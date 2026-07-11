// Mini-L3: drive the conformance host through the real gremlin GLV the same way
// TinkerPop's cucumber runner does — selecting a graph by traversal-source name
// (gmodern, ggraph) — and assert canonical results from the official modern
// graph plus an empty-graph write/reset cycle. This proves the named-graph
// routing and the P1 step set over the exact GraphBinary wire path the full
// cucumber suite uses. The full suite (164 feature files) runs externally; see
// conformance/README-cucumber.md for the command and current tag set.
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import gremlin from 'gremlin';
import { startConformanceServer } from './conformance-server.ts';

const { DriverRemoteConnection } = gremlin.driver;
const { traversal } = gremlin.process.AnonymousTraversalSource;
const __ = gremlin.process.statics;
const { order } = gremlin.process;

describe('conformance host — modern graph (official ids/results)', () => {
  let server: any, drc: any, g: any;

  beforeAll(async () => {
    server = startConformanceServer(0);
    const url = `http://localhost:${server.port}/gremlin`;
    drc = new DriverRemoteConnection(url, { traversalSource: 'gmodern' });
    g = traversal().with_(drc);
  });
  afterAll(async () => { await drc?.close(); server?.stop(); });

  test('g_V_count', async () => expect((await g.V().count().next()).value).toBe(6n));
  test('g_V_hasLabelXpersonX_count', async () =>
    expect((await g.V().hasLabel('person').count().next()).value).toBe(4n));

  test('g_VX1X_outXknowsX_name', async () =>
    expect(await g.V(1).out('knows').values('name').toList()).toEqual(['vadas', 'josh']));

  test('g_VX1X_out_out_name (two hops)', async () =>
    expect((await g.V(1).out().out().values('name').toList()).sort()).toEqual(['lop', 'ripple']));

  test('g_V_valueMap (list-valued)', async () => {
    const m = (await g.V(1).valueMap().next()).value;
    expect(m.get('name')).toEqual(['marko']);
    expect(m.get('age')).toEqual([29]);
  });

  test('g_V_elementMap (flat, id+label tokens)', async () => {
    const m = (await g.V(1).elementMap().next()).value;
    expect(m.get('name')).toBe('marko');
    expect([...m.entries()].find(([k]: any) => k?.elementName === 'label')?.[1]).toBe('person');
  });

  test('g_V_hasLabelXpersonX_order_byXageX_name', async () =>
    expect(await g.V().hasLabel('person').order().by('age').values('name').toList())
      .toEqual(['vadas', 'marko', 'josh', 'peter']));

  test('g_V_order_byXage_descX_range', async () =>
    expect(await g.V().hasLabel('person').order().by('age', order.desc).range(0, 2).values('name').toList())
      .toEqual(['peter', 'josh']));

  test('g_V_valuesXnameX_order (lexicographic)', async () =>
    expect(await g.V().values('name').order().toList())
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']));

  // P2a: as()/select()/project()/by() over the real GraphBinary wire — proves
  // alias-column threading + Map framing round-trip through the unmodified GLV.
  test('g_VX1X_asXaX_outXknowsX_selectXaX (single-label select → vertex)', async () => {
    const vs = await g.V(1).as('a').out('knows').select('a').toList();
    expect(vs.map((v: any) => v.id)).toEqual([1, 1]); // marko, twice
    expect(vs.every((v: any) => v.label === 'person')).toBe(true);
  });

  test('g_VX1X_asXaX_outXknowsX_asXbX_selectXa_bX_byXnameX (Map result)', async () => {
    const maps = await g.V(1).as('a').out('knows').as('b').select('a', 'b').by('name').toList();
    const pairs = maps.map((m: any) => [m.get('a'), m.get('b')]).sort((x: any, y: any) => x[1].localeCompare(y[1]));
    expect(pairs).toEqual([['marko', 'josh'], ['marko', 'vadas']]);
  });

  test('g_VX1X_asXaX_outXknowsX_asXbX_selectXa_bX (Map of vertices)', async () => {
    const maps = await g.V(1).as('a').out('knows').as('b').select('a', 'b').toList();
    expect(maps.length).toBe(2);
    for (const m of maps) {
      expect(m.get('a').id).toBe(1); // marko
      expect([2, 4]).toContain(m.get('b').id); // vadas or josh
      expect(m.get('b').label).toBe('person');
    }
  });

  test('g_V_hasLabelXpersonX_projectXname_ageX (project → Map from current)', async () => {
    const maps = await g.V().hasLabel('person').project('name', 'age').by('name').by('age').toList();
    const byName = Object.fromEntries(maps.map((m: any) => [m.get('name'), m.get('age')]));
    expect(byName).toEqual({ marko: 29, vadas: 27, josh: 32, peter: 35 });
  });
});

describe('conformance host — empty graph write/reset (ggraph)', () => {
  let server: any, drc: any, g: any;

  beforeAll(async () => {
    server = startConformanceServer(0);
    drc = new DriverRemoteConnection(`http://localhost:${server.port}/gremlin`, { traversalSource: 'ggraph' });
    g = traversal().with_(drc);
  });
  afterAll(async () => { await drc?.close(); server?.stop(); });

  test('write then drop-reset (the runner cleans empty with g.V().drop())', async () => {
    const a = (await g.addV('person').property('name', 'a').next()).value;
    const b = (await g.addV('person').property('name', 'b').next()).value;
    await g.V(a.id).addE('knows').to(__.V(b.id)).iterate();
    expect((await g.V().count().next()).value).toBe(2n);

    await g.V().drop().iterate();
    expect((await g.V().count().next()).value).toBe(0n);
  });

  test('modern and empty are isolated graphs', async () => {
    // ggraph was just emptied; gmodern is untouched.
    const modern = traversal().with_(
      new DriverRemoteConnection(`http://localhost:${server.port}/gremlin`, { traversalSource: 'gmodern' }));
    expect((await modern.V().count().next()).value).toBe(6n);
  });
});
