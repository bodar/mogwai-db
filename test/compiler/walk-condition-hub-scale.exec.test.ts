import { describe, expect, test } from 'bun:test';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { loadBulk } from '../../src/bulk.ts';
import { runWith } from '../support/harness.ts';

// AN UNBOUNDED WALK'S emit/until CONDITION RUNS PER FRONTIER ROW, so its per-row work must not be a hub's
// neighbourhood. The condition is a correlated subquery inside the recursive term (`correlatedExistence`,
// `src/compiler/rel/lower/scoped.ts`), and many frontier rows reach one hub:
//  - `local(in().limit(1))` was a per-key ROW_NUMBER numbering the hub's WHOLE in-neighbourhood per row
//    (measured 41× per 8× growth). A one-row scope has one key, so the limit is now a plain LIMIT
//    (`src/rel/decorrelate.ts`), which stops at the first row.
//  - `count().is(gt(1))` counted the hub's whole in-neighbourhood per row (27×); a walk condition's count now
//    reads only as far as its predicate can tell (`boundConditionCount`, `src/compiler/ir/strategies.ts`).
//  - a condition whose per-row work stays a neighbourhood (an unbounded ORDER) declines rather than run
//    quadratically.

/** `chains` chains of 6 persons (knows), each person `created` one of 20 shared software HUBS and a private leaf. */
function hubGraph(chains: number): GraphStore {
  const store = new GraphStore(new BunSqlite(':memory:'));
  const vs: { id: string; labels: string[]; properties: { key: string; value: unknown }[] }[] = [];
  const es: { label: string; src: string; tgt: string }[] = [];
  for (let h = 0; h < 20; h++) vs.push({ id: `h${h}`, labels: ['software'], properties: [] });
  for (let c = 0; c < chains; c++) {
    for (let i = 0; i < 6; i++) {
      vs.push({ id: `p${c}_${i}`, labels: ['person'], properties: [{ key: 'age', value: 20 + ((c + i) % 30) }] });
      vs.push({ id: `l${c}_${i}`, labels: ['software'], properties: [] });
      es.push({ label: 'created', src: `p${c}_${i}`, tgt: `h${(c * 6 + i) % 20}` });
      es.push({ label: 'created', src: `p${c}_${i}`, tgt: `l${c}_${i}` });
      if (i) es.push({ label: 'knows', src: `p${c}_${i - 1}`, tgt: `p${c}_${i}` });
    }
  }
  loadBulk(store, vs, es);
  return store;
}

/** Best of three wall times after one warm-up run. */
function timed(f: () => unknown): number {
  f();
  let best = Infinity;
  for (let i = 0; i < 3; i++) { const t0 = performance.now(); f(); best = Math.min(best, performance.now() - t0); }
  return best;
}

/** 130 → 1050 chains is ~8× the walk. Linear is ≈8×; the quadratic forms measured ~27–52×. */
const expectLinear = (small: number, large: number) => expect(large / Math.max(small, 5)).toBeLessThan(20);

const SCALE_TIMEOUT_MS = 60_000;

describe('a walk condition at a hub costs O(1) per frontier row', () => {
  const small = hubGraph(130);
  const large = hubGraph(1050);
  const count = (store: GraphStore, q: string): number => Number(runWith(store, q)[0].v);

  for (const [q, atSmall] of [
    ["g.V().repeat(out()).emit(local(in().limit(1))).count()", 7410],
    ["g.V().repeat(out()).until(local(in('created').limit(1).has('age',gt(40)))).count()", 756],
    ["g.V().repeat(out()).until(union(out('knows'),in('created')).count().is(gt(1))).count()", 2730],
    ["g.V().repeat(out()).until(in('created').count().is(gt(1))).count()", 2730],
  ] as const) {
    test(q, () => {
      expect(count(small, q)).toBe(atSmall);
      expectLinear(timed(() => runWith(small, q)), timed(() => runWith(large, q)));
    }, SCALE_TIMEOUT_MS);
  }

  test('a condition whose per-row work is a whole neighbourhood declines', () => {
    expect(() => runWith(small, "g.V().repeat(out()).emit(local(in().order().by('age').limit(1))).count()")).toThrow(/not supported/);
  });
});
