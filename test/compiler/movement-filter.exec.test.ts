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

  // An operand shape with no scalar to read — a FILTER body rather than a value producer — still
  // defers, and says so. Before, any unresolved operand object reached SQLite as a bind and
  // surfaced as an opaque driver error. (Re-sourced and correlated operands both resolve now; see
  // the two tests below.)
  expect(() => run(store, 'g.V().has("name",__.not(__.identity()))'))
    .toThrow(/traversal as a predicate operand is not yet supported/);
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

test('a re-sourced traversal operand becomes a scalar subquery (compared against its FIRST result)', () => {
  const store = seededStore();
  const ids = (q: string) => run(store, q).map((r: any) => r.id).sort();
  const vals = (q: string) => run(store, q).map((r: any) => r.v).sort();

  // A V()/E()-headed operand never reads the current traverser, so it is a standalone read —
  // compiled as its own sub-read and embedded as a scalar subquery, the same way within()/all()
  // already embed a folded list operand. No correlation, so it works over any parent shape.
  expect(ids('g.V().has("name", __.V(1).values("name"))')).toEqual([1]);
  expect(ids('g.V().has("age", P.gt(__.V(1).values("age")))')).toEqual([4, 6]);
  expect(vals('g.V().values("age").is(__.V(1).values("age"))')).toEqual([29]);
  expect(vals('g.V().values("age").is(P.gt(__.V(1).values("age")))')).toEqual([32, 35]);
  // A multi-result operand compares against its FIRST result — TinkerPop's rule, which is why
  // the spec scenario orders the operand to make "first" deterministic.
  expect(ids('g.V().has("name", __.V(1).out("knows").values("name").order())')).toEqual([4]);
  // A mutating operand is still rejected before any of this (read-only child verification).
  expect(() => run(store, 'g.V().has("name", __.V().drop().constant("x"))')).toThrow(/mutating step/);
});

test('a traverser-dependent operand becomes a CORRELATED scalar subquery', () => {
  const store = seededStore();
  const ids = (q: string) => run(store, q).map((r: any) => r.id).sort();

  // The operand reads the CURRENT traverser, so it correlates rather than standing alone. The
  // grammar is the child seam's usual split — <element movement/filter prefix>.<scalar projection>
  // — and the prefix goes through compileCorrelatedChild, the same inline renderer where()/filter()
  // use, so movement inside an operand is not a second implementation.
  expect(ids('g.V().has("name", __.values("name"))')).toEqual([1, 2, 3, 4, 5, 6]); // name == own name
  expect(ids('g.V().has("age", __.values("age"))')).toEqual([1, 2, 4, 6]);         // …only those with one
  // an empty prefix is the degenerate case (the element IS the traverser); a movement prefix
  // reaches the neighbour and takes its FIRST value
  expect(ids('g.V().has("name", __.out().values("name"))')).toEqual([]);           // nobody is named as a neighbour
  expect(ids('g.V().has("name", __.in().values("name"))')).toEqual([]);

  // An UNPRODUCTIVE operand yields SQL NULL, which is already TinkerPop's answer at both hosts:
  expect(ids('g.V().has("name", __.values("nonexistent"))')).toEqual([]);          // eq(NULL) → drop
  expect(ids('g.V().has("age", P.eq(__.values("nonexistent")))')).toEqual([]);
  // …and a NULL member of a within() set contributes nothing, while a sibling constant matches.
  expect(ids('g.V().has("name", P.within(__.values("nonexistent"), __.constant("marko")))')).toEqual([1]);
  expect(ids('g.V().has("name", P.within(__.values("nonexistent"), __.values("nonexistent2")))')).toEqual([]);
});

test('operands that are neither re-sourced nor correlated: a sack() read, and hasId', () => {
  const store = seededStore();
  const vals = (q: string) => run(store, q).map((r: any) => r.v).sort();
  const ids = (q: string) => run(store, q).map((r: any) => r.id).sort();

  // __.sack() as an operand is neither a subquery nor a correlation — the value is already a
  // CARRIED column on the traverser, which is the whole point of the sack. It just needs the
  // host's row relation.
  expect(vals('g.withSack(30).V().values("age").is(P.gt(__.sack()))')).toEqual([32, 35]);
  expect(vals('g.withSack(29).V().values("age").is(P.lte(__.sack()))')).toEqual([27, 29]);
  expect(vals('g.withSack(29).V().has("age", P.gt(__.sack())).values("name")')).toEqual(['josh', 'peter']);

  // hasId wraps a bare arg into a within(), so resolving operands on the RESULT of
  // idPredFromArgs covers hasId(trav) and hasId(P.eq(trav)) in one place.
  expect(ids('g.V().hasId(__.V(1).id())')).toEqual([1]);
  expect(ids('g.V().hasId(P.eq(__.V(1).id()))')).toEqual([1]);
});

test('a fast path DECLINES an operand it cannot resolve, it does not throw', () => {
  const store = seededStore();
  // tryInlineScalarPredicate is a fast path with a generic fallback, and its contract is "return
  // null so the caller falls through". Resolving an operand needs the Engine, which a pure
  // inliner has none of — so it must decline rather than let the render throw, which would define
  // support by vocabulary exhaustion. With the decline in place this reaches the generic path.
  expect(run(store, 'g.inject("marko").choose(__.is(P.eq(__.V(9999).values("name"))), __.constant("matched"), __.constant("unmatched"))')
    .map((r: any) => r.v)).toEqual(['unmatched']);
});
