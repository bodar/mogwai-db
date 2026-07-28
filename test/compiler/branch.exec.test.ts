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
  // age in [26,30) → "x" (marko 29, vadas 27), else "z". NB the age-less lop/ripple also land in
  // the ELSE here; TinkerPop would emit the ELEMENT for them (see lowerChooseOptions' KNOWN GAP).
  expect(run(store, 'g.V().choose(__.values("age")).option(P.between(26,30), __.constant("x")).option(Pick.none, __.constant("z"))').map((r) => r.v).sort())
    .toEqual(['x', 'x', 'z', 'z', 'z', 'z']);
  // Write Pick.unproductive and the distinction is honoured: the two age-less vertices take it.
  expect(run(store, 'g.V().choose(__.values("age")).option(P.between(26,30), __.constant("x")).option(Pick.none, __.constant("z")).option(Pick.unproductive, __.constant("u"))').map((r) => r.v).sort())
    .toEqual(['u', 'u', 'x', 'x', 'z', 'z']);
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

test('a label bound AFTER fold() inside a branch arm survives the merge', () => {
  const store = seededStore();
  // `out().fold().as("x")` binds the LIST the fold produced. That is bound AFTER the barrier, so
  // it is well-defined and must survive — unlike a label bound BEFORE the fold, which the barrier
  // legitimately consumes (asserted below so the two cases stay distinguishable).
  //
  // This used to be a deferral: classifyListChild required fold() to be the LAST step, so the
  // trailing as() fell off the end into the generic "scalar/projection body" throw. The arm-bound
  // label then had to survive two more places — tryCompileListChild re-homes each arm onto the
  // PARENT's carried, and finishListMerge projected the BASE's alias columns off each arm by name.
  //
  // marko(1): out has 3 neighbours (one list), in has 0. Only arm 1 binds x, so select("x") keeps
  // that one traverser and drops arm 2's — TinkerPop's drop-not-throw for an unbound label.
  expect(run(store, 'g.V(1).union(__.out().fold().as("x"), __.in().fold()).select("x")').length).toBe(1);
  // both arms bind it → both survive
  expect(run(store, 'g.V(1).union(__.out().fold().as("x"), __.in().fold().as("x")).select("x")').length).toBe(2);
  // bound BEFORE the fold: the barrier eats it, select() correctly yields nothing. Not a bug —
  // pinned so a future change to the merge cannot quietly start answering it.
  expect(run(store, 'g.V(1).union(__.as("x").out().fold(), __.as("x").in().fold()).select("x")').length).toBe(0);
  // the element-shaped twin was always fine; kept adjacent so the shapes stay comparable
  expect(run(store, 'g.V(1).union(__.out().as("x"), __.in().as("x")).select("x")').length).toBe(3);
});

test('a list-armed branch composes as an all-cardinality (local/flatMap) child body', () => {
  const store = seededStore();
  // union of two folded arms → one list per arm per input. flatMap/local emit both; sizes keep the
  // assertion order-independent. marko(1): out has 3 neighbours, in has 0.
  expect(run(store, 'g.V(1).flatMap(__.union(__.out().fold(), __.in().fold())).count(Scope.local)').map((r) => r.v))
    .toEqual([3, 0]);
  expect(run(store, 'g.V(1).local(__.union(__.out().values("name").fold(), __.in().values("name").fold())).count(Scope.local)').map((r) => r.v))
    .toEqual([3, 0]);
  // coalesce takes the FIRST productive arm — one list per input (marko knows vadas+josh → size 2).
  expect(run(store, 'g.V(1).flatMap(__.coalesce(__.out("knows").fold(), __.out("created").fold())).count(Scope.local)').map((r) => r.v))
    .toEqual([2]);
  // map() over a multi-output list branch stays fail-closed (never a silent wrong count).
  expect(() => run(store, 'g.V(1).map(__.union(__.out().fold(), __.in().fold()))'))
    .toThrow(/not supported/);
  // a MIXED-shape branch (element + scalar arms) is likewise an all-cardinality child → a variant
  // stream, equal to the flattened union. marko(1): out {vadas,josh,lop} + values('name') {marko} = 4.
  const variant = (q: string) => run(store, q).map((r) => r.vk === 1 ? `s:${r.v}` : `e:${r.id}`).sort();
  expect(variant('g.V(1).local(__.union(__.out(), __.values("name")))'))
    .toEqual(variant('g.V(1).union(__.out(), __.values("name"))'));
  expect(variant('g.V(1).flatMap(__.union(__.out(), __.values("name")))'))
    .toEqual(['e:2', 'e:3', 'e:4', 's:marko']);
});

test('as()/select(label) compose inside a child body, at any depth', () => {
  const store = seededStore();
  const names = (q: string) => run(store, q).map((r: any) => r.v).sort();

  // A label bound up the chain is VISIBLE inside a child body — pushChildScope already projects
  // the alias columns into every frame, so the read is just a re-root on the carried column.
  // map() is first-cardinality: one row per person who created something, re-rooted back to x.
  expect(names('g.V().as("x").map(__.out("created").select("x")).values("name")'))
    .toEqual(['josh', 'marko', 'peter']);
  // ...and at DEPTH: the env threads through each nested classifier, so the label is still
  // visible two child scopes down.
  expect(names('g.V().as("x").where(__.out("created").where(__.select("x"))).values("name")'))
    .toEqual(['josh', 'marko', 'peter']);

  // A label bound INSIDE the body types the selects that follow it in the same body.
  expect(names('g.V().local(__.out("created").as("a").select("a")).values("name")'))
    .toEqual(['lop', 'lop', 'lop', 'ripple']);

  // ESCAPE is decided by the consumer's boundary, and both directions are TinkerPop's:
  //   a MAPPING child pops the child stream, so the bind rides out to the parent...
  expect(names('g.V().hasLabel("person").map(__.out("created").as("a")).select("a").values("name")'))
    .toEqual(['lop', 'lop', 'lop']);
  //   ...a FILTER child re-projects the parent domain, so the bind stays confined (select() of it
  //   is then an unbound label → drop every traverser, NOT an error).
  expect(run(store, 'g.V().where(__.out("created").as("a")).select("a")')).toEqual([]);

  // An unbound label reads as empty inside a child exactly as it does at root, and — the part
  // that only matters in a child scope — the empty relation still carries the frame's ordinal,
  // so the consumer's rejoin is well-typed instead of referencing a column that isn't there.
  expect(run(store, 'g.V().map(__.out().select("nope"))')).toEqual([]);
  expect(run(store, 'g.V().where(__.out().select("nope"))')).toEqual([]);

  // The INLINE correlated predicate renderer READS labels too: its seed projects the outer row's
  // alias columns, so a label is physically present inside the correlated child exactly as
  // pushChildScope makes it present inside a materialized one. The fast-path contract is
  // enabled ≡ disabled, so assert that on the bodies the inliner now claims.
  const inlined = (query: string, on: boolean) =>
    runWith(store, query, { fastPaths: { predicateInlining: on } }).map((r: any) => r.v).sort();
  for (const query of [
    'g.V().as("x").where(__.out("created").where(__.select("x"))).values("name")',   // read, two scopes down
    'g.V().as("x").where(__.as("x").out("created")).values("name")',                 // leading re-root
    'g.V().where(__.out().as("z").select("z").has("name","lop")).values("name")',    // bind + read, mid-body
    'g.V().where(__.out().select("nope")).values("name")',                           // never-bound → drop, not error
  ]) expect(inlined(query, true)).toEqual(inlined(query, false));
  expect(inlined('g.V().as("x").where(__.out("created").where(__.select("x"))).values("name")', true))
    .toEqual(['josh', 'marko', 'peter']);
  expect(inlined('g.V().where(__.out().select("nope")).values("name")', true)).toEqual([]);
});

test("a where() body's START and END labels are scope variables, not binds", () => {
  const store = seededStore();
  // TinkerPop routes where(traversal) by variable location: a label on the FIRST step is a
  // WhereStartStep (re-root on what it holds), one on the LAST step is a WhereEndStep (the object
  // reached must BE what it holds). So `where(__.as("a").out("knows").as("b"))` asks "does a know
  // b", not "does a know somebody" — marko→lop is the witness, since marko knows vadas and josh
  // but not lop. The rewriteWhereEndLabels Pass canonicalizes both locations BEFORE lowering, so
  // this holds under either fast-path setting rather than at one of them.
  const pairs = (query: string, on: boolean) => runWith(store, query,
    { fastPaths: { predicateInlining: on } }).map((r: any) => `${r.e0_v}->${r.e1_v}`).sort();
  const q = 'g.V().as("a").out().as("b").where(__.as("a").out("knows").as("b")).select("a","b").by("name")';
  expect(pairs(q, true)).toEqual(['marko->josh', 'marko->vadas']);
  expect(pairs(q, true)).toEqual(pairs(q, false));

  // The Pass recurses through and()/or()/not() exactly as TinkerPop's configureStartAndEndSteps
  // does, so every branch gets its own start/end treatment — this is the shape L3 pins.
  const conj = 'g.V().as("a").out().as("b").where(__.and(__.as("a").out("knows").as("b"),'
    + '__.or(__.as("b").out("created").has("name","ripple"),__.as("b").in("knows").count().is(P.not(P.eq(0))))))'
    + '.select("a","b").by("name")';
  expect(pairs(conj, true)).toEqual(['marko->josh', 'marko->vadas']);
  expect(pairs(conj, true)).toEqual(pairs(conj, false));

  // …and at DEPTH: the Pass threads the labels visible where each where() SITS, so one inside a
  // child body resolves against the outer binds rather than being skipped.
  for (const host of ['map', 'local']) {
    const deep = `g.V().as("a").out().as("b").${host}(__.where(__.as("a").out("knows").as("b"))).count()`;
    expect(runWith(store, deep, { fastPaths: { predicateInlining: true } }).map((r: any) => r.v)).toEqual([2]);
    expect(runWith(store, deep, { fastPaths: { predicateInlining: false } }).map((r: any) => r.v)).toEqual([2]);
  }

  // A label in the MIDDLE has neither location and IS an ordinary bind, confined to the filter
  // body. So is an END label the enclosing chain never bound — TinkerPop errors on that one (the
  // path lookup fails); we keep the project-wide drop-not-throw reading rather than add a throw,
  // so the Pass leaves it alone and it stays the bind it reads as.
  expect(run(store, 'g.V().where(__.out("created").as("z").has("name","lop")).values("name")')
    .map((r: any) => r.v).sort()).toEqual(['josh', 'marko', 'peter']);
  expect(run(store, 'g.V().where(__.out("created").as("a")).values("name")')
    .map((r: any) => r.v).sort()).toEqual(['josh', 'marko', 'peter']);
  expect(run(store, 'g.V().where(__.out("created").as("a")).select("a")')).toEqual([]);

  // where() re-roots on its start variable, so this asks "does a have an out-knows" — true for
  // all three of marko's pairs — rather than asking about the current traverser.
  expect(run(store, 'g.V().as("a").out().as("b").where(__.as("a").out("knows")).count()')
    .map((r: any) => r.v)).toEqual([3]);

  // filter() is NOT where(): TinkerPop routes only where() by variable location, so a leading
  // as() in a filter() body is an ordinary bind and must NOT re-root. Only the inline path used
  // to re-root here, which made the same filter() answer two different things depending on a
  // fast-path flag; assert the agreement rather than the value, because the value itself is a
  // separate known gap (we drop these rows; TinkerPop keeps josh's) tracked in outstanding-work.
  for (const q of [
    'g.V().as("a").out().as("b").filter(__.as("a").out("knows")).count()',
    'g.V().as("a").out().as("b").filter(__.as("a").out("knows").as("b")).count()',
  ]) {
    expect(runWith(store, q, { fastPaths: { predicateInlining: true } }))
      .toEqual(runWith(store, q, { fastPaths: { predicateInlining: false } }));
  }
});

test('a child body whose local() is not element-shaped defers cleanly (classify/emit lockstep)', () => {
  const store = seededStore();
  // `local` is in the element-row SUFFIX vocabulary, but the emitter recurses into an ELEMENT
  // child for it. A scalar local() body must therefore be rejected at classify time — when it
  // was not, the emitter returned null into the caller's non-null assertion and the compile
  // died with a null-deref instead of a deferral.
  expect(() => run(store, 'g.V().group().by("name").by(__.out().local(__.values("name")).fold())'))
    .toThrow(/not yet supported/);
});

// ---------- union() in SOURCE position: one branch implementation, not two ----------
//
// A source branch is a fully ROOTED traversal, so it lowers through the ordinary rooted lowering
// and the merge is chosen from the arms' KINDS (never the child seam's syntactic arm triage, which
// describes a body hanging off a parent traverser). These pin that the four axes the old
// hand-rolled UNION-ALL seed rejected — arm SHAPE, as(), emission ORDER and sack — now behave
// exactly as they do mid-traversal.
test('a union() SOURCE reaches every arm shape the mid-traversal union does', () => {
  const store = seededStore();
  const vs = (rows: any[]) => rows.map((r) => r.v).sort();
  // ELEMENT arms (the shape the old seed handled) — unchanged.
  expect(vs(run(store, 'g.union(__.V().hasLabel("software"), __.V().hasLabel("person")).values("name")')))
    .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  // SCALAR arms → the scalar merge. One arm is legal too (nothing to disagree about).
  expect(vs(run(store, 'g.union(__.V().values("name"))')))
    .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  expect(vs(run(store, 'g.union(__.V(1).values("name"), __.V(2).values("name"))'))).toEqual(['marko', 'vadas']);
  // A branch rooted at something other than V()/E(): inject() seeds on the SHARED Query, so its
  // relation lands in the same WITH as its siblings'.
  expect(vs(run(store, 'g.union(__.inject(1), __.inject(2))'))).toEqual([1, 2]);
  // LIST arms (…fold()) → the list merge.
  expect(run(store, 'g.union(__.V(1).values("name").fold(), __.V(2).values("name").fold())').map((r: any) => JSON.parse(r.list)))
    .toEqual([['marko'], ['vadas']]);
  // MIXED arms → the variant merge (vk 1 = scalar, 2 = node).
  expect(run(store, 'g.union(__.V(1).values("name"), __.V(2))').map((r: any) => r.vk).sort()).toEqual([1, 2]);
  // No branches at all is a legal traversal that emits nothing — not an arity error.
  expect(run(store, 'g.union()')).toEqual([]);
  // An arm shape no merge in the family covers fails closed, naming that shape.
  expect(() => run(store, 'g.union(__.V().group().by("name"), __.V())')).toThrow('producing a group value');
});

test('a union() SOURCE carries as(), the path, emission order and the sack through its merge', () => {
  const store = seededStore();
  // as() INSIDE a branch: the merge unions the arms' label sets and NULL-pads the arm that never
  // bound it, so select() resolves (the old seed threw on any arm-bound label).
  expect(run(store, 'g.union(__.V(1).as("a").out(), __.V(2)).select("a").values("name")').map((r: any) => r.v))
    .toEqual(['marko', 'marko', 'marko']); // v2's arm never bound "a" → that traverser drops
  // PATH: each rooted arm seeds its own p0; ragged arms pad, so a short arm's path is shorter.
  const paths = run(store, 'g.union(__.V(1).out().out(), __.V().hasLabel("software")).path().by("name")');
  expect(paths.map((r: any) => [r.x0_v, r.x1_at && r.x1_v, r.x2_at && r.x2_v].filter((x) => x != null)))
    .toEqual([['marko', 'josh', 'lop'], ['marko', 'josh', 'ripple'], ['lop'], ['ripple']]);
  // EMISSION ORDER: a positional consumer downstream of the fan-out mints the arm-merge
  // encounter — arm 0 fully before arm 1, so limit() takes arm 0's first rows.
  expect(run(store, 'g.union(__.V(2), __.V(4)).limit(1).values("name")').map((r: any) => r.v)).toEqual(['vadas']);
  expect(run(store, 'g.union(__.V(4), __.V(2)).limit(1).values("name")').map((r: any) => r.v)).toEqual(['josh']);
  // SACK: withSack() seeds every arm's traversers, and the merge projects the carried column.
  expect(run(store, 'g.withSack(1).union(__.V(1), __.V(2)).sack()').map((r: any) => r.v)).toEqual([1, 1]);
});

// ---------- option-map choose(): an arm merge, and its two implicit arms ----------
//
// The arms that have no body are the ones worth pinning as RESULTS: an input no written option
// claims emits the ELEMENT itself, and Pick.unproductive/Pick.none split on whether the CHOICE
// produced anything at all. Both are TinkerPop's, both are invisible in the SQL.
test('option-map choose() routes every arm shape, incl. the implicit pass-through', () => {
  const store = seededStore();
  const vals = (rows: any[]) => rows.map((r: any) => r.vk === 2 || r.vk === 3 ? '(element)' : r.v ?? JSON.parse(r.list)).sort();
  // No Pick.none: unmatched inputs pass through as the element (Choose.feature pins
  // d[29].i, v[vadas], v[lop], josh, v[ripple], v[peter] for exactly this).
  expect(vals(run(store, 'g.V().choose(__.out().count()).option(2, __.values("name")).option(3, __.values("age"))')))
    .toEqual(['(element)', '(element)', '(element)', '(element)', 29, 'josh']);
  // Pick.unproductive is the choice producing NOTHING — the age-less software vertices — which is
  // a different question from Pick.none (a value that matched no key: josh 32, peter 35).
  expect(vals(run(store, 'g.V().choose(__.values("age")).option(P.between(26,30), __.values("name")).option(Pick.none, __.values("name")).option(Pick.unproductive, __.label())')))
    .toEqual(['josh', 'marko', 'peter', 'software', 'software', 'vadas']);
  // Pick.unproductive claims the age-less vertices; without it they fall to the CASE's ELSE
  // (the known gap — TinkerPop emits the element there).
  expect(vals(run(store, 'g.V().choose(__.values("age")).option(P.between(26,30), __.values("name")).option(Pick.none, __.label()).option(Pick.unproductive, __.constant("none"))')))
    .toEqual(['marko', 'none', 'none', 'person', 'person', 'vadas']);
  // ELEMENT option bodies are arms, not CASE branches: the person arm walks out('knows') (only
  // marko has any), and the software vertices fall to the identity arm.
  expect(vals(run(store, 'g.V().choose(T.label).option("person", __.out("knows")).option(Pick.none, __.identity()).values("name")')))
    .toEqual(['josh', 'lop', 'ripple', 'vadas']);
  // A key that matches nothing sends every input to the identity arm (Choose.feature pins this).
  expect(vals(run(store, 'g.V().choose(T.label).option("blah", __.out("knows")).option("bleep", __.out("created")).option(Pick.none, __.identity()).values("name")')))
    .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  // LIST bodies inside a local() child: the child classifier now admits the option-map form, and
  // the body reaches the same list/variant merges through the ordinary generic lowering.
  expect(run(store, 'g.V().hasLabel("person").local(__.choose(__.values("age")).option(P.between(26,30), __.values("name").fold()).option(Pick.none, __.values("name").fold()))')
    .map((r: any) => JSON.parse(r.list))).toEqual([['marko'], ['vadas'], ['josh'], ['peter']]);
});

});

test('choose().option() RESULTS across the arm shapes (the merge and the CASE agree)', () => {
  const store = seededStore();
  const names = (q: string) => (run(store, q) as any[]).map((r) => r.v).sort();

  // Which lowering runs is a property of the ARMS — a moving arm fans out and takes the gated
  // arm merge, all-scalar arms stay on the CASE. The L2 snapshots pin the SQL each produces;
  // these pin that the two agree on the ANSWER, which a snapshot cannot.
  // marko knows josh+vadas; the other people know nobody; software falls to Pick.none identity.
  for (const choice of ['__.label()', 'T.label']) {
    expect(names(`g.V().choose(${choice}).option("person",__.out("knows")).option(Pick.none,__.identity()).values("name")`))
      .toEqual(['josh', 'lop', 'ripple', 'vadas']);
  }
  // discard() is the empty arm at BOTH lowerings: the merge builds no arm for it, the CASE marks
  // it never-productive. `present` is a 1-or-NULL marker tested with `is not null`, so encoding
  // that as 0 reads as productive and leaks one null row per discarded traverser.
  expect(names('g.V().choose(__.label()).option("person",__.out("knows")).option(Pick.none,__.discard()).values("name")'))
    .toEqual(['josh', 'vadas']);
  // …but discarding the Pick.none arm does NOT discard the UNPRODUCTIVE inputs. lop/ripple have no
  // age, so no written option claims them and TinkerPop emits the element (`null` here — the v
  // column of a variant element row). Choose.feature's
  // g_V_chooseXageX_optionXbetweenX26_30X_nameX_optionXnone_discardX pins exactly
  // `marko | vadas | v[lop] | v[ripple]`. Write option(Pick.unproductive, __.discard()) to drop
  // them too — asserted below.
  expect(names('g.V().choose(__.values("age")).option(between(26,30),__.values("name")).option(Pick.none,__.discard())'))
    .toEqual(['marko', 'vadas', null, null].sort());
  expect(names('g.V().choose(__.values("age")).option(between(26,30),__.values("name")).option(Pick.none,__.discard()).option(Pick.unproductive,__.discard())'))
    .toEqual(['marko', 'vadas']);
  // marko has 3 out-edges → option(3) → age 29; josh has 2 → option(2) → name; the rest discard.
  expect(names('g.V().choose(__.out().count()).option(2,__.values("name")).option(3,__.values("age")).option(Pick.none,__.discard())'))
    .toEqual([29, 'josh']);
  // All-scalar arms keep the CASE.
  expect(names('g.V().hasLabel("person").choose(__.values("age")).option(between(26,30),__.constant("young")).option(Pick.none,__.constant("old"))'))
    .toEqual(['old', 'old', 'young', 'young']);

  // No Pick.none: TinkerPop passes an unmatched traverser through as the ELEMENT itself, so the
  // result is genuinely mixed scalar/element — the variant merge. The two matched vertices come
  // back as values, the four unmatched as vertices.
  const mixed = run(store, 'g.V().choose(__.out().count()).option(2,__.values("name")).option(3,__.values("age"))') as any[];
  expect(mixed.filter((r) => r.v !== null).map((r) => r.v).sort()).toEqual([29, 'josh']);
  expect(mixed.filter((r) => r.id !== null).map((r) => r.label)).toEqual(['person', 'person', 'software', 'software']);
});
