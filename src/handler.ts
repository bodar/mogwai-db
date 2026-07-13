import { compile, type MapEntry, type ElemShape, type GroupKey, type GroupVal, type PathPos, type ValueType } from './compiler.ts';
import type { GraphStore } from './storage.ts';
import { ioc, VertexProperty, Property, t } from './io.ts';

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

// properties(): a standalone VertexProperty element per (owner, key, value) row.
// Synthetic id (owner:key) — we don't persist per-property ids; scenario
// comparison keys on key+value+owning element, not on this id.
function propertyBuffer(owner: number, key: string, value: any): Buffer {
  return ioc.anySerializer.serialize(new VertexProperty(`${owner}:${key}`, key, value, []));
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
      ? elementBuffer(row, e.prefix, 'vertex')
      : ioc.anySerializer.serialize(row[`${e.prefix}_v`]));
  }
  return Buffer.concat(parts);
}

// A GraphBinary LIST framed by hand (mirrors ArraySerializer) so element items
// go through vertexBuffer/edgeBuffer — routing them via listSerializer→
// anySerializer would drop their props (same client-serializer bug).
function listBuffer(items: Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from([ioc.DataType.LIST, 0x00]),
    ioc.intSerializer.serialize(items.length, false),
    ...items,
  ]);
}

// Frame a vertex/edge from a plain (unprefixed) result row — the id/label/props
// (+ src/tgt) projection the vertex/edge/list shapes share.
const rowVertex = (r: any): Buffer => vertexBuffer(r.id, r.label, JSON.parse(r.props));
const rowEdge = (r: any): Buffer => edgeBuffer(r.id, r.label, r.src, r.tgt, JSON.parse(r.props));

// Frame one element (vertex/edge/property) from prefixed columns (k_* / v_*).
function elementBuffer(r: any, prefix: string, elem: ElemShape): Buffer {
  if (elem === 'edge') return edgeBuffer(r[`${prefix}_id`], r[`${prefix}_label`], r[`${prefix}_src`], r[`${prefix}_tgt`], JSON.parse(r[`${prefix}_props`]));
  if (elem === 'property') return propertyBuffer(r[`${prefix}_owner`], r[`${prefix}_pk`], r[`${prefix}_pv`]);
  return vertexBuffer(r[`${prefix}_id`], r[`${prefix}_label`], JSON.parse(r[`${prefix}_props`]));
}

// path(): one GraphBinary Path per row (mirrors PathSerializer). {objects} is
// hand-framed via listBuffer so element positions go through vertexBuffer/edgeBuffer
// (routing them via anySerializer would drop props — the same client bug). {labels}
// rides as one empty Set per position (labels-on-path deferred); it's plain data
// (empty Sets), so listSerializer handles it directly.
function framePath(objects: Buffer[]): Buffer {
  const labels = objects.map(() => new Set<string>()); // labels-on-path deferred → one empty Set per object
  return Buffer.concat([
    Buffer.from([ioc.DataType.PATH, 0x00]),
    ioc.listSerializer.serialize(labels), // {labels}: List<Set<String>>
    listBuffer(objects),                  // {objects}: List of framed, fully-qualified values
  ]);
}

// Linear path(): one row → one Path, positions framed from per-position columns.
function pathBuffer(r: any, positions: PathPos[]): Buffer {
  return framePath(positions.map((pos) =>
    pos.render === 'element' ? elementBuffer(r, pos.prefix, pos.elem) : ioc.anySerializer.serialize(r[`${pos.prefix}_v`])));
}

// Recursive repeat().path(): rows arrive ORDER BY (pk, ord) — one row per path
// element, runs of equal pk being one path. Fold each pk-run into a Path.
function pathGroupedBuffers(rows: any[], elem: ElemShape): Buffer[] {
  const frame = elem === 'edge' ? rowEdge : rowVertex;
  const out: Buffer[] = [];
  let objs: Buffer[] = [];
  let curPk: any;
  for (const r of rows) {
    if (r.pk !== curPk) { if (objs.length) out.push(framePath(objs)); objs = []; curPk = r.pk; }
    objs.push(frame(r));
  }
  if (objs.length) out.push(framePath(objs));
  return out;
}

// A summed numeric, framed to match SQLite's storage class of the SUM (passed as
// typeof(): 'real' → Double even when whole, e.g. 1.0; 'integer' → Int/Long by
// magnitude via NumberSerializationStrategy). Mirrors TinkerPop sum() typing —
// int props sum to Int/Long (d[123].i), double props to Double (d[1.0].d).
function sumBuffer(v: number, storageClass: string): Buffer {
  return storageClass === 'real' ? ioc.doubleSerializer.serialize(v, true) : ioc.anySerializer.serialize(v);
}

// A scalar value(), framed by its compile-time type tag (Shape `as`) when set — the
// GraphBinary type comes from the producing step, not the SQLite storage class. No
// tag → infer from the JS value (anySerializer). 'bool': SQLite carries the boolean
// as 0/1, so frame Boolean(v) explicitly (anySerializer would otherwise emit Int).
function frameValue(v: any, as: ValueType | undefined): Buffer {
  if (as === 'bool') return ioc.booleanSerializer.serialize(Boolean(v), true);
  return ioc.anySerializer.serialize(v);
}

// The GraphBinary key + a canonical string (JS Map dedup key) for one group row.
function groupKey(r: any, key: GroupKey): { buf: Buffer; canon: string } {
  if (key.kind === 'element') return { buf: elementBuffer(r, 'k', key.elem), canon: `e:${r[key.elem === 'property' ? 'k_pk' : 'k_id']}` };
  if (key.kind === 'map') {
    const m = new Map<any, any>();
    key.parts.forEach((p, i) => m.set(p.key, r[`k${i}_v`]));
    return { buf: ioc.anySerializer.serialize(m), canon: 'm:' + key.parts.map((_, i) => JSON.stringify(r[`k${i}_v`])).join(' ') };
  }
  return { buf: ioc.anySerializer.serialize(r.gk), canon: 's:' + JSON.stringify(r.gk) };
}

// group()/groupCount(): fold ALL rows into ONE GraphBinary Map. Element-valued
// groups arrive ORDER BY key (runs of same-key rows); scalar-reducer groups
// arrive one row per group (GROUP BY). One loop keyed on GroupVal handles both.
function groupBuffer(rows: any[], key: GroupKey, val: GroupVal): Buffer {
  const groups = new Map<string, { buf: Buffer; members: Buffer[]; gv: any; gvt: string }>();
  for (const r of rows) {
    // A scalar key over a missing property is SQL NULL — TinkerPop's by(key) uses
    // values(key), which yields nothing, so such elements form NO group (not a
    // spurious null-keyed one). Drop them here (covers both GROUP BY and ORDER BY paths).
    if (key.kind === 'scalar' && r.gk == null) continue;
    const k = groupKey(r, key);
    let g = groups.get(k.canon);
    if (!g) { g = { buf: k.buf, members: [], gv: undefined, gvt: '' }; groups.set(k.canon, g); }
    if (val.kind === 'elementList' || val.kind === 'elementLast') g.members.push(elementBuffer(r, 'v', val.elem));
    else { g.gv = r.gv; g.gvt = r.gvt; } // count/sum/scalarList: precomputed, one row per group
  }
  const valueBuf = (g: { members: Buffer[]; gv: any; gvt: string }): Buffer => {
    switch (val.kind) {
      case 'elementList': return listBuffer(g.members);
      case 'elementLast': return g.members[g.members.length - 1];
      case 'count': return ioc.anySerializer.serialize(BigInt(g.gv));
      case 'sum': return sumBuffer(g.gv, g.gvt);
      // by('age')/by(__.values) filters members missing the property (values
      // semantics) → drop the SQL NULLs json_group_array emitted for them.
      case 'scalarList': return ioc.listSerializer.serialize(JSON.parse(g.gv).filter((x: any) => x !== null));
    }
  };
  const parts: Buffer[] = [Buffer.from([ioc.DataType.MAP, 0x00]), ioc.intSerializer.serialize(groups.size, false)];
  for (const g of groups.values()) { parts.push(g.buf, valueBuf(g)); }
  return Buffer.concat(parts);
}

function execute(store: GraphStore, gremlin: string, params: Record<string, any>): Buffer[] {
  const plan = compile(gremlin, params);
  if (plan.kind === 'write') {
    return plan.run(store).map((r: any) => {
      if (r.vertex) return vertexBuffer(r.vertex.id, r.vertex.label, r.vertex.props);
      const e = r.edge;
      // Frame via edgeBuffer so edge properties materialize — routing through
      // anySerializer's EdgeSerializer drops them (same client bug edgeBuffer works around).
      return edgeBuffer(e.id, e.label, e.src, e.tgt, e.props ?? {});
    });
  }
  // Self-tuning: ensure an expression index for each hot property key the plan
  // filters/orders on, so the first filtered use of a key pays the one-time
  // build and every subsequent query is an index seek.
  for (const key of plan.indexKeys ?? []) store.ensureNodePropIndex(key);
  const rows = store.query(plan.sql, plan.binds) as any[];
  const shape = plan.shape;
  switch (shape.kind) {
    case 'vertex': return rows.map(rowVertex);
    case 'edge': return rows.map(rowEdge);
    case 'valueMap': return rows.map((r) => valueMapBuffer(r.id, r.label, JSON.parse(r.props), shape.keys, shape.tokens));
    case 'elementMap': return rows.map((r) => elementMapBuffer(r.id, r.label, JSON.parse(r.props), shape.keys));
    case 'count': return rows.map((r) => ioc.anySerializer.serialize(BigInt(r.v)));
    case 'value': return rows.map((r) => frameValue(r.v, shape.as));
    // sum(): Int/Long/Double by SQLite storage class. SUM of an empty stream is
    // NULL → no result (TinkerPop yields nothing, matching SQL sum aggregation).
    case 'scalar': return rows.filter((r) => r.v !== null).map((r) => sumBuffer(r.v, r.vt));
    case 'map': return rows.map((r) => mapBuffer(r, shape.entries));
    case 'path': return rows.map((r) => pathBuffer(r, shape.positions));
    case 'pathGrouped': return pathGroupedBuffers(rows, shape.elem);
    case 'property': return rows.map((r) => propertyBuffer(r.owner, r.pk, r.pv));
    // Barriers: the whole stream collapses to ONE value (Map / List).
    case 'group': return [groupBuffer(rows, shape.key, shape.val)];
    case 'list': {
      // fold() reuses the plain vertex/edge projection (unprefixed id/label/…),
      // unlike group's v_-prefixed element columns.
      if (shape.elem === 'scalar') return [ioc.listSerializer.serialize(rows.map((r) => r.v))];
      return [listBuffer(rows.map(shape.elem === 'edge' ? rowEdge : rowVertex))];
    }
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
