import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compiler/compiler.ts';
import { read, seededStore } from './support/harness.ts';

/**
 * THE RelIR SPINE — routing, coverage and the per-traversal differential (§10·4).
 *
 * The corpus-wide differential is `mise run test:legacy-spine` (the whole suite with the switch
 * off) and the coverage ratchet is the census `spine` column. This file holds the three things
 * neither of those can state directly:
 *
 *   1. a covered traversal actually ROUTES to RelIR, so a lowering that silently stopped firing is
 *      a failure here rather than a coverage number nobody read;
 *   2. the two spines return the SAME ROWS for it, asserted side by side at the traversal level;
 *   3. an UNCOVERED shape declines rather than throwing — the decline is the contract that keeps
 *      "not learned yet" from becoming a support regression.
 */

const store = seededStore();
const rowsVia = (gremlin: string, spine: 'rel' | 'legacy') => {
  const plan = read(gremlin, { spine });
  expect(plan.spine).toBe(spine === 'rel' ? 'rel' : 'legacy');
  return store.query(plan.sql, plan.binds).map((row) => JSON.stringify(row)).sort();
};

/** Every shape the lowering covers today. Growing coverage means growing this list. */
const COVERED = [
  'g.V()', 'g.E()', 'g.V(1)', 'g.V(1,2)', 'g.V([1,2])',
  "g.V().hasLabel('person')", "g.V().hasLabel('person','software')", "g.E().hasLabel('knows')",
  "g.V().has('name')", "g.V().has('name','marko')", "g.V().has('age',29)", "g.E().has('weight',0.5)",
  // A RUN of filters is the shape worth pinning: legacy gives each its own CTE that re-joins the
  // element table to reach a column its predecessor projected away, so `has(a).has(b)` costs two
  // redundant self-joins. RelIR conjoins them into one WHERE over one scan — measured, the same
  // index decisions with those SEARCH-by-rowid steps simply absent.
  "g.V().hasLabel('person').has('age',29)", "g.V().has('name','marko').has('age',29)",
];

/**
 * Shapes that must DECLINE, one per reason, so a decline lost to an over-eager lowering is caught
 * by name. `g.V().count()` is the ordinary "step not learned yet"; the rest are the guards.
 */
const DECLINED = [
  'g.V().count()',                    // a step past the source
  'g.V().out()',                      // ditto, movement
  'g.inject(1)',                      // a source that is not V()/E()
  'g.withSack(0).V()',                // a carried sack the source seed would have to declare
  'g.withSideEffect("a",1).V()',      // a side effect
  'g.addV("person")',                 // a write
  "g.V().has('age',P.gt(30))",        // a P predicate — 72 corpus occurrences, its own increment
  "g.V().has('person','age',29)",     // the three-argument (label, key, value) form
  'g.V().has(T.id,1)',                // a T-token key
  "g.V().has('name',null)",           // a null value: not a literal this route can compare
];

describe('the RelIR spine', () => {
  for (const gremlin of COVERED) {
    test(`${gremlin} routes to RelIR and agrees with legacy`, () => {
      expect(compile(gremlin, {}, { spine: 'rel' })).toMatchObject({ spine: 'rel' });
      expect(rowsVia(gremlin, 'rel')).toEqual(rowsVia(gremlin, 'legacy'));
    });
  }

  for (const gremlin of DECLINED) {
    test(`${gremlin} declines to the legacy spine`, () => {
      const plan = compile(gremlin, {}, { spine: 'rel' });
      expect(plan.kind === 'read' ? plan.spine : 'legacy').toBe('legacy');
    });
  }

  test('the switch is a preference, never a claim about coverage', () => {
    // Asking for RelIR does not make an uncovered chain route there, and asking for legacy always
    // works. Coverage is a property of the CHAIN; if these ever diverge the router has started
    // deciding something the lowering should own.
    expect(read('g.V().count()', { spine: 'rel' }).spine).toBe('legacy');
    expect(read('g.V()', { spine: 'legacy' }).spine).toBe('legacy');
    expect(read('g.V()', { spine: 'rel' }).spine).toBe('rel');
  });

  test('the emitted SQL does not depend on how many traversals were compiled before it', () => {
    // Relation ids are minted per lowering. A module-global counter would make two compiles of one
    // query produce two different strings — silently breaking every snapshot and any cache keyed
    // on the text, and only under a particular compile order.
    const first = read('g.V(1)', { spine: 'rel' });
    read('g.E()', { spine: 'rel' });
    expect(read('g.V(1)', { spine: 'rel' }).sql).toBe(first.sql);
  });
});
