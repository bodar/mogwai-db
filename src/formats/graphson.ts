// TYPED GraphSON, the line-oriented ADJACENCY form — reader.
//
// Design: docs/2026-07-31-bulk-transfer-and-io-substrate-plan.md §4/§4b/§4c. This one format carries
// three jobs: it is what `io("…json").read()` consumes, it is the lossless export/backup path, and it
// is the fast seed (the reference graphs load from these files in the pinned submodule).
//
// THREE ARTEFACTS SHARE THE NAME "GraphSON" and only one of them is this:
//
//  1. **The line-oriented adjacency form** — one VERTEX per line, its edges embedded as `inE`/`outE`.
//     This module. It is what `GraphSONWriter.writeGraph` emits (via `writeVertices` →
//     `DirectionalStarGraph` → `StarGraphGraphSONSerializerV{3,4}`), and it is the one that STREAMS:
//     read a line, land a row batch, never hold the graph in memory. That property is why it is the
//     form we want on a Durable Object.
//  2. **`g:graph`** — `{"@type":"g:graph","@value":{"vertices":[…],"edges":[…]}}`. Separate top-level
//     arrays, every element `@type`-wrapped, NOT streamable (the whole document must be
//     materialized). The trap: `tinker-graph-v4.json`, the only whole-graph `-v4` file the corpus
//     ships, IS this form — so "the v4 graph file" is ambiguous and the fixture on disk is the
//     version we do not want. Accepting it is a container question, deliberately still open (§4c·3).
//  3. **Untyped GraphSON v4 responses** (`types=false`) — a RESPONSE encoder, scoped separately in
//     docs/2026-07-13-graphson-untyped-scope.md. Untyped BY DEFINITION, so it cannot carry `vtype`
//     and can never be a graph format.
//
// **v3 and v4 differ in exactly one thing here: the vertex label.** v3 writes `"label": "person"`,
// v4 writes `"label": ["person"]` (`writeLabels(…, starVertex.labels())`). The v3→v4 registry diff is
// otherwise all REMOVALS, and every removal is traversal machinery (Metrics, Traverser, Lambda, the
// Order/Pick/Pop/Scope/Column/Operator enums) — nothing we store. So this is ONE reader with a label
// branch, not two codecs. Reading v3 is not optional: every whole-graph fixture the corpus ships is
// v3. Endpoint labels are NOT part of the adjacency form in either version (`inV` is a bare id, and
// structurally has to be — each vertex is its own line, so a reader resolves the id against that
// vertex's own entry).
import { BulkLoader, type BulkEdge, type BulkProperty, type BulkStats, type BulkVertex } from '../bulk.ts';
import type { GraphStore } from '../storage.ts';
import { BigDecimal, Duration, type CanonicalType, type MapEntryType, type TypeNode } from '../gremlin/types.ts';

/**
 * GraphSON's `@type` names → our canonical type vocabulary, 17 for 17 (plan doc §4b).
 *
 * Not luck: `CanonicalType` was derived from the v4 wire type channel, and GraphSON and GraphBinary
 * are two encodings of the SAME type system. The `g:` names come from `GraphSONModule`, the `gx:` set
 * from `GraphSONXModule`, and `g:UUID` is registered separately in `GraphSONMapper` under the V4
 * branch. V4 pruned `gx:` hard (the eleven `java.time` variants collapsed to one `gx:DateTime`) but
 * kept every name we need, so one map serves both versions.
 */
const GRAPHSON_TYPES: Record<string, CanonicalType> = {
  'g:Int32': 'int', 'g:Int64': 'long', 'g:Float': 'float', 'g:Double': 'double', 'g:UUID': 'uuid',
  'g:List': 'list', 'g:Map': 'map', 'g:Set': 'set',
  'gx:Byte': 'byte', 'gx:Int16': 'short', 'gx:BigInteger': 'bigint', 'gx:BigDecimal': 'bigdecimal',
  'gx:DateTime': 'datetime', 'gx:Char': 'char', 'gx:Duration': 'duration',
  // v3 spelled several of these differently before the V4 pruning; the two that appear in shipped v3
  // fixtures are kept so a v3 file with a date or a duration reads.
  'gx:Instant': 'datetime', 'g:Date': 'datetime', 'g:Timestamp': 'datetime',
};

/** A GraphSON value decoded into (JS value, TypeNode) — the pair `BulkProperty` carries, and the same
 *  pair the wire front-end produces for a literal, so storage sees exactly one representation. */
export interface TypedValue { readonly value: unknown; readonly type: TypeNode | null }

/** A bare (untyped) JSON scalar: GraphSON leaves strings, booleans and `null` unwrapped. A bare NUMBER
 *  is not typed GraphSON — a typed document wraps every number — so it is read as JS infers it rather
 *  than being rejected, which is what makes an untyped file degrade to "types inferred" instead of
 *  failing. */
function bareValue(x: unknown): TypedValue {
  if (typeof x === 'string') return { value: x, type: 'string' };
  if (typeof x === 'boolean') return { value: x, type: 'boolean' };
  return { value: x, type: null };
}

/**
 * Decode one GraphSON value. Fails closed on an unrecognized `@type`: silently dropping the type
 * would land the value with an inferred `vtype`, which is a wrong answer in the one channel this
 * format exists to preserve.
 */
export function graphsonValue(x: unknown): TypedValue {
  if (x === null || typeof x !== 'object') return bareValue(x);
  if (Array.isArray(x)) {
    // A bare JSON array (v4's `label`, and any untyped list) — decode per element.
    const items = x.map(graphsonValue);
    return { value: items.map((i) => i.value), type: { t: 'list', items: items.map((i) => i.type) } };
  }
  const wrapper = x as { '@type'?: string; '@value'?: unknown };
  if (typeof wrapper['@type'] !== 'string') return { value: x, type: null };
  const name = wrapper['@type'];
  const type = GRAPHSON_TYPES[name];
  if (!type) throw new Error(`GraphSON: unsupported @type "${name}" (no canonical type to store it as)`);
  const raw = wrapper['@value'];
  if (type === 'list' || type === 'set') {
    const items = (raw as unknown[]).map(graphsonValue);
    const values = items.map((i) => i.value);
    return { value: type === 'set' ? new Set(values) : values, type: { t: type, items: items.map((i) => i.type) } };
  }
  if (type === 'map') {
    // g:Map is a FLAT alternating [k,v,k,v] array precisely so keys can be typed — which is the
    // fidelity our MapEntryType.key needs and which no Gremlin map literal can spell.
    const flat = raw as unknown[];
    const pairs: [unknown, unknown][] = [];
    const entries: Record<string, MapEntryType | null> = {};
    for (let i = 0; i < flat.length; i += 2) {
      const k = graphsonValue(flat[i]);
      const v = graphsonValue(flat[i + 1]);
      pairs.push([k.value, v.value]);
      entries[String(k.value)] = { key: k.type, value: v.type };
    }
    return { value: new Map(pairs), type: { t: 'map', entries } };
  }
  return { value: scalarOf(type, raw), type };
}

/** A typed scalar's JS carrier, matching what the wire front-end produces for the same type — so the
 *  loader stores exactly what a client write would. */
function scalarOf(type: CanonicalType, raw: unknown): unknown {
  switch (type) {
    // Beyond 2^53 a JSON number has already lost bits, so a big integer is only exact if the document
    // wrote it as a string; both spellings are accepted and carried as bigint.
    case 'bigint': return typeof raw === 'string' ? BigInt(raw) : BigInt(Math.trunc(Number(raw)));
    case 'bigdecimal': return BigDecimal.from(String(raw));
    case 'duration': return graphsonDuration(String(raw));
    // Internally a datetime is epoch-millis (gremlin/types leafStore, and the `datetime('…')` literal).
    case 'datetime': return typeof raw === 'number' ? raw : Date.parse(String(raw));
    default: return raw;
  }
}

/** ISO-8601 `PnDTnHnMn.nS` (what `gx:Duration` writes) → our Duration carrier. Total-nanos digits are
 *  accepted too, since that is how we render one. */
function graphsonDuration(text: string): Duration {
  if (/^-?\d+$/.test(text)) return Duration.from(text);
  const m = /^(-)?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text);
  if (!m) throw new Error(`GraphSON: unparseable gx:Duration "${text}"`);
  const [, neg, d, h, min, sec] = m;
  const seconds = BigInt(d ?? 0) * 86_400n + BigInt(h ?? 0) * 3_600n + BigInt(min ?? 0) * 60n
    + BigInt(Math.trunc(Number(sec ?? 0)));
  const nanos = Math.round((Number(sec ?? 0) % 1) * 1e9);
  const total = seconds * Duration.NANOS_PER_SEC + BigInt(nanos);
  return Duration.fromTotalNanos(neg ? -total : total);
}

/** An element id as the loader wants it: a number stays a rowid, anything else becomes a `uid`. */
const idOf = (x: unknown): number | string => {
  const { value } = graphsonValue(x);
  return typeof value === 'number' ? value : String(value);
};

/** A vertex's labels, across both versions: v3 `"label": "person"`, v4 `"label": ["person"]`. An
 *  ABSENT label is legal in v4 (`empty-label-vertex-v4.json`) and lands as zero labels, which
 *  `vertex_labels` represents natively and only `LabelCardinality.ZERO_OR_MORE` accepts. */
function labelsOf(label: unknown): string[] {
  if (label === undefined || label === null) return [];
  if (Array.isArray(label)) return label.map((l) => String(graphsonValue(l).value));
  return [String(graphsonValue(label).value)];
}

/** A vertex's properties: `{key: [{id, value, properties?}, …]}` — one entry per VertexProperty
 *  INSTANCE, so multi-properties and their ids and meta-properties all survive. */
function vertexProperties(properties: unknown): BulkProperty[] {
  const out: BulkProperty[] = [];
  for (const [key, instances] of Object.entries((properties ?? {}) as Record<string, unknown[]>)) {
    for (const vp of instances) {
      const { id, value, properties: meta } = vp as { id?: unknown; value?: unknown; properties?: Record<string, unknown> };
      const decoded = graphsonValue(value);
      const vpId = id === undefined ? undefined : graphsonValue(id).value;
      out.push({
        key,
        value: decoded.value,
        vtype: flatVtype(decoded.type),
        typeNode: decoded.type,
        // Meta-properties are a flat {metaKey: scalar} bag in storage, so only their VALUES carry
        // through; a typed meta value stringifies into the same JSONB blob the write path builds.
        meta: meta ? Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, graphsonValue(v).value])) : null,
        ...(typeof vpId === 'number' ? { id: vpId } : {}),
      });
    }
  }
  return out;
}

/** An edge's properties: `{key: <typed value>}` — one row per (edge,key), no ids, no meta (TinkerPop's
 *  edge Property has neither). */
function edgeProperties(properties: unknown): BulkProperty[] {
  return Object.entries((properties ?? {}) as Record<string, unknown>).map(([key, v]) => {
    const decoded = graphsonValue(v);
    return { key, value: decoded.value, vtype: flatVtype(decoded.type), typeNode: decoded.type };
  });
}

/** The `vtype` column's value for a decoded TypeNode: a container node names its OUTER shape, a
 *  scalar node IS its name. (`gremlin/types.flatType` is the same reduction; kept local so this
 *  module does not need the whole TypeNode vocabulary re-exported.) */
const flatVtype = (t: TypeNode | null): CanonicalType | null =>
  t === null ? null : typeof t === 'string' ? t : t.t;

/** One parsed adjacency line → the vertex plus the edges it embeds. */
export function graphsonVertexLine(line: string): { vertex: BulkVertex; edges: BulkEdge[] } {
  const v = JSON.parse(line) as {
    '@type'?: string; id?: unknown; label?: unknown; properties?: unknown;
    outE?: Record<string, unknown[]>; inE?: Record<string, unknown[]>;
  };
  // Fail closed on the OTHER two artefacts that share the name (see the header): a `g:Vertex`- or
  // `g:graph`-wrapped document is not the adjacency form, and reading it as one would take `id` as
  // undefined and land a vertex under the uid "undefined" — a silent wrong answer.
  if (typeof v['@type'] === 'string')
    throw new Error(`GraphSON: "${v['@type']}" is not the line-oriented adjacency form `
      + '(one bare vertex object per line, with embedded outE) — a g:Vertex/g:graph document is a different artefact');
  if (v.id === undefined || v.id === null) throw new Error('GraphSON: adjacency vertex has no id');
  const id = idOf(v.id);
  const vertex: BulkVertex = { id, labels: labelsOf(v.label), properties: vertexProperties(v.properties) };
  const edges: BulkEdge[] = [];
  // Only `outE` is read: `inE` is the same edge from the other side, so reading both would double
  // every edge. Every edge appears exactly once as some vertex's outE (an adjacency list is written
  // that way), so nothing is lost.
  for (const [label, list] of Object.entries(v.outE ?? {}))
    for (const e of list) {
      const edge = e as { id?: unknown; inV: unknown; properties?: unknown };
      edges.push({
        id: edge.id === undefined ? undefined : idOf(edge.id),
        label, src: id, tgt: idOf(edge.inV), properties: edgeProperties(edge.properties),
      });
    }
  return { vertex, edges };
}

/**
 * Load a whole line-oriented GraphSON adjacency document into `store`.
 *
 * Streams: one line is parsed, buffered and forgotten, so peak memory is the loader's row buffers
 * rather than the document. Vertices are added as they are read and edges follow, so an edge whose
 * `inV` names a later line still resolves (the loader defers unresolved endpoints to `flush`).
 *
 * Fails closed with the line number on a malformed line — a partially loaded graph is a wrong answer,
 * and the caller can only diagnose it if the failure names where it stopped.
 */
export function loadGraphson(store: GraphStore, document: string): BulkStats {
  const loader = new BulkLoader(store);
  const edges: BulkEdge[] = [];
  let n = 0;
  for (const line of document.split('\n')) {
    n++;
    if (!line.trim()) continue;
    try {
      const parsed = graphsonVertexLine(line);
      loader.vertex(parsed.vertex);
      edges.push(...parsed.edges);
    } catch (e) {
      throw new Error(`GraphSON line ${n}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const e of edges) loader.edge(e);
  return loader.flush();
}
