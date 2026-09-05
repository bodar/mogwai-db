// A map-VALUED merge driver for EDGES — inject([T.label:…,(OUT):…,(IN):…]).mergeE() /
// mergeE(__.identity()) / select("m").mergeE().
//
// The incoming TRAVERSER is the merge map (MergeElementStep.materializeMap with the identity/no-arg map
// traversal, vendor/tinkerpop/.../step/map/MergeElementStep.java:339-353). Its entries are decomposed PER
// DRIVER at runtime via json_each over MAP_COL — so the search (label, endpoints AND property criteria)
// is DATA, not compile-time strings (MergeEdgeStep.searchEdges, .java:162-223). A miss creates one edge
// per DISTINCT (src, tgt, map); a create needs both endpoints (else the reference's raise) and resolves
// each endpoint external id to a vertex (else "Vertex does not exist for mergeE"). Twin of mergeVFromMap
// on the edge host. Validated by OUR tests — the corpus map-valued select("m") scenario lands with the
// side-effect map-producing traversal.
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

// marko(1) --knows(weight 0.5)--> vadas(2); josh(3) exists with no incident edges.
const seed = [
  "g.addV('person').property('name','marko')", // 1
  "g.addV('person').property('name','vadas')", // 2
  "g.addV('person').property('name','josh')",  // 3
  "g.addE('knows').from(__.V().has('name','marko')).to(__.V().has('name','vadas')).property('weight',0.5)",
];

describe('map-valued mergeE — inject([T.label:…,(OUT):…,(IN):…]).mergeE()', () => {
  test('MATCH an existing edge by label + endpoints, creates nothing', async () => {
    const s = store(seed);
    expect(await run(s, "g.inject([(T.label):'knows',(OUT):1,(IN):2]).mergeE().values('weight')")).toEqual([0.5]);
    expect(await run(s, 'g.E().count()')).toEqual([1]);
  });

  test('__.identity() is the same as no-arg', async () => {
    const s = store(seed);
    expect(await run(s, "g.inject([(T.label):'knows',(OUT):1,(IN):2]).mergeE(__.identity()).values('weight')")).toEqual([0.5]);
    expect(await run(s, 'g.E().count()')).toEqual([1]);
  });

  test('MISS by label creates the edge, returns it', async () => {
    const s = store(seed);
    expect(await run(s, "g.inject([(T.label):'likes',(OUT):1,(IN):2]).mergeE().label()")).toEqual(['likes']);
    expect(await run(s, "g.E().hasLabel('likes').count()")).toEqual([1]);
    expect(await run(s, 'g.E().count()')).toEqual([2]);
  });

  test('a PROPERTY criterion narrows the search — a non-matching value creates', async () => {
    const s = store(seed);
    // weight 0.9 does not match the stored 0.5 knows edge -> a second knows edge is created
    expect(await run(s, "g.inject([(T.label):'knows',(OUT):1,(IN):2,weight:0.9]).mergeE().values('weight')")).toEqual([0.9]);
    expect(await run(s, "g.E().hasLabel('knows').count()")).toEqual([2]);
  });

  test('a MATCHING property value matches and creates nothing', async () => {
    const s = store(seed);
    expect(await run(s, "g.inject([(T.label):'knows',(OUT):1,(IN):2,weight:0.5]).mergeE().values('weight')")).toEqual([0.5]);
    expect(await run(s, "g.E().hasLabel('knows').count()")).toEqual([1]);
  });

  test('an endpoint that names no vertex raises the reference message', async () => {
    const s = store(seed);
    await expect(run(s, "g.inject([(T.label):'knows',(OUT):1,(IN):99]).mergeE()"))
      .rejects.toThrow('Vertex does not exist for mergeE');
  });

  test('a map missing the OUT endpoint raises before creating', async () => {
    const s = store(seed);
    await expect(run(s, "g.inject([(T.label):'likes',(IN):2]).mergeE()"))
      .rejects.toThrow('Out Vertex not specified in onCreate');
  });

  test('a map missing the IN endpoint raises before creating', async () => {
    const s = store(seed);
    await expect(run(s, "g.inject([(T.label):'likes',(OUT):1]).mergeE()"))
      .rejects.toThrow('In Vertex not specified in onCreate');
  });

  test('a create writes the map\'s string properties onto the new edge', async () => {
    const s = store(seed);
    expect(await run(s, "g.inject([(T.label):'rated',(OUT):1,(IN):2,stars:5]).mergeE().values('stars')")).toEqual([5]);
  });

  test('a map with no T.label defaults the created edge to the "edge" label', async () => {
    const s = store(seed);
    expect(await run(s, "g.inject([(OUT):1,(IN):3]).mergeE().label()")).toEqual(['edge']);
  });

  test('two identical drivers create ONE edge and both carry it', async () => {
    const s = store(seed);
    expect(await run(s, "g.inject([(T.label):'likes',(OUT):1,(IN):2],[(T.label):'likes',(OUT):1,(IN):2]).mergeE().count()")).toEqual([2]);
    expect(await run(s, "g.E().hasLabel('likes').count()")).toEqual([1]);
  });

  test('two DIFFERENT drivers create two edges', async () => {
    const s = store(seed);
    expect(await run(s, "g.inject([(T.label):'likes',(OUT):1,(IN):2],[(T.label):'likes',(OUT):1,(IN):3]).mergeE().count()")).toEqual([2]);
    expect(await run(s, "g.E().hasLabel('likes').count()")).toEqual([2]);
  });

  test('option(onCreate) adds constant properties on the create path', async () => {
    const s = store(seed);
    expect(await run(s, "g.inject([(T.label):'likes',(OUT):1,(IN):2]).mergeE().option(Merge.onCreate,[since:2020]).values('since')")).toEqual([2020]);
  });

  test('option(onMatch) writes over the matched edge', async () => {
    const s = store(seed);
    expect(await run(s, "g.inject([(T.label):'knows',(OUT):1,(IN):2]).mergeE().option(Merge.onMatch,[touched:1]).values('touched')")).toEqual([1]);
    // no create happened
    expect(await run(s, 'g.E().count()')).toEqual([1]);
  });

  test('a property() tail runs over the merged edge', async () => {
    const s = store(seed);
    expect(await run(s, "g.inject([(T.label):'likes',(OUT):1,(IN):2]).mergeE().property('extra','y').values('extra')")).toEqual(['y']);
  });

  test('a T.id in the map is refused (fail closed)', async () => {
    const s = store(seed);
    await expect(run(s, "g.inject([(T.id):5,(T.label):'knows',(OUT):1,(IN):2]).mergeE()"))
      .rejects.toThrow('T.id in a map-valued driver');
  });

  test('the created edge connects the right endpoints', async () => {
    const s = store(seed);
    await run(s, "g.inject([(T.label):'likes',(OUT):1,(IN):3]).mergeE()");
    // marko(1) -likes-> josh(3)
    expect(await run(s, "g.V().has('name','marko').outE('likes').inV().values('name')")).toEqual(['josh']);
  });

  test('select("m") of a withSideEffect constant map feeds the driver (the corpus shape) — MATCH', async () => {
    const s = store(seed);
    expect(await run(s, "g.withSideEffect('m',[(T.label):'knows',(OUT):1,(IN):2]).inject(1).select('m').mergeE().values('weight')")).toEqual([0.5]);
    expect(await run(s, 'g.E().count()')).toEqual([1]);
  });

  test('select("m") of a withSideEffect constant map feeds the driver — CREATE', async () => {
    const s = store(seed);
    expect(await run(s, "g.withSideEffect('m',[(T.label):'likes',(OUT):1,(IN):2]).inject(1).select('m').mergeE().label()")).toEqual(['likes']);
    expect(await run(s, 'g.E().count()')).toEqual([2]);
  });
});
