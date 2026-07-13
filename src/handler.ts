import { compile, type MapEntry, type ElemShape, type GroupKey, type GroupVal, type PathPos, type ValueType } from './compiler.ts';
import type { GraphStore } from './storage.ts';
import { ioc, VertexProperty, Property, t } from './io.ts';

// ---- GraphBinary v4 response framing (mirrors GraphBinaryReader.readResponse) ----
// The response is ONE logical frame — `HEADER | value* | trailer` — regardless of
// how many HTTP chunks carry it (v4 chunking splits this same byte stream across
// chunks; the client reassembles via arrayBuffer() and reads it once). Split into
// header/trailer so the streaming path can emit the header first, then values in
// batches, then the trailer last — while `frame()` still builds the whole thing in
// one shot for the pre-stream error path.
const HEADER = Buffer.from([0x84, 0x00]); // version, bulked=false
const CONTENT_TYPE = 'application/vnd.graphbinary-v4.0';
// TinkerPop's default resultIterationBatchSize. Governs only how many value
// buffers get concatenated into one enqueue() (HTTP chunk pacing) — NOT a
// protocol boundary; the v4 wire is one logical frame however it's chunked.
const DEFAULT_BATCH_SIZE = 64;

function frameTrailer(status = 200, message: string | null = null): Buffer {
  const parts: Buffer[] = [
    Buffer.from([0xfd, 0x00, 0x00]),         // end-of-stream marker
    ioc.intSerializer.serialize(status, false), // status code, bare int
  ];
  if (message !== null) {
    parts.push(Buffer.from([0x00]), ioc.stringSerializer.serialize(message, false));
  } else {
    parts.push(Buffer.from([0x01])); // null message
  }
  parts.push(Buffer.from([0x01])); // null exception
  return Buffer.concat(parts);
}

// The pre-stream error path builds the whole frame in one shot: an error carries no
// result values, just HEADER + the status trailer (values only ever stream, via
// streamResponse — nothing threads a non-empty value list through here).
function errorFrame(status: number, message: string): Buffer {
  return Buffer.concat([HEADER, frameTrailer(status, message)]);
}

// Custom vertex framing to MATERIALIZE properties. The client's
// VertexSerializer.serialize() hardcodes an empty property list (the client
// never sends props), so routing a Vertex through anySerializer drops them.
// We frame the vertex from ioc primitives instead — its deserialize side reads
// properties fine. Per-property framing (id/label/value) is left to
// VertexPropertySerializer via the qualified list, which serializes correctly.
// props is {key: [value, …]} — one VertexProperty per value (multi-property). The id
// is synthetic (owner.ordinal); scenarios compare on key+value+owner, not this id.
function vertexBuffer(id: number, label: string, props: Record<string, any[]>): Buffer {
  let pid = 0;
  const vprops = Object.entries(props).flatMap(([k, vs]) => vs.map((v) => new VertexProperty(`${id}.${pid++}`, k, v, [])));
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
// Synthetic id (owner:key) — used by the group/select element paths that don't carry
// a real vpid or meta.
function propertyBuffer(owner: number, key: string, value: any): Buffer {
  return ioc.anySerializer.serialize(new VertexProperty(`${owner}:${key}`, key, value, []));
}

// A VertexProperty WITH its meta-properties, hand-framed — the client's
// VertexPropertySerializer.serialize() hardcodes an empty {properties} list (same bug
// as Vertex/Edge), so routing through anySerializer would drop the meta. Layout mirrors
// VertexPropertySerializer: id, {label}=[key] bare, value, null parent, qualified meta
// list. `Property`'s own serializer is not buggy, so meta items frame via listSerializer.
function vertexPropertyBuffer(id: any, key: string, value: any, meta: Record<string, any> | null): Buffer {
  const metaProps = meta ? Object.entries(meta).map(([k, v]) => new Property(k, v)) : [];
  return Buffer.concat([
    Buffer.from([ioc.DataType.VERTEXPROPERTY, 0x00]),
    ioc.anySerializer.serialize(id),
    ioc.listSerializer.serialize([key], false),
    ioc.anySerializer.serialize(value),
    ioc.unspecifiedNullSerializer.serialize(null), // parent
    ioc.listSerializer.serialize(metaProps, true), // {properties} = meta, qualified
  ]);
}

// valueMap()/valueMap(true)/valueMap(keys...): Map<key, [values]>; with tokens,
// prepend the T.id/T.label entries (T tokens ride as GraphBinary DataType.T).
// props is {key:[values]} (multi-valued). valueMap → Map<key, [values]>; with tokens,
// prepend the T.id/T.label entries (T tokens ride as GraphBinary DataType.T).
function valueMapBuffer(id: number, label: string, props: Record<string, any[]>,
                        keys: string[] | null, tokens: boolean): Buffer {
  const m = new Map<any, any>();
  if (tokens) { m.set(t.id, id); m.set(t.label, label); }
  for (const key of keys ?? Object.keys(props)) if (key in props) m.set(key, props[key]);
  return ioc.anySerializer.serialize(m);
}

// elementMap(): flat Map with ONE value per key (first under multi); id/label tokens
// are ALWAYS present.
function elementMapBuffer(id: number, label: string, props: Record<string, any[]>,
                          keys: string[] | null): Buffer {
  const m = new Map<any, any>();
  m.set(t.id, id); m.set(t.label, label);
  for (const key of keys ?? Object.keys(props)) if (key in props) m.set(key, props[key][0]);
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
  switch (as) {
    case undefined: return ioc.anySerializer.serialize(v);
    case 'bool': return ioc.booleanSerializer.serialize(Boolean(v), true);
    case 'byte': return ioc.byteSerializer.serialize(Number(v), true);
    case 'short': return ioc.shortSerializer.serialize(Number(v), true);
    case 'int': return ioc.intSerializer.serialize(Number(v), true);
    // Long/BigInteger take a BigInt; SQLite hands back a JS number (or bigint) for
    // the reachable magnitudes — coerce through BigInt either way.
    case 'long': return ioc.longSerializer.serialize(BigInt(v), true);
    case 'bigint': return ioc.bigIntegerSerializer.serialize(BigInt(v), true);
    case 'float': return ioc.floatSerializer.serialize(Number(v), true);
    case 'double': return ioc.doubleSerializer.serialize(Number(v), true);
    // Datetime is carried as epoch-millis (INTEGER); the client's DateTimeSerializer
    // takes a JS Date (GraphBinary DATETIME 0x04, UTC wire), so reconstruct it here.
    case 'date': return ioc.dateTimeSerializer.serialize(new Date(Number(v)), true);
  }
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

// A generator over the result value buffers, so the response can stream: per-row
// shapes `yield` one buffer per row (framed lazily, over the already-materialized
// row array — never a live cursor, so it's safe to cross the ReadableStream's
// pull() awaits); barrier shapes (group/list) drain the array then yield their one
// value. The row array itself is fully materialized up front by store.query() — the
// memory the streaming path avoids is holding EVERY framed value buffer plus the
// final concat copy simultaneously (framed batches flush + GC as the stream drains,
// leaving only the row array + one in-flight batch resident). The DO SQLite cursor
// can't be held open across awaits for a stable snapshot, so true row-level laziness
// (which would also free the row array) isn't safe there — draining it synchronously
// via store.query() is deliberate, not an oversight.
function* execute(store: GraphStore, gremlin: string, params: Record<string, any>): Generator<Buffer> {
  const plan = compile(gremlin, params);
  if (plan.kind === 'write') {
    for (const r of plan.run(store)) {
      // Write responses carry a flat {key:value} prop bag; vertexBuffer wants
      // {key:[values]}, so wrap each value in a 1-list (single-cardinality write).
      if (r.vertex) yield vertexBuffer(r.vertex.id, r.vertex.label,
        Object.fromEntries(Object.entries(r.vertex.props as Record<string, any>).map(([k, v]) => [k, [v]])));
      else {
        const e = r.edge;
        // Frame via edgeBuffer so edge properties materialize — routing through
        // anySerializer's EdgeSerializer drops them (same client bug edgeBuffer works around).
        yield edgeBuffer(e.id, e.label, e.src, e.tgt, e.props ?? {});
      }
    }
    return;
  }
  const rows = store.query(plan.sql, plan.binds) as any[];
  const shape = plan.shape;
  switch (shape.kind) {
    case 'vertex': for (const r of rows) yield rowVertex(r); return;
    case 'edge': for (const r of rows) yield rowEdge(r); return;
    case 'valueMap': for (const r of rows) yield valueMapBuffer(r.id, r.label, JSON.parse(r.props), shape.keys, shape.tokens); return;
    case 'elementMap': for (const r of rows) yield elementMapBuffer(r.id, r.label, JSON.parse(r.props), shape.keys); return;
    case 'count': for (const r of rows) yield ioc.anySerializer.serialize(BigInt(r.v)); return;
    case 'value': for (const r of rows) yield frameValue(r.v, shape.as); return;
    // sum(): Int/Long/Double by SQLite storage class. SUM of an empty stream is
    // NULL → no result (TinkerPop yields nothing, matching SQL sum aggregation).
    case 'scalar': for (const r of rows) if (r.v !== null) yield sumBuffer(r.v, r.vt); return;
    case 'map': for (const r of rows) yield mapBuffer(r, shape.entries); return;
    case 'path': for (const r of rows) yield pathBuffer(r, shape.positions); return;
    // pathGrouped folds pk-runs into Paths — a bounded fold, so yield each completed Path.
    case 'pathGrouped': yield* pathGroupedBuffers(rows, shape.elem); return;
    // A VertexProperty with its real id + meta-properties framed (vpid null on edges → synthetic).
    case 'property': for (const r of rows) yield vertexPropertyBuffer(r.vpid ?? `${r.owner}:${r.pk}`, r.pk, r.pv, r.pmeta ? JSON.parse(r.pmeta) : null); return;
    // properties().properties(): meta-properties as Property elements.
    case 'metaProperty': for (const r of rows) yield ioc.anySerializer.serialize(new Property(r.mk, r.mv)); return;
    // properties(k).valueMap(): a VertexProperty's meta as a flat Map.
    case 'metaMap': for (const r of rows) yield ioc.anySerializer.serialize(new Map(Object.entries(r.meta ? JSON.parse(r.meta) : {}))); return;
    // Barriers: the whole stream collapses to ONE value (Map / List).
    case 'group': yield groupBuffer(rows, shape.key, shape.val); return;
    case 'list': {
      // fold() reuses the plain vertex/edge projection (unprefixed id/label/…),
      // unlike group's v_-prefixed element columns.
      if (shape.elem === 'scalar') yield ioc.listSerializer.serialize(rows.map((r) => r.v));
      else yield listBuffer(rows.map(shape.elem === 'edge' ? rowEdge : rowVertex));
      return;
    }
    // A list-VALUE stream: one framed List per row (the `list` column arrives as JSON
    // text via json(), so it JSON.parses; scalar elements frame via listSerializer).
    case 'jsonbList': for (const r of rows) yield ioc.listSerializer.serialize(JSON.parse(r.list)); return;
    case 'discard': return;
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
 * Drive a result generator out as a chunked GraphBinary v4 response: emit the
 * HEADER, then value buffers concatenated `batchSize` at a time per pull(), then
 * the status trailer. The generator is primed by the caller (its first value is
 * `primed`) so that pre-stream errors — compile failures, bad SQL, the synchronous
 * cursor drain — have already surfaced as a thrown exception the caller turns into
 * a buffered error Response; by the time we're here, streaming has committed.
 *
 * A mid-stream throw (a later row failing to frame) flushes whatever's buffered,
 * writes a 500 trailer, and closes NORMALLY — never controller.error(), which would
 * abort the HTTP body into a truncated frame the client can't reassemble. Errors
 * always ride the trailer; HTTP stays 200. On client disconnect, cancel() returns
 * the generator so it (and the row array it closes over) can unwind.
 */
function streamResponse(
  gen: Generator<Buffer>,
  primed: IteratorResult<Buffer>,
  batchSize: number,
  onDone: (count: number, error?: string) => void,
): Response {
  let pending: IteratorResult<Buffer> | null = primed;
  let finished = false;
  let count = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(HEADER);
    },
    pull(controller) {
      if (finished) return;
      const batch: Buffer[] = [];
      try {
        while (batch.length < batchSize) {
          const step = pending ?? gen.next();
          pending = null;
          if (step.done) { finished = true; break; }
          batch.push(step.value);
          count++;
        }
      } catch (e: any) {
        finished = true;
        if (batch.length) controller.enqueue(Buffer.concat(batch));
        controller.enqueue(frameTrailer(500, e.message));
        controller.close();
        onDone(count, e.message);
        return;
      }
      if (batch.length) controller.enqueue(Buffer.concat(batch));
      if (finished) {
        controller.enqueue(frameTrailer(200, null));
        controller.close();
        onDone(count);
      }
    },
    cancel() {
      // Client disconnected mid-stream: return the generator so it (and the row
      // array it closes over) unwinds, and stop any further pull() work.
      finished = true;
      gen.return(undefined);
      onDone(count, 'stream cancelled by client');
    },
  });
  return new Response(stream, { headers: { 'Content-Type': CONTENT_TYPE } });
}

/**
 * The runtime-agnostic request handler: sniff JSON/GraphBinary, compile, execute
 * against the injected store, and stream the GraphBinary v4 response in
 * `batchSize`-paced chunks. Returns a Web-standard Response (streaming body), so it
 * drops straight into both `Bun.serve` and a Durable Object `fetch`.
 */
export function makeHandler(source: StoreSource): (req: Request) => Promise<Response> {
  const errorResponse = (message: string): Response =>
    new Response(errorFrame(500, message), { headers: { 'Content-Type': CONTENT_TYPE } });
  return async function handler(req: Request): Promise<Response> {
    let gremlinForLog = '?';
    try {
      const raw = Buffer.from(await req.arrayBuffer());
      let msg: { gremlin: string; parameters?: Record<string, any>; g?: string; batchSize?: number; resultIterationBatchSize?: number };
      if (raw[0] === 0x84) {
        // GraphBinary request: 0x84, fields map (bare), gremlin string (bare). Copy
        // the batch-size fields through raw — precedence + defaulting live at the one
        // seam below, so binary and JSON requests resolve it identically.
        let cursor = raw.subarray(1);
        const { v: fields, len } = ioc.mapSerializer.deserialize(cursor, false);
        cursor = cursor.subarray(len);
        const { v: gremlin } = ioc.stringSerializer.deserialize(cursor, false);
        const bindings = fields?.get?.('bindings') ?? fields?.get?.('parameters') ?? {};
        msg = {
          gremlin,
          g: fields?.get?.('g'),
          parameters: bindings instanceof Map ? Object.fromEntries(bindings) : bindings,
          batchSize: fields?.get?.('batchSize'),
          resultIterationBatchSize: fields?.get?.('resultIterationBatchSize'),
        };
      } else {
        msg = JSON.parse(raw.toString('utf8'));
      }
      gremlinForLog = msg.gremlin;
      // The one seam resolving batch size for BOTH request shapes: batchSize wins over
      // resultIterationBatchSize; 0 / negative / non-numeric fall back to the default.
      const requestedBatchSize = Number(msg.batchSize ?? msg.resultIterationBatchSize);
      const batchSize = requestedBatchSize > 0 ? requestedBatchSize : DEFAULT_BATCH_SIZE;
      const store = typeof source === 'function' ? source(msg.g ?? 'g') : source;
      const gen = execute(store, msg.gremlin, msg.parameters ?? {});
      // Prime the generator: this runs compile() + the synchronous cursor drain +
      // the first frame, so any pre-stream error throws HERE and is caught below as
      // a buffered 500 (before a single streamed byte commits us to HTTP 200).
      const primed = gen.next();
      return streamResponse(gen, primed, batchSize, (count, error) =>
        console.log(error
          ? `ERR  [${gremlinForLog}] ${error} (after ${count} result(s) streamed)`
          : `OK   ${gremlinForLog} -> ${count} result(s)`));
    } catch (e: any) {
      // Request-parse or pre-stream (compile/SQL) failure → always HTTP 200; the
      // error rides the GraphBinary status trailer.
      console.log(`ERR  [${gremlinForLog}] ${e.message}`);
      return errorResponse(e.message);
    }
  };
}
