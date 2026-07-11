import { test, expect, beforeAll, afterAll } from 'bun:test';
import gremlin from 'gremlin';
import { startServer } from '../src/server.js';

const { DriverRemoteConnection } = gremlin.driver;
const { traversal } = gremlin.process.AnonymousTraversalSource;
const __ = gremlin.process.statics;
const P = gremlin.process.P;

let server: ReturnType<typeof startServer>;
let drc: any;
let g: any;
let dan: any, ada: any, zig: any;

beforeAll(async () => {
  server = startServer(8182);
  drc = new DriverRemoteConnection('http://localhost:8182/');
  g = traversal().with_(drc);

  // ---- inserts through the wire ----
  dan = (await g.addV('person').property('name', 'dan').property('age', 44).next()).value;
  ada = (await g.addV('person').property('name', 'ada').property('age', 36).next()).value;
  zig = (await g.addV('language').property('name', 'zig').next()).value;

  await g.V(dan.id).addE('knows').to(__.V(ada.id)).iterate();
  await g.V(dan.id).addE('likes').to(__.V(zig.id)).iterate();
  await g.V(ada.id).addE('likes').to(__.V(zig.id)).iterate();
});

afterAll(async () => {
  await drc.close();
  server.stop(true);
});

test('inserts return materialized vertices', () => {
  expect(dan.constructor.name).toBe('Vertex');
  expect(typeof dan.id).toBe('number');
});

test('count vertices', async () => {
  expect((await g.V().count().next()).value).toBe(3n);
});

test('hasLabel + values', async () => {
  expect(await g.V().hasLabel('person').values('name').toList()).toEqual(['dan', 'ada']);
});

test('has eq', async () => {
  expect(await g.V().has('name', 'dan').values('age').toList()).toEqual([44]);
});

test('P.gt', async () => {
  expect(await g.V().has('age', P.gt(40)).values('name').toList()).toEqual(['dan']);
});

test('out(knows)', async () => {
  expect(await g.V(dan.id).out('knows').values('name').toList()).toEqual(['ada']);
});

test('in(likes)', async () => {
  expect(await g.V(zig.id).in_('likes').values('name').toList()).toEqual(['dan', 'ada']);
});

test('both + dedup', async () => {
  expect((await g.V(zig.id).both().dedup().count().next()).value).toBe(2n);
});

test('two hops', async () => {
  expect(await g.V().has('name', 'dan').out('knows').out('likes').values('name').toList()).toEqual(['zig']);
});

test('label()', async () => {
  expect(await g.V(zig.id).label().toList()).toEqual(['language']);
});

test('limit', async () => {
  expect((await g.V().limit(2).count().next()).value).toBe(2n);
});

test('vertex round-trips id and label', async () => {
  const v = (await g.V().has('name', 'ada').next()).value;
  expect(v.id).toBe(ada.id);
  expect(v.label).toBe('person');
  // Properties come back empty: the client's VertexSerializer hardcodes empty
  // properties. Materializing them (custom vertex framing) is P1 in PLAN.md.
  expect(v.properties ?? []).toEqual([]);
});

test('unsupported step rejected server-side', async () => {
  expect(g.V().sack().toList()).rejects.toThrow();
});
