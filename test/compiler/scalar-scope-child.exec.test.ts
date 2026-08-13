// A `map(B)`/`local(B)` whose body is scalar-shaped is a SCALAR PRODUCER at every child position —
// `isScalarProducingScope` (tail/child-shape.ts) plus the `isOneRowProjection` proof that lets
// `first` cardinality rank on a trivial encounter.
//
// The gap this closes was a pure classifier gap: root lowering has always accepted
// `g.V().out().local(__.count())`, so the identical body one level in was declining a shape the
// engine can already lower. The tests are therefore written as ROOT-vs-CHILD equivalences wherever
// one exists — that is the property, and it is stronger than an expected-value table because it
// cannot drift if the fixture changes.
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';

/** The traverser's value, in whichever spelling the lowering used. A single-field RECORD is either an
 *  `e0_v` column or a one-entry `map` blob; both are the same one value, and reading only one of them
 *  turns a lowering change into a test failure that says nothing. */
/** Traversers are a MULTISET. Two spellings of the same question agree row for row only when
 *  something upstream fixes an emission order; where neither does, comparing sorted is the honest
 *  assertion (a stronger one here would be pinning an order SQLite chose — see the perturbation
 *  instrument in test/CLAUDE.md). */

describe('a scalar-bodied map()/local() composes as a scalar producer in a child body', () => {



});

describe('the cardinality proof is the gate — a many-valued local() body stays out', () => {
  test('local(__.<fan-out scalar>) is NOT admitted as a one-per-input producer', () => {
    // `local(__.out().values("name"))` yields MANY scalars per input, so calling it a scalar
    // producer would silently change the classifier's cardinality contract. It must not compile
    // through this route — either it declines here or something else answers, but the arity claim
    // is never made. Asserted through a `first`-cardinality consumer, which is where a wrong claim
    // would surface as an arbitrary pick.
    let msg = '';
    try { compile("g.V().project('n').by(__.local(__.out().values('name')))", {}); } catch (e: any) { msg = String(e.message); }
    expect(msg).not.toBe('');
  });

});

// A branch in a scalar child body carries a scalar-row TAIL, and a reducer in that tail is
// per-ORIGIN — the same rule the element-row route below it has always followed.
//
// The branch route used to hand its WHOLE body to `lowerStepsStrict`, so the reducer reached
// `SCALAR_DISPATCH` and lowered as a GLOBAL barrier: it dropped the carried layout, and the
// parent's rejoin then projected an ordinal the relation no longer had, splicing an empty
// expression into the SQL (`SELECT r.v AS v,  FROM c8 r`). Both halves are now closed — the route
// continues the tail through the same `continueScalarChildTail` the element-row route uses, and
// `layoutProjection` refuses to project a carried column a relation does not declare.
//
// Invisible to every instrument at the time: the two corpus witnesses were `unbound` (never
// executed), neither L5 ratchet drew it, and `assertStreamColumns` cannot see it because the merged
// stream is self-consistent — the mismatch only exists ACROSS the rejoin.
describe('a reducer after a multi-arm branch in a child scope is per-origin', () => {


});
