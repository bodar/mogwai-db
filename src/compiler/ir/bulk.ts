import { type IRStep, isLocalScope, isPlainOrder, REDUCERS, VERTEX_MOVES, EDGE_MOVES, ENDPOINT_MOVES, OTHER_V, unionOf } from './step.ts';
import { isNested, isTokenArg, stepChain } from '../../gremlin/frontend.ts';

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

// ---------- WHERE THE REFERENCE BULKS — the converse question, asked of a PREFIX ----------
//
// Everything above asks where WE may introduce a multiplicity. A consumer that reads ROWS where the
// reference reads TRAVERSERS asks the converse: could the reference have MERGED two equal traversers
// before this position? Almost every consumer is indifferent — a reducer weights by bulk, a list fold
// expands it — but a NON-LIST `fold(seed, Operator.x)` is not: `FoldStep.projectTraverser` hands the
// operator the traverser's object ONCE whatever its bulk
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/FoldStep.java:58-68`),
// so `sum` over a bulked `29×3` adds 29 once. Our rows are the reference's traversers EXPANDED by bulk,
// so the two answers agree exactly when the reference bulked nothing before the fold.
//
// The reference merges equal traversers wherever a `TraverserSet` receives more than one:
//
// - **`LazyBarrierStrategy`, a DEFAULT strategy** (`…/traversal/TraversalStrategies.java:287`), inserts a
//   `NoOpBarrierStep` after every flat-map step but the FIRST (a `GraphStep` counting as one), unless
//   the next step is itself a `Barrier`
//   (`…/strategy/optimization/LazyBarrierStrategy.java:105-127`) — and it runs per traversal, so a child
//   traversal starts the count afresh;
// - **`PathRetractionStrategy`, ALSO default** (`…/traversal/TraversalStrategies.java:286`), inserts one
//   after every `PathProcessor` (`math`, `where`, `simplePath`, `select`, `dedup`, …) whose next step is
//   not a `Barrier`, labels or no (`…/strategy/optimization/PathRetractionStrategy.java:134-141`) — and
//   `FilterRankingStrategy` runs first, so a ranked `where()` may have moved (`lastBeforeConsumer`);
// - **an explicit `barrier()`** and every collecting barrier (`order()`, `aggregate()`, …);
// - **a start step's own iterator** — `ExpandableStepIterator.add(Iterator)` drains it INTO the
//   `TraverserSet` (`…/step/util/ExpandableStepIterator.java:61-63`), so `inject(1, 1, 2)` and `V(1, 1)`
//   reach their next step as `1×2, 2`.
//
// So the answer is a scan that models those positions and is CONSERVATIVE everywhere it cannot: an
// unlearned step, a non-literal source argument or a source the scan does not know answers `false`,
// which costs the caller a decline and never an answer. Over-counting a flat-map (a `V().has(…)` that the
// reference does not count, an `outE()` it skips) only adds barriers the reference does not have, so the
// scan never needs to be as precise as `LazyBarrierStrategy` to be SOUND.

/** Steps that neither expand nor merge a traverser and whose children (if any) produce a VALUE or a
 *  verdict rather than stream rows — filters and one-to-one maps. None is a `FlatMapStep` or a barrier. */
const NEITHER_EXPANDS_NOR_MERGES: ReadonlySet<string> = new Set([
  'has', 'hasLabel', 'hasId', 'hasNot', 'hasKey', 'hasValue', 'is', 'filter', 'not', 'and', 'or',
  'as', 'identity', 'constant', 'id', 'label', 'key', 'value', 'limit', 'range', 'skip',
  'project', 'valueMap', 'elementMap', 'propertyMap',
]);

/** The `PathProcessor` steps the scan lets through, each a position where `PathRetractionStrategy` —
 *  ALSO a default strategy (`…/traversal/TraversalStrategies.java:286`) — inserts a `NoOpBarrierStep`
 *  unless the next step is a `Barrier`
 *  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/PathRetractionStrategy.java:134-141`).
 *  It does so whether or not a label is involved, and its `keepLabels` retraction can make two traversers
 *  whose paths differed EQUAL there (`ImmutablePath.retract`), so the barrier merges on the object alone.
 *  The other `PathProcessor`s (`select`, `path`, `tree`, `format`, `match`, `dedup`) are in no set here,
 *  so the scan already answers `false` at them. */
const PATH_PROCESSORS: ReadonlySet<string> = new Set(['where', 'math', 'simplePath', 'cyclicPath']);

/** The steps `FilterRankingStrategy` ranks. It runs BEFORE `PathRetractionStrategy` and moves a filter in
 *  front of a higher-ranked one it directly follows
 *  (`…/strategy/optimization/FilterRankingStrategy.java:113-131, 174-199`), so a ranked `where()` written
 *  last may no longer be last when the barrier is placed. A rank-0 step (`math`, `simplePath`) never moves. */
const RANKED_FILTERS: ReadonlySet<string> = new Set([
  'has', 'hasLabel', 'hasId', 'hasNot', 'hasKey', 'hasValue', 'is', 'where', 'filter', 'not', 'and', 'or',
  'dedup', 'order',
]);

/** The connectives whose children the reference may splice into the parent: `filter` and `and`
 *  (`InlineFilterStrategy.processTraversalFilterStep`/`processAndStep`). `or` inlines only `has()`
 *  children (`processOrStep`), but it is listed too — a decline there costs an opportunity, never an
 *  answer. `not` is absent: `NotStep` is neither inlined nor a `PathProcessor`, so its child runs per
 *  traverser and no barrier lands in this traversal. */
const INLINED_FILTERS: ReadonlySet<string> = new Set(['filter', 'and', 'or']);

/** Every `PathProcessor` the IR can name — gremlin-core's implementors are `WhereTraversalStep`,
 *  `WherePredicateStep`, `MathStep`, `PathFilterStep`, `SelectStep`, `SelectOneStep`,
 *  `TraversalSelectStep`, `PathStep`, `TreeStep`/`TreeSideEffectStep`, `FormatStep` and `MatchStep` —
 *  plus `dedup`, which reads labels too. */
const ANY_PATH_PROCESSOR: ReadonlySet<string> = unionOf(PATH_PROCESSORS,
  new Set(['select', 'path', 'tree', 'format', 'match', 'dedup']));

/** Could inlining `step` land a `PathProcessor` in this traversal? Its children's TOP-LEVEL steps are
 *  what is spliced, and the strategy re-runs until nothing changes, so a nested `filter(and(where(…)))`
 *  inlines all the way down — the walk descends through the connectives only. A path processor's OWN
 *  child (a `where(__.as('a').out())`'s `select`) is never spliced: it stays that step's per-traverser
 *  child. Conservative: a child the scan cannot read answers `true`. */
function holdsPathProcessor(step: IRStep): boolean {
  const values: unknown[] = [...(step.args ?? []).map((a) => a.value), ...(step.modulators ?? []).flat()];
  for (const v of values) {
    if (!isNested(v)) continue;
    let chain: readonly IRStep[];
    try { chain = stepChain(v.nested, {}); } catch { return true; }
    if (chain.some((c) => ANY_PATH_PROCESSOR.has(c.name) || (INLINED_FILTERS.has(c.name) && holdsPathProcessor(c)))) return true;
  }
  return false;
}

/** Is `step` a `filter`/`and` holding exactly ONE child that is exactly ONE `PATH_PROCESSORS` step (a
 *  label or `identity()` aside)? Inlined, that step alone stands where the wrapper stood. The wrapper's
 *  name is ranked (`RANKED_FILTERS`), so `lastBeforeConsumer` applies the ranked-filter rule to it,
 *  which is exact for `where()` and stricter than needed for a rank-0 `math()`. */
function soleChildIsPathProcessor(step: IRStep): boolean {
  if (step.name !== 'filter' && step.name !== 'and') return false;
  if (step.modulators?.length) return false;
  const args = step.args ?? [];
  if (args.length !== 1 || !isNested(args[0]!.value)) return false;
  let chain: readonly IRStep[];
  try { chain = stepChain(args[0]!.value.nested, {}); } catch { return false; }
  const real = chain.filter((c) => !NOT_A_REFERENCE_STEP.has(c.name));
  return real.length === 1 && PATH_PROCESSORS.has(real[0]!.name);
}

/** IR steps that are no step in the reference — a label rides the previous step, an `identity()` is
 *  removed (`IdentityRemovalStrategy`) — so neither separates two steps the reference sees as adjacent. */
const NOT_A_REFERENCE_STEP: ReadonlySet<string> = new Set(['as', 'identity']);

/** The flat-map steps — the positions `LazyBarrierStrategy` counts, and after the first of which it bulks. */
const FLAT_MAPS: ReadonlySet<string> = unionOf(VERTEX_MOVES, EDGE_MOVES, ENDPOINT_MOVES, OTHER_V,
  new Set(['values', 'properties', 'V', 'E']));

/** A source argument's EQUALITY key, or `undefined` where the scan cannot say. Deliberately COARSER
 *  than Java's `equals` (`1` and `1L` share a key, as do `1` and `"1"`), because a false collision only
 *  declines while a missed one would answer. */
function literalKey(value: unknown): string | undefined {
  if (value === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof value)) return String(value);
  if (Array.isArray(value) || value instanceof Map) {
    try {
      return JSON.stringify(value, (_k, v) => (v instanceof Map ? [...v.entries()] : typeof v === 'bigint' ? String(v) : v));
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

/**
 * Does the reference reach position `at` of `steps` with EVERY traverser still at bulk 1 — so a consumer
 * that reads rows reads exactly the reference's traversers? `steps` must BEGIN the traversal: `rooted`
 * when `steps[0]` is the root's start step, `false` for a child traversal handed one parent traverser at
 * a time (a `by()` body), whose incoming bulk scales every member alike and so never changes a
 * per-traverser answer. Conservative: `false` wherever the scan cannot see (above).
 */
export function referenceUnbulkedAt(steps: readonly IRStep[], at: number, rooted: boolean): boolean {
  let from = 0;
  let sawFlatMap = false;
  if (rooted) {
    if (!knownStart(steps[0])) return false;
    sawFlatMap = steps[0]!.name !== 'inject';
    from = 1;
  }
  // Is the stream still pairwise DISTINCT here (`referenceDistinctAt`)? A barrier over distinct traversers
  // merges nothing, so a path-processing FILTER over such a stream is harmless wherever it sits.
  let distinct = true;
  for (let i = from; i < at; i++) {
    const name = steps[i]!.name;
    if (PATH_PROCESSORS.has(name)) {
      if (!(distinct && DISTINCT_PRESERVING.has(name)) && !lastBeforeConsumer(steps, i, at)) return false;
    } else if (INLINED_FILTERS.has(name) && holdsPathProcessor(steps[i]!)) {
      // `InlineFilterStrategy` runs BEFORE `PathRetractionStrategy` (its POSTS) and splices a `filter()` or
      // `and()` whose children hold only `FilterStep`s into THIS traversal
      // (`…/strategy/optimization/InlineFilterStrategy.java:80-84, 196-213` and `processAndStep`), so a
      // wrapped `where()` lands here as a root PathProcessor and gets the same barrier — followed by
      // whatever else the child held. So it passes over a still-DISTINCT stream (a barrier there merges
      // nothing), or — when its whole child is ONE path processor, which is what then sits in the
      // wrapper's place — where that bare step would: last before the consumer.
      if (!distinct && !(soleChildIsPathProcessor(steps[i]!) && lastBeforeConsumer(steps, i, at))) return false;
    } else if (FLAT_MAPS.has(name)) {
      // A flat-map after the first is followed by a `NoOpBarrierStep` — unless the next step is the
      // consumer at `at`, a `Barrier` itself, which is the one exemption the strategy makes.
      if (sawFlatMap && i + 1 !== at) return false;
      sawFlatMap = true;
    } else if (!NEITHER_EXPANDS_NOR_MERGES.has(name)) return false;
    distinct &&= DISTINCT_PRESERVING.has(name);
  }
  return true;
}

/** Is the path processor at `i` the step the reference runs IMMEDIATELY before the consumer at `at`, so
 *  `PathRetractionStrategy` places no barrier after it? Not when another step follows it, and not when it
 *  is a ranked filter directly after another ranked filter `FilterRankingStrategy` could move behind it. */
function lastBeforeConsumer(steps: readonly IRStep[], i: number, at: number): boolean {
  if (i + 1 !== at) return false;
  if (!RANKED_FILTERS.has(steps[i]!.name)) return true;
  let j = i - 1;
  while (j >= 0 && NOT_A_REFERENCE_STEP.has(steps[j]!.name)) j--;
  return j < 0 || !RANKED_FILTERS.has(steps[j]!.name);
}

/** A root start step whose traversers the scan can name: a `V()`/`E()`/`inject()` the user wrote (not a
 *  landed marker standing in for a federated arm) over literal, pairwise-distinct arguments. */
const knownStart = (start: IRStep | undefined): boolean =>
  !!start && !start.landedSource && start.graphTag == null && distinctLiterals(start)
  && (start.name === 'V' || start.name === 'E' || start.name === 'inject');

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
  if (rooted && !knownStart(steps[0])) return false;
  for (let i = rooted ? 1 : 0; i < at; i++) if (!DISTINCT_PRESERVING.has(steps[i]!.name)) return false;
  return true;
}

/** The steps after which no ORDER of the stream survives — each consumes the whole stream into one
 *  order-free value (a count, a numeric reduction, a count map), so an upstream reorder is invisible. */
const ORDER_ERASING: ReadonlySet<string> = new Set(['count', 'sum', 'min', 'max', 'mean', 'groupCount']);

/** Steps that keep a pairwise-distinct stream distinct ON TOP of `DISTINCT_PRESERVING`: a reorder (a
 *  merge point over distinct traversers merges nothing). */
const REORDERS: ReadonlySet<string> = new Set(['order', 'barrier']);

/** Is the stream reaching `at` pairwise distinct? Walking back over steps that keep a distinct stream
 *  distinct (`DISTINCT_PRESERVING`, `REORDERS`), it is when it reaches a whole-traverser `dedup()`
 *  (`DedupGlobalStep` with no key and no `by()` keeps one traverser per equal class, whatever reached
 *  it) or the START of a step list known to begin a traversal (`start`): a rooted chain's start naming
 *  distinct traversers (`knownStart`), or a child traversal's one parent traverser. Anything else —
 *  a flat-map, a map, an unknown start — may hold equal traversers. */
function distinctAt(steps: readonly IRStep[], at: number, start: { readonly rooted: boolean } | undefined): boolean {
  for (let i = at - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.name === 'dedup') return !isLocalScope(s) && !(s.args ?? []).length && !s.modulators?.length;
    if (i === 0 && start?.rooted) return knownStart(s);
    if (!DISTINCT_PRESERVING.has(s.name) && !REORDERS.has(s.name)) return false;
  }
  return !!start && !start.rooted;
}

/** Does an `order()` TIE EVERY TRAVERSER — a `by()` whose key is a bare `constant(…)`? Then the stable
 *  sort leaves the merged set in arrival order, so the merge is the whole answer. A key that ties only
 *  SOME unequal traversers (two vertices sharing a `name`) shows the merge only on data where it ties;
 *  that data-dependent residue is the regroup mint's (Cluster A), declining it here would lose dozens of
 *  correct L3 scenarios (measured), and it stays tracked in `docs/outstanding-work.md`. */
function byTiesEveryTraverser(step: IRStep): boolean {
  return (step.modulators ?? []).some((by: readonly unknown[]) => by.some((arg) => {
    if (!isNested(arg)) return false;
    let chain: readonly IRStep[];
    try { chain = stepChain(arg.nested, {}); } catch { return true; }
    const real = chain.filter((c) => !NOT_A_REFERENCE_STEP.has(c.name));
    return real.length === 1 && real[0]!.name === 'constant';
  }));
}

/**
 * Does the reference MERGE EQUAL TRAVERSERS at the explicit `barrier()` / global `order()` at `steps[at]`
 * in a way this spine — which never merges, every row one traverser — does not reproduce and a reader
 * can observe? A STOPGAP DECLINE with ONE authority, which every tail consults (`mergeObservableAt`,
 * `lower.ts`) at every depth a step list is lowered.
 *
 * Both steps add their starts into ONE `TraverserSet`, which merges an equal traverser into the FIRST
 * arrival's slot (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/traverser/util/TraverserSet.java:88-96`):
 * `barrier()` is a `NoOpBarrierStep` that drains that set in slot order
 * (`…/process/traversal/step/map/NoOpBarrierStep.java:40-60`), and `order()` is a `CollectingBarrierStep`
 * that STABLE-sorts the merged set (`…/process/traversal/step/util/CollectingBarrierStep.java:42-90`,
 * `…/process/traversal/step/map/OrderGlobalStep.java:78`). So `inject(1,2,1,3).barrier()` emits
 * `1,1,2,3`, and so does `order().by(constant(0))`, where every traverser ties.
 *
 * It is unobservable — and nothing declines — where the scan can vouch the stream reaching `at` is
 * pairwise distinct (`distinctAt`), and for an `order()` whose keys do not tie every traverser
 * (`byTiesEveryTraverser`). A `barrier()` changes only ORDER, so it declines only where a reader demands
 * one (`ordered`, `ChainFacts.demandsEncounter`); an `order()`'s output order is its answer, so it
 * declines unless a later step erases order (`ORDER_ERASING`). Everywhere else this is a decline, until
 * a first-occurrence regroup mint lowers the merge itself.
 *
 * Deliberately NOT applied to the implicit `NoOpBarrierStep`s `LazyBarrierStrategy` places after a
 * flat-map (`…/strategy/optimization/LazyBarrierStrategy.java:73,86-135`): declining those loses most of
 * L3 (measured), and they are the plain-chain residue tracked in `docs/outstanding-work.md`.
 */
export function referenceMergeObservableAt(
  steps: readonly IRStep[], at: number, start: { readonly rooted: boolean } | undefined, ordered: boolean,
): boolean {
  const step = steps[at];
  if (!step || (step.name !== 'barrier' && step.name !== 'order') || isLocalScope(step)) return false;
  if (step.name === 'order' && !byTiesEveryTraverser(step)) return false;
  if (distinctAt(steps, at, start)) return false;
  const after = steps.slice(at + 1);
  if (step.name === 'order') return !after.some((s) => ORDER_ERASING.has(s.name));
  // A ROOT chain's downstream is `after` itself; a body's continues into whatever encloses it, which
  // only the inherited chain-global `ordered` speaks for.
  return readsOrder(after) || (!start?.rooted && ordered);
}

/** The steps whose answer READS the order of the stream reaching them — the slices
 *  (`ChainFacts.demandsSlice`'s positional consumers) and the collecting consumers, whose members keep
 *  arrival order (`ir/analyze.ts`'s `COLLECTING_CONSUMERS`). */
const ORDER_READERS: ReadonlySet<string> = new Set(['limit', 'range', 'skip', 'tail', 'fold', 'aggregate', 'cap', 'group']);

/** Does any step of `steps` — or of any body nested in one, at any depth — read stream order? Nested
 *  bodies count because a per-traverser child (`local(limit(1))`) or a branch arm reads the order its
 *  host is fed in. An unnormalizable body is assumed to read it. */
function readsOrder(steps: readonly IRStep[]): boolean {
  return steps.some((s) => (ORDER_READERS.has(s.name) && !isLocalScope(s))
    || [...(s.args ?? []).map((a) => a.value), ...(s.modulators ?? []).flat()].some((v) => {
      if (!isNested(v)) return false;
      try { return readsOrder(stepChain(v.nested, {})); } catch { return true; }
    }));
}
