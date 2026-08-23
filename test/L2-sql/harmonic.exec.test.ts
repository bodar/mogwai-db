import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';

// Harmonic centrality — mogwai.harmonic, closeness's sibling on the SAME scope-keyed distance relaxation
// (they share `distanceCentrality`). harmonic[v] = (Σ 1/dist(u→v) over reaching u) / (N−1) — GDS
// HarmonicCentrality. Unlike closeness it sums RECIPROCAL distances, so an unreached pair contributes 0
// (not ∞), and normalises by the TOTAL node count − 1 (a disconnected node lowers the score).
//
// Graph + expected values PORTED from GDS's own test (vendor/gds/.../harmonic/HarmonicCentralityTest.java,
// GPLv3 — re-expressed): UNDIRECTED a-b-c and d-e, N=5 → a=0.375, b=0.5, c=0.375, d=0.25, e=0.25.

const unmap = (v: any): any => v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, unmap(x)])) : v;
const run = async (store: ReturnType<typeof seeded>, gremlin: string): Promise<unknown[]> =>
  Promise.all((await exec(store).framedAsync(gremlin, {})).map((f) => decode(f.buf)));

// UNDIRECTED edges → seed both directions (our relaxation is directed, so in ≡ out ≡ both when symmetric).
const UNDIRECTED: readonly (readonly [string, string])[] = [['a', 'b'], ['b', 'c'], ['d', 'e']];
const HARMONIC_SEED: readonly string[] = [
  ...['a', 'b', 'c', 'd', 'e'].map((n) => `g.addV('Node').property('name','${n}')`),
  ...UNDIRECTED.flatMap(([s, t]) => [
    `g.V().has('name','${s}').addE('TYPE').to(__.V().has('name','${t}'))`,
    `g.V().has('name','${t}').addE('TYPE').to(__.V().has('name','${s}'))`,
  ]),
];

describe('mogwai.harmonic — harmonic centrality (shares closeness distance substrate)', () => {
  test('matches GDS (a=0.375, b=0.5, c=0.375, d=0.25, e=0.25)', async () => {
    const s = Object.fromEntries(((await run(seeded(HARMONIC_SEED),
      `g.V().call("mogwai.harmonic").project("name","harmonic").by("name").by("harmonic")`)).map(unmap) as any[])
      .map((r) => [r.name, r.harmonic]));
    expect(s.a).toBeCloseTo(0.375, 10);
    expect(s.b).toBeCloseTo(0.5, 10);
    expect(s.c).toBeCloseTo(0.375, 10);
    expect(s.d).toBeCloseTo(0.25, 10);
    expect(s.e).toBeCloseTo(0.25, 10);
  });

  test('every vertex decorated; b (path centre) is the most harmonic-central', async () => {
    const store = seeded(HARMONIC_SEED);
    expect(await run(store, `g.V().call("mogwai.harmonic").has("harmonic").count()`)).toEqual([5]);
    expect(await run(store, `g.V().call("mogwai.harmonic").order().by("harmonic", Order.desc).limit(1).values("name")`))
      .toEqual(['b']);
  });
});
