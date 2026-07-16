// Concern A — wire parsing, at the edge. Sniff the request shape (GraphBinary vs
// JSON), pull out the gremlin string, bindings, the traversal-source name (`g`),
// and resolve the chunk batch size. This is the ONLY place the request body is
// decoded; the router uses `g` as the graph-selector fallback when the URL path
// carries none, and passes {gremlin, params} across the manager seam to the store
// tier (concern B). No compilation, no store, no HTTP here.
import { ioc } from './io.ts';
import { WIRE_TYPE_TO_NAME } from './gremlin-types.ts';

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
  paramTypes: Record<string, string>;
  /** Traversal-source name from the body; the router prefers a path id over it. */
  g?: string;
  /** Resolved positive integer — safe to hand straight to streamBuffers. */
  batchSize: number;
}

/** A fully-qualified GraphBinary map, additionally recording each VALUE's leading
 *  DataType code → canonical type name. Mirrors the client's MapSerializer.deserialize
 *  loop (value decode still delegates to the client serializers — we only read the
 *  extra type-code byte, the same reuse-first-fix-deficiencies posture as the rest of
 *  the wire layer). Returns the decoded Map, the per-key value types, and bytes read. */
function decodeMapWithValueTypes(buf: Buffer): { map: Map<any, any>; types: Record<string, string>; len: number } {
  let cursor = buf, len = 0;
  const typeCode = cursor.readUInt8(); len += 1; cursor = cursor.subarray(1);
  if (typeCode !== ioc.DataType.MAP) throw new Error('bindings: expected a GraphBinary map');
  const flag = cursor.readUInt8(); len += 1; cursor = cursor.subarray(1);
  const map = new Map<any, any>();
  const types: Record<string, string> = {};
  if (flag === 0x01) return { map, types, len }; // null map
  const { v: count, len: clen } = ioc.intSerializer.deserialize(cursor, false);
  cursor = cursor.subarray(clen); len += clen;
  for (let i = 0; i < count; i++) {
    const k = ioc.anySerializer.deserialize(cursor); cursor = cursor.subarray(k.len); len += k.len;
    const valTypeCode = cursor.readUInt8();
    const val = ioc.anySerializer.deserialize(cursor); cursor = cursor.subarray(val.len); len += val.len;
    map.set(k.v, val.v);
    const name = WIRE_TYPE_TO_NAME[valTypeCode];
    if (name) types[String(k.v)] = name;
  }
  return { map, types, len };
}

/** Decode the request's non-fully-qualified fields map (length-prefixed, no leading
 *  MAP byte — the shape the client sends), capturing the bound-param value types by
 *  decoding the bindings/parameters sub-map with decodeMapWithValueTypes. Every other
 *  field decodes normally via anySerializer. */
function decodeFields(buf: Buffer): { fields: Map<any, any>; paramTypes: Record<string, string>; len: number } {
  let cursor = buf, len = 0;
  const { v: count, len: clen } = ioc.intSerializer.deserialize(cursor, false);
  cursor = cursor.subarray(clen); len += clen;
  const fields = new Map<any, any>();
  let paramTypes: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const k = ioc.anySerializer.deserialize(cursor); cursor = cursor.subarray(k.len); len += k.len;
    if (k.v === 'bindings' || k.v === 'parameters') {
      const b = decodeMapWithValueTypes(cursor);
      fields.set(k.v, b.map); paramTypes = b.types;
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
  let paramTypes: Record<string, string> = {};
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
