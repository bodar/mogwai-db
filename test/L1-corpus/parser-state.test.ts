import { expect, test } from 'bun:test';
import { parseGremlin } from '../../src/gremlin/frontend.ts';

// A parse must not depend on what was parsed before it. antlr-ng's generated
// recognizers share one static prediction DFA across every instance, so a wrong
// cached prediction is not a transient miss — it is permanent for the lifetime of
// the isolate, and in a Durable Object that isolate serves every later request for
// that graph. The invariant below is therefore a production one, not a test-runner
// artefact: `parser/` must predict these correctly with the shared cache intact.
//
// Each query is individually valid and each one used to poison the others in
// EITHER order, because `parser/` had been generated from an older Gremlin.g4 than
// the `origin/master` grammar the project tracks (its serialized ATN was 36,523
// ints against master's 37,307). Regenerating with `mise run generate` fixed it.
// The witnesses are deep `repeat(__.not(__.or(...)))` nestings found by L5-random.
const WITNESSES = [
  "g.E().filter(__.inV().hasId(7).and(__.values('lang').where(__.fold().count(local)).and(__.skip(1).limit(1).max(), __.skip(1).order()).skip(2), __.skip(1))).hasLabel('created').has('weight', P.lt(1)).elementMap().count()",
  "g.V(2).has('name').repeat(__.not(__.or(__.identity(), __.path().dedup()).label()).label()).times(1)",
  "g.V(1).hasLabel('person').repeat(__.not(__.or(__.identity(), __.hasLabel('person').hasLabel('person')))).times(1)",
];

test('a parse does not depend on the parses before it', () => {
  // Every ordered pair, plus a repeat of each — a poisoned cache entry survives,
  // so re-parsing the victim after its poisoner is the assertion that matters.
  for (const first of WITNESSES) {
    for (const second of WITNESSES) {
      expect(() => parseGremlin(first)).not.toThrow();
      expect(() => parseGremlin(second)).not.toThrow();
      expect(() => parseGremlin(second)).not.toThrow();
    }
  }
});
