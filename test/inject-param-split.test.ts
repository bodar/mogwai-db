import { test, expect, describe, beforeAll } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { CfLimitedSql, CF_MAX_VALUE_BYTES } from '../src/cf-limits.ts';
import { utf8Bytes } from '../src/do-limits.ts';
import { jsonArrayMembers, jsonChunks, jsonTextChunks } from '../src/json-chunks.ts';
import { stringifyExact } from '../src/json-exact.ts';
import { RaisedByQuery } from '../src/rel/raise.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { loadBulk, type BulkVertex } from '../src/bulk.ts';
import { compile } from '../src/compiler/compiler.ts';
import { executeQuery } from './support/executor.ts';
import { decode } from './support/decode.ts';

// A COLLECTION PARAMETER THAT IS UNFOLDED IS A DATA-SIZED SET — so past one Durable Object value (2 MB) it
// splits like `within($xs)` and `V($ids)` already do.
//
// `inject($xs).unfold()` explodes ONE cell of a one-row VALUES, and that is the same relation as
// `json_each($xs)`: a fact of the algebra, stated once in the one explode every `unfold()` arm goes through
// (`explodeMembers`, `src/compiler/rel/build.ts`), which hands the parameter to the one data-sized-set
// builder (`jsonEachRelation`). Before, the whole list crossed as one bind, and a DO refused it on the SIZE
// of what the client sent — green on Bun. Everything here runs under `CfLimitedSql`, so a value past the cap
// fails here exactly as it would on a DO: the limited store IS the regression gate.

const limited = () => new GraphStore(new CfLimitedSql(new BunSqlite(':memory:')));
const SCALE_TIMEOUT_MS = 60_000;
/** A member of ~`bytes` bytes that sorts by `i`. */
const wide = (i: number, bytes = 500) => `${String(i).padStart(6, '0')}-${'w'.repeat(bytes - 7)}`;
const run = (store: GraphStore, q: string, params: Record<string, unknown>) =>
  Promise.all(executeQuery(store, q, params).map((buf) => decode(buf)));
/** The error a query fails with, or null — `executeQuery` throws SYNCHRONOUSLY, so it is caught here too. */
const failure = async (store: GraphStore, q: string, params: Record<string, unknown>): Promise<unknown> => {
  try { await run(store, q, params); return null; } catch (e) { return e; }
};

const N = 8_000;
const xs = Array.from({ length: N }, (_, i) => wide(i));
const ys = Array.from({ length: N }, (_, i) => wide(N + i));
const m = new Map(xs.map((x, i) => [x, i]));

describe('the spelled-array packer', () => {
  test('cuts a JSON array text into its members verbatim — strings, escapes and nesting are not boundaries', () => {
    const members = ['a,b', 'q"uo\\"te', '[x,y]', '{"k":[1,2]}', 'é'];
    const nested = [1.0, 2.5, [3, [4, 5]], { a: 'b,c', d: [6] }, null, true, 'str"]'];
    expect(jsonArrayMembers(stringifyExact(members))).toEqual(members.map((s) => stringifyExact(s)));
    expect(jsonArrayMembers(stringifyExact(nested))).toEqual(nested.map((v) => stringifyExact(v)));
    expect(jsonArrayMembers('[]')).toEqual([]);
    // A writer's own spelling survives: `1.0` is NOT re-spelled `1` (a Double stays a Double).
    expect(jsonArrayMembers('[1.0,{"t":"double","v":2.0}]')).toEqual(['1.0', '{"t":"double","v":2.0}']);
  });

  test('a spelled array packs to the SAME chunks as its values do — so two uses of one parameter share binds', () => {
    expect(jsonTextChunks(stringifyExact(xs))).toEqual(jsonChunks(xs));
    expect(jsonTextChunks('[1.0,2]')).toEqual([{ text: '[1.0,2]', offset: 0 }]);
    const doubles = `[${Array.from({ length: 600_000 }, () => '1.0').join(',')}]`;
    const chunks = jsonTextChunks(doubles);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(utf8Bytes(chunk.text)).toBeLessThanOrEqual(CF_MAX_VALUE_BYTES);
    expect(chunks.every((chunk) => /^\[1\.0(,1\.0)*\]$/.test(chunk.text))).toBe(true);
  });
});

describe('an unfolded collection PARAMETER past one DO value', () => {
  test('its payload is past the cap', () => {
    expect(utf8Bytes(stringifyExact(xs))).toBeGreaterThan(CF_MAX_VALUE_BYTES);
  });

  test('inject($xs).unfold().count() answers every member, over one bind per chunk', async () => {
    const p = compile('g.inject(xs).unfold().count()', { xs });
    if (p.kind !== 'read') throw new Error('expected a read plan');
    expect(p.binds.length).toBe(jsonChunks(xs).length);
    expect(p.binds.length).toBeGreaterThan(1);
    expect(await run(limited(), 'g.inject(xs).unfold().count()', { xs })).toEqual([N]);
  }, SCALE_TIMEOUT_MS);

  test('a slice over a multi-chunk set takes its members from the right POSITIONS', async () => {
    const store = limited();
    expect(await run(store, 'g.inject(xs).unfold().limit(3)', { xs })).toEqual(xs.slice(0, 3));
    expect(await run(store, 'g.inject(xs).unfold().tail(3)', { xs })).toEqual(xs.slice(-3));
    // A window that straddles a chunk boundary, wherever it falls.
    const first = JSON.parse(jsonChunks(xs)[0]!.text).length;
    expect(await run(store, `g.inject(xs).unfold().range(${first - 2}, ${first + 2})`, { xs })).toEqual(xs.slice(first - 2, first + 2));
    expect(await run(store, 'g.inject(xs).unfold().fold().unfold().tail(1)', { xs })).toEqual([xs[N - 1]]);
  }, SCALE_TIMEOUT_MS);

  test('several list traversers keep inject order, each split on its own', async () => {
    const store = limited();
    expect(await run(store, 'g.inject(xs, ys).unfold().count()', { xs, ys })).toEqual([2 * N]);
    expect(await run(store, 'g.inject(xs, ys).unfold().tail(2)', { xs, ys })).toEqual(ys.slice(-2));
  }, SCALE_TIMEOUT_MS);

  test('a MAP parameter unfolds to every entry', async () => {
    const store = limited();
    expect(await run(store, 'g.inject(m).unfold().count()', { m })).toEqual([N]);
    expect(await run(store, 'g.inject(m).unfold().select(values).sum()', { m })).toEqual([(N * (N - 1)) / 2]);
    expect(await run(store, 'g.inject(m).unfold().select(keys).tail(1)', { m })).toEqual([xs[N - 1]]);
  }, SCALE_TIMEOUT_MS);

  test('it composes: a filter, a branch, a label, a dedup and a within($xs) of the same parameter', async () => {
    const store = limited();
    expect(await run(store, "g.inject(xs).unfold().is(gt('004000')).count()", { xs })).toEqual([N - 4_000]);
    expect(await run(store, "g.inject(xs).unfold().choose(is(gt('004')), constant(1), constant(0)).sum()", { xs })).toEqual([N - 4_000]);
    expect(await run(store, "g.inject(xs).unfold().as('a').select('a').dedup().count()", { xs })).toEqual([N]);
    expect(await run(store, 'g.inject(xs).unfold().where(is(within(xs))).count()', { xs })).toEqual([N]);
  }, SCALE_TIMEOUT_MS);

  test('under the cap the plan is EXACTLY the one explode it always was', () => {
    const small = compile('g.inject(xs).unfold().count()', { xs: ['a', 'b'] });
    if (small.kind !== 'read') throw new Error('expected a read plan');
    expect(small.sql).toBe('SELECT agg5.v AS v FROM (SELECT count(1) AS v FROM (SELECT ex1.value AS v, row_number() OVER (ORDER BY ex1.key ASC) AS encounter FROM (VALUES (jsonb(?))) inl0 CROSS JOIN json_each(inl0.column1) ex1) ro4) agg5');
    expect(small.binds).toEqual(['["a","b"]']);
    const map = compile('g.inject(m).unfold()', { m: new Map([['a', 1]]) });
    if (map.kind !== 'read') throw new Error('expected a read plan');
    expect(map.sql).toBe('WITH r8 AS (SELECT injm0.column1 AS map FROM (VALUES (jsonb(?))) injm0) SELECT json(ro5.mk) AS mk, json(ro5.mv) AS mv FROM (SELECT json_extract(ex2.value, \'$[0]\') AS mk, json_extract(ex2.value, \'$[1]\') AS mv, row_number() OVER (ORDER BY ex2.key ASC) AS encounter FROM r8 fm1 CROSS JOIN json_each(fm1.map) ex2) ro5 ORDER BY ro5.encounter ASC');
    expect(map.binds.length).toBe(1);
  });
});

// What is LEFT once every set splits is ONE value — and the message says which kind the user hit.
describe('one value past the cap is a clear platform-limit error that says what it was', () => {
  const big = 'b'.repeat(3 * 1024 * 1024);
  const SENT = /a single value is larger than this graph's storage can hold \(a Durable Object's SQLite caps one string or JSON value at 2 MB\) — this query hands storage one value of that size whole/;
  const COMPUTED = /a single value is larger than this graph's storage can hold \(a Durable Object's SQLite caps one string or JSON value at 2 MB\) — this traversal builds one value of that size: a fold\(\)/;

  test('a single 3 MB property value is one value SENT whole', async () => {
    const error = await failure(limited(), "g.addV('doc').property('body', b)", { b: big });
    expect(error).toBeInstanceOf(RaisedByQuery);
    expect((error as Error).message).toMatch(SENT);
  });

  test('a list parameter a step reads WHOLE (count(local)) is one value sent whole', async () => {
    const error = await failure(limited(), 'g.inject(xs).count(local)', { xs });
    expect(error).toBeInstanceOf(RaisedByQuery);
    expect((error as Error).message).toMatch(SENT);
  }, SCALE_TIMEOUT_MS);

  // `CfLimitedSql` sees only binds and statement text — a value SQLite BUILDS past the cap only a real DO
  // refuses (`src/cf-limits.ts`). So the computed half is checked at the store's own mapping, over a driver
  // that refuses a built value the way a DO does.
  test('a value SQLite built past the cap (no bind that large) is one value the traversal COMPUTED', () => {
    const refusing = new BunSqlite(':memory:');
    const query = refusing.query.bind(refusing);
    refusing.query = <T>(sql: string, binds?: readonly unknown[]): T[] => {
      if (sql.includes('json_group_array')) throw new Error('string or blob too big: SQLITE_TOOBIG');
      return query<T>(sql, binds);
    };
    const store = new GraphStore(refusing);
    const attempt = (bind: string): unknown => {
      try { store.query('SELECT json_group_array(?) AS v', [bind]); return null; } catch (e) { return e; }
    };
    expect(attempt('small')).toBeInstanceOf(RaisedByQuery);
    expect((attempt('small') as Error).message).toMatch(COMPUTED);
    expect((attempt(big) as Error).message).toMatch(SENT);
  });
});

// The federate per-parent injection sends its parents as ONE `inject($map)` parameter that the sibling
// unfolds — the same explode, so it splits with no federate-specific code. Sized past the cap with few
// parents: the sibling's per-key `has(k, select(values))` is still a scan per key (filed in
// docs/outstanding-work.md), so a test at 8k parents would measure that, not this.
describe('federate injection of parents past one DO value', () => {
  const P = 2_500;
  const name = (i: number) => wide(i, 1_000);
  const mgr = new BunGraphManager(undefined, extendedRegistry, undefined, undefined, (source) => new CfLimitedSql(new BunSqlite(source)));
  beforeAll(() => {
    const people = Array.from({ length: P }, (_, i): BulkVertex => ({ labels: ['p'], properties: [{ key: 'name', value: name(i) }] }));
    for (let at = 0; at < P; at += 1_000) {
      loadBulk(mgr.storeOf('home'), people.slice(at, at + 1_000));
      loadBulk(mgr.storeOf('x'), people.slice(at, at + 1_000));
    }
  });

  test('every parent is matched on the sibling', async () => {
    expect(utf8Bytes(stringifyExact(Array.from({ length: P }, (_, i) => name(i))))).toBeGreaterThan(CF_MAX_VALUE_BYTES);
    const q = "g.V().hasLabel('p').values('name').as('e').call('federate',['graph':'x']).V().has('name', select('e')).count()";
    const got = await Promise.all((await mgr.executor('home').framedAsync(q, {})).map((f) => decode(f.buf)));
    expect(got).toEqual([P]);
  }, SCALE_TIMEOUT_MS);
});
