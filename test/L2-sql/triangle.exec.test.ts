import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';

// Triangle count + local clustering coefficient — triangleCount / localClusteringCoefficient,
// ONE-SHOT decorate barriers (a single undirected self-join, no BSP iteration). Both UNDIRECTED. Cases
// ported/matched against GDS's own tests (vendor/gds/.../triangle/, GPLv3 — re-expressed): a 5-clique
// gives every vertex 6 triangles and coefficient 1.0; a line gives 0.

const unmap = (v: any): any => v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, unmap(x)])) : v;
const run = async (store: ReturnType<typeof seeded>, gremlin: string): Promise<unknown[]> =>
  Promise.all((await exec(store).framedAsync(gremlin, {})).map((f) => decode(f.buf)));

// Undirected edges → seed both directions (the algorithm's `und` CTE also dedups, so this is belt+braces).
const seedOf = (nodes: readonly string[], edges: readonly (readonly [string, string])[]): readonly string[] => [
  ...nodes.map((n) => `g.addV('n').property('name','${n}')`),
  ...edges.flatMap(([s, t]) => [
    `g.V().has('name','${s}').addE('T').to(__.V().has('name','${t}'))`,
    `g.V().has('name','${t}').addE('T').to(__.V().has('name','${s}'))`,
  ]),
];

const by = async (store: ReturnType<typeof seeded>, call: string, key: string): Promise<Record<string, number>> =>
  Object.fromEntries(((await run(store, `g.V().call("${call}").project("name","${key}").by("name").by("${key}")`)).map(unmap) as any[])
    .map((r) => [r.name, r[key]]));

describe('triangleCount / localClusteringCoefficient', () => {
  test('5-clique: every vertex is in 6 triangles, coefficient 1.0 (GDS clique5)', async () => {
    const nodes = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const edges: [string, string][] = [];
    for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) edges.push([nodes[i], nodes[j]]);
    const seed = seedOf(nodes, edges);
    const tri = await by(seeded(seed), 'triangleCount', 'triangleCount');
    expect(Object.values(tri)).toEqual([6, 6, 6, 6, 6]);
    const lcc = await by(seeded(seed), 'localClusteringCoefficient', 'localClusteringCoefficient');
    for (const v of nodes) expect(lcc[v]).toBeCloseTo(1.0, 10);
  });

  test('a line a-b-c has no triangles → all 0, coefficient 0', async () => {
    const seed = seedOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
    expect(Object.values(await by(seeded(seed), 'triangleCount', 'triangleCount'))).toEqual([0, 0, 0]);
    expect(Object.values(await by(seeded(seed), 'localClusteringCoefficient', 'localClusteringCoefficient'))).toEqual([0, 0, 0]);
  });

  test('triangle {a,b,c} + pendant a-d separates count from coefficient', async () => {
    // a: 1 triangle, degree 3 → LCC 2·1/(3·2)=1/3. b,c: 1 triangle, degree 2 → LCC 1. d: 0, degree 1 → 0.
    const seed = seedOf(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'a'], ['a', 'd']]);
    expect(await by(seeded(seed), 'triangleCount', 'triangleCount')).toEqual({ a: 1, b: 1, c: 1, d: 0 });
    const lcc = await by(seeded(seed), 'localClusteringCoefficient', 'localClusteringCoefficient');
    expect(lcc.a).toBeCloseTo(1 / 3, 10);
    expect(lcc.b).toBeCloseTo(1, 10);
    expect(lcc.c).toBeCloseTo(1, 10);
    expect(lcc.d).toBe(0);
  });

  test('every vertex decorated; order().by(triangleCount) composes', async () => {
    const seed = seedOf(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'a'], ['a', 'd']]);
    const store = seeded(seed);
    expect(await run(store, `g.V().call("triangleCount").has("triangleCount").count()`)).toEqual([4]);
    // a/b/c all have 1 triangle, so tiebreak by name for a determinate top (else the window is arbitrary).
    expect(await run(store, `g.V().call("triangleCount").order().by("triangleCount", Order.desc).by("name").limit(1).values("name")`))
      .toEqual(['a']);
  });
});
