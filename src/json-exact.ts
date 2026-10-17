// ---------- reading SQLite's JSON without rounding a wide number ----------
//
// A JSON text SQLite wrote can hold a number a JS `number` cannot: an INTEGER past 2^53 that no type tag
// told the compile to carry as decimal text (`jsonMemberByTypeof`, `compiler/rel/build.ts` — a `sum()` past
// 2^53 folded inside `local()`, an untyped column). `JSON.parse` rounds it, and every reader downstream then
// answers for a number nobody stored: the wire frames the rounding, ORDERABILITY ties two distinct Longs,
// `dedup(Scope.local)` merges them, a value-transform barrier re-injects the rounding.
//
// The SOURCE TEXT still has it, and it also says which class the number is: SQLite's JSON writer spells
// an INTEGER with no point or exponent and a REAL always with one (`2.7e+19`, `1.0`). So `parseExactJson`
// keeps every integral-valued number past 2^53 as a `JSON.rawJSON(<its source>)` value (ES2025 JSON.parse
// source-text access; Bun's JSC and workerd's V8 both carry it) — a value that re-stringifies EXACTLY, so a
// barrier re-injecting it and a framer recursing through `JSON.stringify` lose nothing — and the readers
// that look INSIDE a value ask `exactNumberOf` what it is. Every other value is `JSON.parse`'s own, and a
// text with no 16-digit run and no exponent cannot hold such a number, so it parses exactly as before.
//
// A raw value is a frozen null-prototype object, so it must be produced on the side of an RPC boundary
// that consumes it: a DO-side head read ships the TEXT (`BarrierInput.injectedText`), and the Worker-side
// transform parses it.

// A number past 2^53 is spelled with a run of 16+ digits, or with an exponent (`2.7e+19`).
const WIDE_DIGITS = /\d{16}|\d[eE]/;
const INTEGRAL = /^-?\d+$/;
const rawJson = JSON as unknown as { rawJSON?: (text: string) => unknown; isRawJSON?: (value: unknown) => boolean };

/** A number `parseExactJson` kept exact, by its source spelling. */
export type ExactNumber = { readonly rawJSON: string };

/** Is this a number `parseExactJson` kept as its source text? */
export const isExactNumber = (value: unknown): value is ExactNumber => rawJson.isRawJSON?.(value) === true;

/** What an exact number IS: an int64 (`integral` — SQLite's INTEGER, a Gremlin `Long`) with its exact
 *  decimal text, or a binary64 spelled with a point/exponent (a `Double`). */
export const exactNumberOf = (value: ExactNumber): { readonly integral: boolean; readonly text: string } =>
  ({ integral: INTEGRAL.test(value.rawJSON), text: value.rawJSON });

/** `JSON.parse`, keeping every integral-valued number past 2^53 exact (see the module comment). Where the
 *  runtime lacks source-text access the number stays `JSON.parse`'s — a reader that compares it then sees
 *  a bare unsafe integer, which ORDERABILITY declines rather than ranks (`orderability.ts`). */
export function parseExactJson(text: string): any {
  if (!rawJson.rawJSON || !WIDE_DIGITS.test(text)) return JSON.parse(text);
  const reviver = (_key: string, value: unknown, context?: { source?: string }): unknown =>
    typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && context?.source !== undefined
      ? rawJson.rawJSON!(context.source) : value;
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}
