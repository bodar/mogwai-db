import http from 'node:http';
import { GraphStore } from './storage.js';
import { compile } from './compiler.js';

// Reuse the Apache-2.0 GraphBinary implementation shipped in the gremlin client package.
const ESM = 'file://' + process.cwd() + '/node_modules/gremlin/build/esm/';
const ioc = (await import(ESM + 'structure/io/binary/GraphBinary.js')).default;
const { Vertex, VertexProperty, Edge } = await import(ESM + 'structure/graph.js');

const store = new GraphStore(process.env.MOGWAI_DB ?? ':memory:');

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

function toVertex(row: { id: number; label: string; props: string }): InstanceType<typeof Vertex> {
  const props = JSON.parse(row.props);
  let pid = 0;
  const vprops = Object.entries(props).map(
    ([k, v]) => new VertexProperty(`${row.id}.${pid++}`, k, v, []),
  );
  return new Vertex(row.id, row.label, vprops);
}

function execute(gremlin: string, params: Record<string, any>): Buffer[] {
  const plan = compile(gremlin, params);
  if (plan.kind === 'write') {
    return plan.run(store).map((r: any) => {
      if (r.vertex) return ioc.anySerializer.serialize(
        toVertex({ id: r.vertex.id, label: r.vertex.label, props: JSON.stringify(r.vertex.props) }));
      const e = r.edge;
      return ioc.anySerializer.serialize(
        new Edge(e.id, new Vertex(e.src, '', null), e.label, new Vertex(e.tgt, '', null), []));
    });
  }
  const rows = store.db.prepare(plan.sql).all(...plan.binds) as any[];
  switch (plan.shape.kind) {
    case 'vertex': return rows.map((r) => ioc.anySerializer.serialize(toVertex(r)));
    case 'count': return rows.map((r) => ioc.anySerializer.serialize(BigInt(r.v)));
    case 'value': return rows.map((r) => ioc.anySerializer.serialize(r.v));
    case 'discard' as any: return [];
  }
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on("end", () => {
    let gremlinForLog = "?";
    let body: Buffer;
    try {
      const raw = Buffer.concat(chunks);
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
      const values = execute(msg.gremlin, msg.parameters ?? {});
      body = frame(values);
      console.log(`OK   ${msg.gremlin} -> ${values.length} result(s)`);
    } catch (e: any) {
      body = frame([], 500, e.message);
      console.log(`ERR  [${gremlinForLog}] ${e.message}`);
    }
    res.writeHead(200, {
      'Content-Type': 'application/vnd.graphbinary-v4.0',
      'Content-Length': body.length,
    });
    res.end(body);
  });
});

server.listen(8182, () => console.log('mogwai-db listening on :8182'));
