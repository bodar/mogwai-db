import { describe, expect, test } from 'bun:test';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { loadBulk } from '../../src/bulk.ts';
import { read, runWith } from '../support/harness.ts';

// AN UNBOUNDED WALK'S CONDITION MUST NOT COST A HUB'S NEIGHBOURHOOD PER WALK ROW — many walk rows reach one hub.
//  - `emit(c)` is asked over the FINISHED walk once per DISTINCT traverser state (`perState`,
//    `src/compiler/rel/walk.ts`): any head, a filtered union/coalesce/choose, an ORDER — measured 24–35× per 8×
//    when it was asked per row, ~6–7× now.
//  - `until(c)` runs INSIDE the recursive term, per frontier row (`correlatedExistence`,
//    `src/compiler/rel/lower/scoped.ts`): a `limit(n)` there is a plain LIMIT (a one-row scope has one key,
//    `src/rel/decorrelate.ts`; was 41×), a `count().is(P)` reads only as far as P can tell
//    (`boundConditionCount`, `src/compiler/ir/strategies.ts`; was 27×), and a condition whose per-row work stays a
//    neighbourhood — a barrier, or a filter, over an unbounded input — declines rather than run quadratically.
//    Its answer is a column of the walk (`EXIT`), asked once per produced row and READ by the term's stop test,
//    the exit arm and the emit arm alike.
//  - Under a scoping host (`where`/`local`/`not`) the walk is correlated or keyed by scope, so a per-state DISTINCT
//    merges nothing (measured ≈2.4× slower); the emit condition stays per row there (`freeRelIds(walk)`). Those
//    shapes are still super-linear — measured ≈17× (`where`) and ≈26× (`local`/`map` over `out()`) per 8× —
//    because the scoped walk is re-evaluated per host row; scope-free keying is
//    `docs/2026-11-16-ladder-retirement-plan.md` S6, and their 16× assertion waits for it.

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

/** 130 → 1050 chains is ~8× the walk. Linear is ≈8×, N log N ≈10×; the quadratic forms measured ~27–52×. */
const expectLinear = (small: number, large: number) => expect(large / Math.max(small, 5)).toBeLessThan(16);

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
    ["g.V().repeat(out()).emit(union(in('created'),out('knows')).has('age',gt(45))).count()", 2680],
    ["g.V().repeat(out()).emit(coalesce(in('created').has('age',gt(45)),out('nope'))).count()", 2520],
    ["g.V().repeat(out()).emit(choose(hasLabel('software'),in('created').has('age',gt(45)),out('knows'))).count()", 3820],
    ["g.V().repeat(out()).emit(optional(in('created').has('age',gt(45)))).count()", 7410],
    ["g.V().repeat(out()).emit(in('created').has('age',gt(45))).count()", 2520],
    ["g.V().repeat(out()).emit(local(in().order().by('age').limit(1))).count()", 7410],
    ["g.V().repeat(out()).until(has('age',gt(40))).emit(in('created').has('age',gt(45))).count()", 1980],
    ["g.V().repeat(out()).until(optional(in('created').has('age',gt(45)))).count()", 2210],
  ] as const) {
    test(q, () => {
      expect(count(small, q)).toBe(atSmall);
      expectLinear(timed(() => runWith(small, q)), timed(() => runWith(large, q)));
    }, SCALE_TIMEOUT_MS);
  }

  // A SCOPED walk keeps its emit condition per row — no per-state DISTINCT, which would merge nothing. The ratio
  // bound only catches a cliff until S6; the plan assertion is the guard against the 2.4× regression.
  for (const [q, atSmall] of [
    ["g.V().where(repeat(out()).emit(in('created').has('age',gt(45)))).count()", 754],
    ["g.V().where(repeat(out()).emit(union(in('created'),out('knows')).has('age',gt(45)))).count()", 754],
    ["g.V().hasLabel('person').local(repeat(out('knows')).emit(out('knows').has('age',gt(45))).count()).sum()", 160],
    ["g.V().not(repeat(out()).emit(in('created').has('age',gt(45)))).count()", 826],
  ] as const) {
    test(`scoped: ${q}`, () => {
      expect(count(small, q)).toBe(atSmall);
      expect(read(q).sql).not.toContain('DISTINCT');
      expect(timed(() => runWith(large, q)) / Math.max(timed(() => runWith(small, q)), 5)).toBeLessThan(48);
    }, SCALE_TIMEOUT_MS);
  }

  test('an until is asked once per walk row and read everywhere else', () => {
    const { sql } = read("g.V().repeat(out()).until(has('age',gt(40))).emit(in('created').has('age',gt(45))).count()");
    expect(sql.match(/> 40\)/g)).toHaveLength(2); // the INT and REAL spellings of the one test
    expect(sql.match(/lp0 > 0/g)).toHaveLength(1);
  });

  for (const q of [
    "g.V().repeat(out()).until(local(in().order().by('age').limit(1))).count()",
    "g.V().repeat(out()).until(union(in('created'),out('knows')).has('age',gt(45))).count()",
    "g.V().repeat(out()).until(coalesce(in('created').has('age',gt(45)),out('nope'))).count()",
  ]) {
    test(`an until whose per-row work is a whole neighbourhood declines: ${q}`, () => {
      expect(() => runWith(small, q)).toThrow(/not supported/);
    });
  }
});
