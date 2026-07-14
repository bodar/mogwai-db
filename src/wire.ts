// Concern A — wire parsing, at the edge. Sniff the request shape (GraphBinary vs
// JSON), pull out the gremlin string, bindings, the traversal-source name (`g`),
// and resolve the chunk batch size. This is the ONLY place the request body is
// decoded; the router uses `g` as the graph-selector fallback when the URL path
// carries none, and passes {gremlin, params} across the manager seam to the store
// tier (concern B). No compilation, no store, no HTTP here.
import { ioc } from './io.ts';

// TinkerPop's default resultIterationBatchSize — governs only HTTP chunk pacing
// (how many value buffers concat per stream pull), never a protocol boundary.
const DEFAULT_BATCH_SIZE = 64;

export interface ParsedQuery {
  gremlin: string;
  params: Record<string, any>;
  /** Traversal-source name from the body; the router prefers a path id over it. */
  g?: string;
  /** Resolved positive integer — safe to hand straight to streamBuffers. */
  batchSize: number;
}

export function parseRequest(raw: Buffer): ParsedQuery {
  let gremlin: string;
  let params: Record<string, any>;
  let g: string | undefined;
  let rawBatch: any;
  if (raw[0] === 0x84) {
    // GraphBinary request: 0x84, fields map (bare), gremlin string (bare).
    let cursor = raw.subarray(1);
    const { v: fields, len } = ioc.mapSerializer.deserialize(cursor, false);
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
  return { gremlin, params, g, batchSize: n > 0 ? n : DEFAULT_BATCH_SIZE };
}
