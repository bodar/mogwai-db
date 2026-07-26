// Concern A — wire parsing, at the edge. Sniff the request shape (GraphBinary vs
// JSON), pull out the gremlin string, bindings, the traversal-source name (`g`),
// and resolve the chunk batch size. This is the ONLY place the request body is
// decoded; the router uses `g` as the graph-selector fallback when the URL path
// carries none, and passes {gremlin, params} across the manager seam to the store
// tier (concern B). No compilation, no store, no HTTP here.
import { ioc, StreamReader } from './io.ts';
import { WIRE_TYPE_TO_NAME, type TypeNode, type MapEntryType } from './gremlin/types.ts';

/** The client's async byte reader (no shipped types for the internals subpath). Every read
 *  is a Promise because the same reader also backs a live ReadableStream; over a complete
 *  buffer they all resolve synchronously-in-spirit, without I/O. */
interface StreamReaderT {
  readUInt8(): Promise<number>;
  readInt32BE(): Promise<number>;
  readBytes(n: number): Promise<Buffer>;
}

// TinkerPop's default resultIterationBatchSize — governs only HTTP chunk pacing
// (how many value buffers concat per stream pull), never a protocol boundary.
const DEFAULT_BATCH_SIZE = 64;

export interface ParsedQuery {
  gremlin: string;
  params: Record<string, any>;
  /** The canonical Gremlin type each bound param was serialized as on the wire (its
   *  GraphBinary DataType) — the truth for a param's type, which a JS `number` alone
   *  can't carry. Consumed by the frontend to tag the param's argType so a typed
   *  property write records the right vtype. Empty for the JSON request path (no wire
   *  type tags — the write seam then infers from the JS value). */
  paramTypes: Record<string, TypeNode>;
  /** Traversal-source name from the body; the router prefers a path id over it. */
  g?: string;
  /** Resolved positive integer — safe to hand straight to streamBuffers. */
  batchSize: number;
  /** The client's `bulkResults` request option (GraphBinary V4). When true the client
   *  expects a BULKED response: the `{bulked}` header byte set + each value followed by a
   *  fully-qualified `Long` multiplicity. Stock DriverRemoteConnection sends true by default
   *  and decodes the pairs back into Traverser(value, bulk); default false = today's flat
   *  frame, byte-identical. */
  bulked: boolean;
}

/** Decode a fully-qualified GraphBinary value AND its type, recursing through
 *  containers to any depth — the wire truth captured whole (a typed client's
 *  UUID/datetime/long survives; a JS client that serialized it as String simply
 *  yields that type). Scalars delegate to the client's own serializers wholesale
 *  (reuse-first — we only peek the leading DataType byte); maps/lists/sets are
 *  hand-iterated so each element/entry type is captured, not consumed silently.
 *  Returns {value, TypeNode, bytes read}. */
async function decodeTyped(r: StreamReaderT): Promise<{ value: any; type: TypeNode | null }> {
  const typeCode = await r.readUInt8();
  if (typeCode === ioc.DataType.MAP) {
    const flag = await r.readUInt8();
    const entries: Record<string, MapEntryType | null> = {};
    if (flag === 0x01) return { value: null, type: { t: 'map', entries } }; // null map
    const count = await r.readInt32BE();
    const map = new Map<any, any>();
    for (let i = 0; i < count; i++) {
      // Decode the KEY through decodeTyped too (was bare anySerializer) so a typed/
      // non-string key (Map<UUID,…>, Map<Int,…>) keeps its type end-to-end (bug #3).
      const k = await decodeTyped(r);
      const v = await decodeTyped(r);
      map.set(k.value, v.value); entries[String(k.value)] = { key: k.type, value: v.type };
    }
    return { value: map, type: { t: 'map', entries } };
  }
  if (typeCode === ioc.DataType.LIST || typeCode === ioc.DataType.SET) {
    const t: 'list' | 'set' = typeCode === ioc.DataType.SET ? 'set' : 'list';
    const flag = await r.readUInt8();
    const items: (TypeNode | null)[] = [];
    if (flag === 0x01) return { value: null, type: { t, items } };
    const count = await r.readInt32BE();
    const arr: any[] = [];
    for (let i = 0; i < count; i++) {
      const el = await decodeTyped(r);
      arr.push(el.value); items.push(el.type);
    }
    return { value: t === 'set' ? new Set(arr) : arr, type: { t, items } };
  }
  // Any non-container FQ value — reuse the client serializers wholesale. We already consumed
  // the type byte to dispatch on it, so read the value flag and call deserializeValue (the
  // bare form); deserialize() would expect to read the type byte itself.
  const flag = await r.readUInt8();
  const serializers = ioc.serializers as Record<number, { deserializeValue(r: unknown, flag: number, code: number): Promise<any> }>;
  const value = flag === 0x01 ? null
    : await serializers[typeCode].deserializeValue(r, flag, typeCode);
  return { value, type: WIRE_TYPE_TO_NAME[typeCode] ?? null };
}

/** Decode the request's non-fully-qualified fields map (length-prefixed, no leading
 *  MAP byte — the shape the client sends), capturing the bound-param value types by
 *  decoding the bindings/parameters sub-map with decodeTyped (recursively typed). Every
 *  other field decodes normally via anySerializer. paramTypes keeps only the params the
 *  wire actually typed (unknown/absent → omitted, so the write seam infers). */
async function decodeFields(r: StreamReaderT): Promise<{ fields: Map<any, any>; paramTypes: Record<string, TypeNode> }> {
  const count = await r.readInt32BE();
  const fields = new Map<any, any>();
  const paramTypes: Record<string, TypeNode> = {};
  for (let i = 0; i < count; i++) {
    const k = await ioc.anySerializer.deserialize(r);
    if (k === 'bindings' || k === 'parameters') {
      const b = await decodeTyped(r);
      fields.set(k, b.value);
      if (b.type && typeof b.type === 'object' && b.type.t === 'map')
        for (const [key, e] of Object.entries(b.type.entries)) if (e?.value != null) paramTypes[key] = e.value;
    } else {
      fields.set(k, await ioc.anySerializer.deserialize(r));
    }
  }
  return { fields, paramTypes };
}

export async function parseRequest(raw: Buffer): Promise<ParsedQuery> {
  let gremlin: string;
  let params: Record<string, any>;
  let paramTypes: Record<string, TypeNode> = {};
  let g: string | undefined;
  let rawBatch: any;
  let bulked = false;
  if (raw[0] === 0x84) {
    // GraphBinary request: 0x84, fields map (bare), gremlin string (bare). The client's
    // deserializers pull from a StreamReader (async since the response-streaming rework,
    // apache/tinkerpop#3395); fromBuffer wraps a COMPLETE buffer, so every read resolves
    // from memory with no I/O — the reader just owns the cursor we used to advance by hand.
    const r = StreamReader.fromBuffer(raw.subarray(1)) as StreamReaderT;
    const { fields, paramTypes: pt } = await decodeFields(r);
    paramTypes = pt;
    // BARE (not fully-qualified) — the request writes the gremlin string with no leading
    // type byte, so deserializeValue, not deserialize (which would demand one).
    gremlin = await ioc.stringSerializer.deserializeValue(r, 0x00, ioc.DataType.STRING);
    const bindings = fields?.get?.('bindings') ?? fields?.get?.('parameters') ?? {};
    params = bindings instanceof Map ? Object.fromEntries(bindings) : bindings;
    g = fields?.get?.('g');
    rawBatch = fields?.get?.('batchSize') ?? fields?.get?.('resultIterationBatchSize');
    bulked = fields?.get?.('bulkResults') === true;
  } else {
    const msg = JSON.parse(raw.toString('utf8'));
    gremlin = msg.gremlin;
    params = msg.parameters ?? msg.bindings ?? {};
    g = msg.g;
    rawBatch = msg.batchSize ?? msg.resultIterationBatchSize;
    bulked = msg.bulkResults === true;
  }
  // batchSize wins over resultIterationBatchSize; 0 / negative / non-numeric → default.
  const n = Number(rawBatch);
  return { gremlin, params, paramTypes, g, batchSize: n > 0 ? n : DEFAULT_BATCH_SIZE, bulked };
}
