import { type IRStep, isLocalScope, isPlainOrder, REDUCERS, VERTEX_MOVES, EDGE_MOVES, ENDPOINT_MOVES, unionOf } from './step.ts';
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
 * `docs/2026-08-09-repeat-two-regimes-plan.md`.
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
