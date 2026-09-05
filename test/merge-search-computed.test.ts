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

  test('DISTINCT create — two drivers with the SAME computed value share one created vertex', async () => {
    const s = store(modern);
    // Both persons compute handle='same' → one create, two traversers carry it.
    const out = await run(s, "g.V().hasLabel('person').limit(2).mergeV(__.project('handle').by(__.constant('same'))).values('handle')");
    expect(out).toEqual(['same', 'same']);
    expect(await run(s, "g.V().has('handle','same').count()")).toEqual([1]);
  });
});
