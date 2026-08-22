import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';

// connectedComponent() (mogwai.wcc) — a DECORATE barrier. The compute is global (union-find over the
// undirected edge list); the decorate resume keeps the element stream LIVE and reads the component id as
// a synthetic property under the canonical key, so has()/order().by()/project().by() compose. These
// mirror the reference ConnectedComponent.feature scenarios that use the DEFAULT (bothE) edge scope; the
// custom-edge-scope scenario fails closed (its anonymous edge traversal is not yet carried as a param).

const KEY = 'gremlin.connectedComponentVertexProgram.component';
const unmap = (v: any): any => v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, unmap(x)])) : v;
const run = async (store: ReturnType<typeof seeded>, gremlin: string): Promise<unknown[]> =>
  Promise.all((await exec(store).framedAsync(gremlin, {})).map((f) => decode(f.buf)));

describe('connectedComponent() — mogwai.wcc DECORATE barrier', () => {
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

  test('a custom edge scope fails closed (not mis-executed) — deferred to a follow-up', async () => {
    const store = seeded(MODERN_SEED);
    await expect(exec(store).framedAsync(`g.V().hasLabel("person").connectedComponent().with("~tinkerpop.connectedComponent.edges", __.bothE("knows")).has("${KEY}")`, {}))
      .rejects.toThrow();
  });
});
