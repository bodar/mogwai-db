// A WRITE inside a SINGLE-arm branch (union(__.mergeV(…)), union(__.addV(…)), union(__.property(…))) —
// the arm's effect bindings thread OUT through the branch merge to become program bindings, exactly as a
// top-level write's do. A single arm has no sibling to observe the mutation, so it is identical to a
// top-level write followed by its tail. Previously these emitted a malformed plan ("Ref not a Plan
// binding"); now they execute.
//
// A MULTI-arm branch (or choose/coalesce, always ≥2 arms) with a write DECLINES cleanly: effects run
// before the result query, so a sibling arm's read — a graph-global out()/values(), a mergeV/mergeE
// search, or its own re-snapshotted input — would observe the write and answer a post-write state the
// reference (per-traverser, arm-interleaved) does not. Fail closed, never a wrong answer.
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
const seed = [
  "g.addV('person').property('name','marko').property('age',29)",
  "g.addV('person').property('name','vadas').property('age',27)",
  "g.addE('knows').from(__.V().has('name','marko')).to(__.V().has('name','vadas')).property('weight',0.5)",
];

describe('a write inside a SINGLE-arm branch (works)', () => {
  test('union of a mergeV — matches, threads its effects', async () => {
    const s = store(seed);
    expect(await run(s, "g.V().has('name','marko').union(__.mergeV(__.project('name').by(__.values('name')))).values('name')")).toEqual(['marko']);
    expect(await run(s, 'g.V().count()')).toEqual([2]); // matched marko, created nothing
  });

  test('union of a mergeV create adds the vertex', async () => {
    const s = store(seed);
    expect(await run(s, "g.V().has('name','marko').union(__.mergeV(__.project('name').by(__.constant('kuzu')))).values('name')")).toEqual(['kuzu']);
    expect(await run(s, "g.V().has('name','kuzu').count()")).toEqual([1]);
    expect(await run(s, 'g.V().count()')).toEqual([3]);
  });

  test('union of addV writes and passes the new vertex on', async () => {
    const s = store(seed);
    expect(await run(s, "g.V().has('name','marko').union(__.addV('t')).count()")).toEqual([1]);
    expect(await run(s, 'g.V().count()')).toEqual([3]);
    expect(await run(s, "g.V().hasLabel('t').count()")).toEqual([1]);
  });

  test('union of property() mutates and passes through', async () => {
    const s = store(seed);
    expect(await run(s, "g.V().has('name','marko').union(__.property('seen',1)).values('seen')")).toEqual([1]);
    expect(await run(s, "g.V().has('name','marko').values('seen')")).toEqual([1]);
  });

  test('a union write composes with a further tail', async () => {
    const s = store(seed);
    expect(await run(s, "g.V().has('name','marko').union(__.property('seen',1)).both().count()")).toEqual([1]);
  });
});

describe('a write inside a SOURCE union (g.union(…)) — unconditionally correct', () => {
  // A source union has ONE start traverser, so arm-major order coincides with per-traverser order —
  // there is no sibling traverser whose writes an arm could observe out of order. So even MULTIPLE write
  // arms are correct here (unlike a chain-position multi-arm branch).
  test('single-arm source union of addE creates the edge', async () => {
    const s = store(seed.slice(0, 2)); // marko, vadas (no edge)
    expect(await run(s, "g.union(__.addE('knows').from(__.V().has('name','marko')).to(__.V().has('name','vadas'))).count()")).toEqual([1]);
    expect(await run(s, 'g.E().count()')).toEqual([1]);
  });

  test('multi-arm source union of three addV creates all three', async () => {
    const s = new GraphStore(new BunSqlite(':memory:'));
    expect((await run(s, "g.union(__.addV('person').property('name','alice'),__.addV('person').property('name','bob'),__.addV('person').property('name','chris')).values('name')")).sort())
      .toEqual(['alice', 'bob', 'chris']);
    expect(await run(s, 'g.V().count()')).toEqual([3]);
  });

  test('two source-union addV arms', async () => {
    const s = new GraphStore(new BunSqlite(':memory:'));
    expect(await run(s, "g.union(__.addV('a'),__.addV('b')).count()")).toEqual([2]);
    expect(await run(s, "g.V().hasLabel('a').count()")).toEqual([1]);
    expect(await run(s, "g.V().hasLabel('b').count()")).toEqual([1]);
  });
});

describe('a write inside a MULTI-arm CHAIN branch declines cleanly (fail closed)', () => {
  test('two write arms decline (would answer a post-write state)', async () => {
    const s = store(seed);
    await expect(run(s, "g.V().hasLabel('person').union(__.addV('a'),__.addV('b')).count()")).rejects.toThrow(/not supported/);
  });

  test('a write arm beside a read arm declines', async () => {
    const s = store(seed);
    await expect(run(s, "g.V().has('name','marko').union(__.property('x','y'),__.identity())")).rejects.toThrow(/not supported/);
  });

  test('choose with a write arm declines', async () => {
    const s = store(seed);
    await expect(run(s, "g.V().hasLabel('person').choose(__.has('age',29),__.property('big',1),__.property('big',0))")).rejects.toThrow(/not supported/);
  });

  test('coalesce with a write arm declines', async () => {
    const s = store(seed);
    await expect(run(s, "g.V().has('name','marko').coalesce(__.has('age',99),__.property('c',2))")).rejects.toThrow(/not supported/);
  });
});

describe('read-only branches are unchanged (regression)', () => {
  test('union of two reads', async () => {
    const s = store(seed);
    expect(await run(s, "g.V().has('name','marko').union(__.values('name'),__.values('age'))")).toEqual(['marko', 29]);
  });

  test('choose of two reads', async () => {
    const s = store(seed);
    expect(await run(s, "g.V().has('name','marko').choose(__.has('age',29),__.constant('yes'),__.constant('no'))")).toEqual(['yes']);
  });
});
