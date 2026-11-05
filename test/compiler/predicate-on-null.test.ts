// `predicateOnNull` (src/compiler/rel/predicate.ts) answers, at compile time, what `predicateExpr` answers
// over a NULL subject — the fact an `is()` in a child body reads to decide whether a null that passes must
// keep a presence tag (docs/2026-11-05-presence-is-the-tag-plan.md P3). It is a second reading of the same
// null-space rules, so this holds the two together: every definite answer must be what the EMITTED SQL
// answers for `inject(null).is(P)`, and an unknown (`null`) is only ever conservative.
import { describe, expect, test } from 'bun:test';
import { parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { paramEnv } from '../../src/gremlin/param-env.ts';
import { predicateOnNull } from '../../src/compiler/rel/predicate.ts';
import { run, seededStore } from '../support/harness.ts';

const PREDICATES = [
  'P.eq(1)', 'P.neq(1)', 'P.eq(null)', 'P.neq(null)', 'P.gt(1)', 'P.gte(null)', 'P.lte(null)', 'P.lt(null)',
  'P.within(1, 2)', 'P.within(1, null)', 'P.without(1, 2)', 'P.without(1, null)', 'P.within([1, null])', 'P.without([1])',
  'P.between(1, 3)', 'P.inside(1, 3)', 'P.outside(1, 3)',
  'P.not(P.neq(1))', 'P.not(P.eq(1))', 'P.neq(1).and(P.gt(0))', 'P.neq(1).or(P.gt(0))', 'P.eq(null).and(P.neq(2))',
  'TextP.startingWith("a")', 'TextP.notStartingWith("a")', 'TextP.containing("a")', 'TextP.notContaining("a")',
  'TextP.endingWith("a")', 'TextP.notEndingWith("a")',
  '1', 'null', '"x"',
];

/** The `is()` argument of `g.inject(null).is(<pred>)`, as the front-end hands it to the lowering. */
const predOf = (pred: string): unknown => stepChain(parseGremlin(`g.inject(null).is(${pred})`), paramEnv({}))[1]!.args[0]!.value;

describe('predicateOnNull agrees with the SQL predicateExpr emits over a null subject', () => {
  const store = seededStore();
  for (const pred of PREDICATES) {
    test(pred, () => {
      const answer = predicateOnNull(predOf(pred));
      expect(answer).not.toBeNull();   // every predicate listed here has a definite null-space answer
      expect(run(store, `g.inject(null).is(${pred})`).length).toBe(answer ? 1 : 0);
    });
  }
  test('a predicate it cannot read is unknown, never a guess', () => {
    expect(predicateOnNull(predOf('P.typeOf(GType.NULL)'))).toBeNull();
    expect(predicateOnNull(predOf('P.not(P.typeOf(GType.INT))'))).toBeNull();
  });
});
