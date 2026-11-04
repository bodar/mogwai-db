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
//    every runtime (`at most 64 tables in a join`), so K ≥ 64 under `local` could never answer. That is a
//    property of the query text; the assembler now declines it as it builds the block
//    (`SQLITE_JOIN_TABLES`), with a hint naming the `times()`, instead of after spelling the whole statement.
//
// The meter is deterministic, not a wall clock: `relChildren` calls during a compile, spied on the module
// namespace as `node-facts.test.ts` does. Linear work doubles with K; the old ordering grew 2.9–6.2× per
// doubling over the same hosts.
import { describe, expect, spyOn, test } from 'bun:test';
import * as walk from '../../src/rel/walk.ts';
import { compile, UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { JoinWidthExceeded } from '../../src/sql/kernel/budget.ts';
import { bare, run, seededStore } from '../support/harness.ts';

/** Child-relation enumerations one compile makes — answered or declined. */
const enumerations = (q: string): number => {
  const rc = spyOn(walk, 'relChildren');
  try {
    try { compile(q, {}); } catch (e) { if (!(e instanceof UnsupportedTraversal)) throw e; }
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

describe('an unroll inside a host compiles in work linear in its count', () => {
  for (const [host, q] of HOSTS) {
    test(host, () => {
      const [k16, k32, k63] = [16, 32, 63].map((k) => enumerations(q(k)));
      expect(k32! / k16!).toBeLessThanOrEqual(2.5);
      expect(k63! / k32!).toBeLessThanOrEqual(2.5);
    });
  }
});

describe('an unroll inside a host answers up to SQLite\'s join width', () => {
  const store = seededStore();
  test.each([
    ['g.V().local(repeat(out()).times(63)).count()', [0]],
    ['g.V().where(repeat(out()).times(63)).count()', [0]],
    ['g.V().not(repeat(out()).times(64)).count()', [6]],
    // A count body is a correlated scalar subquery: its own SELECT, so 64 hops still fit.
    ['g.V().local(repeat(out()).times(64).count())', [0, 0, 0, 0, 0, 0]],
    // Two hosts side by side are two SELECTs, each under the limit.
    ['g.V().local(repeat(out()).times(40)).local(repeat(out()).times(40)).count()', [0]],
  ] as const)('%s', (q, expected) => {
    expect(bare(run(store, q)).map((row: { v: number }) => row.v)).toEqual([...expected]);
  });
});

describe('past it, the decline is clear and costs work linear in the count', () => {
  const store = seededStore();
  const declines = (q: string): UnsupportedTraversal => {
    try { run(store, q); } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedTraversal);
      return e as UnsupportedTraversal;
    }
    throw new Error(`expected ${q} to decline`);
  };
  // The first count past the limit: a `local` body joins its host's row in, while an `EXISTS` body
  // correlates against it instead, so its SELECT holds one table fewer.
  const FIRST_PAST: Readonly<Record<string, number>> = { local: 64, where: 65 };
  for (const [host, q] of HOSTS.filter(([host]) => host in FIRST_PAST)) {
    const first = FIRST_PAST[host]!;
    test(`${host}: times(${first}), times(500) and times(2000)`, () => {
      expect(bare(run(store, q(first - 1)))).toEqual([{ v: 0 }]);
      for (const k of [first, 500]) {
        const e = declines(q(k));
        expect(e).toBeInstanceOf(JoinWidthExceeded);
        expect(e.message).toBe(`this traversal is not supported yet: it joins more than 64 tables in one SQL SELECT, SQLite's limit; repeat(…).times(${k}) unrolls into one join per iteration — lower the count, move the repeat() out of its child traversal (local/where/map/…) to the top level, where its iterations are not fused into one SELECT, or, for a body without a barrier step (order/limit/range/dedup/aggregate/…), bound it with until(loops().is(${k})), which runs as a loop rather than unrolled`);
      }
      // At 2000 the compile's recursion may meet the runtime's stack first — a full suite process runs out
      // where a lone file does not, and workerd's stack is shallower still (`tooDeep`, compiler.ts). Either
      // decline is clear and names the repeat(); what must not happen is work quadratic in the count.
      expect(declines(q(2000)).message).toMatch(/repeat\(/);
      // Linear: ~31× the iterations may cost at most ~1.5× that per iteration. The quadratic ordering
      // cost ~650× the work at times(2000) that it did at times(63).
      expect(enumerations(q(2000))).toBeLessThan(enumerations(q(first)) * (2000 / first) * 1.5);
    });
  }

  test('at the top level the hint does not suggest moving the repeat()', () => {
    const e = declines('g.V().repeat(__.out()).emit().times(64).count()');
    expect(e.message).not.toContain('top level');
    expect(e.message).toContain('repeat(…).times(64) unrolls into one join per iteration');
  });

  test('the top-level form of the same walk answers', () => {
    expect(bare(run(store, 'g.V().repeat(out()).times(64).count()')).map((row: { v: number }) => row.v)).toEqual([0]);
  });
});
