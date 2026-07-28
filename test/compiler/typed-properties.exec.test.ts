// Compiler execution semantics (split from test/compiler.test.ts) — typed property values (P1).
// Runs compiled SQL against a seeded in-memory store, asserting RESULTS. Pure cut-
// and-paste relocation; the SQL-string snapshots live at test/L2-sql/*.sql.test.ts.
import { test, expect, describe } from 'bun:test';
import { compile, type CompileOptions } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery } from '../support/executor.ts';
import { ioc } from '../../src/io.ts';
import { parseRequest } from '../../src/wire.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { assertStreamColumns } from '../../src/compiler/steps/context/stream.ts';
import { pushChildScope } from '../../src/compiler/steps/tail/child.ts';
import { decode, decodeAll } from '../support/decode.ts';

const read = (q: string, options?: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind !== 'read') throw new Error('expected read plan');
  return p;
};

// ---------- execution semantics against a seeded store ----------

function seededStore() {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const q of MODERN_SEED) executeQuery(store, q, {}); // seed by running the write traversals
  return store;
}

const run = (store: GraphStore, q: string) => {
  const p = compile(q, {});
  if (p.kind === 'write') return p.run(store);
  return store.query(p.sql, p.binds);
};

// A write-response echo now carries each prop value as a self-describing {t,v} typed node
// (so the wire frames it exactly). Tests that assert the written VALUES (not their types)
// unwrap the nodes to plain values with this recursive helper.
const bare = (v: any): any =>
  Array.isArray(v) ? v.map(bare)
  : v && typeof v === 'object' && 't' in v && 'v' in v ? bare(v.v)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bare(x)]))
  : v;

const runWith = (store: GraphStore, q: string, options: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind === 'write') return p.run(store);
  return store.query(p.sql, p.binds);
};

// ---- typed property values, P1: canonical vtype stored on write (docs/2026-07-16-typed-property-values-plan.md) ----
describe('typed property values (P1) — vtype capture + collection storage', () => {
  const fresh = () => new GraphStore(new BunSqlite(':memory:'));
  const vprops = (store: GraphStore, keys: string[]) =>
    store.query<{ key: string; value: any; vtype: string | null }>(
      `SELECT key, value, vtype FROM vertex_properties WHERE key IN (${keys.map(() => '?').join(',')}) ORDER BY key`, keys);

  test('inline literal subtypes are stored as canonical vtype', () => {
    const store = fresh();
    executeQuery(store, "g.addV('t').property('i',1).property('l',5L).property('d',2.5).property('s','hi').property('b',true).property('when',datetime('2024-01-01T00:00:00Z')).property('gid',UUID('0-1'))", {});
    const got = Object.fromEntries(vprops(store, ['i', 'l', 'd', 's', 'b', 'when', 'gid']).map((r) => [r.key, r.vtype]));
    expect(got).toEqual({ b: 'boolean', d: 'double', gid: 'uuid', i: 'int', l: 'long', s: 'string', when: 'datetime' });
  });

  test('a list-valued property stores a self-describing typed-JSON tree (vtype=list)', async () => {
    const store = fresh();
    // Was "Binding expected string…" before collections serialized to JSONB; now the value
    // column holds the top node's BARE `v` = per-element {t,v} nodes (full-fidelity elements).
    executeQuery(store, "g.addV('d').property('list',['a','b','c'])", {});
    const r = store.query<{ v: string; vtype: string }>("SELECT json(value) AS v, vtype FROM vertex_properties WHERE key='list'")[0];
    expect([r.vtype, JSON.parse(r.v)]).toEqual(['list', [
      { t: 'string', v: 'a' }, { t: 'string', v: 'b' }, { t: 'string', v: 'c' },
    ]]);
    // round-trips back to the plain list value.
    const dec = (b: Buffer) => decode(b);
    expect(await decodeAll(executeQuery(store, "g.V().values('list').is(typeOf(GType.LIST))", {}))).toEqual([['a', 'b', 'c']]);
  });

  test('a map-valued property stores ordered typed [key,value] pairs (non-string keys survive)', () => {
    const store = fresh();
    executeQuery(store, "g.addV('x').property('data',[a:1,b:2])", {});
    const r = store.query<{ v: string; vtype: string }>("SELECT json(value) AS v, vtype FROM vertex_properties WHERE key='data'")[0];
    expect([r.vtype, JSON.parse(r.v)]).toEqual(['map', [
      [{ t: 'string', v: 'a' }, { t: 'int', v: 1 }],
      [{ t: 'string', v: 'b' }, { t: 'int', v: 2 }],
    ]]);
  });

  test('edge properties store into the normalized edge_properties table with vtype', () => {
    const store = fresh();
    executeQuery(store, "g.addV('p').as('a').addV('p').as('b').addE('knows').from('a').to('b').property('weight',0.5)", {});
    expect(store.query("SELECT edge, key, value, vtype FROM edge_properties")).toEqual([{ edge: 1, key: 'weight', value: 0.5, vtype: 'double' }]);
    // the flat edges.props blob is retired — reading a value goes through edge_properties.
    expect(executeQuery(store, "g.E().hasLabel('knows').values('weight')", {})).toHaveLength(1);
  });

  test('has(k, typeOf(X)) matches the stored vtype — the storage-class wall falls', () => {
    const store = fresh();
    executeQuery(store, "g.addV('t').property('when',datetime('2024-01-01T00:00:00Z')).property('nick',['a','b']).property('flag',true).property('gid',UUID('0-1')).property('age',30).property('big',5L)", {});
    const n = (g: string) => executeQuery(store, g, {}).length;
    // datetime/list/boolean/uuid were all indistinguishable from int/text/long by
    // storage class alone (folded to false); the stored vtype now answers them.
    expect(n("g.V().has('when', typeOf(GType.DATETIME))")).toBe(1);
    expect(n("g.V().has('nick', typeOf(GType.LIST))")).toBe(1);
    expect(n("g.V().has('flag', typeOf(GType.BOOLEAN))")).toBe(1);
    expect(n("g.V().has('gid', typeOf(GType.UUID))")).toBe(1);
    // numeric subtypes are distinguishable now: 30 is int, 5L is long.
    expect(n("g.V().has('age', typeOf(GType.INT))")).toBe(1);
    expect(n("g.V().has('age', typeOf(GType.LONG))")).toBe(0);
    expect(n("g.V().has('big', typeOf(GType.LONG))")).toBe(1);
    expect(n("g.V().has('when', typeOf(GType.LONG))")).toBe(0);
    // a non-value GType folds to false; a bogus name still raises.
    expect(n("g.V().has('age', typeOf(GType.VERTEX))")).toBe(0);
    expect(() => compile("g.V().has('age', typeOf('bogus-name'))", {})).toThrow('unregistered type');
  });

  test('values(k).is(typeOf(X)) tests the per-row stored vtype', () => {
    const store = fresh();
    executeQuery(store, "g.addV('t').property('age',30).property('big',5L).property('when',datetime('2024-01-01T00:00:00Z')).property('nm','x')", {});
    const n = (g: string) => executeQuery(store, g, {}).length;
    expect(n("g.V().values('age').is(typeOf(GType.INT))")).toBe(1);
    expect(n("g.V().values('age').is(typeOf(GType.LONG))")).toBe(0); // int, not long
    expect(n("g.V().values('big').is(typeOf(GType.LONG))")).toBe(1);
    expect(n("g.V().values('when').is(typeOf(GType.DATETIME))")).toBe(1);
    expect(n("g.V().values('nm').is(typeOf(GType.STRING))")).toBe(1);
    // the per-row vtype survives a row-preserving order() before the typeOf test
    expect(n("g.V().values('age').order().is(typeOf(GType.INT))")).toBe(1);
    // a cast makes the type compile-known → static fold (asNumber → long)
    expect(n("g.V().values('when').asNumber(GType.LONG).is(typeOf(GType.LONG))")).toBe(1);
  });

  test('scalar aliases preserve stored types through history, select(), records, and list members', async () => {
    const store = fresh();
    executeQuery(store, "g.addV('t').property('gid',UUID('0-1')).property('when',datetime('2024-01-01T00:00:00Z')).property('big',9007199254740993L)", {});
    const decoded = async (g: string) => decodeAll(executeQuery(store, g, {}));

    // All three values begin as values()' per-row storage channel. `as()` must put
    // the concrete tag into each JSON history entry so select() does not infer UUID/
    // datetime/Long from their indistinguishable JS representations.
    expect(await decoded("g.V().values('gid').as('x').select('x')")).toEqual(await decoded("g.V().values('gid')"));
    expect(await decoded("g.V().values('when').as('x').select('x')")).toEqual(await decoded("g.V().values('when')"));
    expect(await decoded("g.V().values('big').as('x').select('x')")).toEqual(await decoded("g.V().values('big')"));

    // A record field is another scalar framing boundary; it gets a fresh prefixed
    // vtype column rather than relying on raw JS inference.
    const record = (await decoded("g.V().as('v').values('gid').as('x').select('v','x')"))[0] as Map<string, unknown>;
    expect(record).toBeInstanceOf(Map);
    expect(record.get('x')).toEqual((await decoded("g.V().values('gid')"))[0]);

    // A folded list carries its member descriptor through its alias entry, so select
    // returns a typed list that frames the original UUID rather than a plain string.
    expect(await decoded("g.V().values('gid').fold().as('xs').select('xs')")).toEqual([
      await decoded("g.V().values('gid')"),
    ]);
  });

  test('has(edgeKey, typeOf(X)) matches the stored edge vtype', () => {
    const store = fresh();
    executeQuery(store, "g.addV('p').as('a').addV('p').as('b').addE('knows').from('a').to('b').property('weight',0.5)", {});
    expect(executeQuery(store, "g.E().has('weight', typeOf(GType.DOUBLE))", {})).toHaveLength(1);
    expect(executeQuery(store, "g.E().has('weight', typeOf(GType.LONG))", {})).toHaveLength(0);
  });

  test('the wire is the truth: a bound param keeps its GraphBinary DataType', async () => {
    const store = fresh();
    // 5e9 is out of int32 range → the client serializes it as a GraphBinary Long. The
    // stored vtype must be 'long' (JS-value inference would wrongly guess 'int').
    const bindings = new Map<any, any>([['n', 5_000_000_000], ['s', 'hi']]);
    const fields = new Map<any, any>([['bindings', bindings]]);
    const raw = Buffer.concat([
      Buffer.from([0x84]),
      ioc.mapSerializer.serialize(fields, false),
      ioc.stringSerializer.serialize("g.addV('t').property('big',n).property('txt',s)", false),
    ]);
    const parsed = await parseRequest(raw);
    expect(parsed.paramTypes).toEqual({ n: 'long', s: 'string' });
    executeQuery(store, parsed.gremlin, parsed.params, parsed.paramTypes);
    const got = Object.fromEntries(vprops(store, ['big', 'txt']).map((r) => [r.key, r.vtype]));
    expect(got).toEqual({ big: 'long', txt: 'string' });
    // Without the wire types, the write infers from the JS value. 5e9 is out of int32 range,
    // so magnitude-based inference correctly gives 'long' too (and, crucially, doesn't tag it
    // 'int' — which would overflow the strict Int framer). The genuinely-lossy inference cases
    // (a small long, a uuid, a datetime — indistinguishable from int/string by JS value) are
    // covered elsewhere; the wire type is what recovers those.
    const store2 = fresh();
    executeQuery(store2, parsed.gremlin, parsed.params, {});
    expect(store2.query<{ vtype: string }>("SELECT vtype FROM vertex_properties WHERE key='big'")[0].vtype).toBe('long');
  });
});
