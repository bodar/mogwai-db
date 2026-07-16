import type { GraphStore } from '../storage.ts';
import { q, value, list, empty, raw, render, type Expression } from '../q.ts';
import { labelIn, nodeHasProp, edgeHasProp } from '../plan.ts';
import { gremlinTypeOf, isCollectionType, type CanonicalType } from '../gremlin-types.ts';
import { stepChain, type Step, type SackSpec } from '../frontend.ts';
import { normalize, type PStep } from '../strategies.ts';
import { readCompiled, renderFrom, type Compiled, type WritePlan, type Shape } from '../render.ts';
import { buildPrefix, compileRead } from './index.ts';
import { compileInject } from './inject.ts';

// ---------- nested-traversal write arguments (read spine reuse) ----------
//
// A write-step argument can be a nested traversal — property(k, __.trav), a merge
// match/option map, an addE endpoint. We do NOT hand-parse it: we compile it with the
// ordinary read compiler and read the raw column from the resulting (relation, shape)
// via extractNestedValue — the inverse of execute.ts's framing switch (no GraphBinary).
// A CORRELATED arg (its value depends on the current element) is seeded at the driver
// element by prepending a V(<rowid>)/E(<rowid>) source (numeric arg → rowid match), then
// compiled + run + extracted per driver row. See docs/2026-07-16-write-args-through-read-spine.md.

const isNested = (a: any): a is { nested: any } => a != null && typeof a === 'object' && 'nested' in a;

// Compile a nested traversal (optionally seeded at a driver element) and run it against
// the store, returning its raw result rows + the compiled shape. Seeding prepends a
// V/E source on the driver's internal rowid so the child is anchored at that element.
function runNested(store: GraphStore, nestedNode: any, params: Record<string, any>, seed?: { id: number; elem: 'node' | 'edge' }): { rows: any[]; shape: Shape } {
  let chain: PStep[] = normalize(stepChain(nestedNode, params)).steps;
  // Seed at the driver element: a synthetic V/E source on the internal rowid (numeric
  // arg → rowid match). It borrows the nested node's parse ctx (no ctx of its own).
  if (seed) chain = [{ name: seed.elem === 'edge' ? 'E' : 'V', args: [seed.id], ctx: nestedNode } as PStep, ...chain];
  const compiled = compileRead(chain, params);
  return { rows: store.query<any>(compiled.sql, compiled.binds), shape: compiled.shape };
}

// A compile-time scalar ValueType → the stored CanonicalType vocab (they overlap except
// bool/date). null = infer from the JS value.
const VT_TO_CANON: Record<string, CanonicalType> = {
  bool: 'boolean', byte: 'byte', short: 'short', int: 'int', long: 'long', bigint: 'bigint',
  float: 'float', double: 'double', string: 'string', uuid: 'uuid', date: 'datetime',
};

// The scalar value a nested property()-value traversal produces: the FIRST result row's
// value (single-cardinality write), or has:false for an empty traversal (→ no property).
// The stored vtype comes from the read spine's own type (count→long, a typed value→its
// `as`), else null → inferred from the value. Fails closed on a non-scalar result shape.
function nestedScalar(store: GraphStore, nestedNode: any, params: Record<string, any>, seed: { id: number; elem: 'node' | 'edge' }): { has: boolean; value: any; vtype: CanonicalType | null } {
  const { rows, shape } = runNested(store, nestedNode, params, seed);
  if (shape.kind !== 'value' && shape.kind !== 'scalar' && shape.kind !== 'count')
    throw new Error(`property() traversal value producing a ${shape.kind} not yet supported`);
  if (!rows.length || rows[0].v == null) return { has: false, value: undefined, vtype: null };
  if (shape.kind === 'count') return { has: true, value: Number(rows[0].v), vtype: 'long' };
  const vt = shape.kind === 'value' && !shape.perRowType && shape.as ? VT_TO_CANON[shape.as] ?? null : null;
  return { has: true, value: rows[0].v, vtype: vt };
}

// Resolve a PropSpec's value for one target element: a literal passes through with its
// captured vtype; a nested traversal is evaluated correlated at the element (its vtype is
// inferred from the produced value, the honest fallback for an untyped channel). An empty
// nested traversal → has:false (the property is not written), matching property(traversal)
// on no result.
function resolveSpecValue(store: GraphStore, sp: PropSpec, id: number, elem: 'node' | 'edge', params: Record<string, any>): { has: boolean; value: any; vtype: CanonicalType | null } {
  if (!isNested(sp.value)) return { has: true, value: sp.value, vtype: sp.vtype };
  const r = nestedScalar(store, sp.value.nested, params, { id, elem });
  return { has: r.has, value: r.value, vtype: r.vtype ?? (r.has ? gremlinTypeOf(r.value, null) : null) };
}

// ---------- write compilers ----------
//
// Writes are an imperative interpreter (sequential INSERT/UPDATE/DELETE threading
// store state + as() aliases) — not a functional CTE fold — so these stay closure
// builders over the store. They reuse the read prefix (buildPrefix) to materialize
// target ids, then mutate. The WRITE_RULES table (bottom) routes a step chain to
// the right compiler; routing is predicate/position based (addE can be mid-chain,
// drop must be last), so it's an ordered rule list rather than a name→fn Map.

// drop() — remove the target elements. Vertices (g.V()…drop()) take their
// incident edges with them; edges (g.E()…drop(), g.V().outE()…drop()) delete
// only the matched edge rows.
function compileDrop(steps: PStep[]): WritePlan {
  const { st, stop } = buildPrefix(steps.slice(0, -1));
  if (stop !== steps.length - 1) throw new Error(`drop() after ${steps[stop].name}() not yet supported`);
  const isEdge = st.elem === 'edge';
  const target = renderFrom(st.q, st.rel);
  return {
    kind: 'write',
    run: (store) => {
      // Materialize the target ids ONCE, before mutating. For vertices, deleting
      // incident edges first would empty a re-evaluated target CTE (if it reads
      // the edges table), silently leaving vertices behind. Snapshot, then delete.
      const ids = store.query<{ id: number }>(target.sql, target.binds).map((r) => r.id);
      if (!ids.length) return [];
      const ph = ids.map(() => '?').join(',');
      if (isEdge) {
        store.query(`DELETE FROM edge_properties WHERE edge IN (${ph})`, ids);
        store.query(`DELETE FROM edges WHERE id IN (${ph})`, ids);
      } else {
        // Drop the incident edges' properties first (they reference the soon-deleted
        // edges), then the edges, then this vertex's own properties, then the vertex.
        store.query(`DELETE FROM edge_properties WHERE edge IN (SELECT id FROM edges WHERE src IN (${ph}) OR tgt IN (${ph}))`, [...ids, ...ids]);
        store.query(`DELETE FROM edges WHERE src IN (${ph}) OR tgt IN (${ph})`, [...ids, ...ids]);
        store.query(`DELETE FROM vertex_properties WHERE node IN (${ph})`, ids);
        store.query(`DELETE FROM nodes WHERE id IN (${ph})`, ids);
      }
      return [];
    },
  };
}

// g.V(x).<filters>.property(k, v)[.property(...)] — set properties on the matched
// existing element(s), single cardinality (last write wins).
function compileSetProperty(steps: PStep[], params: Record<string, any>): WritePlan {
  const firstProp = steps.findIndex((s) => s.name === 'property');
  const prefix = steps.slice(0, firstProp);
  const { st, stop } = buildPrefix(prefix, params);
  if (stop !== prefix.length) throw new Error(`property() after ${steps[stop].name}() not yet supported`);
  const elem = st.elem;
  const specs: PropSpec[] = [];
  for (const s of steps.slice(firstProp)) {
    if (s.name !== 'property') throw new Error(`step not implemented after property(): ${s.name}()`);
    const { cardinality, rest, off } = readCardinality(s.args);
    const [key, val, ...metaArgs] = rest;
    // null/map-form property() is a no-op (see parseVertexSpec).
    if (key == null || (typeof key === 'object' && !('token' in key))) continue;
    if (typeof key === 'object' && 'token' in key)
      throw new Error(`property(T.${key.token}) on an existing element not yet supported`);
    specs.push({ key, value: val, vtype: propVtype(s, val, off), meta: metaOf(metaArgs), cardinality });
  }
  const target = renderFrom(st.q, st.rel);
  if (elem === 'edge') {
    // Edge props are normalized rows with no cardinality/meta (TinkerPop Property):
    // UPSERT each into edge_properties, then read the bag back for the response.
    for (const sp of specs) {
      if (sp.cardinality !== 'single') throw new Error('Cardinality is not valid on an edge property');
      if (sp.meta) throw new Error('meta-properties are not valid on an edge property');
    }
    const readCur = `SELECT uid, src, tgt, (SELECT name FROM labels WHERE id=edges.label) AS label FROM edges WHERE id=?`;
    return {
      kind: 'write',
      run: (store) => store.query<{ id: number }>(target.sql, target.binds).map((r) => r.id).map((id) => {
        for (const sp of specs) {
          const r = resolveSpecValue(store, sp, id, 'edge', params);
          if (r.has) insertEdgeProperty(store, id, sp.key, r.value, r.vtype);
        }
        const cur = store.query<any>(readCur, [id])[0];
        return { edge: { id: cur.uid ?? id, label: cur.label, src: nodeExtId(store, cur.src), tgt: nodeExtId(store, cur.tgt), props: readEdgeProps(store, id) } };
      }),
    };
  }
  // Vertex props are normalized rows: apply each with its cardinality (+ meta).
  const readCur = `SELECT uid, (SELECT name FROM labels WHERE id=nodes.label) AS label FROM nodes WHERE id=?`;
  return {
    kind: 'write',
    run: (store) => store.query<{ id: number }>(target.sql, target.binds).map((r) => r.id).map((id) => {
      for (const sp of specs) {
        const r = resolveSpecValue(store, sp, id, 'node', params);
        if (r.has) applyVertexProperty(store, id, sp.key, r.value, r.vtype, sp.meta, sp.cardinality);
      }
      const cur = store.query<any>(readCur, [id])[0];
      return { vertex: { id: cur.uid ?? id, label: cur.label, props: readVertexProps(store, id) } };
    }),
  };
}

// g.inject(...) is a scalar-stream READ (not a write) — it compiles through the
// shared value tail in projection.ts (compileInject). WRITE_RULES routes it here
// only because it has no V/E source; see the import at the top of this file.

type Cardinality = 'single' | 'list' | 'set';
interface PropSpec { key: string; value: any; vtype: CanonicalType | null; meta: Record<string, any> | null; cardinality: Cardinality; }
interface VertexSpec { label: string; props: PropSpec[]; uid: string | number | null; }

// A leading Cardinality token on property() args (default single). Returns it plus
// the remaining [key, value, ...metaArgs], and `off` — how many leading args were
// consumed (0 or 1) so the caller can index the parallel argTypes for the value.
function readCardinality(args: any[]): { cardinality: Cardinality; rest: any[]; off: number } {
  if (args[0] && typeof args[0] === 'object' && 'cardinality' in args[0])
    return { cardinality: args[0].cardinality as Cardinality, rest: args.slice(1), off: 1 };
  return { cardinality: 'single', rest: args, off: 0 };
}

/** The canonical stored type of a property()'s VALUE arg: the type its carrying
 *  channel declared (Step.argTypes at the value's position), else inferred from the
 *  JS value. `off`+1 is the value's index in the original arg list (key is at off). */
const propVtype = (step: Step, val: any, off: number): CanonicalType | null =>
  gremlinTypeOf(val, step.argTypes?.[off + 1] ?? null);

// Trailing property() args after (key, value) are meta-property key/value pairs
// (VertexProperty meta-properties). A meta value must be a scalar (no traversal / no
// meta-of-meta).
function metaOf(metaArgs: any[]): Record<string, any> | null {
  if (!metaArgs.length) return null;
  if (metaArgs.length % 2 !== 0) throw new Error('property() meta-properties must be key/value pairs');
  const m: Record<string, any> = {};
  for (let i = 0; i < metaArgs.length; i += 2) {
    const mk = metaArgs[i];
    if (typeof mk !== 'string') throw new Error('property() meta-property key must be a string');
    const mv = metaArgs[i + 1];
    if (mv && typeof mv === 'object' && 'nested' in mv) throw new Error('property() meta-property value must be a scalar');
    m[mk] = mv;
  }
  return m;
}

// A single-cardinality prop bag (a merge map) → PropSpecs. Merge-map values carry no
// parsed argType (map literal / bound Map values are untyped), so vtype is inferred
// from the JS value — the honest fallback for an untyped channel.
const singleProps = (rec: Record<string, any>): PropSpec[] =>
  Object.entries(rec).map(([key, value]) => ({ key, value, vtype: gremlinTypeOf(value, null), meta: null, cardinality: 'single' as Cardinality }));

// An addV(...) step + its trailing property() steps → a vertex spec.
function parseVertexSpec(addV: Step, propSteps: Step[]): VertexSpec {
  let label = (typeof addV.args[0] === 'string' ? addV.args[0] : null) ?? 'vertex';
  const props: PropSpec[] = [];
  let uid: string | number | null = null;
  for (const s of propSteps) {
    const { cardinality, rest, off } = readCardinality(s.args);
    const [key, val, ...metaArgs] = rest;
    // property(null) / property([:]) / property([map]) — a null or map-form key adds
    // nothing (map-form property() is a no-op for now, matching TinkerPop's null/empty
    // cases; a populated map would add its entries, not yet implemented).
    if (key == null || (typeof key === 'object' && !('token' in key))) continue;
    if (typeof key === 'object' && 'token' in key) {
      if (metaArgs.length) throw new Error(`property(T.${key.token}) does not take meta-properties`);
      if (key.token === 'id') uid = val;
      else if (key.token === 'label') label = String(val);
      else throw new Error(`property(T.${key.token}) not supported`);
      continue;
    }
    props.push({ key, value: val, vtype: propVtype(s, val, off), meta: metaOf(metaArgs), cardinality });
  }
  return { label, props, uid };
}

// INSERT one row into nodes/edges with the shared optional-uid/id column splice.
// A string uid writes the `uid` column; a numeric uid writes the rowid `id`
// directly. Returns the rowid + external id (uid ?? rowid).
function insertRow(store: GraphStore, table: string, baseCols: string[], baseVals: any[], uid: string | number | null, jsonbCol?: string): { id: number; extId: string | number } {
  const uidCol = typeof uid === 'string' ? uid : null;
  const idCol = typeof uid === 'number' ? uid : null;
  const cols = [...baseCols, ...(uidCol !== null ? ['uid'] : []), ...(idCol !== null ? ['id'] : [])];
  const vals = [...baseVals, ...(uidCol !== null ? [uidCol] : []), ...(idCol !== null ? [idCol] : [])];
  // A JSONB column binds its JSON *text* and wraps jsonb(?) so SQLite builds the blob
  // (both runtimes accept a string bind; a raw Buffer bind would diverge — see storage.ts).
  const ph = (c: string) => c === jsonbCol ? 'jsonb(?)' : '?';
  const row = store.query<{ id: number; uid: string | null }>(
    `INSERT INTO ${table}(${cols.join(', ')}) VALUES(${cols.map(ph).join(', ')}) RETURNING id, uid`, vals)[0];
  return { id: row.id, extId: row.uid ?? row.id };
}

// A collection property value (list/map/set) → JSON text for `jsonb(?)`. A JS Map/Set
// must be converted first: JSON.stringify(new Map()/new Set()) is "{}" (no enumerable own
// props), which would silently drop every entry. Map→object (string keys), Set→array,
// recursively (a list can nest maps/sets). Read back via json() + JSON.parse (see
// readVertexProps/readEdgeProps) so the round-trip and P3 framing see a real array/object.
function collectionJson(val: any): string {
  const jsonable = (v: any): any =>
    Array.isArray(v) ? v.map(jsonable)
    : v instanceof Set ? Array.from(v, jsonable)
    : v instanceof Map ? Object.fromEntries(Array.from(v, ([k, x]) => [String(k), jsonable(x)]))
    : v;
  return JSON.stringify(jsonable(val));
}

// Decode a stored property VALUE for a write-response echo: a collection (list/map/set)
// arrives as `json(value)` TEXT (see the SELECTs below) → JSON.parse to a real array/
// object so framing picks the list/map/set serializer, not a raw-blob byte Map. A scalar
// passes through as its bound storage value.
const decodeStoredValue = (value: any, vtype: string | null): any =>
  isCollectionType(vtype) ? JSON.parse(value) : value;

// Set/append ONE vertex property (W4). single = replace all rows for the key then insert
// one; list = append; set = append unless an equal value already exists (then patch its
// meta). Meta is a {metaKey:scalar} object stored as a JSONB blob. A single SQL statement
// each (locked #3). A traversal-valued property defers to a later stage.
export function applyVertexProperty(
  store: GraphStore, node: number, key: string, val: any, vtype: CanonicalType | null,
  meta: Record<string, any> | null, cardinality: 'single' | 'list' | 'set',
): void {
  if (val && typeof val === 'object' && 'nested' in val) throw new Error('property() with a traversal value not yet supported');
  const metaJson = meta ? JSON.stringify(meta) : null;
  // A collection value (list/map/set) is stored as JSONB in the value column (bind the
  // JSON text, wrap jsonb(?)) — a raw JS array/Map bind would throw at the SQLite seam.
  // A scalar binds raw so it keeps its storage class (numeric order/range intact).
  const collection = isCollectionType(vtype);
  const storedVal = collection ? collectionJson(val) : val;
  const valPh = collection ? 'jsonb(?)' : '?';
  if (cardinality === 'single') store.query('DELETE FROM vertex_properties WHERE node=? AND key=?', [node, key]);
  if (cardinality === 'set') {
    const existing = store.query<{ id: number }>(`SELECT id FROM vertex_properties WHERE node=? AND key=? AND value=${valPh}`, [node, key, storedVal]);
    if (existing.length) {
      if (metaJson !== null) store.query('UPDATE vertex_properties SET meta=jsonb(?) WHERE id=?', [metaJson, existing[0].id]);
      return;
    }
  }
  store.query(
    `INSERT INTO vertex_properties(node, key, value, vtype, meta) VALUES(?, ?, ${valPh}, ?, ${metaJson === null ? 'NULL' : 'jsonb(?)'})`,
    metaJson === null ? [node, key, storedVal, vtype] : [node, key, storedVal, vtype, metaJson],
  );
}

// Set ONE edge property (single cardinality — edge Property has no meta/multi). One
// row per (edge,key): UPSERT on the UNIQUE(edge,key) constraint. Collections serialize
// to JSONB like vertex properties; scalars bind raw (storage class preserved).
export function insertEdgeProperty(store: GraphStore, edge: number, key: string, val: any, vtype: CanonicalType | null): void {
  if (val && typeof val === 'object' && 'nested' in val) throw new Error('property() with a traversal value not yet supported');
  const collection = isCollectionType(vtype);
  const storedVal = collection ? collectionJson(val) : val;
  const valPh = collection ? 'jsonb(?)' : '?';
  store.query(
    `INSERT INTO edge_properties(edge, key, value, vtype) VALUES(?, ?, ${valPh}, ?)
     ON CONFLICT(edge, key) DO UPDATE SET value=excluded.value, vtype=excluded.vtype`,
    [edge, key, storedVal, vtype],
  );
}

// Read an edge's properties back as a flat {key:value} bag for a write response
// (single-valued per key), from the normalized edge_properties table.
function readEdgeProps(store: GraphStore, edge: number): Record<string, any> {
  const out: Record<string, any> = {};
  for (const r of store.query<{ key: string; value: any; vtype: string | null }>(
    "SELECT key, CASE WHEN vtype IN ('list','map','set') THEN json(value) ELSE value END AS value, vtype FROM edge_properties WHERE edge=? ORDER BY id", [edge]))
    out[r.key] = decodeStoredValue(r.value, r.vtype);
  return out;
}

// Read a vertex's properties back as a flat {key:value} bag (first value under a key)
// for a write response. Multi-valued keys collapse to the first here — the write
// response shape is flat; full multi framing is on the read path.
function readVertexProps(store: GraphStore, node: number): Record<string, any> {
  const out: Record<string, any> = {};
  // A collection value is a JSONB blob — return json() TEXT so decodeStoredValue can
  // JSON.parse it to a real array/object (a raw blob would frame as a byte Map).
  for (const r of store.query<{ key: string; value: any; vtype: string | null }>(
    "SELECT key, CASE WHEN vtype IN ('list','map','set') THEN json(value) ELSE value END AS value, vtype FROM vertex_properties WHERE node=? ORDER BY id", [node]))
    if (!(r.key in out)) out[r.key] = decodeStoredValue(r.value, r.vtype);
  return out;
}

// Insert a vertex from a spec; returns its rowid and external id (uid ?? rowid).
function insertVertex(store: GraphStore, spec: VertexSpec): { id: number; extId: string | number } {
  const row = insertRow(store, 'nodes', ['label'], [store.labelId(spec.label)], spec.uid);
  for (const p of spec.props) applyVertexProperty(store, row.id, p.key, p.value, p.vtype, p.meta, p.cardinality);
  return row;
}

// g.addV('label').property(k, v)... — and multi-element chains (a graph initializer).
function compileAddV(steps: PStep[]): WritePlan {
  if (steps.some((s, i) => i > 0 && s.name !== 'property'))
    return { kind: 'write', run: (store) => runWriteChainFull(store, steps, {}) };
  const spec = parseVertexSpec(steps[0], steps.slice(1));
  return { kind: 'write', run: (store) => { const v = insertVertex(store, spec); return [{ vertex: { id: v.extId, label: spec.label, props: readVertexProps(store, v.id) } }]; } };
}

interface EdgeCluster { label: string; fromSpec: any; toSpec: any; edgeUid: string | number | null; props: Record<string, any>; propTypes: Record<string, CanonicalType | null>; next: number; }
function parseEdgeCluster(steps: Step[], addEIdx: number): EdgeCluster {
  const label = steps[addEIdx].args[0];
  if (typeof label !== 'string') throw new Error('addE(label): nested-traversal label not supported');
  let fromSpec: any, toSpec: any, edgeUid: string | number | null = null;
  const props: Record<string, any> = {};
  const propTypes: Record<string, CanonicalType | null> = {};
  let i = addEIdx + 1;
  for (; i < steps.length && (steps[i].name === 'from' || steps[i].name === 'to' || steps[i].name === 'property'); i++) {
    const m = steps[i];
    if (m.name === 'from') fromSpec = m.args[0];
    else if (m.name === 'to') toSpec = m.args[0];
    else {
      const { cardinality, rest, off } = readCardinality(m.args);
      const [k, v, ...metaArgs] = rest;
      if (cardinality !== 'single') throw new Error('Cardinality is not valid on an edge property');
      if (metaArgs.length) throw new Error('meta-properties are not valid on an edge property');
      if (k && typeof k === 'object' && 'token' in k) { if (k.token === 'id') edgeUid = v; else throw new Error(`property(T.${k.token}) on an edge not supported`); }
      else { props[k] = v; propTypes[k] = propVtype(m, v, off); }
    }
  }
  return { label, fromSpec, toSpec, edgeUid, props, propTypes, next: i };
}

function nodeExtId(store: GraphStore, rowid: number): any {
  return store.query<{ x: any }>('SELECT COALESCE(uid, id) AS x FROM nodes WHERE id=?', [rowid])[0]?.x ?? rowid;
}

// Insert one edge from a cluster + resolved endpoints; returns the framed result. The
// edge row carries no props (retired flat blob) — each property becomes an
// edge_properties row, typed via the cluster's captured argTypes (else JS-inferred).
function insertEdge(store: GraphStore, c: EdgeCluster, src: number, tgt: number): any {
  const { id, extId } = insertRow(store, 'edges', ['src', 'label', 'tgt'], [src, store.labelId(c.label), tgt], c.edgeUid);
  for (const [k, v] of Object.entries(c.props))
    insertEdgeProperty(store, id, k, v, c.propTypes[k] ?? gremlinTypeOf(v, null));
  return { edge: { id: extId, label: c.label, src: nodeExtId(store, src), tgt: nodeExtId(store, tgt), props: c.props } };
}

// Resolve a cluster's from()/to() and insert the edge.
function applyEdgeCluster(store: GraphStore, c: EdgeCluster, aliases: Map<string, number>, fallback: number | null, params: Record<string, any>): any {
  const src = c.fromSpec !== undefined ? resolveEndpoint(store, c.fromSpec, { aliases }, params) : fallback;
  const tgt = c.toSpec !== undefined ? resolveEndpoint(store, c.toSpec, { aliases }, params) : fallback;
  if (src == null || tgt == null) throw new Error('addE needs both endpoints — supply from()/to() or an incoming traverser');
  return insertEdge(store, c, src, tgt);
}

// addE — general form. A pure write chain goes to the sequential interpreter;
// otherwise a single addE with a V()-rooted prefix, one edge per resulting traverser.
function compileAddE(steps: PStep[], params: Record<string, any>): WritePlan {
  const CHAIN = new Set(['addV', 'as', 'addE', 'from', 'to', 'property']);
  if (steps.every((s) => CHAIN.has(s.name)))
    return { kind: 'write', run: (store) => runWriteChainFull(store, steps, params) };

  const addEIdx = steps.findIndex((s) => s.name === 'addE');
  const cluster = parseEdgeCluster(steps, addEIdx);
  if (cluster.next !== steps.length) throw new Error(`step not implemented after addE(): ${steps[cluster.next].name}()`);
  const prefix = steps.slice(0, addEIdx);
  const { st, stop } = buildPrefix(prefix, params);
  if (stop !== prefix.length) throw new Error(`addE after ${prefix[stop].name}() not yet supported`);
  // as() labels are JSONB history arrays; an addE endpoint is the label's last element
  // (a vertex). Extract its rowid in SQL so resolveEndpoint sees a plain id.
  const aliasCols: [string, string][] = [...st.carried.aliases].map(([lbl, a]) => [lbl, a.col]);
  const idExtract = (c: string) => `CAST(${c} ->> '$[#-1].v' AS INTEGER) AS ${c}`;
  const read = renderFrom(st.q, st.rel, ['id', ...aliasCols.map(([, c]) => idExtract(c))].join(', '));
  return {
    kind: 'write',
    run: (store) => store.query<any>(read.sql, read.binds).map((r) =>
      applyEdgeCluster(store, cluster, new Map(aliasCols.map(([lbl, c]) => [lbl, r[c]])), r.id, params)),
  };
}

// Interpret a linear write chain (addV/property/as/addE/from/to).
function runWriteChainFull(store: GraphStore, steps: Step[], params: Record<string, any>): any[] {
  const aliases = new Map<string, number>();
  let currentV: number | null = null;
  let last: any = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.name === 'addV') {
      const propSteps: Step[] = [];
      while (i + 1 < steps.length && steps[i + 1].name === 'property') propSteps.push(steps[++i]);
      const spec = parseVertexSpec(s, propSteps);
      const v = insertVertex(store, spec);
      currentV = v.id; last = { vertex: { id: v.extId, label: spec.label, props: readVertexProps(store, v.id) } };
    } else if (s.name === 'as') {
      if (currentV == null) throw new Error('as() before any vertex in write chain');
      for (const lbl of s.args) if (typeof lbl === 'string') aliases.set(lbl, currentV);
    } else if (s.name === 'addE') {
      const cluster = parseEdgeCluster(steps, i);
      i = cluster.next - 1;
      last = applyEdgeCluster(store, cluster, aliases, currentV, params);
    } else throw new Error(`write-chain step not supported: ${s.name}()`);
  }
  return last ? [last] : [];
}

// Resolve an addE from()/to() endpoint to a node rowid.
function resolveEndpoint(store: GraphStore, spec: any, d: { aliases: Map<string, number> }, params: Record<string, any>): number {
  if (typeof spec === 'string') {
    const id = d.aliases.get(spec);
    if (id === undefined) throw new Error(`addE from/to("${spec}"): unknown as() label`);
    return id;
  }
  if (spec && typeof spec === 'object' && spec.nested) {
    const inner = stepChain(spec.nested, params);
    const { st, stop } = buildPrefix(inner, params);
    if (stop !== inner.length) throw new Error(`addE endpoint traversal not supported past ${inner[stop].name}()`);
    const sel = renderFrom(st.q, st.rel);
    const rows = store.query<{ id: number }>(sel.sql, sel.binds);
    if (!rows.length) throw new Error('addE endpoint traversal matched no vertex');
    return rows[0].id;
  }
  throw new Error('addE from()/to() must be an as() label or a nested __.V(...) traversal');
}

// ---------- mergeV / mergeE (upsert) ----------

interface MergeSpec { label: string | null; id: string | number | null; outV: any; inV: any; props: Record<string, any>; }

function classifyMergeKey(k: any): { kind: 'label' | 'id' | 'outV' | 'inV' | 'prop'; name?: string } {
  const enumName = (typeName: string) => k && typeof k === 'object' && k.typeName === typeName ? String(k.elementName).toLowerCase() : null;
  const t = enumName('T') ?? (k && typeof k === 'object' && 'token' in k ? k.token : null);
  if (t) { if (t === 'label') return { kind: 'label' }; if (t === 'id') return { kind: 'id' }; throw new Error(`merge map key T.${t} not supported`); }
  const d = enumName('Direction') ?? (k && typeof k === 'object' && 'direction' in k ? k.direction : null);
  if (d) {
    if (d === 'out' || d === 'from') return { kind: 'outV' };
    if (d === 'in' || d === 'to') return { kind: 'inV' };
    throw new Error(`merge map key Direction.${d} not supported`);
  }
  return { kind: 'prop', name: String(k) };
}

function classifyMergeVal(v: any): any {
  const m = v && typeof v === 'object' ? (v.typeName === 'Merge' ? String(v.elementName).toLowerCase() : ('merge' in v ? v.merge : null)) : null;
  return m ? { incoming: m } : v;
}

function normalizeMergeMap(raw: any): MergeSpec {
  const spec: MergeSpec = { label: null, id: null, outV: undefined, inV: undefined, props: {} };
  if (raw == null) return spec; // mergeV(null) — match anything
  if (!(raw instanceof Map)) {
    if (raw && typeof raw === 'object' && 'nested' in raw) throw new Error('merge with a traversal argument (e.g. __.select(...)) not yet supported');
    throw new Error('merge argument must be a map ([k:v] / bound Map), null, or empty ([:])');
  }
  for (const [k, v] of raw) {
    const c = classifyMergeKey(k);
    if (c.kind === 'label') spec.label = String(v);
    else if (c.kind === 'id') spec.id = v;
    else if (c.kind === 'outV') spec.outV = classifyMergeVal(v);
    else if (c.kind === 'inV') spec.inV = classifyMergeVal(v);
    else spec.props[c.name!] = v;
  }
  return spec;
}

// The label / id-or-uid / per-prop equality conditions shared by the vertex and
// edge merge-match queries.
function commonMergeConds(spec: MergeSpec, elem: 'node' | 'edge'): Expression[] {
  const conds: Expression[] = [];
  if (spec.label != null) conds.push(labelIn('label', [spec.label]));
  if (spec.id != null) conds.push(typeof spec.id === 'number' ? q`id=${value(spec.id)}` : q`uid=${value(spec.id)}`);
  for (const [k, v] of Object.entries(spec.props))
    // An ANY-match EXISTS over the element's normalized properties table.
    conds.push(elem === 'node' ? nodeHasProp(raw('nodes.id'), k, v) : edgeHasProp(raw('edges.id'), k, v));
  return conds;
}

function mergeMatchQuery(spec: MergeSpec): { sql: string; binds: any[] } {
  const conds = commonMergeConds(spec, 'node');
  const where = conds.length ? list(conds, ' AND ') : q`1`;
  return render(q`SELECT id, uid, (SELECT name FROM labels WHERE id=nodes.label) AS label FROM nodes WHERE ${where}`);
}

function parseMergeOptions(mods: Step[], step: string): { onCreate: MergeSpec | null; onMatch: MergeSpec | null } {
  let onCreate: MergeSpec | null = null, onMatch: MergeSpec | null = null;
  for (const s of mods) {
    if (s.name !== 'option') throw new Error(`step not implemented after ${step}(): ${s.name}()`);
    const [sel, mapArg] = s.args;
    if (!sel || typeof sel !== 'object' || !('merge' in sel))
      throw new Error(`${step} option() selector must be Merge.onCreate/onMatch`);
    const spec = normalizeMergeMap(mapArg);
    if (sel.merge === 'oncreate') onCreate = spec;
    else if (sel.merge === 'onmatch') onMatch = spec;
    else throw new Error(`${step} option(Merge.${sel.merge}) not supported`);
  }
  return { onCreate, onMatch };
}

// The incoming traversers a merge runs once per, evaluated at run time.
function mergeDrivers(prefix: PStep[], params: Record<string, any>): (store: GraphStore) => (number | null)[] {
  if (prefix.length === 0) return () => [null];
  if (prefix.length === 1 && prefix[0].name === 'inject') { const nulls = prefix[0].args.map(() => null); return () => nulls; }
  const { st, stop } = buildPrefix(prefix, params);
  if (stop !== prefix.length) throw new Error(`merge after ${prefix[stop].name}() not yet supported`);
  const sel = renderFrom(st.q, st.rel);
  return (store) => store.query<{ id: number }>(sel.sql, sel.binds).map((r) => r.id);
}

// g.mergeV(map) [.option(Merge.onCreate, map)] [.option(Merge.onMatch, map)]
function compileMergeV(steps: PStep[], params: Record<string, any>): WritePlan {
  const mvIdx = steps.findIndex((s) => s.name === 'mergeV');
  if (steps[mvIdx].args.length === 0)
    throw new Error('mergeV() with no argument (uses the incoming traverser as the map) not yet supported');
  const matchSpec = normalizeMergeMap(steps[mvIdx].args[0]);
  const { onCreate, onMatch } = parseMergeOptions(steps.slice(mvIdx + 1), 'mergeV');
  const drivers = mergeDrivers(steps.slice(0, mvIdx), params);
  const match = mergeMatchQuery(matchSpec);
  return {
    kind: 'write',
    run: (store) => {
      const out: any[] = [];
      for (const _driver of drivers(store)) {
        const matches = store.query<any>(match.sql, match.binds);
        if (matches.length) {
          for (const m of matches) {
            if (onMatch) for (const [k, v] of Object.entries(onMatch.props)) applyVertexProperty(store, m.id, k, v, gremlinTypeOf(v, null), null, 'single');
            out.push({ vertex: { id: m.uid ?? m.id, label: m.label, props: readVertexProps(store, m.id) } });
          }
        } else {
          const label = onCreate?.label ?? matchSpec.label ?? 'vertex';
          const props = { ...matchSpec.props, ...(onCreate?.props ?? {}) };
          const v = insertVertex(store, { label, props: singleProps(props), uid: matchSpec.id ?? onCreate?.id ?? null });
          out.push({ vertex: { id: v.extId, label, props } });
        }
      }
      return out;
    },
  };
}

// Resolve a mergeE endpoint spec to a node rowid, requiring the vertex to exist.
function resolveMergeEndpoint(store: GraphStore, raw: any): number {
  const r = store.query<{ id: number }>(
    typeof raw === 'number' ? 'SELECT id FROM nodes WHERE id=?' : 'SELECT id FROM nodes WHERE uid=?', [raw])[0];
  if (!r) throw new Error('Vertex does not exist for mergeE');
  return r.id;
}

function edgeMatchQuery(spec: MergeSpec, outV: number, inV: number): { sql: string; binds: any[] } {
  const conds: Expression[] = [q`src=${value(outV)}`, q`tgt=${value(inV)}`, ...commonMergeConds(spec, 'edge')];
  return render(q`SELECT id, uid, src, tgt, (SELECT name FROM labels WHERE id=edges.label) AS label FROM edges WHERE ${list(conds, ' AND ')}`);
}

// g.mergeE(map) [.option(Merge.onCreate, map)] [.option(Merge.onMatch, map)]
function compileMergeE(steps: PStep[], params: Record<string, any>): WritePlan {
  const meIdx = steps.findIndex((s) => s.name === 'mergeE');
  if (steps[meIdx].args.length === 0)
    throw new Error('mergeE() with no argument (uses the incoming traverser as the map) not yet supported');
  const matchSpec = normalizeMergeMap(steps[meIdx].args[0]);
  const { onCreate, onMatch } = parseMergeOptions(steps.slice(meIdx + 1), 'mergeE');
  const drivers = mergeDrivers(steps.slice(0, meIdx), params);
  return {
    kind: 'write',
    run: (store) => {
      const endpoint = (spec: any, oc: any, cur: number | null, role: string): number => {
        const raw = spec?.incoming !== undefined ? cur : spec ?? (oc?.incoming !== undefined ? cur : oc);
        if (raw == null) throw new Error(`mergeE: missing ${role} endpoint (need Direction.${role === 'outV' ? 'OUT' : 'IN'} or an incoming traverser)`);
        return resolveMergeEndpoint(store, raw);
      };
      const out: any[] = [];
      for (const cur of drivers(store)) {
        const outV = endpoint(matchSpec.outV, onCreate?.outV, cur, 'outV');
        const inV = endpoint(matchSpec.inV, onCreate?.inV, cur, 'inV');
        const match = edgeMatchQuery(matchSpec, outV, inV);
        const matches = store.query<any>(match.sql, match.binds);
        if (matches.length) {
          for (const m of matches) {
            if (onMatch) for (const [k, v] of Object.entries(onMatch.props)) insertEdgeProperty(store, m.id, k, v, gremlinTypeOf(v, null));
            out.push({ edge: { id: m.uid ?? m.id, label: m.label, src: nodeExtId(store, m.src), tgt: nodeExtId(store, m.tgt), props: readEdgeProps(store, m.id) } });
          }
        } else {
          const label = matchSpec.label ?? onCreate?.label;
          if (!label) throw new Error('mergeE cannot create an edge without a label');
          const props = { ...matchSpec.props, ...(onCreate?.props ?? {}) };
          out.push(insertEdge(store, { label, fromSpec: undefined, toSpec: undefined, edgeUid: matchSpec.id ?? onCreate?.id ?? null, props, propTypes: {}, next: 0 }, outV, inV));
        }
      }
      return out;
    },
  };
}

// ---------- write dispatch table ----------
//
// Ordered rules: the first whose `match` fires compiles the chain. Order matters
// (addE before addV; drop must be the terminal step) — hence a rule list, not a
// name→fn Map. Returns null when the chain is a read (compiler falls to compileRead).
interface WriteRule { match: (steps: PStep[]) => boolean; compile: (steps: PStep[], params: Record<string, any>, sackInit?: SackSpec) => WritePlan | Compiled; }

const WRITE_RULES: WriteRule[] = [
  { match: (s) => s.some((x) => x.name === 'addE'), compile: (s, p) => compileAddE(s, p) },
  { match: (s) => s[0].name === 'addV', compile: (s) => compileAddV(s) },
  { match: (s) => s.some((x) => x.name === 'mergeV'), compile: (s, p) => compileMergeV(s, p) },
  { match: (s) => s.some((x) => x.name === 'mergeE'), compile: (s, p) => compileMergeE(s, p) },
  // inject is a scalar-stream READ, not a write — it lives here only because it's a
  // source constructor. It threads withSack() so a sack-carrying value stream
  // (withSack(x).inject(v).sack(...)) seeds its `sk` column like the V()/E() path.
  { match: (s) => s[0].name === 'inject', compile: (s, _p, sackInit) => compileInject(s, sackInit) },
  { match: (s) => s[s.length - 1].name === 'drop', compile: (s) => compileDrop(s) },
  { match: (s) => s.some((x) => x.name === 'property'), compile: (s, p) => compileSetProperty(s, p) },
];

/** Route a step chain to its write compiler, or null if it's a read. */
export function routeWrite(steps: PStep[], params: Record<string, any>, sackInit?: SackSpec): WritePlan | Compiled | null {
  for (const rule of WRITE_RULES) if (rule.match(steps)) return rule.compile(steps, params, sackInit);
  return null;
}
