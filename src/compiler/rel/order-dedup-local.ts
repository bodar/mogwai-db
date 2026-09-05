import { isScopeArg } from '../../gremlin/frontend.ts';
import { isLocalScope } from '../ir/step.ts';
import type { IRStep } from '../ir/strategies.ts';
import type { ListOf } from '../../sql/kernel/render.ts';
import type { Plan, SegmentPlan } from '../segment.ts';
import type { FramedRel } from './framing.ts';
import type { Minter } from './build.ts';
import { listSeed, lowerListResumeOf, lowerMapResumeOf, lowerToRel, mapSeed, type Lowering } from './lower.ts';
import { buildValueStreamTransformSegment, buildValueTransformSegment, mapHead, valueHead } from './barrier-value.ts';

/** Re-plan a value-transform barrier's resume TAIL as a nested segment rooted at the re-injected values
 *  (`Lowering.seed`) — supplied by `segmentPlan`, which holds the `SegmentRequest` `planOf` needs. `null`
 *  where the tail holds no further barrier or none covers it; the caller then raises its resume error. */
export type PlanTail = (tail: readonly IRStep[], seed: (fresh: Minter) => FramedRel) => Plan | null;
import { dedupLocalValue, orderLocalValue, orderMapStreamValue, orderStreamValue } from './orderability.ts';

// ---------- order/dedup(Scope.local) over a NESTED list, as a value-transform BARRIER ----------
//
// A BARE `order(Scope.local)` / `dedup(Scope.local)` (identity comparator) over a list whose members are
// themselves collections sorts/dedups by TinkerPop's ORDERABILITY — which is RECURSIVE (lexicographic over
// lists, order-independent over sets/maps), a shape recursion-free SQL cannot express and a JS comparator
// transcribes directly (`orderability.ts`). So it takes the SAME sync value-transform barrier `reverse()`/
// `split()`/regex use: a SQL head reads the nested lists, one batched JS `orderLocalValue`/`dedupLocalValue`
// runs over them, and `lowerListResumeOf` re-injects each transformed list under its member shape.
//
// It fires ONLY for a nested list whose leaf members are SCALARS (or nested scalar lists/maps). It DECLINES:
//  - a FLAT list (scalar/element members) → the INLINE `listMemberOp` lowering (cheaper, `by()` supported);
//  - an ELEMENT-membered nested list — a `Map<K,List<vertex>>` value ordered whole — because the barrier
//    ships MATERIALIZED vertex objects to JS (the rowid is gone once they round-trip through JSON), so the
//    result cannot re-enter the graph (`order(local).unfold().out()`). That needs federate-grade detached-
//    element substrate; a rare, non-corpus shape, so it stays a clean fail-closed decline (never a wrong
//    answer). A MODULATED order/dedup declines too (a non-identity `by()` is the inline path's job).

/** Does this member tree reach an ELEMENT leaf anywhere? An `elem` member (at any nesting depth) is the
 *  case the barrier cannot round-trip, so it declines. `property` is the element family's third kind. */
function hasElementLeaf(of: ListOf): boolean {
  if (of.kind === 'elem' || of.kind === 'property') return true;
  if (of.kind === 'list') return hasElementLeaf(of.of);
  if (of.kind === 'mixed') return of.arms.some((arm) => arm.kind === 'elem');
  return false;
}

/** A bare `order`/`dedup(Scope.local)` step, and its position. Modulated or non-local forms are not this
 *  barrier's — they fall to the inline fold. Shape-agnostic here; the nested-vs-flat and scalar-vs-element
 *  decisions are the head's member descriptor, read at build time where the prefix is lowered. */
export function orderDedupBarrierIn(steps: readonly IRStep[]): { at: number; op: 'order' | 'dedup' } | null {
  for (let at = 0; at < steps.length; at++) {
    const step = steps[at]!;
    if ((step.name !== 'order' && step.name !== 'dedup') || !isLocalScope(step)) continue;
    if (step.modulators?.length) continue;
    // `dedup(Scope.local)` carries only the scope arg; a LABEL tuple (`dedup('a','b')`) is a different
    // question this barrier does not serve.
    if (step.name === 'dedup' && step.args.some((a) => !isScopeArg(a.value))) continue;
    return { at, op: step.name };
  }
  return null;
}

export function buildOrderDedupSegment(
  steps: readonly IRStep[], at: number, op: 'order' | 'dedup', lowering: Lowering,
): SegmentPlan | null {
  // The head decides nested-vs-flat and scalar-vs-element. A bare `value` head is a scalar stream (decline
  // → the inline path handles a scalar `order`/`dedup`); a `jsonbList` head whose MEMBERS are scalars is a
  // FLAT list (decline → inline). Only a `jsonbList` whose members are a `list`/`map` (a NESTED list) with
  // NO element leaf is this barrier's — the ORDERABILITY-recursive case SQL cannot do and the barrier can
  // round-trip (see the element decline above).
  const head = valueHead(lowerToRel(steps.slice(0, at), lowering));
  if (!head || head.shape.kind !== 'jsonbList') return null;
  const of = head.shape.items;
  if (of.kind !== 'list' && of.kind !== 'map') return null;
  if (hasElementLeaf(of)) return null;
  const transform = op === 'order' ? orderLocalValue : dedupLocalValue;
  // Re-inject each transformed list under the pre-barrier list shape. `head.shape.items` IS the outer
  // list's MEMBER descriptor, and `lowerListResumeOf` frames the resumed list as `{kind:'list', of}` — the
  // exact pre-barrier framing, since `order`/`dedup` only reorder/collapse the outer members and leave each
  // member unchanged (round-tripped through JSON as a self-describing node). A following `unfold()`/member
  // op then re-reads the members correctly.
  return buildValueTransformSegment(steps, at, lowering, transform,
    (lists, s, from, opts) => lowerListResumeOf(of, lists, s, from, opts), op);
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
// It fires for a LIST stream (a `jsonbList` head, no element leaf) and a MAP stream (a `mapValue` head — a
// map orders by its sorted entry-set, `orderMapStreamValue`). It DECLINES (→ the inline SQL fold, which
// already covers these):
//  - a SCALAR stream (`values('age').order()`) — a plain `value` head SQLite orders by storage class;
//  - an element-membered list — the barrier ships MATERIALIZED elements to JS (the rowid is gone once they
//    round-trip through JSON), so the result cannot re-enter the graph. A rare, non-corpus shape, so it
//    stays a clean fail-closed decline (never a wrong answer).
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
  const lowered = lowerToRel(steps.slice(0, at), lowering);
  const tail = steps.slice(at + 1);
  // `nest` re-plans the tail rooted at the re-injected (sorted) values, so a barrier the tail holds — a
  // `fold().asString(local)` after a map order — is reached (the fold path having declined it). Only where
  // `segmentPlan` supplied a `planTail`; the re-inject shape is the same seed the resume uses.
  const listHead = valueHead(lowered);
  if (listHead && listHead.shape.kind === 'jsonbList') {
    const of = listHead.shape.items;
    // An element leaf cannot round-trip (see the decline note above).
    if (hasElementLeaf(of)) return null;
    // Re-inject each list under the pre-barrier member shape, unchanged — a global `order()` only reorders
    // the stream, not any list's contents. A following list op reads the members correctly.
    return buildValueStreamTransformSegment(steps, at, lowering, orderStreamValue,
      (lists, s, from, opts) => lowerListResumeOf(of, lists, s, from, opts), 'order', valueHead,
      planTail && ((sorted) => planTail(tail, listSeed(of, sorted))));
  }
  // A MAP stream: sort by the sorted-entry-set order (`orderMapStreamValue`) and re-inject each map's pairs
  // array under the self-describing map framing (`inject($map)`'s shape).
  if (mapHead(lowered)) {
    return buildValueStreamTransformSegment(steps, at, lowering, orderMapStreamValue,
      (maps, s, from, opts) => lowerMapResumeOf(maps, s, from, opts), 'order', mapHead,
      planTail && ((sorted) => planTail(tail, mapSeed(sorted))));
  }
  return null;
}
