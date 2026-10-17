// EVERY EQUALITY SITE SPEAKS THE REFERENCE'S EQUALITY — the producer tag of an all-null `mean()`, the null
// member of `within`/`without`, and the `HashSet` (`Objects.equals`) behind `dedup` and the list set ops.
//
// - `mean()` over an all-null stream is a NULL tagged 'null' at its producer (`reducerAggregate`,
//   src/compiler/rel/reducer.ts), as sum/min/max are, so `math()`'s number check raises on it exactly as
//   `MathStep` does (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MathStep.java:72-88).
// - `Contains.within` is `Compare.eq` per member, and `comparable(null, null)` is true
//   (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java:314-316),
//   so a null subject is within a set holding null and `without` is its complement (predicate.ts).
// - `dedup()`, `dedup(local)` and intersect/difference/disjunct/merge key on `typedEquality`
//   (src/compiler/rel/build.ts): `Integer(1)` is not `Double(1.0)` and `Double.equals(-0.0, 0.0)` is false
//   (DedupGlobalStep.java:59,78; IntersectStep.java:68-80).
import { test, expect, describe } from 'bun:test';
import { seededStore } from '../support/harness.ts';
import { executeQuery } from '../support/executor.ts';
import { typedAll } from '../support/decode.ts';

const store = seededStore();
const typed = (q: string, params: Record<string, unknown> = {}) => typedAll(executeQuery(store, q, params));
const raises = (q: string): string => {
  try { typed(q); } catch (error) { return (error as Error).message; }
  return 'no error';
};

describe('an all-null mean() is a productive null that math() refuses — MathStep.java:72-88', () => {
  const ALL_NULL_MEAN = '__.constant([null]).unfold().mean()';
  test('at every depth the sum/max variants already raise at', () => {
    for (const q of [
      `g.V(1).project('x').by(${ALL_NULL_MEAN}).math('x + 1')`,
      `g.V(1).out().map(${ALL_NULL_MEAN}).math('_ + 1')`,
      `g.V(1).out().local(${ALL_NULL_MEAN}).math('_ + 1')`,
      `g.V(1).repeat(__.out()).times(1).map(${ALL_NULL_MEAN}).math('_ + 1')`,
      `g.V(1).out().map(${ALL_NULL_MEAN}).math('_ * 2').by(identity())`,
      `g.V(1).out().map(${ALL_NULL_MEAN}).fold().unfold().math('_ + 1')`,
      `g.V(1).out().map(${ALL_NULL_MEAN}).where(__.math('_ + 1'))`,
      `g.withSack(1).V(1).out().sack(assign).by(${ALL_NULL_MEAN}).sack().math('_ + 1')`,
      `g.inject([null]).mean(local).math('_ + 1')`,
    ]) expect(raises(q), q).toContain('must resolve to a Number');
  });

  test('a non-null mean is still a Double, and an all-null one still a null', () => {
    expect(typed("g.V().values('age').mean()")).toEqual(['30.75d']);
    expect(typed('g.inject(1, 3).mean()')).toEqual(['2d']);
    expect(typed(`g.V(1).out().map(${ALL_NULL_MEAN})`)).toEqual(['null', 'null', 'null']);
    expect(typed('g.inject([null]).mean(local)')).toEqual(['null']);
  });
});

describe('within/without agree with eq on a null — Contains.within is Compare.eq per member', () => {
  test('a null subject is within a set that holds null', () => {
    for (const q of ['g.inject(null).is(within(0, null))', 'g.inject(null).is(within(null))', 'g.inject(null).is(within([null]))'])
      expect(typed(q), q).toEqual(['null']);
    expect(typed('g.inject(null).is(within(0))')).toEqual([]);
    expect(typed(`g.V(1).out().map(__.constant([null]).unfold().mean()).is(within(0, null))`)).toEqual(['null', 'null', 'null']);
  });

  test('without is the complement — a null subject survives a set without null, and only that', () => {
    expect(typed('g.inject(null, 1, 2).is(without(1, null))')).toEqual(['2i']);
    expect(typed('g.inject(null, 1, 2).is(without(null))')).toEqual(['1i', '2i']);
    expect(typed('g.inject(null, 1, 2).is(without(1))')).toEqual(['null', '2i']);
    expect(typed("g.inject(null, 29, 30).is(without(__.V(1).values('age').fold()))")).toEqual(['null', '30i']);
  });

  test('a collection PARAMETER holding null is the same set', () => {
    expect(typed('g.inject(null, 5).is(within(xs))', { xs: [0, null] })).toEqual(['null']);
    expect(typed('g.inject(null, 5).is(without(xs))', { xs: [0, null] })).toEqual(['5i']);
    expect(typed('g.inject(null, 5).is(without(xs))', { xs: [0] })).toEqual(['null', '5i']);
  });

  test('a stored property is never null, so has() is unchanged', () => {
    expect(typed("g.V().has('age', within(27, null)).values('name')")).toEqual(['"vadas"']);
    expect(typed("g.V().has('age', without(27, null)).values('name')")).toEqual(['"marko"', '"josh"', '"peter"']);
    expect(typed("g.V().has('age', within(null)).values('name')")).toEqual([]);
  });
});

describe('dedup and the set ops key on typed equality — HashSet is Objects.equals', () => {
  test('dedup() keeps a signed zero and an Integer beside a Double, at every arm', () => {
    expect(typed('g.inject(-0.0, 0.0).dedup().fold()')).toEqual(['[-0d,0d]']);
    expect(typed('g.inject(-0.0, 0.0, -0.0).dedup()')).toEqual(['-0d', '0d']);
    expect(typed('g.inject(-0.0, 0.0).order().dedup().fold()')).toEqual(['[-0d,0d]']);
    expect(typed('g.inject(-0.0, 0.0).union(__.identity(), __.identity()).dedup().fold()')).toEqual(['[-0d,0d]']);
    expect(typed('g.inject(-0.0, 0.0).dedup().by(identity()).fold()')).toEqual(['[-0d,0d]']);
    expect(typed('g.inject(1, 1.0, 1).dedup().fold()')).toEqual(['[1i,1d]']);
    expect(typed('g.V(1).local(__.constant([-0.0, 0.0]).unfold().dedup().fold())')).toEqual(['[-0d,0d]']);
  });

  test('one Double stored INTEGER beside the same Double computed REAL is still one value', () => {
    // The `vtype` tag names the class, so the storage class keys only an untagged row (`typedEquality`).
    expect(typed("g.E().values('weight').union(__.identity(), __.constant(1.0)).dedup().order().fold()"))
      .toEqual(['[0.2d,0.4d,0.5d,1d]']);
  });

  test('dedup(local) keys on the member class and a zero sign', () => {
    // `DedupLocalStep` yields a `LinkedHashSet`, which frames as a SET in insertion order.
    expect(typed('g.inject([1, 1.0]).dedup(local)')).toEqual(['set[1i,1d]']);
    expect(typed('g.inject(-0.0, 0.0).fold().dedup(local)')).toEqual(['set[-0d,0d]']);
    expect(typed('g.inject(1, 1L, 1.0, 1).fold().dedup(local)')).toEqual(['set[1i,1L,1d]']);
    expect(typed("g.E().values('weight').fold().dedup(local)")).toEqual(['set[0.5d,1d,0.4d,0.2d]']);
  });

  test('a list member op keeps a negative zero', () => {
    expect(typed('g.inject(-0.0, 0.0).fold().order(local)')).toEqual(['[-0d,0d]']);
    expect(typed('g.inject(-0.0, 0.0).fold().range(local, 0, 2)')).toEqual(['[-0d,0d]']);
  });

  test('intersect/difference/disjunct/merge compare an Integer and a Double as two values', () => {
    // A terminal set op frames as a SET (value order — a set has none of its own).
    expect(typed('g.inject([1, 2]).intersect([1.0])')).toEqual(['set[]']);
    expect(typed('g.inject([1, 2]).difference([1.0])')).toEqual(['set[1i,2i]']);
    expect(typed('g.inject([1, 2]).disjunct([1.0])')).toEqual(['set[1i,1d,2i]']);
    expect(typed('g.inject([1, 2]).merge([1.0])')).toEqual(['set[1i,1d,2i]']);
    expect(typed('g.inject([1, 2]).intersect([1])')).toEqual(['set[1i]']);
    // a stored whole Double (`{t:'double',v:1}`) is a Double on either side
    expect(typed("g.E().values('weight').fold().intersect([1.0])")).toEqual(['set[1d]']);
    expect(typed("g.E().values('weight').fold().intersect([1])")).toEqual(['set[]']);
  });

  test('an operand member the bare encoding cannot carry declines rather than compare as another type', () => {
    // `[1L]` is written INTEGER and would read back an Integer (`listLiteralBlob`).
    expect(() => typed('g.inject([1, 2]).intersect([1L])')).toThrow(/not supported/);
  });
});
