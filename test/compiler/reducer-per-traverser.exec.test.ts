// A REDUCER'S `result` MARKER CARRIED TWO FACTS, and the per-traverser rejoin needs to separate them.
//
//  (a) the value's CLASS rides on the reducer's `vt` column (`result: 'number'`, `REDUCED_TYPE`) — a TYPE fact
//      that holds wherever the value goes;
//  (b) a GLOBAL reducing barrier produced ONE row for the whole stream (`reducedGlobally`) — true at the reducer,
//      false once a per-traverser host (`local`/`map`/`flatMap`, the connector's rejoin) has run it once per
//      traverser.
//
// Fused, (b) made the scalar arm meet and a `match` pattern end refuse a `local(<reducer>)` value that was
// already per traverser, so `union(local(…sum()), constant(0))` — an ordinary default-value idiom — declined
// on the connector. Shedding the whole marker instead lost (a), and with it the stored class of
// `property(k, local(values('age').sum()))`. The rejoin now clears (b) only (`perTraverserFraming`,
// `src/compiler/rel/framing.ts`); the arm meet re-projects (a) onto the merged `vtype` (`scalarArmType`,
// `src/compiler/rel/lower/branch.ts`), and `match` binds the value with its `vt` tag.
//
// Every case compares the typed multiset — `typedAll` keeps the number class, so `3` vs `3.0`
// is a different answer here.
import { describe, expect, test } from 'bun:test';
import { UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { exec } from '../support/executor.ts';
import { typedAll } from '../support/decode.ts';
import { bagOf, seededStore } from '../support/harness.ts';
import type { FastPathConfig } from '../../src/compiler/options/fast-paths.ts';

// One lowering since the ladder was deleted; the loop keeps the mode label in a failure.
const MODES = [['default', undefined]] as const;
const typed = (q: string, fastPaths?: FastPathConfig): string[] => bagOf(typedAll(exec(seededStore(), undefined, fastPaths).buffers(q, {})));

const ANSWERS: readonly (readonly [string, readonly string[]])[] = [
  // A per-traverser SUM beside a default: the edgeless vertices' sum is no traverser (`SumGlobalStep` emits
  // nothing over zero starts), so only the three vertices with out-edges answer it, each a Double.
  ["g.V().union(local(outE().values('weight').sum()), constant(0))", ['1.9d', '1.4d', '0.2d', '0i', '0i', '0i', '0i', '0i', '0i']],
  ["g.V().choose(hasLabel('person'), local(outE().values('weight').mean()), constant(0))",
    ['0.6333333333333333d', '0.7d', '0.2d', '0i', '0i']],
  ["g.V().id().union(map(sum()), identity())", ['1i', '2i', '3i', '4i', '5i', '6i', '1i', '2i', '3i', '4i', '5i', '6i']],
  // The NUMBER CLASS survives the meet: a sum of Ints stays an Int, a mean is a Double even when whole.
  ["g.V().union(local(values('age').sum()), constant(0))", ['29i', '27i', '32i', '35i', '0i', '0i', '0i', '0i', '0i', '0i']],
  ["g.V().union(local(values('age').mean()), constant(0))", ['29d', '27d', '32d', '35d', '0i', '0i', '0i', '0i', '0i', '0i']],
  ["g.V().union(local(outE().count()), constant(0))", ['3L', '0L', '0L', '2L', '0L', '1L', '0i', '0i', '0i', '0i', '0i', '0i']],
  // Cross-shape: the per-traverser reducer joins a VARIANT beside an element arm.
  ["g.V().union(local(outE().values('weight').sum()), out()).count()", ['9L']],
  // A match pattern end that is a per-traverser reducer binds its value AND its class.
  ["g.V().match(__.as('a').map(inE('created').values('weight').mean()).as('b')).select('b')", ['0.3333333333333333d', '1d']],
  ["g.V().match(__.as('a').map(out().count()).as('b')).select('b')", ['3L', '0L', '0L', '2L', '0L', '1L']],
  ["g.V().match(__.as('a').map(out().values('age').max()).as('b')).select('b')", ['32i']],
  // Deeper: the merged stream re-enters a reducer, a fold under a by(), a group value, a coalesce arm.
  ["g.V().union(local(values('age').sum()), constant(1.5)).sum()", ['132d']],
  ["g.V().local(union(local(outE().values('weight').sum()), constant(0)).fold())", ['[1.9d,0i]', '[0i]', '[0i]', '[1.4d,0i]', '[0i]', '[0.2d,0i]']],
  ["g.V().group().by(label).by(union(local(outE().values('weight').sum()), constant(0)).sum())", ['{"person":3.5d,"software":0i}']],
  ["g.V().coalesce(union(local(outE().values('weight').sum()), constant(0)).is(gt(1)), constant(-1))", ['1.9d', '1.4d', '-1i', '-1i', '-1i', '-1i']],
];

describe('a reducer a per-traverser host produced meets and binds as a typed value', () => {
  for (const [q, expected] of ANSWERS)
    for (const [mode, fastPaths] of MODES)
      test(`${q} (${mode})`, () => expect(typed(q, fastPaths)).toEqual(bagOf(expected)));
});

describe('the TYPE fact survives the rejoin', () => {
  // The failure of shedding the whole marker: the stored property lost the sum's class.
  for (const [mode, fastPaths] of MODES)
    test(`property(k, local(values('age').sum())) stores an Int (${mode})`, () => {
      expect(typed("g.V().property('k', local(values('age').sum())).values('k')", fastPaths)).toEqual(bagOf(['29i', '27i', '32i', '35i']));
    });
});

describe('a GLOBAL reduction is still not a per-origin value', () => {
  // A pattern body that reduces across the whole binding table (a union arm is a GLOBAL child) has one value for
  // every origin at once — binding it to each `a` would be a wrong answer, so it declines.
  for (const q of [
    "g.V().match(__.as('a').union(out().values('age').sum()).as('b')).select('b')",
    "g.V().match(__.as('a').union(out().count()).as('b')).select('b')",
  ])
    for (const [mode, fastPaths] of MODES)
      test(`${q} (${mode})`, () => {
        expect(() => typed(q, fastPaths)).toThrow(UnsupportedTraversal);
      });
});
