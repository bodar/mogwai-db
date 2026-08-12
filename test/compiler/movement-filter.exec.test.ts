// Compiler execution semantics (split from test/compiler.test.ts) — movement + edge reading.
// Runs compiled SQL against a seeded in-memory store, asserting RESULTS. Pure cut-
// and-paste relocation; the SQL-string snapshots live at test/L2-sql/*.sql.test.ts.
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { run, runWith, seededStore } from '../support/harness.ts';

// ---------- execution semantics against a seeded store ----------

// A write-response echo now carries each prop value as a self-describing {t,v} typed node
// (so the wire frames it exactly). Tests that assert the written VALUES (not their types)
// unwrap the nodes to plain values with this recursive helper.

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
  // `runWith` for BOTH, because which artifact a write compiles to is not what this test is about —
  // a `T.id` write is the legacy closure, a plain `addV` is a RelIR program, and the id semantics are
  // the same either way. Asserting the kind here made this fail the day one of them moved.
  const w = (q: string) => runWith(store, q);
  const r = (q: string) => runWith(store, q);
  w('g.addV("person").property(T.id,"person:marko").property("name","marko")');
  w('g.addV("person").property(T.id,"person:vadas").property("name","vadas")');
  w('g.V("person:marko").addE("knows").to(__.V("person:vadas"))');
  expect(r('g.V("person:marko").id()').map((x: any) => x.v)).toEqual(['person:marko']); // V(uid) seed + id() exposure
  expect(r('g.V("person:marko").out("knows").id()').map((x: any) => x.v)).toEqual(['person:vadas']); // traverse + expose
  expect(r('g.V("person:marko").values("name")').map((x: any) => x.v)).toEqual(['marko']);
  // plain addV (no T.id) keeps its integer rowid as the id — mixed graph
  w('g.addV("software").property("name","lop")');
  expect(r('g.V().has("name","lop").id()').map((x: any) => typeof x.v)).toEqual(['number']);
});
});


test('a mutating step in a VALUE-argument child traversal is rejected (StandardVerificationStrategy)', () => {
  const bad = (q: string) => expect(() => compile(q, {})).toThrow(/mutating step/);
  // TinkerPop's read-only child rule: a child evaluated for a VALUE must not mutate. The spec
  // pins the message text ("mutating step") across filter operands, V()/E() ids and property().
  bad('g.V().has("name", __.addV("x").values("name"))');
  bad('g.V().has("name", __.V().drop().constant("x"))');
  bad('g.V().has("name", __.V().map(__.addV("x")).values("name"))');   // nested a level down
  bad('g.V().has("name", P.eq(__.addV("x").values("name")))');          // wrapped in a P
  bad('g.V().has("age", P.gt(__.addV("x").values("age")))');            // …incl. the range path
  bad('g.V().values("age").is(__.addV("x").values("age"))');
  bad('g.V().V(__.addV("x").id())');
  bad('g.E(__.addV("x").id())');
  bad('g.V().property(__.addV("temp").project("k").by("name"))');

  // Scoped to VALUE arguments, NOT "every child traversal": a write is legal in a branch or
  // side-effect body, and rejecting those would break working write traversals. These must fail
  // (or not) for their own reasons — never with a mutating-step rejection.
  for (const q of ['g.V().union(__.addV("x"), __.identity())', 'g.V().local(__.addV("x"))']) {
    try { compile(q, {}); } catch (e: any) { expect(e.message).not.toMatch(/mutating step/); }
  }
  // Naming the strategy is a no-op — it is always on, exactly as in TinkerPop.
  expect(() => compile('g.withStrategies(StandardVerificationStrategy).V()', {})).not.toThrow();
  expect(() => compile('g.withoutStrategies(StandardVerificationStrategy).V()', {})).not.toThrow();
});






