// Correlated mergeE SEARCH — a computed criterion per driver (mergeE(__.project('k').by(__.body))).
//
// Increment 2 will build this (mirroring mergeVComputed: a per-driver carrier, a correlated EXISTS over
// edge_properties compared with typedValueEq, create-per-distinct with onCreate endpoints). Until then
// it must DECLINE (fail closed) — NOT drop the computed criterion and search unfiltered, which was a
// live wrong-answer bug: elementMergeE's guard never inspected match.computed and edgeCriteria reads
// only the constant match.props. Validated by OUR tests — the corpus has no computed-mergeE scenario.
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
  "g.addV('person').property('name','marko')",
  "g.addV('person').property('name','vadas')",
  "g.V().has('name','marko').as('a').V().has('name','vadas').as('b').addE('knows').from('a').to('b').property('weight',5)",
];

describe('mergeE(__.project(k).by(body)) — correlated edge search (not yet built)', () => {
  test('a computed criterion that does NOT match must not silently match an existing edge', async () => {
    const s = store(modern);
    // weight=99 matches no edge; the correct answer is to create (or raise, absent endpoints), never to
    // return the existing weight=5 edge. Until the correlated search is built, it declines (fail closed).
    await expect(run(s, "g.V().has('name','marko').mergeE(__.project('weight').by(__.constant(99)))")).rejects.toThrow();
    // nothing was created, nothing matched by the ignored criterion
    expect(await run(s, "g.E().has('weight',99).count()")).toEqual([0]);
    expect(await run(s, 'g.E().count()')).toEqual([1]);
  });

  test('a computed criterion body reading the driver declines (fail closed)', async () => {
    const s = store(modern);
    await expect(run(s, "g.V().has('name','marko').outE('knows').mergeE(__.project('weight').by(__.constant(7)))")).rejects.toThrow();
  });
});
