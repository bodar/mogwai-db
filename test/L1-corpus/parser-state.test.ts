import { expect, test, describe } from 'bun:test';
import { DFA, DFAState, type ATNConfigSet } from 'antlr4ng';
import { parseGremlin } from '../../src/gremlin/frontend.ts';

// A parse must not depend on what was parsed before it. antlr-ng's generated recognizers share one
// static prediction DFA across every instance, so a wrong cached prediction is not a transient miss
// — it is permanent for the lifetime of the isolate, and in a Durable Object that isolate serves
// every later request for that graph. The invariant below is therefore a production one, not a
// test-runner artefact.
//
// ROOT CAUSE (measured, not inferred — an earlier diagnosis blamed a stale `parser/` and was
// disproven: this reproduces on a freshly generated parser, and identically on upstream
// gremlin-js's own generated parser, while the reference Java runtime on the same grammar does not
// reproduce it at all). antlr4ng indexes a decision's DFA states in `Map<number, DFAState>` keyed
// on `ATNConfigSet.hashCode()` and never consults `ATNConfigSet.equals()`. A 32-bit hash is not
// injective, so two structurally different configuration sets collide and are conflated: the
// simulator is handed a state describing a decision it did not ask about and reports "no viable
// alternative" for input that parses fine on its own. Java is immune because its table is
// `HashMap<DFAState, DFAState>`, which resolves a collision by equality.
//
// `patches/antlr4ng@3.0.16.patch` restores those reference semantics (bucket per hash,
// disambiguate with `DFAState.equals`). The L1 corpus alone collides 19 times and the fix moved 18
// corpus traversals from failing to executing, so this is a live correctness issue, not hygiene.
// These tests exist because that patch is the only thing standing between us and a silent,
// order-dependent wrong answer: dropping it on an antlr4ng upgrade must fail here, not in
// production.

// The mechanism, asserted directly, so a missing patch fails deterministically instead of waiting
// for a query pair that happens to collide. Stub configuration sets pin the hash, because a
// collision cannot be provoked on demand through real Gremlin.
test('the prediction DFA keeps distinct configuration sets that share a hash apart', () => {
  const configs = (hash: number, id: string) =>
    ({ id, hashCode: () => hash, equals: (other: { id: string }) => other.id === id }) as unknown as ATNConfigSet;

  const dfa = new DFA(null, 0);
  const first = DFAState.fromConfigs(configs(42, 'first'));
  const second = DFAState.fromConfigs(configs(42, 'second'));
  dfa.addState(first);
  dfa.addState(second);

  expect(dfa.getState(first)).toBe(first);
  expect(dfa.getState(second)).toBe(second);
  expect(dfa.length).toBe(2);

  // An equal set must still resolve to the stored state, or the DFA has stopped being a cache.
  expect(dfa.getState(DFAState.fromConfigs(configs(42, 'first')))).toBe(first);
});

// The behaviour that mechanism protects. Each query is individually valid and each one used to
// poison the others in EITHER order. The first three witnesses are deep `repeat(__.not(__.or(...)))`
// nestings found by L5-random; the last pair is the minimal reproduction delta-debugged out of an
// 8,439-query L5-random prefix, where a single predecessor query is enough to break the victim.
const WITNESSES = [
  "g.E().filter(__.inV().hasId(7).and(__.values('lang').where(__.fold().count(local)).and(__.skip(1).limit(1).max(), __.skip(1).order()).skip(2), __.skip(1))).hasLabel('created').has('weight', P.lt(1)).elementMap().count()",
  "g.V(2).has('name').repeat(__.not(__.or(__.identity(), __.path().dedup()).label()).label()).times(1)",
  "g.V(1).hasLabel('person').repeat(__.not(__.or(__.identity(), __.hasLabel('person').hasLabel('person')))).times(1)",
  'g.V(2).by(asc).not(__.or(__.skip(2).or(__.min(), __.max()), __.max()))',
  "g.V().repeat(__.coalesce(__.label().not(__.order()), __.skip(1)))",
];

test('a parse does not depend on the parses before it', () => {
  // Every ordered pair, plus a repeat of each — a poisoned cache entry survives, so re-parsing the
  // victim after its poisoner is the assertion that matters.
  for (const first of WITNESSES) {
    for (const second of WITNESSES) {
      expect(() => parseGremlin(first)).not.toThrow();
      expect(() => parseGremlin(second)).not.toThrow();
      expect(() => parseGremlin(second)).not.toThrow();
    }
  }
});
