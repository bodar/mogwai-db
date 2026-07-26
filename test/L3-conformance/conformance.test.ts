// Mini-L3: drive the conformance host through the real gremlin GLV the same way
// TinkerPop's cucumber runner does — selecting a graph by traversal-source name
// (gmodern, ggraph) — and assert canonical results from the official modern
// graph plus an empty-graph write/reset cycle. This proves the named-graph
// routing and the P1 step set over the exact GraphBinary wire path the full
// cucumber suite uses. The full suite (164 feature files) runs externally; see
// test/L3-conformance/README-cucumber.md for the command and current tag set.
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import gremlin from 'gremlin';
import { startConformanceServer } from './conformance-server.ts';
import '../support/undici-shim.ts'; // Bun's undici Agent lacks close() — see the shim's header

const { DriverRemoteConnection } = gremlin.driver;
const { traversal } = gremlin.process.AnonymousTraversalSource;
const __ = gremlin.process.statics;
const { order, P, TextP, t } = gremlin.process;
const { gt } = P;

describe('conformance host — modern graph (official ids/results)', () => {
  let server: any, drc: any, g: any;

  beforeAll(async () => {
    server = await startConformanceServer(0);
    const url = `http://localhost:${server.port}/gremlin`;
    drc = new DriverRemoteConnection(url, { traversalSource: 'gmodern' });
    g = traversal().with_(drc);
  });
  afterAll(async () => { await drc?.close(); server?.stop(); });

  test('g_V_count', async () => expect((await g.V().count().next()).value).toBe(6));
  test('g_V_hasLabelXpersonX_count', async () =>
    expect((await g.V().hasLabel('person').count().next()).value).toBe(4));

  test('g_VX1X_outXknowsX_name', async () =>
    // bare values() has no guaranteed order (TinkerPop); compare as a set
    expect((await g.V(1).out('knows').values('name').toList()).sort()).toEqual(['josh', 'vadas']));

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

  // P2c-1: edge traversal over the real wire — proves the edge shape / edgeBuffer
  // (materialised edge props) round-trips through the unmodified GLV.
  test('g_E_count / g_VX1X_outEXknowsX_inV_name', async () => {
    expect((await g.E().count().next()).value).toBe(6);
    expect((await g.V(1).outE('knows').inV().values('name').toList()).sort())
      .toEqual(['josh', 'vadas']);
  });

  test('g_VX1X_outEXknowsX (edge elements with materialised weight)', async () => {
    const edges = await g.V(1).outE('knows').toList();
    expect(edges.length).toBe(2);
    for (const e of edges) {
      expect(e.label).toBe('knows');
      expect(e.outV.id).toBe(1);              // marko is the source
      expect([2, 4]).toContain(e.inV.id);     // vadas or josh
      expect(e.properties.find((p: any) => p.key === 'weight')).toBeDefined(); // props materialised
    }
  });

  // P2c-1b: property elements over the real wire.
  test('g_VX1X_properties_value / _key (VertexProperty elements)', async () => {
    expect((await g.V(1).properties().value().toList()).sort()).toEqual([29, 'marko']);
    expect((await g.V(1).properties().key().toList()).sort()).toEqual(['age', 'name']);
    const props = await g.V(1).properties('name').toList();
    expect(props.length).toBe(1);
    expect(props[0].key).toBe('name');
    expect(props[0].value).toBe('marko');
  });

  // P2c-2: group/groupCount over the real wire — proves the group Map (and its
  // vertex/edge/property values + composite Map keys) round-trips as GraphBinary.
  test('g_V_group_byXnameX (Map<name, List<vertex>>)', async () => {
    const m = (await g.V().group().by('name').next()).value;
    expect(m instanceof Map).toBe(true);
    expect(m.size).toBe(6);
    const marko = m.get('marko');
    expect(Array.isArray(marko)).toBe(true);
    expect(marko[0].id).toBe(1);
    expect(marko[0].label).toBe('person');
  });

  test('g_V_groupCount_byXlabelX (Map<label, Long>)', async () => {
    const m = (await g.V().groupCount().by(__.label()).next()).value;
    expect(m.get('person')).toBe(4);
    expect(m.get('software')).toBe(2);
  });

  test('g_V_group_byXnameX_byXageX (Map<name, List<Int>>; software → [])', async () => {
    const m = (await g.V().group().by('name').by('age').next()).value;
    expect(m.get('marko')).toEqual([29]);
    expect(m.get('lop')).toEqual([]); // no age → filtered to empty list
  });

  test('g_V_valuesXageX_sum / g_V_valuesXnameX_fold (reducers over the wire)', async () => {
    // sum of int ages → Int (d[123].i), deserializes as a JS number, not BigInt.
    expect((await g.V().hasLabel('person').values('age').sum().next()).value).toBe(123);
    const list = (await g.V().values('name').fold().next()).value;
    expect(Array.isArray(list)).toBe(true);
    expect(list.sort()).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });

  test('g_V_group_byXageX excludes software (no null-keyed group)', async () => {
    const m = (await g.V().group().by('age').next()).value;
    expect(m.size).toBe(4); // 4 person ages; lop/ripple (no age) excluded
    expect([...m.keys()].some((k) => k === null)).toBe(false);
  });

  // P2b: is/where/not/TextP over the real wire.
  test('g_V_valuesXageX_isXgt30X / count_is (is over the wire)', async () => {
    expect((await g.V().values('age').is(gt(30)).toList()).sort()).toEqual([32, 35]);
    expect((await g.V().hasLabel('person').count().is(gt(3)).next()).value).toBe(4);
  });

  test('g_V_whereXoutXknowsXX / not / TextP (filters over the wire)', async () => {
    expect(await g.V().where(__.out('knows')).values('name').toList()).toEqual(['marko']);
    expect((await g.V().not(__.out('created')).values('name').toList()).sort()).toEqual(['lop', 'ripple', 'vadas']);
    expect(await g.V().has('name', TextP.startingWith('jo')).values('name').toList()).toEqual(['josh']);
  });

  test('g_V_asXaX_out_created_in_created_whereXneqXaXX (co-creator alias-compare)', async () => {
    const names = (await g.V().as('a').out('created').in_('created').where(P.neq('a')).values('name').toList()).sort();
    expect(names).toEqual(['josh', 'josh', 'marko', 'marko', 'peter', 'peter']);
  });

  // P2 tail: and/or/union/optional over the real wire.
  test('g_VX1X_unionXout_knows__out_createdX / and / optional', async () => {
    expect((await g.V(1).union(__.out('knows'), __.out('created')).values('name').toList()).sort())
      .toEqual(['josh', 'lop', 'vadas']);
    expect(await g.V().and(__.out('knows'), __.out('created')).values('name').toList()).toEqual(['marko']);
    // optional: josh→created ripple/lop; vadas→self
    expect((await g.V(4).optional(__.out('created')).values('name').toList()).sort()).toEqual(['lop', 'ripple']);
    expect(await g.V(2).optional(__.out('created')).values('name').toList()).toEqual(['vadas']);
  });

  // P3: repeat/times/emit over the real wire (recursive CTE round-trip).
  test('g_V_repeatXoutX_timesX2X (+emit)', async () => {
    expect((await g.V().repeat(__.out()).times(2).values('name').toList()).sort()).toEqual(['lop', 'ripple']);
    // emit-after from marko includes intermediates (lop appears twice — multiset)
    expect((await g.V(1).repeat(__.out()).times(2).emit().values('name').toList()).sort())
      .toEqual(['josh', 'lop', 'lop', 'ripple', 'vadas']);
  });

  test('sum of doubles landing on a whole number stays Double (not Long)', async () => {
    // ripple(5) has one incident edge, weight 1.0 → sum 1.0. Must frame as Double
    // (d[1.0].d → JS number), not Long (which deserializes as BigInt). Guards the
    // typeof(SUM) framing fix.
    const v = (await g.V(5).bothE().values('weight').sum().next()).value;
    expect(v).toBe(1.0);
    expect(typeof v).toBe('number');
  });

  test('g_VX1X_outEXknowsX_fold (List<edge> with materialised props)', async () => {
    const list = (await g.V(1).outE('knows').fold().next()).value;
    expect(list.length).toBe(2);
    expect(list.every((e: any) => e.label === 'knows')).toBe(true);
    expect(list.every((e: any) => e.properties.some((p: any) => p.key === 'weight'))).toBe(true);
  });

  // The exact L3 BeforeAll gate traversals (world.js getVertices/getEdges/
  // getVertexProperties) — these must pass or NO upstream scenario runs.
  test('gate: g.V().group().by("name").by(__.tail()) (Map<name, vertex>)', async () => {
    const m = (await g.V().group().by('name').by(__.tail()).next()).value;
    expect(m.size).toBe(6);
    expect(m.get('marko').id).toBe(1);
    expect(m.get('ripple').id).toBe(5);
  });

  test('gate: g.E().group().by(project o/l/i).by(tail) (Map<Map, edge>)', async () => {
    const m = (await g.E().group()
      .by(__.project('o', 'l', 'i').by(__.outV().values('name')).by(__.label()).by(__.inV().values('name')))
      .by(__.tail()).next()).value;
    expect(m.size).toBe(6);
    // find the marko-created->lop key
    const entry = [...m.entries()].find(([k]: any) => k.get('o') === 'marko' && k.get('l') === 'created' && k.get('i') === 'lop');
    expect(entry).toBeDefined();
    expect(entry![1].id).toBe(9); // the edge
  });

  test('gate: g.V().properties().group().by(project n/k/v).by(tail) (Map<Map, property>)', async () => {
    const m = (await g.V().properties().group()
      .by(__.project('n', 'k', 'v').by(__.element().values('name')).by(__.key()).by(__.value()))
      .by(__.tail()).next()).value;
    expect(m.size).toBe(12); // 6 vertices × 2 props each
    const entry = [...m.entries()].find(([k]: any) => k.get('n') === 'marko' && k.get('k') === 'name');
    expect(entry![1].value).toBe('marko');
  });
});

describe('conformance host — empty graph write/reset (ggraph)', () => {
  let server: any, drc: any, g: any;

  beforeAll(async () => {
    server = await startConformanceServer(0);
    drc = new DriverRemoteConnection(`http://localhost:${server.port}/gremlin`, { traversalSource: 'ggraph' });
    g = traversal().with_(drc);
  });
  afterAll(async () => { await drc?.close(); server?.stop(); });

  test('write then drop-reset (the runner cleans empty with g.V().drop())', async () => {
    const a = (await g.addV('person').property('name', 'a').next()).value;
    const b = (await g.addV('person').property('name', 'b').next()).value;
    await g.V(a.id).addE('knows').to(__.V(b.id)).iterate();
    expect((await g.V().count().next()).value).toBe(2);

    await g.V().drop().iterate();
    expect((await g.V().count().next()).value).toBe(0);
  });

  test('modern and empty are isolated graphs', async () => {
    // ggraph was just emptied; gmodern is untouched.
    const modern = traversal().with_(
      new DriverRemoteConnection(`http://localhost:${server.port}/gremlin`, { traversalSource: 'gmodern' }));
    expect((await modern.V().count().next()).value).toBe(6);
  });

  // W1: user-supplied string ids round-trip through the real GLV.
  test('user-supplied string ids (property(T.id), V(uid), edge endpoints)', async () => {
    await g.V().drop().iterate();
    const m = (await g.addV('person').property(t.id, 'person:marko').property('name', 'marko').next()).value;
    expect(m.id).toBe('person:marko');
    await g.addV('person').property(t.id, 'person:vadas').property('name', 'vadas').iterate();
    await g.V('person:marko').addE('knows').to(__.V('person:vadas')).iterate();
    // V(uid) seed resolves; id() and out().id() expose the user id
    expect(await g.V('person:marko').values('name').toList()).toEqual(['marko']);
    expect(await g.V('person:marko').out('knows').id().toList()).toEqual(['person:vadas']);
    await g.V().drop().iterate();
  });
});

// Read-path edge endpoints under UserSuppliedIds: a materialized edge element must
// report the SAME external endpoint ids the write path reports — not the internal
// rowid. Regression for the documented read/write divergence. Uses the pre-seeded
// `guid` graph (alice/bob/e1) so we read edges without a write-then-read dance.
describe('conformance host — read-path edge endpoints report external ids (guid)', () => {
  let server: any, drc: any, g: any;

  beforeAll(async () => {
    server = await startConformanceServer(0);
    drc = new DriverRemoteConnection(`http://localhost:${server.port}/gremlin`, { traversalSource: 'guid' });
    g = traversal().with_(drc);
  });
  afterAll(async () => { await drc?.close(); server?.stop(); });

  test('g.E(): edge id + outV/inV ids are the user-supplied ids', async () => {
    const e = (await g.E().next()).value;
    expect(e.id).toBe('e1');
    expect(e.outV.id).toBe('alice'); // was the internal rowid (1)
    expect(e.inV.id).toBe('bob');    // was the internal rowid (2)
  });

  test('g.V(uid).outE(): endpoints resolve from a vertex-rooted edge scan', async () => {
    const e = (await g.V('alice').outE('knows').next()).value;
    expect(e.outV.id).toBe('alice');
    expect(e.inV.id).toBe('bob');
  });

  test('g.V(uid).outE().fold(): edges in a list keep external endpoints', async () => {
    const list = (await g.V('alice').outE('knows').fold().next()).value;
    expect(list.length).toBe(1);
    expect(list[0].outV.id).toBe('alice');
    expect(list[0].inV.id).toBe('bob');
  });

  test('g.V(uid).outE().inV().path(): the edge position keeps external endpoints', async () => {
    const path = (await g.V('alice').outE('knows').inV().path().next()).value;
    // objects: [alice(vertex), e1(edge), bob(vertex)]
    const edge = path.objects.find((o: any) => o?.outV !== undefined);
    expect(edge.outV.id).toBe('alice');
    expect(edge.inV.id).toBe('bob');
  });
});
