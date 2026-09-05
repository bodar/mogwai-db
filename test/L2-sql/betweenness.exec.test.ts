import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';

// Betweenness centrality (Brandes) — betweenness. The first barrier that is BOTH multi-source
// (scope = source vertex) AND keep-all-rounds (round = BFS level, walked in reverse for the dependency
// pass). DIRECTED (GDS default orientation). Graphs + expected values PORTED from GDS's own
// BetweennessCentralityTest full-selection cases (vendor/gds/.../betweenness/, GPLv3 — re-expressed).

const unmap = (v: any): any => v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, unmap(x)])) : v;
const run = async (store: ReturnType<typeof seeded>, gremlin: string): Promise<unknown[]> =>
  Promise.all((await exec(store).framedAsync(gremlin, {})).map((f) => decode(f.buf)));

// DIRECTED edges (betweenness follows out-edges), one direction only.
const seedD = (nodes: readonly string[], edges: readonly (readonly [string, string])[]): readonly string[] => [
  ...nodes.map((n) => `g.addV('n').property('name','${n}')`),
  ...edges.map(([s, t]) => `g.V().has('name','${s}').addE('R').to(__.V().has('name','${t}'))`),
];

const scores = async (seed: readonly string[]): Promise<Record<string, number>> =>
  Object.fromEntries(((await run(seeded(seed),
    `g.V().call("betweenness").project("name","betweenness").by("name").by("betweenness")`)).map(unmap) as any[])
    .map((r) => [r.name, r.betweenness]));

const near = (got: Record<string, number>, want: Record<string, number>) => {
  for (const [k, v] of Object.entries(want)) expect(got[k]).toBeCloseTo(v, 10);
};

describe('betweenness — Brandes (directed, full source set)', () => {
  test('line a→b→c→d→e', async () => {
    near(await scores(seedD(['a', 'b', 'c', 'd', 'e'], [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']])),
      { a: 0, b: 3, c: 4, d: 3, e: 0 });
  });

  test('directed 3-cycle a→b→c→a', async () => {
    near(await scores(seedD(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']])), { a: 1, b: 1, c: 1 });
  });

  test('diamond with a shared sink (σ splits then rejoins at e)', async () => {
    near(await scores(seedD(['a1', 'a2', 'b', 'c', 'd', 'e', 'f'],
      [['a1', 'b'], ['a2', 'b'], ['b', 'c'], ['b', 'd'], ['c', 'e'], ['d', 'e'], ['e', 'f']])),
      { a1: 0, a2: 0, b: 8, c: 3, d: 3, e: 5, f: 0 });
  });

  test('two 3-cycles joined by a↔d', async () => {
    // GDS CONNECTED_CYCLES: a→b→c→a, d→e→f→d, plus a→d and d→a.
    near(await scores(seedD(['a', 'b', 'c', 'd', 'e', 'f'],
      [['a', 'b'], ['b', 'c'], ['c', 'a'], ['d', 'e'], ['e', 'f'], ['f', 'd'], ['a', 'd'], ['d', 'a']])),
      { a: 13, b: 4, c: 4, d: 13, e: 4, f: 4 });
  });

  test('a 5-clique has zero betweenness (every pair is adjacent)', async () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'];
    const edges: [string, string][] = [];
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) if (i !== j) edges.push([nodes[i], nodes[j]]);
    near(await scores(seedD(nodes, edges)), { a: 0, b: 0, c: 0, d: 0, e: 0 });
  });

  test('a label-scoped edges restricts the paths (edge scope, gained by the adjacencyCte dedup)', async () => {
    const seed = [
      `g.addV('n').property('name','a')`, `g.addV('n').property('name','b')`, `g.addV('n').property('name','c')`,
      `g.V().has('name','a').addE('R').to(__.V().has('name','b'))`,
      `g.V().has('name','b').addE('R').to(__.V().has('name','c'))`,
      `g.V().has('name','a').addE('S').to(__.V().has('name','c'))`, // a shortcut on a DIFFERENT label
    ];
    const bOf = async (edges: string): Promise<number> => ((await run(seeded(seed),
      `g.V().call("betweenness")${edges}.project("name","betweenness").by("name").by("betweenness")`)).map(unmap) as any[])
      .find((r) => r.name === 'b').betweenness;
    // All labels: a→c takes the direct S shortcut, so b is on no shortest path.
    expect(await bOf('')).toBe(0);
    // Scoped to R: a→c must go a→b→c, so b sits on the only shortest path.
    expect(await bOf('.with("~tinkerpop.betweenness.edges", __.outE("R"))')).toBe(1);
  });

  test('an undirected (bothE) edge scope fails closed — directed only (undirected halving unimplemented)', async () => {
    const seed = seedD(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
    await expect(exec(seeded(seed)).framedAsync(
      `g.V().call("betweenness").with("~tinkerpop.betweenness.edges", __.bothE()).has("betweenness")`, {}))
      .rejects.toThrow('directed');
  });

  test('every vertex decorated; order().by(betweenness) composes', async () => {
    const seed = seedD(['a', 'b', 'c', 'd', 'e'], [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']]);
    const store = seeded(seed);
    expect(await run(store, `g.V().call("betweenness").has("betweenness").count()`)).toEqual([5]);
    expect(await run(store, `g.V().call("betweenness").order().by("betweenness", Order.desc).limit(1).values("name")`))
      .toEqual(['c']);
  });
});
