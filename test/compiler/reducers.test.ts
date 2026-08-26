// The reducer table (docs/2026-08-26-federate-pushdown-design.md) — how a terminal reducer splits into
// (partial-remote, combine-local, empty-result) for federate mid-traversal reduction pushdown. `count`
// is the lone MONOID (identity 0); sum/min/max/mean are SEMIGROUPS (no identity, empty -> nothing).
// Calcite's SqlSplittableAggFunction: count/sum = SUM0 combine, min/max = self-split, mean = reduce-first.
import { test, expect, describe } from 'bun:test';
import { UNCOVERED_REDUCERS, reducerOf } from '../../src/compiler/ir/reducers.ts';
import { REDUCERS } from '../../src/compiler/ir/step.ts';

describe('reducers — split for pushdown', () => {
  test('every REDUCERS member has an entry — cannot drift', () => {
    expect(UNCOVERED_REDUCERS).toEqual([]);
    for (const r of REDUCERS) expect(reducerOf(r)).not.toBeNull();
  });

  test('count is the lone MONOID: COUNT partial, SUM combine (SUM0), empty -> 0', () => {
    const m = reducerOf('count')!;
    expect(m.partial).toBe('count');      // the sibling COUNTS its group
    expect(m.combine).toBe('sum');        // partials COMBINE by summing — not re-counting (Calcite CountSplitter)
    expect(m.empty).toBe('zero');         // identity 0: an empty count is a real 0
  });

  test('sum is a SEMIGROUP with an additive combine: empty -> nothing (not 0)', () => {
    const m = reducerOf('sum')!;
    expect(m.partial).toBe('sum');
    expect(m.combine).toBe('sum');
    expect(m.empty).toBe('nothing');      // no identity — empty sum emits no traverser (TINKERPOP-1777)
  });

  test('min/max are SEMIGROUPS: self-split, empty -> nothing', () => {
    for (const [name, ext] of [['min', 'min'], ['max', 'max']] as const) {
      const m = reducerOf(name)!;
      expect(m.partial).toBe(name);       // the sibling runs min/max on its group
      expect(m.combine).toBe(ext);        // combine by the SAME extremal op (idempotent)
      expect(m.empty).toBe('nothing');    // no finite identity — empty min/max emits nothing
    }
  });

  test('mean does not split directly — reduce-first to (sum, count)', () => {
    const m = reducerOf('mean')!;
    expect(m.partial).toBeNull();
    expect(m.empty).toBe('nothing');
    expect(m.reduceFirst?.map((r) => r.name)).toEqual(['sum', 'count']);
  });

  test('a non-reducer has no entry (does not push)', () => {
    expect(reducerOf('dedup')).toBeNull();
    expect(reducerOf('out')).toBeNull();
  });
});
