import { isScopeArg } from '../../gremlin/frontend.ts';
import { isLocalScope, type IRStep } from '../ir/step.ts';
import type { SegmentPlan } from '../segment.ts';
import { ValueParseError } from '../../gremlin/coerce.ts';
import { lowerToRel, lowerListResume, lowerValueResume, type Lowering } from './lower.ts';
import { buildValueTransformSegment, mapHead, valueHead } from './barrier-value.ts';
import { isBareList } from './list.ts';
import { gremlinString } from './gremlin-string.ts';
import { exactOf } from './orderability.ts';
import { staticTypeOf, type ListOf } from '../../sql/kernel/render.ts';

// ---------- asString() over a COLLECTION — a value-transform barrier ----------
//
// SCALAR `asString()` is a SQL cast (`VALUE_TX`, `transform.ts`), the ELEMENT forms render in SQL
// (`terminal()`/`propertyAsString`, `lower.ts`/`property.ts`), and a SCALAR-membered list under
// `Scope.local` is `list.ts`'s in-SQL member cast. What is left — a MAP traverser, and a list whose
// members are ELEMENTS/MAPS/nested lists — is the shape SQL cannot render (Java's `{k=[v]}`/`[a, b]`
// toString), so it escapes to JS in the SAME sync value-transform barrier `reverse()`/`split()`/order use
// (`barrier-value.ts`). The head reads the collection, `gremlinString` renders it (`gremlin-string.ts`),
// and the strings re-inject.
//
// - **MAP stream, global** (`valueMap(k).asString()`): each map → one string, re-injected as a scalar.
// - **LIST stream, local** (`fold().asString(Scope.local)`): each MEMBER stringified, the list kept — a
//   list of strings re-injected (`lowerListResume`). A null member raises `Can't parse null as String.`
//   (`AsStringLocalStep`).
// - **LIST stream, global** (`fold().asString()`): the whole list → one `[a, b]` string, scalar-injected
//   (`String.valueOf` — a null member renders `null`, NOT a raise: `AsStringGlobalStep` only rejects a
//   null TRAVERSER).
//
// A `mapValue` head delivers each map as its PAIRS array, so a global map render wraps it back into a
// `{t:'map'}` node for `gremlinString`; a `jsonbList` head delivers the parsed member array directly.

/** A LIST MEMBER under `Scope.local` → its string, RAISING on a null member — `AsStringLocalStep.map`
 *  throws `Can't parse null as String.` for a null element (a bare null, or a `{t,v}` leaf whose value is
 *  null). Every non-null member is `String.valueOf`. */
const asStringMember = (member: unknown): string => {
  const leafNull = member !== null && typeof member === 'object'
    && 't' in member && 'v' in member && (member as { v: unknown }).v === null;
  if (member === null || member === undefined || leafNull)
    throw new ValueParseError('Can\'t parse null as String.');
  return gremlinString(member);
};

/**
 * A delivered list MEMBER → the self-describing node `gremlinString` prints, by the list's member SHAPE —
 * the ONE place a member's class is re-attached, recursing through the shape so every depth reads the same
 * rule (`fold().fold()`, a label re-read, a list inside a list inside a list).
 *
 * A scalar member under a STATIC member tag rides BARE — its class is the list's, not its own — so it is
 * re-wrapped in that tag: the renderer prints by class (`Float.toString` of the exact float `0.1f` is
 * `0.1`, a whole Double is `1.0`, a Boolean `true`, a negative zero `-0.0`), where a bare number would read
 * as a Double and a bare 0/1 as a number. A NESTED list member re-attaches its own members' shape one level
 * down. A MAP member arrives as its BARE pairs array (`[[keyNode,valNode],…]`, ambiguous with a plain list),
 * so it is wrapped back into the `{t:'map'}` node the renderer frames as `{k=v}` (its pairs are
 * self-describing). An element (`{id,label}`) or a self-describing (`perRow`/`unknown`) member renders as-is.
 */
function memberNode(of: ListOf): (member: unknown) => unknown {
  switch (of.kind) {
    case 'map': return (member) => ({ t: 'map', v: member });
    case 'list': {
      const inner = memberNode(of.of);
      return (member) => (Array.isArray(member) ? { t: 'list', v: member.map(inner) } : member);
    }
    case 'scalar': {
      const tag = staticTypeOf(of.type);
      return tag === undefined ? (member) => member : (member) => (member === null || member === undefined ? member : { t: tag, v: member });
    }
    default: return (member) => member;
  }
}

/** Does this `asString()` position claim the barrier — a MAP head (global only), or a LIST head that is
 *  NOT the scalar-membered-local case `list.ts` already casts in SQL. Lowered here, not just in the
 *  builder, so a SCALAR or ELEMENT `asString()` (the fold's) never claims the boundary and preempts a
 *  later barrier. */
function claims(step: IRStep, lowering: Lowering, prefix: readonly IRStep[]): boolean {
  if (step.name !== 'asString' || step.modulators?.length || step.optionArms) return false;
  if (step.args.some((a) => !isScopeArg(a.value))) return false;
  const lowered = lowerToRel(prefix, lowering);
  if (mapHead(lowered)) return !isLocalScope(step);
  const head = valueHead(lowered);
  return head?.shape.kind === 'jsonbList' && !(isBareList(head.shape.items) && isLocalScope(step));
}

/** The FIRST `asString()` that claims the barrier, and its position. */
export function asStringBarrierIn(steps: readonly IRStep[], lowering: Lowering): { at: number } | null {
  for (let at = 0; at < steps.length; at++) {
    if (claims(steps[at]!, lowering, steps.slice(0, at))) return { at };
  }
  return null;
}

/**
 * Plan a collection `asString()` as a sync value-transform barrier, or `null` to decline (the fold then
 * lowers it — no regression). The head shape and the `Scope` decide the three arms above.
 */
export function buildAsStringSegment(steps: readonly IRStep[], at: number, lowering: Lowering): SegmentPlan | null {
  const step = steps[at]!;
  const local = isLocalScope(step);
  const lowered = lowerToRel(steps.slice(0, at), lowering);
  if (mapHead(lowered)) {
    if (local) return null;
    // Rendered off the EXACT view of the head text (`exactOf`): `JSON.parse` would print a `sum()` past
    // 2^53 as its rounding, a different number than the one the traverser holds.
    return buildValueTransformSegment(steps, at, lowering,
      (pairs, text) => gremlinString({ t: 'map', v: exactOf(pairs, text) }), lowerValueResume, 'asString', mapHead);
  }
  const head = valueHead(lowered);
  if (head?.shape.kind !== 'jsonbList' || (isBareList(head.shape.items) && local)) return null;
  const nodeOf = memberNode(head.shape.items);
  return local
    ? buildValueTransformSegment(steps, at, lowering,
      (list, text) => (exactOf(list, text) as unknown[]).map((m) => asStringMember(nodeOf(m))), lowerListResume, 'asString')
    : buildValueTransformSegment(steps, at, lowering,
      (list, text) => gremlinString((exactOf(list, text) as unknown[]).map(nodeOf)), lowerValueResume, 'asString');
}
