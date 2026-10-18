import { isColumnArg, isOrderArg, isScopeArg } from '../../gremlin/frontend.ts';
import { isLocalScope } from '../ir/step.ts';
import type { IRStep } from '../ir/strategies.ts';
import type { ListOf } from '../../sql/kernel/render.ts';
import { ResumeGap, type Plan, type SegmentPlan } from '../segment.ts';
import type { FramedRel } from './framing.ts';
import type { Minter } from './build.ts';
import type { BarrierInput } from '../../services/spi/types.ts';
import { listSeed, lowerListResumeOf, lowerMapResumeOf, lowerRankHead, lowerToRel, mapSeed, type Lowering } from './lower.ts';
import { buildValueStreamTransformSegment, buildValueTransformSegment, mapHead, valueHead } from './barrier-value.ts';
import { rankKeys } from './ranked-order.ts';
import { compilerParamName } from '../../rel/expr.ts';
import { finishLowering } from './spine.ts';

/** Re-plan a value-transform barrier's resume TAIL as a nested segment rooted at the re-injected values
 *  (`Lowering.seed`) — supplied by `segmentPlan`, which holds the `SegmentRequest` `planOf` needs. `null`
 *  where the tail holds no further barrier or none covers it; the caller then raises its resume error. */
export type PlanTail = (tail: readonly IRStep[], seed: (fresh: Minter) => FramedRel) => Plan | null;
import { dedupLocalValue, orderLocalValue, orderMapLocalValue, orderMapStreamValue, orderStreamValue, type EntryComparator } from './orderability.ts';

// ---------- order/dedup(Scope.local) over a NESTED list, as a value-transform BARRIER ----------
//
// A BARE `order(Scope.local)` / `dedup(Scope.local)` (identity comparator) over a list whose members are
// themselves collections sorts/dedups by TinkerPop's ORDERABILITY — which is RECURSIVE (lexicographic over
// lists, order-independent over sets/maps), a shape recursion-free SQL cannot express and a JS comparator
// transcribes directly (`orderability.ts`). So it takes the SAME sync value-transform barrier `reverse()`/
// `split()`/regex use: a SQL head reads the nested lists, one batched JS `orderLocalValue`/`dedupLocalValue`
// runs over them, and `lowerListResumeOf` re-injects each transformed list under its member shape.
//
// It fires for a nested list whose leaf members are SCALARS (or nested scalar lists/maps) AND for one whose
// leaves are ELEMENTS — a `Map<K,List<vertex>>` value ordered whole. The element case round-trips by
// carrying the members' RAW ROWIDS through the barrier and materializing only at the edge (the architecture
// everywhere else: `map.ts` stores group members as rowids, `unfoldList`'s `elem` arm CASTs a rowid back to
// an element `id`): the head is built with element leaves DEMOTED to raw scalars (`rawListElements`, so
// `listPayloadExpr` emits nested rowids not framed objects), the rowids are sorted/deduped in JS (rowid
// order is the flat-case convention, `list.ts` `Comparator.comparing(Element::id)`), and the re-inject uses
// the ORIGINAL `{elem}` descriptor so the existing rowid re-source handles unfold/read/movement.
//
// It DECLINES:
//  - a FLAT list (scalar/element members) → the INLINE `listMemberOp` lowering (cheaper, `by()` supported);
//  - an element leaf that is NOT a rowid-recoverable bare `elem` — a `property` list (no root framer) or a
//    `mixed`-list element (already a `{t,v}` envelope at the site, rowid gone) → fail-closed decline;
//  - a FEDERATED/merged source — a landed foreign element re-sources its key via `BoundGraph`, which the
//    barrier resume (BaseGraph by default) does not thread yet; fail-closed until it does;
//  - a MODULATED order/dedup (a non-identity `by()` is the inline path's job).

/** Does this member tree reach an ELEMENT leaf anywhere? An `elem`/`property` member (at any nesting depth)
 *  is the case the barrier must carry as a rowid rather than let framing materialize. `property` is the
 *  element family's third kind. `map` values are self-describing and re-enter on their own, so they are not
 *  counted here (matching the existing scalar/map path, which fires for them unchanged). */
function hasElementLeaf(of: ListOf): boolean {
  if (of.kind === 'elem' || of.kind === 'property') return true;
  if (of.kind === 'list') return hasElementLeaf(of.of);
  if (of.kind === 'mixed') return of.arms.some((arm) => arm.kind === 'elem');
  return false;
}

/** Are ALL of this tree's element leaves rowid-RECOVERABLE — a bare `elem` reachable through `list` nesting?
 *  Only those survive the round-trip: `foldElements`/the group-value fold stored them as rowids, so demoting
 *  the leaf emits the rowid and `unfoldList` re-sources it. A `property` leaf (no root framer) and a
 *  `mixed`-list element (expanded to a `{t,v}` envelope at the site, so the rowid is already gone) are NOT
 *  recoverable — the barrier declines them. Called only when `hasElementLeaf` is already true. */
function recoverableElements(of: ListOf): boolean {
  if (of.kind === 'elem') return true;
  if (of.kind === 'property') return false;
  if (of.kind === 'list') return recoverableElements(of.of);
  if (of.kind === 'mixed') return !of.arms.some((arm) => arm.kind === 'elem');
  return true;
}

/** An `order(Scope.local)`'s `by()`s as MAP-ENTRY comparators — each `by(Column.keys|values[, asc|desc])`
 *  or a bare direction — or `null` for any other modulator (a property key, a traversal, `shuffle`), which
 *  is the inline fold's. The ENTRY vocabulary is the only one a map's own entries answer: `Column` reads a
 *  `Map.Entry` side, and nothing else in a `by()` is meaningful over one. */
function entryComparators(step: IRStep): readonly EntryComparator[] | null {
  const comparators: EntryComparator[] = [];
  for (const by of step.modulators ?? []) {
    let side: EntryComparator['side'];
    let dir: EntryComparator['dir'] | undefined;
    for (const arg of by as readonly unknown[]) {
      if (isColumnArg(arg) && side === undefined && (arg.column === 'keys' || arg.column === 'values')) side = arg.column;
      else if (isOrderArg(arg) && dir === undefined && (arg.order === 'asc' || arg.order === 'desc')) dir = arg.order;
      else return null;
    }
    comparators.push({ ...(side ? { side } : {}), dir: dir ?? 'asc' });
  }
  return comparators;
}

/** A bare `order`/`dedup(Scope.local)` step — or an `order(Scope.local)` modulated only by map-ENTRY
 *  comparators (`by(Column.values)`) — and its position. Any other modulated or non-local form is not this
 *  barrier's — it falls to the inline fold. Shape-agnostic here; the nested-vs-flat, scalar-vs-element and
 *  list-vs-map decisions are the head's descriptor, read at build time where the prefix is lowered.
 *
 *  `from` skips the steps before it: an ENTRY-modulated `order(local)` is only CONDITIONALLY this
 *  barrier's (a map head), so where its head turns out not to be a map the step is the inline fold's
 *  after all, and `segmentPlan` resumes the scan past it — exactly where a scan that never claimed it
 *  would have looked. */
export function orderDedupBarrierIn(
  steps: readonly IRStep[], from = 0,
): { at: number; op: 'order' | 'dedup'; comparators: readonly EntryComparator[] } | null {
  for (let at = from; at < steps.length; at++) {
    const step = steps[at]!;
    if ((step.name !== 'order' && step.name !== 'dedup') || !isLocalScope(step)) continue;
    const comparators = step.name === 'order' ? entryComparators(step) : step.modulators?.length ? null : [];
    if (!comparators) continue;
    // `dedup(Scope.local)` carries only the scope arg; a LABEL tuple (`dedup('a','b')`) is a different
    // question this barrier does not serve.
    if (step.name === 'dedup' && step.args.some((a) => !isScopeArg(a.value))) continue;
    return { at, op: step.name, comparators };
  }
  return null;
}

export function buildOrderDedupSegment(
  steps: readonly IRStep[], at: number, op: 'order' | 'dedup', lowering: Lowering,
  comparators: readonly EntryComparator[] = [], planTail?: PlanTail,
): SegmentPlan | null {
  // A MAP traverser: `order(Scope.local)` re-sorts ITS ENTRIES (`orderMapLocalValue`) and the map
  // re-enters under the self-describing map framing (`inject($map)`'s shape) — the per-row twin of the
  // global map-stream sort below, reading the same `mapValue` head. `dedup(Scope.local)` over a map is not
  // this barrier's (a `Map` is not the `Iterable` `DedupLocalStep` takes), so it declines.
  if (op === 'order') {
    const maps = buildValueTransformSegment(steps, at, lowering, orderMapLocalValue(comparators),
      (pairs, s, from, opts) => lowerMapResumeOf(pairs, s, from, opts), op, mapHead, lowering,
      planTail && ((sorted) => planTail(steps.slice(at + 1), mapSeed(sorted))));
    if (maps) return maps;
  }
  // An ENTRY comparator over anything but a map is not this barrier's question.
  if (comparators.length) return null;
  // The head decides nested-vs-flat and scalar-vs-element. A bare `value` head is a scalar stream (decline
  // → the inline path handles a scalar `order`/`dedup`); a `jsonbList` head whose MEMBERS are scalars is a
  // FLAT list (decline → inline). Only a `jsonbList` whose members are a `list`/`map` (a NESTED list) is
  // this barrier's — the ORDERABILITY-recursive case SQL cannot do.
  //
  // The head is built as a RAW-ELEMENT read (`rawListElements`): any element members frame as their stored
  // rowids, not `{id,label,props}` objects, so an element-membered nested list can round-trip through JS and
  // re-source afterwards. For a scalar-membered list this is byte-identical (`demoteElementLeaves` is a
  // no-op), so the established scalar path is unchanged.
  const headOpts: Lowering = { ...lowering, rawListElements: true };
  const head = valueHead(lowerToRel(steps.slice(0, at), headOpts));
  if (!head || head.shape.kind !== 'jsonbList') return null;
  const of = head.shape.items;
  if (of.kind !== 'list' && of.kind !== 'map') return null;
  if (hasElementLeaf(of)) {
    // ELEMENT members round-trip ONLY as base-graph rowids. A federated/merged source re-sources a landed
    // key via `BoundGraph`, which the barrier resume (BaseGraph by default) does not thread yet; and a
    // `property`/`mixed`-element leaf has no recoverable rowid. Both fail closed — never a wrong answer.
    if (lowering.source || lowering.mergedGraphs?.length) return null;
    if (!recoverableElements(of)) return null;
  }
  const transform = op === 'order' ? orderLocalValue : dedupLocalValue;
  // Re-inject each transformed list under the pre-barrier list shape. `head.shape.items` IS the outer
  // list's ORIGINAL MEMBER descriptor (element leaves intact — the head demoted them only for its SQL, not
  // its `Shape`), and `lowerListResumeOf` frames the resumed list as `{kind:'list', of}` — the exact
  // pre-barrier framing, since `order`/`dedup` only reorder/collapse the outer members. Element members
  // re-source from their carried rowids (`unfoldList`'s `elem` arm), so a following `unfold()`/read/
  // movement re-reads them correctly, materializing at the edge. The resume uses the plain `lowering` (no
  // `rawListElements`) so that terminal read frames elements to objects for the wire.
  return buildValueTransformSegment(steps, at, lowering, transform,
    (lists, s, from, opts) => lowerListResumeOf(of, lists, s, from, opts), op, valueHead, headOpts,
    planTail && ((transformed) => planTail(steps.slice(at + 1), listSeed(of, transformed))));
}

// ---------- order() (GLOBAL) whose KEY SQL cannot compare, as a RANK barrier ----------
//
// The general form of the stream barrier below (`ranked-order.ts` holds the why): the head reads every
// traverser's ORDERABILITY key, JS ranks the keys, and the resume re-lowers the WHOLE chain joining each
// traverser to its rank — so a `by()` key and the carried channels (an alias, the path) both survive,
// which a value re-inject cannot give. Asked only where the ordinary lowering already failed
// (`rankedOrderPlan`), so no chain SQL could answer changes plan.

/** A plan, or `null` where planning DECLINED — `planOf` raises `ResumeGap` for an uncoverable resume (its
 *  callers have already run a head), which at compile time, before any head has run, is simply a decline.
 *  ONLY that: any other throw is a defect in the lowering, and swallowing it into a decline would hide it
 *  behind an `UnsupportedTraversal`. */
function plansOrNull(plan: () => Plan | null): Plan | null {
  try {
    return plan();
  } catch (error) {
    if (error instanceof ResumeGap) return null;
    throw error;
  }
}

/**
 * A ranked-order SEGMENT over the first top-level GLOBAL `order()` that `lowering` does not already rank
 * and whose head finds a key SQL could not compare, or `null`. `planRest` plans the WHOLE chain under the
 * extended ranking — itself possibly another ranked segment, so a chain with two such `order()`s ranks
 * one per barrier. A resume `planRest` cannot cover RAISES: the head has already run.
 */
export function buildRankedOrderSegment(
  steps: readonly IRStep[], lowering: Lowering, planRest: (lowering: Lowering) => Plan | null,
): SegmentPlan | null {
  const ranked = lowering.rankedOrders ?? new Map();
  for (let at = 0; at < steps.length; at++) {
    const step = steps[at]!;
    if (step.name !== 'order' || isLocalScope(step) || ranked.has(step)) continue;
    const keyed = lowerRankHead(steps.slice(0, at + 1), lowering, step);
    if (!keyed) continue;
    const head = finishLowering(keyed.head);
    if (head.kind !== 'read') continue;
    // One bind per ranked step, named by its position in the ranking so two ranked `order()`s in one
    // plan never share a parameter.
    const param = compilerParamName(`order_rank_${ranked.size}`);
    const under = (ranks: readonly (readonly [string, number])[]): Lowering =>
      ({ ...lowering, rankedOrders: new Map([...ranked, [step, { kind: 'ranks', ranks, param }]]) });
    // DECLINE NOW rather than raise after the head has run: the resume's plan does not depend on the
    // rank VALUES (they are one bind), so planning the rest over an empty ranking is the same plan the
    // resume will build. A chain whose rest cannot be planned (a step after the `order()` nothing lowers)
    // stays the ordinary `UnsupportedTraversal` instead of a resume error.
    if (!plansOrNull(() => planRest(under([])))) continue;
    return {
      kind: 'segment',
      mode: 'sync',
      head,
      resume: (headRows: readonly BarrierInput[]): Plan => {
        const ranks = rankKeys(headRows.map((row) => row.injectedValue), keyed.dirs);
        const plan = planRest(under(ranks));
        if (!plan) throw new ResumeGap('order() barrier resume: no lowering covers the traversal after order()');
        return plan;
      },
    };
  }
  return null;
}

// ---------- order() (GLOBAL) over a STREAM OF LISTS, as a whole-stream value-transform BARRIER ----------
//
// A bare GLOBAL `order()` (identity comparator, no `by()`) over a stream whose TRAVERSERS are LISTS sorts
// the stream by TinkerPop's ORDERABILITY — a total order that compares two lists element-wise and RECURSES
// into nested collections (`orderability.ts`), which recursion-free SQL cannot express. So it takes the
// same sync value-transform barrier `order(Scope.local)` uses, only the transform reads the WHOLE stream
// at once (`orderStreamValue`) rather than each list in isolation: the SQL head reads one list per
// traverser, one batched JS sort reorders the array, and `lowerListResumeOf` re-injects the lists in the
// sorted order (the array position IS the emission order).
//
// It fires for a LIST stream (a `jsonbList` head) — including an ELEMENT-membered one, carried as rowids
// exactly as the `Scope.local` barrier above does (`rawListElements`, re-source at the edge) — and a MAP
// stream (a `mapValue` head — a map orders by its sorted entry-set, `orderMapStreamValue`). It DECLINES (→
// the inline SQL fold, which already covers these, or fail-closed):
//  - a SCALAR stream (`values('age').order()`) — a plain `value` head SQLite orders by storage class;
//  - a non-recoverable element leaf (`property`/`mixed`-element) or a FEDERATED/merged source — same
//    fail-closed reasons as the `Scope.local` barrier (no recoverable rowid / BoundGraph re-source not
//    threaded).
// Global `dedup()` is NOT this barrier's: the inline list RowShape already collapses a stream of lists.

/** A bare GLOBAL `order()` step (no `Scope.local`, no `by()`, no option arms), and its position — the
 *  whole-stream orderability sort. Shape-agnostic here; the scalar-vs-list-vs-element decision is the
 *  head's descriptor, read at build time. A modulated order is the inline path's job. */
export function orderGlobalBarrierIn(steps: readonly IRStep[]): { at: number } | null {
  for (let at = 0; at < steps.length; at++) {
    const step = steps[at]!;
    if (step.name !== 'order' || isLocalScope(step)) continue;
    if (step.modulators?.length || step.optionArms) continue;
    if (step.args.some((a) => !isScopeArg(a.value))) continue;
    return { at };
  }
  return null;
}

export function buildOrderGlobalSegment(
  steps: readonly IRStep[], at: number, lowering: Lowering, planTail?: PlanTail,
): SegmentPlan | null {
  // The head decides list-vs-map-vs-scalar. A `jsonbList` head carries one list per traverser (LIST
  // stream); a `mapValue` head one map (MAP stream). A scalar `value` head is the SQL path's (SQLite
  // orders scalars by storage class), so both `valueHead` and `mapHead` decline it here.
  //
  // Built RAW (`rawListElements`) like the `Scope.local` head: element members frame as rowids so an
  // element-membered list stream round-trips; byte-identical for a scalar stream, and inert for the MAP
  // branch (the flag only touches list framing).
  const headOpts: Lowering = { ...lowering, rawListElements: true };
  const lowered = lowerToRel(steps.slice(0, at), headOpts);
  const tail = steps.slice(at + 1);
  // `nest` re-plans the tail rooted at the re-injected (sorted) values, so a barrier the tail holds — a
  // `fold().asString(local)` after a map order — is reached (the fold path having declined it). Only where
  // `segmentPlan` supplied a `planTail`; the re-inject shape is the same seed the resume uses.
  const listHead = valueHead(lowered);
  if (listHead && listHead.shape.kind === 'jsonbList') {
    const of = listHead.shape.items;
    // ELEMENT members round-trip ONLY as recoverable base-graph rowids — same fail-closed gate as the
    // `Scope.local` barrier: a `property`/`mixed`-element leaf has no rowid, and a federated/merged source
    // re-sources via `BoundGraph` (not the resume's BaseGraph default) which is not threaded yet.
    if (hasElementLeaf(of)) {
      if (lowering.source || lowering.mergedGraphs?.length) return null;
      if (!recoverableElements(of)) return null;
    }
    // Re-inject each list under the pre-barrier member shape (element leaves intact — the head demoted them
    // only for its SQL), unchanged — a global `order()` only reorders the stream, not any list's contents.
    // A following list op reads the members correctly (element members re-source from their rowids).
    return buildValueStreamTransformSegment(steps, at, lowering, orderStreamValue,
      (lists, s, from, opts) => lowerListResumeOf(of, lists, s, from, opts), 'order', valueHead,
      planTail && ((sorted) => planTail(tail, listSeed(of, sorted))), headOpts);
  }
  // A MAP stream: sort by the sorted-entry-set order (`orderMapStreamValue`) and re-inject each map's pairs
  // array under the self-describing map framing (`inject($map)`'s shape).
  if (mapHead(lowered)) {
    return buildValueStreamTransformSegment(steps, at, lowering, orderMapStreamValue,
      (maps, s, from, opts) => lowerMapResumeOf(maps, s, from, opts), 'order', mapHead,
      planTail && ((sorted) => planTail(tail, mapSeed(sorted))), headOpts);
  }
  return null;
}
