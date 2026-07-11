// Mini-L3: drive the conformance host through the real gremlin GLV the same way
// TinkerPop's cucumber runner does — selecting a graph by traversal-source name
// (gmodern, ggraph) — and assert canonical results from the official modern
// graph plus an empty-graph write/reset cycle. This proves the named-graph
// routing and the P1 step set over the exact GraphBinary wire path the full
// cucumber suite uses. The full suite (164 feature files) runs externally; see
// conformance/README-cucumber.md for the command and current tag set.
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import gremlin from 'gremlin';
import { startConformanceServer } from './conformance-server.js';

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
