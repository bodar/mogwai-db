import { asNumberBare } from '../../gremlin/coerce.ts';
import type { IRStep } from '../ir/step.ts';
import type { SegmentPlan } from '../segment.ts';
import { buildValueTransformSegment, valueHead } from './barrier-value.ts';
import { lowerToRel, lowerValueResume, type Lowering } from './lower.ts';

// ---------- bare asNumber()/asBool() over a per-row stream — a value-transform barrier ----------
//
// Bare `asNumber()` declines over a RUNTIME value stream for ONE structural reason: the value could be a
// string that does not parse, and `AsNumberStep` must RAISE TinkerPop's exact `Can't parse …` — which SQL
// cannot do per row (`transform.ts` handles only the STATICALLY-typed cases, `scalarTail`; `inject()`
// literals fold at compile time, `coerce.ts foldConstantCoercions`). So `values(k).asNumber()` escapes to
// JS in the SAME sync value-transform barrier reverse()/split()/order/asString use (`barrier-value.ts`):
// the coercion runs in JS, where it CAN raise, reusing `coerce.ts` verbatim so the runtime and const-fold
// paths cannot get an overflow boundary or a message apart.
//
// SELECTIVITY — claim only a PER_ROW head (`values(k)`, a stored property whose type rides per row): that
// is precisely where `scalarTail` declines. A STATIC-typed stream (a preceding cast) `scalarTail` already
// answers in SQL (bare `asNumber()` over a numeric/datetime tag is identity), and an inject/UNKNOWN source
// is const-fold's — so neither is claimed, and the barrier's segment cost is spent only where SQL has no
// answer at all. `asNumber(GType.X)` is a SQL CAST (`transform.ts`) and is never claimed.
//
// `asBool()` is deliberately NOT here: every corpus `asBool` is an `inject()` literal (const-fold), so a
// per-row asBool has no coverage — and the barrier re-injects UNKNOWN, which frames a JS boolean back as
// the INTEGER `json_each` stores it (0/1) rather than a Boolean. That is a wrong wire type, so per-row
// asBool stays a fail-closed decline until a TYPED value-resume (STATIC('boolean')) is built for it.

/** The per-value JS coercion for a claimable cast, or `null` if the step is not one. `asNumberBare` is
 *  `coerce.ts`'s own const-fold coercion — the same authority, so a runtime `values()` cast and an
 *  `inject()` one raise the identical message. A null value is `AsNumberStep.map`'s early `return null`
 *  (never a parse). */
function castCoercion(step: IRStep): ((value: unknown) => unknown) | null {
  if (step.modulators?.length || step.optionArms) return null;
  if (step.name === 'asNumber' && step.args.length === 0)
    return (value) => (value === null || value === undefined ? null : asNumberBare(value, null).val);
  return null;
}

/** The FIRST bare `asNumber()`/`asBool()` over a PER_ROW scalar stream, and its position — lowered here,
 *  not just in the builder, so a cast the fold owns (a STATIC-typed or inject one) never claims the
 *  boundary and preempts a later barrier. */
export function castBarrierIn(steps: readonly IRStep[], lowering: Lowering): { at: number } | null {
  for (let at = 0; at < steps.length; at++) {
    if (!castCoercion(steps[at]!)) continue;
    const head = valueHead(lowerToRel(steps.slice(0, at), lowering));
    if (head?.shape.kind === 'value' && head.shape.type.kind === 'perRow') return { at };
  }
  return null;
}

/** Plan a bare cast as a sync value-transform barrier, or `null` to decline. */
export function buildCastSegment(steps: readonly IRStep[], at: number, lowering: Lowering): SegmentPlan | null {
  const coerce = castCoercion(steps[at]!);
  if (!coerce) return null;
  return buildValueTransformSegment(steps, at, lowering, coerce, lowerValueResume, steps[at]!.name);
}
