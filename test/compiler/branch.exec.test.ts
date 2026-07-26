// Compiler execution semantics (split from test/compiler.test.ts) — branch (and/or/union/choose/coalesce/optional/map).
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

describe("branch execution", () => {
test('and/or/union/optional execute correctly', () => {
  const store = seededStore();
  // and: has BOTH out-knows and out-created → only marko
  expect(run(store, 'g.V().and(__.out("knows"), __.out("created")).values("name")').map((r) => r.v)).toEqual(['marko']);
  // union: marko's knows + created neighbours
  expect(run(store, 'g.V(1).union(__.out("knows"), __.out("created")).values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'lop', 'vadas']);
  expect(run(store, 'g.V(1).union(__.values("name"), __.constant("x"))').map((r) => r.v).sort())
    .toEqual(['marko', 'x']);
  expect(run(store, 'g.V(1).union(__.values("name").toUpper(), __.constant("x").toUpper())').map((r) => r.v).sort())
    .toEqual(['MARKO', 'X']);
  expect(run(store, 'g.V(1).union(__.out().count(), __.in().count())').map((r) => r.v))
    .toEqual([3, 0]);
  expect(run(store, 'g.V(1).union(__.outE("knows").values("weight").sum(), __.outE("created").values("weight").sum())').map((r) => r.v))
    .toEqual([1.5, 0.4]);
  expect(run(store, 'g.V(1).union(__.out("knows").values("name").fold(), __.out("created").values("name").fold()).unfold().order()').map((r) => r.v))
    .toEqual(['josh', 'lop', 'vadas']);
  expect(run(store, 'g.V(1).union(__.out("knows").fold(), __.out("created").fold()).unfold().values("name").order()').map((r) => r.v))
    .toEqual(['josh', 'lop', 'vadas']);
  // optional hit: josh created ripple+lop
  expect(run(store, 'g.V(4).optional(__.out("created")).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple']);
  // optional miss: vadas has no out-created → falls back to self
  expect(run(store, 'g.V(2).optional(__.out("created")).values("name")').map((r) => r.v)).toEqual(['vadas']);
  // optional over the whole graph: marko(2 knows) + 5 others as self = 7
  expect(run(store, 'g.V().optional(__.out("knows")).count()').map((r) => r.v)).toEqual([7]);
});

test('choose(pred, then, else) executes both arms, multiset preserved', () => {
  const store = seededStore();
  // person → out(created); software → in(created). Covers both arms + multiset.
  expect(run(store, 'g.V().choose(__.hasLabel("person"), __.out("created"), __.in("created")).values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'josh', 'lop', 'lop', 'lop', 'marko', 'peter', 'ripple']);
  // 2-arg: software → in(created) (creators); person → identity (self)
  expect(run(store, 'g.V().choose(__.hasLabel("software"), __.in("created")).values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'josh', 'josh', 'marko', 'marko', 'peter', 'peter', 'vadas']);
  expect(run(store, 'g.V().choose(__.hasLabel("person"), __.values("name"), __.constant("software"))').map((r) => r.v).sort())
    .toEqual(['josh', 'marko', 'peter', 'software', 'software', 'vadas']);
  expect(run(store, 'g.V().choose(__.hasLabel("person"), __.values("name").toUpper(), __.constant("software").toUpper())').map((r) => r.v).sort())
    .toEqual(['JOSH', 'MARKO', 'PETER', 'SOFTWARE', 'SOFTWARE', 'VADAS']);
  expect(run(store, 'g.V().choose(__.hasLabel("person"), __.out().count(), __.in().count()).count()').map((r) => r.v))
    .toEqual([6]);
  expect(run(store, 'g.V().choose(__.hasLabel("person"), __.values("name").fold(), __.constant("software").fold()).unfold().count()').map((r) => r.v))
    .toEqual([6]);
  expect(run(store, 'g.V().choose(__.hasLabel("person"), __.identity().fold(), __.in().fold()).unfold().count()').map((r) => r.v))
    .toEqual([8]);
  // predicate = count().is: marko has 2 knows-edges → out(knows); others → self
  expect(run(store, 'g.V(1).choose(__.out("knows").count().is(P.gt(1)), __.out("knows")).values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'vadas']);
});

test('coalesce() executes first-non-empty-per-input, multiset preserved', () => {
  const store = seededStore();
  // per vertex: knows if any, else created. marko→(vadas,josh); josh→(ripple,lop);
  // peter→(lop); vadas/lop/ripple→nothing.
  expect(run(store, 'g.V().coalesce(__.out("knows"), __.out("created")).values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'lop', 'lop', 'ripple', 'vadas']);
  // single input, first branch empty → falls to second
  expect(run(store, 'g.V(6).coalesce(__.out("knows"), __.out("created")).values("name")').map((r) => r.v)).toEqual(['lop']);
  // all branches empty → no output (not self)
  expect(run(store, 'g.V(2).coalesce(__.out("knows"), __.out("created")).values("name")').map((r) => r.v)).toEqual([]);
  expect(run(store, 'g.V().coalesce(__.values("age"), __.constant(0))').map((r) => r.v).sort((a, b) => a - b))
    .toEqual([0, 0, 27, 29, 32, 35]);
  expect(run(store, 'g.V(1).coalesce(__.values("missing"), __.values("name"), __.constant("x"))').map((r) => r.v))
    .toEqual(['marko']);
  expect(run(store, 'g.V(1).coalesce(__.values("missing"), __.values("name").toUpper())').map((r) => r.v))
    .toEqual(['MARKO']);
  // count is total, so even zero is productive and prevents fallback.
  expect(run(store, 'g.V(2).coalesce(__.out().count(), __.constant(99))').map((r) => r.v)).toEqual([0]);
  // fold() is total: an empty list is productive, so coalesce must not advance.
  expect(run(store, 'g.V(1).coalesce(__.values("missing").fold(), __.values("name").fold()).unfold().count()').map((r) => r.v))
    .toEqual([0]);
  expect(run(store, 'g.V(2).coalesce(__.out().fold(), __.identity().fold()).unfold().count()').map((r) => r.v))
    .toEqual([0]);
  // Element branch row policies are per parent through the shared child compiler.
  // Two equal parents must each retain their own first outgoing result.
  expect(run(store, 'g.V(1).union(__.identity(),__.identity()).coalesce(__.out().limit(1),__.identity()).values("name")').map((r) => r.v))
    .toEqual(['vadas', 'vadas']);
  expect(run(store, 'g.V(1).coalesce(__.out().dedup(),__.identity()).count()').map((r) => r.v))
    .toEqual([3]);
  // Nested element branches use the same non-materializing lowerer. choose() must
  // retain coalesce's parent ordinal so first-productivity remains per traverser.
  expect(run(store, 'g.V().coalesce(__.choose(__.hasLabel("person"),__.out("created"),__.in("created")),__.identity()).count()').map((r) => r.v))
    .toEqual([9]);
});

test('optional()/flatMap() multi-hop execute correctly', () => {
  const store = seededStore();
  // multi-hop optional HIT: marko out().out() = josh's creations = lop,ripple
  expect(run(store, 'g.V(1).optional(__.out().out()).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple']);
  // multi-hop optional MISS → self: peter out().out() empty → peter
  expect(run(store, 'g.V(6).optional(__.out().out()).values("name")').map((r) => r.v)).toEqual(['peter']);
  // optional(both()) hit: vadas both = marko (knows-in)
  expect(run(store, 'g.V(2).optional(__.both()).values("name")').map((r) => r.v)).toEqual(['marko']);
  expect(run(store, 'g.V(1).optional(__.out().dedup()).count()').map((r) => r.v)).toEqual([3]);
  // Rebinding an existing alias inside the child is schema-preserving and now
  // composes through optional's origin scope (a new one-sided alias still fails).
  expect(run(store, 'g.V(1).as("a").optional(__.out().as("a")).select("a").values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'lop', 'vadas']);
  // flatMap = inline the body: marko out().out() = lop,ripple
  expect(run(store, 'g.V(1).flatMap(__.out().out()).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple']);
  expect(run(store, 'g.V(1).flatMap(__.out().values("name"))').map((r) => r.v).sort()).toEqual(['josh', 'lop', 'vadas']);
  expect(run(store, 'g.V(1).flatMap(__.out().values("name").toUpper())').map((r) => r.v).sort()).toEqual(['JOSH', 'LOP', 'VADAS']);
  expect(run(store, 'g.V().flatMap(__.values("age")).count()').map((r) => r.v)).toEqual([4]);
});

test('branch fork/merge of DIVERGENT arm labels executes (union/coalesce/choose)', () => {
  const store = seededStore();
  // union: arm1 binds 'k' (knows→vadas,josh), arm2 binds 'c' (created→lop). select('k')
  // keeps only arm1 rows (arm2 padded k=NULL → dropped); select('c') only arm2.
  expect(run(store, "g.V(1).union(__.out('knows').as('k'), __.out('created').as('c')).select('k').values('name')").map((r) => r.v).sort())
    .toEqual(['josh', 'vadas']);
  expect(run(store, "g.V(1).union(__.out('knows').as('k'), __.out('created').as('c')).select('c').values('name')").map((r) => r.v).sort())
    .toEqual(['lop']);
  // the SAME label bound in both arms is NOT divergent — every row is present.
  expect(run(store, "g.V(1).union(__.out('knows').as('x'), __.out('created').as('x')).select('x').values('name')").map((r) => r.v).sort())
    .toEqual(['josh', 'lop', 'vadas']);
  // presence guard prevents overcounting: only the binding arm's rows survive select().
  expect(run(store, "g.V(1).union(__.out('knows').as('k'), __.out('created')).select('k').count()").map((r) => r.v))
    .toEqual([2]);
  // coalesce: peter has no knows → the created arm wins and binds 'c'; 'k' is unbound.
  expect(run(store, "g.V(6).coalesce(__.out('knows').as('k'), __.out('created').as('c')).select('c').values('name')").map((r) => r.v).sort())
    .toEqual(['lop']);
  expect(run(store, "g.V(6).coalesce(__.out('knows').as('k'), __.out('created').as('c')).select('k')").map((r) => r.v))
    .toEqual([]);
  // choose: marko matches → then-arm binds 'k'.
  expect(run(store, "g.V(1).choose(__.has('name','marko'), __.out('knows').as('k'), __.out('created').as('c')).select('k').values('name')").map((r) => r.v).sort())
    .toEqual(['josh', 'vadas']);
});

test('option-map choose executes: choice scalar → matched option body', () => {
  const store = seededStore();
  // age in [26,30) → "x" (marko 29, vadas 27), else "z"
  expect(run(store, 'g.V().choose(__.values("age")).option(P.between(26,30), __.constant("x")).option(Pick.none, __.constant("z"))').map((r) => r.v).sort())
    .toEqual(['x', 'x', 'z', 'z', 'z', 'z']);
  // T.label dispatch: person→P (4), software→S (2)
  expect(run(store, 'g.V().choose(T.label).option("person", __.constant("P")).option("software", __.constant("S")).option(Pick.none, __.constant("?"))').map((r) => r.v).sort())
    .toEqual(['P', 'P', 'P', 'P', 'S', 'S']);
  // out(created) degree: 0→"none" (vadas,lop,ripple), else values(name)
  expect(run(store, 'g.V().choose(__.out("created").count()).option(0, __.constant("none")).option(Pick.none, __.values("name"))').map((r) => r.v).sort())
    .toEqual(['josh', 'marko', 'none', 'none', 'none', 'peter']);
  expect(run(store, 'g.V().choose(T.label).option("person", __.constant("P")).option(Pick.none, __.constant("S")).is("P").count()').map((r) => r.v))
    .toEqual([4]);
  // Only the SELECTED option body's productivity matters; productive NULL remains
  // a value, while an unproductive matched body drops its parent.
  expect(run(store, 'g.V().choose(T.label).option("software", __.values("age")).option(Pick.none, __.constant("p"))').map((r) => r.v))
    .toEqual(['p', 'p', 'p', 'p']);
  expect(run(store, 'g.V().choose(T.label).option("person", __.constant(null)).option(Pick.none, __.constant("s"))').map((r) => r.v).sort())
    .toEqual([null, null, null, null, 's', 's']);
});

test('map(__.<scalar>) executes per-traverser', () => {
  const store = seededStore();
  // out-degree per vertex: marko3, josh2, peter1, vadas/lop/ripple 0
  expect(run(store, 'g.V().map(__.out().count())').map((r) => r.v).sort((a, b) => a - b)).toEqual([0, 0, 0, 1, 2, 3]);
  // per-vertex property projection
  expect(run(store, 'g.V(1).out("knows").map(__.values("name"))').map((r) => r.v).sort()).toEqual(['josh', 'vadas']);
  // Productivity is row existence: missing values drop their parents. Movement
  // and scalar projection share the first-productive-row child policy.
  expect(run(store, 'g.V().map(__.values("age"))').map((r) => r.v).sort((a, b) => a - b)).toEqual([27, 29, 32, 35]);
  expect(run(store, 'g.V(1).map(__.out().values("name"))').map((r) => r.v)).toEqual(['vadas']);
  // A productive null is a real traverser, not an empty child result.
  expect(run(store, 'g.V(1).map(__.constant(null))').map((r) => r.v)).toEqual([null]);
  expect(run(store, 'g.V().map(__.out().count()).is(P.gt(0)).count()').map((r) => r.v)).toEqual([3]);
});

test('element-body map keeps the first productive child per parent', () => {
  const store = seededStore();
  expect(run(store, 'g.V().map(__.out()).values("name")').map((r) => r.v).sort())
    .toEqual(['lop', 'lop', 'vadas']);
  expect(run(store, 'g.V(1).union(__.identity(),__.identity()).map(__.out()).values("name")').map((r) => r.v))
    .toEqual(['vadas', 'vadas']);
  expect(run(store, 'g.V().map(__.out().hasLabel("software")).values("name")').map((r) => r.v))
    .toEqual(['lop', 'lop', 'lop']);
  expect(run(store, 'g.V(1).map(__.outE("knows")).inV().values("name")').map((r) => r.v))
    .toEqual(['vadas']);
});

test('nested option-map choose composes through map/local/flatMap child lowering', () => {
  const store = seededStore();
  const option = "__.choose(__.values('age')).option(P.between(26,30), __.values('name')).option(Pick.none, __.constant('unknown'))";

  expect(run(store, `g.V().map(${option})`).map((r) => r.v).sort())
    .toEqual(['marko', 'unknown', 'unknown', 'unknown', 'unknown', 'vadas']);
  expect(run(store, `g.V().local(${option})`).map((r) => r.v).sort())
    .toEqual(['marko', 'unknown', 'unknown', 'unknown', 'unknown', 'vadas']);
  expect(run(store, `g.V().flatMap(${option})`).map((r) => r.v).sort())
    .toEqual(['marko', 'unknown', 'unknown', 'unknown', 'unknown', 'vadas']);
});

test('scalar-producing leaves re-enter common lowering', () => {
  const store = seededStore();
  expect(run(store, 'g.V().math("_").by("age").is(P.gt(30)).count()').map((r) => r.v)).toEqual([2]);
  expect(run(store, 'g.V().as("a").out("created").as("b").math("b + a").by(__.in("created").count()).by("age")').map((r) => r.v).sort((a, b) => a - b))
    .toEqual([32, 33, 35, 38]);
  expect(run(store, 'g.V().format("%{age}").count()').map((r) => r.v)).toEqual([4]);
  expect(run(store, 'g.V().format("%{name} has %{_}").by(__.bothE().count())').map((r) => r.v).sort())
    .toEqual(['josh has 3', 'lop has 3', 'marko has 3', 'peter has 1', 'ripple has 1', 'vadas has 1']);
  expect(run(store, 'g.withSack(7).V().sack().is(7).count()').map((r) => r.v)).toEqual([6]);
});

test('sack clones through a union() fork (TinkerPop split-only, no merge)', () => {
  const store = seededStore();
  // withSack(5) then union(out, out): each arm gets a CLONE of sack=5; the arms never
  // recombine, so every one of marko's 3×2 endpoints carries the pre-fork value 5.
  expect(run(store, 'g.withSack(5L).V(1).union(__.out(), __.out()).sack()').map((r) => r.v))
    .toEqual([5, 5, 5, 5, 5, 5]);
  // a sack assigned BEFORE the fork rides into both arms unchanged.
  expect(run(store, "g.withSack(0L).V(1).sack(assign).by('age').union(__.identity(), __.identity()).sack()").map((r) => r.v))
    .toEqual([29, 29]); // marko's age, cloned into each identity arm
});

test('sack clones through coalesce()/optional()/choose() forks', () => {
  const store = seededStore();
  // coalesce takes the first productive arm; the cloned sack rides through it.
  expect(run(store, "g.withSack(9L).V(1).coalesce(__.out('knows'), __.out()).sack()").map((r) => r.v).sort())
    .toEqual([9, 9]); // marko knows vadas+josh; sack=9 cloned into the taken arm
  // optional: hit keeps the moved traverser, miss keeps the input — both carry the clone.
  expect(run(store, 'g.withSack(3L).V(1).optional(__.out()).sack()').map((r) => r.v))
    .toEqual([3, 3, 3]); // 3 out-neighbours, each carrying sack=3
});

test('a uniform-element branch composes as a child-body value at every position', () => {
  const store = seededStore();
  // local()/flatMap() of an element branch == the flattened branch (all cardinality). The branch
  // folds through lowerElementSteps in the pushed child scope, identical to inlining it.
  expect(run(store, 'g.V().hasLabel("person").local(__.union(__.out(), __.in())).values("name")').map((r) => r.v).sort())
    .toEqual(run(store, 'g.V().hasLabel("person").union(__.out(), __.in()).values("name")').map((r) => r.v).sort());
  expect(run(store, 'g.V().flatMap(__.coalesce(__.out("knows"), __.out("created"))).values("name")').map((r) => r.v).sort())
    .toEqual(run(store, 'g.V().coalesce(__.out("knows"), __.out("created")).values("name")').map((r) => r.v).sort());
  // map() is first-cardinality; over a branch it counts one child result per input — every person
  // has a neighbour, so a per-element count of union(out,in) is marko3/vadas1/josh3/peter1.
  expect(run(store, 'g.V().hasLabel("person").map(__.union(__.out(), __.in()).count())').map((r) => r.v).sort((a, b) => a - b))
    .toEqual([1, 1, 3, 3]);
  // where(__.branch) becomes a correlated existence gate over the element-branch child rows.
  expect(run(store, 'g.V().hasLabel("person").where(__.union(__.out(), __.in())).values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'marko', 'peter', 'vadas']);
  // group().by(value) reduces the element branch per key — the top "group().by(traversal) value"
  // deferral bucket now composes for an element-armed branch.
  expect(run(store, 'g.V().hasLabel("person").group().by("name").by(__.union(__.out(), __.in()).count())').map((r) => [r.gk, r.gv]).sort())
    .toEqual([['josh', 3], ['marko', 3], ['peter', 1], ['vadas', 1]]);
  // a scalar-armed branch (constants) keeps its OWN scalar path — no regression from the widening.
  // local() is all-cardinality, so both constant arms survive (element widening never claimed it).
  expect(run(store, 'g.V(1).local(__.union(__.constant("a"), __.constant("b")))').map((r) => r.v).sort())
    .toEqual(['a', 'b']);
});

});
