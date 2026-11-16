// A `repeat(…).times(K)` UNROLLED INSIDE A PER-TRAVERSER HOST (`local`, `where`, `not`, a `count()` body…)
// fuses one join per iteration into ONE SQL SELECT, so its compile cost and its legality both follow K.
//
// Two defects, one family, and both are about the compile, never the data:
//
//  - COMPILE WORK QUADRATIC IN K. `freeRelIds` (src/rel/walk.ts) let `some` search the left child's whole
//    subtree (`definesId`) before it looked at the right child's id — the id a join's `on` reads — so each
//    link of the chain paid a search of every link beneath it. And the emitter merged every node's column
//    reads into a fresh map per level (`relReads`, src/rel/emit.ts). Measured on trunk:
//    `g.V(1).where(repeat(out()).times(2000)).count()` compiled for 5.5 s, then the store refused it.
//  - A FROM WIDER THAN SQLITE PLANS. SQLite refuses a SELECT joining more than 64 tables at prepare, on
//    every runtime (`at most 64 tables in a join`). That is a property of the query text, and the assembler
//    owns it: a join that would pass 64 closes its wider side into one `OFFSET 0`-fenced derived table
//    (`side`'s `fence`, src/rel/emit.ts), so the unroll nests a SELECT every 64 tables and ANSWERS — in either
//    child order, so neither needs the other (`bothChildOrders`). It used to decline (`JoinWidthExceeded`).
//
// The meter is deterministic, not a wall clock: `relChildren` calls during a compile, spied on the module
// namespace as `node-facts.test.ts` does. Linear work doubles with K; the old ordering grew 2.9–6.2× per
// doubling over the same hosts.
import { describe, expect, spyOn, test } from 'bun:test';
import * as walk from '../../src/rel/walk.ts';
import { compile, UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import type { FastPathConfig } from '../../src/compiler/options/fast-paths.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { loadBulk } from '../../src/bulk.ts';
import { bare, LADDER, read, runWith, seededStore } from '../support/harness.ts';

/** Child-relation enumerations one compile makes — answered or declined. */
const enumerations = (q: string, fastPaths?: Partial<FastPathConfig>): number => {
  const rc = spyOn(walk, 'relChildren');
  try {
    try { compile(q, {}, fastPaths ? { fastPaths } : undefined); } catch (e) { if (!(e instanceof UnsupportedTraversal)) throw e; }
    return rc.mock.calls.length;
  } finally { rc.mockRestore(); }
};

const HOSTS: readonly (readonly [string, (k: number) => string])[] = [
  ['local', (k) => `g.V().local(repeat(out()).times(${k})).count()`],
  ['where', (k) => `g.V(1).where(repeat(out()).times(${k})).count()`],
  ['not', (k) => `g.V().not(repeat(out()).times(${k})).count()`],
  ['a reducing local body', (k) => `g.V().local(repeat(out()).times(${k}).count())`],
  ['filter', (k) => `g.V().filter(repeat(out()).times(${k})).count()`],
];

// Measured in EACH child order alone, across the width: closing a side at 64 is one more derived table, a step
// in the SQL and never growth in the compile.
describe('an unroll inside a host compiles in work linear in its count', () => {
  for (const [host, q] of HOSTS) {
    for (const [order, fastPaths] of [['connector', { connectorOnly: true }], ['ladder', LADDER]] as const) {
      test(`${host} (${order})`, () => {
        const [k16, k32, k63, k130] = [16, 32, 63, 130].map((k) => enumerations(q(k), fastPaths));
        expect(k32! / k16!).toBeLessThanOrEqual(2.5);
        expect(k63! / k32!).toBeLessThanOrEqual(2.5);
        expect(k130! / k63!).toBeLessThanOrEqual(2.5 * 130 / 63 / 2);
      });
    }
  }
  // Linear: ~31× the iterations may cost at most ~1.5× that per iteration. The quadratic ordering cost ~650×
  // the work at times(2000) that it did at times(63).
  for (const [host, q] of HOSTS.slice(0, 2)) {
    test(`${host}: times(2000) against times(64)`, () => {
      expect(enumerations(q(2000))).toBeLessThan(enumerations(q(64)) * (2000 / 64) * 1.5);
    });
  }
});

describe('an unroll inside a host answers past SQLite\'s join width', () => {
  const store = seededStore();
  test.each([
    ['g.V().local(repeat(out()).times(63)).count()', [0]],
    ['g.V().local(repeat(out()).times(64)).count()', [0]],
    ['g.V().local(repeat(out()).times(500)).count()', [0]],
    ['g.V().local(local(repeat(out()).times(63))).count()', [0]],
    ['g.V().map(repeat(out()).times(63)).count()', [0]],
    ['g.V().where(repeat(out()).times(65)).count()', [0]],
    ['g.V().where(repeat(out()).times(500)).count()', [0]],
    ['g.V().not(repeat(out()).times(64)).count()', [6]],
    ['g.V().not(repeat(out()).times(200)).count()', [6]],
    ['g.V().local(where(repeat(out()).times(70))).count()', [0]],
    ['g.V().flatMap(repeat(out()).times(70)).count()', [0]],
    ['g.V().optional(repeat(out()).times(70)).count()', [6]],
    ['g.V().union(repeat(out()).times(70), out()).count()', [6]],
    ['g.V().local(repeat(out()).times(70).count())', [0, 0, 0, 0, 0, 0]],
    ['g.V().local(repeat(out()).times(40)).local(repeat(out()).times(40)).count()', [0]],
    // A top-level emit() unroll joins every iteration's phase into one SELECT too.
    ['g.V().repeat(__.out()).emit().times(64).count()', [8]],
  ] as const)('%s', (q, expected) => {
    for (const fastPaths of [{ connectorOnly: true }, LADDER]) {
      expect(bare(runWith(store, q, { fastPaths })).map((row: { v: number }) => row.v)).toEqual([...expected]);
    }
  });

  // A `both()` hop reads a UNION ALL CTE the flattener merges arm by arm, so the width counts its widest arm
  // (`derivedTables`): counted as one table, it closed at 64 and SQLite still refused the flattened 65. The
  // default order only: the opt-in ladder's per-traverser `limit` enumerates every walk before it keeps one
  // (~2.4× per hop on this graph, a cost of the ladder route at any width, not of the close).
  test('a both() unroll past the width answers', () => {
    const q = 'g.V().local(repeat(both()).times(70).limit(1)).count()';
    for (const fastPaths of [{ connectorOnly: true }, {}]) expect(bare(runWith(store, q, { fastPaths }))).toEqual([{ v: 6 }]);
  });

  // On a ring every vertex walks to exactly one vertex k hops on, so the answer is the vertex count — and a
  // fenced prefix inside a correlated body still seeks every hop by index (`e_out (src=?)`), never scans edges.
  test('the fenced chain answers the walk it spells, and keeps its scope-key seek', () => {
    const ring = new GraphStore(new BunSqlite(':memory:'));
    loadBulk(ring, Array.from({ length: 10 }, (_, i) => ({ id: i + 1, labels: ['v'], properties: [] })),
      Array.from({ length: 10 }, (_, i) => ({ label: 'next', src: i + 1, tgt: (i + 1) % 10 + 1, properties: [] })));
    for (const q of ['g.V().local(repeat(out()).times(130)).count()', 'g.V().where(repeat(out()).times(130)).count()']) {
      const plan = read(q);
      expect(plan.sql).toContain('OFFSET 0');
      expect(bare(ring.query(plan.sql, plan.binds))).toEqual([{ v: 10 }]);
      const steps = ring.query('EXPLAIN QUERY PLAN ' + plan.sql, plan.binds).map((row: { detail: string }) => row.detail);
      expect(steps.filter((detail: string) => /SCAN rme/.test(detail))).toEqual([]);
    }
  });
});
