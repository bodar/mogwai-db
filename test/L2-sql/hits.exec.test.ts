import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';

// HITS (Kleinberg hubs & authorities) — hits, the first MULTI-CHANNEL decorate barrier (hub =
// barrier_state channel 0, auth = channel 1). Call-only (no native TinkerPop step), GDS-style.
//
// Oracle + graph PORTED from GDS's own test (vendor/gds/algo/src/test/java/org/neo4j/gds/hits/HitsTest.java,
// GPLv3 — re-expressed, not transcribed). GDS asserts its Pregel HITS equals a Wikipedia-pseudocode
// reference on this exact 8-node directed graph at 30 iterations; we reproduce that reference in TS and
// assert our SQL HITS matches it. The pseudocode: init hub=auth=1; per iteration auth[v]=Σ hub[u] for
// u→v then L2-normalise, hub[v]=Σ auth[w] for v→w then L2-normalise.

const NODES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
const EDGES: readonly (readonly [string, string])[] = [
  ['a', 'd'], ['b', 'c'], ['b', 'e'], ['c', 'a'], ['d', 'c'], ['e', 'd'], ['e', 'b'],
  ['e', 'f'], ['e', 'c'], ['f', 'c'], ['f', 'h'], ['g', 'a'], ['g', 'c'], ['h', 'a'],
];

const HITS_SEED: readonly string[] = [
  ...NODES.map((n) => `g.addV('n').property('name','${n}')`),
  ...EDGES.map(([s, t]) => `g.V().has('name','${s}').addE('link').to(__.V().has('name','${t}'))`),
];

/** The Wikipedia HITS reference GDS's own test asserts against, over node NAMES. */
function hitsOracle(k: number): { hub: Map<string, number>; auth: Map<string, number> } {
  const inN = new Map<string, string[]>(NODES.map((n) => [n, []]));
  const outN = new Map<string, string[]>(NODES.map((n) => [n, []]));
  for (const [s, t] of EDGES) { outN.get(s)!.push(t); inN.get(t)!.push(s); }
  let hub = new Map<string, number>(NODES.map((n) => [n, 1]));
  let auth = new Map<string, number>(NODES.map((n) => [n, 1]));
  const l2 = (m: Map<string, number>) => Math.sqrt([...m.values()].reduce((s, v) => s + v * v, 0));
  for (let i = 0; i < k; i++) {
    const na = new Map<string, number>(NODES.map((v) => [v, inN.get(v)!.reduce((s, u) => s + hub.get(u)!, 0)]));
    const an = l2(na); if (an > 0) for (const v of NODES) na.set(v, na.get(v)! / an);
    auth = na;
    const nh = new Map<string, number>(NODES.map((v) => [v, outN.get(v)!.reduce((s, w) => s + auth.get(w)!, 0)]));
    const hn = l2(nh); if (hn > 0) for (const v of NODES) nh.set(v, nh.get(v)! / hn);
    hub = nh;
  }
  return { hub, auth };
}

const unmap = (v: any): any => v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, unmap(x)])) : v;
const run = async (store: ReturnType<typeof seeded>, gremlin: string): Promise<unknown[]> =>
  Promise.all((await exec(store).framedAsync(gremlin, {})).map((f) => decode(f.buf)));

describe('hits — HITS hubs & authorities (multi-channel decorate)', () => {
  test('hub + auth match the GDS pseudocode oracle at 30 iterations', async () => {
    const store = seeded(HITS_SEED);
    const rows = (await run(store,
      `g.V().call("hits", ["iterations": 30]).project("name","hub","auth").by("name").by("hub").by("auth")`)).map(unmap);
    expect(rows.length).toBe(8);
    const oracle = hitsOracle(30);
    for (const r of rows as any[]) {
      expect(r.hub).toBeCloseTo(oracle.hub.get(r.name)!, 10);
      expect(r.auth).toBeCloseTo(oracle.auth.get(r.name)!, 10);
    }
  });

  test('both scores are readable as double properties on the passed-through stream', async () => {
    const store = seeded(HITS_SEED);
    // c is the strongest authority (5 in-edges: b,d,e,f,g) — its auth is the max.
    const byName = Object.fromEntries(((await run(store,
      `g.V().call("hits", ["iterations": 30]).project("name","auth").by("name").by("auth")`)).map(unmap) as any[])
      .map((r) => [r.name, r.auth]));
    const maxAuth = Math.max(...Object.values(byName) as number[]);
    expect(byName.c).toBe(maxAuth);
    // e is the strongest hub (5 out-edges) — its hub is the max.
    const byHub = Object.fromEntries(((await run(store,
      `g.V().call("hits", ["iterations": 30]).project("name","hub").by("name").by("hub")`)).map(unmap) as any[])
      .map((r) => [r.name, r.hub]));
    expect(byHub.e).toBe(Math.max(...Object.values(byHub) as number[]));
  });

  test('order().by(auth, desc) composes over the decorated stream', async () => {
    const store = seeded(HITS_SEED);
    // c has the highest authority, so it sorts first descending.
    const names = await run(store,
      `g.V().call("hits", ["iterations": 30]).order().by("auth", Order.desc).limit(1).values("name")`);
    expect(names).toEqual(['c']);
  });

  test('custom property keys via hubProperty / authProperty', async () => {
    const store = seeded(HITS_SEED);
    expect(await run(store,
      `g.V().call("hits", ["hubProperty": "h", "authProperty": "a", "iterations": 5]).has("h").has("a").count()`))
      .toEqual([8]);
  });
});
