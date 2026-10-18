// THE PER-TRAVERSER INTERLEAVE OF A WRITE WITH WHAT COMES AFTER IT — one authority (`Placement`,
// `interleaving` in src/compiler/rel/write.ts) every later step asks: a later READ (`readAfterWrite`), a later
// WRITE (`writeAfterWrite`), a later value body (`sequentialGuard`).
//
// The reference hands traverser 1 through every later step before traverser 2 reaches the write — no barrier
// after a short id source or a first flat-map
// (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/LazyBarrierStrategy.java:93-130)
// — so a later step sees only EARLIER traversers' writes, where one statement per step sees them all. Every
// case here is either the reference's answer exactly, or a refusal that leaves the graph as it was.
import { describe, expect, test } from 'bun:test';
import { bare, run, seededStore } from './support/harness.ts';

const values = (store: ReturnType<typeof seededStore>, q: string): unknown[] => bare(run(store, q)).map((row: { v: unknown }) => row.v);
const NOT_YET = /not supported yet/;

/** Refuses, and the graph is what it was before. */
const refuses = (q: string): void => {
  const store = seededStore();
  const before = run(store, 'g.V().valueMap(true)');
  const edges = run(store, 'g.E().valueMap(true)');
  expect(() => run(store, q), q).toThrow(NOT_YET);
  expect(run(store, 'g.V().valueMap(true)')).toEqual(before);
  expect(run(store, 'g.E().valueMap(true)')).toEqual(edges);
};

describe('a READ after a write over several traversers, with no drain between (readAfterWrite)', () => {
  // The reference's answers: 3, 3, [1,2], 1 — one statement per step said 4, 4, [2,2], 2.
  for (const q of [
    "g.inject(1,2).addV('x').V().hasLabel('x').count()",
    "g.V(1,2).addE('k').to(V(3)).V(3).inE('k').count()",
    "g.inject(1,2).as('a').V(1).property(single,'w',select('a')).values('w')",
    "g.inject(1,2).as('a').addV('x').filter(select('a').is(1)).V().hasLabel('x').count()",
    // …at every depth of the reading step's bodies
    "g.inject(1,2).addV('x').where(V().hasLabel('x').count().is(1))",
    "g.inject(1,2).addV('x').local(V().hasLabel('x').count())",
    "g.inject(1,2).addV('x').project('c').by(V().hasLabel('x').count())",
    "g.inject(1,2).addV('x').choose(V().hasLabel('x').count().is(1), constant('one'), constant('two'))",
    "g.inject(1,2).addV('x').as('v').select('v').V().hasLabel('x').count()",
    "g.V(1,2).addE('k').to(V(3)).inV().inE('k').count()",
    "g.V(1,2).addLabel('z').V().hasLabel('z').count()",
    // a reducer's by() runs per traverser as the barrier pulls (`ReducingBarrierStep.processAllStarts`)
    "g.inject(1,2).as('a').V(1).property(single,'w',select('a')).group().by(values('w')).by(count())",
  ]) test(q, () => refuses(q));

  test('one traverser through the write is the reference exactly', () => {
    expect(values(seededStore(), "g.V(1).addV('x').V().hasLabel('x').count()")).toEqual([1]);
    expect(values(seededStore(), "g.inject(1).as('a').V(1).property(single,'w',select('a')).values('w')")).toEqual([1]);
  });

  test('a read of the traverser\'s OWN element after a write every traverser makes alike', () => {
    expect(values(seededStore(), "g.V().property('x',1).values('x')")).toEqual([1, 1, 1, 1, 1, 1]);
    expect(values(seededStore(), "g.V(1,2).property(single,'w',5).values('w')")).toEqual([5, 5]);
    // …a write onto the element this traverser just made
    expect(values(seededStore(), "g.inject(1,2).addV('x').property('n',1).values('n')")).toEqual([1, 1]);
    // …and the endpoints of its own edge, which no write changes
    expect(values(seededStore(), "g.V(1,2).addE('k').to(V(3)).inV().id()")).toEqual([3, 3]);
  });

  test('a DRAIN between the write and the read: every traverser wrote first', () => {
    // `TraversalUtil`'s per-traverser value lands on V(1) twice, last 2; fold()/barrier()/order() pull everything.
    for (const drain of ['fold().unfold()', 'barrier()', 'order()']) {
      expect(values(seededStore(), `g.inject(1,2).as('a').V(1).property(single,'w',select('a')).${drain}.values('w')`)).toEqual([2, 2]);
    }
  });
});

describe('a WRITE after a write — matched by element kind, freshness, ownership and barrier, not by key alone', () => {
  // The blocker witness and its relatives still refuse: traverser 2's 5 lands after traverser 1's 9.
  for (const q of [
    "g.inject(1,2).as('a').V(1).property(single,'w',5).filter(select('a').is(1)).property(single,'w',9)",
    "g.inject(1,2).as('a').V(1).property(single,'w',5).filter(select('a').is(1)).mergeV([name:'marko']).option(onMatch,[w:single(9)])",
    "g.inject(1,2).as('a').V(1).property(single,'w',5).filter(select('a').is(1)).drop()",
    "g.inject(1,2).as('a').V(1).as('v').property(single,'w',5).filter(select('a').is(1)).select('v').property(single,'w',9)",
    "g.inject(1,2).addV('x').mergeV([(T.label):'x'])",
    "g.inject(1,2).addV('x').property('name','zz').mergeV([name:'zz'])",
  ]) test(q, () => refuses(q));

  test('(a) a later write onto a FRESH element meets no other traverser\'s write', () => {
    const store = seededStore();
    run(store, "g.inject(1,2).as('a').V(1).property(single,'w',5).filter(select('a').is(1)).addV('zz').property('w',9)");
    expect(values(store, "g.V().hasLabel('zz').values('w')")).toEqual([9]);
    expect(values(store, "g.V(1).values('w')")).toEqual([5]);
  });

  test('(b) a vertex write and an edge write never land on one element', () => {
    const store = seededStore();
    run(store, "g.V(1,2).property(single,'w',5).addE('k').to(V(3)).property('w',9)");
    expect(values(store, "g.E().hasLabel('k').values('w')")).toEqual([9, 9]);
    expect(values(store, "g.V(1,2).values('w')")).toEqual([5, 5]);
    const other = seededStore();
    run(other, "g.V(1,2).as('v').property(single,'w',5).select('v').outE('knows').property('w',9)");
    expect(values(other, "g.E(7,8).values('w')")).toEqual([9, 9]);
  });

  test('(c) a write or drop on the traverser\'s OWN element, none reached twice', () => {
    const props = seededStore();
    run(props, "g.V(1,2).property(single,'w',5).properties('w').drop()");
    expect(values(props, "g.V().values('w')")).toEqual([]);
    const element = seededStore();
    run(element, "g.V(1,2).property(single,'w',5).drop()");
    expect(values(element, 'g.V().count()')).toEqual([4]);
  });

  test('(d) past the NoOpBarrierStep LazyBarrierStrategy puts after a second flat-map, the batch order IS the reference order', () => {
    const store = seededStore();
    run(store, "g.V().property(single,'w',1).out().property(single,'w',2)");
    expect(values(store, "g.V().order().by(id).values('w')")).toEqual([1, 2, 2, 2, 2, 1]);
  });

  test('(d) …only while the barrier holds the whole stream: it stops pulling at 2500 distinct traversers', () => {
    const store = seededStore();
    run(store, `g.inject(${Array.from({ length: 2500 }, (_, i) => i).join(',')}).addV('n')`);
    expect(() => run(store, "g.V().property(single,'w',1).out().property(single,'w',2)")).toThrow(/holds at most 2500 distinct traversers/);
    expect(values(store, "g.V().has('w').count()")).toEqual([0]);
  });

  test('(e) a merge whose search cannot find what an earlier creation made', () => {
    const store = seededStore();
    // traverser 1 creates zz, traverser 2 finds it: one zz, emitted twice.
    expect(values(store, "g.inject(1,2).addV('x').mergeV([name:'zz']).values('name')")).toEqual(['zz', 'zz']);
    expect(values(store, "g.V().has('name','zz').count()")).toEqual([1]);
  });
});

describe('a write over traversers the reference MERGED runs once per merged traverser (mergedOnceAlike)', () => {
  // `LazyBarrierStrategy`'s barrier after out() merges lop's three traversers into one, which AddVertexStep
  // maps ONCE and a `list` property appends ONCE (SideEffectStep/ScalarMapStep act per traverser object).
  for (const q of [
    "g.V().out().addV('x')",
    "g.V().out().property('w',2)",
    "g.V().property('w',1).out().property('w',2)",
    'g.inject(1,1).addV(\'x\')',
  ]) test(q, () => refuses(q));

  test('a write a second run leaves alike, or a stream nothing merged, still answers', () => {
    const single = seededStore();
    run(single, "g.V().out().property(single,'w',2)");
    expect(values(single, "g.V(3).values('w')")).toEqual([2]);
    // no barrier before a first flat-map: lop arrives three times, unmerged, and is created after three times
    const unmerged = seededStore();
    run(unmerged, "g.V(1,4,6).out().addV('x')");
    expect(values(unmerged, "g.V().hasLabel('x').count()")).toEqual([6]);
    // a merge point over a stream that reached no element twice merged nothing
    expect(values(seededStore(), "g.V(1,4,6).out().out().property('w',2).values('w')")).toEqual([2, 2]);
  });
});
