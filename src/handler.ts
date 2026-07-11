import { compile, type MapEntry } from './compiler.ts';
import type { GraphStore } from './storage.ts';
import { ioc, Vertex, VertexProperty, Edge, Property, t } from './io.ts';

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

// Custom vertex framing to MATERIALIZE properties. The client's
// VertexSerializer.serialize() hardcodes an empty property list (the client
// never sends props), so routing a Vertex through anySerializer drops them.
// We frame the vertex from ioc primitives instead — its deserialize side reads
// properties fine. Per-property framing (id/label/value) is left to
// VertexPropertySerializer via the qualified list, which serializes correctly.
function vertexBuffer(id: number, label: string, props: Record<string, any>): Buffer {
  let pid = 0;
  const vprops = Object.entries(props).map(([k, v]) => new VertexProperty(`${id}.${pid++}`, k, v, []));
  return Buffer.concat([
    Buffer.from([ioc.DataType.VERTEX, 0x00]),
    ioc.anySerializer.serialize(id),            // {id}, fully qualified
    ioc.listSerializer.serialize([label], false), // {label}, bare list of one
    ioc.listSerializer.serialize(vprops, true),   // {properties}, qualified list
  ]);
}

// Custom edge framing to MATERIALIZE properties — EdgeSerializer.serialize
// hardcodes an empty property list, exactly like VertexSerializer. Wire layout
// (mirrors EdgeSerializer): id, {label} bare list, inV(=tgt) id + bare label
// list, outV(=src) id + bare label list, null parent, qualified property list.
// Endpoint labels ride empty (as the addE write path does); readers that need
// endpoint names traverse for them rather than read the embedded edge element.
function edgeBuffer(id: number, label: string, src: number, tgt: number, props: Record<string, any>): Buffer {
  const eprops = Object.entries(props).map(([k, v]) => new Property(k, v));
  return Buffer.concat([
    Buffer.from([ioc.DataType.EDGE, 0x00]),
    ioc.anySerializer.serialize(id),
    ioc.listSerializer.serialize([label], false),
    ioc.anySerializer.serialize(tgt),          // inV id
    ioc.listSerializer.serialize([], false),   // inV label (omitted)
    ioc.anySerializer.serialize(src),          // outV id
    ioc.listSerializer.serialize([], false),   // outV label (omitted)
    ioc.unspecifiedNullSerializer.serialize(null), // parent
    ioc.listSerializer.serialize(eprops, true),     // properties (qualified)
  ]);
}

// valueMap()/valueMap(true)/valueMap(keys...): Map<key, [values]>; with tokens,
// prepend the T.id/T.label entries (T tokens ride as GraphBinary DataType.T).
function valueMapBuffer(id: number, label: string, props: Record<string, any>,
                        keys: string[] | null, tokens: boolean): Buffer {
  const m = new Map<any, any>();
  if (tokens) { m.set(t.id, id); m.set(t.label, label); }
  for (const key of keys ?? Object.keys(props)) if (key in props) m.set(key, [props[key]]);
  return ioc.anySerializer.serialize(m);
}

// elementMap(): flat Map with scalar values; id/label tokens are ALWAYS present.
function elementMapBuffer(id: number, label: string, props: Record<string, any>,
                          keys: string[] | null): Buffer {
  const m = new Map<any, any>();
  m.set(t.id, id); m.set(t.label, label);
  for (const key of keys ?? Object.keys(props)) if (key in props) m.set(key, props[key]);
  return ioc.anySerializer.serialize(m);
}

// select(labels…)/project(keys…): one GraphBinary Map per row. Framed by hand
// (not via anySerializer on a JS Map) because vertex-valued entries must go
// through vertexBuffer — routing a Vertex through anySerializer drops its props
// (the same client-serializer bug vertexBuffer exists to work around). Layout
// mirrors MapSerializer: [MAP, 0x00], bare int32 count, then key/value pairs
// where each value is an already-fully-qualified buffer.
function mapBuffer(row: any, entries: MapEntry[]): Buffer {
  const parts: Buffer[] = [
    Buffer.from([ioc.DataType.MAP, 0x00]),
    ioc.intSerializer.serialize(entries.length, false),
  ];
  for (const e of entries) {
    parts.push(ioc.anySerializer.serialize(e.key));
    parts.push(e.sub === 'vertex'
      ? vertexBuffer(row[`${e.prefix}_id`], row[`${e.prefix}_label`], JSON.parse(row[`${e.prefix}_props`]))
      : ioc.anySerializer.serialize(row[`${e.prefix}_v`]));
  }
  return Buffer.concat(parts);
}

function execute(store: GraphStore, gremlin: string, params: Record<string, any>): Buffer[] {
  const plan = compile(gremlin, params);
  if (plan.kind === 'write') {
    return plan.run(store).map((r: any) => {
      if (r.vertex) return vertexBuffer(r.vertex.id, r.vertex.label, r.vertex.props);
      const e = r.edge;
      return ioc.anySerializer.serialize(
        new Edge(e.id, new Vertex(e.src, '', null), e.label, new Vertex(e.tgt, '', null), []));
    });
  }
  // Self-tuning: ensure an expression index for each hot property key the plan
  // filters/orders on, so the first filtered use of a key pays the one-time
  // build and every subsequent query is an index seek.
  for (const key of plan.indexKeys ?? []) store.ensureNodePropIndex(key);
  const rows = store.query(plan.sql, plan.binds) as any[];
  const shape = plan.shape;
  switch (shape.kind) {
    case 'vertex': return rows.map((r) => vertexBuffer(r.id, r.label, JSON.parse(r.props)));
    case 'edge': return rows.map((r) => edgeBuffer(r.id, r.label, r.src, r.tgt, JSON.parse(r.props)));
    case 'valueMap': return rows.map((r) => valueMapBuffer(r.id, r.label, JSON.parse(r.props), shape.keys, shape.tokens));
    case 'elementMap': return rows.map((r) => elementMapBuffer(r.id, r.label, JSON.parse(r.props), shape.keys));
    case 'count': return rows.map((r) => ioc.anySerializer.serialize(BigInt(r.v)));
    case 'value': return rows.map((r) => ioc.anySerializer.serialize(r.v));
    case 'map': return rows.map((r) => mapBuffer(r, shape.entries));
    case 'discard': return [];
  }
}

/**
 * A store, or a resolver that picks one from the request's traversal-source
 * name (the `g` field). Production injects a single `GraphStore` (tenancy is
 * routed at the Worker by URL path, per the locked decision). The dev
 * conformance harness injects a resolver so one server can host the several
 * named toy graphs the cucumber suite opens (gmodern, ggraph, ...).
 */
export type StoreSource = GraphStore | ((g: string) => GraphStore);

/**
 * The runtime-agnostic request handler: sniff JSON/GraphBinary, compile,
 * execute against the injected store, frame the GraphBinary v4 response.
 * Returns a Web-standard Response, so it drops straight into both `Bun.serve`
 * and a Durable Object `fetch`.
 */
export function makeHandler(source: StoreSource): (req: Request) => Promise<Response> {
  return async function handler(req: Request): Promise<Response> {
    let gremlinForLog = '?';
    let body: Buffer;
    try {
      const raw = Buffer.from(await req.arrayBuffer());
      let msg: { gremlin: string; parameters?: Record<string, any>; g?: string };
      if (raw[0] === 0x84) {
        // GraphBinary request: 0x84, fields map (bare), gremlin string (bare)
        let cursor = raw.subarray(1);
        const { v: fields, len } = ioc.mapSerializer.deserialize(cursor, false);
        cursor = cursor.subarray(len);
        const { v: gremlin } = ioc.stringSerializer.deserialize(cursor, false);
        const bindings = fields?.get?.('bindings') ?? fields?.get?.('parameters') ?? {};
        msg = { gremlin, g: fields?.get?.('g'), parameters: bindings instanceof Map ? Object.fromEntries(bindings) : bindings };
      } else {
        msg = JSON.parse(raw.toString('utf8'));
      }
      gremlinForLog = msg.gremlin;
      const store = typeof source === 'function' ? source(msg.g ?? 'g') : source;
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
