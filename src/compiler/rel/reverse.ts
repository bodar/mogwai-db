import type { Step } from '../../gremlin/frontend.ts';
import type { SegmentPlan } from '../segment.ts';
import { lowerToRel, lowerValueResume, type Lowering } from './lower.ts';
import { buildValueTransformSegment, valueHead } from './barrier-value.ts';

// ---------- reverse() as a value-transform BARRIER — substrate A ----------
//
// `reverse()` reverses a string char-by-char, reverses a list, and is identity for null and everything
// else (`vendor/tinkerpop/gremlin-core/.../step/map/ReverseStep.java:49-65`). SQLite has no `reverse`
// scalar function, and the shape it CAN be given — a per-row recursive CTE that peels one character at a
// time — is a large, slow, string-only statement (measured ~882 B of SQL and a recursive subquery PER
// ROW, ~2× the runtime and ~2× the compile of the barrier, and it silently passes lists through where
// the reference reverses them).
//
// So reverse lowers instead as substrate A's VALUE-TRANSFORM barrier (`docs/2026-08-21-barrier-substrate-
// design.md`), the same shape as regex: a SYNC barrier over the value stream. The head is the value
// stream up to `reverse()`; the transform reverses each value in trivial JS (correct for strings AND
// lists, and identity otherwise); the survivors — here, the transformed values — re-inject through
// `lowerValueResume` as ONE `json_each` bind that seeds the resumed stream. The messy semantics live in
// one line of JS; the SQL is a flat read plus a `json_each` source. It is SYNCHRONOUS (no async work,
// atomic, DO-local — see `compiler/segment.ts`).
//
// Scope today: the SCALAR value stream (strings, and identity for other scalars — everything the CTE
// did, minus the string-only limitation, since JS reverses a scalar list member too). A non-scalar head
// (a list-shaped stream, `fold().reverse()`) DECLINES here and the fold's remaining reverse handling
// takes it — no regression while the list arm is built out.

/** Reverse one traverser value: a string char-by-char (by code point), a list in place, everything else
 *  (null, numbers, …) unchanged — `ReverseStep.map`. */
const reverseValue = (value: unknown): unknown =>
  typeof value === 'string' ? [...value].reverse().join('')
    : Array.isArray(value) ? [...value].reverse()
      : value;

/** THE FIRST `reverse()` in the chain, or `null`. Asked in `segmentPlan` beside the other barrier
 *  finders so the earliest boundary wins. */
export function reverseBarrierIn(steps: readonly Step[]): number | null {
  for (let at = 0; at < steps.length; at++) if (steps[at]!.name === 'reverse') return at;
  return null;
}

/**
 * Plan `reverse()` as a SYNC value-transform barrier, or `null` to decline (the fold then lowers reverse
 * its own way — no regression). The head must be a SCALAR `value` read; the reversed values re-inject as
 * a value stream (`lowerValueResume`). The shared `buildValueTransformSegment` shell is what `split()`
 * uses too — reverse and split differ only in the transform and the resume lowering.
 */
export function buildReverseSegment(steps: readonly Step[], at: number, lowering: Lowering): SegmentPlan | null {
  // `valueHead` now also admits a `jsonbList` head (for the order/dedup barrier), but reverse's resume is
  // SCALAR (`lowerValueResume`), so a LIST-framed `reverse()` must stay on the INLINE `listMemberOp` path
  // (which reverses a list — and a nested list — in place). Decline a non-scalar head here so the fold
  // keeps it, rather than framing the list as its JSON text.
  const head = valueHead(lowerToRel(steps.slice(0, at), lowering));
  if (head && head.shape.kind !== 'value') return null;
  return buildValueTransformSegment(steps, at, lowering, reverseValue, lowerValueResume, 'reverse');
}
