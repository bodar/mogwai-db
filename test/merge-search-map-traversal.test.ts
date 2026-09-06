// A GENERAL map-producing TRAVERSAL as the merge argument — mergeV(__.out().project(…)),
// mergeV(__.select(dynMap)). MergeElementStep.materializeMap runs the whole body at each driver and takes
// .next() (the FIRST map), raising "The provided traverser does not map to a value" for a driver the body
// is unproductive on (vendor/tinkerpop/.../util/TraversalUtil.java:41-53). The body is resolved correlated
// per driver via childRows(perRow), record→map collapsed, first-per-driver, and fed to the map-valued
// merge driver (mergeVFromMap/mergeEFromMap). This is combinatorial completeness: a map producer in the
// merge-argument position composes through the SAME search/create as inject(map)/select("m"), whatever
// produces it. Distinct from a LEADING project (the computed search) and from __.identity() (the map-driver).
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

// marko(1)-knows->vadas(2); josh(3) has no incident edges.
const seed = [
  "g.addV('person').property('name','marko').property('age',29)",
  "g.addV('person').property('name','vadas').property('age',27)",
  "g.addV('person').property('name','josh').property('age',32)",
  "g.addE('knows').from(__.V().has('name','marko')).to(__.V().has('name','vadas'))",
];

describe('general map-producing traversal as the mergeV argument', () => {
  test('out().project() — a map rooted at a DIFFERENT element than the driver — matches', async () => {
    const s = store(seed);
    // marko's out is vadas; the produced map {name:vadas} matches vadas, creates nothing.
    expect(await run(s, "g.V().has('name','marko').mergeV(__.out().project('name').by(__.values('name'))).values('name')")).toEqual(['vadas']);
    expect(await run(s, 'g.V().count()')).toEqual([3]);
  });

  test('out().project() — a map that matches nothing creates the vertex', async () => {
    const s = store(seed);
    expect(await run(s, "g.V().has('name','marko').mergeV(__.out().project('name').by(__.constant('kuzu'))).values('name')")).toEqual(['kuzu']);
    expect(await run(s, "g.V().has('name','kuzu').count()")).toEqual([1]);
    expect(await run(s, 'g.V().count()')).toEqual([4]);
  });

  test('a driver the body is UNPRODUCTIVE on raises the reference message', async () => {
    const s = store(seed);
    // josh has no out(), so the body produces no map for it → materializeMap's next() throws.
    await expect(run(s, "g.V().has('name','josh').mergeV(__.out().project('name').by(__.values('name'))).values('name')"))
      .rejects.toThrow('The provided traverser does not map to a value');
  });

  test('MIXED productivity raises (one driver unproductive aborts the traversal)', async () => {
    const s = store(seed);
    // marko is productive (out→vadas), josh is not — the whole traversal raises, as TinkerPop's per-driver loop does.
    await expect(run(s, "g.V().has('age',P.gt(28)).mergeV(__.out().project('name').by(__.values('name')))"))
      .rejects.toThrow('The provided traverser does not map to a value');
  });

  test('a multi-key produced map narrows on every key — matches', async () => {
    const s = store(seed);
    expect(await run(s, "g.V().has('name','marko').mergeV(__.out().project('name','age').by(__.values('name')).by(__.values('age'))).values('name')")).toEqual(['vadas']);
    expect(await run(s, 'g.V().count()')).toEqual([3]);
  });

  test('a multi-key produced map with one wrong value creates', async () => {
    const s = store(seed);
    expect(await run(s, "g.V().has('name','marko').mergeV(__.out().project('name','age').by(__.values('name')).by(__.constant(99))).values('age')")).toEqual([99]);
    expect(await run(s, 'g.V().count()')).toEqual([4]);
  });

  test('a LIST-valued produced map (valueMap) declines (fail closed, as the map-driver does)', async () => {
    const s = store(seed);
    await expect(run(s, "g.V().has('name','marko').mergeV(__.valueMap())")).rejects.toThrow(/not supported/);
  });

  test('a LEADING project is still the computed search, unchanged', async () => {
    const s = store(seed);
    // a leading project roots at the DRIVER — the computed path, not the general one.
    expect(await run(s, "g.V().has('name','marko').mergeV(__.project('name').by(__.constant('marko'))).values('name')")).toEqual(['marko']);
    expect(await run(s, 'g.V().count()')).toEqual([3]);
  });

  test('a create writes the produced map onto the new vertex', async () => {
    const s = store(seed);
    await run(s, "g.V().has('name','marko').mergeV(__.out().project('name','role').by(__.constant('kuzu')).by(__.constant('db')))");
    expect(await run(s, "g.V().has('name','kuzu').values('role')")).toEqual(['db']);
  });
});

describe('general map-producing traversal as the mergeE argument', () => {
  test('a produced map with only string keys (no endpoints) raises "Out Vertex not specified"', async () => {
    const s = store(seed);
    // a project() produces string keys only — no Direction endpoints — so a create has nowhere to go.
    await expect(run(s, "g.V().has('name','marko').mergeE(__.out().project('t').by(__.constant('x')))"))
      .rejects.toThrow('Out Vertex not specified in onCreate');
  });
});
