import { test, expect, describe, beforeAll } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { CfLimitedSql, CF_MAX_VALUE_BYTES } from '../src/cf-limits.ts';
import { utf8Bytes } from '../src/do-limits.ts';
import { deleteMembers, insertSet, markMembersDirty, updateSet, type SetColumn } from '../src/setwrite.ts';
import { BatchingLoader, loadBulk, type BulkVertex } from '../src/bulk.ts';
import { jsonEachRelation, meta, minter, typeOf } from '../src/compiler/rel/build.ts';
import { jsonChunks } from '../src/json-chunks.ts';
import { lit } from '../src/rel/expr.ts';
import * as make from '../src/rel/factory.ts';
import { lowerTypedNodeStream } from '../src/compiler/rel/lower.ts';
import { finishLowering } from '../src/compiler/rel/spine.ts';
import { compile } from '../src/compiler/compiler.ts';
import { runSteps } from '../src/program.ts';
import { fillHoles, jsonEachValues, keyedValue, q, render, runTimeHole, value } from '../src/sql/kernel/q.ts';
import { stringifyExact } from '../src/json-exact.ts';
import type { FrameNode } from '../src/gremlin/types.ts';
import { executeQuery } from './support/executor.ts';
import { decode } from './support/decode.ts';
import { read } from './support/harness.ts';

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

// RETAINED ROWS PAST ONE DO VALUE — packed at RUN time, because only then is their size known.
//
// A write is a program: its traversers (and a `property(k, <traversal>)`'s values) are RETAINED as one
// statement's rows and handed to every later statement as `json_each(?)` over one JSON value. Past 2 MB
// that value was a DO refusal at data size — `g.V().property('x', 1)` over ~100k vertices, or 8k × 500 B
// bodies copied by a `property()` — that no Bun store saw. The emitter leaves the source as a run-time
// HOLE (`runTimeHole`); the executor packs the rows with the one packer (`jsonChunks`) and re-spells the
// hole over as many values as it needs (`fillHoles`). Under the cap the statement is byte-identical.
describe('retained rows past one DO value', () => {
  const BIG = 120_000;
  /** A store that remembers each statement, so a test can see that a chunked spelling actually ran. */
  const recording = (inner: GraphStore) => {
    const issued: { sql: string; binds: readonly unknown[] }[] = [];
    return {
      issued,
      query: <T>(sql: string, binds: readonly unknown[] = []): T[] => { issued.push({ sql, binds }); return inner.query<T>(sql, binds); },
      atomically: <T>(fn: () => T): T => inner.atomically(fn),
    };
  };
  const program = (gremlin: string, params: Record<string, unknown> = {}) => {
    const p = compile(gremlin, params);
    if (p.kind !== 'program') throw new Error('expected a program');
    return p;
  };
  const CHUNKED = 'UNION ALL SELECT value FROM json_each(';
  const chunked = (issued: readonly { sql: string }[]) => issued.filter((s) => s.sql.includes(CHUNKED)).length;
  const bare = (store: GraphStore, n: number) => {
    for (let at = 0; at < n; at += 10_000) loadBulk(store, Array.from({ length: Math.min(10_000, n - at) }, (): BulkVertex => ({ labels: ['v'], properties: [] })));
    return store;
  };
  const docs = (store: GraphStore, n: number) => {
    for (let at = 0; at < n; at += 1_000)
      loadBulk(store, Array.from({ length: Math.min(1_000, n - at) }, (_, i): BulkVertex => ({ labels: ['doc'], properties: [{ key: 'body', value: wide(at + i) }] })));
    return store;
  };
  const answer = (store: GraphStore, gremlin: string, params: Record<string, unknown> = {}) => {
    const sink = recording(store);
    return { rows: [...runSteps(sink, program(gremlin, params))] as Record<string, unknown>[], issued: sink.issued };
  };

  test("g.V().property('x', 1) over 120k vertices writes every one, and the value reads back", () => {
    const store = bare(limited(), BIG);
    const { rows, issued } = answer(store, "g.V().property('x', 1).count()");
    expect(rows).toEqual([{ v: BIG }]);
    expect(chunked(issued)).toBeGreaterThan(0);
    expect(store.query("SELECT count(*) AS n, count(DISTINCT node) AS owners FROM vertex_properties WHERE key = 'x' AND value = 1"))
      .toEqual([{ n: BIG, owners: BIG }]);
    expect(store.query(read("g.V().has('x', 1).count()").sql, read("g.V().has('x', 1).count()").binds)).toEqual([{ v: BIG }]);
  }, SCALE_TIMEOUT_MS);

  test('a parameter used twice (NUMBERED placeholders) keeps its ordinal while the hole widens', () => {
    const store = bare(limited(), BIG);
    const { rows, issued } = answer(store, "g.V().property('x', p).has('x', p).count()", { p: 7 });
    expect(rows).toEqual([{ v: BIG }]);
    expect(issued.some((s) => /\?\d/.test(s.sql) && s.sql.includes(CHUNKED))).toBe(true);
  }, SCALE_TIMEOUT_MS);

  test('a multi-chunk echo answers in the order its retained encounter carries', () => {
    const store = bare(limited(), BIG);
    const fold = answer(store, "g.V().order().by(id, desc).property('x', 1).id().fold().limit(local, 3)");
    expect(chunked(fold.issued)).toBeGreaterThan(0);
    expect(JSON.parse(fold.rows[0]!.list as string)).toEqual([BIG, BIG - 1, BIG - 2]);
    const tail = answer(store, "g.V().order().by(id, desc).property('y', 1).id().tail(3)");
    expect(chunked(tail.issued)).toBeGreaterThan(0);
    expect(tail.rows.map((r) => r.v)).toEqual([3, 2, 1]);
  }, SCALE_TIMEOUT_MS);

  test("property('b2', values('body')) over 8k × 500 B copies every body", () => {
    const N = 8_000;
    const store = docs(limited(), N);
    const { rows, issued } = answer(store, "g.V().hasLabel('doc').property('b2', values('body')).count()");
    expect(rows).toEqual([{ v: N }]);
    expect(chunked(issued)).toBeGreaterThan(0);
    expect(store.query(`SELECT count(*) AS n FROM vertex_properties b JOIN vertex_properties c ON c.node = b.node AND c.key = 'b2'
      WHERE b.key = 'body' AND c.value = b.value`)).toEqual([{ n: N }]);
  }, SCALE_TIMEOUT_MS);

  test("addV('c').property('b', select('d').values('body')) over 8k × 500 B lands every body on a new vertex", () => {
    const N = 8_000;
    const store = docs(limited(), N);
    const { rows, issued } = answer(store, "g.V().hasLabel('doc').as('d').addV('c').property('b', select('d').values('body')).count()");
    expect(rows).toEqual([{ v: N }]);
    expect(chunked(issued)).toBeGreaterThan(0);
    expect(store.query(`SELECT count(*) AS n, count(DISTINCT value) AS distinct_values, min(value) AS lo, max(value) AS hi
      FROM vertex_properties WHERE key = 'b'`)).toEqual([{ n: N, distinct_values: N, lo: wide(0), hi: wide(N - 1) }]);
  }, SCALE_TIMEOUT_MS);

  test('under the cap every statement runs EXACTLY as rendered — same text, one bind per retained read', () => {
    const store = docs(limited(), 50);
    const p = program("g.V().hasLabel('doc').as('d').addV('c').property('b', select('d').values('body')).count()");
    const sink = recording(store);
    runSteps(sink, p);
    expect(sink.issued.map((s) => s.sql)).toEqual(p.steps.map((step) => step.emitted.sql));
    expect(sink.issued.map((s) => s.binds.length)).toEqual(p.steps.map((step) => step.emitted.binds.length));
    expect(p.steps.some((step) => step.emitted.holes?.length)).toBe(true);
  });
});

describe('the run-time hole', () => {
  const marker = { m: 1 };
  const statement = (keyed: boolean) => render(q`SELECT ${keyed ? keyedValue(5, 'p') : value(5)} AS a, r.value AS v FROM ${runTimeHole(jsonEachValues([marker]))} r WHERE ${keyed ? keyedValue(5, 'p') : value(6)} > 0`);
  const sqlite = () => new BunSqlite(':memory:');

  test('records where the source landed and fills it in place — anonymous placeholders', () => {
    const s = statement(false);
    expect(s.sql).toBe('SELECT ? AS a, r.value AS v FROM json_each(?) r WHERE ? > 0');
    expect(s.holes?.map((h) => ({ ...h, spelled: s.sql.slice(h.start, h.end) }))).toEqual([{ start: 33, end: 45, bind: 1, spelled: 'json_each(?)' }]);
    expect(fillHoles(s, () => jsonEachValues(['[1]']))).toEqual({ sql: s.sql, binds: [5, '[1]', 6] });
    const three = fillHoles(s, () => jsonEachValues(['[1]', '[2]', '[3]']));
    expect(three.binds).toEqual([5, '[1]', '[2]', '[3]', 6]);
    expect(sqlite().query(three.sql, three.binds)).toEqual([1, 2, 3].map((v) => ({ a: 5, v })));
  });

  test('under NUMBERED placeholders the hole keeps its ordinal and the extra values take fresh ones', () => {
    const s = statement(true);
    expect(s.sql).toBe('SELECT ?1 AS a, r.value AS v FROM json_each(?2) r WHERE ?1 > 0');
    expect(s.holes?.map((h) => ({ ...h, spelled: s.sql.slice(h.start, h.end) }))).toEqual([{ start: 34, end: 47, bind: 1, ordinal: 2, spelled: 'json_each(?2)' }]);
    expect(fillHoles(s, () => jsonEachValues(['[1]']))).toEqual({ sql: s.sql, binds: [5, '[1]'] });
    const three = fillHoles(s, () => jsonEachValues(['[1]', '[2]', '[3]']));
    expect(three.binds).toEqual([5, '[1]', '[2]', '[3]']);
    expect(sqlite().query(three.sql, three.binds)).toEqual([1, 2, 3].map((v) => ({ a: 5, v })));
  });
});
