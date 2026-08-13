// Compiler execution semantics (split from test/compiler.test.ts) — group / groupCount / properties / valueMap.
// Runs compiled SQL against a seeded in-memory store, asserting RESULTS. Pure cut-
// and-paste relocation; the SQL-string snapshots live at test/L2-sql/*.sql.test.ts.
import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../../src/storage.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';
import { grouped, run, seededStore } from '../support/harness.ts';

// ---------- execution semantics against a seeded store ----------

// A write-response echo now carries each prop value as a self-describing {t,v} typed node
// (so the wire frames it exactly). Tests that assert the written VALUES (not their types)
// unwrap the nodes to plain values with this recursive helper.

describe("group/properties execution", () => {
test('properties() streams a VertexProperty per (key,value); key/value/element project', () => {
  const store = seededStore();
  // marko(1) has name+age → two properties
  expect(run(store, 'g.V(1).properties().count()').map((r) => r.v)).toEqual([2]);
  expect(run(store, 'g.V(1).properties().key()').map((r) => r.v).sort()).toEqual(['age', 'name']);
  expect(run(store, 'g.V(1).properties("name").value()').map((r) => r.v)).toEqual(['marko']);
  // element() returns the owner; both properties resolve back to marko
  expect(run(store, 'g.V(1).properties().element().id()').map((r) => r.v)).toEqual([1, 1]);
  expect(run(store, 'g.V(1).properties("age").element().values("name")').map((r) => r.v)).toEqual(['marko']);
  // edge properties too (edge 7 = marko-knows->vadas, weight 0.5)
  expect(run(store, 'g.E(7).properties().value()').map((r) => r.v)).toEqual([0.5]);
});








test('group().by(name).by(tail) yields one vertex per name (gate #1 rows)', () => {
  const store = seededStore();
  // ONE VERTEX PER NAME is what this test means. Counting ROWS asserted a lowering detail instead —
  // the grouping emits one `map` blob rather than one row per key — so it reads the grouping through
  // the harness and the id out of the element NODE the blob carries.
  const byName = Object.fromEntries(Object.entries(grouped(run(store, 'g.V().group().by("name").by(__.tail())')))
    .map(([k, v]) => [k, (v as { id: number }).id]));
  expect(Object.keys(byName)).toHaveLength(6);
  expect(byName).toEqual({ marko: 1, vadas: 2, lop: 3, josh: 4, ripple: 5, peter: 6 });
});




test('group reducers operate over the complete child row domain for each key', () => {
  const store = seededStore();
  // Through the HARNESS, because reading a group row's raw `gk`/`gv` columns would assert a lowering
  // detail (the grouping emits one `map` blob) rather than the grouping itself. Same move the five
  // other gk/gv readers already made.
  const groupedRows = (query: string) => grouped(run(store, query));

  // count is total: parents with no productive child rows retain their key as zero.
  expect(groupedRows('g.V().group().by(T.label).by(__.count())'))
    .toEqual({ person: 4, software: 2 });
  expect(groupedRows('g.V().group().by(T.label).by(__.out().count())'))
    .toEqual({ person: 6, software: 0 });

  // Numeric reducers are productive-only. They combine all child rows sharing the
  // final key; an empty software domain contributes no map entry.
  expect(groupedRows('g.V().group().by(T.label).by(__.values("age").sum())'))
    .toEqual({ person: 123 });
  expect(groupedRows('g.V().group().by(T.label).by(__.outE().values("weight").sum())'))
    .toEqual({ person: 3.5 });

  // Equal element ids are still distinct traversers. Both marko parents contribute
  // their full outgoing-weight domain (1.9 each) to the shared person reduction.
  expect(groupedRows('g.V(1).union(__.identity(),__.identity()).group().by(T.label).by(__.outE().values("weight").sum())'))
    .toEqual({ person: 3.8 });
});



test('a RECORD-keyed group frames as the Map of Maps upstream reads (gate #2)', async () => {
  // Upstream's own `getEdges` graph snapshot
  // (`vendor/tinkerpop/gremlin-js/gremlin-javascript/test/cucumber/world.js:157-174`), asserted THROUGH
  // THE WIRE rather than over columns — the columns were asserting a lowering detail while the wire
  // asserts the answer.
  const store = seededStore();
  const [framed] = await decodeAll(executeQuery(store,
    'g.E().group().by(__.project("o","l","i").by(__.outV().values("name")).by(__.label()).by(__.inV().values("name"))).by(__.tail())', {}));
  expect(framed).toBeInstanceOf(Map);
  // 6 distinct (out-name, label, in-name) triples in the modern graph, each keyed by a Map — which is
  // what `getEdgeKey` stringifies as `o-l->i`.
  expect(framed.size).toBe(6);
  const keyed = new Map([...framed].map(([k, v]) => [`${k.get('o')}-${k.get('l')}->${k.get('i')}`, v]));
  expect([...keyed.keys()].sort()).toEqual([
    'josh-created->lop', 'josh-created->ripple', 'marko-created->lop',
    'marko-knows->josh', 'marko-knows->vadas', 'peter-created->lop',
  ]);
  // The value is the LAST edge routed to that key — one Edge element, not a list of them.
  expect(keyed.get('marko-created->lop').id).toBe(9);
});

test('a RECORD-keyed group over a PROPERTY stream frames VertexProperties (upstream getVertexProperties)', async () => {
  // The third snapshot read (`world.js:176-190`). Its VALUE is the property traverser itself, which is
  // the typed tree's third element kind — so `frameTypedNode` walks it at map depth by the one rule it
  // already had for a vertex and an edge.
  const store = seededStore();
  const [framed] = await decodeAll(executeQuery(store,
    'g.V().properties().group().by(__.project("n","k","v").by(__.element().values("name")).by(__.key()).by(__.value())).by(__.tail())', {}));
  expect(framed).toBeInstanceOf(Map);
  expect(framed.size).toBe(12); // 12 vertex properties in the modern graph
  const keyed = new Map([...framed].map(([k, v]) => [`${k.get('n')}-${k.get('k')}->${k.get('v')}`, v]));
  expect(keyed.get('marko-name->marko').key).toBe('name');
  expect(keyed.get('marko-name->marko').value).toBe('marko');
  // The `age` key kept its stored INT type through the record field — `getVertexPropertyKey` renders
  // it `d[29].i`, which it can only do because the value did not become a string on the way out.
  expect(keyed.get('marko-age->29').value).toBe(29);
});
});

// ---------- a MAP-shaped child body (the fourth child shape) ----------
//
// The child seam admitted element/scalar/list bodies; a map-producing body was inadmissible at
// EVERY position, which is why four separate index items named it as their blocker. It needed no new
// SQL — `lowerValueMap` is the ONE map builder and a MapStream is a one-column `map` blob plus
// carried columns (structurally a scalar's `v`). What was missing: the builder REFUSED to run with a
// live origin and declared no carried columns, so it could never rejoin a parent.
describe('a valueMap() child body', () => {
  // The oracle: a child map must decode to the SAME Map the root form does. Asserted through the
  // real GraphBinary wire, not the SQL rows, because the terminal framing is the part that had no
  // path for a list value side (properties are multi-valued).
  //
  // NB compared as a MULTISET, deliberately. Emission order through a child scope already differs
  // from the root form for the LONG-STANDING scalar child — `g.V(1).local(__.out().values("name"))`
  // yields [vadas,lop,josh] where `g.V(1).out().values("name")` yields [josh,lop,vadas] — so a map
  // child matching the root's order would make it the ONLY shape that does. That divergence is real
  // and pre-existing (canonical-emission-order territory, not this seam's), so these tests hold the
  // map child to the same contract as its siblings and the order gap is recorded below, not hidden.






  test('the re-entry consumers still see the BARE value side (contract unchanged)', () => {
    const store = seededStore();
    // select(Column.values)/unfold aggregate the value side as a plain nested array. If materialize
    // had typed the blob in place instead, this would come back double-encoded.
    expect((run(store, 'g.V(1).valueMap("name").select(Column.values)') as any[]).length).toBe(1);
    expect((run(store, 'g.V(1).valueMap("name").unfold()') as any[]).length).toBe(1);
  });

});

// ---------- a RECORD-shaped child body ----------
//
// The cheapest of the non-element shapes, and the one that shows the substrate is right: the record
// builder (lowerRecordSelectProject) ALREADY threaded its carried columns, so unlike the map builder
// it needed no change at all — the classifier was the only gate, and the per-parent rejoin is the
// shared shape-agnostic one. Adding this shape added no SQL and no rejoin code.
describe('a project()/select() child body', () => {



});

// ---------- a group value body composes with EVERY reducer, not just some ----------
//
// tryLowerGroupChildSource's shape gate had two classifiers and chose ONE by whether the body's
// terminal was `count`: classifyCountChild (a body with no scalar projection — `count()`,
// `out().count()`) or classifyScalarChildRows (`<prefix>.<projection>.<reducer>`). They are
// COMPLEMENTARY, so selecting one meant a count-terminal body WITH a projection matched neither,
// and `count` was special for no semantic reason. Now both are tried. This test asserts the
// UNIFORMITY, not the two scenarios that happened to expose it.
describe('group().by(<value traversal>) — reducer/projection uniformity', () => {
  // Via the harness for the reason above: what this asserts is the GROUPING, not how the row was
  // spelled.
  const groupedPairs = (store: GraphStore, g: string) =>
    Object.entries(grouped(run(store, g))).map(([k, v]) => [k, Number(v)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  test('a projection composes with count exactly as it does with the other reducers', () => {
    const store = seededStore();
    // The grid that exposed the hole: a projection + count used to fail while the identical shape
    // under sum/min/max/mean worked. Every cell must now compile.
    for (const body of ['__.label().count()', '__.values("name").count()',
                        '__.out().values("name").count()', '__.outE().values("weight").count()'])
      expect(() => run(store, `g.V().group().by(__.label()).by(${body})`)).not.toThrow();
  });

  test('…and the ANSWERS are right, oracled against the bare count()', () => {
    const store = seededStore();
    // modern: 4 person + 2 software. `label` and `name` exist on EVERY vertex, so counting either
    // per group is the member count — it must equal the bare count() form exactly.
    const members = groupedPairs(store, 'g.V().group().by(__.label()).by(__.count())');
    expect(members).toEqual([['person', 4], ['software', 2]]);
    for (const body of ['__.label().count()', '__.values("name").count()'])
      expect(groupedPairs(store, `g.V().group().by(__.label()).by(${body})`)).toEqual(members);
    // A property only SOME members carry must differ — proving it counts values, not members.
    expect(groupedPairs(store, 'g.V().group().by(__.label()).by(__.values("age").count())'))
      .toEqual([['person', 4], ['software', 0]]);
    // A movement projection counts reached values, and agrees with the movement-only form.
    expect(groupedPairs(store, 'g.V().group().by(__.label()).by(__.out().values("name").count())'))
      .toEqual(groupedPairs(store, 'g.V().group().by(__.label()).by(__.out().count())'));
  });

  test('a reducer that is nonsense over elements still fails closed', () => {
    const store = seededStore();
    // sum/min/max over a body with NO scalar projection has nothing numeric to reduce. The fix
    // widened `count`; it must not have widened these into answering a different question.
    for (const body of ['__.sum()', '__.out().sum()', '__.min()'])
      expect(() => run(store, `g.V().group().by(__.label()).by(${body})`)).toThrow();
  });
});
