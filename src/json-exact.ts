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
// The same spelling says which CLASS a WHOLE number is, which `JSON.parse` also throws away: SQLite writes a
// whole REAL as `1.0`, and a negative zero as `-0.0` where the JSON-entry authority spells it
// (`asExactReal`, `compiler/rel/build.ts`), and both parse to a JS integer an untagged reader then frames as
// an Int with the sign gone. Traverser equality is `Objects.equals` — `Integer(1)` is not `Double(1.0)` and
// `Double.equals(-0.0, 0.0)` is false
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/traverser/util/AbstractTraverser.java:185-188`)
// — so an integral-valued number spelled with a point or an exponent is kept raw too, and reads back as the
// Double it is. `stringifyExact` is the writing half: `JSON.stringify(-0)` is `0`, so a compile-time tree
// spells a negative zero `-0.0`, the spelling SQLite's JSON keeps (and keys apart from `0.0`).
//
// A raw value is a frozen null-prototype object, so it must be produced on the side of an RPC boundary
// that consumes it: a DO-side head read ships the TEXT (`BarrierInput.injectedText`), and the Worker-side
// transform parses it.

// A number past 2^53 is spelled with a run of 16+ digits, or with an exponent (`2.7e+19`); a whole Double
// with a point (`1.0`, `-0.0`).
import { binary64OfCarrier, hasExactDecimal, INEXACT_DECIMAL, mayHoldCarrier } from './rel/exact-decimal.ts';
import { RaisedByQuery } from './rel/raise.ts';

const WIDE_DIGITS =/\d{16}|\d[eE]|\d\.0/;
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

/** `JSON.parse`, keeping every integral-valued number past 2^53, and every whole Double, exact (see the module comment). Where the
 *  runtime lacks source-text access the number stays `JSON.parse`'s — a reader that compares it then sees
 *  a bare unsafe integer, which ORDERABILITY declines rather than ranks (`orderability.ts`). */
export function parseExactJson(text: string): any {
  const carried = mayHoldCarrier(text);
  if (!carried && (!rawJson.rawJSON || !WIDE_DIGITS.test(text))) return JSON.parse(text);
  const reviver = (_key: string, value: unknown, context?: { source?: string }): unknown => {
    if (carried) {
      // A whole Double past 2^53 stays a raw exact number spelled with its exponent (every carried value
      // is outside [1e-80, 1e116], so `String` spells a whole one `1e+300`), as SQLite's own `1.0e+300` would.
      const leaf = carriedLeaf(value, (x) => rawJson.rawJSON && Number.isInteger(x) ? rawJson.rawJSON(String(x)) : x);
      if (leaf !== undefined) return leaf;
    }
    return rawJson.rawJSON && typeof value === 'number' && Number.isInteger(value) && context?.source !== undefined
      && (!Number.isSafeInteger(value) || !INTEGRAL.test(context.source))
      ? rawJson.rawJSON(context.source) : value;
  };
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

/** The tags whose `{t,v}` leaf may hold a binary64 wire carrier (`binary64Carrier`, `compiler/rel/build.ts`). */
const BINARY64_TAGS: ReadonlySet<unknown> = new Set(['double', 'float', 'real', 'bigdecimal']);

/** A `{t,v}` leaf whose `v` is a binary64 wire carrier, with `v` read back as the number it carries
 *  (`as` picks that number's JS form); `undefined` for any other value. */
function carriedLeaf(value: unknown, as: (x: number) => unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const node = value as { t?: unknown; v?: unknown };
  if (!BINARY64_TAGS.has(node.t)) return undefined;
  const x = binary64OfCarrier(node.v);
  return x === null ? undefined : { ...node, v: as(x) };
}

/**
 * AN ELEMENT PAYLOAD — one element, a list of them, or an element's property bag (`{key: [{t,v}, …]}`,
 * an edge's `{key: {t,v}}`) — as JSON text or already parsed: the one reader of the wire-only JSON
 * `compiler/rel/element.ts` builds. A binary64 no decimal spelling crosses SQLite exactly rides there as a
 * wire carrier (`binary64Carrier`, `compiler/rel/build.ts`), read back here to the number `JSON.parse`
 * would have produced from its exact spelling; everything else is `JSON.parse`'s own.
 */
export function parseElementJson(json: unknown): any {
  // An ALREADY-PARSED payload is decoded too, so a reader that parsed the text some other way (a list
  // column holding element members, a federated node) can never hand a raw carrier on: the decode is a
  // property of THIS reader, not of whichever parse happened to run first.
  if (typeof json !== 'string') return decodeCarriers(json);
  if (!mayHoldCarrier(json)) return JSON.parse(json);
  return JSON.parse(json, (_key, value: unknown) => {
    const leaf = carriedLeaf(value, (x) => x);
    return leaf === undefined ? value : leaf;
  });
}

/** An already-parsed JSON tree with every binary64 wire carrier leaf read back (`carriedLeaf`) — the
 *  object twin of `parseElementJson`'s reviver. Copy-on-write: a tree holding no carrier comes back as
 *  the SAME object, so the common case allocates nothing. A raw exact number (`parseExactJson`) is a
 *  leaf, never walked into. */
export function decodeCarriers(value: unknown): any {
  if (value === null || typeof value !== 'object' || isExactNumber(value)) return value;
  const leaf = carriedLeaf(value, (x) => x);
  if (leaf !== undefined) return leaf;
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    value.forEach((member, i) => {
      const decoded = decodeCarriers(member);
      if (decoded !== member) (out ??= value.slice())[i] = decoded;
    });
    return out ?? value;
  }
  let out: Record<string, unknown> | null = null;
  for (const [key, member] of Object.entries(value)) {
    const decoded = decodeCarriers(member);
    if (decoded !== member) (out ??= { ...(value as Record<string, unknown>) })[key] = decoded;
  }
  return out ?? value;
}

/** `JSON.stringify`, spelling a negative zero `-0.0` — the writing half of the module rule, for a
 *  compile-time tree headed into SQLite's JSON (a literal map, a stored collection). `null` where the
 *  runtime lacks `JSON.rawJSON` and the tree holds a negative zero: the caller declines rather than write
 *  a zero that lost its sign.
 *
 *  A finite number OUTSIDE the range SQLite reads decimal text exactly in (`rel/exact-decimal.ts`) RAISES the
 *  in-row deferral's own `RaisedByQuery`: JS spells it exactly, but SQLite's JSON reader turns `1.5e-300` into
 *  1.4999999999999998E-300, so the tree would hand every SQL reader of it another number. This is the ONE
 *  writer of a JSON text headed into SQLite, so the rule holds for a literal, a bound set, a barrier's
 *  re-injected values and a retained binding alike. */
export function stringifyExact(value: unknown): string | null {
  let lost = false;
  const text = JSON.stringify(value, (_key, member: unknown) => {
    // A raw exact number is a Double only when spelled with a point or exponent (`exactNumberOf`).
    const raw = isExactNumber(member) ? exactNumberOf(member) : null;
    const number = typeof member === 'number' ? member : raw && !raw.integral ? Number(raw.text) : null;
    if (number !== null && !hasExactDecimal(number)) throw new RaisedByQuery(INEXACT_DECIMAL);
    const spelled = typeof member === 'number' ? exactSpelling(member) : undefined;
    if (spelled === undefined) return member;
    if (rawJson.rawJSON) return rawJson.rawJSON(spelled);
    lost = true;
    return member;
  });
  return lost ? null : text;
}

/** The JSON spelling of a number `JSON.stringify` cannot write — a negative zero (`0`, the sign lost) and
 *  `±Infinity` (`null`, the value lost) — as SQLite's own JSON writer spells it: `-0.0`, and the overflow
 *  literal `9.0e+999` that SQLite's JSON parser reads back as `+Inf` and `json_array(9e999)` itself
 *  writes, so a compile-time tree and a SQL-built one compare equal. A NaN has no JSON spelling at all
 *  (SQLite carries it as NULL — `compiler/rel/const.ts`), so it stays `JSON.stringify`'s. */
function exactSpelling(member: number): string | undefined {
  if (Object.is(member, -0)) return '-0.0';
  if (member === Infinity) return '9.0e+999';
  if (member === -Infinity) return '-9.0e+999';
  return undefined;
}

/** `stringifyExact` for a caller with no decline of its own to fall back on (a bound JSON set, a
 *  retained binding's transport, a compile-time literal blob): a runtime that cannot spell a negative
 *  zero or an infinity REFUSES rather than write another value. Both runtimes we ship on have `JSON.rawJSON`. */
export function stringifyExactOrRefuse(value: unknown): string {
  const text = stringifyExact(value);
  if (text == null) throw new Error('a value holding -0.0 or an infinity cannot cross as JSON on this runtime: its text would change the value');
  return text;
}
