import { gtypeName, isPred, isScopeArg, type Step } from '../../gremlin/frontend.ts';
import { normalizeTypeName } from '../../gremlin/types.ts';

// ---------- the compiler's step node ----------
//
// `Step` (gremlin/frontend.ts) is the FRONT-END's node: a flat `{name, args, ctx}` the parser
// produces, and — per locked decision #5 in the root CLAUDE.md — the only thing the compiler is
// allowed to depend on. `IRStep` is the COMPILER's node: the same step after the canonicalize
// passes have absorbed its modulators and folded its multi-step shapes into named fields.
//
// It lives in its own leaf module because both halves of ir/ need it (the rewrite bodies that
// WRITE these fields, and every lowering that READS them) and it must not drag the strategy
// taxonomy along with it.

/**
 * A Step optionally carrying folded modulator data, so no step compiler ever
 * peeks at sibling steps:
 *  - `repeatRegion` — the repeat/emit/times/until run (`formRepeatRegions`).
 *  - `modulators` — the trailing by() modulator arg-lists absorbed onto a host step
 *    (`absorbModulators`): order/select/project/group's by(), and the single
 *    by(key) an alias-compare where()/not() carries.
 *  - `optionArms` — a choose()'s option() arms (`absorbOptionArms`).
 *  - `unrollSuppressed` — this `repeat` sits under a `withoutStrategies(RepeatUnrollStrategy)`
 *    (`markUnrollSuppressed`). A mark on the STEP rather than a flag consulted at the root, because
 *    a body is normalized in isolation later and a root-only answer cannot reach it.
 * The compilers read these fields instead of re-scanning, so the whole read
 * dispatch is a peek-free fold over the step list.
 */
export type IRStep = Step & { repeatRegion?: Step[]; modulators?: any[][]; optionArms?: Step[]; productiveBy?: boolean; unrollSuppressed?: boolean; from?: string; to?: string; withArgs?: [string, any][] };

/** Did this step run inside a PER-TRAVERSER host (`local`/`map`/`flatMap`) whose wrapper the splice pass
 *  erased — `inlineIdentityHostBody`, `ir/strategies.ts`?
 *
 *  It matters for a LOCAL BARRIER and nowhere else: such a step sees one traverser at a time here and
 *  the whole stream at chain position, which is invisible for every step whose answer does not depend
 *  on how many traversers one barrier holds — and observable for the one that does
 *  (`aggregate("a")` under `Operator.assign`). Read off the step rather than re-derived, because the
 *  pass that deleted the wrapper is the only thing that still knew. */
export const ranPerTraverser = (s: IRStep): boolean => s.perTraverser === true;

// ---------- step-name vocabularies: DERIVE with a named difference, never merge ----------
//
// A dozen step-name Sets across the compiler overlap without being interchangeable, and their
// differences are LOAD-BEARING: `COLLAPSE_MOVES` and `VERTEX_PRODUCERS` differ on `otherV` because
// otherV's fromV context is per-traverser identity that a GROUP BY-id collapse would destroy, while
// a partition/subgraph vertex filter must still fire after it. Merging them would silently change
// semantics in at least three places.
//
// So this module exports BASES only. Every consuming set keeps its own name, its own home and its
// own call sites, and spells its membership relative to these — which turns an omission into
// something you can SEE (`COLLAPSE_MOVES` visibly excludes `OTHER_V`) instead of something you have
// to notice is absent. That visibility is what got `POSITION_MOVEMENTS` fixed: its omission of
// `OTHER_V` WAS a real bug (a `bothE().otherV()` projected the edge position, not the reached
// vertex, while path tracking was live) and it now includes it — `tail/path.ts`, tested by
// `test/L4-addendum/where-under-otherv-context.feature` and pinned in
// `test/compiler/step-vocabulary.exec.test.ts`. `COLLAPSE_MOVES`'s exclusion is NOT a bug and must
// stay: otherV carries the per-traverser entering-vertex context a GROUP BY-id collapse destroys.
//
// Rule for anything added here: a base is a vocabulary with ONE meaning. If two consumers want
// different members, that is two bases, not one base plus an exception.

/** Union of step-name vocabularies. Named `unionOf`, not `union`, because `union` is a Gremlin
 *  step and a Set of step names is exactly the place that ambiguity would bite. */
export const unionOf = (...sets: readonly ReadonlySet<string>[]): ReadonlySet<string> =>
  new Set(sets.flatMap((s) => [...s]));

/** vertex → vertex (`out`/`in`/`both`). */
export const VERTEX_MOVES: ReadonlySet<string> = new Set(['out', 'in', 'both']);
/** vertex → edge (`outE`/`inE`/`bothE`). */
export const EDGE_MOVES: ReadonlySet<string> = new Set(['outE', 'inE', 'bothE']);
/** edge → its endpoint vertex (`outV`/`inV`/`bothV`). Deliberately EXCLUDES `otherV`, which is
 *  the whole reason it is its own base — see OTHER_V. */
export const ENDPOINT_MOVES: ReadonlySet<string> = new Set(['outV', 'inV', 'bothV']);
/** `otherV` alone. It is separate because it is the member the consuming sets DISAGREE about: it
 *  needs the entering vertex (`fromV`) retained, which makes it per-traverser identity — safe for a
 *  partition filter to follow, unsafe for a bulk collapse or a static path position. */
export const OTHER_V: ReadonlySet<string> = new Set(['otherV']);
/** The graph sources. */
export const VERTEX_SOURCE: ReadonlySet<string> = new Set(['V']);
export const EDGE_SOURCE: ReadonlySet<string> = new Set(['E']);

/** The path-family steps: they thread a path AND host from()/to() scoping modulators. */
export const PATH_FAMILY: ReadonlySet<string> = new Set(['path', 'simplePath', 'cyclicPath']);

/** The `Operator` tokens a `sack()` may fold with — TinkerPop's `Operator` enum, minus the ones the
 *  lowering does not express (`and`/`or`/`addAll`/`sumLong`). DATA the lowering and its emission layer
 *  must agree on, so it lives here beside the other step-name vocabularies rather than inside the
 *  lowering: the SQL for each operator is emission and belongs to whichever layer emits it (§6·4's
 *  split, applied to a set of six). */
export const SACK_OPS: ReadonlySet<string> = new Set(['assign', 'sum', 'minus', 'mult', 'div', 'min', 'max']);

/** The numeric reducers — every one a bulk-aware SQL aggregate over a scalar stream. */
const NUMERIC_REDUCER_NAMES = ['sum', 'min', 'max', 'mean'] as const;
export const NUMERIC_REDUCERS: ReadonlySet<string> = new Set(NUMERIC_REDUCER_NAMES);
/** The reducers including `count`. Spelled as a union so the several consumers that admit `count`
 *  and the two that do NOT are telling you which they are. */
export const REDUCERS: ReadonlySet<string> = unionOf(NUMERIC_REDUCERS, new Set(['count']));

/** A reducer by NAME, derived from the same member list as the set above rather than declared
 *  beside it — the set is the authority and the type cannot drift from it. (It could: the type
 *  lived in `tail/barrier.ts` and the set here, two independent spellings of four names.) */
export type NumericReducer = (typeof NUMERIC_REDUCER_NAMES)[number];
export type ScalarReducer = 'count' | NumericReducer;

/** A step that observes the WHOLE stream at once, so it cannot be evaluated per-row without
 *  answering a different question. The canonical example is the one that made this shared: a global
 *  `dedup()` drops a value two origins both reach, a per-origin one keeps both.
 *
 *  **THREE sites need exactly this fact and must not drift apart** — `repeat()`'s body (a barrier
 *  there observes the whole FRONTIER at one iteration), a `match()` pattern body (a barrier there
 *  reduces over the whole BINDING TABLE, not per binding), and a BRANCH ARM (a barrier there
 *  observes every traverser reaching the branch, not one). The first two defer rather than
 *  mis-execute; **the third still does NEITHER** — it lowers the arm per-origin and returns a
 *  differently-shaped answer, e.g. `g.V().values('age').union(__.min(), __.max())` yields all four
 *  ages twice instead of `[27, 35]`. `verifyBranchArmBarrierScope` is the gate that would close it
 *  and has not been written; the real fix is `docs/2026-08-01-branch-arm-barrier-scope-plan.md`, and
 *  §1 there is the reason only `union`/`choose` are affected (`coalesce`/`optional` do not extend
 *  `BranchStep`, so their arms genuinely are per-traverser and our lowering of them is right).
 *
 *  It lives HERE, in the IR's step vocabulary, and not beside its first consumer, because the
 *  branch-arm gate belongs in an `ir/` verify Pass, which runs before lowering. */
export const GLOBAL_BARRIER_STEPS: ReadonlySet<string> = new Set([
  'dedup', 'order', 'limit', 'range', 'skip', 'tail', 'sample', 'barrier',
  'group', 'groupCount', 'aggregate', 'local', 'fold', ...REDUCERS,
]);
export const isGlobalBarrier = (s: { readonly name: string }): boolean => GLOBAL_BARRIER_STEPS.has(s.name);

/** Is this step a barrier over the whole stream **as written**? `GLOBAL_BARRIER_STEPS` is by NAME,
 *  and a `Scope.local` argument narrows the same name to one shape's MEMBERS — `order(Scope.local)`
 *  reorders a list value's members and is row-local, where bare `order()` observes every traverser.
 *  Both gates that need this distinction spelled the exemption inline; this is the one predicate. */
export const isStreamBarrier = (s: IRStep): boolean => isGlobalBarrier(s) && !isLocalScope(s);

// ---------- Scope.local, and what a slice step's arguments MEAN ----------
//
// These two belong together and belong HERE, in the step vocabulary, for the same reason the
// barrier sets do: they are facts about a step's ARGUMENTS, and every lowering that reads those
// arguments needs the same answer. The alternative is what the tree actually had — SEVEN inline
// copies of the Scope.local scan (`ir/step.ts`, `tail/{barrier,list,scalar,projection,select}.ts`)
// and NINE independent derivations of a slice's offset/limit. That duplication was not neutral:
// the copy in `tail/variant.ts` was the global slice WITHOUT the scope guard, so
// `g.V().union(…).limit(Scope.local,1)` read the scope TOKEN as its row count and emitted
// `LIMIT NaN` (docs/outstanding-work.md item 27). One decode makes that unspellable — you cannot
// reach the numbers without also being handed the scope.

/** Does this step carry a `Scope.local` token? A local op addresses one VALUE's members — a list's
 *  elements, a record's fields — where the same step name unscoped addresses the stream's ROWS. */
export const isLocalScope = (s: IRStep): boolean =>
  (s.args ?? []).some((a) => isScopeArg(a.value) && a.value.scope === 'local');

/** The three steps that MUTATE an element's labels. A base here rather than a private set in a
 *  lowering, because the question "is this traversal a label mutation" is now asked ABOVE the routing
 *  switch (`verifyLabelMutationTarget`) as well as inside one. */
export const LABEL_MUTATIONS: ReadonlySet<string> = new Set(['addLabel', 'dropLabel', 'dropLabels']);

/** Which kind of element a chain's prefix leaves on the stream. */
export type ElementKind = 'vertex' | 'edge';

/**
 * WHICH ELEMENT KIND THE STREAM HOLDS AT `at`, or `undefined` for **cannot say**.
 *
 * A deliberately small, TOTAL walk of the movement vocabulary, and the third answer is the load-bearing
 * one: this exists so a `verify` Pass can raise a refusal that is a property of the STREAM rather than
 * of a step's arguments, and a Pass that guessed would raise on a traversal it had not understood.
 * Everything outside the vocabulary below — a branch, a re-entry, a `select`, a child host — answers
 * `undefined`, and the caller leaves such a chain to the lowering.
 *
 * It is not a shape ANNOTATION and must not grow into one: `src/compiler/CLAUDE.md` (the bright line)
 * draws the line that a Pass may CONSULT shape and never CONSTRUCT it, and the reason this stays a local
 * question is that its one caller needs a single fact (vertex or edge) about a single position, where a
 * shape vocabulary carries member encodings, key/value sides and framings it has no business inventing.
 */
export function elementKindAt(steps: readonly IRStep[], at: number): ElementKind | undefined {
  let kind: ElementKind | undefined;
  for (let i = 0; i < at && i < steps.length; i++) {
    const name = steps[i].name;
    if (name === 'V' || VERTEX_MOVES.has(name) || ENDPOINT_MOVES.has(name) || OTHER_V.has(name)) kind = 'vertex';
    else if (name === 'E' || EDGE_MOVES.has(name)) kind = 'edge';
    // A mid-chain creation RE-ROOTS the stream onto what it created.
    else if (name === 'addV' || name === 'mergeV') kind = 'vertex';
    else if (name === 'addE' || name === 'mergeE') kind = 'edge';
    // Shape-PRESERVING: the stream is whatever it already was. A filter drops rows, a label binds, a
    // slice picks; none of them retypes. `LABEL_MUTATIONS` are here because they are side-effect steps
    // that pass the SAME traverser on (`compileLabelMutation`'s own note), which is what makes a second
    // one after the first still answerable.
    else if (SHAPE_PRESERVING.has(name) || LABEL_MUTATIONS.has(name)) continue;
    else return undefined; // cannot say — and saying so is the point
  }
  return kind;
}

/** The steps `elementKindAt` may walk THROUGH. Kept narrow on purpose: a name absent here costs a
 *  refusal that is left to the lowering, while a name wrongly present costs a raise on a traversal
 *  nobody analysed. Absent by intent: every branch, every re-entry, every child host, `property`
 *  (whose own value may re-root) and every retype (`values`, `label`, `id`, `fold`, `path`, …). */
const SHAPE_PRESERVING: ReadonlySet<string> = new Set([
  'has', 'hasLabel', 'hasId', 'hasKey', 'hasValue', 'hasNot', 'is', 'where', 'filter', 'not', 'and', 'or',
  'as', 'identity', 'barrier', 'dedup', 'order', 'limit', 'range', 'skip', 'tail', 'sample',
  'simplePath', 'cyclicPath', 'none', 'drop',
]);

/** A bare/keyed `order()` (no by(traversal)) re-establishes a deterministic total order. It is THE
 *  shared hinge of three scans, which is why it is a base here rather than a private helper: such an
 *  order() clears "needs an emission encounter" (a following slice sorts deterministically without
 *  one), it is exactly the order() after which a bulk-aware limit/range/skip/tail stays
 *  result-safe (`ir/bulk.ts`), and it is what `computeCollapseSafe` reads for the same reason. All
 *  three call this one predicate so they cannot disagree on what an order() does — the drift risk a
 *  prose "these must agree" comment used to carry. order().by(traversal) is NOT plain (it mints its
 *  own encounter / is a nested sort) and returns false. */
export function isPlainOrder(step: IRStep): boolean {
  return step.name === 'order' && (step.modulators ?? []).every((by: any[]) => by.length === 0 || typeof by[0] === 'string');
}

/** The three steps that denote a window. `tail` is deliberately NOT one: "the last n" cannot be
 *  turned into an offset without knowing how many there are, which is a question about the STREAM,
 *  not about the step — so its hosts keep their own derivation until item 17 gives them a count. */
export const SLICE_STEPS: ReadonlySet<string> = new Set(['limit', 'skip', 'range']);

/** A slice step decoded: the window, and WHOSE window it is. `limit: null` is "no upper bound"
 *  (`range(2,-1)`, `skip(2)`) — spelled as null rather than SQL's `-1` because the two consumers
 *  that compute with it (`scopedSlice`, `partitionedSlice`) take an offset+count and would read
 *  `offset + -1` as a real upper bound; the sites that render SQL write `${limit ?? -1}`, which is
 *  what all but one of them already did. */
export interface Slice {
  readonly scope: 'global' | 'local';
  readonly offset: number;
  readonly limit: number | null;
}

/** THE decode of `limit`/`skip`/`range`. Skips the scope token rather than counting it as an
 *  argument, which is the whole point: `limit(Scope.local, 1)` has the same numbers as `limit(1)`
 *  and differs only in `scope`. Rejects an illegal range with TinkerPop's own wording. */
export function sliceOf(step: IRStep): Slice {
  const scope = isLocalScope(step) ? 'local' : 'global';
  const nums = (step.args ?? []).filter((a) => !isScopeArg(a.value)).map((a) => Number(a.value));
  switch (step.name) {
    case 'limit': return { scope, offset: 0, limit: nums[0] };
    case 'skip': return { scope, offset: nums[0], limit: null };
    case 'range': {
      const [lo, hi] = nums;
      if (hi >= 0 && lo > hi) throw new Error(`Not a legal range: [${lo}, ${hi}]`);
      return { scope, offset: lo, limit: hi < 0 ? null : hi - lo };
    }
    default: throw new Error(`${step.name}() is not a slice step`);
  }
}

/** The user PARAMETER names of a slice step's NUMERIC arguments, scope tokens skipped — aligned
 *  index-for-index with `sliceOf`'s `nums` decode, so `sliceParamNames(step)[0]` names `limit`'s
 *  count / `skip`'s offset / `range`'s low regardless of a leading `Scope` token. `null` where that
 *  argument is a parsed literal. Now that each `Arg` carries its own `name`, dropping the scope token
 *  drops its name with it — no separate index to keep aligned. Only `limit`/`skip` act on it — a
 *  single count that can bind untouched (`sliceBound`); `range` must reduce, so it never reads this. */
export function sliceParamNames(step: IRStep): (string | null)[] {
  return (step.args ?? [])
    .filter((a) => !isScopeArg(a.value))
    .map((a) => a.name);
}

/**
 * The barriers that COLLAPSE — a body ending in one reduces its whole input to a SINGLE traverser.
 * Lowering such a body per-origin does not merely reorder the answer, it returns a different
 * cardinality: `values('age').union(__.min(), __.max())` becomes four per-value minima instead of
 * `[27, 35]`.
 *
 * A strict subset of `GLOBAL_BARRIER_STEPS`, and the difference is deliberate. The SLICE and SORT
 * barriers (`limit`/`range`/`skip`/`tail`/`order`/`sample`/`dedup`) also batch in the reference —
 * `RangeGlobalStepContract extends FilteringBarrier`, `OrderGlobalStep extends
 * CollectingBarrierStep`, both `Barrier` — but they preserve cardinality, our per-origin form of
 * them is pinned the WRONG WAY by our own tests, and no corpus scenario witnesses either reading.
 * Flipping those is T3 of the branch-arm plan and needs a hand-derived L4 pin FIRST.
 *
 * `fold`/`group`/`groupCount` collapse too and are absent for a different reason: they change the
 * stream's SHAPE, so batching one turns a homogeneous merge into a mixed-shape one. That is T2's
 * ground, not this vocabulary's.
 *
 * So it is `REDUCERS` exactly, today — deliberately spelled as an equality rather than a fresh list,
 * because the two are the same members for different reasons and only one of them is free to grow:
 * `REDUCERS` is "the SQL aggregates over a scalar stream", this is "the barriers whose result is one
 * traverser". `fold` joining the second (T2) must not silently join the first.
 */
export const COLLAPSING_BARRIERS: ReadonlySet<string> = REDUCERS;

/**
 * The branch kinds whose arms can see the branch's WHOLE input, and it is a class-hierarchy fact,
 * not a judgement: `UnionStep` and `ChooseStep` extend `BranchStep`, whose `standardAlgorithm`
 * injects every start at once when `hasBarrier` is set. `CoalesceStep extends FlatMapStep` and
 * `OptionalStep extends AbstractStep` take ONE traverser at a time unconditionally, so a barrier in
 * one of their arms genuinely reduces over that traverser's sub-stream and our per-origin lowering
 * of those two is CORRECT.
 *
 * Named separately from `BRANCH_KINDS` for exactly that reason — "fix all four branch kinds" would
 * break a dozen tests that are already right
 * (docs/2026-08-01-branch-arm-barrier-scope-plan.md §1, §6).
 */
export const BATCHING_BRANCHES: ReadonlySet<string> = new Set(['union', 'choose']);

/**
 * The barriers that PRESERVE cardinality but choose or reorder a subset of the whole stream. Every
 * one is a `Barrier` in the reference — `RangeGlobalStepContract`/`TailGlobalStepContract extends
 * FilteringBarrier`, `OrderGlobalStep`/`SampleGlobalStep extends CollectingBarrierStep`,
 * `DedupGlobalStep extends FilteringBarrier` — so each sets `hasBarrier` exactly as a reducer does.
 *
 * Separate from `COLLAPSING_BARRIERS` because the two differ in what they do to the merge, not in
 * whether they batch: a collapsing arm loses its carried per-traverser state to
 * `dropLayoutAtBarrier`, a slice arm keeps it.
 */
export const SLICE_BARRIERS: ReadonlySet<string> =
  new Set(['limit', 'range', 'skip', 'tail', 'order', 'sample', 'dedup']);

/**
 * The barriers whose presence in an arm makes that arm see the branch's WHOLE input.
 *
 * `GLOBAL_BARRIER_STEPS` minus four, and each exclusion is a reason rather than an oversight:
 * `fold`/`group`/`groupCount`/`aggregate` change the stream's SHAPE, so batching one turns a
 * homogeneous merge into a mixed-shape merge (that is the branch-arm plan's own open ground, and
 * bundling it here would hide a shape change inside a scope change); `local` is in
 * `GLOBAL_BARRIER_STEPS` because two other gates want "not row-local" from it and is not a `Barrier`
 * in the reference at all; `barrier` itself is a no-op for us.
 *
 * So this is the set whose arms we can hand to the ordinary engine over the branch's input and get
 * the same SHAPE back. That is the whole criterion, and it is why the set is spelled here rather
 * than derived by subtraction at a call site.
 */
export const BATCHED_BARRIERS: ReadonlySet<string> = unionOf(COLLAPSING_BARRIERS, SLICE_BARRIERS);

/**
 * Does this arm body BATCH — does a barrier in it make the arm observe the branch's whole input?
 *
 * Position-INDEPENDENT on purpose. `hasBarrier` is set by
 * `getStepsOfAssignableClassRecursively(Barrier.class, …)`, which asks whether the option CONTAINS
 * one, not whether it ends in one — so `union(__.out().count().is(gt(0)), …)` batches, and gating on
 * the TERMINAL step would route it down the per-origin path. Measured: that spelling is what a
 * committed test caught, and it is a real 4-vs-2 row difference.
 *
 * The scan is flat, so a barrier that sits only inside a NESTED branch arm is not seen here and that
 * arm keeps its per-origin lowering. The reference's scan recurses; matching it is a separate
 * widening, deliberately not bundled in.
 */
export const armBatches = (body: readonly { readonly name: string }[]): boolean =>
  body.some((s) => BATCHED_BARRIERS.has(s.name));

/** The four steps that fork a traverser into arms and merge the results. */
export type BranchKind = 'union' | 'choose' | 'coalesce' | 'optional';
export const BRANCH_KINDS: ReadonlySet<string> = new Set<string>(['union', 'choose', 'coalesce', 'optional']);
export const asBranchKind = (name: string): BranchKind | null =>
  BRANCH_KINDS.has(name) ? name as BranchKind : null;

// ---------- `is(typeOf(GType.X))`: ONE decode, three readings ----------
//
// A `typeOf` assert is read by the group, path, list and scalar arms, and before this was one
// function they had already DRIFTED — the group arm THREW on a non-MAP assert where the path arm
// returned an empty relation. This is the one decode, and it sits beside `sliceOf` because it is
// the same kind of thing: THE total decode of one step's arguments, so no consumer re-reads
// `step.args[0]` for itself.
//
// What a NON-matching assert MEANS is deliberately not decided here. It genuinely differs per arm
// and both answers are defensible — an empty relation (the assert is a filter that matched nothing)
// or a throw (this arm has no lowering for the shape the caller claims). Naming the decode
// separately from the policy is what lets the two stop drifting without forcing one on both.

export type TypeAssert =
  /** `is(typeOf(GType.X))`; `gtype` is X in Gremlin's own UPPERCASE spelling ('MAP', 'PATH', …). */
  | { readonly kind: 'gtype'; readonly gtype: string }
  /** The predicate IS `typeOf`, but its argument names no GType we can read. */
  | { readonly kind: 'opaque' }
  /** Not an `is(typeOf(…))` at all — a different step, or an is() with a different predicate. */
  | { readonly kind: 'none' };

const NO_TYPE_ASSERT: TypeAssert = { kind: 'none' };

/** PURE. Decode an `is(typeOf(GType.X))` follower. Total over the three outcomes so a reader must
 *  say what it does with each — an arm that only cares about one GType should use `assertsGType`. */
export function typeOfAssert(step: IRStep): TypeAssert {
  if (step.name !== 'is') return NO_TYPE_ASSERT;
  const pred = (step.args ?? [])[0]?.value;
  if (!isPred(pred) || pred.op !== 'typeOf') return NO_TYPE_ASSERT;
  const name = gtypeName(pred.operands?.[0]?.value);
  return name ? { kind: 'gtype', gtype: name.toUpperCase() } : { kind: 'opaque' };
}

/** PURE. Does `step` assert exactly this GType? The boolean reading of `typeOfAssert`, for the arms
 *  whose own shape answers exactly one GType (`'MAP'` for map/group/valueMap, `'PATH'` for path). */
export const assertsGType = (step: IRStep, gtype: string): boolean => {
  const a = typeOfAssert(step);
  return a.kind === 'gtype' && a.gtype === gtype;
};

/** PURE. The COLLECTION reading of `typeOfAssert`: the canonical collection name a scalar value
 *  stream is being retyped to (`is(typeOf(GType.LIST|SET|MAP))`), else null. A derived coarse view
 *  of the one decode, not a second one. */
export function collectionAssert(step: IRStep): 'list' | 'set' | 'map' | null {
  const a = typeOfAssert(step);
  if (a.kind !== 'gtype') return null;
  const c = normalizeTypeName(a.gtype);
  return c === 'list' || c === 'set' || c === 'map' ? c : null;
}

// ---------- the SHAPE-LOCAL vocabularies: what a step name means over one VALUE ----------
//
// The four below used to live beside the emission code that first consumed them. Each is a step-name
// vocabulary and nothing else — no stream, no lowering state, no SQL — so keeping them beside an
// emitter did two bad things at once: it pinned every importer to a whole emission closure for the
// sake of a Set of strings, and it hid them from the "derive with a named difference, never merge"
// rule this module exists to enforce. Read them against the bases above, not against the file each
// used to live in.

/** The syntax-only scalar transform vocabulary — the step names whose meaning is "reshape this one
 *  scalar value", emitted by `scalarTx` (`plan/plan.ts`). Membership is decided by SYNTAX alone,
 *  which is why child-shape classification can consult it without importing an emitter: the
 *  classifier must run BEFORE the engine it would otherwise pull in. */
export const SCALAR_TRANSFORMS: ReadonlySet<string> = new Set([
  'concat', 'length', 'toUpper', 'toLower', 'asString', 'substring', 'replace',
  'trim', 'lTrim', 'rTrim', 'reverse', 'asBool', 'asNumber', 'asDate', 'dateAdd', 'dateDiff',
]);

/** The `Scope.local` collection transforms that keep a list a LIST — a per-list reshape, not a
 *  whole-stream reduction. Spelled as its own base rather than as `SLICE_STEPS + order/dedup/tail`
 *  because the members coincide today for unrelated reasons: these are the ops with a per-list
 *  meaning, those are the ops that denote a window. */
export const LIST_LOCAL_TX: ReadonlySet<string> = new Set(['order', 'dedup', 'limit', 'skip', 'range', 'tail']);

/** The scalar string transforms that, applied to a LIST, apply to each ELEMENT (`Scope.local`).
 *  A strict subset of `SCALAR_TRANSFORMS`, and the exclusions are the whole content:
 *  `reverse` reverses element ORDER on a list rather than each string, and `concat` is excluded
 *  because TinkerPop ships no `ConcatLocalStep` — `ConcatStep.map` rejects a non-String receiver at
 *  every scope, so `g.inject(["a","b"],"c").concat("d")` must THROW, not answer `['ad','bd','cd']`.
 *  It did answer that, from a membership list that looked harmlessly complete. */
export const STRING_LOCAL_TX: ReadonlySet<string> = new Set([
  'toUpper', 'toLower', 'trim', 'lTrim', 'rTrim', 'asString', 'length', 'substring', 'replace',
]);

/** The collection ops with an unambiguous meaning over a PATH: the path coerces to its element
 *  sequence and the op reshapes/filters/explodes that list. `order`/`dedup`/`limit`/`count` are
 *  deliberately absent — over a path those are WHOLE-STREAM ops, so they overlap
 *  `LIST_LOCAL_TX` by name while meaning something else entirely. Two vocabularies, not one with
 *  an exception. */
export const PATH_LIST_OPS: ReadonlySet<string> = new Set([
  'combine', 'intersect', 'difference', 'disjunct', 'product', 'merge', 'reverse', 'conjoin',
  'all', 'any', 'none', 'unfold',
]);
