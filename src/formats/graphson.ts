// TYPED GraphSON, the line-oriented ADJACENCY form — reader and writer.
//
// Design: docs/archive/2026-07-31-bulk-transfer-and-io-substrate-plan.md §4/§4b/§4c. This one format carries
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
import { BulkLoader, type BulkEdge, type BulkOptions, type BulkProperty, type BulkStats, type BulkVertex } from '../bulk.ts';
import type { GraphStore } from '../storage.ts';
import {
    BigDecimal, Duration, exactInteger, gremlinTypeOf, valueNodeFromStored,
    type CanonicalType, type MapEntryType, type TypeNode, type ValueNode,
} from '../gremlin/types.ts';
import { type PropRow, edgePropsForOwners, groupByOwner, keysetPages, labelsForOwners, rowsForOwners, vertexPropsForOwners } from './drain.ts';

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
  // Present under the same name in both versions.
  'g:Int32': 'int', 'g:Int64': 'long', 'g:Float': 'float', 'g:Double': 'double', 'g:UUID': 'uuid',
  'g:List': 'list', 'g:Map': 'map', 'g:Set': 'set',
  // **v4 moved the extended types from `gx:` to `g:`** — measured over the corpus, not guessed: every
  // `@type` in the shipped `-v4` fixtures carries the `g:` prefix (`g:BigDecimal`, `g:BigInteger`,
  // `g:Byte`, `g:Char`, `g:DateTime`, `g:Duration`, `g:Int16`), while the v3 files and
  // `GraphSONXModule` use `gx:`. The plan doc's §4b table listed the `gx:` spellings under a "v4"
  // heading; those are the v3 names. Both are accepted, which keeps this ONE reader rather than two.
  'g:Byte': 'byte', 'gx:Byte': 'byte',
  'g:Int16': 'short', 'gx:Int16': 'short',
  'g:Char': 'char', 'gx:Char': 'char',
  'g:BigInteger': 'bigint', 'gx:BigInteger': 'bigint',
  'g:BigDecimal': 'bigdecimal', 'gx:BigDecimal': 'bigdecimal',
  'g:DateTime': 'datetime', 'gx:DateTime': 'datetime',
  'g:Duration': 'duration', 'gx:Duration': 'duration',
  // v3-only spellings that predate the V4 pruning of the eleven java.time variants.
  'gx:Instant': 'datetime', 'g:Date': 'datetime', 'g:Timestamp': 'datetime',
};

/** The inverse, for the WRITER: one canonical name per type, and v4's `g:` prefix throughout (so the
 *  output is v4, per §4c's "read both, write v4"). `string`/`boolean` are absent deliberately — a
 *  GraphSON writer leaves them as bare JSON. */
const GRAPHSON_NAMES: Partial<Record<CanonicalType, string>> = {
  int: 'g:Int32', long: 'g:Int64', float: 'g:Float', double: 'g:Double', uuid: 'g:UUID',
  list: 'g:List', map: 'g:Map', set: 'g:Set',
  byte: 'g:Byte', short: 'g:Int16', char: 'g:Char',
  bigint: 'g:BigInteger', bigdecimal: 'g:BigDecimal', datetime: 'g:DateTime', duration: 'g:Duration',
};

/**
 * The three types whose `@value` is EXACT DIGITS on the wire but cannot survive `JSON.parse` /
 * `JSON.stringify`, and the two passes that carry them across.
 *
 * JSON numbers are arbitrary-precision BY SPEC, and GraphSON uses that: `max-long-v4.json` is
 * `9223372036854775807`, `neg-bigdecimal-v4.json` a 33-digit decimal. JavaScript's JSON is where the
 * precision dies — `JSON.parse` yields a `number` (9007199254740993 → …992) and `JSON.stringify`
 * cannot emit a bigint at all. So the digits ride as a STRING through both JSON boundaries:
 * `quoteExactNumbers` before a parse, `unquoteExactNumbers` after a stringify. Exact inverses, one
 * pattern, so a change to either side cannot drift.
 *
 * The pattern is provably safe rather than merely unlikely: inside a JSON string every `"` is escaped,
 * so the literal text `{"@type":"g:Int64","@value":…}` cannot occur INSIDE a string value — it can only
 * be a real GraphSON object. It does assume `@type` precedes `@value`, which both `JSON.stringify`
 * (insertion order) and Jackson's GraphSON writer do.
 */
const EXACT_NUMBER_TYPES = ['g:Int64', 'g:BigInteger', 'g:BigDecimal', 'gx:BigInteger', 'gx:BigDecimal'] as const;
const EXACT = `(${EXACT_NUMBER_TYPES.join('|')})`;
const BARE_EXACT = new RegExp(String.raw`\{"@type":"${EXACT}","@value":(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\}`, 'g');
const QUOTED_EXACT = new RegExp(String.raw`\{"@type":"${EXACT}","@value":"(-?\d+(?:\.\d+)?)"\}`, 'g');

/** Digits → string, before `JSON.parse` loses them. */
const quoteExactNumbers = (json: string) => json.replace(BARE_EXACT, '{"@type":"$1","@value":"$2"}');
/** String → digits, after `JSON.stringify` refused to write them. */
const unquoteExactNumbers = (json: string) => json.replace(QUOTED_EXACT, '{"@type":"$1","@value":$2}');

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
    // `quoteExactNumbers` has already turned the digits into a string, so nothing here has been
    // through a float. A bigint carrier lets `storedScalar` make the SAME call the write path makes:
    // a JS number while it fits ±2^53 exactly, decimal TEXT beyond it.
    case 'bigint': return BigInt(String(raw));
    // A g:Int64 is both a big number's type AND the type an ELEMENT ID uses, so it narrows to the
    // smallest exact carrier: a JS number while it fits ±2^53 (which is what an id needs, and what
    // `storedScalar` would produce anyway), a bigint only when the digits genuinely exceed it.
    case 'long': return typeof raw === 'string' ? exactInteger(raw) : raw;
    case 'bigdecimal': return BigDecimal.from(String(raw));
    case 'duration': return graphsonDuration(String(raw));
    // Internally a datetime is epoch-millis (gremlin/types leafStore, and the `datetime('…')` literal).
    case 'datetime': return typeof raw === 'number' ? raw : Date.parse(String(raw));
    default: return raw;
  }
}

/** ISO-8601 `PnDTnHnMn.nS` (what `g:Duration` writes) → our Duration carrier. Total-nanos digits are
 *  accepted too, since that is how we STORE one, so a value that has been through our own storage
 *  reads back either way. The ISO half is `Duration.fromIso` — one parser, shared with CSV. */
function graphsonDuration(text: string): Duration {
  if (/^-?\d+$/.test(text)) return Duration.from(text);
  try {
    return Duration.fromIso(text);
  } catch {
    throw new Error(`GraphSON: unparseable g:Duration "${text}"`);
  }
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
  const v = JSON.parse(quoteExactNumbers(line)) as {
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
export function loadGraphson(store: GraphStore, document: string, options?: BulkOptions): BulkStats {
  const loader = new BulkLoader(store, options);
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

// ---------- the writer: v4, line-oriented adjacency ----------
//
// "Read both, write v4" (§4c). Writing v4 is not cosmetic: **v3 cannot represent a multi-label
// vertex**, its `label` being one bare string, so a v3 writer is lossy for exactly the graph that
// exercises the feature (`gzoo`, `LabelCardinality.ZERO_OR_MORE`) — and we are the provider that
// declares multi-label.
//
// Both incidence directions are emitted per vertex, and that is REQUIRED rather than
// faithful-for-its-own-sake: TinkerPop's `GraphSONWriter.writeGraph` calls
// `writeVertices(…, Direction.BOTH)`, and its `GraphSONReader.readGraph` reads
// `readVertex(…, Direction.IN)` and then attaches `edges(Direction.IN)` — so **a file carrying only
// `outE` reads as EDGELESS in TinkerPop.** Our own reader takes the `outE` side (each edge appears
// there exactly once, so nothing is doubled). Writer and reader therefore interoperate both ways.

/** `{"@type":…,"@value":…}`, or the bare value for the types GraphSON leaves untyped. */
const typed = (type: CanonicalType | null, value: unknown): unknown => {
  if (type === null || type === 'string' || type === 'boolean') return value;
  const name = GRAPHSON_NAMES[type];
  // Fail closed: a canonical type with no GraphSON name would otherwise write an UNTYPED value, which
  // is the one loss this format exists to prevent.
  if (!name) throw new Error(`GraphSON: no @type name for canonical type "${type}"`);
  return { '@type': name, '@value': value };
};

/** A stored ValueNode → its GraphSON encoding. The inverse of `graphsonValue`, and the reason the
 *  writer needs no knowledge of the SQL row: `valueNodeFromStored` already reconstructs the typed tree
 *  from `(value, vtype)`, so this walks a value tree and nothing else. */
export function graphsonNode(node: ValueNode): unknown {
  if (node.t === 'list' || node.t === 'set')
    return typed(node.t, (node.v as ValueNode[]).map(graphsonNode));
  if (node.t === 'map')
    // Flat alternating [k,v,k,v] — the form that lets a KEY carry its own type.
    return typed('map', (node.v as [ValueNode, ValueNode][]).flatMap(([k, v]) => [graphsonNode(k), graphsonNode(v)]));
  return typed(node.t, leafJson(node.t, node.v));
}

/** One scalar leaf's JSON payload, from its STORED form. The exact-digit types return a STRING, which
 *  `unquoteExactNumbers` turns back into a bare JSON number. */
function leafJson(type: CanonicalType | null, stored: unknown): unknown {
  switch (type) {
    // A boolean stores as 1/0 (coerceBindValue — DO SQLite rejects a boolean bind), so the writer has
    // to put the JSON boolean back or the reader reads a number and loses the type.
    case 'boolean': return stored === 1 || stored === true;
    case 'bigint': case 'bigdecimal': return String(stored);
    // A long past 2^53 is stored as decimal TEXT (coerceBindValue); within range it is a number.
    case 'long': return typeof stored === 'string' ? stored : stored;
    // Stored as total nanos (TEXT) / epoch millis; GraphSON wants ISO-8601 for both.
    case 'duration': return Duration.from(String(stored)).toIso();
    case 'datetime': return new Date(Number(stored)).toISOString();
    default: return stored;
  }
}

/** An element id as GraphSON: a `uid` rides as a bare string, a rowid as g:Int32 (or g:Int64 past
 *  int32 range, which is what the corpus fixtures do for a large id). */
const idJson = (id: number | string): unknown =>
  typeof id === 'string' ? id
    : typed(id >= -2147483648 && id <= 2147483647 ? 'int' : 'long', id);

interface EdgeRow { id: number; uid: string | null; src: number; tgt: number; label: string; owner: number }

/** `{key: <typed value>}` for an edge's properties. */
const edgePropsJson = (rows: readonly PropRow[]): Record<string, unknown> =>
  Object.fromEntries(rows.map((p) => [p.key, graphsonNode(valueNodeFromStored(p.value, p.vtype))]));

/** `{key: [{id, value, properties?}, …]}` for a vertex's properties — one entry per VertexProperty
 *  INSTANCE, so multi-properties keep their identity and their meta-properties.
 *
 *  KNOWN LOSS, and it is in STORAGE rather than in the format: `vertex_properties.meta` is a flat
 *  `{metaKey: scalar}` JSONB bag with no per-value type, so a meta value round-trips as whatever JSON
 *  gives back (int/double/string/bool). GraphSON could carry more; we have nothing more to give it. */
function vertexPropsJson(rows: readonly PropRow[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const p of rows) {
    const meta = p.meta === null ? null : JSON.parse(p.meta) as Record<string, unknown>;
    const instance = {
      id: typed('long', p.id),
      value: graphsonNode(valueNodeFromStored(p.value, p.vtype)),
      ...(meta && Object.keys(meta).length
        ? { properties: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, typed(gremlinTypeOf(v), v)])) }
        : {}),
    };
    const list = out[p.key];
    if (list) list.push(instance); else out[p.key] = [instance];
  }
  return out;
}

/** `{label: [{id, inV|outV, properties}, …]}` for one side of a vertex's incident edges. */
function incidenceJson(
  edges: readonly EdgeRow[], props: Map<number, PropRow[]>, endpoint: 'inV' | 'outV',
  extId: (rowid: number) => number | string,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const e of edges) {
    const other = endpoint === 'inV' ? e.tgt : e.src;
    const p = props.get(e.id) ?? [];
    const entry = {
      id: idJson(e.uid ?? e.id),
      [endpoint]: idJson(extId(other)),
      ...(p.length ? { properties: edgePropsJson(p) } : {}),
    };
    const list = out[e.label];
    if (list) list.push(entry); else out[e.label] = [entry];
  }
  return out;
}

/**
 * Drain the whole graph as typed GraphSON v4 adjacency lines — one line per vertex.
 *
 * STREAMING, by the same argument the reader is: vertices drain in keyset pages (`keysetPages`), and
 * each page reads its labels, properties and incident edges in bind-bounded chunks. Peak memory is one
 * page, not the graph — which is what makes a whole-graph export runnable inside a Durable Object
 * rather than only on a machine that can hold the graph twice.
 */
export function* graphsonLines(store: GraphStore, pageSize = 200): Generator<string> {
  for (const page of keysetPages<{ id: number; uid: string | null }>(store, 'nodes', ['id', 'uid'], pageSize)) {
    const ids = page.map((v) => v.id);
    const extId = new Map<number, number | string>(page.map((v) => [v.id, v.uid ?? v.id]));

    const labels = labelsForOwners(store, ids);
    const props = vertexPropsForOwners(store, ids, true); // GraphSON JSON-parses each value — collections as json() text

    // Both incidence directions, per the header. `owner` is the vertex this side hangs off.
    const edgeSql = (endpointCol: 'src' | 'tgt') => (ph: string) =>
      `SELECT e.id AS id, e.uid AS uid, e.src AS src, e.tgt AS tgt, l.name AS label, e.${endpointCol} AS owner
       FROM edges e JOIN labels l ON l.id = e.label WHERE e.${endpointCol} IN (${ph}) ORDER BY e.${endpointCol}, e.id`;
    const outE = rowsForOwners<EdgeRow>(store, edgeSql('src'), ids);
    const inE = rowsForOwners<EdgeRow>(store, edgeSql('tgt'), ids);
    const edgeProps = edgePropsForOwners(store, [...new Set([...outE, ...inE].map((e) => e.id))], true);
    const outByOwner = groupByOwner(outE);
    const inByOwner = groupByOwner(inE);

    // An endpoint id may belong to a vertex outside this page, so it resolves lazily against the store
    // — one statement for a genuinely foreign endpoint, none for a same-page one.
    const resolveExt = (rowid: number): number | string => {
      const known = extId.get(rowid);
      if (known !== undefined) return known;
      const row = store.query<{ uid: string | null }>('SELECT uid FROM nodes WHERE id=?', [rowid])[0];
      const ext = row?.uid ?? rowid;
      extId.set(rowid, ext);
      return ext;
    };

    for (const v of page) {
      const out = outByOwner.get(v.id) ?? [];
      const incoming = inByOwner.get(v.id) ?? [];
      const vp = props.get(v.id) ?? [];
      yield unquoteExactNumbers(JSON.stringify({
        id: idJson(v.uid ?? v.id),
        // v4: a label ARRAY, which is what makes a multi-label vertex representable at all.
        label: (labels.get(v.id) ?? []).map((l) => l.name),
        ...(vp.length ? { properties: vertexPropsJson(vp) } : {}),
        ...(out.length ? { outE: incidenceJson(out, edgeProps, 'inV', resolveExt) } : {}),
        ...(incoming.length ? { inE: incidenceJson(incoming, edgeProps, 'outV', resolveExt) } : {}),
      }));
    }
  }
}

/** The whole graph as one newline-separated document — the file `io().write()` will put in R2 or on
 *  disk. A caller streaming to a sink should iterate `graphsonLines` instead of joining. */
export const writeGraphson = (store: GraphStore, pageSize?: number): string =>
  [...graphsonLines(store, pageSize)].join('\n');
