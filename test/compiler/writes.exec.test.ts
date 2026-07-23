// Compiler execution semantics (split from test/compiler.test.ts) — writes (drop / property / addV / addE / mergeV / mergeE).
// Runs compiled SQL against a seeded in-memory store, asserting RESULTS. Pure cut-
// and-paste relocation; the SQL-string snapshots live at test/L2-sql/*.sql.test.ts.
import { test, expect, describe } from 'bun:test';
import { compile, type CompileOptions } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery } from '../support/executor.ts';
import { ioc } from '../../src/io.ts';
import { parseRequest } from '../../src/wire.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { assertStreamColumns } from '../../src/steps/context/stream.ts';
import { pushChildScope } from '../../src/steps/tail/child.ts';

const read = (q: string, options?: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind !== 'read') throw new Error('expected read plan');
  return p;
};

// ---------- execution semantics against a seeded store ----------

function seededStore() {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const q of MODERN_SEED) executeQuery(store, q, {}); // seed by running the write traversals
  return store;
}

const run = (store: GraphStore, q: string) => {
  const p = compile(q, {});
  if (p.kind === 'write') return p.run(store);
  return store.query(p.sql, p.binds);
};

// A write-response echo now carries each prop value as a self-describing {t,v} typed node
// (so the wire frames it exactly). Tests that assert the written VALUES (not their types)
// unwrap the nodes to plain values with this recursive helper.
const bare = (v: any): any =>
  Array.isArray(v) ? v.map(bare)
  : v && typeof v === 'object' && 't' in v && 'v' in v ? bare(v.v)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bare(x)]))
  : v;

const runWith = (store: GraphStore, q: string, options: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind === 'write') return p.run(store);
  return store.query(p.sql, p.binds);
};

describe("write execution", () => {
test('drop() after an edge-reading traversal deletes the right vertices', () => {
  // regression: g.V(1).out().drop() must drop marko's out-neighbors, not just
  // their edges. Snapshotting target ids before mutating guards this.
  const store = seededStore();
  run(store, 'g.V(1).out().drop()'); // vadas(2), lop(3), josh(4)
  const remaining = run(store, 'g.V().values("name")').map((r) => r.v).sort();
  expect(remaining).toEqual(['marko', 'peter', 'ripple']);
});

test('drop() removes vertices and their incident edges', () => {
  const store = seededStore();
  run(store, 'g.V(1).drop()'); // marko + edges 7,8,9
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([5]);
  // marko was src of 3 edges; all gone
  expect(store.query('SELECT COUNT(*) AS c FROM edges')[0].c).toBe(3);
});

test('g.V().drop() empties the graph (cucumber reset idiom)', () => {
  const store = seededStore();
  run(store, 'g.V().drop()');
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([0]);
  expect(store.query('SELECT COUNT(*) AS c FROM edges')[0].c).toBe(0);
});

test('edge drop() deletes only the matched edges, not their endpoints', () => {
  const store = seededStore();
  run(store, 'g.V(1).outE().drop()'); // marko's 3 out-edges (7,8,9)
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([6]); // every vertex survives
  expect(store.query('SELECT COUNT(*) AS c FROM edges')[0].c).toBe(3); // edges 10,11,12 remain
});

test('g.E().drop() removes every edge but keeps all vertices', () => {
  const store = seededStore();
  run(store, 'g.E().drop()');
  expect(store.query('SELECT COUNT(*) AS c FROM edges')[0].c).toBe(0);
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([6]);
});

test('property() updates existing vertices (overwrite + new key, single cardinality)', () => {
  const store = seededStore();
  // overwrite marko's age, add a new key
  const res = run(store, 'g.V(1).property("age", 30).property("city", "London")');
  expect(bare((res[0] as any).vertex)).toEqual({ id: 1, label: 'person', props: { name: 'marko', age: 30, city: 'London' } });
  expect(run(store, 'g.V(1).values("age")').map((r) => r.v)).toEqual([30]);
  expect(run(store, 'g.V(1).values("city")').map((r) => r.v)).toEqual(['London']);
  // untouched vertices keep their props
  expect(run(store, 'g.V(2).values("age")').map((r) => r.v)).toEqual([27]);
});

test('property() updates every matched vertex in the set', () => {
  const store = seededStore();
  run(store, 'g.V().hasLabel("person").property("kind", "human")');
  expect(run(store, 'g.V().has("kind","human").count()').map((r) => r.v)).toEqual([4]);
});

test('property(k, __.trav): correlated value from the read spine', () => {
  const store = seededStore();
  // scalar copy: each person's age → a new key, evaluated per element
  run(store, 'g.V().has("age").property("a2", __.values("age"))');
  expect(run(store, 'g.V().values("a2")').map((r) => r.v).sort((a, b) => a - b)).toEqual([27, 29, 32, 35]);
  // count-shaped value: marko(1) has 3 out-edges → deg=3, stored as a Long vtype
  run(store, 'g.V(1).property("deg", __.outE().count())');
  expect(run(store, 'g.V(1).values("deg")').map((r) => r.v)).toEqual([3]);
  expect(store.query("SELECT vtype FROM vertex_properties WHERE key='deg'", []).map((r: any) => r.vtype)).toEqual(['long']);
  // empty nested traversal → the property is NOT written (lop=3 has no age)
  run(store, 'g.V(3).property("noage", __.values("age"))');
  expect(run(store, 'g.V(3).values("noage")').length).toBe(0);
  // edge property from a traversal value
  run(store, 'g.E().property("checked", __.constant(true))');
  expect(run(store, 'g.E().values("checked")').every((r: any) => r.v === 1 || r.v === true)).toBe(true);
});

test('property() cardinality: single replaces, list appends, set dedups (W4)', () => {
  const store = seededStore();
  // single replaces the existing value
  run(store, 'g.V(1).property(Cardinality.single, "age", 40)');
  expect(run(store, 'g.V(1).values("age")').map((r) => r.v)).toEqual([40]);
  // list appends — multiple values under one key
  run(store, 'g.V(1).property(Cardinality.list, "nick", "x")');
  run(store, 'g.V(1).property(Cardinality.list, "nick", "y")');
  expect(run(store, 'g.V(1).values("nick")').map((r) => r.v).sort()).toEqual(['x', 'y']);
  // set dedups by value — re-adding "x" is a no-op
  run(store, 'g.V(1).property(Cardinality.set, "nick", "x")');
  expect(run(store, 'g.V(1).values("nick")').map((r) => r.v).sort()).toEqual(['x', 'y']);
  // has() matches ANY value under the key (multi-property semantics)
  expect(run(store, 'g.V(1).has("nick","y").count()').map((r) => r.v)).toEqual([1]);
});

test('addV multi-property + meta-property write (W4)', () => {
  const store = seededStore();
  run(store, 'g.addV("crew").property(Cardinality.list, "location", "sd", "startTime", 1997).property(Cardinality.list, "location", "sf", "startTime", 2005)');
  // both values land under the multi-valued key
  expect(run(store, 'g.V().hasLabel("crew").values("location")').map((r) => r.v).sort()).toEqual(['sd', 'sf']);
  // the meta blob is stored on the VertexProperty row
  const metas = store.query("SELECT json(meta) m FROM vertex_properties WHERE key='location' ORDER BY value").map((r: any) => JSON.parse(r.m));
  expect(metas).toEqual([{ startTime: 1997 }, { startTime: 2005 }]);
});

test('meta-property read chains: has(metaKey) filter, properties().properties(), valueMap (W4)', () => {
  const store = seededStore();
  run(store, 'g.V(1).property(Cardinality.single, "name", "stephenm", "since", 2010)');
  // properties(k).has(metaKey, v) filters the VertexProperty stream by its meta
  expect(run(store, 'g.V(1).properties("name").has("since",2010).count()').map((r) => r.v)).toEqual([1]);
  expect(run(store, 'g.V(1).properties("name").has("since",2011).count()').map((r) => r.v)).toEqual([0]);
  // properties().properties() explodes a VertexProperty's meta into Property elements
  expect(run(store, 'g.V(1).properties("name").properties()').length).toBe(1); // one meta-prop: since
  // properties(k).valueMap() shape is a flat meta map
  expect(read('g.V(1).properties("name").valueMap()').shape).toEqual({ kind: 'metaMap' });
  // properties().id() surfaces the real VertexProperty rowid
  expect(read('g.V(1).properties("name").id()').shape).toEqual({ kind: 'value' });
});

test('property() updates edges too (materialized on the wire via edgeBuffer)', () => {
  const store = seededStore();
  const res = run(store, 'g.V(1).outE("created").property("weight2", 0.9)');
  expect(bare((res[0] as any).edge.props)).toEqual({ weight: 0.4, weight2: 0.9 });
  expect(run(store, 'g.V(1).outE("created").values("weight2")').map((r) => r.v)).toEqual([0.9]);
});

test('addE start-step: from()/to() nested traversals + edge property', () => {
  const store = seededStore();
  const res = run(store, 'g.addE("knows").from(__.V().has("name","marko")).to(__.V().has("name","vadas")).property("weight", 0.9)');
  expect(bare((res[0] as any).edge)).toMatchObject({ label: 'knows', src: 1, tgt: 2, props: { weight: 0.9 } });
  // marko already knew vadas (edge 7); now a second knows edge exists → 2 paths to vadas
  expect(run(store, 'g.V(1).out("knows").has("name","vadas").count()').map((r) => r.v)).toEqual([2]);
  expect(run(store, 'g.V(1).outE("knows").count()').map((r) => r.v)).toEqual([3]);
});

test('addE from() sets outV, incoming traverser is inV', () => {
  const store = seededStore();
  // g.V(2).addE("likes").from(__.V(1)) → edge 1→2 (inV defaults to current, vadas)
  run(store, 'g.V(2).addE("likes").from(__.V(1))');
  expect(run(store, 'g.V(1).out("likes").values("name")').map((r) => r.v)).toEqual(['vadas']);
});

test('addE mid-traversal with as() alias endpoint (per incoming traverser)', () => {
  const store = seededStore();
  // everything marko created gets a createdBy edge back to marko
  run(store, 'g.V(1).as("a").out("created").addE("createdBy").to("a")');
  expect(run(store, 'g.V(3).out("createdBy").values("name")').map((r) => r.v)).toEqual(['marko']);
});

test('addE sets its own uid via property(T.id)', () => {
  const store = seededStore();
  const res = run(store, 'g.addE("knows").from(__.V(1)).to(__.V(2)).property(T.id, "e:marko-vadas")');
  expect((res[0] as any).edge.id).toBe('e:marko-vadas');
  expect(run(store, 'g.E("e:marko-vadas").label()').map((r) => r.v)).toEqual(['knows']);
});

test('addE write-chain graph initializer (addV.as.addV.as.addE.from.to)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  run(store, 'g.addV("person").property("name","marko").as("a").addV("person").property("name","vadas").as("b").addE("knows").from("a").to("b").property("weight", 0.5)');
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([2]);
  expect(run(store, 'g.V().has("name","marko").out("knows").values("name")').map((r) => r.v)).toEqual(['vadas']);
  expect(run(store, 'g.V().has("name","marko").outE("knows").values("weight")').map((r) => r.v)).toEqual([0.5]);
});

test('addV inline property NESTED value routes through resolveSpecValue', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  // __.constant(v) as an inline property value — evaluated at the new vertex.
  const res = run(store, 'g.addV("person").property("age", __.constant(29)).property("name", "marko")');
  expect(bare((res[0] as any).vertex)).toMatchObject({ label: 'person', props: { name: 'marko', age: 29 } });
  expect(run(store, 'g.V().has("person","age",29).values("name")').map((r) => r.v)).toEqual(['marko']);
});

test('addV nested property value seeds at the NEW (edge-less) vertex → out().count()=0', () => {
  const store = seededStore();
  run(store, 'g.addV("person").property("name","x").property("deg", __.out().count())');
  expect(run(store, 'g.V().has("name","x").values("deg")').map((r) => r.v)).toEqual([0]);
});

test('addE inline property NESTED value resolves + response echoes the resolved value', () => {
  const store = seededStore();
  const res = run(store, 'g.addE("knows").from(__.V(1)).to(__.V(2)).property("w", __.constant(0.7))');
  // the framed response carries the resolved scalar, never a {nested} blob
  expect(bare((res[0] as any).edge.props)).toEqual({ w: 0.7 });
  expect(run(store, 'g.V(1).outE("knows").values("w")').map((r) => r.v)).toEqual([0.7]);
});

test('addV nested-traversal LABEL is evaluated at run time (no silent "vertex" default)', () => {
  const store = seededStore(); // modern: V(1)=marko/person
  run(store, 'g.addV(__.V(1).label()).property("name","clone")');
  expect(run(store, 'g.V().has("name","clone").label()').map((r) => r.v)).toEqual(['person']);
});

test('addE endpoint to(__.select("a")) ≡ to("a") (as()-label via nested select)', () => {
  const store = seededStore();
  run(store, 'g.V(1).as("a").out("created").addE("createdBy").to(__.select("a"))');
  expect(run(store, 'g.V(3).out("createdBy").values("name")').map((r) => r.v)).toEqual(['marko']);
});

test('addE endpoint to(__.addV(...)) creates the target vertex as a side effect', () => {
  const store = seededStore(); // modern: 6 vertices
  run(store, 'g.addE("next").from(__.V(1)).to(__.addV("person").property("name","fresh"))');
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([7]);
  // marko now has a "next" edge to the freshly-created vertex
  expect(run(store, 'g.V(1).out("next").values("name")').map((r) => r.v)).toEqual(['fresh']);
  expect(run(store, 'g.V().has("name","fresh").label()').map((r) => r.v)).toEqual(['person']);
});

test('addE endpoint traversal with a repeat cluster resolves (normalize fix)', () => {
  const store = seededStore(); // modern: V(1)=marko created lop(3)
  // to(...) endpoint uses a folded repeat/times cluster — must normalize before buildPrefix
  run(store, 'g.addE("x").from(__.V(2)).to(__.V(1).repeat(__.out("created")).times(1))');
  expect(run(store, 'g.V(2).out("x").values("name")').map((r) => r.v)).toEqual(['lop']);
});

test('addV nested LABEL __.constant(...) resolves (shared value authority)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  run(store, 'g.addV(__.constant("widget")).property("name","w")');
  expect(run(store, 'g.V().has("name","w").label()').map((r) => r.v)).toEqual(['widget']);
});

test('property() with a __.constant(...) KEY resolves; a live-read key fails closed', () => {
  const store = seededStore();
  run(store, 'g.addV("person").property(__.constant("nick"), "bob")');
  expect(run(store, 'g.V().has("nick","bob").count()').map((r) => r.v)).toEqual([1]);
  // a non-constant nested key is fail-closed (never a silent drop / "[object Object]")
  expect(() => run(store, 'g.V(1).property(__.union(__.constant("k")), "v")'))
    .toThrow(/nested-traversal key not yet supported/);
  expect(() => run(store, 'g.addE("knows").from(__.V(1)).to(__.V(2)).property(__.union(__.constant("k")), "v")'))
    .toThrow(/nested-traversal key not yet supported/);
});

test('addV property value __.constant(UUID(...)) keeps the uuid vtype (not string)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  run(store, 'g.addV("person").property("gid", __.constant(UUID("0263f28b-eff9-4c17-8e33-0b41c74b6d4c")))');
  const vt = store.query("SELECT vtype FROM vertex_properties WHERE key='gid'").map((r: any) => r.vtype);
  expect(vt).toEqual(['uuid']);
});

test('mergeV creates when no match, matches when it exists (inline map)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  const a = run(store, 'g.mergeV([(T.label): "person", name: "marko"])');
  expect(bare((a[0] as any).vertex)).toMatchObject({ label: 'person', props: { name: 'marko' } });
  // second identical merge matches the first → still one vertex
  run(store, 'g.mergeV([(T.label): "person", name: "marko"])');
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([1]);
  expect(run(store, 'g.V().hasLabel("person").has("name","marko").count()').map((r) => r.v)).toEqual([1]);
});

test('mergeV map literal with a NESTED value ([k: __.trav]) resolves it', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  // a per-value traversal in the merge map — legal per grammar (mapEntry value is a
  // genericLiteral, which includes nestedTraversal). __.constant('zed') → 'zed'.
  run(store, 'g.mergeV([(T.label): "person", name: __.constant("zed")])');
  expect(run(store, 'g.V().hasLabel("person").values("name")').map((r) => r.v)).toEqual(['zed']);
  // matching against the same nested-valued map re-resolves and matches → still one
  run(store, 'g.mergeV([(T.label): "person", name: __.constant("zed")])');
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([1]);
});

test('mergeV nested map value is CORRELATED per driver (varies by incoming element)', () => {
  const store = seededStore(); // modern: 4 person vertices
  // per person, merge a "tag" vertex whose src = that person's name → correlation
  // produces one distinct tag per person.
  run(store, 'g.V().hasLabel("person").mergeV([(T.label): "tag", src: __.values("name")])');
  expect(run(store, 'g.V().hasLabel("tag").values("src")').map((r) => r.v).sort())
    .toEqual(['josh', 'marko', 'peter', 'vadas']);
});

test('mergeV literal map values keep their parsed type (uuid/long), not JS-inferred', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  run(store, "g.mergeV([(T.label):'person', gid: UUID('0263f28b-eff9-4c17-8e33-0b41c74b6d4c'), n: 5L])");
  const rows = store.query("SELECT key, vtype FROM vertex_properties ORDER BY key").map((r: any) => [r.key, r.vtype]);
  expect(rows).toEqual([['gid', 'uuid'], ['n', 'long']]);
});

test('mergeV nested map value keeps the read-shape type (uuid)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  run(store, "g.mergeV([(T.label):'person', gid: __.constant(UUID('0263f28b-eff9-4c17-8e33-0b41c74b6d4c'))])");
  expect(store.query("SELECT vtype FROM vertex_properties WHERE key='gid'").map((r: any) => r.vtype)).toEqual(['uuid']);
});

test('mergeV onCreate typed value is honored on create', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  run(store, "g.mergeV([(T.label):'person', name:'x']).option(Merge.onCreate, [gid: UUID('0263f28b-eff9-4c17-8e33-0b41c74b6d4c')])");
  expect(store.query("SELECT vtype FROM vertex_properties WHERE key='gid'").map((r: any) => r.vtype)).toEqual(['uuid']);
});

test('mergeE literal edge property value keeps its parsed type (uuid)', () => {
  const store = seededStore(); // modern: V(1)=marko, V(2)=vadas
  run(store, "g.mergeE([(T.label):'rated', (Direction.OUT): 1, (Direction.IN): 2, gid: UUID('0263f28b-eff9-4c17-8e33-0b41c74b6d4c')])");
  expect(store.query("SELECT vtype FROM edge_properties WHERE key='gid'").map((r: any) => r.vtype)).toEqual(['uuid']);
});

test('mergeV whole-arg traversal beyond select-const fails CLOSED with a specific message', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  expect(() => run(store, 'g.inject(0).mergeV(__.identity())'))
    .toThrow(/map-valued driver|not yet supported/);
});

test('mergeV([:]) matches all; on empty graph creates one default-label vertex', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  run(store, 'g.mergeV([:])');
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([1]);
  // now match-all matches the one; no new vertex
  run(store, 'g.mergeV([:])');
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([1]);
});

test('mergeV mid-chain runs per incoming traverser (g.V().mergeV([:]) → N×matches)', () => {
  const store = seededStore(); // 6 vertices
  const res = run(store, 'g.V().mergeV([:])'); // each of 6 drivers matches all 6
  expect(res.length).toBe(36);
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([6]); // no creates
});

test('mergeV option(onMatch) patches props on the matched vertex', () => {
  const store = seededStore();
  run(store, 'g.mergeV([(T.label): "person", name: "marko"]).option(Merge.onMatch, [age: 30])');
  expect(run(store, 'g.V().has("name","marko").values("age")').map((r) => r.v)).toEqual([30]);
});

test('mergeV option(onCreate) adds props only on the create branch', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  run(store, 'g.mergeV([(T.label): "person", name: "stephen"]).option(Merge.onCreate, [created: "Y"])');
  expect(run(store, 'g.V().has("name","stephen").values("created")').map((r) => r.v)).toEqual(['Y']);
});

test('mergeV/mergeE map from withSideEffect + __.select(key) constant', () => {
  // onCreate: select("c") is the (absent) match map, select("m") the create props
  const s1 = new GraphStore(new BunSqlite(':memory:'));
  run(s1, 'g.addV("person").property("name","marko").property("age",29)');
  run(s1, 'g.withSideEffect("c",[(T.label):"person","name":"stephen"]).withSideEffect("m",[(T.label):"person","name":"stephen","age":19]).mergeV(__.select("c")).option(Merge.onCreate, __.select("m"))');
  expect(run(s1, 'g.V().has("person","name","stephen").values("age")').map((r) => r.v)).toEqual([19]);
  // onMatch: select("c") matches marko, select("m") patches age
  const s2 = new GraphStore(new BunSqlite(':memory:'));
  run(s2, 'g.addV("person").property("name","marko").property("age",29)');
  run(s2, 'g.withSideEffect("c",[(T.label):"person","name":"marko"]).withSideEffect("m",["age":19]).mergeV(__.select("c")).option(Merge.onMatch, __.select("m"))');
  expect(run(s2, 'g.V().has("person","name","marko").values("age")').map((r) => r.v)).toEqual([19]);
  // mergeE match map from a side-effect constant
  const s3 = new GraphStore(new BunSqlite(':memory:'));
  run(s3, 'g.addV().property(T.id, 1).as("a").addV().property(T.id, 2).as("b")');
  run(s3, 'g.withSideEffect("a",[(T.label):"knows",(Direction.OUT):1,(Direction.IN):2]).mergeE(__.select("a"))');
  expect(run(s3, 'g.E().hasLabel("knows").count()').map((r) => r.v)).toEqual([1]);
  // a select() with no matching withSideEffect fails closed
  expect(() => run(new GraphStore(new BunSqlite(':memory:')), 'g.mergeV(__.select("nope"))'))
    .toThrow("needs a withSideEffect('nope', map)");
});

test('write-arg value/key from __.select(k) of a withSideEffect constant', () => {
  // property() value on an existing element
  const s1 = new GraphStore(new BunSqlite(':memory:'));
  run(s1, 'g.addV("software").property("name","lop")');
  run(s1, 'g.withSideEffect("a","test").V().hasLabel("software").property("temp",__.select("a"))');
  expect(run(s1, 'g.V().values("temp")').map((r) => r.v)).toEqual(['test']);
  // addV property() value
  const s2 = new GraphStore(new BunSqlite(':memory:'));
  run(s2, 'g.withSideEffect("a","marko").addV().property("name",__.select("a"))');
  expect(run(s2, 'g.V().values("name")').map((r) => r.v)).toEqual(['marko']);
  // property() KEY from a constant
  const s3 = new GraphStore(new BunSqlite(':memory:'));
  run(s3, 'g.withSideEffect("a","name").addV().property(__.select("a"),"marko")');
  expect(run(s3, 'g.V().values("name")').map((r) => r.v)).toEqual(['marko']);
});

test('mergeV accepts a bound Map parameter with EnumValue keys (wire path)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  // mimic a GraphBinary-deserialized m[{"t[label]":"person","name":"stephen"}]
  const xx1 = new Map<any, any>([[{ typeName: 'T', elementName: 'label' }, 'person'], ['name', 'stephen']]);
  const p = compile('g.mergeV(xx1).option(Merge.onCreate, null)', { xx1 });
  if (p.kind !== 'write') throw new Error('want write');
  p.run(store);
  const r = compile('g.V().hasLabel("person").has("name","stephen").count()', {});
  if (r.kind !== 'read') throw new Error('want read');
  expect(store.query(r.sql, r.binds).map((x: any) => x.v)).toEqual([1]);
});

test('mergeE creates an edge between existing endpoints, then matches it', () => {
  const store = seededStore(); // marko=1, vadas=2, already knows via edge 7
  // a NEW label between marko and josh(4)
  const c = run(store, 'g.mergeE([(T.label): "likes", (Direction.OUT): 1, (Direction.IN): 4])');
  expect((c[0] as any).edge).toMatchObject({ label: 'likes', src: 1, tgt: 4 });
  expect(run(store, 'g.V(1).out("likes").values("name")').map((r) => r.v)).toEqual(['josh']);
  // merging again matches the existing edge → no duplicate
  run(store, 'g.mergeE([(T.label): "likes", (Direction.OUT): 1, (Direction.IN): 4])');
  expect(run(store, 'g.V(1).outE("likes").count()').map((r) => r.v)).toEqual([1]);
});

test('mergeE onCreate/onMatch patch edge props on the right branch', () => {
  const store = seededStore();
  run(store, 'g.mergeE([(T.label): "likes", (Direction.OUT): 1, (Direction.IN): 4]).option(Merge.onCreate, [w: "new"]).option(Merge.onMatch, [w: "old"])');
  expect(run(store, 'g.V(1).outE("likes").values("w")').map((r) => r.v)).toEqual(['new']);
  // second merge takes the onMatch branch
  run(store, 'g.mergeE([(T.label): "likes", (Direction.OUT): 1, (Direction.IN): 4]).option(Merge.onCreate, [w: "new"]).option(Merge.onMatch, [w: "old"])');
  expect(run(store, 'g.V(1).outE("likes").values("w")').map((r) => r.v)).toEqual(['old']);
});

test('mergeE raises when an endpoint vertex does not exist', () => {
  const store = seededStore();
  expect(() => run(store, 'g.mergeE([(T.label): "knows", (Direction.OUT): 100, (Direction.IN): 101])'))
    .toThrow(/Vertex does not exist for mergeE/);
});

test('bare mergeV()/mergeE() (incoming-as-map) is a clear deferral, not silent match-all', () => {
  const store = seededStore();
  expect(() => run(store, 'g.inject(0).mergeV()')).toThrow(/no argument/);
  expect(() => run(store, 'g.inject(0).mergeE()')).toThrow(/no argument/);
});

test('inject(v1,…).mergeV runs once per injected value (arity, not always 1)', () => {
  const store = seededStore(); // 6 vertices
  // 3 injected values → 3 drivers, each match-all matches 6 → 18 results, no creates
  expect(run(store, 'g.inject(1,2,3).mergeV([:])').length).toBe(18);
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([6]);
});
});
