import { isScopeArg, type Step } from '../../gremlin/frontend.ts';
import { isLocalScope } from '../ir/step.ts';
import type { SegmentPlan } from '../segment.ts';
import { lowerListResume, lowerToRel, type Lowering } from './lower.ts';
import { buildValueTransformSegment, valueHead } from './barrier-value.ts';

// ---------- split() as a value-transform BARRIER — substrate A ----------
//
// `split()` returns a LIST of strings made by splitting the incoming string around the separator
// (`vendor/tinkerpop/gremlin-core/.../step/map/SplitGlobalStep.java:48-59`). It is the value twin of
// `reverse()`: a per-traverser string → list transform SQLite has no scalar function for, so it lowers
// as substrate A's VALUE-TRANSFORM barrier (`docs/2026-08-21-barrier-substrate-design.md`) — the same
// SYNC shape reverse uses. The head is the value stream up to `split()`; the JS transform splits each
// value into a list; the computed lists re-inject through `lowerValueResume` as ONE `json_each` bind
// that seeds the resumed stream (each list a row, framed back as a list by the UNKNOWN scalar tail — the
// exact path `inject(list).reverse()` already travels). The messy Commons-`StringUtils` semantics live
// in one JS function; the SQL is a flat read plus a `json_each` source.
//
// Scope today: the GLOBAL form over a SCALAR `value` stream (strings → lists, null → null, a non-string
// traverser → the reference's `IllegalArgumentException`). `split(Scope.local, sep)` over a LIST
// (`fold().split(local, sep)`) is a member-wise string → LIST transform — a list-of-lists shape the list
// vocabulary does not build yet — and a LIST-shaped head (`inject([...]).split(sep)`, the reference's
// non-string throw) both DECLINE here and fail closed, no regression.

/** The reference whitespace split: Commons `StringUtils.splitByWholeSeparator(s, null)` splits on runs
 *  of whitespace. Committed to JS `\s+` (as the regex barrier commits to JS `RegExp`) — it agrees with
 *  Java on every construct the corpus exercises and diverges only on exotic code points no scenario
 *  uses (Java `Character.isWhitespace` excludes ` `, JS `\s` includes it). */
const JAVA_WHITESPACE = /\s+/;

/** Split one traverser value into a list — `SplitGlobalStep.map` composed with `StringUtil.split`:
 *  null passes through unchanged; a non-string traverser is an error the reference throws; an EMPTY
 *  separator splits into characters (`"ab cd"` → `["a","b"," ","c","d"]`); a NULL separator splits on
 *  whitespace; any other separator is a whole-separator split with the empty tokens adjacent separators
 *  would produce removed (`StringUtils.splitByWholeSeparator`). */
const splitValue = (value: unknown, separator: string | null): unknown => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string')
    throw new Error(`The split() step can only take string as argument, encountered ${value}.`);
  if (separator === '') return value.split('');
  if (separator === null) return value.split(JAVA_WHITESPACE).filter((t) => t !== '');
  return value.split(separator).filter((t) => t !== '');
};

/** THE FIRST GLOBAL `split()` in the chain with its separator, or `null`. The local form
 *  (`split(Scope.local, …)`) is not a barrier and is skipped so the earliest boundary that IS one wins.
 *  The separator is the sole non-scope argument's value — a string or null (a null literal splits on
 *  whitespace, per the reference). */
export function splitBarrierIn(steps: readonly Step[]): { at: number; separator: string | null } | null {
  for (let at = 0; at < steps.length; at++) {
    const step = steps[at]!;
    if (step.name !== 'split' || isLocalScope(step)) continue;
    const sepArg = step.args.find((a) => !isScopeArg(a.value));
    const separator = sepArg?.value ?? null;
    if (separator !== null && typeof separator !== 'string') continue;
    return { at, separator };
  }
  return null;
}

/**
 * Plan `split()` as a SYNC value-transform barrier, or `null` to decline (fail closed — no regression).
 * The head must be a SCALAR `value` read: a LIST-shaped head is the reference's non-string throw case and
 * a shape this barrier does not read, so it declines rather than guess.
 */
export function buildSplitSegment(
  steps: readonly Step[], at: number, separator: string | null, lowering: Lowering,
): SegmentPlan | null {
  // `valueHead` now also admits a `jsonbList` head (the order/dedup barrier), but `split()` reads a SCALAR
  // string (`splitValue` throws on a non-string), so a LIST-framed head must decline here — the reference's
  // non-string throw case is the fold's to raise, not this barrier's to mis-read.
  const head = valueHead(lowerToRel(steps.slice(0, at), lowering));
  if (head && head.shape.kind !== 'value') return null;
  // The value twin of `reverse()` on the shared shell: each string splits into a LIST, so the survivors
  // re-inject through `lowerListResume` (reverse uses `lowerValueResume`). The separator is bound into
  // the per-value transform here.
  return buildValueTransformSegment(steps, at, lowering, (value) => splitValue(value, separator), lowerListResume, 'split');
}
