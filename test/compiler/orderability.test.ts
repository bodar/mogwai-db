// The JS ORDERABILITY comparator (`src/compiler/rel/orderability.ts`) is the semantic authority behind
// the order/dedup(Scope.local)-over-a-nested-list barrier, so it is unit-tested DIRECTLY against
// TinkerPop's `GremlinValueComparator.ORDERABILITY` rules (type-priority ladder, numeric-not-lexical,
// recursive over collections) rather than only through the end-to-end barrier. A defect here is a wrong
// ANSWER the barrier would ship, and this is the cheapest place to pin it.
import { test, expect, describe } from 'bun:test';
import { orderLocalValue, dedupLocalValue, orderabilityCompare } from '../../src/compiler/rel/orderability.ts';

const sorted = (xs: unknown[]): unknown[] => orderLocalValue(xs) as unknown[];

describe('ORDERABILITY comparator (order(Scope.local))', () => {
  test('numbers sort NUMERICALLY, not lexically', () => {
    expect(sorted([10, 9, 2, 100, 3])).toEqual([2, 3, 9, 10, 100]);
  });

  test('strings sort naturally', () => {
    expect(sorted(['b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
  });

  test('lists compare LEXICOGRAPHICALLY, shorter-prefix first', () => {
    expect(sorted([[3, 1, 10], [3, 1, 9], [2]])).toEqual([[2], [3, 1, 9], [3, 1, 10]]);
    // a prefix sorts before its extension
    expect(sorted([[1, 2], [1]])).toEqual([[1], [1, 2]]);
  });

  test('cross-type follows the priority ladder (null < boolean < number < string)', () => {
    expect(sorted(['x', 3, true, null])).toEqual([null, true, 3, 'x']);
  });

  test('typed {t,v} nodes compare by their unwrapped value and numeric type', () => {
    expect(sorted([{ t: 'int', v: 10 }, { t: 'int', v: 9 }])).toEqual([{ t: 'int', v: 9 }, { t: 'int', v: 10 }]);
  });

  test('elements order by id', () => {
    expect(sorted([{ id: 4, label: ['person'] }, { id: 2, label: ['person'] }]))
      .toEqual([{ id: 2, label: ['person'] }, { id: 4, label: ['person'] }]);
  });

  test('order is STABLE on ties (first-in wins)', () => {
    const a = { t: 'int', v: 1, tag: 'a' };
    const b = { t: 'int', v: 1, tag: 'b' };
    expect(sorted([a, b])).toEqual([a, b]);
  });

  test('a non-list value passes through unchanged (OrderLocalStep.map)', () => {
    expect(orderLocalValue(5)).toBe(5);
    expect(orderLocalValue('x')).toBe('x');
  });
});

describe('ORDERABILITY equality (dedup(Scope.local))', () => {
  test('dedups scalars, first occurrence wins, order kept', () => {
    expect(dedupLocalValue([1, 2, 1, 3, 2])).toEqual([1, 2, 3]);
  });

  test('dedups lists by ordered element-wise equality', () => {
    expect(dedupLocalValue([[1, 2], [1, 2], [3]])).toEqual([[1, 2], [3]]);
    // order-sensitive: [1,2] and [2,1] are DISTINCT lists
    expect(dedupLocalValue([[1, 2], [2, 1]])).toEqual([[1, 2], [2, 1]]);
  });

  test('dedups typed nodes by value', () => {
    expect(dedupLocalValue([{ t: 'int', v: 1 }, { t: 'int', v: 1 }, { t: 'int', v: 2 }]))
      .toEqual([{ t: 'int', v: 1 }, { t: 'int', v: 2 }]);
  });
});

describe('orderabilityCompare direct', () => {
  test('total-order sign contract', () => {
    expect(orderabilityCompare(1, 2)).toBeLessThan(0);
    expect(orderabilityCompare(2, 1)).toBeGreaterThan(0);
    expect(orderabilityCompare(1, 1)).toBe(0);
    // cross-type: a number always precedes a string
    expect(orderabilityCompare(99, 'a')).toBeLessThan(0);
  });
});
