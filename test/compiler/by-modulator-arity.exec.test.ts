// The `by()` arity rule — `byModulatorArity` (ir/passes.ts) over BY_MODULATOR_ARITY
// (ir/strategies.ts).
//
// Every expected message here is TinkerPop's own, read from the `modulateBy` override of the
// reference step class in `vendor/tinkerpop/gremlin-core`. That is the point of the file: the rule
// is an ARITY rule, so a violation is invalid Gremlin forever and must be refused with the spec's
// wording — never with a "not yet supported" deferral, which says something false AND files the
// traversal in the deferral telemetry that ranks docs/outstanding-work.md.
//
// The negative half matters as much as the positive: order()/select()/project()/path()/group() take
// more than one by() legitimately, so a table entry added for them would break working traversals.
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';

/** Each host at its LIMIT + 1, paired with the reference's message. Source class in the comment. */
const OVER_MODULATED: readonly (readonly [string, string, string])[] = [
  // DedupGlobalStep.java:126
  ['dedup', 'g.V().dedup().by("lang").by("name")', 'Dedup step can only have one by modulator'],
  // …the dedup(labels) constructor is the same class, so it takes the same message.
  ['dedup(labels)', 'g.V().as("a").out().as("b").dedup("a","b").by("name").by("age")', 'Dedup step can only have one by modulator'],
  // GroupCountStep.java:79 / GroupCountSideEffectStep.java:108 — two classes, one wording.
  ['groupCount', 'g.V().out("created").groupCount().by("name").by("age")', 'GroupCount step can only have one by modulator'],
  ['groupCount(key)', 'g.V().out("created").groupCount("x").by("name").by("age")', 'GroupCount step can only have one by modulator'],
  // AggregateStep.java:73
  ['aggregate', 'g.V().aggregate("x").by("name").by("age").cap("x")', 'Aggregate step can only have one by modulator'],
  // SackValueStep.java:55
  ['sack', 'g.V().sack(Operator.assign).by("age").by("name").sack()', 'Sack step can only have one by modulator'],
  // SampleGlobalStep.java:76
  ['sample', 'g.V().sample(1).by("age").by(T.id)', 'Sample step can only have one by modulator'],
  // PropertyMapStep.java:127 — the one message that names two step spellings.
  ['valueMap', 'g.V(1).valueMap("name","location").by(__.unfold()).by()', 'valueMap()/propertyMap() step can only have one by modulator'],
  // GroupStep.java:98 — two slots (key then value), so THREE is the violation.
  ['group', 'g.V().group().by("name").by("age").by(T.label)', 'The key and value traversals for group()-step have already been set'],
];

describe('by() modulator arity — TinkerPop\'s wording, not a deferral', () => {
  for (const [host, query, message] of OVER_MODULATED)
    test(`${host} rejects one by() too many`, () => {
      expect(() => compile(query, {})).toThrow(message);
    });

  test('the rule reaches a host nested inside a child body', () => {
    // `g.V().local(aggregate("x").by("name").by("age")).cap("x")` is the corpus spelling, and the
    // by()s sit INSIDE the local() body — so a check that only walked the top-level chain would
    // pass it. The Pass recurses into every nested argument at every depth, which is also why the
    // hosts themselves no longer re-check (their own throw could only disagree).
    expect(() => compile('g.V().local(__.aggregate("x").by("name").by("age")).cap("x")', {}))
      .toThrow('Aggregate step can only have one by modulator');
  });

  test('a Scope.local dedup/sample is a DIFFERENT reference class and is left alone', () => {
    // DedupLocalStep / SampleLocalStep are not ByModulating at all, so "can only have one by
    // modulator" would be the wrong complaint about them. Whatever those spellings do today, this
    // rule must not be the thing that answers — asserted as "not this message" rather than as an
    // outcome, so the day their own lowering lands, this test does not have to move.
    for (const q of ['g.V().values("name").fold().dedup(Scope.local).by("x").by("y")',
                     'g.V().values("name").fold().sample(Scope.local,1).by("x").by("y")']) {
      let msg = '';
      try { compile(q, {}); } catch (e: any) { msg = String(e.message); }
      expect(msg).not.toContain('can only have one by modulator');
    }
  });
});

// StandardVerificationStrategy's own clauses live beside the arity rule for the same reason: both
// are permanent refusals of invalid Gremlin, and both used to be spelled as deferrals.
describe('StandardVerificationStrategy — the clauses our surface can violate', () => {

  test('inject() under a repeat(), at any depth', () => {
    // hasRepeatStepParent walks EVERY ancestor, so the nested spelling violates it too — the second
    // case is the one a direct-body check would miss.
    expect(() => compile("g.V().repeat(__.inject('y')).times(2)", {}))
      .toThrow('The parent of inject()-step can not be repeat()-step');
    expect(() => compile("g.V().repeat(__.union(__.inject('y'), __.out())).times(2)", {}))
      .toThrow('The parent of inject()-step can not be repeat()-step');
  });

  test('inject() outside a repeat() is untouched', () => {
    expect(() => compile('g.inject(1,2)', {})).not.toThrow();
    expect(() => compile('g.V().repeat(__.out()).times(2)', {})).not.toThrow();
  });
});

describe('the hosts that legitimately take many by()s still compile', () => {
  // One per by()-taking host NOT in the table. A table entry mistakenly added for any of these
  // would break a working traversal, which is the failure mode this half exists to catch.
  const MULTI_BY = [
    'g.V().order().by("name").by("age")',
    'g.V().group().by("name").by("age")',
    'g.V().project("a","b").by("name").by("age")',
    'g.V().as("a").as("b").select("a","b").by("name").by("age")',
    'g.V().out().path().by("name").by(T.label)',
  ];
  for (const q of MULTI_BY) test(q, () => { expect(() => compile(q, {})).not.toThrow(); });

  // …and each table host AT its limit, which is the boundary the off-by-one would move. Asserted
  // as "the arity rule stays silent", not as "compiles": `sample().by()` and
  // `valueMap().by(unfold)` are unimplemented for reasons of their own and fail closed on those,
  // so demanding a clean compile here would couple this file to two unrelated capability gaps.
  const AT_LIMIT = [
    'g.V().dedup().by("lang")',
    'g.V().groupCount().by("name")',
    'g.V().aggregate("x").by("name").cap("x")',
    'g.V().sample(1).by("age")',
    'g.V(1).valueMap("name","location").by(__.unfold())',
    'g.V().group().by("name").by(__.count())',
  ];
  for (const q of AT_LIMIT) test(q, () => {
    let msg = '';
    try { compile(q, {}); } catch (e: any) { msg = String(e.message); }
    expect(msg).not.toContain('by modulator');
    expect(msg).not.toContain('already been set');
  });
});
