import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';

// connectedComponent() (wcc) — a DECORATE barrier. The compute is global (union-find over the
// undirected edge list); the decorate resume keeps the element stream LIVE and reads the component id as
// a synthetic property under the canonical key, so has()/order().by()/project().by() compose. These
// mirror the reference ConnectedComponent.feature scenarios that use the DEFAULT (bothE) edge scope; the
// custom-edge-scope scenario fails closed (its anonymous edge traversal is not yet carried as a param).

const KEY = 'gremlin.connectedComponentVertexProgram.component';
const unmap = (v: any): any => v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, unmap(x)])) : v;
const run = async (store: ReturnType<typeof seeded>, gremlin: string): Promise<unknown[]> =>
  Promise.all((await exec(store).framedAsync(gremlin, {})).map((f) => decode(f.buf)));

describe('connectedComponent() — wcc DECORATE barrier', () => {
  test('has(component) passes every vertex (modern graph is one undirected component)', async () => {
    const store = seeded(MODERN_SEED);
    // g_V_connectedComponent_hasXcomponentX / g_V_dedup_connectedComponent_hasXcomponentX
    expect(await run(store, `g.V().connectedComponent().has("${KEY}").count()`)).toEqual([6]);
    expect(await run(store, `g.V().dedup().connectedComponent().has("${KEY}").count()`)).toEqual([6]);
  });

  test('project name+component over software vertices — both in component "1"', async () => {
    const store = seeded(MODERN_SEED);
    // g_V_hasLabelXsoftwareX_connectedComponent_project_byXnameX_byXcomponentX
    const rows = (await run(store, `g.V().hasLabel("software").connectedComponent().project("name","${KEY}").by("name").by("${KEY}")`)).map(unmap);
    expect(Object.fromEntries(rows.map((r: any) => [r.name, r[KEY]]))).toEqual({ lop: '1', ripple: '1' });
  });

  test('the component id is the lexicographically-smallest external id in the component', async () => {
    const store = seeded(MODERN_SEED);
    // All six vertices reach id 1 (marko) undirected, so every component id is "1".
    const rows = (await run(store, `g.V().connectedComponent().project("name","${KEY}").by("name").by("${KEY}")`)).map(unmap);
    expect(new Set(rows.map((r: any) => r[KEY]))).toEqual(new Set(['1']));
  });

  test('order().by(component).by(name) composes over the decorated stream', async () => {
    const store = seeded(MODERN_SEED);
    expect(await run(store, `g.V().connectedComponent().order().by("${KEY}").by("name").values("name")`))
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });

  test('a custom bothE(knows) edge scope restricts connectivity (knows-only components)', async () => {
    const store = seeded(MODERN_SEED);
    // g_V_connectedComponent_withXEDGES_bothEXknowsXX_withXPROPERTY_NAME_clusterX_...
    // knows-only: {marko,vadas,josh} share component "1"; peter is isolated → its own id "6".
    const rows = (await run(store, `g.V().hasLabel("person").connectedComponent().with("~tinkerpop.connectedComponent.edges", __.bothE("knows")).with("~tinkerpop.connectedComponent.propertyName", "cluster").project("name","cluster").by("name").by("cluster")`)).map(unmap);
    expect(Object.fromEntries(rows.map((r: any) => [r.name, r.cluster]))).toEqual({ marko: '1', vadas: '1', josh: '1', peter: '6' });
  });

  test('a directional (outE/inE) edge scope fails closed — undirected only, for now', async () => {
    const store = seeded(MODERN_SEED);
    await expect(exec(store).framedAsync(`g.V().connectedComponent().with("~tinkerpop.connectedComponent.edges", __.outE("knows")).has("${KEY}")`, {}))
      .rejects.toThrow('undirected');
  });

  test('has(component, value) filters on the decorated TEXT component id', async () => {
    const store = seeded(MODERN_SEED);
    // Every vertex is component "1" in the undirected modern graph.
    expect(await run(store, `g.V().connectedComponent().has("${KEY}", "1").count()`)).toEqual([6]);
    expect(await run(store, `g.V().connectedComponent().has("${KEY}", "9").count()`)).toEqual([0]);
    // knows-only scope isolates peter into its own component "6" — filter to exactly it.
    const rows = await run(store, `g.V().hasLabel("person").connectedComponent().with("~tinkerpop.connectedComponent.edges", __.bothE("knows")).with("~tinkerpop.connectedComponent.propertyName", "cluster").has("cluster", "6").values("name")`);
    expect(rows).toEqual(['peter']);
  });

  test('values() mixing the decorated component key with a stored key — the UNION multiset', async () => {
    const store = seeded(MODERN_SEED);
    const vals = await run(store, `g.V().connectedComponent().values("name", "${KEY}")`);
    expect(vals.length).toBe(12); // 6 stored names + 6 decorated component ids
    expect(vals.filter((v) => v === '1').length).toBe(6); // every component id is "1"
    expect(new Set(vals.filter((v) => v !== '1'))).toEqual(new Set(['marko', 'vadas', 'lop', 'josh', 'ripple', 'peter']));
  });

  test('bare values() (every key) includes the decorated component id', async () => {
    const store = seeded(MODERN_SEED);
    const bare = await run(store, `g.V().connectedComponent().values()`);
    const plain = await run(store, `g.V().values()`);
    expect(bare.length).toBe(plain.length + 6); // + one component id per vertex
    expect(bare.filter((v) => v === '1').length).toBe(6); // every vertex's component id is "1"
  });
});
