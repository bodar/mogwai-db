import { expect, test } from 'bun:test';
import { parseGremlin } from '../../src/gremlin/frontend.ts';

// antlr-ng generated recognizers cache their prediction DFA statically. These
// two individually valid queries used to demonstrate that one parse could
// poison the next. The front-end owns parser construction, so it owns the
// invariant that request-local parsing has no history dependence.
const CACHE_POISONER = "g.E().filter(__.inV().hasId(7).and(__.values('lang').where(__.fold().count(local)).and(__.skip(1).limit(1).max(), __.skip(1).order()).skip(2), __.skip(1))).hasLabel('created').has('weight', P.lt(1)).elementMap().count()";
const FOLLOWING_VALID_QUERY = "g.V(2).has('name').repeat(__.not(__.or(__.identity(), __.path().dedup()).label()).label()).times(1)";

test('parser prediction state does not cross query boundaries', () => {
  expect(() => parseGremlin(CACHE_POISONER)).not.toThrow();
  expect(() => parseGremlin(FOLLOWING_VALID_QUERY)).not.toThrow();
});
