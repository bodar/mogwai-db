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
import { valueNodeFromStored } from './gremlin/types.ts';

/**
 * One `FrameNode` → plain JS (a `JSON.stringify`-able value). Total over the FrameNode union: a
 * container recurses, an element renders to its untyped GraphSON object, a token renders to its name,
 * and a scalar leaf renders to its bare value.
 *
 * A `bigint` (a Long — a `count()`, an int64 id) renders as a JS number, because JSON has no bigint;
 * a value beyond ±2^53 loses precision, which is out of this readable-view's scope (the GraphBinary
 * path carries it exactly).
 */
export function untyped(node: FrameNode): unknown {
  if (node === null || node === undefined) return null;
  if (typeof node === 'bigint') return Number(node);
  if (typeof node !== 'object') return node; // a bare string / number / boolean leaf
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
      return typeof node.v === 'bigint' ? Number(node.v) : node.v;
  }
}

/** A `{t:'map'}` node → a JS object. JSON object keys are strings, so a token/element/scalar key is
 *  stringified (`untypedMapKey`); the value recurses. */
function untypedMap(pairs: [FrameNode, FrameNode][]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of pairs) out[untypedMapKey(k)] = untyped(v);
  return out;
}

/** A map KEY as a string — a `T`/`Direction` token by its name, anything else by its rendered value. */
function untypedMapKey(k: FrameNode): string {
  if (k !== null && typeof k === 'object' && !Array.isArray(k) && (k.t === 'T' || k.t === 'D')) return String(k.v);
  return String(untyped(k));
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
const asProps = (props: any): Record<string, any> => (typeof props === 'string' ? JSON.parse(props) : props);
