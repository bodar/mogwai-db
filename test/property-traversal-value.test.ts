// Correlated per-incoming-row write-argument resolver — increment 1: property(k, __.trav) VALUE.
//
// A property() whose value is a nested traversal not foldable to a constant resolves the body PER
// incoming traverser (correlated to the owner row) via ChildSeam.rows, matching
// AddPropertyStep.handleTraversalValue (vendor/tinkerpop/.../AddPropertyStep.java:127-200):
//   - 0 results  → skip the mutation, element passes through
//   - >1 under single (declared/default) → raise
//   - list/set   → write each result
//   - else       → the one value
// Validated by OUR tests: the TinkerPop corpus has no traversal-valued property() scenario.
import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { executeQuery, executeFramed } from './support/executor.ts';
import { streamBuffers } from '../src/http.ts';
import { ioc } from '../src/io.ts';

async function values(gremlin: string, writes: string[]): Promise<any[]> {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const w of writes) executeQuery(store, w, {});
  const buffers = await executeFramed(store, gremlin, {});
  const res = streamBuffers(buffers, 64);
  const reader = res.body!.getReader();
  const chunks: Buffer[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
  const parsed = await (ioc as any).graphBinaryReader.readResponse(Buffer.concat(chunks));
  expect(parsed.status.code).toBe(200);
  return parsed.result.data;
}

describe('property(k, __.trav) — correlated per-row value', () => {
  test('copies a per-vertex property value: property("copy", __.values("name"))', async () => {
    const out = await values("g.V().property('copy', __.values('name')).values('copy')", [
      "g.addV('p').property('name', 'marko')",
      "g.addV('p').property('name', 'josh')",
    ]);
    expect(out.sort()).toEqual(['josh', 'marko']);
  });

  test('a per-vertex computed value is correlated, not global', async () => {
    // each vertex gets ITS OWN age back under 'age2' — not one shared value.
    const out = await values("g.V().property('age2', __.values('age')).values('age2')", [
      "g.addV('p').property('age', 29)",
      "g.addV('p').property('age', 35)",
    ]);
    expect(out.map(Number).sort((a, b) => a - b)).toEqual([29, 35]);
  });

  test('0 results → skip: the mutation is absent, the vertex passes through', async () => {
    // 'missing' is not present on either vertex, so __.values('missing') yields nothing → no write.
    const out = await values("g.V().property('copy', __.values('missing')).values('copy')", [
      "g.addV('p').property('name', 'marko')",
    ]);
    expect(out).toEqual([]);
    // the vertex itself still passes through the step
    const passed = await values("g.V().property('copy', __.values('missing')).values('name')", [
      "g.addV('p').property('name', 'marko')",
    ]);
    expect(passed).toEqual(['marko']);
  });

  // marko knows vadas + josh — a two-result value body under a single vertex.
  const twoKnows = [
    "g.addV('p').property('name', 'marko')",
    "g.addV('p').property('name', 'vadas')",
    "g.addV('p').property('name', 'josh')",
    "g.V().has('name','marko').addE('knows').to(__.V().has('name','vadas'))",
    "g.V().has('name','marko').addE('knows').to(__.V().has('name','josh'))",
  ];

  test('>1 result under EXPLICIT single cardinality RAISES (fail-closed, not a silent first)', async () => {
    // The graph default is `list` (api.ts, matching Graph.java:672), so the raise needs an explicit
    // single. A single-cardinality value from a multi-result traversal is the reference's raise
    // (AddPropertyStep.java:178-182), never a silent take-first.
    await expect(values("g.V().has('name','marko').property(Cardinality.single, 'x', __.out('knows').values('name'))", twoKnows)).rejects.toThrow();
  });

  test('default cardinality (list) appends every result — no raise', async () => {
    const out = await values("g.V().has('name','marko').property('x', __.out('knows').values('name')).values('x')", twoKnows);
    expect(out.sort()).toEqual(['josh', 'vadas']);
  });

  test('list cardinality writes EACH result', async () => {
    const out = await values("g.V().has('name','marko').property(Cardinality.list, 'friends', __.out('knows').values('name')).values('friends')", twoKnows);
    expect(out.sort()).toEqual(['josh', 'vadas']);
  });

  test('a REDUCER value (count) resolves per owner via the child.scalar fallback', async () => {
    // __.out('knows').count() is a reducing barrier — child.rows declines it (loses origin), so it
    // resolves through child.scalar: one value per owner, correlated. marko→2, vadas/josh→0 (count is
    // always productive, so every vertex gets a deg).
    const out = await values("g.V().property('deg', __.out('knows').count()).values('deg')", twoKnows);
    expect(out.map(Number).sort((a, b) => a - b)).toEqual([0, 0, 2]);
  });

  test('the post-write FTS refresh indexes a runtime-written value', () => {
    // A runtime value is not indexed in the compiled plan; the refresh derives its property_fts rows
    // from the stored tree. Asserted at the index directly (a store-level check), like fts-index.test.
    const store = new GraphStore(new BunSqlite(':memory:'));
    for (const w of ["g.addV('p').property('name', 'marko')", "g.addV('p').property('name', 'josh')"]) executeQuery(store, w, {});
    executeQuery(store, "g.V().property('copy', __.values('name'))", {});
    const copyRows = store.query<{ text: string }>("SELECT text FROM property_fts WHERE pk='copy' AND kind='value' ORDER BY text");
    expect(copyRows.map((r) => r.text)).toEqual(['josh', 'marko']);
    // and it did not double-index the constant 'name' rows (one each, not two).
    const nameRows = store.query<{ n: number }>("SELECT count(*) AS n FROM property_fts WHERE pk='name' AND kind='value'");
    expect(nameRows[0]!.n).toBe(2);
  });
});
