// The reducer monoid registry (docs/2026-08-26-federate-pushdown-design.md) — how a terminal reducer
// splits into (partial-remote, combine-local, identity) for federate mid-traversal reduction pushdown.
// Calcite's SqlSplittableAggFunction: count/sum = SUM0, min/max = self-split, mean = reduce-first.
import { test, expect, describe } from 'bun:test';
import { UNCOVERED_REDUCERS, reducerMonoid } from '../../src/compiler/ir/reducer-monoid.ts';
import { REDUCERS } from '../../src/compiler/ir/step.ts';

describe('reducer monoids', () => {
  test('every REDUCERS member has a monoid — cannot drift', () => {
    expect(UNCOVERED_REDUCERS).toEqual([]);
    for (const r of REDUCERS) expect(reducerMonoid(r)).not.toBeNull();
  });

  test('count is (COUNT partial, SUM combine, zero identity) — Calcite CountSplitter (SUM0)', () => {
    const m = reducerMonoid('count')!;
    expect(m.partial).toBe('count');      // the sibling COUNTS its group
    expect(m.combine).toBe('sum');        // partials COMBINE by summing — not re-counting
    expect(m.identity).toBe('zero');      // a parent that matched nothing counts 0
  });

  test('sum is SUM0 too', () => {
    const m = reducerMonoid('sum')!;
    expect(m.partial).toBe('sum');
    expect(m.combine).toBe('sum');
    expect(m.identity).toBe('zero');
  });

  test('min/max self-split with an ABSORBING identity (empty -> drop, not 0)', () => {
    for (const [name, ext] of [['min', 'min'], ['max', 'max']] as const) {
      const m = reducerMonoid(name)!;
      expect(m.partial).toBe(name);       // the sibling runs min/max on its group
      expect(m.combine).toBe(ext);        // combine by the SAME extremal op (idempotent)
      expect(m.identity).toBe('absorbing'); // no zero — empty min/max emits nothing
    }
  });

  test('mean is NOT a direct monoid — reduce-first to (sum, count)', () => {
    const m = reducerMonoid('mean')!;
    expect(m.partial).toBeNull();
    expect(m.reduceFirst?.map((r) => r.name)).toEqual(['sum', 'count']);
  });

  test('a non-reducer has no monoid (does not push)', () => {
    expect(reducerMonoid('dedup')).toBeNull();
    expect(reducerMonoid('out')).toBeNull();
  });
});
