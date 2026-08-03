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
  // The P/TextP vocabulary as RelIR expressions. Range comparisons go through the vtype-aware
  // ordering key, so a value stored as TEXT because it does not fit a numeric storage class (a
  // long past 2^53, a bigint, a bigdecimal, a duration) still orders numerically — the one arm
  // where a plausible-looking lowering is silently wrong.
  "g.V().has('age',P.gt(30))", "g.V().has('age',P.lte(29))", "g.V().has('name',P.neq('marko'))",
  "g.V().has('name',P.within('marko','josh'))", "g.V().has('name',P.without('marko'))",
  "g.V().has('name',P.within())", "g.V().has('age',P.between(20,30))", "g.V().has('age',P.inside(20,35))",
  "g.V().has('age',P.gt(20).and(P.lt(30)))", "g.V().has('age',P.not(P.gt(30)))", "g.E().has('weight',P.gte(0.5))",
  // THE SHAPE BOUNDARY: both of these retype element -> scalar, so they exercise the framing
  // bridge's second stream kind rather than one more step in the same one.
  'g.V().count()', 'g.E().count()', "g.V().hasLabel('person').count()", "g.V().has('age',P.gt(29)).count()",
  "g.V().values('name')", "g.V().values('age')", "g.E().values('weight')", "g.V().hasLabel('person').values('name')",
  // `is(P)` past the shape change — the SAME predicate module the source filters use, over the
  // scalar's own `v`, which is the payoff for having built it as a module rather than a helper.
  'g.V().count().is(P.gt(2))', 'g.V().count().is(2)', "g.V().values('age').is(P.gt(29))",
  "g.V().values('name').is('marko')", "g.V().values('age').is(P.between(28,33))",
  "g.V().values('name').is(P.within('marko','josh'))", "g.V().values('name').is(TextP.containing('ark'))",
  "g.V().hasLabel('person').values('age').is(P.gte(30)).is(P.lt(40))", "g.E().values('weight').is(P.gt(0.3))",
  // `values()` is `element.properties(keys)`: no keys means EVERY key, several mean membership.
  // Both spines answered these WRONG until 2026-08-02 — see the semantics test below.
  "g.V().values('name','age')", "g.V().values('name','age',null)", 'g.V().values()', 'g.E().values()',
];

/**
 * Shapes that must DECLINE, one per reason, so a decline lost to an over-eager lowering is caught
 * by name. `g.V().count()` is the ordinary "step not learned yet"; the rest are the guards.
 */
const DECLINED = [
  "g.V().bothE().otherV()",           // otherV reads the entering vertex — carried state not modelled
  "g.V().as('a').out().select('a')",  // an alias: carried state not modelled
  'g.V().out().order()',              // the row-algebraic class, not learned yet
  'g.V().count().fold()',             // a step after the shape change that is NOT in its vocabulary
  'g.inject(1)',                      // a source that is not V()/E()
  'g.withSack(0).V()',                // a carried sack the source seed would have to declare
  'g.withSideEffect("a",1).V()',      // a side effect
  'g.addV("person")',                 // a write
  "g.V().has('name',TextP.containing('ark'))",  // ftsSubstringPredicate's — see below
  "g.V().has('name',P.within(__.V().values('name').fold()))", // a run-time member list, not a set
  "g.V().has('person','age',29)",     // the three-argument (label, key, value) form
  'g.V().has(T.id,1)',                // a T-token key
  "g.V().has('name',null)",           // a null value: not a literal this route can compare
  "g.V().where(__.has('name','marko'))", // a filter-only body is a predicate on the SAME traverser
  "g.V().where(__.out().order())",    // a body step the child fold has not learned
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

  test('a fast-path switch selects a STRATEGY, and RelIR covers the side it implements', () => {
    // `predicateInlining` chooses between two lowerings of a `where()` body: the correlated EXISTS
    // (which RelIR emits) and a MATERIALIZED child-existence gate — a pushed ordinal, a LEFT JOIN
    // and a rejoin — which it has not learned. With the switch off it therefore declines, exactly
    // as it declines an unlearned step, and both positions stay live for L5's differential.
    //
    // This is NOT the FTS rule inverted. There, reading the flag would have let spine choice dodge
    // an optimization RelIR cannot state at all (an index seek). Here the flag names two strategies
    // and RelIR implements one; covering only what it implements is ordinary coverage.
    expect(read("g.V().where(__.out('knows'))", { spine: 'rel' }).spine).toBe('rel');
    expect(read("g.V().where(__.out('knows'))", { spine: 'rel', fastPaths: { predicateInlining: false } }).spine).toBe('legacy');
    // `movementCollapse` is the other side of the same coin: RelIR states BOTH forms, so it covers
    // the traversal either way and the flag only changes what it emits.
    for (const movementCollapse of [true, false]) {
      expect(read('g.V().out()', { spine: 'rel', fastPaths: { movementCollapse } }).spine).toBe('rel');
    }
    // Matched on `sum(…) AS bulk`, not on `GROUP BY`: the element framing projection has a GROUP BY
    // of its own (the property aggregation), so that alone would pass either way. And not on
    // `sum(p.bulk)` either — the assembler fuses the aggregate into the join's block, so the
    // multiplicity is spelled as the expression that computes it, which here is the seed literal.
    const collapsed = /sum\([^)]*\) AS bulk/i;
    expect(read('g.V().out()', { spine: 'rel', fastPaths: { movementCollapse: true } }).sql).toMatch(collapsed);
    expect(read('g.V().out()', { spine: 'rel', fastPaths: { movementCollapse: false } }).sql).not.toMatch(collapsed);
  });

  test('a fast path is never silently dropped', () => {
    // THE RULE, and it is general: coverage measures whether the new spine can EXPRESS a
    // traversal, not whether it should take it from a specialized lowering. `has(k, containing(t))`
    // routes through the `property_fts` trigram index; expressing it here as a base-table LIKE scan
    // would be a performance regression the census cannot see, reported by the coverage number as
    // progress. §4.7 is where the fast paths become plan rewrites and this decline lifts.
    expect(read("g.V().has('name',TextP.containing('ark'))", { spine: 'rel' }).spine).toBe('legacy');
    expect(read("g.V().has('name',TextP.containing('ark'))").sql).toContain('property_fts');
    // The decline is a function of the CHAIN alone, never of the fast-path config: making spine
    // choice read `fastPaths` would couple two decisions that have to stay independent.
    expect(read("g.V().has('name',TextP.containing('ark'))", { spine: 'rel', fastPaths: { ftsSubstringPredicate: false } }).spine).toBe('legacy');
  });

  test('the switch is a preference, never a claim about coverage', () => {
    // Asking for RelIR does not make an uncovered chain route there, and asking for legacy always
    // works. Coverage is a property of the CHAIN; if these ever diverge the router has started
    // deciding something the lowering should own.
    expect(read('g.V().out().order()', { spine: 'rel' }).spine).toBe('legacy');
    expect(read('g.V()', { spine: 'legacy' }).spine).toBe('legacy');
    expect(read('g.V()', { spine: 'rel' }).spine).toBe('rel');
  });

  test('a retyping terminal frames as the same Shape on both spines', () => {
    // Rows agreeing is not enough at the shape boundary: `Compiled.shape` is what the wire framer
    // reads, so a lowering that produced the right VALUES under the wrong shape would round-trip
    // as the wrong GraphBinary type and every row assertion would still pass.
    for (const gremlin of ['g.V().count()', "g.V().values('name')", "g.E().values('weight')"]) {
      expect(read(gremlin, { spine: 'rel' }).shape).toEqual(read(gremlin, { spine: 'legacy' }).shape);
    }
    expect(read('g.V().count()', { spine: 'rel' }).shape).toEqual({ kind: 'value', type: { kind: 'static', type: 'long' } });
    expect(read("g.V().values('name')", { spine: 'rel' }).shape).toEqual({ kind: 'value', type: { kind: 'perRow', column: 'vtype' } });
  });

  test('values(k…) is the KEY SET, on both spines', () => {
    // Both spines read only `args[0]` until 2026-08-02, so `values('name','age')` returned just the
    // names and `values()` bound null and returned nothing — right arity, plausible rows, and the
    // census recorded both as `ran`. Found by re-expressing the step in RelIR: a second
    // implementation asks questions of the first that no test in the suite was asking.
    //
    // TinkerPop's `PropertiesStep` is `element.properties(keys)` — no keys means EVERY key, several
    // mean membership in the set, and a null key never matches (`Properties.feature:91` pins
    // `values("name","age",null)` as names AND ages). Asserted on both spines, because the fix
    // landed in both and the differential requires them to agree.
    for (const spine of ['legacy', 'rel'] as const) {
      const rows = (g: string) => (store.query(read(g, { spine }).sql, read(g, { spine }).binds) as any[]).map((r) => r.v).sort();
      expect(rows("g.V().values('name')")).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
      expect(rows("g.V().values('name','age')")).toEqual([27, 29, 32, 35, 'josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
      expect(rows("g.V().values('name','age',null)")).toEqual([27, 29, 32, 35, 'josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
      expect(rows('g.V().values()')).toEqual([27, 29, 32, 35, 'java', 'java', 'josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
      expect(rows('g.E().values()')).toEqual([0.2, 0.4, 0.4, 0.5, 1, 1]);
    }
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
