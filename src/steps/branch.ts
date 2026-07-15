import { q, list, empty, Relation, type Expression } from '../q.ts';
import { edges } from '../schema.ts';
import { stepChain, type Step } from '../frontend.ts';
import { dirsFor, edgeLabelFilter, labelIn, nodeHasProp, compileFilterPredicate, predicateSql, elemCtx, type ScalarCtx, type Elem } from '../plan.ts';
import { advance, elemRel, prevRel, carryFrag, carriedCols, aliasColsOf, type Carried, type PathState, type ElementStream, type StepFn } from './context.ts';
import { foldBody } from './index.ts';
import { pushChildScope } from './child.ts';

/** A ScalarCtx correlating on a walk row's current vertex id — its props/label are
 *  read back from `nodes` by subquery (the walk row carries only the id). Lets
 *  until()'s predicate reuse the where()/filter() predicate engine over each hop. */
const walkNodeCtx = (idExpr: Expression): ScalarCtx => {
  const sub = (col: string) => q`(SELECT ${col} FROM nodes WHERE id=${idExpr})`;
  // Node ctx: props are read from vertex_properties via idExpr (hasProp/scalarProp),
  // so no propsExpr (that's edge-only now).
  return { elem: 'node', idExpr, extIdExpr: sub('COALESCE(uid, id)'), labelIdExpr: sub('label') };
};

/** Compile an until(<traversal>) modulator into `(id, depth) → boolean SQL`. A
 *  `loops().is(P)` body tests the depth counter; every other body is an element
 *  predicate over the current vertex (has/hasLabel/values/out…count().is/and/or),
 *  reusing compileFilterPredicate on a correlated ctx. */
function untilPredicate(untilStep: Step, params: Record<string, any>): (id: Expression, depth: Expression) => Expression {
  const nested = stepChain(untilStep.args[0]?.nested, params);
  if (!nested.length) throw new Error('until() requires a traversal predicate');
  if (nested[0].name === 'loops') {
    if (nested.length === 2 && nested[1].name === 'is') return (_id, depth) => predicateSql(depth, nested[1].args[0]);
    throw new Error('until(__.loops()…) form not yet supported (only loops().is(P))');
  }
  return (id) => compileFilterPredicate(nested, walkNodeCtx(id), params);
}

// ---------- branch (union / optional / repeat) ----------

/** Seed a coalesce/optional branch fold: tag each current traverser with a unique
 *  ordinal `o` (ROW_NUMBER) so a branch body's results stay tied to their input row,
 *  even across the multiset (two equal ids get distinct ordinals — the technique
 *  sqlg uses as `sqlg_index`). The base relation PROJECTS the incoming carried columns
 *  (as() aliases etc.) alongside `o`, and the seed keeps them, so a branch body threads
 *  them forward and the merge can preserve them. Returns the base (id, <carried>, o) and
 *  a seed ElementStream carrying `o` + the incoming carried schema. */
function originSeed(st: ElementStream): { base: Relation; seedSt: ElementStream; ord: string } {
  const { frame, seed } = pushChildScope(st);
  return { base: frame.domain, seedSt: seed, ord: frame.ordinal };
}

/** PREFIX steps that hand-roll a SELECT that DROPS the input-ordinal (`ElementStream.origin`)
 *  instead of threading it via carryFrag — so a coalesce/optional body containing one
 *  must defer rather than emit a column-mismatched CTE. (Movement/filter/passthrough
 *  carry it via carryFrag; union/flatMap re-project it; a scalar/projection step isn't
 *  in PREFIX at all → it gets the clearer scalar-body message below.) */
const ORIGIN_UNSAFE = new Set(['dedup', 'as', 'repeat', 'choose']);

/** Fold a branch body (element-only) from `seed` through the movement/filter
 *  dispatch. Multi-hop bodies work (they chain CTEs off the seed). A scalar/
 *  projection tail (a step absent from PREFIX) fails closed. When `seed` carries an
 *  input ordinal (coalesce/optional), a body step that wouldn't thread it also fails
 *  closed. Returns the finished ElementStream — its `rel` carries the ordinal when active, so
 *  the caller can re-associate results with their input. */
function branchArm(name: string, nested: any, seed: ElementStream, params: Record<string, any>): ElementStream {
  if (!nested) throw new Error(`${name}(traversal) required`);
  const body = stepChain(nested, params);
  if (seed.carried.origins.length) {
    const bad = body.find((c) => ORIGIN_UNSAFE.has(c.name));
    if (bad) throw new Error(`${name}() branch step __.${bad.name}() not yet supported inside coalesce()/optional() (input-ordinal not carried)`);
  }
  const { st: end, stop } = foldBody(body, seed, 0);
  if (stop !== body.length)
    throw new Error(`${name}() branch __.${body.map((c) => c.name + '()').join('.')} not yet supported (scalar/projection body)`);
  return end;
}

/** A branch forks a traverser into arms. as() aliases + path positions are pure
 *  labels that copy cleanly into each arm, but the sack (a MUTABLE per-traverser
 *  accumulator) and the otherV() entering-vertex (fromV) have split/merge-on-fork
 *  semantics we haven't verified — so fail closed rather than let carriedCols carry
 *  them silently through the merge (CLAUDE.md/the matrix defer 'split/merge-on-fork').
 *  Aliases/path deliberately pass; only these two are gated here. */
function assertForkSafe(name: string, st: ElementStream): void {
  if (st.carried.sack) throw new Error(`sack() through ${name}() not yet supported (split/merge-on-fork)`);
  if (st.carried.fromV) throw new Error(`otherV() context through ${name}() not yet supported`);
}

// ---------- path-through-branch merge (pad-to-max cols) ----------
//
// Arms fold from the same seed, so they append path positions at ALIGNED indices
// (each starts at p{L}). A branch where arms append DIFFERENT numbers of positions is
// ragged: pad the shorter arms' merge SELECT with trailing NULLs and mark those
// positions nullable, so compilePath LEFT JOINs them and the handler skips a null-id
// position (a shorter arm's path is genuinely shorter). Fail-closed on a same-index
// element-KIND conflict (union(outE(), out())) and on a dynamic-length (array/repeat)
// arm — both would need the tagged-array regime (a separate, larger piece).

/** The carried columns EXCLUDING path positions (aliases + origin/sack/fromV). These
 *  must be identical across arms; only path is padded. */
const nonPathCols = (c: Carried): string[] => carriedCols({ ...c, path: undefined });

/** Merge cols() PATH states by padding to the max length. */
function mergePaths(arms: PathState[]): PathState {
  if (arms.some((p) => p.kind !== 'cols'))
    throw new Error('path() through a branch containing a repeat()/dynamic-length arm not yet supported');
  const cols = arms.map((p) => (p as Extract<PathState, { kind: 'cols' }>).cols);
  const M = Math.max(...cols.map((c) => c.length));
  const merged: { col: string; elem: Elem; nullable?: boolean }[] = [];
  for (let j = 0; j < M; j++) {
    const present = cols.filter((c) => j < c.length).map((c) => c[j]);
    const elem = present[0].elem;
    if (present.some((pos) => pos.elem !== elem))
      throw new Error('path() through a branch with conflicting element kinds at one position not yet supported');
    merged.push({ col: `p${j}`, elem, nullable: present.length < cols.length || present.some((pos) => pos.nullable) });
  }
  return { kind: 'cols', cols: merged };
}

/** Assert every arm agrees with `seed` on non-path carried cols (a NEW as()/sack inside
 *  an arm diverges → fail closed) and merge the arms' PATH by padding. Returns the
 *  merged Carried (seed's non-path cols + the padded path). */
function mergeBranchCarried(seed: Carried, arms: Carried[]): Carried {
  const want = nonPathCols(seed);
  for (const a of arms) {
    const got = nonPathCols(a);
    if (got.length !== want.length || got.some((x, i) => x !== want[i]))
      throw new Error('branch arms disagree on carried columns (a step binding new as()/sack state inside a branch arm not yet supported)');
  }
  return { ...seed, path: seed.path ? mergePaths(arms.map((a) => a.path!)) : undefined };
}

/** One arm's merge SELECT column list, padding its missing (trailing) path positions
 *  with `NULL` so the UNION ALL lines up with `out`. Order MUST match carriedCols(out):
 *  id, aliases, origin/sack/fromV, then path LAST. */
function armProjection(arm: ElementStream, out: Carried): string {
  const parts = ['id', ...aliasColsOf(out.aliases), ...out.origins];
  if (out.sack) parts.push(out.sack);
  if (out.fromV) parts.push(out.fromV);
  if (out.path?.kind === 'cols') {
    const armLen = arm.carried.path?.kind === 'cols' ? arm.carried.path.cols.length : 0;
    out.path.cols.forEach((pos, j) => parts.push(j < armLen ? pos.col : `NULL AS ${pos.col}`));
  }
  return parts.join(', ');
}

/** union(): UNION ALL of each branch, each folded from the CURRENT relation (so the
 *  incoming carried columns — as() aliases, the coalesce/optional ordinal when nested —
 *  ride into every arm via carryFrag) through the full dispatch (multi-hop bodies work).
 *  Same-shape branches only (all node or all edge). mergeCarried asserts every arm
 *  exposes the same carried schema (an arm binding a NEW as() diverges → deferred) and
 *  the merge projects it, so `union(...).select('a')` resolves. path tracking through a
 *  branch (1b) still defers. */
export const union: StepFn = (s, st) => {
  assertForkSafe('union', st);
  const branches = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 2) throw new Error('union() needs at least two branches');
  const ends = branches.map((b) => branchArm('union', b.nested, st, st.params));
  const elem = ends[0].elem;
  if (ends.some((e) => e.elem !== elem)) throw new Error('union() branches produce different element kinds (mixed-shape) not yet supported');
  const out = mergeBranchCarried(st.carried, ends.map((e) => e.carried)); // pads ragged path arms
  const selects = ends.map((e) => q`SELECT ${armProjection(e, out)} FROM ${e.rel}`);
  return advance(st, list(selects, ' UNION ALL '), { elem, path: out.path });
};

/** optional(t) = t where it yields output, else the traverser itself. Fast path: a
 *  single out()/in() over vertices → LEFT JOIN + COALESCE-to-self (index-only, no
 *  window). General path: optional(t) = coalesce(t, identity) via the input ordinal
 *  — emit t's results, plus each input unchanged where t produced nothing. Same-shape
 *  only: the self-on-miss fallback is the input element, so t must not flip the kind. */
export const optional: StepFn = (s, st) => {
  assertForkSafe('optional', st);
  const body = stepChain(s.args[0]?.nested, st.params);
  if (!body.length) throw new Error('optional(traversal) required');
  // Fast path only WITHOUT path tracking: with a path, hit extends it and miss doesn't,
  // so the two are ragged and must go through the padded general path below.
  if (!st.carried.origins.length && !st.carried.path && body.length === 1 && (body[0].name === 'out' || body[0].name === 'in') && st.elem === 'node') {
    const [from, to] = dirsFor(body[0].name)[0];
    const e = edges.as('e');
    const p = prevRel(st, 'p');
    // On a hit id = the neighbour; on a miss COALESCE keeps the input id. The carried
    // columns (aliases) come from `p` (the input) either way — the label bindings are
    // the input traverser's, correct in both cases.
    return advance(st, q`SELECT COALESCE(${e.c[to]}, ${p.c.id}) AS id${carryFrag(st.carried, p)} FROM ${p} LEFT JOIN ${e} ON ${e.c[from]}=${p.c.id}${edgeLabelFilter(body[0].args)}`);
  }
  // Nesting is supported: originSeed mints a UNIQUE ordinal (o0, o1, …) per depth and
  // carries the outer ordinals through, so optional()/coalesce() compose.
  const { base, seedSt, ord } = originSeed(st);
  const end = branchArm('optional', s.args[0].nested, seedSt, st.params);
  if (end.elem !== st.elem)
    throw new Error('optional() body changing element kind not yet supported (self-on-miss would be mixed-shape)');
  // Two ragged arms: the HIT (body, path extended) and the MISS (base = input unchanged,
  // path at its incoming length). Pad to max; POP this branch's ordinal on output (restore
  // the outer origins), keeping any outer ordinals threaded.
  const merged = mergeBranchCarried(seedSt.carried, [end.carried, seedSt.carried]);
  const out: Carried = { ...merged, origins: st.carried.origins };
  const baseSt: ElementStream = { ...seedSt, rel: base };
  const hit = q`SELECT ${armProjection(end, out)} FROM ${end.rel}`;
  const miss = q`SELECT ${armProjection(baseSt, out)} FROM ${base} WHERE ${ord} NOT IN (SELECT ${ord} FROM ${end.rel})`;
  return advance(st, list([hit, miss], ' UNION ALL '), { elem: end.elem, origins: st.carried.origins, path: out.path });
};

/** coalesce(t1, …, tn): the first branch that yields output, per input traverser.
 *  Tag each input with a unique ordinal (originSeed), fold every branch carrying it,
 *  then emit branch k only for inputs no earlier branch produced a row for. Same-shape
 *  branches only; scalar-body defers. Nests inside coalesce/optional (unique ordinal per depth). */
export const coalesce: StepFn = (s, st) => {
  assertForkSafe('coalesce', st);
  const branches = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 1) throw new Error('coalesce() needs at least one branch');
  const { seedSt, ord } = originSeed(st); // unique ordinal — nests inside optional/coalesce
  const ends = branches.map((b) => branchArm('coalesce', b.nested, seedSt, st.params));
  const elem = ends[0].elem;
  if (ends.some((e) => e.elem !== elem)) throw new Error('coalesce() branches produce different element kinds (mixed-shape) not yet supported');
  // Pad ragged path arms; POP this branch's ordinal on output (restore the outer origins).
  const merged = mergeBranchCarried(seedSt.carried, ends.map((e) => e.carried));
  const out: Carried = { ...merged, origins: st.carried.origins };
  const parts = ends.map((end, k) => {
    const sel = armProjection(end, out);
    if (k === 0) return q`SELECT ${sel} FROM ${end.rel}`;
    const notPrior = list(ends.slice(0, k).map((pr) => q`${ord} NOT IN (SELECT ${ord} FROM ${pr.rel})`), ' AND ');
    return q`SELECT ${sel} FROM ${end.rel} WHERE ${notPrior}`;
  });
  return advance(st, list(parts, ' UNION ALL '), { elem, origins: st.carried.origins, path: out.path });
};

/** flatMap(t): apply t per traverser, flatten all results — for element bodies this
 *  is just inlining the body (a fan-out through the dispatch). map()'s first-result-
 *  only semantics differ (needs a per-input row-number) and stay deferred. */
export const flatMap: StepFn = (s, st) => {
  assertForkSafe('flatMap', st); // 1:many is a split too — same sack/fromV concern
  // Single body, no merge — incoming aliases + the appended path ride through on `end`.
  const end = branchArm('flatMap', s.args[0]?.nested, st, st.params);
  mergeBranchCarried(st.carried, [end.carried]); // reject a NEW as() bound inside (non-path cols must agree); path just rides on `end`
  return end;
};

// ---------- repeat body → one recursive-term step ----------
//
// SQLite requires the recursive table to appear exactly ONCE in the term's FROM (not in
// a sub-CTE/subquery), so a multi-step body must compile to a SINGLE flat SELECT: a chain
// of edge JOINs off `self`, plus has() filters as correlated WHERE conds. Movements
// out/in/both fork by direction, so the body expands to the cartesian product of each
// movement's directions (both() = 2) — one recursive SELECT per combo. Barrier/side-effect
// bodies (limit/dedup/order/local/union/sack/groupCount/nested-repeat) can't live in a
// recursive term and stay deferred; so does hasLabel()/complex has() (own follow-up).

const REPEAT_MOVES = new Set(['out', 'in', 'both']);

/** Cartesian product of each movement's (from,to) direction pairs. */
function dirCombos(moves: Step[]): [string, string][][] {
  let combos: [string, string][][] = [[]];
  for (const m of moves) combos = combos.flatMap((c) => dirsFor(m.name).map((d) => [...c, d] as [string, string][]));
  return combos;
}

/** Expand a movement+has() body into one {finalId, from, conds} per direction combo:
 *  each movement adds `JOIN edges reN ON reN.<from>=<curId> [AND label]`, advancing curId
 *  to `reN.<to>`; each has() adds a correlated predicate on the current node. */
function expandRepeatBody(self: Relation, core: Step[]): { finalId: Expression; from: Expression; conds: Expression[] }[] {
  const moves = core.filter((c) => REPEAT_MOVES.has(c.name));
  return dirCombos(moves).map((dirs) => {
    let curId: Expression = self.c.id;
    const joins: Expression[] = [];
    const conds: Expression[] = [];
    let mi = 0;
    for (const step of core) {
      if (REPEAT_MOVES.has(step.name)) {
        const [from, to] = dirs[mi++];
        const e = edges.as(`re${mi}`);
        joins.push(q` JOIN ${e} ON ${e.c[from]}=${curId}${step.args.length ? q` AND ${labelIn(`${e.name}.label`, step.args)}` : empty}`);
        curId = e.c[to];
      } else {
        // has() only (hasLabel/complex has deferred at validation): a correlated EXISTS
        // over vertex_properties on the current node id.
        conds.push(nodeHasProp(curId, step.args[0], step.args[1]));
      }
    }
    return { finalId: curId, from: q`${self}${list(joins, '')}`, conds };
  });
}

/** repeat(): the folded repeat/emit/times/until cluster (strategies.foldRepeat) →
 *  a WITH RECURSIVE walk. Termination is spec-faithful and structural, NOT a magic
 *  depth cap: times() is the only depth bound (emit before/after selects the band);
 *  until() and emit() run to the natural fixpoint (the recursion stops when the
 *  frontier is exhausted). A genuinely cyclic body without simplePath() (e.g. any
 *  both()) is infinite PER THE SPEC — we compile it faithfully and let the DO's
 *  per-request CPU/memory limit be the backstop (one self-inflicted request fails and
 *  the DO reloads from durable storage; blast radius is the caller's own tenant). Do
 *  NOT reintroduce an artificial cap: it silently truncates legitimate deep walks.
 *  until() → a `done` column (expand only from not-done rows, output done rows;
 *  do-while when until is after repeat, while-do when before). Path tracking (JSONB
 *  array) and simplePath()'s cycle guard compose in. Deferred forms (emit-pred,
 *  until+times/emit, complex body) throw — the fold gathered the cluster, not validated it. */
export const repeat: StepFn = (s, st) => {
  if (st.elem !== 'node') throw new Error('repeat() on edges not yet supported');
  if (st.carried.aliases.size > 0) throw new Error('repeat() after as() not yet supported');
  const cluster = s.cluster ?? [s];
  const rep = cluster.find((c) => c.name === 'repeat');
  if (!rep) throw new Error(`${s.name}() without repeat() not yet supported`);
  const emitStep = cluster.find((c) => c.name === 'emit');
  if (emitStep?.args.length) throw new Error('emit(predicate) not yet supported');
  const timesStep = cluster.find((c) => c.name === 'times');
  if (timesStep && typeof timesStep.args[0] !== 'number') throw new Error('times(predicate) not yet supported');
  const untilStep = cluster.find((c) => c.name === 'until');
  const hasUntil = !!untilStep;
  // Interactions not built yet — fail closed rather than silently mis-terminate.
  if (hasUntil && timesStep) throw new Error('until() together with times() not yet supported');
  if (hasUntil && emitStep) throw new Error('until() together with emit() not yet supported');
  // Require an exit modulator: times() (fixed depth), until() (stop predicate), or
  // emit() (output every iteration; terminates when the frontier is exhausted). Bare
  // repeat() has no termination AND no output semantics → reject. Note: unbounded
  // until()/emit() on a cyclic body are infinite by spec — see the docstring.
  if (!timesStep && !hasUntil && !emitStep) throw new Error('repeat() requires times(), until(), or emit()');
  const emitBefore = !!emitStep && cluster.indexOf(emitStep) < cluster.indexOf(rep);

  // Body: movements (out/in/both) + has() filters, optionally a trailing simplePath().
  // A bare single movement keeps the original (byte-identical) term; anything more uses
  // the general JOIN-chain term (expandRepeatBody). Barrier/side-effect bodies defer.
  const body = stepChain(rep.args[0]?.nested, st.params);
  const simplePathInBody = body.length > 0 && body[body.length - 1].name === 'simplePath';
  const core = simplePathInBody ? body.slice(0, -1) : body;
  const moves = core.filter((c) => REPEAT_MOVES.has(c.name));
  const badStep = core.find((c) => !REPEAT_MOVES.has(c.name) && c.name !== 'has');
  if (!moves.length || badStep)
    throw new Error(`repeat(__.${body.map((c) => c.name + '()').join('.')}) not yet supported (movements + has(), optional trailing simplePath(); barrier/side-effect bodies deferred)`);
  // has() in a repeat body: only has(key, value|P) — a 3-arg or T-token form defers.
  const badHas = core.find((c) => c.name === 'has' && (typeof c.args[0] !== 'string' || c.args.length > 2));
  if (badHas) throw new Error('complex has() (3-arg / T-token) in a repeat() body not yet supported');
  const singleMove = core.length === 1 && REPEAT_MOVES.has(core[0].name);
  // times() → its fixed depth (the ONLY depth bound). until()/emit() have none —
  // they terminate at the natural fixpoint (see the docstring). null = no bound.
  const maxDepth = timesStep ? Number(timesStep.args[0]) : null;

  // Path tracking. `wantsPathOutput`: a downstream path() (chain seeded st.carried.path at V).
  // simplePath() in the body needs the accumulated path for its cycle guard even
  // when nothing outputs it. Either → accumulate a JSONB array through the walk.
  const wantsPathOutput = !!st.carried.path;
  // Fail closed on path() spanning more than one movement segment: either a linear
  // hop before repeat (`cols` length > 1) OR a path already accumulated by a PRIOR
  // repeat cluster (`array`). Both would need the walk seeded from the carried path,
  // not a fresh jsonb_array(id) — deferred rather than silently dropping the prefix.
  if (wantsPathOutput && (st.carried.path!.kind === 'array' || st.carried.path!.cols.length > 1))
    throw new Error('path() spanning more than one repeat()/movement is not yet supported');
  if (wantsPathOutput && emitStep) throw new Error('emit() with path() not yet supported');
  const trackArray = wantsPathOutput || simplePathInBody;
  // path()/simplePath() record ONE position per iteration = one movement; a multi-MOVEMENT
  // body loses its intermediate(s), so defer there. A single movement + has() filters is fine.
  if (trackArray && moves.length > 1) throw new Error('path()/simplePath() with a multi-hop repeat() body not yet supported');

  // until(): `done` = does the stop predicate hold for this row? do-while (until
  // AFTER repeat) leaves the seed untested (body runs ≥1×); while-do (until BEFORE)
  // tests the seed too. Expansion continues only from done=0 rows; done=1 rows exit.
  const untilFn = hasUntil ? untilPredicate(untilStep!, st.params) : null;
  const untilFirst = hasUntil && cluster.indexOf(untilStep!) < cluster.indexOf(rep);
  const doneCol = (id: Expression, depth: Expression): Expression => q`, CASE WHEN ${untilFn!(id, depth)} THEN 1 ELSE 0 END AS done`;

  const walkCols = ['id', 'depth', ...(trackArray ? ['path'] : []), ...(hasUntil ? ['done'] : [])];
  const walk = st.q.recursiveCte(walkCols, (self: Relation) => {
    // One recursive-term SELECT: advance to `finalId`, bump depth, accumulate path/done,
    // and guard expansion — shared depth<times / done=0 guards FIRST, then the branch's
    // own guards, so the bare single-movement case is byte-identical to before.
    const mkRec = (finalId: Expression, from: Expression, branchGuards: Expression[]): Expression => {
      const pathAcc = trackArray ? q`, jsonb_insert(${self.c.path}, '$[#]', ${finalId}) AS path` : q``;
      const doneAcc = hasUntil ? doneCol(finalId, q`${self.c.depth} + 1`) : q``;
      const guards: Expression[] = [];
      if (timesStep) guards.push(q`${self.c.depth} < ${maxDepth!}`); // maxDepth non-null when timesStep set
      if (hasUntil) guards.push(q`${self.c.done}=0`); // until() expands only from still-looping rows
      guards.push(...branchGuards);
      const where = guards.length ? q` WHERE ${list(guards, ' AND ')}` : q``;
      return q`SELECT ${finalId} AS id, ${self.c.depth} + 1 AS depth${pathAcc}${doneAcc} FROM ${from}${where}`;
    };
    // simplePath()'s cycle guard: reject a finalId already on the accumulated path.
    const cycleGuard = (finalId: Expression): Expression[] =>
      simplePathInBody ? [q`NOT EXISTS (SELECT 1 FROM json_each(${self.c.path}) je WHERE je.value=${finalId})`] : [];
    // Bare single movement → the ORIGINAL term (alias `e`, label in WHERE), byte-identical.
    // Everything else (movement + has(), or multi-hop) → the general JOIN-chain expansion.
    const rec = singleMove
      ? dirsFor(core[0].name).map(([from, to]) => {
          const e = edges.as('e');
          const guards = [...cycleGuard(e.c[to]), ...(core[0].args.length ? [labelIn('e.label', core[0].args)] : [])];
          return mkRec(e.c[to], q`${self} JOIN ${e} ON ${e.c[from]}=${self.c.id}`, guards);
        })
      : expandRepeatBody(self, core).map(({ finalId, from, conds }) => mkRec(finalId, from, [...conds, ...cycleGuard(finalId)]));
    // Only while-do (untilFirst) tests the SEED against until()'s correlated
    // `(SELECT props FROM nodes WHERE id=<seed id>)`; a bare `id` there would bind
    // BOTH sides to nodes.id (always true → wrong row), so alias the source (`w.id`).
    // Every other seed uses bare `id` (no subquery) → byte-identical to before.
    const seedSrc = untilFirst ? st.rel.as('w') : st.rel;
    const seedId = untilFirst ? seedSrc.c.id : q`id`;
    const seedSel = untilFirst ? q`${seedId} AS id` : q`id`; // do-while keeps bare `id` → byte-identical
    const seedPath = trackArray ? q`, jsonb_array(${seedId}) AS path` : q``;
    const seedDone = hasUntil ? (untilFirst ? doneCol(seedId, q`0`) : q`, 0 AS done`) : q``;
    return q`SELECT ${seedSel}, 0 AS depth${seedPath}${seedDone} FROM ${seedSrc} UNION ALL ${list(rec, ' UNION ALL ')}`;
  });
  // Output: until() → the rows that satisfied the stop predicate; emit() → every
  // iteration (after → depth≥1; before → also the seed, depth≥0); times() without
  // emit → the final depth band. maxDepth is non-null in the last case (times present
  // whenever neither until nor emit is).
  const outWhere = hasUntil ? 'done = 1'
    : emitStep ? (emitBefore ? 'depth >= 0' : 'depth >= 1')
    : `depth = ${maxDepth}`;
  // Expose the path column iff a path() will frame it; else drop it (the array was
  // internal to the walk, only there for simplePath's guard).
  if (wantsPathOutput)
    return advance(st, q`SELECT id, path FROM ${walk} WHERE ${outWhere}`, { path: { kind: 'array', col: 'path', elem: 'node' } });
  return advance(st, q`SELECT id FROM ${walk} WHERE ${outWhere}`);
};

// ---------- choose (predicate form) ----------

/** `NOT COALESCE((<pred>), 0)` — a NULL (missing prop) counts as false, so the
 *  else arm gets exactly the traversers the then arm didn't (mirrors filter.ts). */
const notCoalesce = (e: Expression): Expression => q`NOT COALESCE((${e}), 0)`;

/** Gate the current traverser relation by a boolean test → a one-column (id) seed
 *  CTE. choose()'s then/else arms fold from their gated seed; aliases/path are
 *  refused by choose() up front, so the seed carries only id. */
function gate(st: ElementStream, test: Expression): ElementStream {
  const n = elemRel(st);
  const p = prevRel(st, 'p');
  return advance(st, q`SELECT ${n.c.id}${carryFrag(st.carried, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} WHERE ${test}`);
}

/**
 * choose(pred, then[, else]) — the predicate form. The predicate traversal compiles
 * to a correlated boolean (reusing the where()/filter() engine); the current stream
 * splits into two gated seeds (pred / NOT pred); each arm folds from its seed through
 * the movement/filter dispatch (multi-hop arms work); the two element id-relations
 * merge UNION ALL. Same-shape arms only (both node or both edge). else absent →
 * identity passthrough (the gated NOT-pred seed itself).
 *
 * Deferred (clear errors): the option-map form choose(choiceFn).option(k, t)… (needs
 * a strategies pass), scalar/projection arm bodies (values/count/fold — the id-relation
 * can't carry them), and choose() after as()/with path tracking.
 */
export const choose: StepFn = (s, st) => {
  assertForkSafe('choose', st);
  const args = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (args.length < 2 || args.length > 3)
    throw new Error('choose(): only the predicate form choose(pred, then[, else]) is supported (option-map form not yet supported)');
  const [predArg, thenArg, elseArg] = args;
  const pred = compileFilterPredicate(stepChain(predArg.nested, st.params), elemCtx(elemRel(st), st.elem), st.params);

  const arm = (arg: any, seed: ElementStream): ElementStream => {
    const body = stepChain(arg.nested, st.params);
    const { st: end, stop } = foldBody(body, seed, 0);
    if (stop !== body.length)
      throw new Error(`choose() branch __.${body.map((c) => c.name + '()').join('.')} not yet supported (scalar/projection body)`);
    return end;
  };

  const thenEnd = arm(thenArg, gate(st, pred));
  const elseSeed = gate(st, notCoalesce(pred));
  const elseEnd = elseArg ? arm(elseArg, elseSeed) : elseSeed; // else absent → identity
  if (thenEnd.elem !== elseEnd.elem)
    throw new Error('choose() branches produce different element kinds (mixed-shape) not yet supported');

  const out = mergeBranchCarried(st.carried, [thenEnd.carried, elseEnd.carried]); // pads ragged path arms
  const merged = list([q`SELECT ${armProjection(thenEnd, out)} FROM ${thenEnd.rel}`, q`SELECT ${armProjection(elseEnd, out)} FROM ${elseEnd.rel}`], ' UNION ALL ');
  return advance(st, merged, { elem: thenEnd.elem, path: out.path });
};
