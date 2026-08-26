import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';

// k-core decomposition — kcore, a BSP fixpoint decorate barrier. Coreness via the Montresor
// distributed h-index update (converges to the same value GDS's peeling computes). Graph + expected
// values PORTED from GDS's own KCoreDecompositionTest (vendor/gds/.../kcore/, GPLv3 — re-expressed):
// an isolated z (0), a tail a-b (1) feeding a 6-cycle c-d-e-f-g-h (2).

const unmap = (v: any): any => v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, unmap(x)])) : v;
const run = async (store: ReturnType<typeof seeded>, gremlin: string): Promise<unknown[]> =>
  Promise.all((await exec(store).framedAsync(gremlin, {})).map((f) => decode(f.buf)));

const seedOf = (nodes: readonly string[], edges: readonly (readonly [string, string])[]): readonly string[] => [
  ...nodes.map((n) => `g.addV('n').property('name','${n}')`),
  ...edges.flatMap(([s, t]) => [
    `g.V().has('name','${s}').addE('R').to(__.V().has('name','${t}'))`,
    `g.V().has('name','${t}').addE('R').to(__.V().has('name','${s}'))`,
  ]),
];

describe('kcore — coreness (h-index fixpoint)', () => {
  test('GDS graph: z=0, a=1, b=1, c..h=2', async () => {
    const seed = seedOf(
      ['z', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['f', 'g'], ['g', 'h'], ['h', 'c']],
    );
    const core = Object.fromEntries(((await run(seeded(seed),
      `g.V().call("kcore").project("name","coreValue").by("name").by("coreValue")`)).map(unmap) as any[])
      .map((r) => [r.name, r.coreValue]));
    expect(core).toEqual({ z: 0, a: 1, b: 1, c: 2, d: 2, e: 2, f: 2, g: 2, h: 2 });
  });

  test('a 4-clique is a 3-core (every vertex coreness 3); a pendant is 1', async () => {
    const clique: [string, string][] = [];
    const cs = ['a', 'b', 'c', 'd'];
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) clique.push([cs[i], cs[j]]);
    const seed = seedOf(['a', 'b', 'c', 'd', 'p'], [...clique, ['a', 'p']]);
    const core = Object.fromEntries(((await run(seeded(seed),
      `g.V().call("kcore").project("name","coreValue").by("name").by("coreValue")`)).map(unmap) as any[])
      .map((r) => [r.name, r.coreValue]));
    expect(core).toEqual({ a: 3, b: 3, c: 3, d: 3, p: 1 });
  });

  test('every vertex decorated; order().by(coreValue) composes', async () => {
    // A 3-clique {x,y,z} (coreness 2 each) + a pendant p (1). Top by coreValue is a clique member;
    // name-asc tiebreak makes it x.
    const seed = seedOf(['x', 'y', 'z', 'p'], [['x', 'y'], ['y', 'z'], ['z', 'x'], ['x', 'p']]);
    const store = seeded(seed);
    expect(await run(store, `g.V().call("kcore").has("coreValue").count()`)).toEqual([4]);
    expect(await run(store, `g.V().call("kcore").order().by("coreValue", Order.desc).by("name").limit(1).values("name")`))
      .toEqual(['x']);
  });
});
