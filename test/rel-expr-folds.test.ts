import { describe, expect, test } from 'bun:test';
import { and, col, conjoin, conjuncts, disjoin, disjuncts, or, type Expr } from '../src/rel/expr.ts';
import type { RelId } from '../src/rel/types.ts';

// The two connective folds and their inverses are ONE authority in `src/rel/expr.ts`. Every lowering that
// builds an AND/OR chain goes through them, so their fold ORDER is what keeps the emitted SQL byte-stable.
const [a, b, c] = (['a', 'b', 'c'] as const).map((name): Expr => col('r' as RelId, name));

describe('connective folds', () => {
  test('no terms is an absent predicate', () => {
    expect(conjoin([])).toBeUndefined();
    expect(disjoin([])).toBeUndefined();
  });

  test('one term is the term itself', () => {
    expect(conjoin([a!])).toBe(a!);
    expect(disjoin([a!])).toBe(a!);
  });

  test('a left fold: ((a op b) op c)', () => {
    expect(conjoin([a!, b!, c!])).toEqual(and(and(a!, b!), c!));
    expect(disjoin([a!, b!, c!])).toEqual(or(or(a!, b!), c!));
  });

  test('conjuncts and disjuncts invert the folds', () => {
    expect(conjuncts(conjoin([a!, b!, c!])!)).toEqual([a!, b!, c!]);
    expect(disjuncts(disjoin([a!, b!, c!])!)).toEqual([a!, b!, c!]);
    // Each inverse flattens only its own connective.
    expect(disjuncts(conjoin([a!, b!])!)).toHaveLength(1);
    expect(conjuncts(disjoin([a!, b!])!)).toHaveLength(1);
  });
});
