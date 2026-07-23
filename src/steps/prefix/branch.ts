import { q, list, empty, Relation, type Expression } from '../../sql/kernel/q.ts';
import { edges } from '../../sql/schema.ts';
import { stepChain, type Step } from '../../gremlin/frontend.ts';
import { dirsFor, edgeLabelFilter, labelIn, nodeHasProp, elemCtx, type ScalarCtx, type Elem } from '../../compiler/plan/plan.ts';
import { tryInlinePredicate } from './predicate.ts';
import { advance, elemRel, prevRel, carryFrag, carryFragMint, carriedCols, partitionOver, type AliasEntry, type AliasMap, type Carried, type PathState, type ElementStream, type StepFn } from '../context/context.ts';
import { type AliasShape } from '../context/alias.ts';
import { pushChildScope, tryCompileCountChild, tryCompileElementTraversal, tryCompileListChild, tryCompileScalarChild, tryCompileScalarValueChild, tryCompileScalarValueRows, tryGateByChildExistence } from '../tail/child.ts';
import { classifyListChild, classifyScalarChild, isElementChild, isListChild, isScalarChild, ROOT_SCOPE } from '../tail/child-shape.ts';
import { carryOf, toListStream, toVariantStream, type ListStream, type ScalarStream, type VariantStream } from '../context/stream.ts';
import { mergeVariantArms, unifyLists, variantArmsMeta, type VariantArm } from '../tail/variant.ts';
import { unionScalarStreams } from '../tail/scalar.ts';
import { engineOf, type Engine } from '../../compiler/engine/deps.ts';

/** A ScalarCtx correlating on a walk row's current vertex id — its props/label are
 *  read back from `nodes` by subquery (the walk row carries only the id). Lets
 *  until()'s predicate reuse the where()/filter() predicate engine over each hop. */
const walkNodeCtx = (idExpr: Expression): ScalarCtx => {
  const sub = (col: string) => q`(SELECT ${col} FROM nodes WHERE id=${idExpr})`;
  // Node ctx: props are read from vertex_properties via idExpr (hasProp/scalarProp),
  // so no propsExpr (that's edge-only now).
  return { elem: 'node', idExpr, extIdExpr: sub('COALESCE(uid, id)'), labelIdExpr: sub('label') };
};


/** Compile an until()/emit() traversal modulator into `(id, depth) → boolean SQL`, routing
 *  the WHOLE body through the shared predicate engine on a correlated walk ctx. loops()
 *  reads the depth counter via ctx.loopsExpr; every other leaf is an element predicate over
 *  the current vertex (has/hasLabel/values/out…count().is), and the infix/and/or machinery
 *  composes them — so until(__.has('name','x').or().loops().is(3)) lowers as one boolean.
 *  Movement leaves correlate through the same compileCorrelatedChild as where()/choose().
 *  until() and emit() share this: the only difference is what the resulting column drives
 *  (termination vs output). */
function walkPredicate(engine: Engine, step: Step, params: Record<string, any>, kind: 'until' | 'emit'): (id: Expression, depth: Expression) => Expression {
  const nested = stepChain(step.args[0]?.nested, params);
  if (!nested.length) throw new Error(`${kind}() requires a traversal predicate`);
  return (id, depth) => tryInlinePredicate(engine, nested, { ...walkNodeCtx(id), loopsExpr: depth }, params)
    ?? (() => { throw new Error(`${kind}() predicate not supported by inline lowering`); })();
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

const armDescription = (nested: any, params: Record<string, any>): string =>
  stepChain(nested, params).map((step) => step.name + '()').join('.');

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

/** The RIGID carried columns — origin/sack/fromV/encounter (everything but aliases and
 *  path). These are per-traverser physical state a branch cannot fork/merge, so they
 *  must be identical across arms; aliases fork/merge (mergeAliasMaps) and path pads. */
const rigidCols = (c: Carried): string[] => carriedCols({ ...c, aliases: new Map(), path: undefined });

/** Union the arms' alias maps onto the shared pre-branch seed → the merged label set.
 *  A label bound before the branch keeps its seed column (every arm inherited it); a
 *  label first bound INSIDE an arm gets a fresh canonical column appended after the seed
 *  columns (arms mint columns independently from the same seed size, so their raw a{n}
 *  collide — armProjection remaps each arm's physical column onto the canonical one).
 *  `shapes` unions across arms. `binds` stays static only when every arm binds the label
 *  the same known number of times; a label bound in only some arms, or a differing count,
 *  or a dynamic (repeat/arm) bind → undefined, so Pop resolves at runtime off the array. */
function mergeAliasMaps(seed: AliasMap, arms: Carried[]): AliasMap {
  const order: string[] = [...seed.keys()];
  for (const a of arms) for (const lbl of a.aliases.keys()) if (!order.includes(lbl)) order.push(lbl);
  const merged = new Map<string, AliasEntry>();
  order.forEach((lbl, i) => {
    const col = seed.get(lbl)?.col ?? `a${i}`; // seed labels keep a{i} (== their mint order)
    const perArm = arms.map((a) => a.aliases.get(lbl));
    const shapes = new Set<AliasShape>();
    for (const e of perArm) if (e) for (const sh of e.shapes) shapes.add(sh);
    const counts = perArm.map((e) => e?.binds ?? 0); // absent in an arm → 0 bindings on that path
    const defined = perArm.every((e) => !e || e.binds !== undefined);
    const binds = defined && counts.every((c) => c === counts[0]) ? counts[0] : undefined;
    merged.set(lbl, { col, shapes, binds });
  });
  return merged;
}

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

/** Merge the arms into the post-branch Carried: fork/merge the alias label set
 *  (mergeAliasMaps), pad the PATH, and assert the RIGID cols (origin/sack/fromV/encounter)
 *  agree across arms (those are per-traverser state a fork can't reconcile → fail closed).
 *  Divergent as() labels are NO LONGER rejected — they union into the merged label set and
 *  armProjection pads each arm's missing labels with an empty (NULL) history. */
function mergeBranchCarried(seed: Carried, arms: Carried[]): Carried {
  const want = rigidCols(seed);
  for (const a of arms) {
    const got = rigidCols(a);
    if (got.length !== want.length || got.some((x, i) => x !== want[i]))
      throw new Error('branch arms disagree on carried columns (a step binding new sack/origin state inside a branch arm not yet supported)');
  }
  return { ...seed, aliases: mergeAliasMaps(seed.aliases, arms), path: seed.path ? mergePaths(arms.map((a) => a.path!)) : undefined };
}

/** One arm's merge SELECT column list. Order MUST match carriedCols(out): id, aliases,
 *  origin/sack/fromV/encounter, then path LAST. Each canonical alias column selects the
 *  arm's PHYSICAL column that holds that label (arms mint columns independently, so the
 *  names can differ → alias with `AS`); a label the arm never bound is padded with a NULL
 *  history (drop-not-throw: select() of it drops the traverser). Trailing path positions a
 *  shorter arm lacks are likewise NULL-padded. */
function armProjection(arm: ElementStream, out: Carried, armIdx?: number): string {
  const parts = ['id'];
  for (const [label, entry] of out.aliases) {
    const got = arm.carried.aliases.get(label);
    parts.push(!got ? `NULL AS ${entry.col}` : got.col === entry.col ? entry.col : `${got.col} AS ${entry.col}`);
  }
  parts.push(...rigidCols(out));
  if (out.path?.kind === 'cols') {
    const armLen = arm.carried.path?.kind === 'cols' ? arm.carried.path.cols.length : 0;
    out.path.cols.forEach((pos, j) => parts.push(j < armLen ? pos.col : `NULL AS ${pos.col}`));
  }
  // When emission order is live, tag the arm with its index so the merge can re-mint a
  // canonical encounter (arm a before arm b) — each arm carried its OWN 1..k encounter, which
  // is meaningless across arms until re-numbered.
  if (armIdx !== undefined) parts.push(`${armIdx} AS arm_idx`);
  return parts.join(', ');
}

/** Merge the element arms' UNION ALL. When emission order is live, re-mint the encounter as
 *  ROW_NUMBER() OVER (<partition> ORDER BY arm_idx, arm_encounter) — arm 0 fully before arm 1,
 *  matching TinkerPop's union/coalesce/choose emission order — superseding the per-arm
 *  encounters `armProjection` tagged. Otherwise a plain UNION ALL (hot path unchanged). `parts`
 *  are the per-arm SELECTs (each already carrying `arm_idx` when `out.encounter` is live). */
function finishElementMerge(st: ElementStream, out: Carried, parts: Expression[], opts: { elem: Elem; aliases: AliasMap; origins?: readonly string[]; path?: PathState }): ElementStream {
  if (!out.encounter) return advance(st, list(parts, ' UNION ALL '), opts);
  const inner = st.q.cte(list(parts, ' UNION ALL '), ['id', ...carriedCols(out), 'arm_idx']);
  const m = inner.as('m');
  const over = partitionOver(out, m, q`${m.c.arm_idx}, ${m.c[out.encounter]}`);
  const body = q`SELECT ${m.c.id} AS id${carryFragMint(out, m, out.encounter, q`ROW_NUMBER() OVER (${over})`)} FROM ${m}`;
  return advance(st, body, opts);
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
  const ends = branches.map((b) => tryCompileElementTraversal(st, b.nested)
    ?? (() => { throw new Error(`union() branch __.${armDescription(b.nested, st.params)} not yet supported (scalar/projection body)`); })());
  const elem = ends[0].elem;
  if (ends.some((e) => e.elem !== elem)) throw new Error('union() branches produce different element kinds (mixed-shape) not yet supported');
  const out = mergeBranchCarried(st.carried, ends.map((e) => e.carried)); // merges alias sets, pads ragged path arms
  const selects = ends.map((e, k) => q`SELECT ${armProjection(e, out, out.encounter ? k : undefined)} FROM ${e.rel}`);
  return finishElementMerge(st, out, selects, { elem, aliases: out.aliases, path: out.path });
};

/** Homogeneous scalar union through the generic child compiler. Every arm applies
 * `all` to the same incoming parent stream; UNION ALL then concatenates their
 * productive rows. Element/scalar mixing deliberately returns null so the legacy
 * element union emits its existing fail-closed mixed-shape error. */
export function tryLowerScalarUnion(s: Step, st: ElementStream): ScalarStream | null {
  assertForkSafe('union', st);
  const branches = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 2) throw new Error('union() needs at least two branches');
  const arms: ScalarStream[] = [];
  for (const branch of branches) {
    const arm = tryCompileScalarChild(st, branch.nested, 'all')
      ?? tryCompileCountChild(st, branch.nested);
    if (!arm) return null;
    arms.push(arm);
  }
  return unionScalarStreams(st, arms);
}

export function tryLowerListUnion(s: Step, st: ElementStream): ListStream | null {
  assertForkSafe('union', st);
  const branches = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 2) return null;
  // classify every arm once (pure, no CTE); emit only if ALL qualify, reusing each parsed
  // body — so a partly-list union never emits arm0's CTEs before a later arm disqualifies.
  const plans = branches.map((b) => classifyListChild(b.nested, st.params));
  if (plans.some((p) => !p)) return null;
  const arms = branches.map((branch, i) => tryCompileListChild(st, branch.nested, ROOT_SCOPE, plans[i]!.body)!);
  const parts = arms.map((arm) => {
    const a = arm.rel.as('a');
    return q`SELECT ${a.c.list} AS list${carryFrag(st.carried, a)} FROM ${a}`;
  });
  const rel = st.q.cte(list(parts, ' UNION ALL '), ['list', ...carriedCols(st.carried)]);
  return toListStream(carryOf(st), rel, unifyLists(arms));
}

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
  if (engineOf(st).fastPaths.singleHopOptional !== false && !st.carried.origins.length && !st.carried.path && body.length === 1 && (body[0].name === 'out' || body[0].name === 'in') && st.elem === 'node') {
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
  const end = tryCompileElementTraversal(seedSt, s.args[0].nested)
    ?? (() => { throw new Error(`optional() branch __.${armDescription(s.args[0].nested, st.params)} not yet supported (scalar/projection body)`); })();
  if (end.elem !== st.elem)
    throw new Error('optional() body changing element kind not yet supported (self-on-miss would be mixed-shape)');
  // Two ragged arms: the HIT (body, path extended) and the MISS (base = input unchanged,
  // path at its incoming length). Pad to max; POP this branch's ordinal on output (restore
  // the outer origins), keeping any outer ordinals threaded.
  const merged = mergeBranchCarried(seedSt.carried, [end.carried, seedSt.carried]);
  const out: Carried = { ...merged, origins: st.carried.origins };
  const baseSt: ElementStream = { ...seedSt, rel: base };
  const hit = q`SELECT ${armProjection(end, out, out.encounter ? 0 : undefined)} FROM ${end.rel}`;
  const miss = q`SELECT ${armProjection(baseSt, out, out.encounter ? 1 : undefined)} FROM ${base} WHERE ${ord} NOT IN (SELECT ${ord} FROM ${end.rel})`;
  return finishElementMerge(st, out, [hit, miss], { elem: end.elem, aliases: out.aliases, origins: st.carried.origins, path: out.path });
};

/** Shape-changing optional: productive scalar child rows win; an unproductive
 * parent emits its original element. Both arms retain the same outer carried
 * schema, while the child-only origin is consumed by the anti-existence arm. */
export function tryLowerVariantOptional(s: Step, st: ElementStream): VariantStream | null {
  const nested = s.args[0]?.nested;
  const plan = classifyScalarChild(nested, st.params);
  if (!plan) return null;
  const rows = tryCompileScalarValueRows(st, nested, ROOT_SCOPE, plan.body);
  if (!rows) return null;
  const c = rows.stream.rel.as('c');
  const d = rows.frame.domain.as('d');
  const hit = q`SELECT 1 AS vk, ${c.c.v} AS v, NULL AS rid${carryFrag(st.carried, c)} FROM ${c}`;
  const miss = q`SELECT 2 AS vk, NULL AS v, ${d.c.id} AS rid${carryFrag(st.carried, d)} FROM ${d} WHERE NOT EXISTS (SELECT 1 FROM ${c} WHERE ${c.c[rows.frame.ordinal]}=${d.c[rows.frame.ordinal]})`;
  const rel = st.q.cte(list([hit, miss], ' UNION ALL '), ['vk', 'v', 'rid', ...carriedCols(st.carried)]);
  return toVariantStream(carryOf(st), rel, { scalarAs: rows.stream.as, ...(st.elem === 'edge' ? { edge: true } : { node: true }) });
}

/** coalesce(t1, …, tn): the first branch that yields output, per input traverser.
 *  Tag each input with a unique ordinal (originSeed), fold every branch carrying it,
 *  then emit branch k only for inputs no earlier branch produced a row for. Same-shape
 *  branches only; scalar-body defers. Nests inside coalesce/optional (unique ordinal per depth). */
export const coalesce: StepFn = (s, st) => {
  assertForkSafe('coalesce', st);
  const branches = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 1) throw new Error('coalesce() needs at least one branch');
  const { seedSt, ord } = originSeed(st); // unique ordinal — nests inside optional/coalesce
  const ends = branches.map((b) => tryCompileElementTraversal(seedSt, b.nested)
    ?? (() => { throw new Error(`coalesce() branch __.${armDescription(b.nested, st.params)} not yet supported (scalar/projection body)`); })());
  const elem = ends[0].elem;
  if (ends.some((e) => e.elem !== elem)) throw new Error('coalesce() branches produce different element kinds (mixed-shape) not yet supported');
  // Pad ragged path arms; POP this branch's ordinal on output (restore the outer origins).
  const merged = mergeBranchCarried(seedSt.carried, ends.map((e) => e.carried));
  const out: Carried = { ...merged, origins: st.carried.origins };
  const parts = ends.map((end, k) => {
    const sel = armProjection(end, out, out.encounter ? k : undefined);
    if (k === 0) return q`SELECT ${sel} FROM ${end.rel}`;
    const notPrior = list(ends.slice(0, k).map((pr) => q`${ord} NOT IN (SELECT ${ord} FROM ${pr.rel})`), ' AND ');
    return q`SELECT ${sel} FROM ${end.rel} WHERE ${notPrior}`;
  });
  return finishElementMerge(st, out, parts, { elem, aliases: out.aliases, origins: st.carried.origins, path: out.path });
};

/** Homogeneous scalar coalesce: compile every arm from one ordinal-tagged seed, then
 * emit arm k only where no earlier arm produced a row for that parent ordinal. The
 * internal ordinal is removed at the merge boundary while outer carried state stays. */
export function tryLowerScalarCoalesce(s: Step, st: ElementStream): ScalarStream | null {
  assertForkSafe('coalesce', st);
  const branches = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (!branches.length) return null;
  const plans = branches.map((b) => classifyScalarChild(b.nested, st.params));
  if (plans.some((p) => !p)) return null;
  const { seedSt, ord } = originSeed(st);
  const arms = branches.map((branch, i) =>
    (tryCompileScalarChild(seedSt, branch.nested, 'all', ROOT_SCOPE, plans[i]!.body)
      ?? tryCompileCountChild(seedSt, branch.nested, ROOT_SCOPE, plans[i]!.body))!);
  return unionScalarStreams(st, arms, (a, k) =>
    k === 0 ? undefined : list(arms.slice(0, k).map((p) => q`${a.c[ord]} NOT IN (SELECT ${ord} FROM ${p.rel})`), ' AND '));
}

export function tryLowerListCoalesce(s: Step, st: ElementStream): ListStream | null {
  assertForkSafe('coalesce', st);
  const branches = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (!branches.length) return null;
  const plans = branches.map((b) => classifyListChild(b.nested, st.params));
  if (plans.some((p) => !p)) return null;
  const { seedSt, ord } = originSeed(st);
  const arms = branches.map((branch, i) => tryCompileListChild(seedSt, branch.nested, ROOT_SCOPE, plans[i]!.body)!);
  const parts = arms.map((arm, k) => {
    const a = arm.rel.as('a');
    const prior = k === 0 ? empty : q` WHERE ${list(arms.slice(0, k).map((p) => q`${a.c[ord]} NOT IN (SELECT ${ord} FROM ${p.rel})`), ' AND ')}`;
    return q`SELECT ${a.c.list} AS list${carryFrag(st.carried, a)} FROM ${a}${prior}`;
  });
  const rel = st.q.cte(list(parts, ' UNION ALL '), ['list', ...carriedCols(st.carried)]);
  return toListStream(carryOf(st), rel, unifyLists(arms));
}

// ---------- mixed-shape branch arms → a dynamic-tag VariantStream (P4) ----------
//
// When a union/coalesce/choose's arms are NOT one shape class (some scalar, some
// element, some list), no per-shape handler (list/scalar/legacy-element) applies.
// Compile each arm to its natural shape and merge the rows into one variant relation
// where `vk` tags each row's shape (1 scalar / 2 node / 3 edge / 4 list). Homogeneous
// arms keep their richer per-shape handlers (path/aliases); mixed element KIND
// (node+edge, both element-class) stays with the legacy element compiler's clear defer.

type ArmShape = 'element' | 'scalar' | 'list';
const armShape = (nested: any, params: Record<string, any>): ArmShape | null =>
  isElementChild(nested, params) ? 'element'
  : isScalarChild(nested, params) ? 'scalar'
  : isListChild(nested, params) ? 'list'
  : null;

/** Compile ONE branch body from `seed` to a variant-arm carrying seed's exact carried
 *  schema: element movement → node/edge, values/id/label/count → scalar, …fold() → list. */
function compileVariantArm(seed: ElementStream, nested: any): VariantArm {
  const element = tryCompileElementTraversal(seed, nested);
  if (element) return { rel: element.rel, vk: element.elem === 'edge' ? 3 : 2 };
  const scalar = tryCompileScalarValueChild(seed, nested, 'all');
  if (scalar) return { rel: scalar.rel, vk: 1, as: scalar.as };
  const listArm = tryCompileListChild(seed, nested);
  if (listArm) return { rel: listArm.rel, vk: 4, listOf: listArm.of };
  throw new Error(`variant branch __.${armDescription(nested, seed.params)} not yet supported (shape not element/scalar/list)`);
}

/** Are these branch shapes genuinely mixed (not all one class, all classifiable)? */
function branchesAreMixed(branches: readonly any[], params: Record<string, any>): boolean {
  const shapes = branches.map((b) => armShape(b.nested, params));
  return !shapes.some((x) => x === null) && !shapes.every((x) => x === shapes[0]);
}

/** union() over mixed-shape arms → a VariantStream (plain UNION ALL, no gating). */
export function tryLowerVariantUnion(s: Step, st: ElementStream): VariantStream | null {
  assertForkSafe('union', st);
  const branches = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 2 || !branchesAreMixed(branches, st.params)) return null;
  if (st.carried.path) throw new Error('path() through a mixed-shape union() not yet supported');
  const arms = branches.map((b) => compileVariantArm(st, b.nested));
  return mergeVariantArms(st, arms, variantArmsMeta(arms));
}

/** coalesce() over mixed-shape arms → a VariantStream. One ordinal-tagged seed feeds
 *  every arm; arm k emits only for parents no earlier arm produced a row for. */
export function tryLowerVariantCoalesce(s: Step, st: ElementStream): VariantStream | null {
  assertForkSafe('coalesce', st);
  const branches = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (!branches.length || !branchesAreMixed(branches, st.params)) return null;
  if (st.carried.path) throw new Error('path() through a mixed-shape coalesce() not yet supported');
  const { seedSt, ord } = originSeed(st);
  const arms = branches.map((b) => compileVariantArm(seedSt, b.nested));
  return mergeVariantArms(st, arms, variantArmsMeta(arms), (a, k) => k === 0 ? undefined
    : list(arms.slice(0, k).map((pr) => q`${a.c[ord]} NOT IN (SELECT ${ord} FROM ${pr.rel})`), ' AND '));
}

/** choose(pred, then, else) with mixed-shape then/else → a VariantStream. The gate
 *  partitions the input (pred / NOT pred); each arm folds from its gated seed. */
export function tryLowerVariantChoose(s: Step, st: ElementStream): VariantStream | null {
  if ((s as any).options) return null;
  assertForkSafe('choose', st);
  const args = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (args.length !== 3) return null; // two-arg choose has an element identity else arm
  const [predArg, thenArg, elseArg] = args;
  const thenShape = armShape(thenArg.nested, st.params);
  const elseShape = armShape(elseArg.nested, st.params);
  if (!thenShape || !elseShape || thenShape === elseShape) return null;
  if (st.carried.path) throw new Error('path() through a mixed-shape choose() not yet supported');
  const seedFor = chooseGate(st, predArg.nested);
  const thenArm = compileVariantArm(seedFor(false), thenArg.nested); // then before else (lazy gate bind order)
  const elseArm = compileVariantArm(seedFor(true), elseArg.nested);
  const arms = [thenArm, elseArm];
  return mergeVariantArms(st, arms, variantArmsMeta(arms));
}

/** flatMap(t): apply t per traverser, flatten all results — for element bodies this
 *  is just inlining the body (a fan-out through the dispatch). map()'s first-result-
 *  only semantics differ (needs a per-input row-number) and stay deferred. */
export const flatMap: StepFn = (s, st) => {
  assertForkSafe('flatMap', st); // 1:many is a split too — same sack/fromV concern
  // Single body, no merge — incoming aliases + the appended path ride through on `end`.
  const nested = s.args[0]?.nested;
  const end = tryCompileElementTraversal(st, nested)
    ?? (() => { throw new Error(`flatMap() branch __.${armDescription(nested, st.params)} not yet supported (scalar/projection body)`); })();
  mergeBranchCarried(st.carried, [end.carried]); // single arm: assert rigid cols agree; a new as() label rides on `end`
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
  const hasEmitPred = !!emitStep && emitStep.args.length > 0;
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
  // A bare single movement keeps the original (unchanged) term; anything more uses
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
  const untilFn = hasUntil ? walkPredicate(engineOf(st), untilStep!, st.params, 'until') : null;
  const untilFirst = hasUntil && cluster.indexOf(untilStep!) < cluster.indexOf(rep);
  const doneCol = (id: Expression, depth: Expression): Expression => q`, CASE WHEN ${untilFn!(id, depth)} THEN 1 ELSE 0 END AS done`;

  // emit(predicate): an `emit` column marks WHICH rows are output (vs until's `done`,
  // which marks termination). The walk proceeds regardless. emit-before tests the seed
  // (depth 0) too; emit-after only body results (depth ≥ 1) — so the seed's emit is 0
  // under emit-after. Every recursive row is tested by the predicate in both positions.
  const emitFn = hasEmitPred ? walkPredicate(engineOf(st), emitStep!, st.params, 'emit') : null;
  const emitCol = (id: Expression, depth: Expression): Expression => q`, CASE WHEN ${emitFn!(id, depth)} THEN 1 ELSE 0 END AS emit`;

  const walkCols = ['id', 'depth', ...(trackArray ? ['path'] : []), ...(hasUntil ? ['done'] : []), ...(hasEmitPred ? ['emit'] : [])];
  const walk = st.q.recursiveCte(walkCols, (self: Relation) => {
    // One recursive-term SELECT: advance to `finalId`, bump depth, accumulate path/done,
    // and guard expansion — shared depth<times / done=0 guards FIRST, then the branch's
    // own guards, so the bare single-movement case is unchanged from before.
    const mkRec = (finalId: Expression, from: Expression, branchGuards: Expression[]): Expression => {
      const pathAcc = trackArray ? q`, jsonb_insert(${self.c.path}, '$[#]', ${finalId}) AS path` : q``;
      const doneAcc = hasUntil ? doneCol(finalId, q`${self.c.depth} + 1`) : q``;
      const emitAcc = hasEmitPred ? emitCol(finalId, q`${self.c.depth} + 1`) : q``;
      const guards: Expression[] = [];
      if (timesStep) guards.push(q`${self.c.depth} < ${maxDepth!}`); // maxDepth non-null when timesStep set
      if (hasUntil) guards.push(q`${self.c.done}=0`); // until() expands only from still-looping rows
      guards.push(...branchGuards);
      const where = guards.length ? q` WHERE ${list(guards, ' AND ')}` : q``;
      return q`SELECT ${finalId} AS id, ${self.c.depth} + 1 AS depth${pathAcc}${doneAcc}${emitAcc} FROM ${from}${where}`;
    };
    // simplePath()'s cycle guard: reject a finalId already on the accumulated path.
    const cycleGuard = (finalId: Expression): Expression[] =>
      simplePathInBody ? [q`NOT EXISTS (SELECT 1 FROM json_each(${self.c.path}) je WHERE je.value=${finalId})`] : [];
    // Bare single movement → the ORIGINAL term (alias `e`, label in WHERE), unchanged.
    // Everything else (movement + has(), or multi-hop) → the general JOIN-chain expansion.
    const rec = singleMove
      ? dirsFor(core[0].name).map(([from, to]) => {
          const e = edges.as('e');
          const guards = [...cycleGuard(e.c[to]), ...(core[0].args.length ? [labelIn('e.label', core[0].args)] : [])];
          return mkRec(e.c[to], q`${self} JOIN ${e} ON ${e.c[from]}=${self.c.id}`, guards);
        })
      : expandRepeatBody(self, core).map(({ finalId, from, conds }) => mkRec(finalId, from, [...conds, ...cycleGuard(finalId)]));
    // The SEED is tested by a correlated predicate in two cases: while-do until
    // (untilFirst) and emit-before. A bare `id` inside that predicate's
    // `(SELECT … FROM nodes WHERE id=<seed id>)` would bind BOTH sides to nodes.id
    // (always true → wrong row), so alias the source (`w.id`). Every other seed uses
    // bare `id` (no subquery) → unchanged from before.
    const seedTested = untilFirst || (hasEmitPred && emitBefore);
    const seedSrc = seedTested ? st.rel.as('w') : st.rel;
    const seedId = seedTested ? seedSrc.c.id : q`id`;
    const seedSel = seedTested ? q`${seedId} AS id` : q`id`; // untested seed keeps bare `id` → unchanged
    const seedPath = trackArray ? q`, jsonb_array(${seedId}) AS path` : q``;
    const seedDone = hasUntil ? (untilFirst ? doneCol(seedId, q`0`) : q`, 0 AS done`) : q``;
    // emit-before tests+emits the seed (depth 0); emit-after never emits the seed.
    const seedEmit = hasEmitPred ? (emitBefore ? emitCol(seedId, q`0`) : q`, 0 AS emit`) : q``;
    return q`SELECT ${seedSel}, 0 AS depth${seedPath}${seedDone}${seedEmit} FROM ${seedSrc} UNION ALL ${list(rec, ' UNION ALL ')}`;
  });
  // Output: until() → the rows that satisfied the stop predicate; emit(pred) → the rows
  // whose emit column is set (the depth band is baked into that column); bare emit() →
  // every iteration (after → depth≥1; before → also the seed, depth≥0); times() without
  // emit → the final depth band. maxDepth is non-null in the last case (times present
  // whenever neither until nor emit is).
  const outWhere = hasUntil ? 'done = 1'
    : hasEmitPred ? 'emit = 1'
    : emitStep ? (emitBefore ? 'depth >= 0' : 'depth >= 1')
    : `depth = ${maxDepth}`;
  // Expose the path column iff a path() will frame it; else drop it (the array was
  // internal to the walk, only there for simplePath's guard). The recursive walk is a
  // barrier for carried bulk: its endpoints are freshly enumerated (one row per walk), so
  // each carries a fresh bulk of 1 (re-seeded, not carried through the walk) — matching a
  // sibling union arm's bulk so a branch merge agrees. A convergent-walk collapse that
  // reweights bulk through an unrolled times(n) is a later stage (a recursive GROUP BY is
  // rejected). `bulk` is the source-seeded carried column, always live here.
  if (wantsPathOutput)
    return advance(st, q`SELECT id, 1 AS bulk, path FROM ${walk} WHERE ${outWhere}`, { path: { kind: 'array', col: 'path', elem: 'node' } });
  return advance(st, q`SELECT id, 1 AS bulk FROM ${walk} WHERE ${outWhere}`);
};

// ---------- choose (predicate form) ----------

/** `NOT COALESCE((<pred>), 0)` — a NULL (missing prop) counts as false, so the
 *  else arm gets exactly the traversers the then arm didn't (mirrors filter.ts). */
const notCoalesce = (e: Expression): Expression => q`NOT COALESCE((${e}), 0)`;

/** choose() predicate gating (shared by element/scalar/list arms): a correlated
 *  boolean via the where()/filter() inline engine splits the stream into two gated
 *  seeds; when the predicate is beyond inline lowering, fall through to the SAME
 *  generic child-existence engine where()/filter() use (D2 — no more support-definer).
 *  Returns a LAZY seed factory: the inline predicate re-emits its binds at each
 *  interpolation, so the caller must build the then-seed (and compile its arm) before
 *  the else-seed to keep bind order interleaved with the arm SQL. Same gated-seed shape
 *  either way, so the arm compilers are unchanged. */
function chooseGate(st: ElementStream, predNested: any): (negate: boolean) => ElementStream {
  const inline = tryInlinePredicate(engineOf(st), stepChain(predNested, st.params), elemCtx(elemRel(st), st.elem), st.params);
  if (inline) return (negate) => gate(st, negate ? notCoalesce(inline) : inline);
  const gated = tryGateByChildExistence(st, predNested)
    ?? (() => { throw new Error('choose() predicate not supported by inline predicate or generic child existence lowering'); })();
  return (negate) => (negate ? gated.else : gated.then);
}

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
  const seedFor = chooseGate(st, predArg.nested);

  const arm = (arg: any, seed: ElementStream): ElementStream => {
    const body = stepChain(arg.nested, st.params);
    const end = tryCompileElementTraversal(seed, arg.nested);
    if (!end)
      throw new Error(`choose() branch __.${body.map((c) => c.name + '()').join('.')} not yet supported (scalar/projection body)`);
    return end;
  };

  const thenEnd = arm(thenArg, seedFor(false)); // then-seed + arm before else-seed (bind order)
  const elseSeed = seedFor(true);
  const elseEnd = elseArg ? arm(elseArg, elseSeed) : elseSeed; // else absent → identity
  if (thenEnd.elem !== elseEnd.elem)
    throw new Error('choose() branches produce different element kinds (mixed-shape) not yet supported');

  const out = mergeBranchCarried(st.carried, [thenEnd.carried, elseEnd.carried]); // merges alias sets, pads ragged path arms
  const parts = [
    q`SELECT ${armProjection(thenEnd, out, out.encounter ? 0 : undefined)} FROM ${thenEnd.rel}`,
    q`SELECT ${armProjection(elseEnd, out, out.encounter ? 1 : undefined)} FROM ${elseEnd.rel}`,
  ];
  return finishElementMerge(st, out, parts, { elem: thenEnd.elem, aliases: out.aliases, path: out.path });
};

/** Predicate choose with two homogeneous scalar result arms. The predicate gates
 * two ElementStream seeds exactly like element choose; each gated seed then enters
 * the generic child compiler and the resulting scalar rows merge with UNION ALL. */
export function tryLowerScalarChoose(s: Step, st: ElementStream): ScalarStream | null {
  if ((s as any).options) return null;
  assertForkSafe('choose', st);
  const args = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (args.length !== 3) return null; // two-arg choose has an element identity else arm
  const [predArg, thenArg, elseArg] = args;
  const thenPlan = classifyScalarChild(thenArg.nested, st.params);
  const elsePlan = classifyScalarChild(elseArg.nested, st.params);
  if (!thenPlan || !elsePlan) return null;
  const seedFor = chooseGate(st, predArg.nested);
  const lowerArm = (arg: any, body: ReturnType<typeof stepChain>, seed: ElementStream): ScalarStream =>
    (tryCompileScalarChild(seed, arg.nested, 'all', ROOT_SCOPE, body)
      ?? tryCompileCountChild(seed, arg.nested, ROOT_SCOPE, body))!;
  const thenEnd = lowerArm(thenArg, thenPlan.body, seedFor(false));
  const elseEnd = lowerArm(elseArg, elsePlan.body, seedFor(true));
  return unionScalarStreams(st, [thenEnd, elseEnd]);
}

export function tryLowerListChoose(s: Step, st: ElementStream): ListStream | null {
  if ((s as any).options) return null;
  assertForkSafe('choose', st);
  const args = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (args.length !== 3) return null;
  const [predArg, thenArg, elseArg] = args;
  const thenPlan = classifyListChild(thenArg.nested, st.params);
  const elsePlan = classifyListChild(elseArg.nested, st.params);
  if (!thenPlan || !elsePlan) return null;
  const seedFor = chooseGate(st, predArg.nested);
  const thenEnd = tryCompileListChild(seedFor(false), thenArg.nested, ROOT_SCOPE, thenPlan.body)!;
  const elseEnd = tryCompileListChild(seedFor(true), elseArg.nested, ROOT_SCOPE, elsePlan.body)!;
  const parts = [thenEnd, elseEnd].map((arm) => {
    const a = arm.rel.as('a');
    return q`SELECT ${a.c.list} AS list${carryFrag(st.carried, a)} FROM ${a}`;
  });
  const rel = st.q.cte(list(parts, ' UNION ALL '), ['list', ...carriedCols(st.carried)]);
  return toListStream(carryOf(st), rel, unifyLists([thenEnd, elseEnd]));
}
