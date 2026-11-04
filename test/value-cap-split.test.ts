import { test, expect, describe, beforeAll } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { CfLimitedSql, CF_MAX_VALUE_BYTES } from '../src/cf-limits.ts';
import { utf8Bytes } from '../src/do-limits.ts';
import { deleteMembers, insertSet, markMembersDirty, updateSet, type SetColumn } from '../src/setwrite.ts';
import { BatchingLoader, loadBulk, type BulkVertex } from '../src/bulk.ts';
import { jsonChunks, jsonEachRelation, meta, minter, typeOf } from '../src/compiler/rel/build.ts';
import { lit } from '../src/rel/expr.ts';
import * as make from '../src/rel/factory.ts';
import { lowerTypedNodeStream } from '../src/compiler/rel/lower.ts';
import { finishLowering } from '../src/compiler/rel/spine.ts';
import { compile } from '../src/compiler/compiler.ts';
import { stringifyExact } from '../src/json-exact.ts';
import type { FrameNode } from '../src/gremlin/types.ts';
import { executeQuery } from './support/executor.ts';
import { decode } from './support/decode.ts';

// A DATA-SIZED SET PAST ONE DURABLE OBJECT VALUE (2 MB) STILL CROSSES — split at member boundaries.
//
// The bind-count rule puts every data-sized set into ONE `json_each(?)` value, which made that value's
// SIZE the next wall: a DO caps a string/BLOB value at 2 MB (`src/do-limits.ts`, measured on workerd), so
// an io() load of 6,000 × 500 B properties, a federated landing of 8,000 wide people, or a `within($xs)`
// parameter of a few thousand long names was refused in production and green on every Bun store. The
// ONE builder (`jsonEachRelation`, over the ONE packer `jsonChunks`) now splits such a set into several
// values under UNION ALL, keeping each member's position. Everything here runs under `CfLimitedSql`, so
// a value past the cap fails here exactly as it would on a DO — the limited store IS the regression gate.

const limited = () => new GraphStore(new CfLimitedSql(new BunSqlite(':memory:')));
const SCALE_TIMEOUT_MS = 60_000;
/** A member of ~`bytes` bytes that sorts by `i`. */
const wide = (i: number, bytes = 500) => `${String(i).padStart(6, '0')}-${'w'.repeat(bytes - 7)}`;

describe('the packer', () => {
  test('a set under the cap is ONE chunk spelled exactly as the whole array', () => {
    const members = [1, 'two', { t: 'map', v: [] }, null, [3.5]];
    expect(jsonChunks(members)).toEqual([{ text: stringifyExact(members), offset: 0 }]);
    expect(jsonChunks([])).toEqual([{ text: '[]', offset: 0 }]);
  });

  test('a set past the cap packs in order, every chunk within one DO value, offsets the members before it', () => {
    const members = Array.from({ length: 9_000 }, (_, i) => wide(i));
    const chunks = jsonChunks(members);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(utf8Bytes(chunk.text)).toBeLessThanOrEqual(CF_MAX_VALUE_BYTES);
    // Re-assembled in chunk order, the members are the input — none lost, duplicated or reordered.
    expect(chunks.flatMap((chunk) => JSON.parse(chunk.text))).toEqual(members);
    let before = 0;
    for (const chunk of chunks) { expect(chunk.offset).toBe(before); before += JSON.parse(chunk.text).length; }
  });

  test('bytes are UTF-8 bytes, not UTF-16 units — a multibyte set splits where a DO would refuse it', () => {
    // 'é' is 2 bytes; 1.2M of them is 2.4 MB but only 1.2M code units.
    const members = Array.from({ length: 1_200 }, () => 'é'.repeat(1_000));
    const chunks = jsonChunks(members);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) expect(utf8Bytes(chunk.text)).toBeLessThanOrEqual(CF_MAX_VALUE_BYTES);
  });

  test('a single member past the cap is its own chunk — it is not split', () => {
    const huge = 'h'.repeat(CF_MAX_VALUE_BYTES + 10);
    const chunks = jsonChunks(['a', huge, 'b']);
    expect(chunks.map((c) => JSON.parse(c.text))).toEqual([['a'], [huge], ['b']]);
  });
});

describe('the builder', () => {
  const spec = { id: 'fgx', as: { value: 'v', ord: 'o' }, type: typeOf(meta('v', 'any', true), meta('o', 'int')) } as const;

  test('under the cap it is EXACTLY the single explode every site always emitted', () => {
    const members = [[1, 'a'], [2, 'b']];
    expect(jsonEachRelation({ ...spec, members }, minter())).toEqual(make.explode({
      id: minter()('fgx'), channels: [], expr: lit(stringifyExact(members), 'text'), as: spec.as, type: spec.type,
    }));
  });

  test('the value stream statement is unchanged under the cap', () => {
    const p = finishLowering(lowerTypedNodeStream([{ t: 'string', v: 'x' } as FrameNode]));
    if (p.kind !== 'read') throw new Error('expected a read plan');
    expect(p.sql).toBe('SELECT json(fnx0.value) AS node FROM json_each(?) fnx0 ORDER BY fnx0.key ASC');
    expect(p.binds.length).toBe(1);
  });

  test('past the cap it is one bind per chunk, each a legal DO value, and the rows keep the emitted order', () => {
    const n = 9_000;
    // Emitted in DESCENDING order, so an answer sorted by value or by a per-chunk key would show.
    const nodes = Array.from({ length: n }, (_, i) => ({ t: 'string', v: wide(n - i) }) as FrameNode);
    const p = finishLowering(lowerTypedNodeStream(nodes));
    if (p.kind !== 'read') throw new Error('expected a read plan');
    expect(p.binds.length).toBe(jsonChunks(nodes).length);
    expect(p.binds.length).toBeGreaterThan(1);
    const rows = limited().query<{ node: string }>(p.sql, p.binds);
    expect(rows.map((r) => JSON.parse(r.node).v)).toEqual(nodes.map((node) => (node as { v: string }).v));
  }, SCALE_TIMEOUT_MS);
});

describe('a user collection PARAMETER past one DO value', () => {
  const N = 6_000;
  const names = Array.from({ length: N }, (_, i) => wide(i, 400));
  const store = limited();
  // Loaded in batches each under the cap, so these tests isolate the PARAMETER's split from the load's.
  beforeAll(() => {
    const vertices = names.map((name, i): BulkVertex => ({ id: `u-${wide(i, 400)}`, labels: ['p'], properties: [{ key: 'name', value: name }] }));
    for (let at = 0; at < N; at += 1_000) loadBulk(store, vertices.slice(at, at + 1_000));
  });
  const run = (q: string, params: Record<string, unknown>) => Promise.all(executeQuery(store, q, params).map((buf) => decode(buf)));

  test('its payload is past the cap', () => {
    expect(utf8Bytes(stringifyExact(names))).toBeGreaterThan(CF_MAX_VALUE_BYTES);
  });

  test('within($xs) answers every member', async () => {
    expect(await run("g.V().has('name', within(xs)).count()", { xs: names })).toEqual([N]);
    expect(await run("g.V().has('name', without(xs)).count()", { xs: names.slice(1) })).toEqual([1]);
  }, SCALE_TIMEOUT_MS);

  test('V($ids) over long string ids answers every member', async () => {
    const ids = names.map((_, i) => `u-${wide(i, 400)}`);
    expect(utf8Bytes(stringifyExact(ids))).toBeGreaterThan(CF_MAX_VALUE_BYTES);
    expect(await run('g.V(vs).count()', { vs: ids })).toEqual([N]);
  }, SCALE_TIMEOUT_MS);

  test('a parameter used twice binds its chunks ONCE, chunk for chunk', async () => {
    const q = "g.V().has('name', within(xs)).where(values('name').is(within(xs))).count()";
    const p = compile(q, { xs: names });
    if (p.kind !== 'read') throw new Error('expected a read plan');
    expect(p.binds.length).toBe(jsonChunks(names).length);
    expect(await run(q, { xs: names })).toEqual([N]);
  }, SCALE_TIMEOUT_MS);
});

describe('the set-based writes past one DO value', () => {
  const N = 6_000;
  const PROP: SetColumn[] = [
    { name: 'id', type: 'int' }, { name: 'node', type: 'int' }, { name: 'key', type: 'text' },
    { name: 'value', type: 'any' }, { name: 'vtype', type: 'text' }, { name: 'meta', type: 'blob', jsonb: true },
  ];
  const nodeRows = Array.from({ length: N }, (_, i) => [i + 1, null] as const);
  const propRows = Array.from({ length: N }, (_, i) => [i + 1, i + 1, 'body', wide(i), 'g:String', null] as const);

  test('insertSet, updateSet, markMembersDirty and deleteMembers each land every row', () => {
    const store = limited();
    expect(utf8Bytes(stringifyExact(propRows))).toBeGreaterThan(CF_MAX_VALUE_BYTES);
    insertSet(store, 'nodes', [{ name: 'id', type: 'int' }, { name: 'uid', type: 'text' }], nodeRows);
    insertSet(store, 'vertex_properties', PROP, propRows);
    expect(store.query('SELECT count(*) AS n, min(value) AS lo, max(value) AS hi FROM vertex_properties')).toEqual([
      { n: N, lo: wide(0), hi: wide(N - 1) },
    ]);
    // A key + one wide column per row, past the cap.
    updateSet(store, 'nodes', 'id', [{ name: 'uid', type: 'text' }], nodeRows.map(([id]) => [id, wide(id)]));
    expect(store.query('SELECT count(*) AS n FROM nodes WHERE uid = printf(\'%06d-\', id) || substr(uid, 8)')).toEqual([{ n: N }]);
    const longUids = nodeRows.map(([id]) => wide(id));
    markMembersDirty(store, 'nodes', 'uid', longUids);
    expect(store.query('SELECT count(*) AS n FROM nodes WHERE dirty = 2')).toEqual([{ n: N }]);
    deleteMembers(store, 'vertex_properties', 'value', propRows.slice(1).map((row) => row[3]));
    expect(store.query('SELECT value FROM vertex_properties')).toEqual([{ value: wide(0) }]);
  }, SCALE_TIMEOUT_MS);
});

describe('a bulk / io() load past one DO value per batch', () => {
  const N = 6_000;
  const vertices: BulkVertex[] = Array.from({ length: N }, (_, i) => ({ labels: ['doc'], properties: [{ key: 'body', value: wide(i) }] }));
  const check = (store: GraphStore) =>
    expect(store.query("SELECT count(*) AS n, min(value) AS lo, max(value) AS hi FROM vertex_properties WHERE key = 'body'"))
      .toEqual([{ n: N, lo: wide(0), hi: wide(N - 1) }]);

  test('loadBulk lands every vertex', () => {
    const store = limited();
    loadBulk(store, vertices);
    check(store);
  }, SCALE_TIMEOUT_MS);

  test('the streaming BatchingLoader (the io() read path) lands every vertex', () => {
    const store = limited();
    const loader = new BatchingLoader(store);
    for (const v of vertices) loader.vertex(v);
    expect(loader.done().vertices).toBe(N);
    check(store);
  }, SCALE_TIMEOUT_MS);
});
