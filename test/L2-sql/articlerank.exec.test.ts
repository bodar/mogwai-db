import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';

// ArticleRank — articleRank, a MULTI-CHANNEL BSP decorate barrier (rank = channel 0, per-round
// delta = channel 1). A PageRank variant that damps influence by (out-degree + average degree). Graphs +
// EXACT expected ranks PORTED from GDS's own PageRankTest.ArticleRank (vendor/gds/.../pagerank/, GPLv3 —
// re-expressed), run with the same config the test uses: dampingFactor 0.85, tolerance 0, run to
// maxIterations. GDS asserts within 1e-5, which we mirror. Isolated nodes stay at alpha = 1 − damping =
// 0.15 (no incoming rank), which pins alpha and the seed.

const unmap = (v: any): any => v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, unmap(x)])) : v;
const run = async (store: ReturnType<typeof seeded>, gremlin: string): Promise<unknown[]> =>
  Promise.all((await exec(store).framedAsync(gremlin, {})).map((f) => decode(f.buf)));

// DIRECTED edges — ArticleRank flows rank along out-edges (one addE per edge, direction respected).
const seedOf = (nodes: readonly string[], edges: readonly (readonly [string, string])[]): readonly string[] => [
  ...nodes.map((n) => `g.addV('n').property('name','${n}')`),
  ...edges.map(([s, t]) => `g.V().has('name','${s}').addE('R').to(__.V().has('name','${t}'))`),
];

const ranksOf = async (store: ReturnType<typeof seeded>, maxIterations: number): Promise<Record<string, number>> =>
  Object.fromEntries(((await run(store,
    `g.V().call("articleRank", ["maxIterations": ${maxIterations}, "tolerance": 0, "dampingFactor": 0.85])`
    + `.project("name","articleRank").by("name").by("articleRank")`)).map(unmap) as any[])
    .map((r) => [r.name, r.articleRank]));

const expectRanks = (got: Record<string, number>, expected: Record<string, number>): void => {
  for (const [k, v] of Object.entries(expected)) expect(Math.abs(got[k] - v)).toBeLessThanOrEqual(1e-5);
};

describe('articleRank — GDS ArticleRankComputation (delta accumulation)', () => {
  test('GDS 10-node graph: exact ranks, isolated g..j stay at alpha=0.15', async () => {
    const seed = seedOf(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      [['b', 'c'], ['c', 'b'], ['d', 'a'], ['d', 'b'], ['e', 'b'], ['e', 'd'], ['e', 'f'], ['f', 'b'], ['f', 'e']],
    );
    expectRanks(await ranksOf(seeded(seed), 40), {
      a: 0.20720, b: 0.47091, c: 0.36067, d: 0.19515, e: 0.20720, f: 0.19515,
      g: 0.15, h: 0.15, i: 0.15, j: 0.15,
    });
  });

  test('GDS paper graph: exact ranks (7 nodes, maxIterations 20)', async () => {
    const seed = seedOf(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      [['b', 'a'], ['c', 'a'], ['c', 'b'], ['d', 'a'], ['d', 'b'], ['d', 'c'],
       ['e', 'a'], ['e', 'b'], ['e', 'c'], ['e', 'd'], ['f', 'b'], ['f', 'e'], ['g', 'b'], ['g', 'e']],
    );
    expectRanks(await ranksOf(seeded(seed), 20), {
      a: 0.34627, b: 0.31950, c: 0.21092, d: 0.18028, e: 0.21375, f: 0.15000, g: 0.15000,
    });
  });

  test('every vertex decorated; has()/order().by(articleRank) compose over the stream', async () => {
    const seed = seedOf(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'a'], ['a', 'd']]);
    const store = seeded(seed);
    expect(await run(store, `g.V().call("articleRank").has("articleRank").count()`)).toEqual([4]);
    // d is a pure sink fed only by a; b/c/d/a form a small cycle+pendant. Just assert order() composes and
    // returns all four vertices ranked (values are graph-specific; the exact-value graphs above pin them).
    const ordered = await run(store, `g.V().call("articleRank").order().by("articleRank").by("name").values("name")`);
    expect(new Set(ordered)).toEqual(new Set(['a', 'b', 'c', 'd']));
  });
});
