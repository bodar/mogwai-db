import { type IRStep, isLocalScope, isPlainOrder, REDUCERS, VERTEX_MOVES, EDGE_MOVES, ENDPOINT_MOVES, OTHER_V, unionOf } from './step.ts';
import { isNested, isTokenArg, stepChain } from '../../gremlin/frontend.ts';
import { rawBodies, someStepDeep } from './walk.ts';

// ---------- WHO OBSERVES A TRAVERSER MULTIPLICITY — one authority, asked at a POSITION ----------
//
// A movement collapse (`SELECT id, SUM(bulk) … GROUP BY id`) replaces N convergent traversers with
// ONE row carrying `bulk = N`. That is only result-equivalent while every consumer downstream of it
// READS the multiplicity — sums it, resets it, or carries it to the wire — and it is a wrong ANSWER,
// silently short of rows, the moment one reads rows where it must read traversers.
//
// **The question is positional, and this module is the one place that answers it.** Both references
// model it that way and neither models it as a chain verdict:
//
// - **TinkerPop decides WHERE bulking may be introduced, per position.** `LazyBarrierStrategy` walks
//   the chain inserting the `NoOpBarrierStep`s that bulk traversers, and disqualifies a position by
//   what is live THERE — `labeledPath` suppresses insertion after a step that carries labels, and a
//   `PathProcessor` whose `keepLabels` has emptied RE-ENABLES it ("if no more path data, then start
//   barrier'ing again")
//   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/LazyBarrierStrategy.java:104-134`).
//   Whether two traversers may merge at all is then per traverser CLASS, by `equals`
//   (`.../traverser/B_O_Traverser.java:70` merges on the object alone; `B_LP_O_S_SE_SL_Traverser.java:117`
//   ANDs the path in, so labelled traversers never merge).
// - **Calcite declares splittability per FUNCTION, not per query.** `SqlSplittableAggFunction`'s own
//   javadoc is this problem: *"Aggregate function that can be split into partial aggregates. For
//   example, COUNT(x) can be split into COUNT(x) on subsets followed by SUM to combine those counts"*
//   (`vendor/calcite/core/src/main/java/org/apache/calcite/sql/SqlSplittableAggFunction.java:42-48`).
//
// So the two questions a collapse asks are separate and neither subsumes the other:
//
// 1. **May these rows merge HERE?** — a property of the state carried at that node, answered by
//    `channels.ts`'s `CHANNEL_GROUP_POLICY` (`groupableChannels`). Already positional.
// 2. **Will the multiplicity be READ?** — a property of the SUFFIX, answered here.
//
// `ChainFacts.collapseSafe` (`analyze.ts`) is question 2 asked of the WHOLE chain, which is why it
// also has to refuse the prefix shapes question 1 already covers: it cannot say "safe here, unsafe
// there". Two shapes measure the difference, both of which this module admits and the chain verdict
// refuses: `g.V().out().order().by('name').limit(2).count()` (the chain verdict admits a post-order
// slice only under an ELEMENT terminal, because it cannot see that the slice sits between the
// collapse and a reducer that sums what the slice trimmed), and `g.V().out().dedup().limit(2)` (a
// dedup RESETS the multiplicity, so the slice behind it never meets one).
//
// **What is admitted here grows one name at a time, with its own argument.** `select` is the next
// candidate and is deliberately absent: a single-label `select` re-frames to the element the alias
// holds and looks bulk-transparent, but whether `selectKeys` carries the channel through has not been
// measured, and an unlearned step here costs a collapse OPPORTUNITY while a wrong guess costs an
// ANSWER. That asymmetry is the whole reason the scan's default is `'reads-rows'`.

/** vertex/edge/endpoint movement — the hops a collapse merges convergent walks across. `OTHER_V` is
 *  absent, and visibly so (`step.ts`'s rule): `otherV` carries the entering-vertex context as
 *  per-traverser identity. Its absence here costs a collapse OPPORTUNITY and never an answer, so
 *  admitting it is its own increment with its own pin rather than a widening smuggled in. */
export const COLLAPSE_MOVES = unionOf(VERTEX_MOVES, EDGE_MOVES, ENDPOINT_MOVES);

/** Steps that neither read nor change a multiplicity. A filter drops whole rows, so `bulk` rides
 *  through untouched; `as()` BINDS a label on the rows it is handed, which is well-defined exactly
 *  because a collapsed frontier has one row per id (§7.2's positional half); a bare `barrier()` is
 *  `NoOpBarrierStep`, which is the reference's own bulking step and our `rowOp` identity. */
const BULK_TRANSPARENT = new Set(['has', 'hasLabel', 'hasId', 'where', 'filter', 'not', 'and', 'or', 'as', 'identity', 'barrier']);

/** A scalar projection off an element. It carries `bulk` as an ordinary column into the scalar
 *  vocabulary, so it is transparent to a REDUCER behind it — but only the `elements` framing arm
 *  projects `bulk` onto the wire (`lower.ts`'s `framed`), so it is fatal at a LEAF. Hence its own
 *  verdict rather than membership in the set above. */
const COLLAPSE_PROJ = new Set(['values', 'id', 'label']);

/** The row slices a cumulative-`SUM(bulk)` window can TRIM (`bulkSlice`), which is what makes them
 *  traverser-counting rather than row-counting. They need a position to accumulate along, so they
 *  are admitted only behind a plain `order()`. `sample` is deliberately absent at every position: a
 *  uniform sample of ROWS is not a uniform sample of traversers when a row stands for N of them, and
 *  a sample has no band to trim (`sliceOp` declines it outright). */
const TRIMMABLE_SLICES = new Set(['limit', 'range', 'skip', 'tail']);

/**
 * What a step does to a multiplicity it is handed. The scan's DEFAULT is `'reads-rows'`, which is
 * what makes this total over a vocabulary that keeps growing: an unlearned step costs a collapse
 * opportunity, never an answer.
 */
type BulkVerdict =
  /** passes it through unchanged, and the stream is still an ELEMENT one */
  | 'transparent'
  /** passes it through, but the stream is no longer an element one — only that framing carries `bulk` to the wire */
  | 'retypes'
  /** reads it as a count and answers for it, so nothing behind this step can misread one */
  | 'observes'
  /** the survivor stands for ITSELF (`DedupGlobalStep.filter`'s unconditional `setBulk(1L)`), so nothing behind it sees a multiplicity at all */
  | 'resets'
  /** reads ROWS where it must read TRAVERSERS — a collapse in front of this step is a wrong answer */
  | 'reads-rows';

/** The scan state a verdict depends on. Both fields are facts about what has already been walked,
 *  which is why the verdict is a function of a POSITION and not of a step name alone. */
type BulkScan = { readonly framedAsElements: boolean; readonly sawOrder: boolean };

function verdictOf(step: IRStep, scan: BulkScan): BulkVerdict {
  const nm = step.name;
  if (COLLAPSE_MOVES.has(nm)) return 'transparent';
  if (BULK_TRANSPARENT.has(nm)) return (step.args ?? []).length && nm === 'barrier' ? 'reads-rows' : 'transparent';
  if (isPlainOrder(step)) return 'transparent';
  // BOTH `dedup()` arms reset the multiplicity to 1 — the unordered form projects the literal and the
  // ordered one takes `MIN(encounter)` with the same literal — because a survivor stands for itself
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/DedupGlobalStep.java:75`
  // calls `setBulk(1L)` before it even looks at a `by()`). So a dedup ENDS the question rather than
  // continuing it. It is admitted only in the element framing: the scalar vocabulary's distinct has
  // not been shown to reset one, and asserting it here on the strength of the element arm is exactly
  // the assumption this module exists to avoid.
  if (nm === 'dedup') return scan.framedAsElements && !isLocalScope(step) ? 'resets' : 'reads-rows';
  if (TRIMMABLE_SLICES.has(nm)) return scan.sawOrder ? 'transparent' : 'reads-rows';
  if (REDUCERS.has(nm) && (step.args?.length ?? 0) === 0) return 'observes';
  if (bulkGroupCollapseTerminal(step)) return 'observes';
  if (scan.framedAsElements && COLLAPSE_PROJ.has(nm) && !step.modulators?.length) return 'retypes';
  return 'reads-rows';
}

/**
 * IS A MULTIPLICITY INTRODUCED AT `from` READ BY EVERYTHING THAT CONSUMES IT — the positional half of
 * collapse-safety, and the question `collapseSafe` could only ask of a whole chain.
 *
 * Asked by the RelIR movement fold of the suffix behind the hop it is about to collapse, and by
 * `computeCollapseSafe` of the whole chain so that the two cannot drift — one authority, per §7 of
 * `docs/archive/2026-08-09-repeat-two-regimes-plan.md`.
 *
 * Reaching the END of the chain is not automatically safe and that is the finding this module records:
 * only the `elements` framing arm carries `bulk` onto the wire (as the RLE count `execute.ts` frames),
 * so a chain that retyped to a scalar, a list, a map, a record or a path and then ENDED would drop the
 * multiplicity — N traversers answered as one row. `framedAsElements` is what makes the leaf a
 * question rather than an assumption.
 */
export function bulkObservedFrom(steps: readonly IRStep[], from: number): boolean {
  let framedAsElements = true;
  let sawOrder = false;
  for (let i = from; i < steps.length; i++) {
    const step = steps[i];
    switch (verdictOf(step, { framedAsElements, sawOrder })) {
      case 'observes': case 'resets': return true;
      case 'reads-rows': return false;
      case 'retypes': framedAsElements = false; break;
      case 'transparent': sawOrder ||= isPlainOrder(step); break;
    }
  }
  return framedAsElements;
}

/** A `groupCount()` terminal whose key does NOT fan out is a bulk-mergeable barrier: it
 *  weights every group by SUM(bulk) (see lowerGroup's isCount), so collapsing convergent
 *  walks into (element, N) before it is result-equivalent — the exact "groupCount after a
 *  big fan-out/repeat" correctness+tractability case. A bare key (the element identity), a
 *  property key `by('name')`, or a token key `by(T.label)` all follow the element's identity,
 *  so merging same-id rows keeps every key intact. A by(traversal) key can fan out (one
 *  traverser → many keys), which a GROUP BY-id merge would corrupt → left unsafe. A
 *  `group().by().by(__.count())` has the same split and is admitted by the shared terminal below;
 *  element/list-valued groups and every other reducer remain deferred. */
export function bulkGroupCollapseTerminal(step: IRStep): boolean {
  if (step.name === 'group') return reducingGroupCollapseTerminal(step);
  if (step.name !== 'groupCount' || (step.args?.length ?? 0) !== 0) return false;
  const modulators = step.modulators ?? [];
  if (modulators.length === 0) return true;
  if (modulators.length !== 1) return false;
  const a = modulators[0]?.[0];
  return nonFanoutKey(a);
}

/** A bare, property, or token key yields exactly one key per traverser. A traversal key may fan out,
 * so merging by element identity before it would change the answer. */
const nonFanoutKey = (a: unknown): boolean => a === undefined || typeof a === 'string' || isTokenArg(a);

/** `group().by(<non-fan-out key>).by(__.count())` is weighted by SUM(bulk) per key just like
 * `groupCount()`. This is Calcite's `SqlSplittableAggFunction.CountSplitter`: COUNT over partitions
 * followed by SUM of the partial counts
 * (`vendor/calcite/core/src/main/java/org/apache/calcite/sql/SqlSplittableAggFunction.java`). Keep
 * this deliberately narrower than `groupReducesItsValues`: an aggregate may ignore encounter order
 * without being splittable over an (id, bulk) frontier. */
function reducingGroupCollapseTerminal(step: IRStep): boolean {
  if (step.name !== 'group' || (step.args?.length ?? 0) !== 0) return false;
  const bys = step.modulators ?? [];
  if (bys.length === 0 || bys.length > 2 || !nonFanoutKey(bys[0]?.[0])) return false;
  const value = bys[1]?.[0];
  if (!isNested(value)) return false;
  try {
    const inner = stepChain(value.nested, {});
    return inner.length === 1 && inner[0].name === 'count' && (inner[0].args?.length ?? 0) === 0;
  } catch {
    return false;
  }
}

/** The prefix vocabularies `computeCollapseSafe` scans with. They live here, beside the multiplicity
 *  question they serve, rather than being spelled a second time in the chain analysis — `as`,
 *  `identity` and `barrier` are deliberately NOT in the filter set, because a chain-global verdict
 *  cannot tell an `as()` bound before a collapse from one bound after it. */
export { COLLAPSE_PROJ };
export const COLLAPSE_FILTERS: ReadonlySet<string> = new Set(['has', 'hasLabel', 'hasId', 'where', 'filter', 'not', 'and', 'or']);

// ---------- WHERE THE REFERENCE BULKS — one authority, `bulkingPositions` ----------
//
// Everything above asks where WE may introduce a multiplicity. The converse question — where does the
// REFERENCE merge equal traversers — is answered once, here, and every consumer derives from it.
//
// The reference merges equal traversers wherever a `TraverserSet` receives more than one: `add` folds an
// equal traverser into the FIRST arrival's slot, summing bulk
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/traverser/util/TraverserSet.java:88-96`),
// and equality is the traverser's object (`…/traverser/util/AbstractTraverser.java:181-188`) — plus its
// path for a path-carrying class (`…/traverser/B_LP_O_S_SE_SL_Traverser.java:113-125`) and never for one
// carrying an unmergeable sack. The sets that do it:
//
// - **an `inject()` start's own iterator** — `StartStep` hands it to `ExpandableStepIterator.add(Iterator)`, which drains it INTO the
//   `TraverserSet` (`…/step/util/ExpandableStepIterator.java:61-63`), so `inject(1, 2, 1)` reaches its next
//   step as `1×2, 2` (`…/step/sideEffect/StartStep.java:60-67`). A start `GraphStep` generates one traverser at a time and merges nothing;
// - **`LazyBarrierStrategy`, a DEFAULT strategy**, which inserts a `NoOpBarrierStep(2500)` after every
//   flat-map step but the FIRST (a `GraphStep` counting as one unless it names fewer than five ids or is
//   followed by a `has()`), unless the next step is itself a `Barrier`, the traversal end, or a labelled
//   path is live — and does nothing at all when the traversal requires a PATH
//   (`…/strategy/optimization/LazyBarrierStrategy.java:73,86-135`);
// - **`PathRetractionStrategy`, ALSO default**, which inserts one after every `PathProcessor` whose next
//   step is not a `Barrier` (`…/strategy/optimization/PathRetractionStrategy.java:134-141`);
// - **an explicit `barrier()`** (`…/step/map/NoOpBarrierStep.java:40-60`), the collecting barriers
//   `order()`/`sample()` (`…/step/util/CollectingBarrierStep.java:42-90` — `OrderGlobalStep.java:78`
//   STABLE-sorts the merged set), and the pass-through local barriers `aggregate('x')`/
//   `groupCount('x')`/`group('x')` (`…/step/sideEffect/SideEffectBarrierStep.java`, `AggregateStep.java`).
//
// A `NoOpBarrierStep(n)` drains after n DISTINCT slots (`barrier.size() < maxBarrierSize`), so a merge's
// `window` is how many distinct traversers one drain may hold; the regroup mint (`regroupFirstOccurrence`,
// `src/compiler/rel/build.ts`) reproduces one drain exactly and raises a deferral past it.
//
// Two answers come out of the one scan, and the difference between them is the whole design:
//
// - **EXACT** (`bulkingPositions`): every merge position, for a lowering that REPRODUCES the merge. It is
//   `'unknown'` wherever the scan cannot be exact before the position asked about — a label (a labelled
//   path changes both where the strategy inserts and what `equals` compares), a PATH requirement, a body
//   unrolled past `RepeatUnrollStrategy`, a merge step or a service, or any step outside the vocabulary
//   below — and for a sack anywhere. The lowering then declines where the SUPERSET says a merge it cannot
//   place lands under a reader of the order (`mayMergeAt`), and otherwise leaves the stream as it is.
// - **SUPERSET** (`referenceUnbulkedAt`): may the reference have merged ANYTHING before a position? Here an
//   over-count only declines, so what only REMOVES a merge (a label's equality) is ignored, what only adds
//   one is assumed, and a step the scan cannot classify answers `false`.

/** `LazyBarrierStrategy.MAX_BARRIER_SIZE` and `PathRetractionStrategy.MAX_BARRIER_SIZE` — the distinct-slot
 *  capacity of an implicit `NoOpBarrierStep` (`…/strategy/optimization/LazyBarrierStrategy.java:74`). */
export const MAX_BARRIER_SIZE = 2500;

/** Where a `TraverserSet` merge happens. */
export type BulkingKind =
  /** a start step's literal arguments, drained into its iterator's set */
  | 'start'
  /** `LazyBarrierStrategy`'s implicit `NoOpBarrierStep` after a flat-map */
  | 'lazy'
  /** `PathRetractionStrategy`'s implicit `NoOpBarrierStep` after a `PathProcessor` */
  | 'retraction'
  /** an explicit `barrier()` */
  | 'barrier'
  /** a `CollectingBarrierStep` — `order()`, `sample()` */
  | 'collecting'
  /** a pass-through `LocalBarrier` that writes a side effect — `aggregate('x')`, `groupCount('x')`, … */
  | 'side-effect'
  /** SUPERSET ONLY: a `RepeatStep`'s re-entry into its body, where an unrolled body went past
   *  `RepeatUnrollStrategy` — the reference merges there as evaluation interleaves, which no scan places */
  | 'repeat';

/** ONE MERGE of the stream `steps[after]` emits, i.e. of the stream reaching `steps[after + 1]`. */
export interface BulkingPosition {
  readonly after: number;
  readonly kind: BulkingKind;
  /** the most distinct traversers one drain holds — `Infinity` for an unbounded set */
  readonly window: number;
  /** is the stream reaching the merge provably pairwise distinct, so the merge folds nothing? */
  readonly distinct: boolean;
}

/** The reference's `Barrier` steps (`…/process/traversal/step/Barrier.java` and its implementors), by IR
 *  name — the next-step exemption both strategies make. Only the GLOBAL form of a scoped step is one:
 *  `count(local)` is a map. */
const BARRIER_NAMES: ReadonlySet<string> = new Set([
  'count', 'sum', 'min', 'max', 'mean', 'fold', 'group', 'groupCount', 'order', 'sample', 'aggregate', 'cap',
  'barrier', 'dedup', 'limit', 'range', 'skip', 'tail', 'tree', 'subgraph',
]);
/** A step spliced out of a per-traverser host stands for that host (`local`/`map`/`flatMap`), which is no
 *  `Barrier` whatever its body holds. */
export const isReferenceBarrier = (s: IRStep | undefined): boolean =>
  !!s && !s.perTraverser && BARRIER_NAMES.has(s.name) && !isLocalScope(s);

/** The flat-map steps `LazyBarrierStrategy` counts — `FlatMapStep`s (`VertexStep` returning vertices,
 *  `EdgeVertexStep`, `PropertiesStep`, `UnfoldStep`, `TraversalFlatMapStep`, `CoalesceStep`) and a mid-chain
 *  `GraphStep`. An EDGE-returning `VertexStep` is excluded by name in the strategy (`returnsEdge()`), and
 *  `otherV` requires a PATH, which switches the strategy off. */
const FLAT_MAPS: ReadonlySet<string> = unionOf(VERTEX_MOVES, ENDPOINT_MOVES,
  new Set(['values', 'properties', 'unfold', 'flatMap', 'coalesce', 'V', 'E']));

/** Steps that neither expand nor merge and keep a pairwise-distinct stream distinct — filters, and the
 *  writes that pass their traverser through (`AddPropertyStep`, `AddLabelStep`, … are `SideEffectStep`s;
 *  `DropStep` a filter that drops everything). Their children (if any) answer a verdict, never stream rows. */
const FILTERS: ReadonlySet<string> = new Set([
  'has', 'hasLabel', 'hasId', 'hasNot', 'hasKey', 'hasValue', 'is', 'filter', 'not', 'and', 'or', 'where',
  'coin', 'identity', 'timeLimit', 'none', 'discard', 'property', 'addLabel', 'dropLabel', 'dropLabels', 'drop',
]);

/** One-to-one (or one-to-at-most-one) maps and pass-through steps that neither expand nor merge, but may
 *  map two distinct traversers to equal ones. A `local()`/`map()`/`sideEffect()` runs its body per
 *  traverser in a traversal of its own, so no merge lands in THIS one; a `branch` step is a `BranchStep`
 *  whose merge is its arms' (`branchHoldsBarrier`). */
const MAPS: ReadonlySet<string> = new Set([
  'id', 'label', 'key', 'value', 'constant', 'project', 'valueMap', 'elementMap', 'propertyMap', 'select', 'addV', 'addE',
  'local', 'map', 'sideEffect', 'union', 'choose', 'optional', 'branch',
  'asString', 'toUpper', 'toLower', 'length', 'trim', 'lTrim', 'rTrim', 'reverse', 'concat', 'replace',
  'substring', 'split', 'dateAdd', 'dateDiff', 'asDate', 'asNumber', 'asBool', 'format', 'index',
  'conjoin', 'combine', 'difference', 'disjunct', 'intersect', 'merge', 'product',
]);

/** The steps whose stream is ONE traverser (a global reduction) — distinct by itself. */
const REDUCING: ReadonlySet<string> = new Set(['count', 'sum', 'min', 'max', 'mean', 'fold', 'group', 'groupCount', 'cap']);

/** The slices — `FilteringBarrier`s that only drop, so they keep a distinct stream distinct. */
const SLICES: ReadonlySet<string> = new Set(['limit', 'range', 'skip', 'tail']);

/** Steps whose presence BEFORE a position makes the exact scan unknowable there: a label (a labelled path
 *  suppresses the strategy and enters `equals`), a PATH requirement (`PathFilterStep`, `PathStep`, `TreeStep`,
 *  `EdgeOtherVertexStep`, `TraversalSelectStep` — the strategy returns early), `match` (labels), a merge
 *  step (a `MergeElementStep` is a flat-map whose output depends on the graph it writes), and a service. */
const UNKNOWABLE_BEFORE: ReadonlySet<string> = new Set([
  'as', 'path', 'simplePath', 'cyclicPath', 'tree', 'otherV', 'match', 'element', 'mergeV', 'mergeE', 'call', 'io',
]);
/** The steps that read or write a sack — present anywhere, the traversal's traversers all carry one. */
const SACK_STEPS: ReadonlySet<string> = new Set(['sack', 'loops']);

/** A source argument's EQUALITY key, or `undefined` where the scan cannot say. Deliberately COARSER
 *  than Java's `equals` (`1` and `1L` share a key, as do `1` and `"1"`), because a false collision only
 *  costs the merge's no-op skip while a missed one would skip a real merge. */
function literalKey(value: unknown): string | undefined {
  if (value === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof value)) return String(value);
  if (Array.isArray(value) || value instanceof Map) {
    try {
      // A map's entries in KEY order: `Map.equals` compares entries in no order (`AbstractMap.equals`), so
      // `[a:1,b:2]` and `[b:2,a:1]` must share a key.
      return JSON.stringify(value, (_k, v) => (v instanceof Map
        ? [...v.entries()].sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))
        : typeof v === 'bigint' ? String(v) : v));
    } catch { return undefined; }
  }
  return undefined;
}

/** Are a start step's arguments literal and pairwise distinct — so its `TraverserSet` merges nothing? */
function distinctLiterals(step: IRStep): boolean {
  const keys = new Set<string>();
  for (const a of step.args ?? []) {
    const key = literalKey(a.value);
    if (key === undefined || keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

/** A root start step whose traversers the scan can name: a `V()`/`E()`/`inject()` the user wrote (not a
 *  landed marker standing in for a federated arm). */
const knownStartStep = (start: IRStep | undefined): start is IRStep =>
  !!start && !start.landedSource && start.graphTag == null
  && (start.name === 'V' || start.name === 'E' || start.name === 'inject');

/** Does `steps` open with a start step the scan can name — so it is scanned `rooted`? */
export const beginsWithSource = (steps: readonly IRStep[]): boolean => knownStartStep(steps[0]);

/** IR steps that are no step in the reference — a label rides the previous step, an `identity()` is
 *  removed (`IdentityRemovalStrategy`) — so neither separates two steps the reference sees as adjacent. */
const NOT_A_REFERENCE_STEP: ReadonlySet<string> = new Set(['as', 'identity', 'by', 'with']);

/** The step the reference runs right after `steps[i]`, skipping IR-only steps. */
function nextReferenceStep(steps: readonly IRStep[], i: number): IRStep | undefined {
  for (let j = i + 1; j < steps.length; j++) if (!NOT_A_REFERENCE_STEP.has(steps[j]!.name)) return steps[j];
  return undefined;
}

/** Does a branch step hold a `Barrier` anywhere in an arm (`BranchStep.hasBarrier`, set by
 *  `getStepsOfAssignableClassRecursively(Barrier.class, …)`, `…/step/branch/BranchStep.java:87-88`)? Then
 *  every start enters each arm's own set and is merged there, so the branch's output is no longer
 *  per-traverser. A folded `option()` cluster or an unreadable arm answers `true`. */
function branchHoldsBarrier(step: IRStep): boolean {
  if (step.optionArms?.length || step.hasBarrier) return true;
  const read = rawBodies({});
  return (step.args ?? []).some(({ value }) => {
    if (!isNested(value)) return false;
    const arm = read(value.nested);
    return !arm || someStepDeep(arm, read, (s) => isReferenceBarrier(s as IRStep), true);
  });
}

/** The side-effect KEY a step writes, if it is the side-effect form (`groupCount('x')`, not `groupCount()`). */
const sideEffectKey = (s: IRStep): boolean => (s.args ?? []).some((a) => typeof a.value === 'string');

/** `barrier(n)`'s window, or `undefined` when its argument is not a literal count. */
function barrierWindow(s: IRStep): number | undefined {
  const args = s.args ?? [];
  if (!args.length) return Infinity;
  const n = args[0]!.value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Could inlining `step` land a `PathProcessor` in this traversal? `InlineFilterStrategy` splices a
 *  `filter()`/`and()`/`or()` whose children are filters into the parent (`…/strategy/optimization/
 *  InlineFilterStrategy.java:80-84, 196-213`), so a wrapped `where(…)`/`math(…)` lands here. Unreadable
 *  answers `true`. Only the SUPERSET scan asks — the exact one already refuses every label. */
function holdsPathProcessor(step: IRStep): boolean {
  if (!INLINED_FILTERS.has(step.name)) return false;
  for (const v of [...(step.args ?? []).map((a) => a.value), ...(step.modulators ?? []).flat()]) {
    if (!isNested(v)) continue;
    let chain: readonly IRStep[];
    try { chain = stepChain(v.nested, {}); } catch { return true; }
    if (chain.some((c) => SUPERSET_PATH_PROCESSORS.has(c.name) || holdsPathProcessor(c))) return true;
  }
  return false;
}
const INLINED_FILTERS: ReadonlySet<string> = new Set(['filter', 'and', 'or']);

/** The `PathProcessor`s the superset scan places a retraction barrier after: every `where` (a labelled
 *  one is a `WhereTraversalStep`/`WherePredicateStep`; the superset does not tell them apart), `math`,
 *  `select`, and the path filters. */
const SUPERSET_PATH_PROCESSORS: ReadonlySet<string> = new Set(['where', 'math', 'select', 'format', 'simplePath', 'cyclicPath']);
/** The path processors that MAP rather than filter. */
const PATH_MAPS: ReadonlySet<string> = new Set(['math', 'select', 'format']);

/** `FilterRankingStrategy` runs BEFORE `PathRetractionStrategy` and moves a filter in front of a
 *  higher-ranked one it directly follows (`…/strategy/optimization/FilterRankingStrategy.java:113-131,
 *  174-199`), so a ranked path processor written last may no longer be last when the barrier is placed.
 *  The superset scan therefore drops the next-step exemption for a ranked processor that directly follows
 *  another ranked filter. */
const RANKED_FILTERS: ReadonlySet<string> = new Set([
  'has', 'hasLabel', 'hasId', 'hasNot', 'hasKey', 'hasValue', 'is', 'where', 'filter', 'not', 'and', 'or',
  'dedup', 'order',
]);

/** The parents that EMIT their child's traversers rather than a value split off the parent: `LocalStep`
 *  (`…/step/branch/LocalStep.java:60-67`) and the `BranchStep`s. `map()`/`flatMap()`/`coalesce()` split
 *  their output off the PARENT traverser (`…/step/map/FlatMapStep.java:42-52`), so a merge inside their
 *  body never reaches this traversal. */
const BULK_FORWARDING: ReadonlySet<string> = new Set(['local', 'union', 'choose', 'optional', 'branch']);

/** May a bulk-forwarding parent's body emit merged traversers — does its own (child, superset) scan hold
 *  a merge over a stream that may repeat? A folded `option()` cluster or an unreadable body answers `true`. */
function bodiesMayBulk(step: IRStep, single: boolean): boolean {
  if (step.optionArms?.length) return true;
  for (const v of (step.args ?? []).map((a) => a.value)) {
    if (!isNested(v)) continue;
    let chain: readonly IRStep[];
    try { chain = stepChain(v.nested, {}); } catch { return true; }
    // A body opening with its own start step is scanned by that step's rule; any other is handed the
    // host's stream — ONE traverser where the host's input is one (`single`).
    const positions = scan(chain, knownStartStep(chain[0] as IRStep | undefined), 'superset', chain.length, single);
    // A `repeat` re-entry merge is the residue `IMPLICIT` already leaves to `'unknown'`, not a forwarded one.
    if (positions === 'unknown' || positions.some((p) => !p.distinct && p.kind !== 'repeat')) return true;
  }
  return false;
}

/** Steps that keep a stream of AT MOST ONE traverser at most one — filters, slices, the one-to-one maps,
 *  the pass-through side effects and the reorders. A flat-map, a branch or anything unlisted may fan out. */
const SINGLE_PRESERVING: ReadonlySet<string> = new Set([
  ...FILTERS, ...SLICES, 'dedup', 'barrier', 'order', 'sample', 'aggregate', 'group', 'groupCount', 'subgraph',
  'id', 'label', 'key', 'value', 'constant', 'project', 'valueMap', 'elementMap', 'propertyMap', 'select', 'math', 'format', 'path',
  'map', 'sideEffect', 'addV', 'addE',
  'asString', 'toUpper', 'toLower', 'length', 'trim', 'lTrim', 'rTrim', 'reverse', 'concat', 'replace',
  'substring', 'split', 'dateAdd', 'dateDiff', 'asDate', 'asNumber', 'asBool', 'index',
  'conjoin', 'combine', 'difference', 'disjunct', 'intersect', 'merge', 'product', 'otherV',
]);
/** Does `s` keep a single-traverser stream single? (A global reduction MAKES one — the scan's own rule.) */
const keepsSingle = (s: IRStep): boolean =>
  s.perTraverser ? s.splicedHost !== 'flatMap' : (isLocalScope(s) && BARRIER_NAMES.has(s.name)) || SINGLE_PRESERVING.has(s.name);

/** The steps whose `TraverserRequirement.PATH` switches `LazyBarrierStrategy` off for their traversal:
 *  `PathStep`, `PathFilterStep`, `TreeStep`/`TreeSideEffectStep`, `EdgeOtherVertexStep` (and a
 *  `TraversalSelectStep`, matched by its nested argument). */
const PATH_REQUIRERS: ReadonlySet<string> = new Set(['path', 'simplePath', 'cyclicPath', 'tree', 'otherV']);

/** A `PathProcessor` that needs no label: `math`, `format`, and a `select` naming a key (a side effect,
 *  in a label-free traversal) rather than a `Column`. */
const labelFreePathProcessor = (s: IRStep): boolean =>
  s.name === 'math' || s.name === 'format'
  || (s.name === 'select' && (s.args ?? []).some((a) => typeof a.value === 'string' || isNested(a.value)));

type Mode = 'exact' | 'superset';

/**
 * THE SCAN. Walks `steps` — a whole traversal: `rooted` when `steps[0]` is the root's start step, else a
 * child traversal — through the two strategies' insertion rules, recording every merge. `upTo` stops the
 * walk (the consumer at `upTo` is still read as a next step). `'unknown'` where the mode cannot answer.
 *
 * `singleStart` says how a CHILD is fed: one parent traverser at a time (the default — `TraversalUtil.apply`,
 * `LocalStep`, a traverser-major `BranchStep` option), or EVERY start at once — an option of a `BranchStep`
 * whose options hold a `Barrier` (`hasBarrier`), which pushes all its starts into the option before reading
 * any back (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java:87-88,143-148`).
 * There a map of two distinct starts may make two equal traversers, and a barrier in the option merges them.
 */
function scan(steps: readonly IRStep[], rooted: boolean, mode: Mode, upTo = steps.length, singleStart = !rooted): readonly BulkingPosition[] | 'unknown' {
  const exact = mode === 'exact';
  // A sack is on EVERY traverser once any step reads one, and it decides whether traversers merge at all;
  // everything else the exact scan cannot place matters only where it sits BEFORE the position asked about
  // — a label bound later is not yet on the path, a write later has not yet run.
  if (exact && (someStepDeep(steps, {}, (s) => SACK_STEPS.has(s.name), true)
    || someStepDeep(steps.slice(0, upTo), {}, (s) => UNKNOWABLE_BEFORE.has(s.name)
      || (s as IRStep).unrolled === 'beyond' || (s as IRStep).labelsRetracted === true, true))) return 'unknown';
  if (steps.some((s) => s.bulkingSuppressed)) return 'unknown';
  // `LazyBarrierStrategy` does NOTHING in a traversal that requires a PATH anywhere in it, or that holds a
  // `DropStep`/`ElementStep` (`LazyBarrierStrategy.java:80-86`); `PathRetractionStrategy` does nothing
  // in a ROOT that requires a PATH anywhere (`PathRetractionStrategy.java:76-78, 241-245`). A child cannot
  // see its root, so it keeps its retraction barriers — over-counting only declines.
  const requiresPath = someStepDeep(steps, {}, (s) => PATH_REQUIRERS.has(s.name)
    || (s.name === 'select' && (s.args ?? []).some((a) => isNested(a.value))), false);
  const lazyOff = requiresPath || steps.some((s) => s.name === 'element' || s.name === 'drop');
  const retractionOff = requiresPath && rooted;
  const positions: BulkingPosition[] = [];
  let foundFlatMap = false;
  // A live labelled path suppresses the strategy's barriers until a `PathProcessor` retracts every label
  // (`LazyBarrierStrategy.java:104-108, 128-130`). The exact scan refused every label; the superset clears
  // the flag at ANY path processor, which can only add barriers.
  let labeledPath = false;
  let distinct = true;
  // Does the stream hold AT MOST ONE traverser? A child traversal is handed one parent traverser at a time
  // (`singleStart`), and a set of at most one merges nothing, however its traverser was reached.
  let single = singleStart;
  let from = 0;
  if (rooted) {
    const start = steps[0];
    if (!exact && start?.name === 'call') {
      foundFlatMap = true;
      distinct = false;
      single = false;
      from = 1;
    } else {
    if (!knownStartStep(start)) return 'unknown';
    const ids = start.args ?? [];
    if (ids.length && start.name === 'inject') {
      positions.push({ after: 0, kind: 'start', window: Infinity, distinct: distinctLiterals(start) });
      // A drained set holds pairwise-distinct traversers.
      distinct = true;
    } else if (ids.length) {
      // A start `GraphStep` generates its traversers ONE AT A TIME (`…/step/map/GraphStep.java:193-196`) —
      // no set holds them, so a repeated id is two traversers, unmerged.
      distinct = distinctLiterals(start);
    } else if (start.name === 'inject') return 'unknown';
    single = ids.length === 1;
    // A GraphStep counts as the first flat-map unless it names fewer than BIG_START_SIZE (5) ids, or names
    // none and is followed by a `HasStep` (`LazyBarrierStrategy.java:113-115`).
    if (start.name !== 'inject') {
      const next = nextReferenceStep(steps, 0);
      foundFlatMap = ids.length >= 5 || (ids.length === 0 && !(next && next.name.startsWith('has')));
    }
    if (start.labelsRetracted) labeledPath = true;
    from = 1;
    }
  }
  for (let i = from; i < Math.min(upTo, steps.length); i++) {
    const s = steps[i]!;
    const name = s.name;
    if (name === 'as') { labeledPath = true; continue; }
    if (name === 'by' || name === 'with') continue;
    // The LAST step of a body `RepeatUnrollStrategy` unrolled is followed by the `NoOpBarrierStep(2500)` it
    // inserts — a `Barrier`, so the step itself takes no barrier of the strategy's — except after the final
    // body when the step after the repeat is a `Barrier` already (`RepeatUnrollStrategy.java:100-113`).
    const phaseEnd = s.unrolled === 'strategy' ? s.unrolledPhaseEnd : undefined;
    const next = nextReferenceStep(steps, i);
    const realNextIsBarrier = !next || isReferenceBarrier(next);
    const nextIsBarrier = realNextIsBarrier || !!phaseEnd;
    const placedBefore = positions.length;
    const singleIn = single;
    const verdict = visit(s, i, nextIsBarrier, singleIn);
    if (verdict === 'unknown') return 'unknown';
    // A global reduction MAKES a single traverser — not its keyed side-effect form, which passes the stream on.
    single = (singleIn && keepsSingle(s)) || (REDUCING.has(name) && !isLocalScope(s) && !((name === 'group' || name === 'groupCount') && sideEffectKey(s)));
    if (single) {
      distinct = true;
      for (let k = placedBefore; k < positions.length; k++) positions[k] = { ...positions[k]!, distinct: true };
    }
    if (phaseEnd && !(phaseEnd === 'last' && realNextIsBarrier)) {
      positions.push({ after: i, kind: 'lazy', window: MAX_BARRIER_SIZE, distinct });
      distinct = true;
    }
    if (s.labelsRetracted) labeledPath = true;
  }
  return positions;

  /** One step's effect on the scan state — `'unknown'` where the mode cannot place its merges. */
  function visit(s: IRStep, i: number, nextIsBarrier: boolean, single: boolean): 'unknown' | void {
    const name = s.name;
    const local = isLocalScope(s);
    const barrierAfter = foundFlatMap && !labeledPath && !lazyOff && !nextIsBarrier;
    const flatMap = (out: boolean): void => {
      if (barrierAfter) {
        positions.push({ after: i, kind: 'lazy', window: MAX_BARRIER_SIZE, distinct: out });
        // A drained set holds pairwise-distinct traversers — only up to its window, past which the regroup
        // mint raises — so the stream after a merge is distinct again.
        distinct = true;
      } else {
        foundFlatMap = true;
        distinct = out;
      }
    };
    // A body this pass widened past `RepeatUnrollStrategy` runs, in the reference, inside a `RepeatStep`
    // whose re-entries merge as evaluation interleaves (`RepeatStep.java:265-278, 334-353`). The exact scan
    // refused it; the superset counts a merge after every such step.
    if (s.unrolled === 'beyond') {
      positions.push({ after: i, kind: 'repeat', window: Infinity, distinct: false });
      distinct = false;
      return;
    }
    // A step spliced out of a per-traverser host (`inlineIdentityHostBody`) ran in that host's own child
    // traversal, one traverser at a time, and its body leaves the stream alone — so it is transparent here,
    // but a spliced `flatMap()` still stood where a counted flat-map stands (`splicedHost`).
    if (s.perTraverser) {
      if (s.splicedHost === 'flatMap') flatMap(distinct);
      return;
    }
    // `otherV()` is a map that requires a PATH (the exact scan refused it); counted as a flat-map here
    // because over-counting only declines.
    if (OTHER_V.has(name)) {
      if (exact) return 'unknown';
      flatMap(false);
      return;
    }
    // `properties()` of pairwise-distinct elements is pairwise distinct (a property has one owner); every
    // other flat-map may reach one traverser twice.
    if (FLAT_MAPS.has(name)) { flatMap(distinct && name === 'properties'); return; }
    if (EDGE_MOVES.has(name)) { distinct = false; return; }
    if (name === 'barrier') {
      const window = barrierWindow(s);
      if (window === undefined) return 'unknown';
      positions.push({ after: i, kind: 'barrier', window, distinct });
      distinct = true;
      return;
    }
    if ((name === 'order' || name === 'sample') && !local) {
      positions.push({ after: i, kind: 'collecting', window: Infinity, distinct });
      distinct = true;
      return;
    }
    if (name === 'aggregate' || name === 'subgraph' || ((name === 'groupCount' || name === 'group') && sideEffectKey(s))) {
      positions.push({ after: i, kind: 'side-effect', window: Infinity, distinct });
      distinct = true;
      return;
    }
    if (name === 'dedup' && !local) { distinct = true; return; }
    if (SLICES.has(name) && !local) return;
    if (REDUCING.has(name) && !local) { distinct = true; return; }
    if (exact && labelFreePathProcessor(s)) {
      // `MathStep`, a side-effect `select('x')` (`SelectOneStep`) and `FormatStep` are `PathProcessor`s
      // with or without a label: `PathRetractionStrategy` places a barrier after each unless the next step
      // is a `Barrier` (or nothing).
      if (s.args.some((a) => isNested(a.value)) && name === 'select') return 'unknown';
      const placed = !nextIsBarrier && !retractionOff;
      if (placed) positions.push({ after: i, kind: 'retraction', window: MAX_BARRIER_SIZE, distinct: false });
      distinct = placed;
      return;
    }
    if (!exact && (SUPERSET_PATH_PROCESSORS.has(name) || holdsPathProcessor(s))) {
      const ranked = RANKED_FILTERS.has(name) || INLINED_FILTERS.has(name);
      let j = i - 1;
      while (j >= 0 && NOT_A_REFERENCE_STEP.has(steps[j]!.name)) j--;
      const movable = ranked && j >= 0 && RANKED_FILTERS.has(steps[j]!.name);
      // A path FILTER keeps a distinct stream distinct, so its barrier merges nothing wherever it lands; a
      // path MAP (`math`, `select`, `format`) may map distinct traversers to equal ones.
      const outDistinct = distinct && !PATH_MAPS.has(name);
      if (!outDistinct && !retractionOff && (!nextIsBarrier || movable))
        positions.push({ after: i, kind: 'retraction', window: MAX_BARRIER_SIZE, distinct: false });
      distinct = outDistinct;
      labeledPath = false;
      return;
    }
    // A `where()` with a label is a `PathProcessor`; the exact scan already refused every label.
    if (FILTERS.has(name)) return;
    if (MAPS.has(name) || (local && BARRIER_NAMES.has(name))) {
      if (BULK_FORWARDING.has(name) && name !== 'local' && branchHoldsBarrier(s)) return 'unknown';
      // A body whose OWN traversers may arrive merged forwards them merged: `LocalStep` and `BranchStep`
      // emit the child's traversers as they are, bulk and all. The exact scan cannot place that merge in
      // this traversal; the superset counts it as one.
      if (BULK_FORWARDING.has(name) && bodiesMayBulk(s, single)) {
        if (exact) return 'unknown';
        positions.push({ after: i, kind: 'lazy', window: MAX_BARRIER_SIZE, distinct: false });
      }
      distinct = false;
      return;
    }
    return 'unknown';
  }
}

/**
 * EVERY MERGE THE REFERENCE MAKES in the traversal `steps` begins (see the section head) — or `'unknown'`
 * where the scan cannot be exact. A lowering that reproduces the merges reads this; one that cannot
 * reproduce them asks `referenceUnbulkedAt` instead.
 */
export function bulkingPositions(steps: readonly IRStep[], rooted: boolean, upTo = steps.length, singleStart = !rooted): readonly BulkingPosition[] | 'unknown' {
  return scan(steps, rooted, 'exact', upTo, singleStart);
}

/**
 * DOES A BRANCH OPTION MERGE EQUAL TRAVERSERS AT ITS OWN END? Every `BranchStep` option is closed by an
 * `EndStep` (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java:85`),
 * which is neither a `Barrier` nor the `EmptyStep` that ends any other traversal — so `LazyBarrierStrategy`
 * puts its `NoOpBarrierStep` after an option's LAST flat-map too
 * (`…/strategy/optimization/LazyBarrierStrategy.java:116-127`), where the root and a `local()`/`by()` child
 * get none: `V(1,4,6).out().values('name').fold()` keeps every `lop` where it arrived, while
 * `union(…, out().values('name'))` merges them at the first one's place. The option is scanned as the child
 * traversal it is, with a non-barrier step after its end; `true` where the superset scan places a merge of
 * possibly-equal traversers there (or cannot see).
 */
export function armEndMerges(body: readonly IRStep[]): boolean {
  if (!body.length) return false;
  const closed = [...body, { name: '__end', args: [] } as unknown as IRStep];
  const positions = scan(closed, false, 'superset', body.length);
  if (positions === 'unknown') return true;
  // Only `LazyBarrierStrategy`'s merge is the EndStep's doing; a side-effect barrier at the end merges with or
  // without it, and that merge is its own step's to reproduce.
  return positions.some((p) => p.after === body.length - 1 && !p.distinct && p.kind === 'lazy') && !sortedAdjacent(body, body.length - 1);
}

/**
 * A merge of EQUAL traversers that are already ADJACENT moves nothing: `order().by(k).values(k)` hands the
 * barrier after `values(k)` its equal values side by side, so collapsing them at the first one's place keeps
 * the stream as it was (only the bulk moves, and every reader here counts it).
 */
function sortedAdjacent(steps: readonly IRStep[], at: number): boolean {
  const read = steps[at];
  const sort = steps[at - 1];
  const key = read?.name === 'values' && read.args?.length === 1 ? read.args[0]!.value : undefined;
  if (typeof key !== 'string' || sort?.name !== 'order' || isLocalScope(sort) || sort.modulators?.length !== 1) return false;
  return sort.modulators[0]![0] === key;
}

/**
 * Where the EXACT scan places a `LazyBarrierStrategy` merge of possibly-equal traversers before `at` in a CHILD
 * traversal — `'unknown'` where it cannot see (a label, a sack, …). The narrower twin of `referenceUnbulkedAt`
 * for a consumer that reproduces nothing past the scan's sight and keeps its previous answer there. A
 * retraction barrier after a `select()` of a label bound OUTSIDE the child is left out: every traverser of
 * one start selects the same object there, so the equal ones are already adjacent.
 */
export function placedMergeBefore(steps: readonly IRStep[], at: number): boolean | 'unknown' {
  const positions = scan(steps, false, 'exact', at);
  if (positions === 'unknown') return 'unknown';
  return positions.some((p) => p.after < at && !p.distinct && p.kind === 'lazy' && !sortedAdjacent(steps, p.after));
}

/**
 * Does the reference reach position `at` of `steps` with EVERY traverser still at bulk 1 — so a consumer
 * that reads rows reads exactly the reference's traversers? `steps` must BEGIN the traversal: `rooted`
 * when `steps[0]` is the root's start step, `false` for a child traversal handed one parent traverser at
 * a time (a `by()` body, which `TraversalUtil.apply` runs at bulk 1). Derived from the SUPERSET scan: no
 * merge before `at` over a stream that may hold equal traversers. Conservative: `false` wherever the scan
 * cannot see.
 */
export function referenceUnbulkedAt(steps: readonly IRStep[], at: number, rooted: boolean, singleStart = !rooted): boolean {
  const positions = scan(steps, rooted, 'superset', at, singleStart);
  return positions !== 'unknown' && positions.every((p) => p.after >= at || p.distinct);
}

/**
 * MAY the reference merge equal traversers on the stream reaching `steps[at]` of a ROOT traversal where a
 * READER observes it — for a caller whose exact scan answered `'unknown'` and that must therefore decline
 * wherever an unreproduced merge would change its answer. Only a step that reads stream order (a slice, a
 * collecting consumer — `readsOrder`, at any depth) after `at` observes it; a root emission the corpus
 * asserts unordered does not. The SUPERSET scan places the merge where it can; where even it cannot see
 * the prefix, the step before `at` is judged on its own: a flat-map, a path processor or a pass-through
 * side-effect barrier whose next step is no `Barrier` may carry an implicit `NoOpBarrierStep`, and a
 * start step naming repeated literals merges them. (An explicit `barrier()`/`order()` merges in its own
 * step, `barrierRows`/`orderRows`.)
 */
export function mayMergeAt(steps: readonly IRStep[], at: number, rooted = true, enclosingReads = false, singleStart = !rooted): boolean {
  if (at <= 0 || !(enclosingReads || readsStreamOrder(steps.slice(at)))) return false;
  const positions = scan(steps, rooted, 'superset', at, singleStart);
  if (positions !== 'unknown') return positions.some((p) => p.after === at - 1 && !p.distinct && IMPLICIT.has(p.kind));
  const before = steps[at - 1]!;
  if (at - 1 === 0 && rooted) return knownStartStep(before) && !distinctLiterals(before);
  const next = nextReferenceStep(steps, at - 1);
  if (before.perTraverser) return before.splicedHost === 'flatMap' && !!next && !isReferenceBarrier(next);
  if (before.name === 'aggregate') return true;
  if (!next || isReferenceBarrier(next) || before.unrolled === 'beyond') return false;
  return FLAT_MAPS.has(before.name) || OTHER_V.has(before.name) || SUPERSET_PATH_PROCESSORS.has(before.name);
}

/**
 * `mayMergeAt` for a step list the lowering cannot place in its traversal (`ChainCtx.traversal` does not
 * name it): scanned as the traversal it would begin — from its own start step's rule where it opens with
 * one (a `GraphStep` counts by its own index in its own traversal, `LazyBarrierStrategy.java:113-115`),
 * else as a child from its first step. Only a reader IN `steps` is weighed: an unplaced list cannot say
 * how its host consumes it (a `group()` value body runs once per KEY, a `union()` arm per start or over
 * all of them), so a reader beyond it is that host's to judge.
 */
/**
 * Does a GLOBAL slice after `at` cut the stream reaching it — the one reader whose MEMBERSHIP a merge
 * changes even where the stream carries no emission order: `RangeGlobalStep` trims a merged slot's bulk
 * as one traverser (`…/step/filter/RangeGlobalStep.java:73-120`), so which k traversers survive depends on
 * the slots, not on any order the rows happen to be read in. (An unordered stream's other readers fold in
 * a canonical value order, which no merge can move.) A slice past a step that merges or collapses the
 * WHOLE stream reads that step's output instead — and a whole-stream merge (`order()`, `barrier()`,
 * `dedup()`, a reduction) answers the same whatever was merged before it, because a stable regroup keeps
 * every value's first occurrence and its multiplicity.
 */
export function slicedAfter(steps: readonly IRStep[], at: number): boolean {
  for (const s of steps.slice(at)) {
    if (isLocalScope(s)) continue;
    if (SLICES.has(s.name)) return true;
    if (WHOLE_STREAM.has(s.name) && !(s.name === 'barrier' && (s.args ?? []).length) && !(s.name === 'dedup' && (s.args ?? []).length)) return false;
  }
  return false;
}
const WHOLE_STREAM: ReadonlySet<string> = new Set([...REDUCING, 'order', 'barrier', 'dedup']);

/** The global reductions whose ONE value carries no member order — nothing upstream of them is readable as
 *  an arrival order downstream. (`fold`/`group`/`cap` keep their members in arrival order, so an `unfold()`
 *  behind one re-emits that order: not resets.) */
const ORDER_FREE: ReadonlySet<string> = new Set(['count', 'sum', 'min', 'max', 'mean']);

/** Is the stream leaving `steps[from - 1]` read in ANY order — does it reach the end of the list with no
 *  order-free reduction (`ORDER_FREE`) on the way? `inherited` is whether the list's own output is read. */
export function orderReadAfter(steps: readonly IRStep[], from: number, inherited = true): boolean {
  for (let i = from; i < steps.length; i++) if (ORDER_FREE.has(steps[i]!.name) && !isLocalScope(steps[i]!)) return false;
  return inherited;
}

export function mayMergeUnplaced(steps: readonly IRStep[], at: number): boolean {
  // A `call()` start (a barrier service's resume) is the superset scan's own rooted case.
  return mayMergeAt(steps, at, steps[0]?.name === 'call' || knownStartStep(steps[0]));
}

/** The merges a stream receives between two steps rather than in a step of its own. `repeat` is absent: a
 *  `RepeatStep`'s re-entry merge depends on evaluation interleaving, so declining at it would refuse every
 *  widened unroll for a merge no one can place — that residue is `bulkingPositions`' `'unknown'`. */
const IMPLICIT: ReadonlySet<BulkingKind> = new Set<BulkingKind>(['start', 'lazy', 'retraction', 'side-effect']);

/** Steps that keep a stream of pairwise-DISTINCT traversers distinct — filters, which only drop. */
const DISTINCT_PRESERVING: ReadonlySet<string> = new Set([
  'as', 'has', 'hasLabel', 'hasId', 'hasNot', 'hasKey', 'hasValue', 'is', 'where', 'filter', 'not', 'and', 'or',
  'identity', 'limit', 'range', 'skip', 'simplePath', 'cyclicPath',
]);

/**
 * Does the reference reach position `at` with a stream of PAIRWISE-DISTINCT traversers, each at bulk 1?
 * Stronger than `referenceUnbulkedAt`, and the question a GLOBAL child asks of its parent: a `union()`
 * arm holding a barrier receives every parent traverser into ONE `TraverserSet` (`BranchStep`, arm-major —
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java:120-152`),
 * which merges equal ones even where no barrier was inserted. A start that names distinct traversers,
 * followed only by filters, is the shape the scan can vouch for; a child traversal (`rooted: false`)
 * starts from ONE traverser, which is distinct by itself.
 */
export function referenceDistinctAt(steps: readonly IRStep[], at: number, rooted: boolean): boolean {
  if (rooted && !(knownStartStep(steps[0]) && distinctLiterals(steps[0]))) return false;
  for (let i = rooted ? 1 : 0; i < at; i++) if (!DISTINCT_PRESERVING.has(steps[i]!.name)) return false;
  return true;
}

/** Steps that keep a pairwise-distinct stream distinct ON TOP of `DISTINCT_PRESERVING`: a reorder (a
 *  merge point over distinct traversers merges nothing). */
const REORDERS: ReadonlySet<string> = new Set(['order', 'barrier']);

/** Is the stream reaching `at` pairwise distinct? Walking back over steps that keep a distinct stream
 *  distinct (`DISTINCT_PRESERVING`, `REORDERS`), it is when it reaches a whole-traverser `dedup()`
 *  (`DedupGlobalStep` with no key and no `by()` keeps one traverser per equal class, whatever reached
 *  it) or the START of a step list known to begin a traversal (`start`): a rooted chain's start naming
 *  distinct traversers, or a child traversal's one parent traverser. Anything else — a flat-map, a map,
 *  an unknown start — may hold equal traversers. */
export function streamDistinctAt(steps: readonly IRStep[], at: number, start: { readonly rooted: boolean } | undefined): boolean {
  for (let i = at - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.name === 'dedup') return !isLocalScope(s) && !(s.args ?? []).length && !s.modulators?.length;
    if (i === 0 && start?.rooted) return knownStartStep(s) && distinctLiterals(s);
    if (!DISTINCT_PRESERVING.has(s.name) && !REORDERS.has(s.name)) return false;
  }
  return !!start && !start.rooted;
}

/**
 * Does the explicit `barrier()` at `steps[at]` merge equal traversers in a way a reader can observe
 * WITHOUT an emission order to regroup? `barrier()` is a `NoOpBarrierStep` that drains its
 * `TraverserSet` in slot order (`…/process/traversal/step/map/NoOpBarrierStep.java:40-60`), so
 * `inject(1,2,1,3).barrier()` emits `1,1,2,3`. Where the stream carries an emission order the lowering
 * REPRODUCES that merge (`regroupFirstOccurrence`); this is the residual decline for a stream that carries
 * none while a reader still demands one — `readsOrder` downstream, or (a body) the inherited `ordered`.
 * Unobservable — no decline — over a stream the scan vouches pairwise distinct (`streamDistinctAt`).
 */
export function unorderedBarrierMergeObservable(
  steps: readonly IRStep[], at: number, start: { readonly rooted: boolean } | undefined, ordered: boolean,
): boolean {
  if (streamDistinctAt(steps, at, start)) return false;
  return readsOrder(steps.slice(at + 1)) || (!start?.rooted && ordered);
}

/** The steps whose answer READS the order of the stream reaching them — the slices
 *  (`ChainFacts.demandsSlice`'s positional consumers) and the collecting consumers, whose members keep
 *  arrival order (`ir/analyze.ts`'s `COLLECTING_CONSUMERS`). */
const ORDER_READERS: ReadonlySet<string> = new Set(['limit', 'range', 'skip', 'tail', 'fold', 'aggregate', 'cap', 'group']);

/** `readsOrder` without `cap`: a `cap` reads a side-effect COLLECTION, whose order was fixed where the
 *  collection was written (an `aggregate`, itself a reader), not the stream that reaches the `cap`. */
function readsStreamOrder(steps: readonly IRStep[]): boolean {
  return someStepDeep(steps, {}, (s) => ORDER_READERS.has(s.name) && s.name !== 'cap' && !isLocalScope(s as IRStep), true);
}

/** Does any step of `steps` — or of any body nested in one, at any depth — read stream order? Nested
 *  bodies count because a per-traverser child (`local(limit(1))`) or a branch arm reads the order its
 *  host is fed in. An unnormalizable body is assumed to read it. */
function readsOrder(steps: readonly IRStep[]): boolean {
  return someStepDeep(steps, {}, (s) => ORDER_READERS.has(s.name) && !isLocalScope(s as IRStep), true);
}

/** The steps a per-traverser body answers DIFFERENTLY for one traverser at bulk k than for k traversers at
 *  bulk 1, where a host hands its child the traverser WITH its bulk (`OptionalStep`): a global reduction
 *  emits ONE traverser for the k (a `count()` of `k·n`, not k counts of n), a slice trims the bulk
 *  (`RangeGlobalStep.filter`, `…/step/filter/RangeGlobalStep.java:73-120`), a dedup resets it, and an
 *  order or a coin acts on the merged slot. */
const BULK_NONLINEAR: ReadonlySet<string> = new Set([
  'count', 'sum', 'min', 'max', 'mean', 'fold', 'group', 'groupCount', 'tree', 'cap',
  'limit', 'range', 'skip', 'tail', 'sample', 'dedup',
]);

/** Does a body, at any depth, hold a step whose answer for one bulk-k traverser differs from k bulk-1
 *  ones (`BULK_NONLINEAR`, global scope)? Unreadable answers `true`. */
export function bulkNonlinear(body: readonly IRStep[]): boolean {
  return someStepDeep(body, {}, (s) => BULK_NONLINEAR.has(s.name) && !isLocalScope(s as IRStep), true);
}
