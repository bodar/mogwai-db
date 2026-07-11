import { compile } from './compiler.js';
import type { GraphStore } from './storage.js';
import { ioc, Vertex, VertexProperty, Edge } from './io.js';

// ---- GraphBinary v4 response framing (mirrors GraphBinaryReader.readResponse) ----
function frame(values: Buffer[], status = 200, message: string | null = null): Buffer {
  const parts: Buffer[] = [Buffer.from([0x84, 0x00])]; // version, bulked=false
  parts.push(...values);
  parts.push(Buffer.from([0xfd, 0x00, 0x00])); // end-of-stream marker
  parts.push(ioc.intSerializer.serialize(status, false)); // status code, bare int
  if (message !== null) {
    parts.push(Buffer.from([0x00]), ioc.stringSerializer.serialize(message, false));
  } else {
    parts.push(Buffer.from([0x01])); // null message
  }
  parts.push(Buffer.from([0x01])); // null exception
  return Buffer.concat(parts);
}

function toVertex(id: number, label: string, props: Record<string, any>): InstanceType<typeof Vertex> {
  let pid = 0;
  const vprops = Object.entries(props).map(
    ([k, v]) => new VertexProperty(`${id}.${pid++}`, k, v, []),
  );
  return new Vertex(id, label, vprops);
}

function execute(store: GraphStore, gremlin: string, params: Record<string, any>): Buffer[] {
  const plan = compile(gremlin, params);
  if (plan.kind === 'write') {
    return plan.run(store).map((r: any) => {
      if (r.vertex) return ioc.anySerializer.serialize(
        toVertex(r.vertex.id, r.vertex.label, r.vertex.props));
      const e = r.edge;
      return ioc.anySerializer.serialize(
        new Edge(e.id, new Vertex(e.src, '', null), e.label, new Vertex(e.tgt, '', null), []));
    });
  }
  const rows = store.query(plan.sql, plan.binds) as any[];
  switch (plan.shape.kind) {
    case 'vertex': return rows.map((r) => ioc.anySerializer.serialize(toVertex(r.id, r.label, JSON.parse(r.props))));
    case 'count': return rows.map((r) => ioc.anySerializer.serialize(BigInt(r.v)));
    case 'value': return rows.map((r) => ioc.anySerializer.serialize(r.v));
    case 'discard': return [];
  }
}

/**
 * The runtime-agnostic request handler: sniff JSON/GraphBinary, compile,
 * execute against the injected store, frame the GraphBinary v4 response.
 * Returns a Web-standard Response, so it drops straight into both `Bun.serve`
 * and a Durable Object `fetch`.
 */
export function makeHandler(store: GraphStore): (req: Request) => Promise<Response> {
  return async function handler(req: Request): Promise<Response> {
    let gremlinForLog = '?';
    let body: Buffer;
    try {
      const raw = Buffer.from(await req.arrayBuffer());
      let msg: { gremlin: string; parameters?: Record<string, any> };
      if (raw[0] === 0x84) {
        // GraphBinary request: 0x84, fields map (bare), gremlin string (bare)
        let cursor = raw.subarray(1);
        const { v: fields, len } = ioc.mapSerializer.deserialize(cursor, false);
        cursor = cursor.subarray(len);
        const { v: gremlin } = ioc.stringSerializer.deserialize(cursor, false);
        const bindings = fields.get?.('bindings') ?? fields.get?.('parameters') ?? {};
        msg = { gremlin, parameters: bindings instanceof Map ? Object.fromEntries(bindings) : bindings };
      } else {
        msg = JSON.parse(raw.toString('utf8'));
      }
      gremlinForLog = msg.gremlin;
      const values = execute(store, msg.gremlin, msg.parameters ?? {});
      body = frame(values);
      console.log(`OK   ${msg.gremlin} -> ${values.length} result(s)`);
    } catch (e: any) {
      body = frame([], 500, e.message);
      console.log(`ERR  [${gremlinForLog}] ${e.message}`);
    }
    // Always HTTP 200; errors ride the GraphBinary status trailer.
    return new Response(body, {
      headers: { 'Content-Type': 'application/vnd.graphbinary-v4.0' },
    });
  };
}
