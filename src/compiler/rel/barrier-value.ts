import type { Step } from '../../gremlin/frontend.ts';
import type { BarrierInput } from '../../services/spi/types.ts';
import type { Compiled } from '../../sql/kernel/render.ts';
import { ResumeGap, type Plan, type SegmentPlan } from '../segment.ts';
import { lowerToRel, type Lowering, type RelLowering } from './lower.ts';
import { finishLowering } from './spine.ts';

// ---------- the value-transform BARRIER shell — shared by reverse()/split()/regex ----------
//
// A value-transform barrier is substrate A's SYNC shape (`docs/archive/2026-08-21-barrier-substrate-design.md`):
// a SQL head reads the candidate VALUES, a single batched JS transform runs over them, and the
// survivors re-inject as one `json_each` bind that seeds the resumed stream — the traversal stays
// compiled on both sides of one opaque set-transform. `reverse()`, `split()` and the regex `has()`
// barrier all open the same way (lower the prefix to a scalar `value` read); reverse/split also share
// the whole resume shape (transform each value, re-inject, raise if the tail is uncovered), which is
// what `buildValueTransformSegment` is. regex keeps its own resume (a `within(<survivors>)` re-inject
// with a trigram prefilter) and shares only `valueHead`.

/** The head of a value-transform barrier: the lowered prefix, IF it is a scalar `value` read (reverse/
 *  split/regex over a scalar stream) OR a `jsonbList` read (a `order`/`dedup(Scope.local)` whose head is a
 *  LIST-framed stream — `readSegmentHead` delivers the parsed list as `injectedValue`); else `null` so the
 *  caller declines and the fold lowers the step its own way (no regression). */
export function valueHead(lowered: RelLowering | null): Compiled | null {
  if (!lowered) return null;
  const head = finishLowering(lowered);
  return head.kind === 'read' && (head.shape.kind === 'value' || head.shape.kind === 'jsonbList') ? head : null;
}

/** The head of a MAP-stream value-transform barrier: the lowered prefix IF it is a `mapValue` read (a
 *  global `order()` over a map stream — `readSegmentHead` delivers each map's pairs array as
 *  `injectedValue`); else `null`. Kept separate from `valueHead` so `reverse()`/`split()` (whose
 *  transforms are string/list, not map) never accept a map head. */
export function mapHead(lowered: RelLowering | null): Compiled | null {
  if (!lowered) return null;
  const head = finishLowering(lowered);
  return head.kind === 'read' && head.shape.kind === 'mapValue' ? head : null;
}

/**
 * Plan a SYNC value-transform barrier — the whole of `reverse()`/`split()`. The head is the value
 * stream up to `at`; `transform` maps each head value in JS; the results re-inject through `resume`
 * (`lowerValueResume`/`lowerListResume`), which lowers the resumed tail. Declines (`null`) when the head
 * is not a scalar `value` read. The resume RAISES `<label>() barrier resume: …` when the tail is
 * uncovered — a computed value stream cannot decline silently, so it names the failure.
 */
export function buildValueTransformSegment(
  steps: readonly Step[], at: number, lowering: Lowering,
  // `text` is the head's JSON text for a collection head (`BarrierInput.injectedText`) — a transform that
  // COMPARES or RENDERS members reads it exactly (`parseExactJson`); one that only reshapes ignores it.
  transform: (value: unknown, text?: string, type?: string | null) => unknown,
  resume: (values: readonly unknown[], steps: readonly Step[], from: number, opts: Lowering) => RelLowering | null,
  label: string,
  headOf: (lowered: RelLowering | null) => Compiled | null = valueHead,
  // The head lowers under `headOpts` (the resume always uses the plain `lowering`) so a barrier can build
  // its HEAD with an option the RESUME must not inherit — `order`/`dedup(Scope.local)`'s `rawListElements`,
  // which frames element members as rowids for the round-trip but must NOT reach the resume's wire read.
  headOpts: Lowering = lowering,
  // Re-plan the tail as a NESTED segment rooted at the transformed values where the fold path cannot
  // (the tail holds ANOTHER barrier — `order(local).by(values).order(local).by(keys)`). The stream
  // shell's `nest`, for the per-row shell.
  nest?: (transformed: readonly unknown[]) => Plan | null,
): SegmentPlan | null {
  const head = headOf(lowerToRel(steps.slice(0, at), headOpts));
  if (!head || !resumable(steps, at, lowering, resume, nest)) return null;
  return {
    kind: 'segment',
    mode: 'sync',
    head,
    resume: (headRows: readonly BarrierInput[]): Plan => {
      const transformed = headRows.map((row) => transform(row.injectedValue, row.injectedText, row.injectedType));
      const resumed = resume(transformed, steps, at + 1, lowering);
      if (resumed) return { kind: 'sql', compiled: finishLowering(resumed) };
      const nested = nest?.(transformed);
      if (nested) return nested;
      throw new ResumeGap(`${label}() barrier resume: no lowering covers the traversal after ${label}()`);
    },
  };
}

/**
 * Plan a SYNC value-transform barrier whose transform reads the WHOLE STREAM at once — a global
 * `order()`/`dedup()` over a collection stream, where reordering or collapsing a traverser needs to see
 * its neighbours (`buildValueTransformSegment`'s per-row map cannot). `streamTransform` takes the array of
 * head values (one per traverser, in stream order) and returns the surviving values in emission order;
 * `resume` re-injects them (`lowerListResumeOf`), the sorted/collapsed array position becoming the output
 * stream order. Same head, decline and raise-on-uncovered-tail contract as the per-row shell.
 */
export function buildValueStreamTransformSegment(
  steps: readonly Step[], at: number, lowering: Lowering,
  // `texts[i]` is `values[i]`'s head JSON text (`BarrierInput.injectedText`) — see the per-row shell.
  streamTransform: (values: readonly unknown[], texts: readonly (string | undefined)[]) => readonly unknown[],
  resume: (values: readonly unknown[], steps: readonly Step[], from: number, opts: Lowering) => RelLowering | null,
  label: string,
  headOf: (lowered: RelLowering | null) => Compiled | null = valueHead,
  nest?: (transformed: readonly unknown[]) => Plan | null,
  // The head lowers under `headOpts`, the resume always under the plain `lowering` — a global `order()`
  // over an element-membered list stream builds its HEAD with `rawListElements` (element members framed as
  // rowids for the round-trip) which the RESUME's wire read must not inherit. See the per-row shell.
  headOpts: Lowering = lowering,
): SegmentPlan | null {
  const head = headOf(lowerToRel(steps.slice(0, at), headOpts));
  if (!head || !resumable(steps, at, lowering, resume, nest)) return null;
  return {
    kind: 'segment',
    mode: 'sync',
    head,
    resume: (headRows: readonly BarrierInput[]): Plan => {
      const transformed = streamTransform(headRows.map((row) => row.injectedValue), headRows.map((row) => row.injectedText));
      // The fold path first (the common case — a plain SQL tail). It declines (null) only when the tail
      // holds ANOTHER barrier, which the ordinary fold cannot lower; `nest` then re-plans the tail as a
      // NESTED segment rooted at the re-injected values (§ Lowering.seed) — `order().fold().asString(local)`.
      const resumed = resume(transformed, steps, at + 1, lowering);
      if (resumed) return { kind: 'sql', compiled: finishLowering(resumed) };
      const nested = nest?.(transformed);
      if (nested) return nested;
      throw new ResumeGap(`${label}() barrier resume: no lowering covers the traversal after ${label}()`);
    },
  };
}

/**
 * Can the resume be planned at all — asked at COMPILE time, before any head has run, so a tail no lowering
 * covers DECLINES (the ordinary `UnsupportedTraversal`) instead of raising after the head's statement.
 * Planning over ZERO values is the very plan the resume builds: every re-injected seed crosses as ONE
 * `json_each` bind (`valueSeed`/`listSeed`/`mapSeed`, `lower.ts`), so the plan's shape is independent of
 * the values the transform computes. The ranked-order barrier asks the same question of its rest
 * (`buildRankedOrderSegment`). Only a `ResumeGap` is a decline; any other throw is a lowering defect.
 */
function resumable(
  steps: readonly Step[], at: number, lowering: Lowering,
  resume: (values: readonly unknown[], steps: readonly Step[], from: number, opts: Lowering) => RelLowering | null,
  nest?: (transformed: readonly unknown[]) => Plan | null,
): boolean {
  if (resume([], steps, at + 1, lowering)) return true;
  try {
    return !!nest?.([]);
  } catch (error) {
    if (error instanceof ResumeGap) return false;
    throw error;
  }
}
