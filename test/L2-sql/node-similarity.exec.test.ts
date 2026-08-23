import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';

// Node similarity (Jaccard over out-neighbour sets) — mogwai.nodeSimilarity, the first PAIR-OUTPUT
// barrier: `g.call("mogwai.nodeSimilarity")` returns a stream of `{node1, node2, similarity}` MAPS, not a
// per-vertex decoration. A new barrier output arm (pairSegment → lowerPairResume → the mapValue wire
// form). Metric matches GDS's default (Jaccard of out-neighbour sets, pairs with similarity > 0).

const unmap = (v: any): any => v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, unmap(x)])) : v;
const run = async (store: ReturnType<typeof seeded>, gremlin: string): Promise<unknown[]> =>
  Promise.all((await exec(store).framedAsync(gremlin, {})).map((f) => decode(f.buf)));

// Vertices are inserted in order, so rowids are 1..N: a=1, b=2, c=3, d=4, x=5, y=6.
const SEED: readonly string[] = [
  ...['a', 'b', 'c', 'd', 'x', 'y'].map((n) => `g.addV('n').property('name','${n}')`),
  ...([['a', 'x'], ['a', 'y'], ['b', 'x'], ['b', 'y'], ['c', 'x'], ['d', 'y']] as [string, string][])
    .map(([s, t]) => `g.V().has('name','${s}').addE('R').to(__.V().has('name','${t}'))`),
];
const ID = { a: 1, b: 2, c: 3, d: 4 };

describe('mogwai.nodeSimilarity — Jaccard pairs, a stream of {node1,node2,similarity} maps', () => {
  test('returns scored pairs as maps (the new pair-output shape)', async () => {
    const rows = (await run(seeded(SEED), `g.call("mogwai.nodeSimilarity")`)).map(unmap) as any[];
    // Every row is a 3-key map with two node ids and a similarity.
    for (const r of rows) {
      expect(new Set(Object.keys(r))).toEqual(new Set(['node1', 'node2', 'similarity']));
      expect(typeof r.similarity).toBe('number');
    }
    const sim: Record<string, number> = {};
    for (const r of rows) sim[`${r.node1},${r.node2}`] = r.similarity;
    // N(a)=N(b)={x,y} → 1; a/b vs c ({x}) or d ({y}) → 1/2; c vs d share nothing → NO pair.
    expect(sim[`${ID.a},${ID.b}`]).toBeCloseTo(1, 10);
    expect(sim[`${ID.b},${ID.a}`]).toBeCloseTo(1, 10);
    expect(sim[`${ID.a},${ID.c}`]).toBeCloseTo(0.5, 10);
    expect(sim[`${ID.a},${ID.d}`]).toBeCloseTo(0.5, 10);
    expect(sim[`${ID.b},${ID.c}`]).toBeCloseTo(0.5, 10);
    expect(sim[`${ID.c},${ID.d}`]).toBeUndefined(); // disjoint neighbours → omitted
    expect(rows.length).toBe(10); // (a,b),(a,c),(a,d),(b,c),(b,d) × both directions
  });

  test('a shared-neighbour clique gives similarity 1 between all sources', async () => {
    // p,q,r all point to the same single target t → pairwise Jaccard 1.
    const seed = [
      ...['p', 'q', 'r', 't'].map((n) => `g.addV('n').property('name','${n}')`),
      ...['p', 'q', 'r'].map((s) => `g.V().has('name','${s}').addE('R').to(__.V().has('name','t'))`),
    ];
    const rows = (await run(seeded(seed), `g.call("mogwai.nodeSimilarity")`)).map(unmap) as any[];
    expect(rows.length).toBe(6); // 3 sources × 2 others
    for (const r of rows) expect(r.similarity).toBeCloseTo(1, 10);
  });

  test('a graph with no shared neighbours yields no pairs', async () => {
    const seed = [
      ...['a', 'b', 'x', 'y'].map((n) => `g.addV('n').property('name','${n}')`),
      `g.V().has('name','a').addE('R').to(__.V().has('name','x'))`,
      `g.V().has('name','b').addE('R').to(__.V().has('name','y'))`,
    ];
    expect((await run(seeded(seed), `g.call("mogwai.nodeSimilarity")`)).length).toBe(0);
  });
});
