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
    // (a)'s exemption does NOT hold where the earlier write's FEED re-reads the graph: traverser 2's V() reaches
    // traverser 1's new vertices and writes w=5 over their w=9 (`streamSeesCreation`)…
    "g.inject(1,2).as('a').V().property(single,'w',5).filter(select('a').is(1)).addV('x').property(single,'w',9)",
    "g.inject(1,2).V().property(single,'w',5).addV('x').property(single,'w',9)",
    "g.inject(1,2).V().hasLabel('person','x').property(single,'w',5).addV('x').property(single,'w',9)",
    // …or crosses an edge the program also creates, or reaches an edge where the creation is one
    "g.inject(1,2).as('a').V(1).out().property(single,'w',5).filter(select('a').is(1)).addV('x').property(single,'w',9).addE('k').from(V(1))",
    "g.inject(1,2).as('a').V(1).outE('knows').property('w',5).filter(select('a').is(1)).V(1).addE('knows').to(V(2)).property('w',9)",
    // (d) past the barrier, a step between it and the later write runs per traverser and sees that write's
    // effect for traversers the barrier emitted first (`readBeforeWrite`)
    "g.V().property(single,'w',1).out().where(__.in().has('w',1)).property(single,'w',2)",
    "g.V().property(single,'w',1).out().not(__.in().has('w',2)).property(single,'w',2)",
    "g.V().property(single,'w',1).out().where(__.in().has('w',1)).property(single,'w',2).count()",
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

describe('a READ BEFORE a write, run for a later traverser after the write ran for an earlier one (readBeforeWrite)', () => {
  // The reference's answers: josh alone written; 18 vertices; lop written once, then filtered.
  for (const q of [
    "g.V(4,5).where(__.in().hasNot('w')).property(single,'w',2)",
    "g.inject(1,2).V().addV('x')",
    "g.inject(1,2).V().hasLabel('person').addV('x')",
    "g.V().out().where(__.in().values('w').count().is(0)).property(single,'w',1)",
    "g.V().out().coalesce(__.in().has('w'), identity()).property(single,'w',1)",
    // an own-element read where an element reaches the write twice (`repeatedGuard` at run time)
    "g.V().out().hasNot('w').property(single,'w',1)",
    "g.V().as('x').out().select('x').hasNot('w').property(single,'w',2)",
  ]) test(q, () => refuses(q));

  test('a read of the traverser\'s OWN element, no element reaching the write twice, is the reference exactly', () => {
    expect(values(seededStore(), "g.V().hasNot('w').property(single,'w',1).count()")).toEqual([6]);
    expect(values(seededStore(), "g.V().out().dedup().hasNot('w').property(single,'w',1).count()")).toEqual([4]);
    // statically unproven, distinct at run time
    expect(values(seededStore(), "g.V().out().out().hasNot('w').property(single,'w',2).count()")).toEqual([2]);
  });

  test('a read no write can change, or that no traverser passed before the first write, is the reference exactly', () => {
    // a labelled move crosses no edge of another label; a vertex read sees no edge merge's keys
    expect(values(seededStore(), "g.V().as('a').out('created').addE('createdBy').to('a').count()")).toEqual([4]);
    // nothing passes the filter before a write, so no write precedes any traverser's read
    expect(values(seededStore(), "g.V().out().where(__.in().has('w')).property(single,'w',1).count()")).toEqual([0]);
    // one traverser reaches the read
    expect(values(seededStore(), "g.V(1).where(__.out().hasNot('w')).property(single,'w',1).count()")).toEqual([1]);
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

describe('a READ BEFORE an addE, crossing an edge an earlier traverser just made (readBeforeWrite, `edges`)', () => {
  // No barrier follows the FIRST flat-map, and V(1,4) (fewer than five ids) is none
  // (LazyBarrierStrategy.java:109-130): traverser 2's out() crosses the edges traverser 1 made. The
  // reference's answers: 8, 6, 7, 8, 8, 8, 8, four `created` edges, 8, 9 — each one or more short here before.
  for (const q of [
    "g.V(1,4).out().addE('k').from(V(4)).to(V(3)).count()",
    "g.V(1,4).out().addE('k').to(V(3)).count()",
    "g.V(1,4).both().addE('k').to(V(3)).count()",
    "g.V(1,4).outE().inV().addE('k').from(V(4)).to(V(3)).count()",
    "g.V(1,4).outE().addE('k').from(V(4)).to(V(3)).count()",
    "g.V(1,4).local(out()).addE('k').from(V(4)).to(V(3)).count()",
    "g.V(1,4).union(out()).addE('k').from(V(4)).to(V(3)).count()",
    "g.V(1,4).out('created').addE('created').from(V(4)).to(V(3))",
    "g.V().hasLabel('person').out().addE('k').to(V(1)).count()",
    // a labelled path suppresses every barrier
    "g.inject(1,2).as('i').V(1).out().addE('k').from(V(1)).to(V(2)).count()",
    "g.V(1,4).out().union(addE('k').to(V(3))).count()",
    // a merge's new edge, crossed by a later traverser's unlabelled both()
    "g.V(1).both().both().as('v').mergeE([(T.label):'dup',(Direction.OUT):Merge.outV,(Direction.IN):Merge.inV]).option(Merge.outV,select('v')).option(Merge.inV,select('v'))",
    // an own-vertex read whose direction is NOT pinned to the traverser's vertex: from(V(2)) makes edges out
    // of vadas, which vadas's own outE('l') then sees; to(V(2)) makes edges into her
    "g.V(1,2,3,4).where(__.not(__.outE('l'))).addE('l').from(V(2))",
    "g.V(1,2,3,4).where(__.not(__.inE('l'))).addE('l').to(V(2))",
    // past the pinned hop the body stands on another vertex, whose edges are anyone's
    "g.V(1,2,3).where(__.not(__.inE('l').outV().outE('l'))).addE('l').from(V(6))",
  ]) test(q, () => refuses(q));

  const edges = (q: string): unknown[] => { const store = seededStore(); run(store, q); return values(store, "g.E().hasLabel('l').count()"); };

  test('a first hop off the traverser\'s own vertex in the direction the new edge is pinned to (edgeAnchor)', () => {
    // replication's placement: the new edge goes INTO each traverser's own vertex, so another's inE('l') never sees it
    expect(edges("g.V(1,2,3,4).where(__.not(__.inE('l'))).addE('l').from(V(6))")).toEqual([4]);
    expect(edges("g.V(1,2,3).has('name').where(__.not(__.inE('l'))).has('name').addE('l').from(V(6))")).toEqual([3]);
    expect(edges("g.V(1,2,3).where(__.not(__.in('l').has('name'))).addE('l').from(V(6))")).toEqual([3]);
    // a self-loop is pinned both ways
    expect(edges("g.V(1,2,3).where(__.not(__.both('l'))).addE('l')")).toEqual([3]);
  });

  test('a sized barrier between the reads and the addE: every traverser read first', () => {
    // out() is the second flat-map, so a NoOpBarrierStep follows it; to(V(3))'s own body places nothing before it
    for (const q of ["g.V(1,4).out().out().addE('k').to(V(3))", "g.V().out().out().addE('k').from(V(3))"]) {
      const store = seededStore();
      run(store, q);
      expect(values(store, "g.E().hasLabel('k').count()"), q).toEqual([2]);
    }
  });

  test('a label read reaches no edge by itself', () => {
    // the corpus's codeveloper form: where(neq('a')) compares path objects
    expect(values(seededStore(), "g.V().as('a').out('created').in('created').where(neq('a')).as('b').addE('codeveloper').from('a').to('b').count()")).toEqual([6]);
  });
});

describe('a READ BEFORE a terminal drop(), which switches LazyBarrierStrategy off (LazyBarrierStrategy.java:80-86)', () => {
  // The reference's answers: [1,4] (lop is gone before peter is read), the same, [1,5,6] (josh is dropped from
  // marko before his own start reaches him, so ripple survives), and 5 edges (edge 11 survives: josh has one left).
  for (const q of [
    'g.V().not(__.out()).drop()',
    'g.V().where(__.out().count().is(0)).drop()',
    'g.V().out().drop()',
    'g.V().out().out().drop()',
    'g.E().where(__.outV().outE().count().is(2)).drop()',
  ]) test(q, () => refuses(q));

  const after = (q: string, read: string): unknown[] => { const store = seededStore(); run(store, q); return values(store, read); };

  test('own-element reads, a drain between, and a final hop no edge joins two dropped vertices across', () => {
    expect(after("g.V().has('age',gt(30)).drop()", 'g.V().id()')).toEqual([1, 2, 3, 5]);
    expect(after('g.V().not(__.out()).barrier().drop()', 'g.V().id()')).toEqual([1, 4, 6]);
    expect(after("g.V().out('knows').drop()", 'g.V().id()')).toEqual([1, 3, 5, 6]);
    expect(after("g.V().hasLabel('person').aggregate('a').out('created').drop()", 'g.V().id()')).toEqual([1, 2, 4, 6]);
    // a target reached twice behind the hop: dropped again, it is a no-op
    expect(after("g.V().out('created').has('lang','java').drop()", 'g.V().id()')).toEqual([1, 2, 4, 6]);
    // an edge drop pinned to the vertex the read stands on
    expect(after('g.V().where(__.out()).outE().drop()', 'g.E().count()')).toEqual([0]);
    expect(after("g.V().properties('name').hasValue('marko').drop()", "g.V(1).values('name')")).toEqual([]);
  });
});

describe('drop() after EVERY hop kind, at depth and under local()/union(): the reference exactly, or a clean refusal', () => {
  // A final `both()` before a vertex drop once reached the user as `RelIR: duplicate Plan binding 'r0'`: the
  // drop's own target snapshot and the `dropTargetsLinked` guard over the same target were named by two
  // separate `name()` calls, and both called their first shared node `r0`.
  const prefixes = ['', "hasLabel('person').", "out('knows').", "in('created').", 'both().', 'outE().inV().', 'bothE().otherV().'];
  const hops = ['out()', 'in()', 'both()', "both('knows')", 'outE()', 'inE()', 'bothE()', "bothE('created')",
    'outE().inV()', 'inE().outV()', 'bothE().otherV()', 'outE().otherV()'];
  const suffixes = ['', ".hasLabel('software')", '.dedup()', '.limit(2)'];
  // Every prefix × hop × suffix at the top level; each hop at depth one and two under local()/union().
  const forms = [
    ...prefixes.flatMap((p) => hops.flatMap((h) => suffixes.map((s) => `g.V().${p}${h}${s}.drop()`))),
    ...['local', 'union'].flatMap((w) => ['', 'both().'].flatMap((p) => hops.map((h) => `g.V().${w}(__.${p}${h}).drop()`))),
  ];
  test('no form raises anything but the refusal, and a refusal leaves the graph as it was', () => {
    // One store until a form answers (a refusal rolls back, so the next form still starts on the modern graph).
    let store = seededStore();
    const state = (): unknown[] => [values(store, 'g.V().id()'), values(store, 'g.E().id()')];
    const modern = state();
    for (const q of forms) {
      try { run(store, q); store = seededStore(); } catch (e) {
        expect((e as Error).message, q).toMatch(NOT_YET);
        expect(state(), q).toEqual(modern);
      }
    }
  }, 30_000);

  const graph = (q: string): [unknown[], unknown[]] => { const store = seededStore(); run(store, q); return [values(store, 'g.V().id()'), values(store, 'g.E().id()')]; };
  test('the forms that answer are the reference', () => {
    // both(): no edge joins two distinct dropped vertices across, so the hop is exact (`dropTargetsLinked`)
    expect(graph("g.V().both().hasLabel('software').drop()")).toEqual([[1, 2, 4, 6], [7, 8]]);
    expect(graph('g.V(4).both().drop()')).toEqual([[2, 4, 6], []]);
    expect(graph("g.V().hasLabel('person').in().drop()")).toEqual([[2, 3, 4, 5, 6], [10, 11, 12]]);
    // an EDGE drop is idempotent: bothE() reaches every edge from both ends, and the second drop is a no-op
    expect(graph('g.V().bothE().drop()')).toEqual([[1, 2, 3, 4, 5, 6], []]);
    expect(graph("g.V().bothE('created').dedup().drop()")).toEqual([[1, 2, 3, 4, 5, 6], [7, 8]]);
    expect(graph("g.V().hasLabel('person').inE().drop()")).toEqual([[1, 2, 3, 4, 5, 6], [9, 10, 11, 12]]);
    expect(graph("g.V().bothE().has('weight',gt(0.5)).drop()")).toEqual([[1, 2, 3, 4, 5, 6], [7, 9, 11, 12]]);
  });

  // A stream-counting step after the final hop spends its budget on the plan's duplicates (`finalHop`): the
  // reference drops 9, 7, 8 and 11 (vadas's 7 is gone before his start is read); the plan's fourth is 7 again.
  for (const q of ['g.V().bothE().limit(4).drop()', 'g.V().outE().limit(4).drop()', 'g.V().both().drop()', "g.V(1).out('knows').both().drop()"]) {
    test(q, () => refuses(q));
  }
});
