// A WHERE/NOT/MATCH LEG BODY SEES THE ROW'S PATH LABELS. A `where(__.select('a')…)` body runs over a
// SPLIT of the outer traverser (`TraversalFilterStep.filter` → `TraversalUtil.test`,
// vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/TraversalFilterStep.java:62),
// so its path — every `as()` bound before the step — is in scope, and a second `select('b')` in the body
// reads the outer `b` (`SelectOneStep` → `Scoping.getScopeValue`,
// vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectOneStep.java).
// The leg route (`match.ts` `legSingle`) used to hand its body to the predicate seam WITHOUT the row's
// aliases, so that select read as unbound: `where` answered 0 and `not` 6. The seam now takes the
// aliases and dispatches through the one entry `filter()` uses (`childPredicate`).
//
// The MULTI-correlation route (`match.ts` `legCorrelated`) walks the body from its anchored start
// SEEDED with the outer labels it reads, so a `where(P.eq('c'))` filters at its OWN position and a
// `limit`/`dedup`/`range` after it slices the constrained stream. It used to lift every label
// constraint to a clause applied AFTER the walk, so a slice ran first: `limit(1)` kept an arbitrary
// in-neighbour and the post-walk equality then dropped half the rows (12 -> 6). Only a body reading the
// whole path (`path()`) still declines — the seed carries labels, not path positions.
import { test, expect, describe } from 'bun:test';
import { seededStore, run, bare } from '../support/harness.ts';
import { UnsupportedTraversal } from '../../src/compiler/unsupported.ts';

const s = seededStore();
const count = (g: string): number => bare(run(s, g))[0].v;
const BA = "g.V().as('b').out().as('a')"; // 6 rows; every `b` (marko, josh, peter) is a person

describe('a leg body reads the outer row labels', () => {
  test('where(select(a).select(b))', () => expect(count(`${BA}.where(__.select('a').select('b')).count()`)).toBe(6));
  test('not(select(a).select(b))', () => expect(count(`${BA}.not(__.select('a').select('b')).count()`)).toBe(0));
  test('where(select(b).select(b)) — start and read are one label', () =>
    expect(count("g.V().as('b').out().where(__.select('b').select('b')).count()")).toBe(6));
  test('filter() control agrees', () => expect(count(`${BA}.filter(__.select('a').select('b')).count()`)).toBe(6));
  test('a movement after the second select', () =>
    expect(count(`${BA}.where(__.select('a').select('b').out('created')).count()`)).toBe(6));
  test('a filter on the second select', () =>
    expect(count(`${BA}.where(__.select('a').select('b').has('age', P.gt(32))).count()`)).toBe(1));
  test('a nested where inside a where', () =>
    expect(count(`${BA}.where(__.select('a').where(__.select('a').select('b'))).count()`)).toBe(6));
  test('a nested not inside a where', () =>
    expect(count(`${BA}.where(__.select('a').not(__.select('b').hasLabel('software'))).count()`)).toBe(6));
  test('inside a union arm', () =>
    expect(count(`${BA}.union(__.where(__.select('a').select('b')), __.not(__.select('a').select('b'))).count()`)).toBe(6));
  test('inside local()', () => expect(count(`${BA}.local(__.where(__.select('a').select('b'))).count()`)).toBe(6));
  test('a match() where-leg with a second select of a bound label', () =>
    expect(count(`${BA}.match(__.as('a').in().as('c'), __.where(__.as('a').select('b').hasLabel('person'))).count()`)).toBe(12));
  test('a where after match() reads a pre-match label', () =>
    expect(count(`${BA}.match(__.as('a').in().as('c')).where(__.select('c').select('b').has('age', P.gt(30))).count()`)).toBe(7));
});

// BAC: 12 rows (b, a, c ∈ in(a)); c is always an in-neighbour of a, so every leg below that asks for
// one keeps all 12, and its `not` keeps none.
const BAC = `${BA}.in().as('c')`;

describe('a multi-correlation leg filters at its own position, then slices', () => {
  test('limit after the label filter', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).limit(1)).count()`)).toBe(12));
  test('dedup().limit after the label filter', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).dedup().limit(1)).count()`)).toBe(12));
  test('range after the label filter', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).range(0, 1)).count()`)).toBe(12));
  test('dedup().by(label) after the label filter', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).dedup().by(T.label)).count()`)).toBe(12));
  test('order().by().limit after the label filter', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).order().by('name').limit(1)).count()`)).toBe(12));
  test('not(…limit) is the complement', () =>
    expect(count(`${BAC}.not(__.select('a').in().where(P.eq('c')).limit(1)).count()`)).toBe(0));
  test('the unsliced dedup witness', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).dedup()).count()`)).toBe(12));
  test('neq then limit', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.neq('c')).limit(1)).count()`)).toBe(9));
  test('inside local()', () =>
    expect(count(`${BAC}.local(__.where(__.select('a').in().where(P.eq('c')).limit(1))).count()`)).toBe(12));
  test('inside a union arm', () =>
    expect(count(`${BAC}.union(__.where(__.select('a').in().where(P.eq('c')).limit(1)), __.identity()).count()`)).toBe(24));
  test('after match() — the record tail', () =>
    expect(count(`${BA}.match(__.as('a').in().as('c')).where(__.select('a').in().where(P.eq('c')).limit(1)).count()`)).toBe(12));
});

describe('a multi-correlation leg reads outer labels after the correlation', () => {
  test('select(b) after the label filter', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).select('b')).count()`)).toBe(12));
  test('a filter on that select', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).select('b').has('age', P.gt(30))).count()`)).toBe(7));
  test('a second positional label filter', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).where(P.eq('b'))).count()`)).toBe(6));
  test('a where-theta over two outer labels', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).where('c', P.eq('b'))).count()`)).toBe(6));
  test('Pop.first/all over a rebound outer label keep its history', () => {
    const AA = "g.V().as('a').out().as('a').in().as('c')";
    expect(count(`${AA}.where(__.select('a').in().where(P.eq('c')).select(Pop.first, 'a').hasLabel('person')).count()`)).toBe(12);
    expect(count(`${AA}.where(__.select('a').in().where(P.eq('c')).select(Pop.all, 'a').count(Scope.local).is(2)).count()`)).toBe(12);
  });
  test('a repeat body then an outer select', () =>
    expect(count(`${BA}.where(__.select('a').repeat(__.out()).times(1).select('b')).count()`)).toBe(1)); // only a=josh moves on
  test('a body reading the whole path still declines', () =>
    expect(() => run(s, `${BAC}.where(__.select('a').in().where(P.eq('c')).path()).count()`)).toThrow(UnsupportedTraversal));
  test('a multi-correlation leg reading only its correlated labels still answers', () =>
    expect(count("g.V().as('a').out().as('b').match(__.as('a').out().as('b'), __.where(__.as('a').out('knows').as('b'))).count()")).toBe(2));
});
