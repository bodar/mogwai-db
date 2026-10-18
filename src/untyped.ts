// ---------- untyped (readable) JSON rendering of a result node tree ----------
//
// A PARALLEL tail to the GraphBinary framer (`execute.ts`), chosen by HTTP content negotiation
// (`Accept: application/json`, opt-in — GraphBinary stays the default the real GLV clients get). It
// renders the DECODED NODE TREE (`FrameNode`/`ValueNode`, which keep element properties) to plain JS,
// then `JSON.stringify`. It must render from the node tree and NOT by decoding our GraphBinary back,
// because the client's vertex/edge deserializers hardcode empty properties (`.claude/rules/
// wire-protocol.md`) — decoding the binary would LOSE every element property. This is the same node
// tree the federation transport already produces (`rowsToNodes`).
//
// The shape follows TinkerPop 4's UNTYPED GraphSON element form (`TypeInfo.NO_TYPES`), from
// `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/io/graphson/
// GraphSONSerializersV4.java` at the pin (rev 2e56ccc):
//   - a VERTEX (`VertexJacksonSerializer.serialize`, line 84) → `{ id, label: [<labels>],
//     properties: { <key>: [ { id?, value }, … ] } }`. `writeLabels` (line 711) writes the field name
//     `"label"` but ALWAYS an ARRAY (multi-label support), and each property value is a VertexProperty
//     object `{ id?, value }` under NO_TYPES (line 116);
//   - an EDGE (`EdgeJacksonSerializer.serialize`, line 143) → `{ id, label: [<label>], inV, outV,
//     properties: { <key>: [ <value> ] } }`. V4 wraps each edge property value in a one-element ARRAY
//     too (line 179). Endpoints (`inV`/`outV`) are BARE ids here rather than the V4 `{ id, label }`
//     objects, because our edge payload carries only endpoint ids — the same reduction the GraphBinary
//     edge frames (`execute.ts edgeBuffer` rides empty endpoint labels);
//   - a PROPERTY (`PropertyJacksonSerializer`, line 191) → `{ key, value }` (VertexProperty adds `id`);
//   - a scalar leaf → its value; a `list`/`set` → an array; a `map` → a JS object.
//
// It is UNTYPED: NO `@type`/`@value` wrappers. That is the whole point — the TYPED `graphsonNode`
// (`src/formats/graphson.ts`) is the io/adjacency form and is deliberately NOT reused here; this is a
// different, response-shaped rendering.
import type { FrameNode, ValueNode } from './gremlin/types.ts';
import { numberClassOf, valueNodeFromStored } from './gremlin/types.ts';
import { exactNumberOf, isExactNumber, type ExactNumber } from './json-exact.ts';

const rawJson = JSON as unknown as { rawJSON?: (text: string) => unknown };

/** The integral tags — a Gremlin Byte/Short/Int/Long/BigInteger, and the `integer` storage class a numeric
 *  reducer tags its sum with. A value under one may ride as its exact decimal TEXT (a Long past 2^53). */
const INTEGRAL_TAGS: ReadonlySet<unknown> = new Set(['byte', 'short', 'int', 'long', 'bigint', 'integer']);
const DOUBLE_TAGS: ReadonlySet<unknown> = new Set(['double', 'real', 'float']);
const DECIMAL_INTEGER = /^-?\d+$/;

/** A JS number as JSON: a NaN or an infinity — which JSON has no number for (`JSON.stringify` writes
 *  `null`) — renders as its NAME, a string, rather than a silent `null`. */
const untypedNumber = (x: number): unknown => (Number.isFinite(x) ? x : String(x));

/** A Long/BigInteger as JSON: a JS number within ±2^53, else its exact digits (a JSON number has no
 *  width; `Number(9223372036854775807n)` is `…808`) — as a raw JSON number where the runtime has
 *  `JSON.rawJSON`, else as a digit string. */
function untypedInteger(x: bigint): unknown {
  if (Number.isSafeInteger(Number(x))) return Number(x);
  return rawJson.rawJSON ? rawJson.rawJSON(String(x)) : String(x);
}

/** A scalar leaf's bare value as JSON: a number (`untypedNumber`/`untypedInteger`), and an INTEGRAL
 *  tag's decimal text (a Long past 2^53) as the number it is rather than a string. A raw exact number
 *  (`parseExactJson`) re-stringifies as its own source text, so it passes through. */
function untypedLeaf(tag: string | null, v: unknown): unknown {
  if (typeof v === 'number') return untypedNumber(v);
  if (typeof v === 'bigint') return untypedInteger(v);
  if (typeof v === 'string' && INTEGRAL_TAGS.has(tag) && DECIMAL_INTEGER.test(v)) return untypedInteger(BigInt(v));
  return v;
}

/**
 * One `FrameNode` → plain JS (a `JSON.stringify`-able value). TOTAL over the FrameNode union: a
 * container recurses, an element renders to its untyped GraphSON object, a token renders to its name,
 * and a scalar leaf renders to its bare value (a Long past 2^53 as its exact digits).
 */
export function untyped(node: FrameNode): unknown {
  if (node === null || node === undefined) return null;
  if (typeof node !== 'object') return untypedLeaf(null, node); // a bare string / number / boolean leaf
  if (isExactNumber(node)) return node;
  if (Array.isArray(node)) return node.map(untyped); // a bare array (the untyped list substrate)
  switch (node.t) {
    case 'list':
    case 'set':
      return (node.v as FrameNode[]).map(untyped);
    case 'map':
      return untypedMap(node.v as [FrameNode, FrameNode][]);
    case 'vertex':
      return untypedVertex(node.v as Record<string, any>);
    case 'edge':
      return untypedEdge(node.v as Record<string, any>);
    case 'property':
      return untypedProperty(node.v as Record<string, any>);
    // A PATH (`PathJacksonSerializer`) → `{ labels, objects }`, one label set per position (empty —
    // labels-on-path deferred), as the GraphBinary path frames.
    case 'path':
      return { labels: node.v.map(() => []), objects: node.v.map(untyped) };
    // A `T`/`Direction` token as a VALUE renders as its name — a bare string (as a map KEY it is
    // stringified the same way, `untypedMapKey`).
    case 'T':
    case 'D':
      return node.v;
    // A scalar leaf `{ t: <canonical type | null>, v }` — the type is presentational only in the
    // untyped form, so the bare value is the whole rendering (a datetime rides as its stored epoch
    // millis; a uuid/bigdecimal/duration as its stored canonical string).
    default:
      return untypedLeaf(node.t, node.v);
  }
}

/** A `{t:'map'}` node → a JS object. JSON object keys are strings, so each key is spelled by the one
 *  total rule (`untypedMapKey`); the value recurses. Two distinct keys can spell alike (the Int `1` and
 *  the String `"1"`, `null` and `"null"`) — and an object would keep only one of them, losing an entry.
 *  So a map whose keys collide renders as an ARRAY of `[key, value]` entries instead, each key rendered
 *  as a value (`untyped`), so every entry survives and `1` stays apart from `"1"`. The object has no
 *  prototype, so a `"__proto__"` key is an ordinary entry rather than a prototype assignment. */
function untypedMap(pairs: [FrameNode, FrameNode][]): Record<string, unknown> | unknown[] {
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of pairs) {
    const key = untypedMapKey(k);
    if (Object.hasOwn(out, key)) return pairs.map(([pk, pv]) => [untyped(pk), untyped(pv)]);
    out[key] = untyped(v);
  }
  return out;
}

/**
 * A map KEY as a string — TOTAL. An ELEMENT (a vertex, an edge, a VertexProperty) keys by its id, as the
 * reference's `GraphSONKeySerializer` does; a `T`/`Direction` token by its name; null as `null`; a scalar
 * as `String(v)`, with `.0` appended to a whole Double so `1` and `1.0` stay distinct keys; anything
 * else (a list, a set, a map, an edge property) as the JSON text of its untyped rendering. Java's
 * `toString()` spellings (`Double.toString`'s `1.0E-5`, `[v[1]]`, `p[weight->0.4]`) are not reproduced.
 */
function untypedMapKey(k: FrameNode): string {
  if (k === null || k === undefined) return 'null';
  if (typeof k !== 'object' || isExactNumber(k)) return scalarKey(null, k);
  if (Array.isArray(k)) return JSON.stringify(untyped(k));
  switch (k.t) {
    case 'T':
    case 'D':
      return String(k.v);
    case 'vertex':
    case 'edge':
      return String((k.v as Record<string, unknown>).id);
    case 'property': {
      const vpid = (k.v as Record<string, unknown>).vpid;
      return vpid == null ? JSON.stringify(untyped(k)) : String(vpid);
    }
    case 'list':
    case 'set':
    case 'map':
    case 'path':
      return JSON.stringify(untyped(k));
    default:
      return scalarKey(k.t, k.v);
  }
}

/** A scalar key by its tag: `String(v)`, a whole Double (by tag, or a bare number `numberClassOf` calls
 *  a Double) with `.0` appended; an integral exact number as its digits. */
function scalarKey(tag: string | null, v: unknown): string {
  if (isExactNumber(v)) {
    const { integral, text } = exactNumberOf(v as ExactNumber);
    if (integral && (tag === null || INTEGRAL_TAGS.has(tag))) return text;
    return scalarKey(tag ?? 'double', Number(text));
  }
  if (typeof v === 'number' && (DOUBLE_TAGS.has(tag) || (tag === null && numberClassOf(v) === 'double'))) {
    const text = String(v);
    return /^-?\d+$/.test(text) ? `${text}.0` : text;
  }
  return String(v);
}

/** A vertex payload (`{ id, label, props }`, as `elementNode` builds it — `label` already the
 *  labels array, `props` the `{ key: [valueNode] }` object) → the untyped GraphSON vertex. Both fields
 *  are re-normalised defensively (a map-blob-carried element may arrive as JSON text). */
function untypedVertex(v: Record<string, any>): unknown {
  const props = asProps(v.props) as Record<string, ValueNode[]>;
  const properties: Record<string, unknown[]> = {};
  // V4 NO_TYPES writes each value as a VertexProperty object `{ id?, value }`. Our payload carries the
  // value nodes only (no per-property id here), so `id` is omitted (the V4 shape allows it optional).
  for (const key of Object.keys(props)) properties[key] = props[key].map((vn) => ({ value: untyped(vn) }));
  return { id: v.id, label: asLabels(v.label), properties };
}

/** An edge payload (`{ id, label, src, tgt, props }`) → the untyped GraphSON edge. `label` is a single
 *  name wrapped in the V4 one-element array; `inV`/`outV` are the bare endpoint ids; each property
 *  value rides in a one-element array (V4). */
function untypedEdge(v: Record<string, any>): unknown {
  const props = asProps(v.props) as Record<string, ValueNode>;
  const properties: Record<string, unknown[]> = {};
  for (const key of Object.keys(props)) properties[key] = [untyped(props[key])];
  return { id: v.id, label: [v.label], inV: v.tgt, outV: v.src, properties };
}

/** A property payload (`{ vpid, owner, pk, pv, pvtype, pmeta }`, the tuple `framePropertyRow` reads) →
 *  `{ id?, key, value }`. The stored `(pv, pvtype)` pair reconstructs its value node via the one
 *  `valueNodeFromStored` rule the framer uses, so a typed/collection value renders correctly. */
function untypedProperty(v: Record<string, any>): unknown {
  const out: Record<string, unknown> = { key: v.pk, value: untyped(valueNodeFromStored(v.pv, v.pvtype ?? null)) };
  if (v.vpid != null) out.id = v.vpid;
  return out;
}

/** A vertex's label field → a labels ARRAY. Already an array from `elementNode`; a raw
 *  JSON-text form (a map-blob-carried element) is parsed; anything else yields no labels. */
const asLabels = (label: any): string[] =>
  Array.isArray(label) ? label : typeof label === 'string' ? (JSON.parse(label) as string[]) : [];

/** An element's props field → the `{ key: [valueNode] }` object. Already an object from
 *  `elementNode`/`propsOf`; a raw JSON-text form is parsed. */
const asProps = (props: any): Record<string, any> => (typeof props === 'string' ? JSON.parse(props) : props);
