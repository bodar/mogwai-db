// Concern A — wire parsing, at the edge. Sniff the request shape (GraphBinary vs
// JSON), pull out the gremlin string, bindings, the traversal-source name (`g`),
// and resolve the chunk batch size. This is the ONLY place the request body is
// decoded; the router uses `g` as the graph-selector fallback when the URL path
// carries none, and passes {gremlin, params} across the manager seam to the store
// tier (concern B). No compilation, no store, no HTTP here.
import { ioc } from './io.ts';
import { WIRE_TYPE_TO_NAME, type TypeNode } from './gremlin-types.ts';

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
}

/** Decode a fully-qualified GraphBinary value AND its type, recursing through
 *  containers to any depth — the wire truth captured whole (a typed client's
 *  UUID/datetime/long survives; a JS client that serialized it as String simply
 *  yields that type). Scalars delegate to the client's own serializers wholesale
 *  (reuse-first — we only peek the leading DataType byte); maps/lists/sets are
 *  hand-iterated so each element/entry type is captured, not consumed silently.
 *  Returns {value, TypeNode, bytes read}. */
function decodeTyped(buf: Buffer): { value: any; type: TypeNode | null; len: number } {
  let cursor = buf, len = 0;
  const typeCode = cursor.readUInt8();
  if (typeCode === ioc.DataType.MAP) {
    len += 1; cursor = cursor.subarray(1);
    const flag = cursor.readUInt8(); len += 1; cursor = cursor.subarray(1);
    const entries: Record<string, TypeNode | null> = {};
    if (flag === 0x01) return { value: null, type: { t: 'map', entries }, len }; // null map
    const { v: count, len: clen } = ioc.intSerializer.deserialize(cursor, false);
    cursor = cursor.subarray(clen); len += clen;
    const map = new Map<any, any>();
    for (let i = 0; i < count; i++) {
      const k = ioc.anySerializer.deserialize(cursor); cursor = cursor.subarray(k.len); len += k.len;
      const v = decodeTyped(cursor); cursor = cursor.subarray(v.len); len += v.len;
      map.set(k.v, v.value); entries[String(k.v)] = v.type;
    }
    return { value: map, type: { t: 'map', entries }, len };
  }
  if (typeCode === ioc.DataType.LIST || typeCode === ioc.DataType.SET) {
    const t: 'list' | 'set' = typeCode === ioc.DataType.SET ? 'set' : 'list';
    len += 1; cursor = cursor.subarray(1);
    const flag = cursor.readUInt8(); len += 1; cursor = cursor.subarray(1);
    const items: (TypeNode | null)[] = [];
    if (flag === 0x01) return { value: null, type: { t, items }, len };
    const { v: count, len: clen } = ioc.intSerializer.deserialize(cursor, false);
    cursor = cursor.subarray(clen); len += clen;
    const arr: any[] = [];
    for (let i = 0; i < count; i++) {
      const el = decodeTyped(cursor); cursor = cursor.subarray(el.len); len += el.len;
      arr.push(el.value); items.push(el.type);
    }
    return { value: t === 'set' ? new Set(arr) : arr, type: { t, items }, len };
  }
  // Any non-container FQ value — reuse the client serializers wholesale.
  const val = ioc.anySerializer.deserialize(cursor);
  return { value: val.v, type: WIRE_TYPE_TO_NAME[typeCode] ?? null, len: val.len };
}

/** Decode the request's non-fully-qualified fields map (length-prefixed, no leading
 *  MAP byte — the shape the client sends), capturing the bound-param value types by
 *  decoding the bindings/parameters sub-map with decodeTyped (recursively typed). Every
 *  other field decodes normally via anySerializer. paramTypes keeps only the params the
 *  wire actually typed (unknown/absent → omitted, so the write seam infers). */
function decodeFields(buf: Buffer): { fields: Map<any, any>; paramTypes: Record<string, TypeNode>; len: number } {
  let cursor = buf, len = 0;
  const { v: count, len: clen } = ioc.intSerializer.deserialize(cursor, false);
  cursor = cursor.subarray(clen); len += clen;
  const fields = new Map<any, any>();
  const paramTypes: Record<string, TypeNode> = {};
  for (let i = 0; i < count; i++) {
    const k = ioc.anySerializer.deserialize(cursor); cursor = cursor.subarray(k.len); len += k.len;
    if (k.v === 'bindings' || k.v === 'parameters') {
      const b = decodeTyped(cursor);
      fields.set(k.v, b.value);
      if (b.type && typeof b.type === 'object' && b.type.t === 'map')
        for (const [key, tn] of Object.entries(b.type.entries)) if (tn != null) paramTypes[key] = tn;
      cursor = cursor.subarray(b.len); len += b.len;
    } else {
      const val = ioc.anySerializer.deserialize(cursor); cursor = cursor.subarray(val.len); len += val.len;
      fields.set(k.v, val.v);
    }
  }
  return { fields, paramTypes, len };
}

export function parseRequest(raw: Buffer): ParsedQuery {
  let gremlin: string;
  let params: Record<string, any>;
  let paramTypes: Record<string, TypeNode> = {};
  let g: string | undefined;
  let rawBatch: any;
  if (raw[0] === 0x84) {
    // GraphBinary request: 0x84, fields map (bare), gremlin string (bare).
    let cursor = raw.subarray(1);
    const { fields, paramTypes: pt, len } = decodeFields(cursor);
    paramTypes = pt;
    cursor = cursor.subarray(len);
    ({ v: gremlin } = ioc.stringSerializer.deserialize(cursor, false));
    const bindings = fields?.get?.('bindings') ?? fields?.get?.('parameters') ?? {};
    params = bindings instanceof Map ? Object.fromEntries(bindings) : bindings;
    g = fields?.get?.('g');
    rawBatch = fields?.get?.('batchSize') ?? fields?.get?.('resultIterationBatchSize');
  } else {
    const msg = JSON.parse(raw.toString('utf8'));
    gremlin = msg.gremlin;
    params = msg.parameters ?? msg.bindings ?? {};
    g = msg.g;
    rawBatch = msg.batchSize ?? msg.resultIterationBatchSize;
  }
  // batchSize wins over resultIterationBatchSize; 0 / negative / non-numeric → default.
  const n = Number(rawBatch);
  return { gremlin, params, paramTypes, g, batchSize: n > 0 ? n : DEFAULT_BATCH_SIZE };
}
