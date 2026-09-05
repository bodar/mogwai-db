// Correlated merge SEARCH — increment 1: mergeV(__.project('k').by(__.body)).
//
// The merge argument is a whole MAP-PRODUCING traversal, so MergeElementStep.materializeMap runs it at
// the driver (vendor/tinkerpop/.../util/TraversalUtil.java:41-53) and searches on the CONCRETE per-driver
// values (vendor/tinkerpop/.../MergeElementStep.java:397-404). The search is correlated per driver; a
// match returns the found vertex, a miss creates one per DISTINCT computed map. Validated by OUR tests —
// the corpus has no computed-merge scenario.
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

const modern = [
  "g.addV('person').property('name','marko').property('age',29)",
  "g.addV('person').property('name','vadas').property('age',27)",
  "g.addV('person').property('name','josh').property('age',32)",
  "g.addV('person').property('name','peter').property('age',35)",
  "g.addV('software').property('name','lop')",
  "g.addV('software').property('name','ripple')",
];

describe('mergeV(__.project(k).by(body)) — correlated search', () => {
  test('MATCH by a constant computed value finds the vertex, creates nothing', async () => {
    const s = store(modern);
    const before = await run(s, 'g.V().count()');
    const out = await run(s, "g.V().limit(1).mergeV(__.project('name').by(__.constant('marko'))).values('name')");
    expect(out).toEqual(['marko']);
    expect(await run(s, 'g.V().count()')).toEqual(before); // no create
  });

  test('MATCH by a numeric computed value compares numerically (int)', async () => {
    const s = store(modern);
    const out = await run(s, "g.V().limit(1).mergeV(__.project('age').by(__.constant(29))).values('name')");
    expect(out).toEqual(['marko']);
  });

  test('MISS creates a vertex carrying the computed value, and returns it', async () => {
    const s = store(modern);
    const out = await run(s, "g.V().limit(1).mergeV(__.project('name').by(__.constant('brandnew'))).values('name')");
    expect(out).toEqual(['brandnew']);
    expect(await run(s, "g.V().has('name','brandnew').count()")).toEqual([1]);
  });

  test('CORRELATED create — each person seeds a distinct new vertex by its own name', async () => {
    const s = store(modern);
    // No vertex has a 'handle' property, so every person MISSES and creates handle=<their name>.
    const out = await run(s, "g.V().hasLabel('person').mergeV(__.project('handle').by(__.values('name'))).values('handle')");
    expect(out.sort()).toEqual(['josh', 'marko', 'peter', 'vadas']);
    expect(await run(s, "g.V().has('handle','marko').count()")).toEqual([1]);
    expect(await run(s, "g.V().has('handle').count()")).toEqual([4]);
  });

  test('CORRELATED match — each person finds ITSELF by computed name (no creates)', async () => {
    const s = store(modern);
    const before = await run(s, 'g.V().count()');
    const out = await run(s, "g.V().hasLabel('person').mergeV(__.project('name').by(__.values('name'))).values('name')");
    expect(out.sort()).toEqual(['josh', 'marko', 'peter', 'vadas']);
    expect(await run(s, 'g.V().count()')).toEqual(before);
  });

  test('TAIL over a MATCH — property() after the merge writes onto the found vertex', async () => {
    const s = store(modern);
    const out = await run(s, "g.V().has('name','marko').mergeV(__.project('name').by(__.values('name'))).property('seen','yes').values('seen')");
    expect(out).toEqual(['yes']);
    expect(await run(s, "g.V().has('name','marko').has('seen','yes').count()")).toEqual([1]);
    expect(await run(s, "g.V().has('seen','yes').count()")).toEqual([1]);
  });

  test('TAIL over a CREATE — property() after the merge writes onto each created vertex', async () => {
    const s = store(modern);
    const out = await run(s, "g.V().hasLabel('person').mergeV(__.project('handle').by(__.values('name'))).property('kind','h').values('kind')");
    expect(out).toEqual(['h', 'h', 'h', 'h']);
    expect(await run(s, "g.V().has('handle').has('kind','h').count()")).toEqual([4]);
  });

  test('DISTINCT create — two drivers with the SAME computed value share one created vertex', async () => {
    const s = store(modern);
    // Both persons compute handle='same' → one create, two traversers carry it.
    const out = await run(s, "g.V().hasLabel('person').limit(2).mergeV(__.project('handle').by(__.constant('same'))).values('handle')");
    expect(out).toEqual(['same', 'same']);
    expect(await run(s, "g.V().has('handle','same').count()")).toEqual([1]);
  });

  test('by("key") shorthand — a string by() is values("key")', async () => {
    const s = store(modern);
    const out = await run(s, "g.V().has('name','marko').mergeV(__.project('name').by('name')).values('name')");
    expect(out).toEqual(['marko']);
    expect(await run(s, 'g.V().count()')).toEqual([6]);
  });

  test('MULTI-KEY — every computed criterion must hold (miss creates a vertex carrying all)', async () => {
    const s = store(modern);
    const out = await run(s, "g.V().has('name','marko').mergeV(__.project('a','b').by(__.constant('x')).by(__.constant('y'))).values('a')");
    expect(out).toEqual(['x']);
    expect(await run(s, "g.V().has('a','x').has('b','y').count()")).toEqual([1]);
    expect(await run(s, 'g.V().count()')).toEqual([7]);
  });

  test('MULTI-KEY match — an existing vertex satisfying all criteria is found, not duplicated', async () => {
    const s = store(modern);
    const out = await run(s, "g.V().has('name','marko').mergeV(__.project('name','age').by('name').by('age')).values('name')");
    expect(out).toEqual(['marko']);
    expect(await run(s, 'g.V().count()')).toEqual([6]);
  });

  test('option(onMatch, [const]) — writes onto the MATCHED vertex', async () => {
    const s = store(modern);
    const out = await run(s, "g.V().has('name','marko').mergeV(__.project('name').by(__.values('name'))).option(Merge.onMatch, ['seen':'yes']).values('seen')");
    expect(out).toEqual(['yes']);
    expect(await run(s, "g.V().has('name','marko').has('seen','yes').count()")).toEqual([1]);
    expect(await run(s, 'g.V().count()')).toEqual([6]);
  });

  test('option(onCreate, [const + T.label]) — writes onto the CREATED vertex with its label', async () => {
    const s = store(modern);
    const out = await run(s, "g.V().has('name','marko').mergeV(__.project('handle').by(__.constant('newh'))).option(Merge.onCreate, [(T.label):'account','status':'fresh']).values('handle')");
    expect(out).toEqual(['newh']);
    expect(await run(s, "g.V().hasLabel('account').has('handle','newh').has('status','fresh').count()")).toEqual([1]);
    expect(await run(s, 'g.V().count()')).toEqual([7]);
  });

  test('option(onMatch, [k: __.trav]) RUNTIME — each matched vertex gets ITS OWN driver value', async () => {
    const s = store(modern);
    // Each person matches itself and sets echo = its own age — the per-driver ord-correlation.
    const out = await run(s, "g.V().hasLabel('person').mergeV(__.project('name').by(__.values('name'))).option(Merge.onMatch, ['echo': __.values('age')]).values('echo')");
    expect(out.sort((a: number, b: number) => a - b)).toEqual([27, 29, 32, 35]);
    expect(await run(s, "g.V().has('name','marko').values('echo')")).toEqual([29]);
    expect(await run(s, "g.V().has('name','peter').values('echo')")).toEqual([35]);
  });

  test('option(onCreate, [k: __.trav]) RUNTIME — each created vertex gets ITS driver value', async () => {
    const s = store(modern);
    const out = await run(s, "g.V().hasLabel('person').mergeV(__.project('handle').by(__.values('name'))).option(Merge.onCreate, ['fromAge': __.values('age')]).values('handle')");
    expect(out.sort()).toEqual(['josh', 'marko', 'peter', 'vadas']);
    expect(await run(s, "g.V().has('handle','marko').values('fromAge')")).toEqual([29]);
    expect(await run(s, "g.V().has('handle','peter').values('fromAge')")).toEqual([35]);
  });

  test('an explicit list/set cardinality on a RUNTIME arm value declines (fail closed)', async () => {
    const s = store(modern);
    await expect(run(s, "g.V().has('name','marko').mergeV(__.project('name').by(__.values('name'))).option(Merge.onMatch, ['x': __.values('age')], Cardinality.list)")).rejects.toThrow();
  });

  test('a tail on a MATCHED vertex is FTS-indexed (the matched side is marked dirty)', async () => {
    const s = store(modern);
    await run(s, "g.V().has('name','marko').mergeV(__.project('name').by(__.values('name'))).property('note','findable words')");
    const fts = s.query("SELECT owner FROM property_fts WHERE pk='note'", []) as { owner: number }[];
    expect(fts.length).toBe(1);
  });
});
