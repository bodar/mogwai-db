import type { GraphStore } from '../storage.ts';
import { q, value, list, Query } from '../q.ts';
import { propExtract } from '../plan.ts';
import { stepChain, type Step } from '../frontend.ts';
import { type PStep } from '../strategies.ts';
import { render, readCompiled, renderFrom, type Compiled, type WritePlan } from '../render.ts';
import { buildPrefix } from './index.ts';
import { type Expression } from '@bodar/lazyrecords/sql/template/Expression.ts';

// ---------- write compilers ----------
//
// Writes are an imperative interpreter (sequential INSERT/UPDATE/DELETE threading
// store state + as() aliases) — not a functional CTE fold — so these stay closure
// builders over the store. They reuse the read prefix (buildPrefix) to materialize
// target ids, then mutate. The WRITE_RULES table (bottom) routes a step chain to
// the right compiler; routing is predicate/position based (addE can be mid-chain,
// drop must be last), so it's an ordered rule list rather than a name→fn Map.

// g.V(...).<filters>.drop() — delete the target vertices and their incident edges.
function compileDrop(steps: PStep[]): WritePlan {
  const { st, stop } = buildPrefix(steps.slice(0, -1));
  if (stop !== steps.length - 1) throw new Error(`drop() after ${steps[stop].name}() not yet supported`);
  if (st.elem === 'edge') throw new Error('edge drop() (e.g. g.E().drop()) not yet supported');
  const target = renderFrom(st.q, st.last);
  return {
    kind: 'write',
    run: (store) => {
      // Materialize the target ids ONCE, before mutating. Deleting incident edges
      // first would empty a re-evaluated target CTE (if it reads the edges table),
      // silently leaving vertices behind. Snapshot ids, then delete by value.
      const ids = store.query<{ id: number }>(target.sql, target.binds).map((r) => r.id);
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        store.query(`DELETE FROM edges WHERE src IN (${ph}) OR tgt IN (${ph})`, [...ids, ...ids]);
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
  const setProps: Record<string, any> = {};
  for (const s of steps.slice(firstProp)) {
    if (s.name !== 'property') throw new Error(`step not implemented after property(): ${s.name}()`);
    const [key, val] = stripCardinality(s.args);
    if (key && typeof key === 'object' && 'token' in key)
      throw new Error(`property(T.${key.token}) on an existing element not yet supported`);
    setProps[key] = val;
  }
  const tbl = elem === 'edge' ? 'edges' : 'nodes';
  const labelSub = `(SELECT name FROM labels WHERE id=${tbl}.label) AS label`;
  const readCur = elem === 'edge'
    ? `SELECT uid, src, tgt, props, ${labelSub} FROM edges WHERE id=?`
    : `SELECT uid, props, ${labelSub} FROM nodes WHERE id=?`;
  const target = renderFrom(st.q, st.last);
  return {
    kind: 'write',
    run: (store) => {
      const ids = store.query<{ id: number }>(target.sql, target.binds).map((r) => r.id);
      return ids.map((id) => {
        const cur = store.query<any>(readCur, [id])[0];
        const props = { ...JSON.parse(cur.props), ...setProps };
        store.query(`UPDATE ${tbl} SET props=? WHERE id=?`, [JSON.stringify(props), id]);
        return elem === 'edge'
          ? { edge: { id: cur.uid ?? id, label: cur.label, src: nodeExtId(store, cur.src), tgt: nodeExtId(store, cur.tgt), props } }
          : { vertex: { id: cur.uid ?? id, label: cur.label, props } };
      });
    },
  };
}

// g.inject(v1, v2, ...) — seed a value stream from constants.
function compileInject(steps: PStep[]): Compiled {
  if (steps.length !== 1) throw new Error('inject() with subsequent steps not yet supported');
  const vals = steps[0].args;
  if (vals.length === 0)
    return { kind: 'read', sql: `SELECT NULL AS v WHERE 0`, binds: [], shape: { kind: 'value' } };
  // WITH c0(v) AS (VALUES (?), …) SELECT v FROM c0. Injected values ride as Value
  // tokens (one row each), so binds derive from the tree.
  const Q = new Query();
  const rows = list(vals.map((v) => q`(${value(v)})`), ', ');
  const c0 = Q.cte(q`VALUES ${rows}`, ['v']);
  return readCompiled(Q, q`SELECT v FROM ${c0}`, { kind: 'value' });
}

interface VertexSpec { label: string; props: Record<string, any>; uid: string | number | null; }

// A leading Cardinality token on property() args: `single` is a no-op we drop;
// list/set (real multi-property) wait on W4's schema rework.
function stripCardinality(args: any[]): any[] {
  if (args[0] && typeof args[0] === 'object' && 'cardinality' in args[0]) {
    if (args[0].cardinality !== 'single') throw new Error(`property(Cardinality.${args[0].cardinality}) (multi-property) deferred to W4`);
    return args.slice(1);
  }
  return args;
}

// An addV(...) step + its trailing property() steps → a vertex spec.
function parseVertexSpec(addV: Step, propSteps: Step[]): VertexSpec {
  let label = (typeof addV.args[0] === 'string' ? addV.args[0] : null) ?? 'vertex';
  const props: Record<string, any> = {};
  let uid: string | number | null = null;
  for (const s of propSteps) {
    const [key, val] = stripCardinality(s.args);
    if (key && typeof key === 'object' && 'token' in key) {
      if (key.token === 'id') uid = val;
      else if (key.token === 'label') label = String(val);
      else throw new Error(`property(T.${key.token}) not supported`);
      continue;
    }
    props[key] = val;
  }
  return { label, props, uid };
}

// INSERT one row into nodes/edges with the shared optional-uid/id column splice.
// A string uid writes the `uid` column; a numeric uid writes the rowid `id`
// directly. Returns the rowid + external id (uid ?? rowid).
function insertRow(store: GraphStore, table: string, baseCols: string[], baseVals: any[], uid: string | number | null): { id: number; extId: string | number } {
  const uidCol = typeof uid === 'string' ? uid : null;
  const idCol = typeof uid === 'number' ? uid : null;
  const cols = [...baseCols, ...(uidCol !== null ? ['uid'] : []), ...(idCol !== null ? ['id'] : [])];
  const vals = [...baseVals, ...(uidCol !== null ? [uidCol] : []), ...(idCol !== null ? [idCol] : [])];
  const row = store.query<{ id: number; uid: string | null }>(
    `INSERT INTO ${table}(${cols.join(', ')}) VALUES(${cols.map(() => '?').join(', ')}) RETURNING id, uid`, vals)[0];
  return { id: row.id, extId: row.uid ?? row.id };
}

// Insert a vertex from a spec; returns its rowid and external id (uid ?? rowid).
function insertVertex(store: GraphStore, spec: VertexSpec): { id: number; extId: string | number } {
  return insertRow(store, 'nodes', ['label', 'props'], [store.labelId(spec.label), JSON.stringify(spec.props)], spec.uid);
}

// g.addV('label').property(k, v)... — and multi-element chains (a graph initializer).
function compileAddV(steps: PStep[]): WritePlan {
  if (steps.some((s, i) => i > 0 && s.name !== 'property'))
    return { kind: 'write', run: (store) => runWriteChainFull(store, steps, {}) };
  const spec = parseVertexSpec(steps[0], steps.slice(1));
  return { kind: 'write', run: (store) => [{ vertex: { id: insertVertex(store, spec).extId, label: spec.label, props: spec.props } }] };
}

interface EdgeCluster { label: string; fromSpec: any; toSpec: any; edgeUid: string | number | null; props: Record<string, any>; next: number; }
function parseEdgeCluster(steps: Step[], addEIdx: number): EdgeCluster {
  const label = steps[addEIdx].args[0];
  if (typeof label !== 'string') throw new Error('addE(label): nested-traversal label not supported');
  let fromSpec: any, toSpec: any, edgeUid: string | number | null = null;
  const props: Record<string, any> = {};
  let i = addEIdx + 1;
  for (; i < steps.length && (steps[i].name === 'from' || steps[i].name === 'to' || steps[i].name === 'property'); i++) {
    const m = steps[i];
    if (m.name === 'from') fromSpec = m.args[0];
    else if (m.name === 'to') toSpec = m.args[0];
    else {
      const [k, v] = stripCardinality(m.args);
      if (k && typeof k === 'object' && 'token' in k) { if (k.token === 'id') edgeUid = v; else throw new Error(`property(T.${k.token}) on an edge not supported`); }
      else props[k] = v;
    }
  }
  return { label, fromSpec, toSpec, edgeUid, props, next: i };
}

function nodeExtId(store: GraphStore, rowid: number): any {
  return store.query<{ x: any }>('SELECT COALESCE(uid, id) AS x FROM nodes WHERE id=?', [rowid])[0]?.x ?? rowid;
}

// Insert one edge from a cluster + resolved endpoints; returns the framed result.
function insertEdge(store: GraphStore, c: EdgeCluster, src: number, tgt: number): any {
  const { extId } = insertRow(store, 'edges', ['src', 'label', 'tgt', 'props'], [src, store.labelId(c.label), tgt, JSON.stringify(c.props)], c.edgeUid);
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
  const aliasCols: [string, string][] = [...st.aliases].map(([lbl, a]) => [lbl, a.col]);
  const read = renderFrom(st.q, st.last, ['id', ...aliasCols.map(([, c]) => c)].join(', '));
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
      currentV = v.id; last = { vertex: { id: v.extId, label: spec.label, props: spec.props } };
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
    const sel = renderFrom(st.q, st.last);
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
function commonMergeConds(spec: MergeSpec): Expression[] {
  const conds: Expression[] = [];
  if (spec.label != null) conds.push(q`label IN (SELECT id FROM labels WHERE name=${value(spec.label)})`);
  if (spec.id != null) conds.push(typeof spec.id === 'number' ? q`id=${value(spec.id)}` : q`uid=${value(spec.id)}`);
  for (const [k, v] of Object.entries(spec.props))
    conds.push(q`${propExtract('props', k).expr} = ${value(v)}`);
  return conds;
}

function mergeMatchQuery(spec: MergeSpec): { sql: string; binds: any[] } {
  const conds = commonMergeConds(spec);
  const where = conds.length ? list(conds, ' AND ') : q`1`;
  return render(q`SELECT id, uid, (SELECT name FROM labels WHERE id=nodes.label) AS label, props FROM nodes WHERE ${where}`);
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
  const sel = renderFrom(st.q, st.last);
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
            let props = JSON.parse(m.props);
            if (onMatch) { props = { ...props, ...onMatch.props }; store.query('UPDATE nodes SET props=? WHERE id=?', [JSON.stringify(props), m.id]); }
            out.push({ vertex: { id: m.uid ?? m.id, label: m.label, props } });
          }
        } else {
          const label = onCreate?.label ?? matchSpec.label ?? 'vertex';
          const props = { ...matchSpec.props, ...(onCreate?.props ?? {}) };
          const v = insertVertex(store, { label, props, uid: matchSpec.id ?? onCreate?.id ?? null });
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
  const conds: Expression[] = [q`src=${value(outV)}`, q`tgt=${value(inV)}`, ...commonMergeConds(spec)];
  return render(q`SELECT id, uid, src, tgt, (SELECT name FROM labels WHERE id=edges.label) AS label, props FROM edges WHERE ${list(conds, ' AND ')}`);
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
            let props = JSON.parse(m.props);
            if (onMatch) { props = { ...props, ...onMatch.props }; store.query('UPDATE edges SET props=? WHERE id=?', [JSON.stringify(props), m.id]); }
            out.push({ edge: { id: m.uid ?? m.id, label: m.label, src: nodeExtId(store, m.src), tgt: nodeExtId(store, m.tgt), props } });
          }
        } else {
          const label = matchSpec.label ?? onCreate?.label;
          if (!label) throw new Error('mergeE cannot create an edge without a label');
          const props = { ...matchSpec.props, ...(onCreate?.props ?? {}) };
          out.push(insertEdge(store, { label, fromSpec: undefined, toSpec: undefined, edgeUid: matchSpec.id ?? onCreate?.id ?? null, props, next: 0 }, outV, inV));
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
interface WriteRule { match: (steps: PStep[]) => boolean; compile: (steps: PStep[], params: Record<string, any>) => WritePlan | Compiled; }

const WRITE_RULES: WriteRule[] = [
  { match: (s) => s.some((x) => x.name === 'addE'), compile: (s, p) => compileAddE(s, p) },
  { match: (s) => s[0].name === 'addV', compile: (s) => compileAddV(s) },
  { match: (s) => s.some((x) => x.name === 'mergeV'), compile: (s, p) => compileMergeV(s, p) },
  { match: (s) => s.some((x) => x.name === 'mergeE'), compile: (s, p) => compileMergeE(s, p) },
  { match: (s) => s[0].name === 'inject', compile: (s) => compileInject(s) },
  { match: (s) => s[s.length - 1].name === 'drop', compile: (s) => compileDrop(s) },
  { match: (s) => s.some((x) => x.name === 'property'), compile: (s, p) => compileSetProperty(s, p) },
];

/** Route a step chain to its write compiler, or null if it's a read. */
export function routeWrite(steps: PStep[], params: Record<string, any>): WritePlan | Compiled | null {
  for (const rule of WRITE_RULES) if (rule.match(steps)) return rule.compile(steps, params);
  return null;
}
