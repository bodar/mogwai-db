// Compiler execution semantics (split from test/compiler.test.ts) — movement + edge reading.
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
import { assertStreamColumns } from '../../src/compiler/steps/context/stream.ts';
import { pushChildScope } from '../../src/compiler/steps/tail/child.ts';

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

describe("movement/filter execution", () => {
test('order().by(key) then id() (n.props alias must be in scope)', () => {
  const store = seededStore();
  // regression: id projection needs the nodes n join so ORDER BY key resolves
  expect(run(store, 'g.V().hasLabel("person").order().by("age").id()').map((r) => r.v))
    .toEqual([2, 1, 4, 6]); // vadas,marko,josh,peter by age 27,29,32,35
});

test('multi-term order().by() mixing property keys and traversals (shared modulation seam)', () => {
  const store = seededStore();
  // by(__.out().count()).by('name'): out-degrees vadas0,peter1,josh2,marko3 (all distinct)
  expect(run(store, 'g.V().hasLabel("person").order().by(__.out().count()).by("name").values("name")').map((r) => r.v))
    .toEqual(['vadas', 'peter', 'josh', 'marko']);
  // by('age').by(__.out().count()): ages all distinct → age drives it entirely
  expect(run(store, 'g.V().hasLabel("person").order().by("age").by(__.out().count()).values("name")').map((r) => r.v))
    .toEqual(['vadas', 'marko', 'josh', 'peter']);
  // by(__.in().count()).by(__.out().count()): in {marko0,peter0,vadas1,josh1}; tie-break out
  // asc → peter(out1)<marko(out3); vadas(out0)<josh(out2)
  expect(run(store, 'g.V().hasLabel("person").order().by(__.in().count()).by(__.out().count()).values("name")').map((r) => r.v))
    .toEqual(['peter', 'marko', 'vadas', 'josh']);
});

test('order().by(key) survives a following movement/branch (item 5b: ordered element re-entry)', () => {
  const store = seededStore();
  // order() is a barrier: it re-establishes a total order that must survive the following out().
  // Ages asc: vadas27,marko29,josh32,peter35 (software lop/ripple have no age → sort first). out()
  // then fans each source in that order — the result is grouped by the source's age rank. marko→
  // {lop,vadas,josh} (by neighbour id), josh→{ripple,lop}, peter→{lop}; the age-less/childless
  // sources contribute nothing. Threading the minted encounter through out() yields exactly this.
  expect(run(store, 'g.V().order().by("age").out().values("name")').map((r) => r.v))
    .toEqual(['vadas', 'lop', 'josh', 'lop', 'ripple', 'lop']);
  // Order.desc flips the source order: peter→lop, josh→{lop,ripple}, marko→{vadas,lop,josh}.
  expect(run(store, 'g.V().order().by("age", Order.desc).out().values("name")').map((r) => r.v))
    .toEqual(['lop', 'lop', 'ripple', 'vadas', 'lop', 'josh']);
  // A limit after the movement observes the ordered stream (the encounter threads through out()).
  expect(run(store, 'g.V().order().by("age").out().limit(2).values("name")').map((r) => r.v))
    .toEqual(['vadas', 'lop']);
  // A branch (coalesce) after order() re-enters too — the exact TinkerPop Coalesce scenario
  // g_V_outXcreatedX_order_byXnameX_coalesceXname_constantXxXX (asserted unordered upstream).
  expect(run(store, 'g.V().out("created").order().by("name").coalesce(__.values("name"), __.constant("x"))').map((r) => r.v).sort())
    .toEqual(['lop', 'lop', 'lop', 'ripple']);
});

test('outE().inV() equals out(); outV/inV recover edge endpoints', () => {
  const store = seededStore();
  // marko(1) outE knows → 2 edges → inV → vadas+josh (== out('knows'))
  expect(run(store, 'g.V(1).outE("knows").inV().values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'vadas']);
  // edge endpoints: edge 9 (marko-created->lop) outV=marko, inV=lop
  expect(run(store, 'g.E(9).outV().values("name")').map((r) => r.v)).toEqual(['marko']);
  expect(run(store, 'g.E(9).inV().values("name")').map((r) => r.v)).toEqual(['lop']);
});

test('E()/hasLabel/count and edge values() over the edges table', () => {
  const store = seededStore();
  expect(run(store, 'g.E().count()').map((r) => r.v)).toEqual([6]);
  expect(run(store, 'g.E().hasLabel("knows").count()').map((r) => r.v)).toEqual([2]);
  expect(run(store, 'g.V(1).outE("knows").values("weight")').map((r) => r.v).sort())
    .toEqual([0.5, 1.0]);
  // bothE from lop(3): the 3 created-edges into it
  expect(run(store, 'g.V(3).bothE().count()').map((r) => r.v)).toEqual([3]);
});
test('user-supplied string ids: create, seed, traverse, expose (COALESCE uid,id)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  const w = (q: string) => { const p = compile(q, {}); if (p.kind !== 'write') throw new Error('want write'); return p.run(store); };
  const r = (q: string) => { const p = compile(q, {}); if (p.kind === 'write') return p.run(store); return store.query(p.sql, p.binds); };
  w('g.addV("person").property(T.id,"person:marko").property("name","marko")');
  w('g.addV("person").property(T.id,"person:vadas").property("name","vadas")');
  w('g.V("person:marko").addE("knows").to(__.V("person:vadas"))');
  expect(r('g.V("person:marko").id()').map((x: any) => x.v)).toEqual(['person:marko']); // V(uid) seed + id() exposure
  expect(r('g.V("person:marko").out("knows").id()').map((x: any) => x.v)).toEqual(['person:vadas']); // traverse + expose
  expect(r('g.V("person:marko").values("name")').map((x: any) => x.v)).toEqual(['marko']);
  // plain addV (no T.id) keeps its integer rowid as the id — mixed graph
  const lop = w('g.addV("software").property("name","lop")');
  expect(typeof (lop[0] as any).vertex.id).toBe('number');
  expect(r('g.V().has("name","lop").id()').map((x: any) => typeof x.v)).toEqual(['number']);
});
});

test('a constant() predicate operand folds to its literal, at every predicate host', () => {
  const store = seededStore();
  const vals = (q: string) => run(store, q).map((r: any) => r.v).sort();
  const names = (q: string) => run(store, q).map((r: any) => r.id).sort();

  // TinkerPop lets a predicate's OPERAND be a traversal, compared against its first result. A
  // bare constant() reads nothing from the traverser, so it IS its value — folded in the IR
  // (foldConstantPredicateOperands) rather than handled per host, which is why one Pass covers
  // is()/has()/where()/hasLabel() and the P-wrapped forms alike.
  expect(vals('g.V().values("age").is(__.constant(29))')).toEqual([29]);
  expect(vals('g.V().values("name").is(__.constant("marko"))')).toEqual(['marko']);
  expect(vals('g.V().values("age").is(P.gt(__.constant(29)))')).toEqual([32, 35]);
  expect(vals('g.V().values("age").where(P.gt(__.constant(29)))')).toEqual([32, 35]);
  expect(names('g.V().has("name",__.constant("marko"))')).toEqual([1]);
  expect(names('g.V().has("age",P.lte(__.constant(27)))')).toEqual([2]);
  expect(names('g.V().hasLabel(__.constant("software"))')).toEqual([3, 5]);
  // …including operands nested inside a multi-value P
  expect(vals('g.V().values("age").is(P.without(__.constant(29), __.constant(32)))')).toEqual([27, 35]);

  // A nested traversal in where()/filter() is a PREDICATE BODY, not an operand — folding one
  // would turn a filter into a comparison, so those hosts are deliberately excluded.
  expect(names('g.V().where(__.out("created"))')).toEqual([1, 4, 6]);

  // A genuinely per-traverser operand still defers, and says so: it needs a correlated value.
  // Before, the operand object reached SQLite as a bind and surfaced as an opaque driver error.
  expect(() => run(store, 'g.V().has("name",__.V(1).out("knows").values("name"))'))
    .toThrow(/traversal as a predicate operand is not yet supported/);
});
