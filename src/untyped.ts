// ---------- untyped (readable) JSON rendering of a result node tree ----------
//
// A PARALLEL tail to the GraphBinary framer (`execute.ts`), chosen by HTTP content negotiation
// (`Accept: application/json`, opt-in — GraphBinary stays the default the real GLV clients get). It
// renders the DECODED NODE TREE (`FrameNode`/`ValueNode`, which keep element properties) to plain JS,
// then `JSON.stringify`. It must render from the node tree and NOT by decoding our GraphBinary back,
// because the client's vertex/edge deserializers hardcode empty properties (`.claude/rules/
// wire-protocol.md`) — decoding the binary would LOSE every element property. This is the same node
// tree the federation transport already produces (`foreignValueNodes`/`foreignElementNode`).
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
import { exactNumberOf, isExactNumber, parseElementJson, type ExactNumber } from './json-exact.ts';

/**
 * A result this readable rendering cannot SPELL as the value it is — a map key with no exact JSON spelling
 * (a list, a map, an edge property: Java's `toString()` of one prints nested element strings and
 * abbreviations this rendering does not reproduce), a non-finite Double (JSON has no number for it), two
 * keys that print alike, or a wide number on a runtime without `JSON.rawJSON`. `resolveJson` catches it
 * and answers `null`, so the router falls back to the GraphBinary response, which carries every one of
 * them exactly — never a stringified object (`"[object Object]"`, which also merged distinct keys into
 * ONE entry) or a rounded number.
 */
export class UnspellableJson extends Error {
  constructor(what: string) {
    super(`untyped JSON cannot spell ${what}`);
    this.name = 'UnspellableJson';
  }
}

const rawJson = JSON as unknown as { rawJSON?: (text: string) => unknown };

/** An exact JSON number for `text` (a decimal spelling already known exact), or a decline. */
function rawNumber(text: string): unknown {
  if (!rawJson.rawJSON) throw new UnspellableJson(`the number ${text} on this runtime`);
  return rawJson.rawJSON(text);
}

/** The integral tags — a Gremlin Byte/Short/Int/Long/BigInteger, and the `integer` storage class a numeric
 *  reducer tags its sum with. A value under one may ride as its exact decimal TEXT (a Long past 2^53). */
const INTEGRAL_TAGS: ReadonlySet<unknown> = new Set(['byte', 'short', 'int', 'long', 'bigint', 'integer']);
const DECIMAL_INTEGER = /^-?\d+$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A JS number as JSON, exactly: a NaN or an infinity — which `JSON.stringify` writes as `null` — declines. */
function untypedNumber(x: number): unknown {
  if (!Number.isFinite(x)) throw new UnspellableJson(`the Double ${x}`);
  return x;
}

/** A Long/BigInteger as JSON: a JS number within ±2^53, else its exact digits (a JSON number has no
 *  width; `Number(9223372036854775807n)` is `…808`). */
const untypedInteger = (x: bigint): unknown => (Number.isSafeInteger(Number(x)) ? Number(x) : rawNumber(String(x)));

/** A scalar leaf's bare value as JSON: a number exactly (`untypedNumber`/`untypedInteger`), and an
 *  INTEGRAL tag's decimal text (a Long past 2^53) as the number it is rather than a string. A raw exact
 *  number (`parseExactJson`) re-stringifies as its own source text, so it passes through. */
function untypedLeaf(tag: string | null, v: unknown): unknown {
  if (typeof v === 'number') return untypedNumber(v);
  if (typeof v === 'bigint') return untypedInteger(v);
  if (typeof v === 'string' && INTEGRAL_TAGS.has(tag) && DECIMAL_INTEGER.test(v)) return untypedInteger(BigInt(v));
  return v;
}

/**
 * One `FrameNode` → plain JS (a `JSON.stringify`-able value). Total over the FrameNode union: a
 * container recurses, an element renders to its untyped GraphSON object, a token renders to its name,
 * and a scalar leaf renders to its bare value — EXACTLY, or not at all (`UnspellableJson`): a Long past
 * 2^53 as its exact digits (`JSON.rawJSON`).
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

/** A `{t:'map'}` node → a JS object. JSON object keys are strings, so each key is spelled the way the
 *  reference spells it (`untypedMapKey`); the value recurses. */
function untypedMap(pairs: [FrameNode, FrameNode][]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of pairs) {
    const key = untypedMapKey(k);
    // Two distinct keys that print alike (the Int `1` and the String `"1"`) would MERGE into one JSON
    // entry — a different map — so a collision declines too.
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new UnspellableJson(`two map keys that both print as ${JSON.stringify(key)}`);
    out[key] = untyped(v);
  }
  return out;
}

/**
 * A map KEY as the string the reference writes for it — TOTAL, or a decline (`UnspellableJson`).
 * `GraphSONKeySerializer.ser` (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/
 * structure/io/graphson/GraphSONSerializersV4.java:371-376) writes an ELEMENT (a vertex, an edge, a
 * VertexProperty — `VertexProperty extends Element`) as `element.id().toString()` and anything else as
 * Jackson's `StdKeySerializer` does, i.e. its `toString()`. Spelled exactly here: a String/Character as
 * itself, a Boolean, an integral number in decimal, a Double/Float as `Double.toString`/`Float.toString`
 * (`javaDecimal`), a uuid in its canonical lower-case form, a `T`/`Direction` token by its name. Every
 * other key DECLINES rather than print a near miss: a list/set/map (`AbstractCollection.toString` prints
 * each member's `toString` — `v[1]`, `e[7][1-knows->2]`, `[]` — not what a member renders as here), an
 * edge `Property` (not an Element: `p[weight->0.4]`, abbreviated by `StringFactory`), a null, a
 * datetime/bigdecimal/duration.
 */
function untypedMapKey(k: FrameNode): string {
  if (k === null || k === undefined) throw new UnspellableJson('a null map key');
  if (typeof k !== 'object' || isExactNumber(k)) return scalarKey(null, k);
  if (Array.isArray(k)) throw new UnspellableJson('a list map key');
  switch (k.t) {
    case 'T':
    case 'D':
      return String(k.v);
    case 'vertex':
    case 'edge':
      return elementIdKey((k.v as Record<string, unknown>).id);
    case 'property': {
      // A VertexProperty is an Element and keys by its id; an edge `Property` (no `vpid`) is not one.
      const vpid = (k.v as Record<string, unknown>).vpid;
      if (vpid == null) throw new UnspellableJson('an edge property map key');
      return elementIdKey(vpid);
    }
    case 'list':
    case 'set':
    case 'map':
      throw new UnspellableJson(`a ${k.t} map key`);
    default:
      return scalarKey(k.t, k.v);
  }
}

/** An element id as a key: our ids are integers or (a `uid`) strings, each of which prints as itself. */
function elementIdKey(id: unknown): string {
  if (typeof id === 'string' || typeof id === 'bigint' || (typeof id === 'number' && Number.isSafeInteger(id))) return String(id);
  throw new UnspellableJson('an element id map key');
}

/** A scalar key by its tag; a null tag infers the class the framer would (`numberClassOf` for a bare
 *  number, an int64 for a raw integral exact number — `exactNumberBuffer`). */
function scalarKey(tag: string | null, v: unknown): string {
  if (isExactNumber(v)) {
    const { integral, text } = exactNumberOf(v as ExactNumber);
    if (integral && (tag === null || INTEGRAL_TAGS.has(tag))) return text;
    return scalarKey(tag ?? 'double', Number(text));
  }
  if (tag === null) {
    if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
    if (typeof v === 'number') return numberClassOf(v) === 'double' ? javaDecimal(v, 'double') : String(v);
  } else if (tag === 'string' || tag === 'char') {
    if (typeof v === 'string') return v;
  } else if (tag === 'boolean') {
    if (typeof v === 'boolean') return String(v);
  } else if (INTEGRAL_TAGS.has(tag)) {
    if (typeof v === 'bigint' || (typeof v === 'number' && Number.isSafeInteger(v))) return String(v);
    if (typeof v === 'string' && DECIMAL_INTEGER.test(v)) return String(BigInt(v));
  } else if (tag === 'double' || tag === 'real' || tag === 'float') {
    if (typeof v === 'number') return javaDecimal(v, tag === 'float' ? 'float' : 'double');
  } else if (tag === 'uuid') {
    if (typeof v === 'string' && CANONICAL_UUID.test(v)) return v;
  }
  throw new UnspellableJson(`a ${tag ?? typeof v} map key`);
}

/**
 * `Double.toString` / `Float.toString` (`java.lang.Double#toString(double)`, JDK 19+): the SHORTEST decimal
 * that reads back as the value (for a Float, back through `float` rounding — `Math.fround`), laid out
 * plainly with at least one fraction digit when 10^-3 <= |x| < 10^7 (`1.0`, `0.001`), otherwise as
 * `<d.ddd>E<n>` (`1.5E300`, `1.0E-5`); `NaN` and `Infinity` by name (a zero is `0.0`, sign and all). JS's `Number#toString` picks the
 * same shortest digits for a double; only the layout differs.
 */
function javaDecimal(x: number, cls: 'double' | 'float'): string {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : '-Infinity';
  if (x === 0) return '0.0';
  let d = x;
  if (cls === 'float') {
    if (Math.fround(x) !== x) throw new UnspellableJson(`the Float ${x}`);
    for (let p = 1; p <= 9; p++) {
      const candidate = Number(x.toPrecision(p));
      if (Math.fround(candidate) === x) { d = candidate; break; }
    }
  }
  const magnitude = Math.abs(d);
  if (magnitude >= 1e-3 && magnitude < 1e7) {
    const plain = String(d);
    return plain.includes('.') ? plain : `${plain}.0`;
  }
  const [mantissa, exponent] = d.toExponential().split('e') as [string, string];
  return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}E${Number(exponent)}`;
}

/** A vertex payload (`{ id, label, props }`, as `foreignElementNode` builds it — `label` already the
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

/** A vertex's label field → a labels ARRAY. Already an array from `foreignElementNode`; a raw
 *  JSON-text form (a map-blob-carried element) is parsed; anything else yields no labels. */
const asLabels = (label: any): string[] =>
  Array.isArray(label) ? label : typeof label === 'string' ? (JSON.parse(label) as string[]) : [];

/** An element's props field → the `{ key: [valueNode] }` object. Already an object from
 *  `foreignElementNode`/`propsOf`; a raw JSON-text form is parsed. */
const asProps = (props: any): Record<string, any> => parseElementJson(props);
