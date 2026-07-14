import { q, list, empty, Relation, type Expression } from '../q.ts';
import { edges } from '../schema.ts';
import { stepChain, type Step } from '../frontend.ts';
import { dirsFor, edgeLabelFilter, labelIn, compileFilterPredicate, predicateSql, elemCtx, type ScalarCtx } from '../plan.ts';
import { advance, elemRel, prevRel, withCarried, carryFrag, carriedCols, mergeCarried, type St, type StepFn } from './context.ts';
import { foldBody } from './index.ts';

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
 *  a seed St carrying `o` + the incoming carried schema. */
function originSeed(st: St): { base: Relation; seedSt: St } {
  const s = st.last.as('s');
  const cc = carriedCols(st.carried);
  const base = st.q.cte(q`SELECT ${s.c.id} AS id${carryFrag(st.carried, s)}, ROW_NUMBER() OVER () AS o FROM ${s}`, ['id', ...cc, 'o']);
  return { base, seedSt: withCarried({ ...st, last: base }, { origin: 'o' }) };
}

/** PREFIX steps that hand-roll a SELECT that DROPS the input-ordinal (`St.origin`)
 *  instead of threading it via carryFrag — so a coalesce/optional body containing one
 *  must defer rather than emit a column-mismatched CTE. (Movement/filter/passthrough
 *  carry it via carryFrag; union/flatMap re-project it; a scalar/projection step isn't
 *  in PREFIX at all → it gets the clearer scalar-body message below.) */
const ORIGIN_UNSAFE = new Set(['dedup', 'as', 'repeat', 'choose']);

/** Fold a branch body (element-only) from `seed` through the movement/filter
 *  dispatch. Multi-hop bodies work (they chain CTEs off the seed). A scalar/
 *  projection tail (a step absent from PREFIX) fails closed. When `seed` carries an
 *  input ordinal (coalesce/optional), a body step that wouldn't thread it also fails
 *  closed. Returns the finished St — its `last` carries the ordinal when active, so
 *  the caller can re-associate results with their input. */
function branchArm(name: string, nested: any, seed: St, params: Record<string, any>): St {
  if (!nested) throw new Error(`${name}(traversal) required`);
  const body = stepChain(nested, params);
  if (seed.carried.origin) {
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
function assertForkSafe(name: string, st: St): void {
  if (st.carried.sack) throw new Error(`sack() through ${name}() not yet supported (split/merge-on-fork)`);
  if (st.carried.fromV) throw new Error(`otherV() context through ${name}() not yet supported`);
}

/** union(): UNION ALL of each branch, each folded from the CURRENT relation (so the
 *  incoming carried columns — as() aliases, the coalesce/optional ordinal when nested —
 *  ride into every arm via carryFrag) through the full dispatch (multi-hop bodies work).
 *  Same-shape branches only (all node or all edge). mergeCarried asserts every arm
 *  exposes the same carried schema (an arm binding a NEW as() diverges → deferred) and
 *  the merge projects it, so `union(...).select('a')` resolves. path tracking through a
 *  branch (1b) still defers. */
export const union: StepFn = (s, st) => {
  if (st.carried.path) throw new Error('path tracking through union() not yet supported');
  assertForkSafe('union', st);
  const branches = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 2) throw new Error('union() needs at least two branches');
  const ends = branches.map((b) => branchArm('union', b.nested, st, st.params));
  const elem = ends[0].elem;
  if (ends.some((e) => e.elem !== elem)) throw new Error('union() branches produce different element kinds (mixed-shape) not yet supported');
  const cols = mergeCarried(st.carried, ends.map((e) => e.carried)).join(', ');
  return advance(st, list(ends.map((e) => q`SELECT ${cols} FROM ${e.last}`), ' UNION ALL '), { elem });
};

/** optional(t) = t where it yields output, else the traverser itself. Fast path: a
 *  single out()/in() over vertices → LEFT JOIN + COALESCE-to-self (index-only, no
 *  window). General path: optional(t) = coalesce(t, identity) via the input ordinal
 *  — emit t's results, plus each input unchanged where t produced nothing. Same-shape
 *  only: the self-on-miss fallback is the input element, so t must not flip the kind. */
export const optional: StepFn = (s, st) => {
  if (st.carried.path) throw new Error('path tracking through optional() not yet supported');
  assertForkSafe('optional', st);
  const body = stepChain(s.args[0]?.nested, st.params);
  if (!body.length) throw new Error('optional(traversal) required');
  if (!st.carried.origin && body.length === 1 && (body[0].name === 'out' || body[0].name === 'in') && st.elem === 'node') {
    const [from, to] = dirsFor(body[0].name)[0];
    const e = edges.as('e');
    const p = prevRel(st, 'p');
    // On a hit id = the neighbour; on a miss COALESCE keeps the input id. The carried
    // columns (aliases) come from `p` (the input) either way — the label bindings are
    // the input traverser's, correct in both cases.
    return advance(st, q`SELECT COALESCE(${e.c[to]}, ${p.c.id}) AS id${carryFrag(st.carried, p)} FROM ${p} LEFT JOIN ${e} ON ${e.c[from]}=${p.c.id}${edgeLabelFilter(body[0].args)}`);
  }
  if (st.carried.origin) throw new Error('optional() inside coalesce()/optional() not yet supported');
  const { base, seedSt } = originSeed(st);
  const end = branchArm('optional', s.args[0].nested, seedSt, st.params);
  if (end.elem !== st.elem)
    throw new Error('optional() body changing element kind not yet supported (self-on-miss would be mixed-shape)');
  mergeCarried(seedSt.carried, [end.carried]); // arm must agree with the seed (catches a new as() inside the body)
  // Output the INCOMING carried schema (drop the internal ordinal `o`); hit rows from
  // the body, miss rows (o unseen) from the base = the input unchanged, labels intact.
  const out = ['id', ...carriedCols(st.carried)].join(', ');
  const miss = q`SELECT ${out} FROM ${base} WHERE o NOT IN (SELECT o FROM ${end.last})`;
  return advance(st, list([q`SELECT ${out} FROM ${end.last}`, miss], ' UNION ALL '), { elem: end.elem, origin: null });
};

/** coalesce(t1, …, tn): the first branch that yields output, per input traverser.
 *  Tag each input with a unique ordinal (originSeed), fold every branch carrying it,
 *  then emit branch k only for inputs no earlier branch produced a row for. Same-shape
 *  branches only; aliased/path/scalar-body/nested-in-origin cases defer. */
export const coalesce: StepFn = (s, st) => {
  if (st.carried.path) throw new Error('path tracking through coalesce() not yet supported');
  assertForkSafe('coalesce', st);
  if (st.carried.origin) throw new Error('coalesce() inside coalesce()/optional() not yet supported');
  const branches = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 1) throw new Error('coalesce() needs at least one branch');
  const { seedSt } = originSeed(st);
  const ends = branches.map((b) => branchArm('coalesce', b.nested, seedSt, st.params));
  const elem = ends[0].elem;
  if (ends.some((e) => e.elem !== elem)) throw new Error('coalesce() branches produce different element kinds (mixed-shape) not yet supported');
  mergeCarried(seedSt.carried, ends.map((e) => e.carried)); // arms must agree (catches a new as() inside a body)
  // Output the INCOMING carried schema (drop the internal ordinal `o`).
  const out = ['id', ...carriedCols(st.carried)].join(', ');
  const parts = ends.map((end, k) => {
    if (k === 0) return q`SELECT ${out} FROM ${end.last}`;
    const notPrior = list(ends.slice(0, k).map((pr) => q`o NOT IN (SELECT o FROM ${pr.last})`), ' AND ');
    return q`SELECT ${out} FROM ${end.last} WHERE ${notPrior}`;
  });
  return advance(st, list(parts, ' UNION ALL '), { elem, origin: null });
};

/** flatMap(t): apply t per traverser, flatten all results — for element bodies this
 *  is just inlining the body (a fan-out through the dispatch). map()'s first-result-
 *  only semantics differ (needs a per-input row-number) and stay deferred. */
export const flatMap: StepFn = (s, st) => {
  if (st.carried.path) throw new Error('path tracking through flatMap() not yet supported');
  assertForkSafe('flatMap', st); // 1:many is a split too — same sack/fromV concern
  // Single body, no merge — incoming aliases ride through the fold (carryFrag from st).
  const end = branchArm('flatMap', s.args[0]?.nested, st, st.params);
  mergeCarried(st.carried, [end.carried]); // reject a NEW as() bound inside the body (label escape unverified), matching the merged branch ops
  return end;
};

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

  // Body: a single out/in/both, optionally followed by simplePath() (cycle-free walk).
  const body = stepChain(rep.args[0]?.nested, st.params);
  const mv = body[0];
  const simplePathInBody = body.length === 2 && body[1].name === 'simplePath';
  if (!mv || !['out', 'in', 'both'].includes(mv.name) || (body.length > 1 && !simplePathInBody))
    throw new Error(`repeat(__.${body.map((c) => c.name + '()').join('.')}) not yet supported (single out()/in()/both(), optional .simplePath())`);
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

  // until(): `done` = does the stop predicate hold for this row? do-while (until
  // AFTER repeat) leaves the seed untested (body runs ≥1×); while-do (until BEFORE)
  // tests the seed too. Expansion continues only from done=0 rows; done=1 rows exit.
  const untilFn = hasUntil ? untilPredicate(untilStep!, st.params) : null;
  const untilFirst = hasUntil && cluster.indexOf(untilStep!) < cluster.indexOf(rep);
  const doneCol = (id: Expression, depth: Expression): Expression => q`, CASE WHEN ${untilFn!(id, depth)} THEN 1 ELSE 0 END AS done`;

  const walkCols = ['id', 'depth', ...(trackArray ? ['path'] : []), ...(hasUntil ? ['done'] : [])];
  const walk = st.q.recursiveCte(walkCols, (self: Relation) => {
    const e = edges.as('e');
    const rec = dirsFor(mv.name).map(([from, to]) => {
      // Accumulate the visited-id path (jsonb — no text reparse per hop). simplePath
      // rejects revisiting any element already in the path (the cycle guard).
      const pathAcc = trackArray ? q`, jsonb_insert(${self.c.path}, '$[#]', ${e.c[to]}) AS path` : q``;
      const doneAcc = hasUntil ? doneCol(e.c[to], q`${self.c.depth} + 1`) : q``;
      // Expansion guards, ALL of which must hold to keep walking. A depth bound is
      // added ONLY for times(); until()/emit() rely on frontier exhaustion (and
      // simplePath(), if present) to terminate — no artificial cap.
      const guards: Expression[] = [];
      if (timesStep) guards.push(q`${self.c.depth} < ${maxDepth!}`); // maxDepth non-null when timesStep set
      if (hasUntil) guards.push(q`${self.c.done}=0`); // until() expands only from still-looping rows
      if (simplePathInBody) guards.push(q`NOT EXISTS (SELECT 1 FROM json_each(${self.c.path}) je WHERE je.value=${e.c[to]})`);
      if (mv.args.length) guards.push(labelIn('e.label', mv.args));
      const where = guards.length ? q` WHERE ${list(guards, ' AND ')}` : q``;
      return q`SELECT ${e.c[to]} AS id, ${self.c.depth} + 1 AS depth${pathAcc}${doneAcc} FROM ${self} JOIN ${e} ON ${e.c[from]}=${self.c.id}${where}`;
    });
    // Only while-do (untilFirst) tests the SEED against until()'s correlated
    // `(SELECT props FROM nodes WHERE id=<seed id>)`; a bare `id` there would bind
    // BOTH sides to nodes.id (always true → wrong row), so alias the source (`w.id`).
    // Every other seed uses bare `id` (no subquery) → byte-identical to before.
    const seedSrc = untilFirst ? st.last.as('w') : st.last;
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
function gate(st: St, test: Expression): St {
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
  if (st.carried.path) throw new Error('path tracking through choose() not yet supported');
  assertForkSafe('choose', st);
  const args = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (args.length < 2 || args.length > 3)
    throw new Error('choose(): only the predicate form choose(pred, then[, else]) is supported (option-map form not yet supported)');
  const [predArg, thenArg, elseArg] = args;
  const pred = compileFilterPredicate(stepChain(predArg.nested, st.params), elemCtx(elemRel(st), st.elem), st.params);

  const arm = (arg: any, seed: St): St => {
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

  const cols = mergeCarried(st.carried, [thenEnd.carried, elseEnd.carried]).join(', ');
  const merged = list([q`SELECT ${cols} FROM ${thenEnd.last}`, q`SELECT ${cols} FROM ${elseEnd.last}`], ' UNION ALL ');
  return advance(st, merged, { elem: thenEnd.elem });
};
