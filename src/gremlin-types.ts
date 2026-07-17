// ---------- the one canonical Gremlin type vocabulary ----------
//
// Typed property values (docs/2026-07-16-typed-property-values-plan.md) unify what
// used to be three disconnected type vocabularies (frontend numeric argTypes,
// render.ts ValueType, plan.ts GTYPE_SQL) into ONE lowercased canonical name set.
// The type of a stored value is produced by whichever channel CARRIED it — never a
// heuristic:
//   - a bound param  → the GraphBinary DataType the client serialized (wire truth,
//     captured in wire.ts),
//   - an inline literal → the ANTLR-parsed subtype (frontend.ts walkArgs).
// It is stored on write (vertex_properties.vtype / edge_properties.vtype) and
// consumed on read (typeOf filter + per-row framing).

import { ioc } from './io.ts';

// ---------- exact big-value carriers (BigDecimal / Duration) ----------
//
// JS has no native BigDecimal or java.time.Duration, so a value of either type would
// lose precision if funneled through a JS `number` (the pre-existing bug for long>2^53
// and bigdecimal — see docs & the do-sqlite-bind-precision investigation). These two
// small classes carry the EXACT value end-to-end; they surface only at the wire boundary
// (serializers.ts deserialize → instance) and at literal parse (frontend.ts), and are
// normalized to a canonical decimal TEXT by `storedScalar` the moment they hit storage,
// so the rest of the compiler stays number/bigint/string-only. `Char` needs no carrier —
// it is a 1-codepoint string, disambiguated from String purely by its stored vtype.

/** A java.math.BigDecimal: value = unscaled × 10^(-scale). */
export class BigDecimal {
  constructor(public unscaled: bigint, public scale: number) {}
  /** Canonical plain decimal string (no exponent) — the stored + re-parseable form. */
  toString(): string {
    const neg = this.unscaled < 0n;
    let digits = (neg ? -this.unscaled : this.unscaled).toString();
    const s = this.scale;
    let out: string;
    if (s === 0) out = digits;
    else if (s < 0) out = digits + '0'.repeat(-s);
    else {
      if (digits.length <= s) digits = '0'.repeat(s - digits.length + 1) + digits;
      out = digits.slice(0, digits.length - s) + '.' + digits.slice(digits.length - s);
    }
    return neg ? '-' + out : out;
  }
  /** Parse a plain decimal string into {unscaled, scale}. No exponent notation
   *  (neither our stored form nor a `m`-suffixed literal ever uses it). */
  static fromText(str: string): BigDecimal {
    str = str.trim();
    let neg = false;
    if (str[0] === '+') str = str.slice(1);
    else if (str[0] === '-') { neg = true; str = str.slice(1); }
    const dot = str.indexOf('.');
    let scale: number, digits: string;
    if (dot < 0) { scale = 0; digits = str; }
    else { scale = str.length - dot - 1; digits = str.slice(0, dot) + str.slice(dot + 1); }
    let unscaled = BigInt(digits === '' ? '0' : digits);
    if (neg) unscaled = -unscaled;
    return new BigDecimal(unscaled, scale);
  }
  /** Accept an instance, a decimal string, a bigint, or a number. */
  static from(x: BigDecimal | string | bigint | number): BigDecimal {
    if (x instanceof BigDecimal) return x;
    if (typeof x === 'bigint') return new BigDecimal(x, 0);
    return BigDecimal.fromText(String(x));
  }
}

/** A java.time.Duration: {seconds, nanos}, nanos normalized to [0, 1e9). The canonical
 *  stored form is total-nanoseconds as a decimal string (single reversible scalar). */
export class Duration {
  static readonly NANOS_PER_SEC = 1_000_000_000n;
  constructor(public seconds: bigint, public nanos: number) {}
  totalNanos(): bigint { return this.seconds * Duration.NANOS_PER_SEC + BigInt(this.nanos); }
  toString(): string { return this.totalNanos().toString(); }
  static fromTotalNanos(total: bigint): Duration {
    let s = total / Duration.NANOS_PER_SEC;
    let n = total % Duration.NANOS_PER_SEC;
    if (n < 0n) { s -= 1n; n += Duration.NANOS_PER_SEC; } // Java normalization: nanos ≥ 0
    return new Duration(s, Number(n));
  }
  /** Accept an instance, a total-nanos decimal string, or a total-nanos bigint. */
  static from(x: Duration | string | bigint): Duration {
    if (x instanceof Duration) return x;
    return Duration.fromTotalNanos(typeof x === 'bigint' ? x : BigInt(x));
  }
}

/** The canonical type names. A superset of the GType tokens; every typeOf argument
 *  and every wire/literal type normalizes into this set. */
export type CanonicalType =
  | 'string' | 'boolean'
  | 'byte' | 'short' | 'int' | 'long' | 'bigint' | 'float' | 'double' | 'bigdecimal'
  | 'datetime' | 'uuid' | 'char' | 'duration'
  | 'list' | 'map' | 'set';

/** The recursively-captured wire/parse type of a value. A scalar leaf is a bare
 *  CanonicalType string (so every existing argType consumer keeps working — an unknown
 *  container node falls through gremlinTypeOf to JS inference). A container carries its
 *  element/entry types so a consumer that needs depth (merge maps) can honor them.
 *  null = the channel said nothing (JSON path / a JS client that dropped the type). */
export type TypeNode =
  | CanonicalType
  | { t: 'map'; entries: Record<string, TypeNode | null> }
  | { t: 'list' | 'set'; items: (TypeNode | null)[] };

/** The scalar/container KIND of a TypeNode as a flat name (a scalar node IS its name;
 *  a container node → its `t`). For the common "I just need a type string" consumer. */
export const flatType = (tn: TypeNode | null | undefined): CanonicalType | null =>
  tn == null ? null : typeof tn === 'string' ? tn : tn.t;

/** The value-type under a merge-map key, or null. */
export const mapEntryType = (tn: TypeNode | null | undefined, key: string): TypeNode | null =>
  tn != null && typeof tn === 'object' && tn.t === 'map' ? tn.entries[key] ?? null : null;

/** GraphBinary DataType code → canonical name. Built from the client's own DataType
 *  enum so it stays byte-stable with the serializers (no magic numbers). Only the
 *  codes a property VALUE can carry are mapped; element/token codes (VERTEX/T/…) are
 *  intentionally absent (they are never stored as a property value). */
export const WIRE_TYPE_TO_NAME: Record<number, CanonicalType> = {
  [ioc.DataType.STRING]: 'string',
  [ioc.DataType.BOOLEAN]: 'boolean',
  [ioc.DataType.BYTE]: 'byte',
  [ioc.DataType.SHORT]: 'short',
  [ioc.DataType.INT]: 'int',
  [ioc.DataType.LONG]: 'long',
  [ioc.DataType.BIGINTEGER]: 'bigint',
  [ioc.DataType.FLOAT]: 'float',
  [ioc.DataType.DOUBLE]: 'double',
  [ioc.DataType.BIGDECIMAL]: 'bigdecimal',
  [ioc.DataType.DATETIME]: 'datetime',
  [ioc.DataType.UUID]: 'uuid',
  [ioc.DataType.CHAR]: 'char',
  [ioc.DataType.DURATION]: 'duration',
  [ioc.DataType.LIST]: 'list',
  [ioc.DataType.MAP]: 'map',
  [ioc.DataType.SET]: 'set',
};

/** typeOf/GType-token spelling → canonical name. `integer`→`int`, `biginteger`→
 *  `bigint`, and the vertex-property token aliases. Names already canonical map to
 *  themselves via `normalizeTypeName`. */
const ALIASES: Record<string, CanonicalType> = {
  integer: 'int',
  biginteger: 'bigint',
};

const CANONICAL = new Set<string>([
  'string', 'boolean', 'byte', 'short', 'int', 'long', 'bigint', 'float', 'double',
  'bigdecimal', 'datetime', 'uuid', 'char', 'duration', 'list', 'map', 'set',
]);

/** Collections are stored as JSONB in the value column (not a raw scalar bind). */
export const COLLECTION_TYPES = new Set<CanonicalType>(['list', 'map', 'set']);
export const isCollectionType = (t: string | null | undefined): boolean =>
  t != null && COLLECTION_TYPES.has(t as CanonicalType);

/** ±(2^53 − 1): the range a JS `number` (and thus a numeric SQLite bind) holds
 *  exactly. Outside it, a value must ride as decimal TEXT to survive both runtimes
 *  (DO rejects bigint binds; a number loses the low bits — see do-sqlite-bind-precision). */
const SAFE_MIN = -9007199254740991n, SAFE_MAX = 9007199254740991n;
export const fitsSafeInteger = (b: bigint): boolean => b >= SAFE_MIN && b <= SAFE_MAX;

/** Normalize ANY value to a lossless SQLite bind at the one seam both runtimes cross
 *  (storage.ts coerceBind). A bigint binds as a JS number while it fits ±2^53 exactly,
 *  else as its decimal string (a raw bigint bind throws on the DO; Number() truncates —
 *  see do-sqlite-bind-precision). A BigDecimal/Duration carrier binds as its canonical
 *  decimal text. Booleans → 1/0 (bun accepts booleans, the DO does not). Everything else
 *  passes through. This makes every bind site — write value, predicate literal, id —
 *  precision-safe, not just the write path (storedScalar). */
export function coerceBindValue(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return fitsSafeInteger(value) ? Number(value) : value.toString();
  if (value instanceof BigDecimal || value instanceof Duration) return value.toString();
  return value;
}

/** Normalize a SCALAR property value to what actually BINDS into the `value` column,
 *  keyed on its canonical vtype. The exact tail is stored as canonical decimal TEXT so
 *  no precision is lost at the bind seam (string binds losslessly on both runtimes;
 *  a number bind truncates >2^53 and a bigint bind throws on the DO):
 *    - bigdecimal/duration → their canonical decimal text (BigDecimal / total-nanos),
 *    - char                → the 1-codepoint string,
 *    - long/bigint         → a JS number while it fits ±2^53 exactly (keeps INTEGER/REAL
 *      storage class + native index usage for the common case), else decimal TEXT.
 *  Every read of these compares/frames through CAST (plan.ts uniform CAST ordering +
 *  execute.ts CAST-AS-TEXT framing), so a per-key mix of numeric- and TEXT-stored rows is
 *  compared correctly regardless of storage class. Collections never reach here (JSONB). */
export function storedScalar(val: any, vtype: CanonicalType | null): any {
  switch (vtype) {
    case 'bigdecimal': return BigDecimal.from(val).toString();
    case 'duration': return Duration.from(val).toString();
    case 'char': return String(val);
    case 'long': case 'bigint':
      if (typeof val === 'bigint') return fitsSafeInteger(val) ? Number(val) : val.toString();
      return val;
    default: return val;
  }
}

/** Types without a bidirectional GraphBinary serializer. Formerly {bigdecimal, char,
 *  duration} — the client's three unchecked TODOs — now all three are served by our
 *  hand-rolled serializers (serializers.ts), so the set is empty: every canonical type
 *  both detects (typeOf over vtype) AND frames out. Kept as the single source of truth
 *  should a future type land detect-only again. */
export const UNFRAMEABLE_TYPES = new Set<CanonicalType>([]);
export const hasSerializer = (t: string | null | undefined): boolean =>
  t != null && CANONICAL.has(t) && !UNFRAMEABLE_TYPES.has(t as CanonicalType);

/** Lowercase + de-alias a GType/typeOf name to its canonical form, or null if it is
 *  not a recognized property-value type name (the caller decides whether that is an
 *  error or a fold-to-false). */
export function normalizeTypeName(name: string): CanonicalType | null {
  const lc = name.toLowerCase();
  if (lc in ALIASES) return ALIASES[lc];
  return CANONICAL.has(lc) ? (lc as CanonicalType) : null;
}

/** The canonical type to STORE for a value, given the type its carrying channel
 *  declared (`argType` — a wire DataType name or a parsed literal subtype) and the
 *  materialized JS value. The declared type wins when present (it is the truth the
 *  wire/literal gave us, and is the ONLY way datetime/uuid are distinguishable from
 *  long/string); otherwise infer conservatively from the JS runtime type — the
 *  honest fallback for an untyped channel (a JSON-request param, an unftagged arg).
 *  Returns null when nothing can be said (e.g. a null value), leaving vtype NULL =
 *  "infer on read" (the legacy storage-class path). */
export function gremlinTypeOf(jsValue: any, argType?: TypeNode | null): CanonicalType | null {
  // A TypeNode may be a scalar name (string) or a container node — flatten to a name;
  // an unknown/container name falls through to JS inference below (a container JS value
  // infers to list/map/set anyway, so a container node needs no special handling here).
  const flat = flatType(argType);
  if (flat) {
    const c = normalizeTypeName(flat);
    if (c) return c;
  }
  if (jsValue === null || jsValue === undefined) return null;
  if (Array.isArray(jsValue)) return 'list';
  if (jsValue instanceof Map) return 'map';
  if (jsValue instanceof Set) return 'set';
  switch (typeof jsValue) {
    case 'boolean': return 'boolean';
    case 'string': return 'string';
    case 'bigint': return 'bigint';
    case 'number': return Number.isInteger(jsValue) ? 'int' : 'double';
    default: return null;
  }
}
