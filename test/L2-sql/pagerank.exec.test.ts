import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';

// pageRank() (mogwai.pageRank) — a DECORATE barrier faithfully replaying PageRankVertexProgram's BSP
// (default outE scope, α=0.85, ε=1e-5, ≤20 iters, dangling-node teleport redistribution). The decorate
// resume keeps the vertex stream LIVE and reads the score under the canonical key, so has()/order().by()
// compose. Mirrors the default-scope PageRank.feature scenarios; the custom-edge-scope / times /
// values(key).math() scenarios need the edge-config + numeric-read substrate (a follow-up).

const KEY = 'gremlin.pageRankVertexProgram.pageRank';
const run = async (store: ReturnType<typeof seeded>, gremlin: string): Promise<unknown[]> =>
  Promise.all((await exec(store).framedAsync(gremlin, {})).map((f) => decode(f.buf)));

describe('pageRank() — mogwai.pageRank DECORATE barrier', () => {
  test('has(pageRank) passes every vertex', async () => {
    const store = seeded(MODERN_SEED);
    // g_V_pageRank_hasXpageRankX
    expect(await run(store, `g.V().pageRank().has("${KEY}").count()`)).toEqual([6]);
  });

  test('order().by(pageRank, desc).by(name).values(name) — the reference ranking', async () => {
    const store = seeded(MODERN_SEED);
    // g_V_pageRank_order_byXpageRank_descX_byXnameX_name — the exact expected order.
    expect(await run(store, `g.V().pageRank().order().by("${KEY}", Order.desc).by("name").values("name")`))
      .toEqual(['lop', 'ripple', 'josh', 'vadas', 'marko', 'peter']);
  });

  test('order().by(pageRank, desc).values(name).limit(2)', async () => {
    const store = seeded(MODERN_SEED);
    // g_V_pageRank_order_byXpageRank_descX_name_limitX2X
    expect(await run(store, `g.V().pageRank().order().by("${KEY}", Order.desc).values("name").limit(2)`))
      .toEqual(['lop', 'ripple']);
  });

  test('the highest-ranked vertex is the most-created software (lop)', async () => {
    const store = seeded(MODERN_SEED);
    const rows = (await run(store, `g.V().pageRank().project("name","${KEY}").by("name").by("${KEY}")`))
      .map((m: any) => m instanceof Map ? Object.fromEntries(m) : m);
    const byName = Object.fromEntries(rows.map((r: any) => [r.name, r[KEY]]));
    // Every score is a positive double; lop (a sink every creator points at) outranks its creators.
    for (const v of ['marko', 'vadas', 'lop', 'josh', 'ripple', 'peter']) expect(byName[v]).toBeGreaterThan(0);
    expect(byName.lop).toBeGreaterThan(byName.marko);
    expect(byName.lop).toBeGreaterThan(byName.josh);
  });

  test('values(key) over the decorated REAL score composes — the score reads back through movement', async () => {
    const store = seeded(MODERN_SEED);
    // g_V_pageRank_withXpropertyName_pageRankX_asXaX_outXknowsX_pageRank_asXbX_selectXa_bX_by_byXmathX
    const rows = (await run(store, `g.V().pageRank().with("~tinkerpop.pageRank.propertyName","pageRank").as("a").out("knows").values("pageRank").as("b").select("a", "b").by().by(__.math("ceil(_ * 100)"))`))
      .map((m: any) => m instanceof Map ? Object.fromEntries(m) : m);
    // marko is the only person with out("knows") (→ vadas, josh); both targets ceil to 15.
    expect(rows.length).toBe(2);
    for (const r of rows) { expect(r.a?.id ?? r.a).toBe(1); expect(r.b).toBe(15); }
  });

  test('a custom edge scope / fixed times fail closed (not mis-executed) — deferred to a follow-up', async () => {
    const store = seeded(MODERN_SEED);
    await expect(exec(store).framedAsync(`g.V().pageRank().with("~tinkerpop.pageRank.times", 0).has("${KEY}")`, {}))
      .rejects.toThrow('iteration count');
  });
});
