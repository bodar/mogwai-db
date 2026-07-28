import { q, list, empty, paren, value, raw, Relation, type Expression } from '../../../sql/kernel/q.ts';
import { staticTypeOf } from '../../../sql/kernel/render.ts';
import { edges } from '../../../sql/schema.ts';
import { isNested, stepChain, type SackSpec, type Step } from '../../../gremlin/frontend.ts';
import { type PStep } from '../../ir/strategies.ts';
import { normalize } from '../../ir/passes.ts';
import { analyze, type ChainFacts } from '../../ir/analyze.ts';
import { dirsFor, edgeLabelFilter, labelIn, nodeHasProp, hasProp, elemCtx, scalarProp, aliasCtx, labelNameSub, predicateSql, jsonbGroupArray, type ScalarCtx, type Elem } from '../../plan/plan.ts';
import { tryInlinePredicate, PredicateInliningFastPath } from './predicate.ts';
import { advance, aliasColsOf, elemRel, labelScope, prevRel, carryFrag, carryFragMint, carriedCols, carriedWith, mergeCarried, rehomeCarried, rigidCols, partitionOver, type AliasEntry, type AliasMap, type Carried, type Carry, type PathState, type ElementStream, type StepFn, type SideEffectDef } from '../context/context.ts';
import { type AliasShape } from '../context/alias.ts';
import { keyedChildRelation, keyedKeySet } from '../tail/keyed.ts';
import { pushChildScope, tryCompileCountChild, tryCompileElementTraversal, tryCompileListChild, tryCompileScalarChild, tryCompileScalarModulations, tryCompileScalarValueChild, tryCompileScalarValueRows, tryGateByChildExistence } from '../tail/child.ts';
import { childCtx, childSteps, classifyArmShape, classifyListChild, classifyScalarChild, isGlobalBarrier, optionMapMerge, optionMapNeedsPassthrough, readOptionMapArms, ROOT_SCOPE, type BranchArmShape, type ChildCtx } from '../tail/child-shape.ts';
import { emptyElementLike } from '../tail/labelselect.ts';
import { carryOf, toVariantStream, type ListStream, type ScalarStream, type Stream, type VariantStream } from '../context/stream.ts';
import { finishListMerge, mergeVariantArms, mergeVariantParts, variantArmsMeta, type VariantArm } from '../tail/variant.ts';
import { unionScalarStreams, SACK_OPS, combineSack } from '../tail/scalar.ts';
import { engineOf, fastPathContextOf, type Engine } from '../../engine/deps.ts';
import { runFastPath, type FastPath } from '../../options/fast-paths.ts';

/** A ScalarCtx correlating on a walk row's current vertex id — its props/label are
 *  read back from `nodes` by subquery (the walk row carries only the id). Lets
 *  until()'s predicate reuse the where()/filter() predicate engine over each hop. */
const walkNodeCtx = (idExpr: Expression): ScalarCtx => {
  const sub = (col: string) => q`(SELECT ${col} FROM nodes WHERE id=${idExpr})`;
  // Node ctx: props are read from vertex_properties via idExpr (hasProp/scalarProp),
  // so no propsExpr (that's edge-only now).
  return { elem: 'vertex', idExpr, extIdExpr: sub('COALESCE(uid, id)'), labelIdExpr: sub('label') };
};


/** Compile an until()/emit() traversal modulator into `(id, depth) → boolean SQL`, routing
 *  the WHOLE body through the shared predicate engine on a correlated walk ctx. loops()
 *  reads the depth counter via ctx.loopsExpr; every other leaf is an element predicate over
 *  the current vertex (has/hasLabel/values/out…count().is), and the infix/and/or machinery
 *  composes them — so until(__.has('name','x').or().loops().is(3)) lowers as one boolean.
 *  Movement leaves correlate through the same compileCorrelatedChild as where()/choose().
 *  until() and emit() share this: the only difference is what the resulting column drives
 *  (termination vs output).
 *
 *  TWO routes, inline FIRST. The inline compiler is the fast path AND the wider vocabulary
 *  (it alone reaches loops()/sack()/reducers), so it is tried first and everything that
 *  worked before is unchanged. When it declines, the KEYED CHILD RELATION is the generic
 *  fallback: a row-local element predicate compiles ONCE over every vertex and the recursive
 *  term reads `id IN <origins that produced a row>`. That is the same trick the repeat BODY
 *  uses, which is why both live behind one module. */
function walkPredicate(st: ElementStream, step: Step, kind: 'until' | 'emit'): (id: Expression, depth: Expression, sackExpr: Expression | null) => Expression {
  const engine = engineOf(st);
  const params = st.params;
  const nested = stepChain(step.args[0]?.nested, params);
  if (!nested.length) throw new Error(`${kind}() requires a traversal predicate`);
  // A pure sack-reading predicate — until(__.sack().is(P)) / emit(__.sack().is(P)) — reads the
  // walk's ACCUMULATED sack, not an element property, so it can't route through the element
  // ScalarCtx. Recognize the exact shape (mirror of sackWhereGuard) and compare the freshly-folded
  // sack against P. This is the spreading-activation-with-threshold primitive: loop until the
  // decayed relevance crosses a bound. A mixed sack+element predicate stays deferred.
  const sackPred = nested.length === 2 && nested[0].name === 'sack' && (nested[0].args ?? []).length === 0 && nested[1].name === 'is'
    ? nested[1].args[0] : undefined;
  // NB until()/emit() deliberately do NOT gate on PredicateInliningFastPath. The inline route is
  // the only one that can read the walk's PER-ITERATION state (loops(), the sack), so disabling it
  // would lose a capability rather than just speed — which is exactly the fast-path law's
  // "disable-safe" requirement failing, so it isn't declared as one.
  //
  // The keyed fallback below needs no separate guard against those per-iteration bodies: `loops` and
  // a bare read `sack()` are both OUTSIDE the row-local vocabulary (`isElementChildStep`), so
  // keyedChildRelation declines them on its own and we fail closed with a clear deferral. Built
  // LAZILY and memoized — a CTE registered here would show up in the emitted SQL even when the
  // inline route serves the predicate, and the closure is called more than once (seed + recursive
  // term) for while-do until / emit-before.
  let keySet: Relation | null | undefined;
  const genericGate = (id: Expression): Expression | null => {
    if (keySet === undefined) {
      // Normalized with the SAME normalize() every other nested body uses — not a hand-picked
      // fold — so a modulator inside the predicate folds as it would anywhere else.
      const k = keyedChildRelation(st, normalize(nested as PStep[]).steps);
      keySet = k ? keyedKeySet(st, k) : null;
    }
    // until(traversal)/emit(traversal) are EXISTENCE: "does the body produce a result for this
    // traverser". So the gate is membership in the origin set, which is what keyedKeySet is.
    return keySet ? q`${id} IN (SELECT ${keySet.c.id} FROM ${keySet})` : null;
  };
  return (id, depth, sackExpr) => {
    if (sackPred !== undefined) {
      if (!sackExpr) throw new Error(`${kind}(__.sack()...) requires a sack (withSack() or a body sack(op))`);
      return predicateSql(sackExpr, sackPred);
    }
    return tryInlinePredicate(engine, nested, { ...walkNodeCtx(id), loopsExpr: depth }, params)
      ?? genericGate(id)
      ?? (() => {
        throw new Error(`${kind}(__.${nested.map((n) => n.name + '()').join('.')}) not yet supported: beyond inline lowering, and not row-local enough to precompile as a keyed relation (a per-iteration body — loops()/sack() — or a global barrier)`);
      })();
  };
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

/** A branch forks a traverser into arms. TinkerPop split-only semantics: each arm gets a
 *  CLONE of the incoming per-traverser state and the arms never recombine. as() aliases,
 *  path positions AND the sack all clone cleanly — the incoming sack column rides into every
 *  arm via carryFrag, passes through unchanged (a mutate sack(op) inside an arm is separately
 *  deferred — it isn't in the child-body vocabulary), and armProjection/rigidCols project it
 *  through the merge. Only fromV stays gated: an edge's otherV() entering-vertex has no
 *  defined meaning once a fork moves off the edge, so fail closed rather than carry a stale id. */
function assertForkSafe(name: string, st: ElementStream): void {
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
  // The path pad-to-max is branch-specific (every other merge declines a live path), so it is
  // computed here and handed to the shared authority.
  return mergeCarried(seed, arms, seed.path ? mergePaths(arms.map((a) => a.path!)) : undefined);
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
 *  are the per-arm SELECTs (each already carrying `arm_idx` when `out.encounter` is live).
 *
 *  Takes a bare `Carry`, like its three siblings (unionScalarStreams / finishListMerge /
 *  mergeVariantArms): the arms' PARENT is not part of a merge, only the carried schema they
 *  forked from — which lets a `union()` SOURCE, whose arms are rooted and have no parent at all,
 *  reuse it with a synthesized base (sourceUnion, below). */
function finishElementMerge(base: Carry, out: Carried, parts: Expression[], opts: { elem: Elem; aliases: AliasMap; origins?: readonly string[]; path?: PathState }): ElementStream {
  let body = list(parts, ' UNION ALL ');
  if (out.encounter) {
    const inner = base.q.cte(body, ['id', ...carriedCols(out), 'arm_idx']);
    const m = inner.as('m');
    const over = partitionOver(out, m, q`${m.c.arm_idx}, ${m.c[out.encounter]}`);
    body = q`SELECT ${m.c.id} AS id${carryFragMint(out, m, out.encounter, q`ROW_NUMBER() OVER (${over})`)} FROM ${m}`;
  }
  const carried = carriedWith(base.carried, opts);
  return { ...base, kind: 'elements', elem: opts.elem, carried, rel: base.q.cte(body, ['id', ...carriedCols(carried)]) };
}

/** Merge a set of ELEMENT arms into one element stream — the ungated entry to the element merge,
 *  the twin of unionScalarStreams / finishListMerge / mergeVariantArms. `base.carried` is
 *  the schema the arms forked from: its RIGID columns must agree with every arm's, its alias set
 *  unions with theirs (a label bound in only one arm NULL-pads), and its path — when live — pads
 *  to the longest arm. The gated merges (coalesce/optional/choose) call finishElementMerge
 *  directly: they add a per-arm WHERE and pop their own ordinal, which this shape has no room for. */
export function mergeElementArms(base: Carry, arms: readonly ElementStream[]): ElementStream {
  const elem = arms[0].elem;
  if (arms.some((e) => e.elem !== elem)) throw new Error('union() branches produce different element kinds (mixed-shape) not yet supported');
  const out = mergeBranchCarried(base.carried, arms.map((e) => e.carried)); // merges alias sets, pads ragged path arms
  const selects = arms.map((e, k) => q`SELECT ${armProjection(e, out, out.encounter ? k : undefined)} FROM ${e.rel}`);
  return finishElementMerge(base, out, selects, { elem, aliases: out.aliases, path: out.path });
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
  const branches = s.args.filter(isNested);
  // A SINGLE branch is legal Gremlin — union() is varargs and `union(t)` is just t — and the arm
  // merge handles one arm fine (it is a UNION ALL of one). Rejecting it was the same artificial
  // arity guard and()/or() carried: it broke the metamorphic law `union(q) === q`. ZERO branches
  // still throws (nothing to merge).
  if (branches.length === 0) throw new Error('union() needs at least one branch');
  const ends = branches.map((b) => tryCompileElementTraversal(st, b.nested)
    ?? (() => { throw new Error(`union() branch __.${armDescription(b.nested, st.params)} not yet supported (scalar/projection body)`); })());
  return mergeElementArms(carryOf(st), ends);
};

/** Homogeneous scalar union through the generic child compiler. Every arm applies
 * `all` to the same incoming parent stream; UNION ALL then concatenates their
 * productive rows. Element/scalar mixing deliberately returns null so the legacy
 * element union emits its existing fail-closed mixed-shape error. */
export function tryLowerScalarUnion(s: Step, st: ElementStream): ScalarStream | null {
  assertForkSafe('union', st);
  const branches = s.args.filter(isNested);
  // A SINGLE branch is legal Gremlin — union() is varargs and `union(t)` is just t — and the arm
  // merge handles one arm fine (it is a UNION ALL of one). Rejecting it was the same artificial
  // arity guard and()/or() carried: it broke the metamorphic law `union(q) === q`. ZERO branches
  // still throws (nothing to merge).
  if (branches.length === 0) throw new Error('union() needs at least one branch');
  const arms: ScalarStream[] = [];
  for (const branch of branches) {
    // Classify first so a trailing as() run is peeled and handed to the emitter; unionScalarStreams
    // already unions the arms' label sets, so the bound label survives the merge.
    const plan = classifyScalarChild(branch.nested, childCtx(st));
    const arm = tryCompileScalarChild(st, branch.nested, 'all', ROOT_SCOPE, plan ?? undefined)
      ?? tryCompileCountChild(st, branch.nested, ROOT_SCOPE, plan ?? undefined);
    if (!arm) return null;
    arms.push(arm);
  }
  return unionScalarStreams(st, arms);
}

export function tryLowerListUnion(s: Step, st: ElementStream): ListStream | null {
  assertForkSafe('union', st);
  const branches = s.args.filter(isNested);
  if (branches.length < 2) return null;
  // classify every arm once (pure, no CTE); emit only if ALL qualify, reusing each parsed
  // body — so a partly-list union never emits arm0's CTEs before a later arm disqualifies.
  const plans = branches.map((b) => classifyListChild(b.nested, childCtx(st)));
  if (plans.some((p) => !p)) return null;
  const arms = branches.map((branch, i) => tryCompileListChild(st, branch.nested, ROOT_SCOPE, plans[i]!)!);
  return finishListMerge(carryOf(st), arms);
}

/** optional(t) = t where it yields output, else the traverser itself. Fast path: a
 *  single out()/in() over vertices → LEFT JOIN + COALESCE-to-self (index-only, no
 *  window). General path: optional(t) = coalesce(t, identity) via the input ordinal
 *  — emit t's results, plus each input unchanged where t produced nothing. Same-shape
 *  only: the self-on-miss fallback is the input element, so t must not flip the kind. */
/** The singleHopOptional fast path. Applies ONLY without path tracking or a live branch origin:
 *  with a path, a hit extends it and a miss does not, so the two are ragged and must take the
 *  padded general path. tryLower emits a single LEFT JOIN — on a hit id = the neighbour, on a miss
 *  COALESCE keeps the input id; the carried columns come from `p` (the input) either way. Declines
 *  → the general originSeed/coalesce path below (result-equivalent). */
export const SingleHopOptionalFastPath: FastPath<[ElementStream, Step[]], ElementStream> = {
  name: 'singleHopOptional',
  equivalentWhen: 'test/L5-properties/differential.test.ts — the fast-path differential (this switch off vs. on, over the L1 corpus + generated traversals)',
  appliesWhen: (ctx, st, body) =>
    ctx.enabled.singleHopOptional && !st.carried.origins.length && !st.carried.path
    && body.length === 1 && (body[0].name === 'out' || body[0].name === 'in') && st.elem === 'vertex',
  tryLower: (_ctx, st, body) => {
    const [from, to] = dirsFor(body[0].name)[0];
    const e = edges.as('e');
    const p = prevRel(st, 'p');
    return advance(st, q`SELECT COALESCE(${e.c[to]}, ${p.c.id}) AS id${carryFrag(st.carried, p)} FROM ${p} LEFT JOIN ${e} ON ${e.c[from]}=${p.c.id}${edgeLabelFilter(body[0].args)}`);
  },
};

export const optional: StepFn = (s, st) => {
  assertForkSafe('optional', st);
  const body = stepChain(s.args[0]?.nested, st.params);
  if (!body.length) throw new Error('optional(traversal) required');
  const fast = runFastPath(SingleHopOptionalFastPath, fastPathContextOf(st), st, body);
  if (fast) return fast;
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
  const out = rehomeCarried(merged, st.carried.origins);
  const baseSt: ElementStream = { ...seedSt, rel: base };
  const hit = q`SELECT ${armProjection(end, out, out.encounter ? 0 : undefined)} FROM ${end.rel}`;
  const miss = q`SELECT ${armProjection(baseSt, out, out.encounter ? 1 : undefined)} FROM ${base} WHERE ${ord} NOT IN (SELECT ${ord} FROM ${end.rel})`;
  return finishElementMerge(carryOf(st), out, [hit, miss], { elem: end.elem, aliases: out.aliases, origins: st.carried.origins, path: out.path });
};

/** Shape-changing optional: productive scalar child rows win; an unproductive
 * parent emits its original element. Both arms retain the same outer carried
 * schema, while the child-only origin is consumed by the anti-existence arm. */
export function tryLowerVariantOptional(s: Step, st: ElementStream): VariantStream | null {
  const nested = s.args[0]?.nested;
  const plan = classifyScalarChild(nested, childCtx(st));
  if (!plan) return null;
  // Same fail-closed wall as the three mixed-shape siblings (union/coalesce/choose above): the
  // hit arm is a scalar row (no path position) and the miss arm the original element (keeps
  // its positions), so the merged rows are ragged in a way the array regime would have to
  // reconcile. Consuming path() off a variant already throws in the variant tail; guarding HERE
  // names the real cause (the branch) instead of the downstream symptom.
  if (st.carried.path) throw new Error('path() through a mixed-shape optional() not yet supported');
  const rows = tryCompileScalarValueRows(st, nested, ROOT_SCOPE, plan.body);
  if (!rows) return null;
  const meta = { scalarAs: staticTypeOf(rows.stream.type), ...(st.elem === 'edge' ? { edge: true } : { node: true }) } as const;
  const c = rows.stream.rel.as('c');
  const d = rows.frame.domain.as('d');
  // Hit (the scalar child rows) before miss (the unproductive parent, restored) — optional() IS
  // coalesce(t, identity), so arm order is the take-first order. Tag both arms when emission
  // order is live so mergeVariantParts re-mints the canonical encounter once.
  const enc = st.carried.encounter;
  const baseNoEnc = enc ? carriedWith(st.carried, { encounter: null }) : st.carried;
  const armTag = (k: number, r: Relation) => enc ? q`, ${k} AS arm_idx, ${r.c[enc]} AS arm_encounter` : empty;
  const hit = q`SELECT 1 AS vk, ${c.c.v} AS v, NULL AS rid${armTag(0, c)}${carryFrag(baseNoEnc, c)} FROM ${c}`;
  const miss = q`SELECT 2 AS vk, NULL AS v, ${d.c.id} AS rid${armTag(1, d)}${carryFrag(baseNoEnc, d)} FROM ${d} WHERE NOT EXISTS (SELECT 1 FROM ${c} WHERE ${c.c[rows.frame.ordinal]}=${d.c[rows.frame.ordinal]})`;
  return mergeVariantParts(carryOf(st), [hit, miss], meta);
}

/** coalesce(t1, …, tn): the first branch that yields output, per input traverser.
 *  Tag each input with a unique ordinal (originSeed), fold every branch carrying it,
 *  then emit branch k only for inputs no earlier branch produced a row for. Same-shape
 *  branches only; scalar-body defers. Nests inside coalesce/optional (unique ordinal per depth). */
export const coalesce: StepFn = (s, st) => {
  assertForkSafe('coalesce', st);
  const branches = s.args.filter(isNested);
  if (branches.length < 1) throw new Error('coalesce() needs at least one branch');
  const { seedSt, ord } = originSeed(st); // unique ordinal — nests inside optional/coalesce
  const ends = branches.map((b) => tryCompileElementTraversal(seedSt, b.nested)
    ?? (() => { throw new Error(`coalesce() branch __.${armDescription(b.nested, st.params)} not yet supported (scalar/projection body)`); })());
  const elem = ends[0].elem;
  if (ends.some((e) => e.elem !== elem)) throw new Error('coalesce() branches produce different element kinds (mixed-shape) not yet supported');
  // Pad ragged path arms; POP this branch's ordinal on output (restore the outer origins).
  const merged = mergeBranchCarried(seedSt.carried, ends.map((e) => e.carried));
  const out = rehomeCarried(merged, st.carried.origins);
  const parts = ends.map((end, k) => {
    const sel = armProjection(end, out, out.encounter ? k : undefined);
    if (k === 0) return q`SELECT ${sel} FROM ${end.rel}`;
    const notPrior = list(ends.slice(0, k).map((pr) => q`${ord} NOT IN (SELECT ${ord} FROM ${pr.rel})`), ' AND ');
    return q`SELECT ${sel} FROM ${end.rel} WHERE ${notPrior}`;
  });
  return finishElementMerge(carryOf(st), out, parts, { elem, aliases: out.aliases, origins: st.carried.origins, path: out.path });
};

/** Homogeneous scalar coalesce: compile every arm from one ordinal-tagged seed, then
 * emit arm k only where no earlier arm produced a row for that parent ordinal. The
 * internal ordinal is removed at the merge boundary while outer carried state stays. */
export function tryLowerScalarCoalesce(s: Step, st: ElementStream): ScalarStream | null {
  assertForkSafe('coalesce', st);
  const branches = s.args.filter(isNested);
  if (!branches.length) return null;
  const plans = branches.map((b) => classifyScalarChild(b.nested, childCtx(st)));
  if (plans.some((p) => !p)) return null;
  const { seedSt, ord } = originSeed(st);
  const arms = branches.map((branch, i) =>
    (tryCompileScalarChild(seedSt, branch.nested, 'all', ROOT_SCOPE, plans[i]!)
      ?? tryCompileCountChild(seedSt, branch.nested, ROOT_SCOPE, plans[i]!))!);
  return unionScalarStreams(st, arms, (a, k) =>
    k === 0 ? undefined : list(arms.slice(0, k).map((p) => q`${a.c[ord]} NOT IN (SELECT ${ord} FROM ${p.rel})`), ' AND '));
}

export function tryLowerListCoalesce(s: Step, st: ElementStream): ListStream | null {
  assertForkSafe('coalesce', st);
  const branches = s.args.filter(isNested);
  if (!branches.length) return null;
  const plans = branches.map((b) => classifyListChild(b.nested, childCtx(st)));
  if (plans.some((p) => !p)) return null;
  const { seedSt, ord } = originSeed(st);
  const arms = branches.map((branch, i) => tryCompileListChild(seedSt, branch.nested, ROOT_SCOPE, plans[i]!.body)!);
  // The merge projects the OUTER carried (st), not the seed's — the pushed ordinal is consumed by
  // the not-in-prior gate and must not leak into the merged list stream's declared schema.
  return finishListMerge(carryOf(st), arms, (a, k) => k === 0 ? undefined
    : list(arms.slice(0, k).map((p) => q`${a.c[ord]} NOT IN (SELECT ${ord} FROM ${p.rel})`), ' AND '));
}

// ---------- mixed-shape branch arms → a dynamic-tag VariantStream (P4) ----------
//
// When a union/coalesce/choose's arms are NOT one shape class (some scalar, some
// element, some list), no per-shape handler (list/scalar/legacy-element) applies.
// Compile each arm to its natural shape and merge the rows into one variant relation
// where `vk` tags each row's shape (1 scalar / 2 node / 3 edge / 4 list). Homogeneous
// arms keep their richer per-shape handlers (path/aliases); mixed element KIND
// (node+edge, both element-class) stays with the legacy element compiler's clear defer.

/** ONE arm's shape, from the canonical classifier (child-shape.ts) — never a second
 *  element/scalar/list if-chain. `classifyArmShape` is the same per-arm probe
 *  `classifyBranchArms` folds over, so a single arm and a whole branch can't disagree. */
const armShape = classifyArmShape;

/** Compile ONE branch body from `seed` to a variant-arm carrying seed's exact carried
 *  schema: element movement → node/edge, values/id/label/count → scalar, …fold() → list. */
function compileVariantArm(seed: ElementStream, nested: any): VariantArm {
  const element = tryCompileElementTraversal(seed, nested);
  if (element) return { rel: element.rel, vk: element.elem === 'edge' ? 3 : 2 };
  const scalar = tryCompileScalarValueChild(seed, nested, 'all');
  if (scalar) return { rel: scalar.rel, vk: 1, as: staticTypeOf(scalar.type) };
  const listArm = tryCompileListChild(seed, nested);
  if (listArm) return { rel: listArm.rel, vk: 4, listOf: listArm.of };
  throw new Error(`variant branch __.${armDescription(nested, seed.params)} not yet supported (shape not element/scalar/list)`);
}

/** Are these branch shapes genuinely mixed (not all one class, all classifiable)? The
 *  `merge === 'variant'` verdict of the canonical triage, expressed over a bare arm list (the
 *  mixed-shape lowerers below receive the arms already extracted). */
function branchesAreMixed(branches: readonly any[], ctx: ChildCtx): boolean {
  const shapes = branches.map((b) => armShape(b.nested, ctx));
  return !shapes.some((x) => x === null) && !shapes.every((x) => x === shapes[0]);
}

/** union() over mixed-shape arms → a VariantStream (plain UNION ALL, no gating). */
export function tryLowerVariantUnion(s: Step, st: ElementStream): VariantStream | null {
  assertForkSafe('union', st);
  const branches = s.args.filter(isNested);
  if (branches.length < 2 || !branchesAreMixed(branches, childCtx(st))) return null;
  if (st.carried.path) throw new Error('path() through a mixed-shape union() not yet supported');
  const arms = branches.map((b) => compileVariantArm(st, b.nested));
  return mergeVariantArms(st, arms, variantArmsMeta(arms));
}

/** coalesce() over mixed-shape arms → a VariantStream. One ordinal-tagged seed feeds
 *  every arm; arm k emits only for parents no earlier arm produced a row for. */
export function tryLowerVariantCoalesce(s: Step, st: ElementStream): VariantStream | null {
  assertForkSafe('coalesce', st);
  const branches = s.args.filter(isNested);
  if (!branches.length || !branchesAreMixed(branches, childCtx(st))) return null;
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
  const args = s.args.filter(isNested);
  if (args.length !== 3) return null; // two-arg choose has an element identity else arm
  const [predArg, thenArg, elseArg] = args;
  const thenShape = armShape(thenArg.nested, childCtx(st));
  const elseShape = armShape(elseArg.nested, childCtx(st));
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
// movement's directions (both() = 2) — one recursive SELECT per combo. Bodies still
// deferred here (can't live in one flat recursive term): barrier/collection steps
// (limit/dedup/order/local/union/groupCount/nested-repeat), hasLabel()/complex has(). A
// mutate sack(op).by(v) IS supported — it folds a carried accumulator (context.ts sack)
// through the walk, and a where(__.sack().is(P)) guard reads the freshly-folded value.

const REPEAT_MOVES = new Set(['out', 'in', 'both']);
// Vertex→edge steps (land on an edge) and edge→vertex steps (land on an endpoint vertex).
// Together with REPEAT_MOVES these are the walk's movement vocabulary; edge steps let a body
// pause ON an edge to fold its property (path-weight accumulation: outE().sack().by('weight').inV()).
const TO_EDGE = new Set(['outE', 'inE', 'bothE']);
const TO_VERTEX = new Set(['outV', 'inV', 'bothV']);
const REPEAT_MOVE_ALL = new Set([...REPEAT_MOVES, ...TO_EDGE, ...TO_VERTEX]);
/** Steps in a repeat() body that are PER-ITERATION GLOBAL barriers — they observe the whole
 *  frontier at one iteration, which a recursive CTE cannot window across. Named only so the
 *  deferral can say WHICH one and why (see the repeatBodyRelation header); nothing dispatches on
 *  it. `local` is here because it re-scopes a barrier per traverser, which is the same problem
 *  seen from the other side. */


/** A body's sack fold, threaded through the walk left-to-right: `combineSack` applied at
 *  the body position where the sack(op) step sits (so its by() reads the element the
 *  traverser is on THEN — a vertex OR an edge). One SQL expression over `self.c.sk` + a
 *  correlated by-value — no per-row JS, no self-reference twice. Only a mutate sack (has an
 *  operator) produces one; a bare sack() read inside the body is not a fold. */
export function repeatSackByValue(byArgs: any[] | undefined, curId: Expression, curElem: Elem): Expression {
  const a = byArgs?.[0];
  if (a === undefined) throw new Error('sack(Operator.x) in a repeat() body requires a by() modulator');
  if (typeof a === 'string') return scalarProp(aliasCtx(curId, curElem), a);
  if (a && typeof a === 'object' && 'token' in a) {
    if (a.token === 'label') return labelNameSub(aliasCtx(curId, curElem).labelIdExpr);
    if (a.token === 'id') return curId;
    throw new Error(`sack().by(T.${a.token}) in a repeat() body not yet supported`);
  }
  if (isNested(a)) {
    // A constant by() folds a fixed step (decay factor, per-hop increment); anything that
    // reads the graph and could fan out can't live in a single flat recursive SELECT.
    const inner = stepChain(a.nested, {});
    if (inner.length === 1 && inner[0].name === 'constant') return q`CAST(${value(inner[0].args[0])} AS REAL)`;
    throw new Error('sack().by(traversal) in a repeat() body not yet supported (only by(key)/by(T)/by(constant); a fan-out traversal cannot live in a recursive term)');
  }
  throw new Error('unsupported sack().by() modulator in a repeat() body');
}

/** The predicate `P` of a `where(__.sack().is(P))` body guard, or null if the where is
 *  not that exact shape (a sack-reading loop guard). Lets the walk expand only from rows
 *  whose freshly-folded sack still satisfies P — TinkerPop's Repeat.feature:664. */
export function sackWhereGuard(step: Step): any | null {
  if (step.name !== 'where') return null;
  const inner = stepChain(step.args[0]?.nested, {});
  if (inner.length === 2 && inner[0].name === 'sack' && (inner[0].args ?? []).length === 0 && inner[1].name === 'is')
    return inner[1].args[0];
  return null;
}

/** The per-movement direction choices, as (from,to) endpoint-column pairs. Vertex movements
 *  (out/in/both) and vertex→edge steps (outE/inE/bothE) both join a NEW edge on `from`; a
 *  bothX forks into two. Edge→vertex steps (outV/inV/bothV) read the CURRENT edge's endpoint,
 *  so they carry the endpoint column choice(s) but add no join (handled in the expander). */
function moveDirs(name: string): [string, string][] {
  if (name === 'out' || name === 'outE') return [['src', 'tgt']];
  if (name === 'in' || name === 'inE') return [['tgt', 'src']];
  if (name === 'both' || name === 'bothE') return [['src', 'tgt'], ['tgt', 'src']];
  if (name === 'outV') return [['src', 'src']];
  if (name === 'inV') return [['tgt', 'tgt']];
  return [['src', 'src'], ['tgt', 'tgt']]; // bothV
}

/** Cartesian product of each movement's direction choices (both/bothE/bothV fork into two). */
function dirCombos(moves: Step[]): [string, string][][] {
  let combos: [string, string][][] = [[]];
  for (const m of moves) combos = combos.flatMap((c) => moveDirs(m.name).map((d) => [...c, d] as [string, string][]));
  return combos;
}

/** Expand a movement+has()+sack() body into one {finalId, from, conds, sackExpr} per
 *  direction combo. Threads `curId`/`curElem` (element position + kind) AND `sackExpr` (the
 *  accumulator) left-to-right, so each sack(op).by() folds using the position/kind the
 *  traverser holds THEN and each where(__.sack().is(P)) guards on the sack value at that point.
 *  Vertex→edge steps land ON the joined edge (so a following sack().by('weight') reads it);
 *  edge→vertex steps read the current edge's endpoint (no new join). `sackExpr` is null when
 *  the incoming stream has no sack and the body folds none. `finalElem` is the walk endpoint
 *  kind — always 'vertex' (the walk id is a vertex rowid; a body ending on an edge is rejected). */
function expandRepeatBody(
  self: Relation, core: Step[], sackCol: string | undefined,
): { finalId: Expression; from: Expression; conds: Expression[]; sackExpr: Expression | null; finalElem: Elem }[] {
  const moves = core.filter((c) => REPEAT_MOVE_ALL.has(c.name));
  return dirCombos(moves).map((dirs) => {
    let curId: Expression = self.c.id;
    let curElem: Elem = 'vertex';
    let curEdge: Relation | null = null; // the edge alias we're currently ON (after a vertex→edge step)
    let sackExpr: Expression | null = sackCol ? self.c[sackCol] : null;
    const joins: Expression[] = [];
    const conds: Expression[] = [];
    let mi = 0;
    for (const step of core) {
      if (REPEAT_MOVES.has(step.name) || TO_EDGE.has(step.name)) {
        // Vertex movement (lands on the far vertex) or vertex→edge step (lands on the edge).
        const [from, to] = dirs[mi++];
        const e = edges.as(`re${mi}`);
        joins.push(q` JOIN ${e} ON ${e.c[from]}=${curId}${step.args.length ? q` AND ${labelIn(`${e.name}.label`, step.args)}` : empty}`);
        if (TO_EDGE.has(step.name)) { curId = e.c.id; curElem = 'edge'; curEdge = e; }
        else { curId = e.c[to]; curElem = 'vertex'; curEdge = null; }
      } else if (TO_VERTEX.has(step.name)) {
        // Edge→vertex: read the current edge's endpoint column (no new join). Requires being
        // on an edge (a body starting/continuing off an edge is a compile error, guarded here).
        if (!curEdge) throw new Error(`${step.name}() in a repeat() body requires being on an edge (a preceding outE()/inE()/bothE())`);
        const [, to] = dirs[mi++];
        curId = curEdge.c[to]; curElem = 'vertex'; curEdge = null;
      } else if (step.name === 'has') {
        // has() only (hasLabel/complex has deferred at validation): a correlated EXISTS on the
        // current element (a vertex, or an edge when paused on one after outE()/inE()).
        conds.push(hasProp(aliasCtx(curId, curElem), step.args[0], step.args[1]));
      } else if (step.name === 'sack') {
        // Mutate sack(op).by(v): fold the by-value (over the current position/kind) into the
        // accumulator. Reuses combineSack verbatim (boundary-agnostic operator semantics).
        const op = (step.args ?? []).find((a: any) => a && typeof a === 'object' && 'operator' in a)?.operator;
        if (!op) throw new Error('bare sack() (read) inside a repeat() body is not a fold — use where(__.sack()...) to guard');
        if (!SACK_OPS.has(op)) throw new Error(`sack(Operator.${op}) not yet supported`);
        sackExpr = combineSack(op, repeatSackByValue((step as any).bys?.[0], curId, curElem), sackExpr);
      } else {
        // where(__.sack().is(P)): expand only from rows whose current sack satisfies P.
        const pred = sackWhereGuard(step);
        if (pred === null) throw new Error(`repeat() body step ${step.name}() not yet supported`);
        if (!sackExpr) throw new Error('where(__.sack()...) in a repeat() body requires a sack (withSack() or a body sack(op))');
        conds.push(predicateSql(sackExpr, pred));
      }
    }
    // The walk id is a vertex rowid; a body must net back to a vertex (outE()…inV()). A body
    // left ON an edge (outE() with no closing …V()) is rejected — the walk can't carry an edge id.
    if (curElem !== 'vertex') throw new Error('a repeat() body must end on a vertex (an edge step needs a closing inV()/outV()/otherV())');
    return { finalId: curId, from: q`${self}${list(joins, '')}`, conds, sackExpr, finalElem: curElem };
  });
}

// ---------- the GENERIC repeat body: a KEYED CHILD RELATION ----------
//
// `expandRepeatBody` above is a private movement/filter mini-compiler: its own direction table, its
// own edge aliases, its own has() handling — a second implementation of what the StepFns already
// do, and therefore a vocabulary wall (no hasLabel/hasId/where/not/filter/union/…). It exists for a
// real reason: SQLite has no `LATERAL`, so a FAN-OUT body inside the recursive term's FROM cannot
// reference the walk row. Hence a flat JOIN chain, hand-built — and it stays, as the frontier-lazy
// fast path.
//
// The way out needs no new rendering mode and no vocabulary here at all: it is the KEYED CHILD
// RELATION (`tail/keyed.ts`), which compiles the body ONCE through the ordinary seam over every
// vertex and hands back `(key, value)` for the recursive term to join. That module's header owns
// the full rationale — the LATERAL constraint, the |V|×fanout cost that makes this the FALLBACK
// rather than the replacement, and what must stay out (a per-iteration global barrier, a label, a
// body-internal bind). Read it before changing the gate here.

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
  if (st.elem !== 'vertex') throw new Error('repeat() on edges not yet supported');
  // A label bound BEFORE the walk is LOOP-INVARIANT: the walk moves the traverser, it never
  // rebinds an existing label, so the alias column's value is the same on every row of every
  // iteration. Carrying it is therefore a projection, not a fold — seed it from the outer row and
  // pass it through the recursive term unchanged (see aliasCols below). A label bound INSIDE the
  // body is the different, genuinely-recursive question; `as` is not in REPEAT_BODY_OK, so those
  // bodies still defer there rather than here.
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

  // Body: movements (out/in/both) + has() filters + a mutate sack(op).by() fold +
  // a where(__.sack().is(P)) loop guard, optionally a trailing simplePath(). A bare single
  // movement keeps the original (unchanged) term; anything more uses the general JOIN-chain
  // term (expandRepeatBody). Barrier/collection bodies still defer.
  // The body is a sub-traversal, not a special case — so canonicalize it with the SAME `normalize()`
  // every other nested body uses (match patterns, correlated predicates, write targets), not a
  // hand-picked single fold. This used to be `foldByModulators` alone, which meant a NESTED
  // repeat/times cluster in the body never folded: the inner `times()` stayed a separate step, so
  // the inner repeat saw no cluster and reported `repeat() requires times(), until(), or emit()`.
  const body = normalize(stepChain(rep.args[0]?.nested, st.params)).steps;
  const simplePathInBody = body.length > 0 && body[body.length - 1].name === 'simplePath';
  // A body-TERMINAL aggregate('x') (bare or local(__.aggregate('x'))) collects every vertex the
  // body emits — i.e. every walk row at depth ≥ 1 — into the named bag, read back by cap('x').
  // It's a pass-through (no movement/filter), so it's stripped from the movement expansion and
  // registered as a post-walk side-effect CTE sourced from the walk (reuses the linear aggregate's
  // JSONB-list machinery). Only the terminal position is supported (the common repeat(out().aggregate)
  // shape); a mid-body aggregate (out().aggregate().out()) would collect an intermediate frontier and
  // stays deferred. by()-modulated aggregate-in-repeat also defers (collect element rowids only).
  const bodyAggName = (c: Step): string | null => {
    if (c.name === 'aggregate' && (c.args ?? []).length === 1 && typeof c.args[0] === 'string' && !(c as any).bys?.length) return c.args[0];
    if (c.name === 'local') {
      const inner = stepChain(c.args[0]?.nested, st.params);
      if (inner.length === 1 && inner[0].name === 'aggregate' && typeof inner[0].args[0] === 'string' && !(inner[0] as any).bys?.length) return inner[0].args[0];
    }
    return null;
  };
  const preAgg = simplePathInBody ? body.slice(0, -1) : body;
  const aggName = preAgg.length >= 1 ? bodyAggName(preAgg[preAgg.length - 1]) : null;
  // Strip a terminal aggregate from the core so the movement expander never sees it. A body that
  // is ONLY aggregate (repeat(aggregate('a')), no movement) stays on the same vertex each iteration
  // (depth 1..n all the seed) — the walk still emits those rows, so the bag collects the seed n times.
  const core = aggName ? preAgg.slice(0, -1) : preAgg;
  // Vertex→edge steps land ON an edge (so a following sack().by(edgeKey) reads it); each edge
  // step counts as a movement for progress. `moves` gates path tracking (a net vertex hop count).
  const moves = core.filter((c) => REPEAT_MOVES.has(c.name) || TO_EDGE.has(c.name));
  const hasEdgeStep = core.some((c) => TO_EDGE.has(c.name) || TO_VERTEX.has(c.name));
  // A body sack fold is a mutate sack(op) step; a sack-reading where guard is where(__.sack().is(P)).
  const isSackFold = (c: Step): boolean => c.name === 'sack' && (c.args ?? []).some((a: any) => a && typeof a === 'object' && 'operator' in a);
  const bodyFoldsSack = core.some(isSackFold);
  const REPEAT_BODY_OK = (c: Step): boolean => REPEAT_MOVE_ALL.has(c.name) || c.name === 'has' || isSackFold(c) || sackWhereGuard(c) !== null;
  // has() in the FLAT expansion: only has(key, value|P) — a 3-arg or T-token form is beyond it.
  const badHas = core.find((c) => c.name === 'has' && (typeof c.args[0] !== 'string' || c.args.length > 2));
  // Does the FLAT expansion (expandRepeatBody) recognize this body? It is the fast path — it walks
  // the frontier lazily instead of materializing the body over every vertex — so it is tried first
  // and the generic body relation is the fallback. A movement-free body is valid only when it folds
  // a sack (TinkerPop's on-the-spot accumulate, Repeat.feature:664) or collects a body aggregate
  // (repeat(aggregate('a')) revisits the seed each iteration); otherwise it never progresses.
  const flatOk = core.every(REPEAT_BODY_OK) && !badHas && (moves.length > 0 || bodyFoldsSack || !!aggName);
  // The single-movement fast path only applies to a bare VERTEX movement with no sack fold /
  // edge step; any sack-folding or edge-step body routes through the general expansion.
  const singleMove = core.length === 1 && REPEAT_MOVES.has(core[0].name);
  // The carried sack column: live if the incoming stream has one (withSack()/prior sack(op))
  // or the body folds one. A body fold with no prior sack seeds fresh at the base term.
  const sackCol = st.carried.sack ?? (bodyFoldsSack ? 'sk' : undefined);
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
  // path()/simplePath() with edge steps in the body (which visit edges AND vertices) needs the
  // edge-aware path regime — a separate piece. Defer rather than record only the vertices.
  if (trackArray && hasEdgeStep) throw new Error('path()/simplePath() with edge steps (outE()/inV()) in a repeat() body not yet supported');

  // Body strategy. The FLAT expansion is the fast path (frontier-lazy); when it does not recognize
  // the body, fall back to the GENERIC body relation — the ordinary StepFns compiled once into a
  // (from_id, to_id) relation the recursive term joins (see the header above repeatBodyRelation).
  // The generic route cannot carry the per-iteration sack fold (the accumulator depends on the
  // running value, not just the hop) nor the path array (positions are recorded per iteration), so
  // those stay with the flat expansion; a body needing both is a clean deferral.
  // The walk id is a vertex rowid, so the body must net back to a vertex (outE()…inV()).
  const bodyRel = flatOk || sackCol || trackArray ? null : keyedChildRelation(st, core, { landOn: 'vertex' });
  if (!flatOk && !bodyRel) {
    const names = body.map((c) => c.name + '()').join('.');
    // Name the ACTUAL obstacle rather than reciting a vocabulary. A per-iteration global barrier is
    // a semantic wall (precomputing it per-origin would answer a different question — see the
    // keyed.ts header); anything else is a shape neither route recognizes.
    const barrier = core.find(isGlobalBarrier);
    if (barrier) throw new Error(`repeat(__.${names}) not yet supported: ${barrier.name}() is a per-iteration GLOBAL barrier over the whole frontier, and a recursive CTE cannot window across iterations — precomputing it per-origin would answer a different question. A fixed times(n) body could be unrolled instead (not built).`);
    if (sackCol) throw new Error(`repeat(__.${names}) with a sack() fold not yet supported (the sack accumulator is per-iteration, so the body cannot be precompiled; the flat expansion takes movements + has() + sack(op).by() + where(__.sack()...))`);
    if (trackArray) throw new Error(`repeat(__.${names}) while tracking a path()/simplePath() not yet supported (path positions are recorded per iteration, so the body cannot be precompiled)`);
    throw new Error(`repeat(__.${names}) not yet supported (body must be row-local: movement, has/hasLabel/hasId/where/filter/not/and/or, or a uniform-element branch)`);
  }

  // until(): `done` = does the stop predicate hold for this row? do-while (until
  // AFTER repeat) leaves the seed untested (body runs ≥1×); while-do (until BEFORE)
  // tests the seed too. Expansion continues only from done=0 rows; done=1 rows exit.
  const untilFn = hasUntil ? walkPredicate(st, untilStep!, 'until') : null;
  const untilFirst = hasUntil && cluster.indexOf(untilStep!) < cluster.indexOf(rep);
  // `sackAt` is the accumulated sack at the row being tested (post-fold in the recursive term,
  // the seed value on the seed) — passed so a sack-reading until/emit predicate can read it.
  const doneCol = (id: Expression, depth: Expression, sackAt: Expression | null): Expression => q`, CASE WHEN ${untilFn!(id, depth, sackAt)} THEN 1 ELSE 0 END AS done`;

  // emit(predicate): an `emit` column marks WHICH rows are output (vs until's `done`,
  // which marks termination). The walk proceeds regardless. emit-before tests the seed
  // (depth 0) too; emit-after only body results (depth ≥ 1) — so the seed's emit is 0
  // under emit-after. Every recursive row is tested by the predicate in both positions.
  const emitFn = hasEmitPred ? walkPredicate(st, emitStep!, 'emit') : null;
  const emitCol = (id: Expression, depth: Expression, sackAt: Expression | null): Expression => q`, CASE WHEN ${emitFn!(id, depth, sackAt)} THEN 1 ELSE 0 END AS emit`;

  // LOOP-INVARIANT carried columns: the ones the walk neither reads nor rewrites, so they simply
  // ride each iteration untouched. Two kinds, same mechanism — worth stating once rather than
  // twice, because they arrived as separate pieces of work and are the same fact:
  //   • ALIAS columns — the walk MOVES the traverser, it never rebinds an existing label, so an
  //     incoming `as()` binding is invariant (a label bound INSIDE the body is the genuinely
  //     recursive question and still fails closed).
  //   • ORIGIN columns — a walk is row-local (each traverser walks independently), so the ordinal
  //     saying which parent a row came from is just carried, exactly as movement carries it via
  //     carryFrag. Threading it is what lets `repeat()` be a CHILD body (`local`/`map`/`where`/
  //     `group`/`order` over a walk) and lets a repeat NEST in another repeat's body.
  // `ride` re-projects them from whichever relation the caller is selecting from — the outer row
  // in the seed, the walk itself in the recursive term, bare at the output.
  const aliasCols = aliasColsOf(st.carried.aliases);
  const originCols = st.carried.origins;
  const ride = (cols: readonly string[], r: Relation | null): Expression =>
    cols.length ? list(cols.map((c) => (r ? q`, ${r.c[c]}` : q`, ${raw(c)}`)), '') : empty;
  // Inside the walk the column order is only self-consistency, so the two groups sit together;
  // the OUTPUT below must instead match carriedCols (aliases, sack, bulk, origins, path).
  const throughCols = [...aliasCols, ...originCols];
  const walkCols = ['id', 'depth', ...throughCols, ...(sackCol ? [sackCol] : []), ...(trackArray ? ['path'] : []), ...(hasUntil ? ['done'] : []), ...(hasEmitPred ? ['emit'] : [])];
  const walk = st.q.recursiveCte(walkCols, (self: Relation) => {
    // One recursive-term SELECT: advance to `finalId`, bump depth, fold the sack, accumulate
    // path/done, and guard expansion — shared depth<times / done=0 guards FIRST, then the
    // branch's own guards, so the bare single-movement case is unchanged from before.
    // `sackExpr` (null for a sack-free walk) is the accumulator AFTER this iteration's folds.
    const mkRec = (finalId: Expression, from: Expression, sackExpr: Expression | null, branchGuards: Expression[]): Expression => {
      const sackNow = sackCol ? (sackExpr ?? self.c[sackCol]) : null; // the sack AFTER this iteration's folds
      const sackAcc = sackCol ? q`, ${sackNow!} AS ${sackCol}` : q``;
      const pathAcc = trackArray ? q`, jsonb_insert(${self.c.path}, '$[#]', ${finalId}) AS path` : q``;
      const doneAcc = hasUntil ? doneCol(finalId, q`${self.c.depth} + 1`, sackNow) : q``;
      const emitAcc = hasEmitPred ? emitCol(finalId, q`${self.c.depth} + 1`, sackNow) : q``;
      const guards: Expression[] = [];
      if (timesStep) guards.push(q`${self.c.depth} < ${maxDepth!}`); // maxDepth non-null when timesStep set
      if (hasUntil) guards.push(q`${self.c.done}=0`); // until() expands only from still-looping rows
      guards.push(...branchGuards);
      const where = guards.length ? q` WHERE ${list(guards, ' AND ')}` : q``;
      return q`SELECT ${finalId} AS id, ${self.c.depth} + 1 AS depth${ride(throughCols, self)}${sackAcc}${pathAcc}${doneAcc}${emitAcc} FROM ${from}${where}`;
    };
    // simplePath()'s cycle guard: reject a finalId already on the accumulated path.
    const cycleGuard = (finalId: Expression): Expression[] =>
      simplePathInBody ? [q`NOT EXISTS (SELECT 1 FROM json_each(${self.c.path}) je WHERE je.value=${finalId})`] : [];
    // Three body renderings, one recursive term. The GENERIC body relation comes first because it
    // is the fallback the other two decline into (bodyRel is non-null only then): join the
    // precompiled (from_id, to_id) on the walk row. Bare single movement → the ORIGINAL term
    // (alias `e`, label in WHERE), unchanged. Everything else the flat expansion recognizes
    // (movement + has()/sack(), or multi-hop) → expandRepeatBody.
    const rec = bodyRel
      ? [(() => {
          const rb = bodyRel.rel.as('rb');
          const to = rb.c[bodyRel.value];
          return mkRec(to, q`${self} JOIN ${rb} ON ${rb.c[bodyRel.key]}=${self.c.id}`, null, cycleGuard(to));
        })()]
      : singleMove
      ? dirsFor(core[0].name).map(([from, to]) => {
          const e = edges.as('e');
          const guards = [...cycleGuard(e.c[to]), ...(core[0].args.length ? [labelIn('e.label', core[0].args)] : [])];
          return mkRec(e.c[to], q`${self} JOIN ${e} ON ${e.c[from]}=${self.c.id}`, sackCol ? self.c[sackCol] : null, guards);
        })
      : expandRepeatBody(self, core, sackCol).map(({ finalId, from, conds, sackExpr }) => mkRec(finalId, from, sackExpr, [...conds, ...cycleGuard(finalId)]));
    // The SEED is tested by a correlated predicate in two cases: while-do until
    // (untilFirst) and emit-before. A bare `id` inside that predicate's
    // `(SELECT … FROM nodes WHERE id=<seed id>)` would bind BOTH sides to nodes.id
    // (always true → wrong row), so alias the source (`w.id`). Every other seed uses
    // bare `id` (no subquery) → unchanged from before.
    const seedTested = untilFirst || (hasEmitPred && emitBefore);
    const seedSrc = seedTested ? st.rel.as('w') : st.rel;
    const seedId = seedTested ? seedSrc.c.id : q`id`;
    const seedSel = seedTested ? q`${seedId} AS id` : q`id`; // untested seed keeps bare `id` → unchanged
    // Seed the sack from the outer row (withSack()/prior sack(op)); NULL when the body
    // folds fresh with no prior seed (assign overwrites; a numeric fold with no seed is
    // undefined per TinkerPop and yields NULL → the row drops, matching the linear path).
    const seedSackExpr = sackCol ? (st.carried.sack ? seedSrc.c[st.carried.sack] : q`NULL`) : null;
    const seedSack = sackCol ? q`, ${seedSackExpr!} AS ${sackCol}` : q``;
    const seedPath = trackArray ? q`, jsonb_array(${seedId}) AS path` : q``;
    const seedDone = hasUntil ? (untilFirst ? doneCol(seedId, q`0`, seedSackExpr) : q`, 0 AS done`) : q``;
    // emit-before tests+emits the seed (depth 0); emit-after never emits the seed.
    const seedEmit = hasEmitPred ? (emitBefore ? emitCol(seedId, q`0`, seedSackExpr) : q`, 0 AS emit`) : q``;
    // The seed selects from ONE relation, so an untested seed keeps its columns unqualified
    // (matching `seedSel`'s bare `id`); a tested seed aliases the source and qualifies through it.
    return q`SELECT ${seedSel}, 0 AS depth${ride(throughCols, seedTested ? seedSrc : null)}${seedSack}${seedPath}${seedDone}${seedEmit} FROM ${seedSrc} UNION ALL ${list(rec, ' UNION ALL ')}`;
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
  // The folded sack rides out of the walk as the carried `sk` column (bare `sack()` reads
  // it downstream). advance() declares `sack: 'sk'` so carriedCols threads it forward.
  // Column ORDER on the SELECT must match carriedCols(out): sack, bulk, ORIGINS, then path.
  // The walk names its accumulator `sackCol`; the outbound carried name is always `sk`.
  const sackOut = sackCol ? q`, ${raw(sackCol)} AS sk` : empty;
  // Column ORDER must match carriedCols(out) EXACTLY: aliases, sack, bulk, origins, path. The two
  // ride-groups are therefore NOT contiguous here (bulk sits between them), unlike inside the walk.
  const aliasOut = ride(aliasCols, null);
  const originOut = ride(originCols, null);
  // The walk RE-SEEDS bulk (`1 AS bulk` above) rather than carrying it, so it must also DECLARE it:
  // `advance` derives the CTE's column list from the carried state, and an emitted-but-undeclared
  // column is an arity skew SQLite only reports at execution. An input that already carried bulk
  // (every element source seeds it) made the declaration line up by luck; a caller whose input does
  // NOT carry it — a match() pattern seed, whose multiplicity is its row count — hit the skew.
  const bulkOut = { bulk: 'bulk' as const };
  const out = wantsPathOutput
    ? advance(st, q`SELECT id${aliasOut}${sackOut}, 1 AS bulk${originOut}, path FROM ${walk} WHERE ${outWhere}`, { sack: sackCol ? 'sk' : null, ...bulkOut, path: { kind: 'array', col: 'path', elem: 'vertex' } })
    : advance(st, q`SELECT id${aliasOut}${sackOut}, 1 AS bulk${originOut} FROM ${walk} WHERE ${outWhere}`, { sack: sackCol ? 'sk' : null, ...bulkOut });
  if (!aggName) return out;
  // A body-terminal aggregate('x'): collect every vertex the body emitted — the walk rows at
  // depth ≥ 1 (the seed is the pre-body input, not a body output). If the name already holds a
  // bag (a pre-repeat local(aggregate('x'))), UNION ALL its members (BulkSet multiset union). The
  // bag stores element rowids; cap('x') rejoins nodes when framing — reusing the linear aggregate's
  // `{kind:'list', of:{kind:'elem'}}` def, so cap/unfold need no new path.
  const w = walk.as('w');
  const prior = out.sideEffects?.get(aggName);
  // BulkSet multiset union: a pre-repeat local(aggregate('x')) bag's members come FIRST (their
  // json_each value aliased `m` to match the walk leg's column), then the walk's depth≥1 rows.
  const priorMembers = prior && prior.kind === 'list' && prior.of.kind === 'elem'
    ? q`SELECT value AS m FROM json_each((SELECT list FROM ${prior.rel})) UNION ALL ` : empty;
  const bagRel = out.q.cte(
    q`SELECT ${jsonbGroupArray(q`m`)} AS list FROM (${priorMembers}SELECT ${w.c.id} AS m FROM ${w} WHERE ${raw('w.depth')} >= 1)`,
    ['list'],
  );
  const def: SideEffectDef = { kind: 'list', rel: bagRel, of: { kind: 'elem', elem: 'vertex' } };
  return { ...out, sideEffects: new Map([...(out.sideEffects ?? []), [aggName, def]]) };
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
  // choose()'s predicate honours predicateInlining (unlike until()/emit(), it HAS a generic
  // fallback below — tryGateByChildExistence — so disabling inlining compiles the same choose()
  // generically). The flag gates the attempt; recognition failure also falls through to generic.
  // gate() below is filterCte's shape (`FROM <elem> n JOIN <prev> p …`), so the carried alias
  // columns are in scope for the predicate — pass the LabelScope and choose()'s predicate reads
  // labels on exactly the terms where()/filter()'s does.
  const inline = runFastPath(PredicateInliningFastPath, fastPathContextOf(st),
    () => tryInlinePredicate(engineOf(st), stepChain(predNested, st.params), elemCtx(elemRel(st), st.elem), st.params, labelScope(st)));
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
  const args = s.args.filter(isNested);
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
  return finishElementMerge(carryOf(st), out, parts, { elem: thenEnd.elem, aliases: out.aliases, path: out.path });
};

/** Predicate choose with two homogeneous scalar result arms. The predicate gates
 * two ElementStream seeds exactly like element choose; each gated seed then enters
 * the generic child compiler and the resulting scalar rows merge with UNION ALL. */
export function tryLowerScalarChoose(s: Step, st: ElementStream): ScalarStream | null {
  if ((s as any).options) return null;
  assertForkSafe('choose', st);
  const args = s.args.filter(isNested);
  if (args.length !== 3) return null; // two-arg choose has an element identity else arm
  const [predArg, thenArg, elseArg] = args;
  const thenPlan = classifyScalarChild(thenArg.nested, childCtx(st));
  const elsePlan = classifyScalarChild(elseArg.nested, childCtx(st));
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
  const args = s.args.filter(isNested);
  if (args.length !== 3) return null;
  const [predArg, thenArg, elseArg] = args;
  const thenPlan = classifyListChild(thenArg.nested, childCtx(st));
  const elsePlan = classifyListChild(elseArg.nested, childCtx(st));
  if (!thenPlan || !elsePlan) return null;
  const seedFor = chooseGate(st, predArg.nested);
  const thenEnd = tryCompileListChild(seedFor(false), thenArg.nested, ROOT_SCOPE, thenPlan)!;
  const elseEnd = tryCompileListChild(seedFor(true), elseArg.nested, ROOT_SCOPE, elsePlan)!;
  return finishListMerge(carryOf(st), [thenEnd, elseEnd]);
}

// ---------- union() as a SOURCE — g.union(b1, b2, …) ----------
//
// A source branch is a fully ROOTED traversal (`__.V().values('name')`, `__.inject(1)`, a nested
// `__.union(…)`), NOT a child body hanging off a parent traverser — so the child seam's arm triage
// (`classifyBranchArms` and the `is*Child` classifiers under it) does not describe it and is
// deliberately not used here. Each arm lowers through the ordinary rooted lowering
// (`Engine.lowerRootedArm` — the same seed + shaped loop compileRead runs) to a Stream of whatever
// shape it naturally has, and the merge is picked POST HOC from the arms' KINDS.
//
// The merges themselves are the SAME four parent-agnostic builders the mid-traversal branch uses.
// That is the whole point: the hand-rolled `UNION ALL` over vertex id-relations this replaced was
// a second, strictly weaker branch implementation — it rejected scalar/list/mixed arms, `as()`
// inside an arm, an emission-order encounter and sack. All four now fall out of the one merge
// family for free.

/** The three shapes a source branch can merge as — exactly the shapes the merge family covers. */
type ArmStream = ElementStream | ScalarStream | ListStream;

/** The carried schema a SOURCE merge starts from. A source has no parent traverser, so there are
 *  no incoming aliases and no live origin ordinal; what the base must declare is the per-traverser
 *  RIGID state (sack/bulk/encounter) and the path regime the arms actually carry. Arms are seeded
 *  from the same facts, so they agree by construction — a divergence means an arm's tail consumed
 *  state the others kept (a barrier eating `bulk`), which no merge can reconcile: fail closed. */
function sourceBaseCarried(arms: readonly ArmStream[]): Carried {
  const want = rigidCols(arms[0].carried);
  for (const a of arms) {
    const got = rigidCols(a.carried);
    if (got.length !== want.length || got.some((x, i) => x !== want[i]))
      throw new Error('union() source branches disagree on carried columns (sack/bulk/emission order) — a branch whose tail consumes per-traverser state cannot merge with one that keeps it');
  }
  const c = arms[0].carried;
  return { aliases: new Map(), origins: c.origins, sack: c.sack, bulk: c.bulk, encounter: c.encounter, path: c.path };
}

/** One lowered source branch as a variant arm, tagged by its natural shape. The kind-dispatch twin
 *  of compileVariantArm/compileScalarVariantArm — those pick a per-arm COMPILER from a syntactic
 *  classify; a rooted arm is already lowered, so its `kind` IS the answer. */
const sourceVariantArm = (s: ArmStream): VariantArm =>
  s.kind === 'elements' ? { rel: s.rel, vk: s.elem === 'edge' ? 3 : 2 }
  : s.kind === 'scalar' ? { rel: s.rel, vk: 1, as: staticTypeOf(s.type) }
  : { rel: s.rel, vk: 4, listOf: s.of };

const isVariantArmKind = (s: Stream): s is ArmStream =>
  s.kind === 'elements' || s.kind === 'scalar' || s.kind === 'list';

/** Lower `union(b1, b2, …)` in SOURCE position to one merged Stream. */
export function sourceUnion(engine: Engine, step: PStep, params: Record<string, any>, sackInit: SackSpec | undefined, facts: ChainFacts): Stream {
  const seed: Carry = { q: engine.q, params, carried: { aliases: new Map(), origins: [] } };
  const branches = (step.args ?? []).filter(isNested);
  // union() with no branches emits nothing (TinkerPop: the result is empty). Not an arity error —
  // g.union() is a legal traversal, and one arm is legal too (there is nothing to disagree about).
  if (!branches.length) return emptyElementLike(seed);
  const bodies = branches.map((b: any) => childSteps(b.nested, params));
  // Path tracking and the emission encounter are chain-global facts an ARM cannot see: `path()`
  // sits AFTER the union, and the demand never appears in the arm's own text. Force both uniformly
  // over every arm — either all carry the column or none does, because a merge projects one
  // declared carried schema off every arm relation.
  const own = bodies.map(analyze);
  const armFacts: ChainFacts = {
    tracksPath: facts.tracksPath || own.some((f) => f.tracksPath),
    demandsEncounter: facts.demandsEncounter || own.some((f) => f.demandsEncounter),
    collapseSafe: false, // gated per-compile at engine construction; never re-read from here
  };
  const arms = bodies.map((body) => engine.lowerRootedArm(body, params, sackInit, armFacts));
  // Name the offending arm's SHAPE before anything else: a map/group/record/path/variant branch
  // has no merge in the family, and inventing a fifth is what this consolidation exists to prevent.
  const unmergeable = arms.find((a) => !isVariantArmKind(a));
  if (unmergeable) throw new Error(`union() source branch producing a ${unmergeable.kind} value not yet supported`);
  const base: Carry = { ...seed, carried: sourceBaseCarried(arms as ArmStream[]) };
  if (arms.every((a) => a.kind === 'elements')) return mergeElementArms(base, arms as ElementStream[]);
  if (arms.every((a) => a.kind === 'scalar')) return unionScalarStreams(base, arms as ScalarStream[]);
  if (arms.every((a) => a.kind === 'list')) return finishListMerge(base, arms as ListStream[]);
  // Same wall as the mid-traversal mixed-shape merges: a scalar/list arm holds no path position,
  // so the merged rows are ragged in a way only the tagged-array regime could reconcile.
  if (base.carried.path) throw new Error('path() through a mixed-shape union() source not yet supported');
  const vs = (arms as ArmStream[]).map(sourceVariantArm);
  return mergeVariantArms(base, vs, variantArmsMeta(vs));
}

// ---------- choose (option-map form) as an ARM MERGE ----------
//
// `choose(choiceFn).option(k, body)…` is a BRANCH whose arm selection is an N-way lookup on a
// choice scalar, not (only) a scalar CASE. The CASE projector (`lowerChooseOptions`, mapscalar.ts)
// is the right lowering when every option body yields one scalar per input — one CTE, no per-arm
// gating — and it stays the first thing tried. But it is a SPECIALIZATION, and treating it as the
// whole implementation is what made three unrelated things defer: an ELEMENT option body
// (`option('blah', __.out('knows'))`), a LIST one (`…fold()`), and the no-`Pick.none` form, whose
// unmatched inputs pass through as the element itself (TinkerPop) — a genuinely mixed
// scalar/element result that predates VariantStream and is now perfectly representable.
//
// So this is the generic route: gate the parent per option (first match wins, exactly the CASE's
// WHEN order), lower each option body from its gated seed, and route to the SAME arm triage +
// merge family every other branch uses. No fifth merge, no second traversal implementation.

/** The per-parent CHOICE as `ch` (its value) + `ch_at` (its PRESENCE) on a relation carrying the
 *  parent's id + carried schema. Presence is what separates `Pick.unproductive` (the choice
 *  traversal produced nothing) from `Pick.none` (it produced a value that matched no key) — the
 *  modulation seam already computes it, so the distinction costs one extra column. A T token is
 *  always productive (every element has a label/id), hence a constant 1.
 *
 *  A nested choice goes through the SAME correlated modulation seam the CASE projector uses, so
 *  the two agree on what a choice can be. */
function chooseChoiceDomain(st: ElementStream, a0: any): Relation | null {
  const cols = ['id', 'ch', 'ch_at', ...carriedCols(st.carried)];
  if (a0 && typeof a0 === 'object' && 'nested' in a0) {
    // Not `required`: an unproductive choice routes to Pick.unproductive/none, it never drops the
    // parent — so the modulation is a LEFT join and `present` is the signal, not a filter.
    const mods = tryCompileScalarModulations(st, [{ nested: a0.nested, required: false }]);
    if (!mods) return null;
    const p = mods.rel.as('p');
    return st.q.cte(q`SELECT ${p.c.id} AS id, ${p.c[mods.values[0].value]} AS ch, ${p.c[mods.values[0].present]} AS ch_at${carryFrag(st.carried, p)} FROM ${p}`, cols);
  }
  if (!(a0 && typeof a0 === 'object' && 'token' in a0)) return null;
  const n = elemRel(st);
  const ctx = elemCtx(n, st.elem);
  const ch = a0.token === 'label' ? labelNameSub(ctx.labelIdExpr) : a0.token === 'id' ? ctx.extIdExpr! : null;
  if (!ch) return null;
  const p = prevRel(st, 'p');
  return st.q.cte(q`SELECT ${p.c.id} AS id, ${ch} AS ch, 1 AS ch_at${carryFrag(st.carried, p)} FROM ${p} JOIN ${n} ON ${n.c.id}=${p.c.id}`, cols);
}

/** `choose(choiceFn).option(k, body)…` routed through the arm triage + merge family. Returns null
 *  to DEFER (an unsupported option form, a choice the modulation seam cannot compile, an
 *  unclassifiable body) so the caller keeps its clear message — never a throw, which would break
 *  the CASE projector's fall-through. */
export function tryLowerOptionMapBranch(st: ElementStream, step: PStep): Stream | null {
  assertForkSafe('choose', st);
  const ctx = childCtx(st);
  const opts = readOptionMapArms(step, st.params);
  const merge = opts && optionMapMerge(step, ctx);
  if (!opts || !merge) return null;
  const domain = chooseChoiceDomain(st, step.args[0]);
  if (!domain) return null;
  const d = domain.as('d');

  // The gates. A keyed arm needs a PRODUCTIVE choice that matches its key and no earlier key
  // (first match wins — the CASE projector's WHEN order, and a Map lookup's semantics; corpus keys
  // are mutually exclusive, so this only pins an order that would otherwise be unspecified).
  const productive = q`${d.c.ch_at} IS NOT NULL`;
  const keyed = opts.filter((o) => o.pick === 'key');
  const matches = keyed.map((o) => predicateSql(d.c.ch, o.key));
  const unmatched = matches.map(notCoalesce);
  const testFor = (k: number) =>
    list([productive, ...unmatched.slice(0, k), paren(matches[k])], ' AND ');
  // Pick.none: productive, but no key matched. Pick.unproductive: the choice produced nothing.
  const noneTest = list([productive, ...unmatched], ' AND ');
  const unproductiveTest = q`${d.c.ch_at} IS NULL`;
  const seedFor = (test: Expression): ElementStream =>
    advance(st, q`SELECT ${d.c.id} AS id${carryFrag(st.carried, d)} FROM ${d} WHERE ${test}`);

  // Arm order = declaration order, then the implicit pass-through last. Seeds are built lazily in
  // that order because an inline predicate re-emits its binds at each interpolation, and the
  // merges tag `arm_idx` by position.
  const plan: { nested: any; test: Expression }[] = [];
  let k = 0;
  for (const o of opts) {
    const test = o.pick === 'key' ? testFor(k++) : o.pick === 'none' ? noneTest : unproductiveTest;
    if (!o.discard) plan.push({ nested: o.nested, test }); // discard() drops its rows → no arm
  }
  // No Pick.none written → unmatched-but-productive inputs emit the ELEMENT itself (TinkerPop).
  // No Pick.unproductive written → an unproductive choice falls to Pick.none, or, absent that too,
  // to the same element pass-through; both are covered by widening the gate here.
  const hasNone = opts.some((o) => o.pick === 'none');
  const hasUnproductive = opts.some((o) => o.pick === 'unproductive');
  const passthroughTest = hasNone ? unproductiveTest
    : hasUnproductive ? noneTest
    : q`${paren(noneTest)} OR ${paren(unproductiveTest)}`;
  const needsPassthrough = optionMapNeedsPassthrough(step, opts, st.params); // shared with the triage

  if (merge !== 'variant') {
    const lower = (nested: any, seed: ElementStream): Stream | null =>
      merge === 'element' ? tryCompileElementTraversal(seed, nested)
      : merge === 'scalar' ? tryCompileScalarValueChild(seed, nested, 'all')
      : tryCompileListChild(seed, nested);
    const arms: Stream[] = [];
    for (const a of plan) {
      const got = lower(a.nested, seedFor(a.test));
      if (!got) return null;
      arms.push(got);
    }
    if (needsPassthrough) arms.push(seedFor(passthroughTest)); // element identity
    const base = carryOf(st);
    if (merge === 'element') return mergeElementArms(base, arms as ElementStream[]);
    if (merge === 'scalar') return unionScalarStreams(base, arms as ScalarStream[]);
    return finishListMerge(base, arms as ListStream[]);
  }
  // Genuinely mixed arms → the variant merge. Same wall as its siblings: a scalar/list arm holds
  // no path position, so a live path would make the merged rows ragged.
  if (st.carried.path) throw new Error('path() through a mixed-shape choose().option() not yet supported');
  const vs: VariantArm[] = plan.map((a) => compileVariantArm(seedFor(a.test), a.nested));
  if (needsPassthrough) {
    const seed = seedFor(passthroughTest);
    vs.push({ rel: seed.rel, vk: seed.elem === 'edge' ? 3 : 2 });
  }
  return mergeVariantArms(carryOf(st), vs, variantArmsMeta(vs));
}
