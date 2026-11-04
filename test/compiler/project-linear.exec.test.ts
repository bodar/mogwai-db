// `project()`'s SQL text is LINEAR in its keys — the record accumulator names its input ONCE.
//
// The bug this pins was a TEXT-SIZE wall, not a bind wall: no user parameter is involved and every key is
// a constant. `recordPairs` (`src/compiler/rel/record.ts`) builds the map with one `json_insert` per
// field, and an OPTIONAL field (any `by('age')`, unproductive on a software vertex) was spelled
// `CASE WHEN present THEN json_insert(acc, …) ELSE acc END`. The emitter expands a shared `Expr` as a
// tree, so `acc` was written out twice per optional field and the statement DOUBLED per key: nine
// alternating `by('age')`/`by('name')` keys were 371 KB — over a Durable Object's 100 KB statement cap,
// so a bun:sqlite test passed and production refused — and twenty keys never finished compiling. The
// condition now selects the json_insert PATH (`$[#]` appends, `$` is a no-op), so `acc` is named once.
//
// Every run is against a `CfLimitedSql` store, so a statement a Durable Object would reject fails here.
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { CfLimitedSql, CF_MAX_SQL_BYTES } from '../../src/cf-limits.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';
import { bagOf } from '../support/harness.ts';

const store = new GraphStore(new CfLimitedSql(new BunSqlite(':memory:')));
for (const q of MODERN_SEED) executeQuery(store, q);
const plain = (v: unknown): unknown =>
  v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)]))
    : Array.isArray(v) ? v.map(plain)
      : v;
const values = async (g: string) => (await decodeAll(executeQuery(store, g))).map(plain);
const sqlBytes = (g: string): number => {
  const p = compile(g, {});
  if (p.kind !== 'read') throw new Error('expected a read plan');
  return p.sql.length;
};

/** The modern graph's vertices — `age` is absent on the two software vertices. */
const VERTICES: readonly { readonly name: string; readonly age?: number }[] = [
  { name: 'marko', age: 29 }, { name: 'vadas', age: 27 }, { name: 'lop' },
  { name: 'josh', age: 32 }, { name: 'ripple' }, { name: 'peter', age: 35 },
];

/** `project('k0',…,'k{n-1}')` with the `by()`s alternating — `first` on even keys, `second` on odd. */
const project = (n: number, first: 'name' | 'age', second: 'name' | 'age'): string =>
  `project(${Array.from({ length: n }, (_, i) => `'k${i}'`).join(',')})`
  + Array.from({ length: n }, (_, i) => `.by('${i % 2 ? second : first}')`).join('');

/** The map `project(n, first, second)` gives one vertex: an unproductive `by('age')` OMITS its key —
 *  `ProjectStep.map`'s `ifProductive(p -> end.put(…))`
 *  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ProjectStep.java`). */
const expected = (n: number, first: 'name' | 'age', second: 'name' | 'age', v: (typeof VERTICES)[number]) => {
  const map: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    const value = v[i % 2 ? second : first];
    if (value !== undefined) map[`k${i}`] = value;
  }
  return map;
};

describe('project() — SQL text is linear in the number of keys', () => {
  test('the two-key witness omits age on software rows (not null)', async () => {
    const rows = await values("g.V().project('a','b').by('age').by('name')") as Record<string, unknown>[];
    expect(bagOf(rows)).toEqual(bagOf(VERTICES.map((v) => (v.age === undefined ? { b: v.name } : { a: v.age, b: v.name }))));
    for (const row of rows.filter((r) => r.b === 'lop' || r.b === 'ripple')) expect('a' in row).toBe(false);
  });

  for (const n of [20, 24]) {
    test(`${n} keys run under the Durable Object caps and answer exactly`, async () => {
      const q = `g.V().${project(n, 'name', 'age')}`;
      expect(sqlBytes(q)).toBeLessThan(CF_MAX_SQL_BYTES);
      expect(bagOf(await values(q))).toEqual(bagOf(VERTICES.map((v) => expected(n, 'name', 'age', v))));
    });
  }

  test('the record nested in a by() — the correlated field-read form — at 20 keys', async () => {
    const inner = project(20, 'age', 'name');
    const q = `g.V().project('x').by(__.${inner})`;
    expect(sqlBytes(q)).toBeLessThan(CF_MAX_SQL_BYTES);
    expect(bagOf(await values(q))).toEqual(bagOf(VERTICES.map((v) => ({ x: expected(20, 'age', 'name', v) }))));
  });

  test('group().by(label).by(project(20 keys).fold()) — a record inside a grouped value', async () => {
    const q = `g.V().group().by(label).by(__.${project(20, 'name', 'age')}.fold())`;
    expect(sqlBytes(q)).toBeLessThan(CF_MAX_SQL_BYTES);
    const [grouped] = await values(q) as Record<string, unknown[]>[];
    const of = (names: string[]) => bagOf(VERTICES.filter((v) => names.includes(v.name)).map((v) => expected(20, 'name', 'age', v)));
    expect(bagOf(grouped!.person!)).toEqual(of(['marko', 'vadas', 'josh', 'peter']));
    expect(bagOf(grouped!.software!)).toEqual(of(['lop', 'ripple']));
  });

  test('groupCount().by(project(20 keys)) — a record as a group KEY', async () => {
    const q = `g.V().groupCount().by(__.${project(20, 'age', 'name')})`;
    expect(sqlBytes(q)).toBeLessThan(CF_MAX_SQL_BYTES);
    // A map key decodes as a Map; every vertex's projection is distinct, so each counts once.
    const [counts] = await decodeAll(executeQuery(store, q)) as Map<unknown, unknown>[];
    expect(bagOf([...counts!.keys()].map(plain))).toEqual(bagOf(VERTICES.map((v) => expected(20, 'age', 'name', v))));
    expect([...counts!.values()]).toEqual(VERTICES.map(() => 1));
  });

  test('a field whose by() may RAISE is still never evaluated into the map on an absent row', async () => {
    // The pair is now built on every row (the condition rides on the json_insert path); a field node that
    // carries a reference raise (`math()`'s Number check) is gated by its presence test instead.
    const q = "g.V().project('x').by(__.project('a','b').by('name').by(__.values('age').math('_+1')))";
    expect(bagOf(await values(q))).toEqual(bagOf(VERTICES.map((v) => ({ x: v.age === undefined ? { a: v.name } : { a: v.name, b: v.age + 1 } }))));
  });

  test('select() after a 20-key project() re-roots a field', async () => {
    const q = `g.V().${project(20, 'age', 'name')}.select('k18')`;
    expect(bagOf(await values(q))).toEqual(bagOf(VERTICES.flatMap((v) => (v.age === undefined ? [] : [v.age]))));
  });

  // The doubling grew ×2 per optional key; a linear statement grows ×2 per DOUBLING of keys, plus the
  // fixed scaffolding. 2.2× leaves room for that constant without admitting anything super-linear.
  for (const k of [8, 16, 32]) {
    test(`size(${2 * k} keys) <= 2.2 × size(${k} keys)`, () => {
      for (const shape of [(n: number) => `g.V().${project(n, 'age', 'name')}`,
        (n: number) => `g.V().group().by(label).by(__.${project(n, 'name', 'age')}.fold())`]) {
        expect(sqlBytes(shape(2 * k))).toBeLessThanOrEqual(2.2 * sqlBytes(shape(k)));
      }
    });
  }

  test('an absolute bytes-per-key ceiling', () => {
    // Measured ~1.1 KB/key at the top level and ~2 KB/key inside a group value; the ceiling is the
    // linear rate with headroom, so a constant-factor regression in the field node shows up too.
    expect(sqlBytes(`g.V().${project(64, 'age', 'name')}`) / 64).toBeLessThan(2 * 1024);
    expect(sqlBytes(`g.V().group().by(label).by(__.${project(64, 'name', 'age')}.fold())`) / 64).toBeLessThan(3 * 1024);
  });

  test('compile time is not exponential in the keys (secondary guard)', () => {
    const time = (n: number) => {
      const q = `g.V().${project(n, 'age', 'name')}`;
      compile(q, {});
      const start = performance.now();
      for (let i = 0; i < 3; i++) compile(q, {});
      return (performance.now() - start) / 3;
    };
    // Linear would be ~4×; the 2^k form was ~2^30× and never returned. 40× is a generous bound for a
    // noisy runner that still fails on anything super-linear by an order of magnitude.
    expect(time(40) / Math.max(time(10), 1)).toBeLessThan(40);
  });
});
