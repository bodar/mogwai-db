import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { CfLimitedSql, CF_MAX_BINDS, CF_MAX_SQL_BYTES, cfLimitViolation } from '../src/cf-limits.ts';
import { executeQuery } from './support/executor.ts';
import { landForeignElements } from '../src/compiler/steps/tail/foreign.ts';
import { materializeRootStream } from '../src/compiler/steps/tail/materialize.ts';
import { LoweringEngine } from '../src/compiler/engine/engine.ts';
import { createAppScope, createCompilerScope } from '../src/scopes.ts';
import type { ForeignRow } from '../src/services/spi/types.ts';
import type { LoweringState } from '../src/compiler/steps/context/context.ts';

// The CF-parity harness (src/cf-limits.ts) and the two walls it exists to make visible.
//
// Cloudflare DO SQLite rejects a statement carrying more than 100 bound parameters; bun:sqlite
// accepts 65,535. So a bind list whose length scales with ROW COUNT is green in every suite here
// and broken in production, on the ONE runtime we ship to. This file is where that asymmetry stops
// being invisible: it asserts the decorator's own contract, and then pins the two shipped breaches
// (docs/2026-07-31-bulk-transfer-and-io-substrate-plan.md §1c/§1d) as failures ON BUN.
//
// Read the two "the wall" tests as measurements of a known defect, not as desired behaviour: each
// asserts today's breach and names the phase that flips it. When one starts failing because the
// path was fixed, the fix is to flip the assertion, not to widen the harness.

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

describe('the wall: g.V().drop() binds one ? per id (plan §1d, fixed in phase 2)', () => {
  test('50 vertices is the ceiling — 51 breaches, because src IN (…) OR tgt IN (…) binds ids twice', () => {
    const under = limited();
    for (let i = 0; i < 50; i++) executeQuery(under, "g.addV('person')", {});
    executeQuery(under, 'g.V().drop()', {});
    expect(under.query<{ n: number }>('SELECT count(*) AS n FROM nodes')[0].n).toBe(0);

    const over = limited();
    for (let i = 0; i < 51; i++) executeQuery(over, "g.addV('person')", {});
    expect(() => executeQuery(over, 'g.V().drop()', {})).toThrow(/bound-parameter limit: 102 binds/);
  });

  // The FTS cascade is the FIRST statement to blow on an edge drop — `deleteFtsForOwners`
  // (services/fts-index.ts) binds the owner kind plus one ? per owner id, so its ceiling is 99
  // edges where the `DELETE FROM edges` that follows it would reach 100.
  test('an edge drop breaches past 99 edges, in the FTS cascade before the edge delete', () => {
    const store = limited();
    executeQuery(store, "g.addV('person')", {});
    executeQuery(store, "g.addV('person')", {});
    for (let i = 0; i < 101; i++) executeQuery(store, 'g.addE("knows").from(__.V(1)).to(__.V(2))', {});
    expect(() => executeQuery(store, 'g.E().drop()', {}))
      .toThrow(/bound-parameter limit: 102 binds in DELETE FROM property_fts/);
  });
});

describe('the wall: landForeignElements binds 4 ? per foreign row (plan §1c, fixed in phase 2)', () => {
  const vrow = (id: number): ForeignRow =>
    ({ kind: 'vertex', id, label: 'person', labels: ['person'], props: { name: [{ t: 'string', v: `v${id}` }] } });

  const landAndCount = (n: number) => {
    const engine = new LoweringEngine(createAppScope(), createCompilerScope(createAppScope(), { params: {} }));
    const c: LoweringState = { q: engine.q, params: {}, traverserLayout: { aliases: new Map(), origins: [] } };
    const seed = landForeignElements(c, Array.from({ length: n }, (_, i) => vrow(i + 1)), 'vertex');
    const plan = materializeRootStream(engine.lowerStepsStrict(seed, [], 0));
    if (plan.kind !== 'read') throw new Error('expected read plan');
    return plan;
  };

  test('a federated result of 25 vertices is the ceiling; 26 cannot execute on a DO', () => {
    const store = limited();
    const ok = landAndCount(25);
    expect(ok.binds.length).toBe(100);
    expect(store.query(ok.sql, ok.binds).length).toBe(25);

    const wall = landAndCount(26);
    expect(wall.binds.length).toBe(104);
    expect(() => store.query(wall.sql, wall.binds)).toThrow(/bound-parameter limit: 104 binds/);
  });
});
