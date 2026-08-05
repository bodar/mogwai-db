import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { CfLimitedSql, CF_MAX_BINDS, CF_MAX_SQL_BYTES, cfLimitViolation } from '../src/cf-limits.ts';
import { executeQuery } from './support/executor.ts';
import { compile } from '../src/compiler/compiler.ts';
import { landForeignElements } from '../src/compiler/steps/tail/foreign.ts';
import { materializeRootStream } from '../src/compiler/steps/tail/materialize.ts';
import { LoweringEngine } from '../src/compiler/engine/engine.ts';
import { createAppScope, createRequestScope } from '../src/scopes.ts';
import type { ForeignRow } from '../src/services/spi/types.ts';
import { rootLayout, type LoweringState } from '../src/compiler/steps/context/context.ts';

// The CF-parity harness (src/cf-limits.ts) and the walls it exists to make visible.
//
// Cloudflare DO SQLite rejects a statement carrying more than 100 bound parameters; bun:sqlite
// accepts 65,535. So a bind list whose length scales with ROW COUNT is green in every suite here
// and broken in production, on the ONE runtime we ship to. This file is where that asymmetry stops
// being invisible: it asserts the decorator's own contract, and then runs the two paths that were
// breaching it (docs/archive/2026-07-31-bulk-transfer-and-io-substrate-plan.md §1c/§1d) at a cardinality
// far past the cap, under a store that fails on the statement a DO would reject.
//
// Both are now DO-legal — drop() chunks through RowBatch, and a federated landing rides one JSON
// bind — so these read as ordinary behaviour tests. What makes them regression gates is the store
// they run against: the same traversal under a plain BunSqlite would pass either way.

const limited = () => new GraphStore(new CfLimitedSql(new BunSqlite(':memory:')));

describe('cfLimitViolation — the DO statement contract', () => {
  test(`${CF_MAX_BINDS} binds is legal, one more is not`, () => {
    const at = Array.from({ length: CF_MAX_BINDS }, (_, i) => i);
    expect(cfLimitViolation(`SELECT ${at.map(() => '?').join(',')}`, at)).toBeNull();
    const over = [...at, 100];
    expect(cfLimitViolation('SELECT ?', over)).toMatch(/exceeds Cloudflare's 100-bound-parameter limit: 101 binds/);
  });

  test('statement text is capped in BYTES, not characters', () => {
    // Just under the cap in characters but over it in UTF-8 bytes: a multibyte literal is exactly
    // the case a `sql.length` check would wave through.
    const multibyte = `SELECT '${'é'.repeat(CF_MAX_SQL_BYTES - 100)}'`;
    expect(multibyte.length).toBeLessThan(CF_MAX_SQL_BYTES);
    expect(cfLimitViolation(multibyte, [])).toMatch(/exceeds Cloudflare's \d+-byte text limit/);
    expect(cfLimitViolation('SELECT 1', [])).toBeNull();
  });

  test('the decorator gates query() and exec(), and passes ordinary traffic through', () => {
    const store = limited();
    executeQuery(store, "g.addV('person').property('name','marko')", {});
    expect(store.query<{ v: string }>('SELECT value AS v FROM vertex_properties').map((r) => r.v)).toEqual(['marko']);
    const sql = new CfLimitedSql(new BunSqlite(':memory:'));
    expect(() => sql.query(`SELECT ${Array.from({ length: 101 }, () => '?').join(',')}`, Array(101).fill(1)))
      .toThrow(/bound-parameter limit/);
    expect(() => sql.exec(`CREATE TABLE t(${'x'.repeat(CF_MAX_SQL_BYTES)})`)).toThrow(/byte text limit/);
  });
});

/**
 * These walls are only observable at HUNDREDS of rows — that is the point of them — so each test below
 * runs hundreds of compiles and statements, and bun's default 5s per-test budget is a unit-test budget.
 * Standalone the whole file finishes in ~3.6s and the default never bites; inside `mise run ci` it does,
 * because the suite shares a machine with `build`, `sql-hygiene` and the rest of `test`. An explicit
 * budget states "slow BY CONSTRUCTION" instead of leaving a load-sensitive flake that reports as a
 * different victim each run — measured: three red `ci` runs, three different tests, all green standalone.
 */
const ROW_SCALE_TIMEOUT_MS = 30_000;

// Was the wall of plan doc §1d: `ids.map(() => '?')`, spliced TWICE for `src IN (…) OR tgt IN (…)`,
// so a DO refused the statement past 50 vertices — and the FTS owner sweep refused it past 99 edges.
describe('drop() cascades in DO-legal chunks whatever the target count', () => {
  test('250 vertices with properties and incident edges', () => {
    const store = limited();
    for (let i = 1; i <= 250; i++) executeQuery(store, `g.addV('person').property('name','p${i}')`, {});
    for (let i = 2; i <= 250; i++) executeQuery(store, `g.addE('knows').from(__.V(1)).to(__.V(${i}))`, {});
    executeQuery(store, 'g.V().drop()', {});
    for (const t of ['nodes', 'edges', 'vertex_properties', 'vertex_labels', 'property_fts'])
      expect([t, store.query<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)[0].n]).toEqual([t, 0]);
  }, ROW_SCALE_TIMEOUT_MS);

  test('250 edges dropped on their own leaves the vertices and sweeps their FTS rows', () => {
    const store = limited();
    executeQuery(store, "g.addV('person')", {});
    executeQuery(store, "g.addV('person')", {});
    for (let i = 0; i < 250; i++) executeQuery(store, `g.addE('knows').from(__.V(1)).to(__.V(2)).property('note','n${i}')`, {});
    executeQuery(store, 'g.E().drop()', {});
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM edges')[0].n).toBe(0);
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM edge_properties')[0].n).toBe(0);
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM property_fts')[0].n).toBe(0);
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM nodes')[0].n).toBe(2);
  }, ROW_SCALE_TIMEOUT_MS);
});

// Was the wall of plan doc §1c: four binds per landed cell, so a federated result of 26 vertices
// could not execute on a DO. The whole set now rides as ONE bind and json_each explodes it.
describe('a federated landing binds the whole result set once', () => {
  const vrow = (id: number): ForeignRow =>
    ({ kind: 'vertex', id, label: 'person', labels: ['person'], props: { name: [{ t: 'string', v: `v${id}` }] } });

  const landAndCount = (n: number) => {
    const engine = new LoweringEngine(createRequestScope(createAppScope(), { params: {} }));
    const c: LoweringState = { q: engine.q, params: {}, traverserLayout: rootLayout() };
    const seed = landForeignElements(c, Array.from({ length: n }, (_, i) => vrow(i + 1)), 'vertex');
    const plan = materializeRootStream(engine.lowerStepsStrict(seed, [], 0));
    if (plan.kind !== 'read') throw new Error('expected read plan');
    return plan;
  };

  test('500 landed vertices are one bind, and the statement runs on a DO-legal store', () => {
    const store = limited();
    const plan = landAndCount(500);
    expect(plan.binds.length).toBe(1);
    expect(store.query(plan.sql, plan.binds).length).toBe(500);
  }, ROW_SCALE_TIMEOUT_MS);

  test('an empty result set lands as a zero-row relation (no special-case branch)', () => {
    const plan = landAndCount(0);
    expect(limited().query(plan.sql, plan.binds)).toEqual([]);
  });
});

// The third exposure of plan doc §1d: `within(<set>)` binds one ? per member, and the member count
// is DATA-shaped for a bound-param collection and for a federate hop's distinct injected keys.
describe('a data-sized within() set rides one JSON bind', () => {
  test('within() over 300 values compiles to a DO-legal statement and still matches', () => {
    const store = limited();
    for (let i = 1; i <= 5; i++) executeQuery(store, `g.addV('person').property('name','p${i}')`, {});
    const many = Array.from({ length: 300 }, (_, i) => `p${i + 1}`);
    const plan = compile('g.V().has("name", within(names)).count()', { names: many });
    if (plan.kind !== 'read') throw new Error('expected read plan');
    expect(plan.binds.length).toBeLessThanOrEqual(CF_MAX_BINDS);
    expect(store.query<{ v: number }>(plan.sql, plan.binds)[0].v).toBe(5);
  }, ROW_SCALE_TIMEOUT_MS);

  test('a small set keeps the IN-list form (one bind per member)', () => {
    const plan = compile('g.V().has("name", within("a","b","c")).count()', {});
    if (plan.kind !== 'read') throw new Error('expected read plan');
    expect(plan.binds.filter((b) => typeof b === 'string' && 'abc'.includes(b)).length).toBe(3);
  });
});
