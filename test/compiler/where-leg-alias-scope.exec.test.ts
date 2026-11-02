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
// The MULTI-correlation route (a fresh `V()` walk joined on its correlated positions) cannot see the
// outer path by construction, so a body reading any other live outer label DECLINES there rather than
// answering as if the label were unbound.
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

describe('the fresh-walk leg declines a read it cannot see', () => {
  test('a multi-correlation body selecting an uncorrelated outer label', () =>
    expect(() => run(s, `${BA}.in().as('c').where(__.select('a').in().where(P.eq('c')).select('b')).count()`)).toThrow(UnsupportedTraversal));
  test('a repeat body then an outer select', () =>
    expect(() => run(s, `${BA}.where(__.select('a').repeat(__.out()).times(1).select('b')).count()`)).toThrow(UnsupportedTraversal));
  test('a multi-correlation leg reading only its correlated labels still answers', () =>
    expect(count("g.V().as('a').out().as('b').match(__.as('a').out().as('b'), __.where(__.as('a').out('knows').as('b'))).count()")).toBe(2));
});
