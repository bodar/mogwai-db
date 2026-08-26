import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';

// Strongly connected components — scc, a ONE-SHOT decorate barrier over the DIRECTED graph. Two
// vertices share a component iff they are mutually reachable (u→…→v AND v→…→u), computed as a directed
// transitive-closure CTE. Graph + partition PORTED from GDS's own SccTest
// (vendor/gds/algo/src/test/java/org/neo4j/gds/scc/SccTest.java, GPLv3 — re-expressed): three size-3
// directed cycles {a,b,c},{d,e,f},{g,h,i} plus a ONE-WAY a→d bridge that does NOT merge two SCCs. GDS
// asserts only the PARTITION (same-component grouping + 3 components of size 3), which is what we check.

const unmap = (v: any): any => v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, unmap(x)])) : v;
const run = async (store: ReturnType<typeof seeded>, gremlin: string): Promise<unknown[]> =>
  Promise.all((await exec(store).framedAsync(gremlin, {})).map((f) => decode(f.buf)));

// DIRECTED edges — one addE per edge, direction respected (unlike the undirected triangle/kcore seeds).
const seedOf = (nodes: readonly string[], edges: readonly (readonly [string, string])[]): readonly string[] => [
  ...nodes.map((n) => `g.addV('n').property('name','${n}')`),
  ...edges.map(([s, t]) => `g.V().has('name','${s}').addE('R').to(__.V().has('name','${t}'))`),
];

/** name → componentId over a graph. */
const componentsOf = async (store: ReturnType<typeof seeded>): Promise<Record<string, string>> =>
  Object.fromEntries(((await run(store,
    `g.V().call("scc").project("name","componentId").by("name").by("componentId")`)).map(unmap) as any[])
    .map((r) => [r.name, r.componentId]));

/** Assert `names` all share ONE component and NO other vertex is in it (GDS's assertBelongSameComponent). */
const sameComponent = (comp: Record<string, string>, names: readonly string[]): void => {
  const id = comp[names[0]];
  for (const n of names) expect(comp[n]).toBe(id);
  for (const [n, c] of Object.entries(comp)) if (!names.includes(n)) expect(c).not.toBe(id);
};

describe('scc — strongly connected components (directed mutual reachability)', () => {
  test('GDS SccTest graph: three size-3 cycles, a→d bridge does NOT merge them', async () => {
    const comp = await componentsOf(seeded(seedOf(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      [['a', 'b'], ['b', 'c'], ['c', 'a'],
       ['d', 'e'], ['e', 'f'], ['f', 'd'],
       ['a', 'd'],
       ['g', 'h'], ['h', 'i'], ['i', 'g']],
    )));
    sameComponent(comp, ['a', 'b', 'c']);
    sameComponent(comp, ['d', 'e', 'f']);
    sameComponent(comp, ['g', 'h', 'i']);
    expect(new Set(Object.values(comp)).size).toBe(3); // exactly 3 components
  });

  test('direction matters: a→b→c (no back edges) is THREE singleton SCCs', async () => {
    const comp = await componentsOf(seeded(seedOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']])));
    expect(new Set(Object.values(comp)).size).toBe(3);
  });

  test('a 2-cycle a⇄b is ONE SCC; a pendant c (a→c) is its own', async () => {
    const comp = await componentsOf(seeded(seedOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'a'], ['a', 'c']])));
    sameComponent(comp, ['a', 'b']);
    sameComponent(comp, ['c']);
  });

  test('every vertex decorated; has()/order().by(componentId) compose over the stream', async () => {
    const store = seeded(seedOf(
      ['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'a'], ['a', 'd']]));
    expect(await run(store, `g.V().call("scc").has("componentId").count()`)).toEqual([4]);
    // {a,b,c} one SCC, {d} singleton → 2 distinct component ids; order().by composes.
    const ids = await run(store, `g.V().call("scc").order().by("componentId").by("name").values("name")`);
    expect(new Set(ids)).toEqual(new Set(['a', 'b', 'c', 'd']));
  });
});
