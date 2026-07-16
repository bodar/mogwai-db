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

/** The canonical type names. A superset of the GType tokens; every typeOf argument
 *  and every wire/literal type normalizes into this set. */
export type CanonicalType =
  | 'string' | 'boolean'
  | 'byte' | 'short' | 'int' | 'long' | 'bigint' | 'float' | 'double' | 'bigdecimal'
  | 'datetime' | 'uuid' | 'char' | 'duration'
  | 'list' | 'map' | 'set';

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

/** Types WITHOUT a bidirectional GraphBinary serializer in the reused `gremlin`
 *  client package. A value of one of these can be DETECTED (typeOf filter over the
 *  stored vtype) but not FRAMED out — framing such a value stays deferred (throws /
 *  falls to anySerializer), matching the pre-existing bigdecimal wall. */
export const UNFRAMEABLE_TYPES = new Set<CanonicalType>(['bigdecimal', 'char', 'duration']);
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
export function gremlinTypeOf(jsValue: any, argType?: string | null): CanonicalType | null {
  if (argType) {
    const c = normalizeTypeName(argType);
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
