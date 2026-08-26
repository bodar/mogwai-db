import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';

// Closeness centrality — closeness, a scope-keyed DECORATE barrier reusing relaxShortestPath's
// per-source distances (scope = source). closeness[v] = reached[v] / farness[v], farness = Σ dist(u→v)
// over reaching u (GDS DefaultCentralityComputer). IN direction (the algorithm's own — see below).
//
// Both graphs + expected values PORTED from GDS's own tests (vendor/gds/.../closeness/, GPLv3 —
// re-expressed): ClosenessCentralityTest (symmetric path) and ClosenessCentralityDirectedTest (the one
// that PROVES the IN direction — a=2/3,b=1,c=0 only reproduce with reverse-edge BFS).

const unmap = (v: any): any => v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, unmap(x)])) : v;
const run = async (store: ReturnType<typeof seeded>, gremlin: string): Promise<unknown[]> =>
  Promise.all((await exec(store).framedAsync(gremlin, {})).map((f) => decode(f.buf)));

const seedOf = (nodes: readonly string[], edges: readonly (readonly [string, string])[]): readonly string[] => [
  ...nodes.map((n) => `g.addV('Node').property('name','${n}')`),
  ...edges.map(([s, t]) => `g.V().has('name','${s}').addE('TYPE').to(__.V().has('name','${t}'))`),
];

const scoresByName = async (store: ReturnType<typeof seeded>): Promise<Record<string, number>> =>
  Object.fromEntries(((await run(store,
    `g.V().call("closeness").project("name","closeness").by("name").by("closeness")`)).map(unmap) as any[])
    .map((r) => [r.name, r.closeness]));

describe('closeness — closeness centrality (scope-keyed barrier)', () => {
  test('symmetric path a<->b<->c<->d<->e matches GDS (0.4 / 0.571 / 0.667 / 0.571 / 0.4)', async () => {
    // Bidirectional edges, so in ≡ out; farness sums are 10/7/6/7/10 over N-1=4 reached.
    const EDGES: [string, string][] = [
      ['a', 'b'], ['b', 'a'], ['b', 'c'], ['c', 'b'], ['c', 'd'], ['d', 'c'], ['d', 'e'], ['e', 'd'],
    ];
    const s = await scoresByName(seeded(seedOf(['a', 'b', 'c', 'd', 'e'], EDGES)));
    expect(s.a).toBeCloseTo(0.4, 2);
    expect(s.b).toBeCloseTo(0.571, 2);
    expect(s.c).toBeCloseTo(0.667, 2);
    expect(s.d).toBeCloseTo(0.571, 2);
    expect(s.e).toBeCloseTo(0.4, 2);
  });

  test('directed graph matches GDS — the IN direction (a=2/3, b=1, c=0, d=2/3, e=1, f=0)', async () => {
    // a<->b, c->b, d<->e, f->e. c and f are pure sources (nothing reaches them) → farness 0 → closeness 0.
    const EDGES: [string, string][] = [
      ['a', 'b'], ['b', 'a'], ['c', 'b'], ['d', 'e'], ['e', 'd'], ['f', 'e'],
    ];
    const s = await scoresByName(seeded(seedOf(['a', 'b', 'c', 'd', 'e', 'f'], EDGES)));
    expect(s.a).toBeCloseTo(2 / 3, 10);
    expect(s.b).toBeCloseTo(1, 10);
    expect(s.c).toBe(0);
    expect(s.d).toBeCloseTo(2 / 3, 10);
    expect(s.e).toBeCloseTo(1, 10);
    expect(s.f).toBe(0);
  });

  test('every vertex is decorated (has(closeness) passes all) and order().by composes', async () => {
    const EDGES: [string, string][] = [['a', 'b'], ['b', 'a'], ['b', 'c'], ['c', 'b'], ['c', 'd'], ['d', 'c'], ['d', 'e'], ['e', 'd']];
    const store = seeded(seedOf(['a', 'b', 'c', 'd', 'e'], EDGES));
    expect(await run(store, `g.V().call("closeness").has("closeness").count()`)).toEqual([5]);
    // c is the most central (middle of the path) → sorts first descending.
    expect(await run(store, `g.V().call("closeness").order().by("closeness", Order.desc).limit(1).values("name")`))
      .toEqual(['c']);
  });
});
