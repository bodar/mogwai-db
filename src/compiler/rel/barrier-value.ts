import type { Step } from '../../gremlin/frontend.ts';
import type { BarrierInput } from '../../services/spi/types.ts';
import type { Compiled } from '../../sql/kernel/render.ts';
import type { Plan, SegmentPlan } from '../segment.ts';
import { lowerToRel, type Lowering, type RelLowering } from './lower.ts';
import { finishLowering } from './spine.ts';

// ---------- the value-transform BARRIER shell — shared by reverse()/split()/regex ----------
//
// A value-transform barrier is substrate A's SYNC shape (`docs/2026-08-21-barrier-substrate-design.md`):
// a SQL head reads the candidate VALUES, a single batched JS transform runs over them, and the
// survivors re-inject as one `json_each` bind that seeds the resumed stream — the traversal stays
// compiled on both sides of one opaque set-transform. `reverse()`, `split()` and the regex `has()`
// barrier all open the same way (lower the prefix to a scalar `value` read); reverse/split also share
// the whole resume shape (transform each value, re-inject, raise if the tail is uncovered), which is
// what `buildValueTransformSegment` is. regex keeps its own resume (a `within(<survivors>)` re-inject
// with a trigram prefilter) and shares only `valueHead`.

/** The head of a value-transform barrier: the lowered prefix, IF it is a scalar `value` read; else
 *  `null` so the caller declines and the fold lowers the step its own way (no regression). One guard,
 *  three barriers — the `read`+`value` shape they all require. */
export function valueHead(lowered: RelLowering | null): Compiled | null {
  if (!lowered) return null;
  const head = finishLowering(lowered);
  return head.kind === 'read' && head.shape.kind === 'value' ? head : null;
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
  transform: (value: unknown) => unknown,
  resume: (values: readonly unknown[], steps: readonly Step[], from: number, opts: Lowering) => RelLowering | null,
  label: string,
): SegmentPlan | null {
  const head = valueHead(lowerToRel(steps.slice(0, at), lowering));
  if (!head) return null;
  return {
    kind: 'segment',
    mode: 'sync',
    head,
    resume: (headRows: readonly BarrierInput[]): Plan => {
      const transformed = headRows.map((row) => transform(row.injectedValue));
      const resumed = resume(transformed, steps, at + 1, lowering);
      if (!resumed) throw new Error(`${label}() barrier resume: no lowering covers the traversal after ${label}()`);
      return { kind: 'sql', compiled: finishLowering(resumed) };
    },
  };
}
