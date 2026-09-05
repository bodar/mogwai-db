// Correlated mergeE SEARCH — increment 2: mergeE(__.project('k').by(__.body)).
//
// A whole MAP-PRODUCING traversal as the merge argument, so MergeElementStep.materializeMap runs it at
// the driver (vendor/tinkerpop/.../util/TraversalUtil.java:41-53) and searches edges on the CONCRETE
// per-driver values (vendor/tinkerpop/.../step/map/MergeEdgeStep.java:218). A `project` search map admits
// only STRING property keys — no Direction/T.label token key — so a computed edge search narrows by
// PROPERTIES alone; the create's endpoints/label come from option(onCreate, …). A miss creates one edge
// per DISTINCT (endpoints, computed map). Mirrors mergeVComputed on the edge host. Validated by OUR tests
// — the corpus has no computed-mergeE scenario.
import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { executeQuery, executeFramed } from './support/executor.ts';
import { streamBuffers } from '../src/http.ts';
import { ioc } from '../src/io.ts';

function store(writes: string[]): GraphStore {
  const s = new GraphStore(new BunSqlite(':memory:'));
  for (const w of writes) executeQuery(s, w, {});
  return s;
}

async function run(s: GraphStore, gremlin: string): Promise<any[]> {
  const buffers = await executeFramed(s, gremlin, {});
  const res = streamBuffers(buffers, 64);
  const reader = res.body!.getReader();
  const chunks: Buffer[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
  const parsed = await (ioc as any).graphBinaryReader.readResponse(Buffer.concat(chunks));
  expect(parsed.status.code).toBe(200);
  return parsed.result.data;
}

// marko(1,age29)-knows(w5)->vadas(2); josh(3,age32); peter(4,age35). Integer weights keep the
// value-notation simple; the double case is exercised on the modern graph in the .feature.
const seed = [
  "g.addV('person').property('name','marko').property('age',29)", // 1
  "g.addV('person').property('name','vadas').property('age',27)", // 2
  "g.addV('person').property('name','josh').property('age',32)",  // 3
  "g.addV('person').property('name','peter').property('age',35)", // 4
  "g.V().has('name','marko').as('a').V().has('name','vadas').as('b').addE('knows').from('a').to('b').property('weight',5)",
];

describe('mergeE(__.project(k).by(body)) — correlated edge search', () => {
  test('MATCH by a computed value returns the edge, creates nothing', async () => {
    const s = store(seed);
    const before = await run(s, 'g.E().count()');
    const out = await run(s, "g.V().has('name','marko').mergeE(__.project('weight').by(__.constant(5))).values('weight')");
    expect(out).toEqual([5]);
    expect(await run(s, 'g.E().count()')).toEqual(before); // no create
  });

  test('the search narrows by the computed PROPERTY, not by endpoints — every edge weight 5, not just marko\'s', async () => {
    const s = store([...seed, "g.V().has('name','josh').as('a').V().has('name','peter').as('b').addE('likes').from('a').to('b').property('weight',5)"]);
    // Two edges have weight 5 (knows and likes), neither endpoint-narrowed away — both match the one driver.
    expect(await run(s, "g.V().has('name','marko').mergeE(__.project('weight').by(__.constant(5))).count()")).toEqual([2]);
  });

  test('MISS creates an edge carrying the computed value, via onCreate endpoints', async () => {
    const s = store(seed);
    const out = await run(s, "g.V().has('name','marko').mergeE(__.project('weight').by(__.constant(9))).option(Merge.onCreate,[T.label:'knows',Direction.from:1,Direction.to:3]).values('weight')");
    expect(out).toEqual([9]);
    expect(await run(s, "g.E().has('weight',9).count()")).toEqual([1]);
    expect(await run(s, "g.V().has('name','marko').outE('knows').inV().has('name','josh').count()")).toEqual([1]);
    expect(await run(s, 'g.E().count()')).toEqual([2]);
  });

  test('MISS with no endpoints to create raises the reference sentence', async () => {
    const s = store(seed);
    await expect(run(s, "g.V().has('name','marko').mergeE(__.project('weight').by(__.constant(9)))"))
      .rejects.toThrow(/Out Vertex not specified/);
    expect(await run(s, 'g.E().count()')).toEqual([1]); // nothing created
  });

  test('a numeric computed value compares numerically across storage class', async () => {
    const s = store(seed);
    // 5.0 (double) matches the stored integer 5 — typedValueEq numeric cross-class compare.
    expect(await run(s, "g.V().has('name','marko').mergeE(__.project('weight').by(__.constant(5.0))).count()")).toEqual([1]);
  });

  test('a computed criterion body reads the DRIVER vertex property (by traversal)', async () => {
    const s = store(seed);
    // marko (age 29) searches weight==29 (misses -> create), while a driver whose age is 5 would match.
    // Give marko an incident edge weight 29 so the match branch is exercised too.
    await run(s, "g.V().has('name','vadas').as('a').V().has('name','josh').as('b').addE('rated').from('a').to('b').property('weight',27)");
    // vadas age 27 -> matches the weight-27 rated edge; the others miss and create self loops.
    const out = await run(s, "g.V().hasLabel('person').mergeE(__.project('weight').by(__.values('age'))).option(Merge.onCreate,[T.label:'self',Direction.from:1,Direction.to:1]).values('weight')");
    expect(out.sort((a, b) => a - b)).toEqual([27, 29, 32, 35]); // vadas matched (27), the rest created with their age
  });

  test("by('key') shorthand reads the driver property", async () => {
    const s = store(seed);
    // marko age 29; give marko an edge weight 29 to match.
    await run(s, "g.V().has('name','marko').as('a').V().has('name','peter').as('b').addE('rated').from('a').to('b').property('weight',29)");
    expect(await run(s, "g.V().has('name','marko').mergeE(__.project('weight').by('age')).values('weight')")).toEqual([29]);
  });

  test('MULTI-KEY: two computed criteria both narrow the search and both land on a create', async () => {
    const s = store(seed);
    const out = await run(s, "g.V().has('name','marko').mergeE(__.project('weight','since').by(__.constant(9)).by(__.constant(2020))).option(Merge.onCreate,[T.label:'knows',Direction.from:1,Direction.to:3]).values('since')");
    expect(out).toEqual([2020]);
    expect(await run(s, "g.E().has('weight',9).has('since',2020).count()")).toEqual([1]);
  });

  test('DISTINCT create — two drivers computing the SAME map and endpoints share ONE created edge', async () => {
    const s = store(seed);
    // Two person drivers, both search weight 9 (miss) and both create 1->3; one edge, carried by both.
    const out = await run(s, "g.V().hasLabel('person').limit(2).mergeE(__.project('weight').by(__.constant(9))).option(Merge.onCreate,[T.label:'knows',Direction.from:1,Direction.to:3]).count()");
    expect(out).toEqual([2]);                                     // both drivers carry the edge
    expect(await run(s, "g.E().has('weight',9).count()")).toEqual([1]); // exactly one created
  });

  test('DISTINCT create — different endpoints (per driver) make different edges', async () => {
    const s = store(seed);
    // Two drivers, the SAME computed map (weight 9) but per-driver create endpoints (each a self loop on
    // the driver, via option(Merge.outV/inV, __.select('d'))) -> two edges, one per driver. Proves the
    // distinct key is (src, tgt, map), not the map alone.
    const out = await run(s, "g.V().hasLabel('person').limit(2).as('d').mergeE(__.project('weight').by(__.constant(9))).option(Merge.onCreate,[T.label:'self',Direction.from:Merge.outV,Direction.to:Merge.inV]).option(Merge.outV,__.select('d')).option(Merge.inV,__.select('d')).count()");
    expect(out).toEqual([2]);
    expect(await run(s, "g.E().hasLabel('self').has('weight',9).count()")).toEqual([2]);
  });

  test('onMatch CONSTANT arm writes on the matched edge', async () => {
    const s = store(seed);
    await run(s, "g.V().has('name','marko').mergeE(__.project('weight').by(__.constant(5))).option(Merge.onMatch,['note':'seen'])");
    expect(await run(s, "g.E().has('weight',5).values('note')")).toEqual(['seen']);
  });

  test('onCreate CONSTANT extra props land on the created edge', async () => {
    const s = store(seed);
    await run(s, "g.V().has('name','marko').mergeE(__.project('weight').by(__.constant(9))).option(Merge.onCreate,[T.label:'knows',Direction.from:1,Direction.to:3,'extra':'z'])");
    expect(await run(s, "g.E().has('weight',9).values('extra')")).toEqual(['z']);
  });

  test('a property() TAIL runs over the merge output', async () => {
    const s = store(seed);
    // matched edge (weight 5) gets the tail
    await run(s, "g.V().has('name','marko').mergeE(__.project('weight').by(__.constant(5))).property('tag','m')");
    expect(await run(s, "g.E().has('weight',5).values('tag')")).toEqual(['m']);
    // created edge gets the tail too
    await run(s, "g.V().has('name','marko').mergeE(__.project('weight').by(__.constant(9))).option(Merge.onCreate,[T.label:'knows',Direction.from:1,Direction.to:3]).property('tag','c')");
    expect(await run(s, "g.E().has('weight',9).values('tag')")).toEqual(['c']);
  });

  test('a RUNTIME edge arm value declines (fail closed — edge runtime values are deferred)', async () => {
    const s = store(seed);
    await expect(run(s, "g.V().has('name','marko').mergeE(__.project('weight').by(__.constant(5))).option(Merge.onMatch,['note':__.values('name')])"))
      .rejects.toThrow();
  });
});
