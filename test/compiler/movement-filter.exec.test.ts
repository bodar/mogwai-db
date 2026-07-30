// Compiler execution semantics (split from test/compiler.test.ts) — movement + edge reading.
// Runs compiled SQL against a seeded in-memory store, asserting RESULTS. Pure cut-
// and-paste relocation; the SQL-string snapshots live at test/L2-sql/*.sql.test.ts.
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { run, seededStore } from '../support/harness.ts';

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

test('V()/E() mid-traversal re-sources the graph, carrying the schema forward', () => {
  const store = seededStore();
  const names = (q: string) => (run(store, q) as any[]).map((r) => r.v).sort();
  const count = (q: string) => (run(store, q) as any[]).map((r) => r.v);

  // TinkerPop's GraphStep(isStart=false): discard the current object and re-source the graph
  // PER TRAVERSER — a flatMap, so the row count multiplies. It reuses the very CROSS JOIN the
  // scalar tail already had for `inject(1).V()`; a re-source reads only the carried schema and
  // never the parent's payload, which is exactly why one implementation serves both parents.
  expect(count('g.V(1).V().count()')).toEqual([6]);              // 1 traverser × 6 vertices
  expect(count('g.V(1).E().count()')).toEqual([6]);              // …and the edge table
  expect(count('g.V().hasLabel("person").V().hasLabel("software").count()')).toEqual([8]); // 4 × 2
  expect(count('g.V(1).as("a").out().V().count()')).toEqual([18]);                          // 3 × 6
  expect(names('g.V(1).V(2).values("name")')).toEqual(['vadas']); // id-scoped re-source

  // Carrying the schema across the re-source is the POINT of the step: the label bound before
  // it is what the re-sourced vertices are compared against. josh(32) and peter(35) are the two
  // older than marko(29).
  expect(names('g.V(1).as("a").V().has("age",gt(__.select("a").values("age"))).values("name")'))
    .toEqual(['josh', 'peter']);
  expect(names('g.V(1).as("a").V(2).select("a").values("name")')).toEqual(['marko']);

  // path()/sack()/otherV() fork through a re-source in ways that are not worked out, so those
  // fail closed rather than silently dropping the carried state.
  expect(() => run(store, 'g.V(1).path().V().count()')).toThrow(/not yet supported/);
});

test('within()/without() over a folded re-sourced traversal is LIST membership', () => {
  const store = seededStore();
  const vals = (q: string) => (run(store, q) as any[]).map((r) => r.v).sort();
  // `within(__.V(1).out('knows').values('age').fold())` asks whether the value is among the
  // members that read produces — a list operand, not the vararg set `within(a, b)` compiles to an
  // IN-list for. The members are only known at run time, so it renders as a json_each scan over
  // the folded sub-read. marko knows vadas(27) and josh(32).
  expect(vals("g.V().values('age').is(within(__.V(1).out('knows').values('age').fold()))")).toEqual([27, 32]);
  expect(vals("g.V().values('age').is(without(__.V(1).out('knows').values('age').fold()))")).toEqual([29, 35]);

  // The has() host is the one that catches the scoping trap: json_each exposes a column named
  // `value`, and hasProp passes the UNQUALIFIED `value` column of vertex_properties. Rendered as
  // `EXISTS (… WHERE je.value = value)` both sides bind to json_each and EVERY row matches —
  // within returned all six vertices and without returned none. Keeping the operand on the left
  // of `IN (SELECT …)` evaluates it in the outer scope, where it means what the caller intended.
  expect(vals("g.V().has('name',within(__.V(1).out('knows').values('name').fold())).values('name')"))
    .toEqual(['josh', 'vadas']);
  expect(vals("g.V().has('name',without(__.V(1).out('knows').values('name').fold())).values('name')"))
    .toEqual(['lop', 'marko', 'peter', 'ripple']);

  // An empty operand list matches nothing, rather than degenerating to a true predicate.
  expect(vals("g.V().values('age').is(within(__.V(9999).values('age').fold()))")).toEqual([]);
});
