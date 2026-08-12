// Compiler execution semantics (split from test/compiler.test.ts) — unified lowering / filter / sack / aggregate / order / local.
// Runs compiled SQL against a seeded in-memory store, asserting RESULTS. Pure cut-
// and-paste relocation; the SQL-string snapshots live at test/L2-sql/*.sql.test.ts.
import { test, expect, describe } from 'bun:test';
import { STATIC } from '../../src/sql/kernel/render.ts';
import { compile } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery } from '../support/executor.ts';
import { rawVertex } from '../support/graph.ts';
import { read, run, seededStore } from '../support/harness.ts';

// ---------- execution semantics against a seeded store ----------

// A write-response echo now carries each prop value as a self-describing {t,v} typed node
// (so the wire frames it exactly). Tests that assert the written VALUES (not their types)
// unwrap the nodes to plain values with this recursive helper.

describe('compiler execution semantics', () => {
describe('unified lowering characterization', () => {



  test('duplicate parent traversers remain distinct through a child reduction', () => {
    const store = seededStore();
    // The two identity arms are two traversers with the same vertex id. A future
    // child-domain relation must key them by ordinal, never collapse them by id.
    expect(run(store, 'g.V(1).union(__.identity(),__.identity()).local(__.outE().count())')
      .map((r) => r.v)).toEqual([3, 3]);
  });

  test('empty child count is total per parent, including zero', () => {
    const store = seededStore();
    expect(run(store, 'g.V().local(__.outE().count())').map((r) => r.v).sort((a, b) => a - b))
      .toEqual([0, 0, 0, 1, 2, 3]);
  });








});
describe('child body with movement under path tracking (pushChildScope ordinal-order)', () => {
});
test('has(label, key, value) 3-arg folds in a label filter', () => {
  const store = seededStore();
  // the standard cucumber verification idiom
  expect(run(store, 'g.V().has("person","name","marko").has("age",29).count()').map((r) => r.v)).toEqual([1]);
  // wrong label → no match, even though a software vertex is named "lop"
  expect(run(store, 'g.V().has("person","name","lop").count()').map((r) => r.v)).toEqual([0]);
  expect(run(store, 'g.V().has("software","name","lop").count()').map((r) => r.v)).toEqual([1]);
});

test('has(T.label, v) / has(T.id, v) token forms filter on label / id', () => {
  const store = seededStore();
  expect(run(store, 'g.V().has(T.label,"person").count()').map((r) => r.v)).toEqual([4]);
  expect(run(store, 'g.V().has(T.id, 1).values("name")').map((r) => r.v)).toEqual(['marko']);
});

test('has(T.id|T.label, P) routes through a predicate (no crash on P/TextP)', () => {
  const store = seededStore();
  expect(run(store, 'g.V().has(T.id, P.within(1,2)).values("name")').map((r) => r.v).sort()).toEqual(['marko', 'vadas']);
  expect(run(store, 'g.V().has(T.label, P.eq("software")).count()').map((r) => r.v)).toEqual([2]);
});

test('sack(assign).by(key) assigns per-traverser; by-miss drops the traverser', () => {
  const store = seededStore();
  // 4 persons have age; software (lop, ripple) have none → dropped by the by() miss.
  expect(run(store, 'g.V().sack(assign).by("age").sack()').map((r) => r.v).sort((a, b) => a - b))
    .toEqual([27, 29, 32, 35]);
});

test('sack(assign).by(T.label) over edges, carried through inV()', () => {
  const store = seededStore();
  expect(run(store, 'g.withSack("hello").V().outE().sack(Operator.assign).by(T.label).inV().sack()').map((r) => r.v).sort())
    .toEqual(['created', 'created', 'created', 'created', 'knows', 'knows']);
});

test('withSack(0.0d) + sack(sum).by(weight) accumulates per edge; sum() folds', () => {
  const store = seededStore();
  // each edge contributes its weight to a fresh (0 + weight) sack; sum over all = 3.5.
  expect(run(store, 'g.withSack(0.0d).V().outE().sack(Operator.sum).by("weight").inV().sack().sum()').map((r) => r.v))
    .toEqual([3.5]);
});

test('withSack(2) + sack(div).by(__.constant(4.0)) → real division per vertex', () => {
  const store = seededStore();
  expect(run(store, 'g.withSack(2).V().sack(Operator.div).by(__.constant(4.0d)).sack()').map((r) => r.v))
    .toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
});

test('local(__.sack(sum).by(age)) folds the sack per-traverser inside a child scope (Local.feature:224)', () => {
  // V().in() → the incoming-neighbour multiset; barrier() is a no-op on the SQL engine; the
  // local() runs sack(sum).by('age') per traverser (seed 0 + own age) and sack() reads it.
  // A mutate sack(op) is an element-preserving child step, folded through the same engine.
  const store = seededStore();
  expect(run(store, 'g.withSack(0L).V().in().barrier().local(__.sack(sum).by("age")).sack()').map((r) => r.v).sort((a, b) => a - b))
    .toEqual([29, 29, 29, 32, 32, 35]);
});

test('aggregate(x).by(key).cap(x) is one list; explicit unfold emits scalar members', () => {
  const store = seededStore();
  expect(executeQuery(store, 'g.V().aggregate("x").by("name").cap("x")', {})).toHaveLength(1);
  expect(run(store, 'g.V().aggregate("x").by("name").cap("x").unfold()').map((r) => r.v).sort())
    .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  // by-miss (software has no age) drops the member → 4 ages, not 6 with nulls.
  expect(run(store, 'g.V().aggregate("x").by("age").cap("x").unfold()').map((r) => r.v).sort((a, b) => a - b))
    .toEqual([27, 29, 32, 35]);
});

test('bare aggregate(x).cap(x) is one list; explicit unfold emits vertices', () => {
  const store = seededStore();
  expect(executeQuery(store, 'g.V().aggregate("x").cap("x")', {})).toHaveLength(1);
  expect(run(store, 'g.V().aggregate("x").cap("x").unfold()').map((r) => r.id).sort((a, b) => a - b))
    .toEqual([1, 2, 3, 4, 5, 6]);
});

test('aggregate is a pass-through barrier (traversal continues past it)', () => {
  const store = seededStore();
  // aggregate mid-chain does not disturb the stream: out() still flows on.
  expect(run(store, 'g.V(1).aggregate("x").out().values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'lop', 'vadas']);
});


test('local(scalar reduction) is a per-input scalar (zeros preserved; count is Long)', () => {
  const store = seededStore();
  // out-degree per vertex, incl 0 for the software/leaf vertices.
  expect(run(store, 'g.V().local(__.outE().count())').map((r) => r.v).sort((a, b) => a - b))
    .toEqual([0, 0, 0, 1, 2, 3]);
  expect(read('g.V().local(__.outE().count())').shape).toEqual({ kind: 'value', type: STATIC('long') });
});





test('sack with two by() modulators throws TinkerPop message', () => {
  expect(() => compile('g.V().sack(assign).by("age").by("name").sack()', {}))
    .toThrow('Sack step can only have one by modulator');
});


test('order().by numeric ascending vs descending', () => {
  const store = seededStore();
  expect(run(store, 'g.V().hasLabel("person").order().by("age").values("name")').map((r) => r.v))
    .toEqual(['vadas', 'marko', 'josh', 'peter']); // 27,29,32,35
  expect(run(store, 'g.V().hasLabel("person").order().by("age",desc).values("name")').map((r) => r.v))
    .toEqual(['peter', 'josh', 'marko', 'vadas']);
});

test('order().by string is lexicographic', () => {
  const store = seededStore();
  expect(run(store, 'g.V().values("name").order()').map((r) => r.v))
    .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
});

test('range is 0-based, low-inclusive high-exclusive', () => {
  const store = seededStore();
  expect(run(store, 'g.V().order().by("name").range(1,3).values("name")').map((r) => r.v))
    .toEqual(['lop', 'marko']);
});

test('traversers are a multiset — both() preserves duplicates', () => {
  // marko(1) knows vadas+josh and created lop; both() from lop reaches its 3 creators.
  const store = seededStore();
  const names = run(store, 'g.V(3).both("created").values("name")').map((r) => r.v).sort();
  expect(names).toEqual(['josh', 'marko', 'peter']); // lop created by all three
});

test('both() on a self-loop yields the vertex twice', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  const self = store.labelId('self');
  rawVertex(store, 1, 'person');
  store.query('INSERT INTO vertex_properties(node,key,value) VALUES(?,?,?)', [1, 'name', 'ouro']);
  store.query('INSERT INTO edges(id,src,label,tgt) VALUES(?,?,?,?)', [2, 1, self, 1]);
  expect(run(store, 'g.V(1).both().count()').map((r) => r.v)).toEqual([2]);
});

test('has() on a missing property filters the traverser out', () => {
  const store = seededStore();
  // software vertices (lop, ripple) have no age -> excluded
  const names = run(store, 'g.V().has("age", 27).values("name")').map((r) => r.v);
  expect(names).toEqual(['vadas']);
  const some = run(store, 'g.V().values("lang")').map((r) => r.v).sort();
  expect(some).toEqual(['java', 'java']); // only software has lang; no nulls
});


test('where/not/filter filter the traverser (EXISTS/NULL semantics)', () => {
  const store = seededStore();
  // only marko knows anyone
  expect(run(store, 'g.V().where(__.out("knows")).values("name")').map((r) => r.v)).toEqual(['marko']);
  // creators
  expect(run(store, 'g.V().where(__.out("created")).values("name")').map((r) => r.v).sort()).toEqual(['josh', 'marko', 'peter']);
  // not(created): software has no age either — NULL is kept (not(traversal) = no output)
  expect(run(store, 'g.V().not(__.out("created")).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple', 'vadas']);
  // people known by someone
  expect(run(store, 'g.V().hasLabel("person").where(__.inE("knows").count().is(P.gte(1))).values("name")').map((r) => r.v).sort()).toEqual(['josh', 'vadas']);
  expect(run(store, 'g.V().filter(__.out("created")).values("name")').map((r) => r.v).sort()).toEqual(['josh', 'marko', 'peter']);
  // Child order and slicing are scoped to each parent before EXISTS is tested.
  expect(run(store, 'g.V().where(__.out().hasLabel("person").order().by("name").range(1,2)).values("name")').map((r) => r.v))
    .toEqual(['marko']);
  expect(run(store, 'g.V().not(__.out().hasLabel("person").order().by("name").limit(1)).values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'lop', 'peter', 'ripple', 'vadas']);
});

test('multi-hop where executes: correlated EXISTS over the path', () => {
  const store = seededStore();
  // has an out-neighbour created ripple → only josh (josh created ripple)
  expect(run(store, 'g.V().where(__.out().has("name","ripple")).values("name")').map((r) => r.v)).toEqual(['josh']);
  // has a 2-hop out path → only marko (marko→josh→ripple/lop)
  expect(run(store, 'g.V().where(__.out().out()).values("name")').map((r) => r.v)).toEqual(['marko']);
  // created something that is a software vertex → marko, josh, peter
  expect(run(store, 'g.V().where(__.out("created").hasLabel("software")).values("name")').map((r) => r.v).sort()).toEqual(['josh', 'marko', 'peter']);
  // terminal values().is on the neighbour: known-by a person over 30 → nobody (marko is 29)
  expect(run(store, 'g.V().where(__.in("knows").values("age").is(P.gt(30)))').map((r) => r.v)).toEqual([]);
  // where(__.label().is(P)) — current-label predicate
  expect(run(store, 'g.V().where(__.label().is("person")).values("name")').map((r) => r.v).sort()).toEqual(['josh', 'marko', 'peter', 'vadas']);
  // where(__.not(t)) — negated inner predicate (non-creators)
  expect(run(store, 'g.V().where(__.not(__.out("created"))).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple', 'vadas']);
});



test('sum() sums a value stream; fold() collects it', () => {
  const store = seededStore();
  expect(run(store, 'g.V().hasLabel("person").values("age").sum()').map((r) => r.v)).toEqual([123]);
  expect(JSON.parse(run(store, 'g.V().values("name").fold()')[0].list).sort())
    .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
});

});
