import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';

// shortestPath() (mogwai.shortestPath) — Template B: a single recursive-CTE enumerating every simple
// path, keeping the shortest per (source, target) with all ties, landed in the path channel. It is a
// PURE `rel` contribution (no barrier). These mirror the reference ShortestPath.feature scenarios that
// the UNWEIGHTED family covers: the default bothE scope, the Direction.IN / __.outE() overrides,
// includeEdges, and the unweighted maxDistance hop cap. Weighted distance, a label-scoped edges
// traversal and a target filter fail closed until their increments land.

const run = async (store: ReturnType<typeof seeded>, gremlin: string): Promise<any[]> =>
  Promise.all((await exec(store).framedAsync(gremlin, {})).map((f) => decode(f.buf)));

/** A path object → the name (or value) at each position, edges dropped. */
const nameOf = (o: any): string => o?.properties?.find((p: any) => p.key === 'name')?.value ?? String(o?.value ?? o?.id);
const isEdge = (o: any): boolean => o?.inV !== undefined && o?.outV !== undefined;
const vseq = (path: any): string => (path.objects ?? path).filter((o: any) => !isEdge(o)).map(nameOf).join(',');
const seqs = (rows: any[]): string[] => rows.map(vseq).sort();

// The 36 shortest paths of the modern graph under the default (undirected) scope — ShortestPath.feature
// `g_V_shortestPath`, as comma-joined name sequences.
const DEFAULT_36 = [
  'josh', 'josh,lop', 'josh,lop,peter', 'josh,marko', 'josh,marko,vadas', 'josh,ripple',
  'lop', 'lop,josh', 'lop,josh,ripple', 'lop,marko', 'lop,marko,vadas', 'lop,peter',
  'marko', 'marko,josh', 'marko,josh,ripple', 'marko,lop', 'marko,lop,peter', 'marko,vadas',
  'peter', 'peter,lop', 'peter,lop,josh', 'peter,lop,josh,ripple', 'peter,lop,marko', 'peter,lop,marko,vadas',
  'ripple', 'ripple,josh', 'ripple,josh,lop', 'ripple,josh,lop,peter', 'ripple,josh,marko', 'ripple,josh,marko,vadas',
  'vadas', 'vadas,marko', 'vadas,marko,josh', 'vadas,marko,josh,ripple', 'vadas,marko,lop', 'vadas,marko,lop,peter',
].sort();

describe('shortestPath() — mogwai.shortestPath recursive-CTE (unweighted)', () => {
  test('g_V_shortestPath — all-pairs shortest paths, default bothE scope', async () => {
    const store = seeded(MODERN_SEED);
    expect(seqs(await run(store, `g.V().shortestPath()`))).toEqual(DEFAULT_36);
  });

  test('g_V_both_dedup_shortestPath — the prefix is the source set, same paths', async () => {
    const store = seeded(MODERN_SEED);
    expect(seqs(await run(store, `g.V().both().dedup().shortestPath()`))).toEqual(DEFAULT_36);
  });

  test('g_V_hasXname_markoX_shortestPath — a single source', async () => {
    const store = seeded(MODERN_SEED);
    expect(seqs(await run(store, `g.V().has("name","marko").shortestPath()`)))
      .toEqual(['marko', 'marko,josh', 'marko,josh,ripple', 'marko,lop', 'marko,lop,peter', 'marko,vadas'].sort());
  });

  test('g_V_shortestPath_directionXINX — Direction.IN', async () => {
    const store = seeded(MODERN_SEED);
    expect(seqs(await run(store, `g.V().shortestPath().with("~tinkerpop.shortestPath.edges", Direction.IN)`)))
      .toEqual(['josh', 'josh,marko', 'lop', 'lop,josh', 'lop,marko', 'lop,peter', 'marko', 'peter',
        'ripple', 'ripple,josh', 'ripple,josh,marko', 'vadas', 'vadas,marko'].sort());
  });

  test('g_V_shortestPath_edgesXoutEX — __.outE()', async () => {
    const store = seeded(MODERN_SEED);
    expect(seqs(await run(store, `g.V().shortestPath().with("~tinkerpop.shortestPath.edges", __.outE())`)))
      .toEqual(['josh', 'josh,lop', 'josh,ripple', 'lop', 'marko', 'marko,josh', 'marko,josh,ripple',
        'marko,lop', 'marko,vadas', 'peter', 'peter,lop', 'ripple', 'vadas'].sort());
  });

  test('g_V_hasXname_markoX_shortestPath_maxDistanceX1X — an unweighted hop cap', async () => {
    const store = seeded(MODERN_SEED);
    expect(seqs(await run(store, `g.V().has("name","marko").shortestPath().with("~tinkerpop.shortestPath.maxDistance", 1)`)))
      .toEqual(['marko', 'marko,josh', 'marko,lop', 'marko,vadas'].sort());
  });

  test('g_V_shortestPath_edgesIncluded — the traversed edges interleave the vertices', async () => {
    const store = seeded(MODERN_SEED);
    const rows = await run(store, `g.V().shortestPath().with("~tinkerpop.shortestPath.includeEdges")`);
    // Same 36 shortest paths (edges dropped), and every path alternates v,e,v,…,v.
    expect(seqs(rows)).toEqual(DEFAULT_36);
    for (const path of rows) {
      const objs = path.objects ?? path;
      for (let i = 0; i < objs.length; i++) expect(isEdge(objs[i])).toBe(i % 2 === 1);
    }
  });

  test('fail closed: a weighted distance is not supported yet', async () => {
    const store = seeded(MODERN_SEED);
    await expect(exec(store).framedAsync(
      `g.V().has("name","marko").shortestPath().with("~tinkerpop.shortestPath.distance", "weight")`, {}))
      .rejects.toThrow('weighted distance');
  });

  test('fail closed: a target filter is not supported yet', async () => {
    const store = seeded(MODERN_SEED);
    await expect(exec(store).framedAsync(
      `g.V().shortestPath().with("~tinkerpop.shortestPath.target", __.has("name","marko"))`, {}))
      .rejects.toThrow('target filter');
  });
});
