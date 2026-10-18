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
import { seededStore, storeSeededWith } from '../support/harness.ts';
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
    // A terminal set op frames as a SET (value order, then class name — a set has none of its own).
    expect(typed('g.inject([1, 2]).intersect([1.0])')).toEqual(['set[]']);
    expect(typed('g.inject([1, 2]).difference([1.0])')).toEqual(['set[1i,2i]']);
    expect(typed('g.inject([1, 2]).disjunct([1.0])')).toEqual(['set[1d,1i,2i]']);
    expect(typed('g.inject([1, 2]).merge([1.0])')).toEqual(['set[1d,1i,2i]']);
    expect(typed('g.inject([1, 2]).intersect([1])')).toEqual(['set[1i]']);
    // a stored whole Double (`{t:'double',v:1}`) is a Double on either side
    expect(typed("g.E().values('weight').fold().intersect([1.0])")).toEqual(['set[1d]']);
    expect(typed("g.E().values('weight').fold().intersect([1])")).toEqual(['set[]']);
  });

  test('an operand member the bare encoding cannot name back rides as its {t,v} node and compares by its class', () => {
    // `[1L]` is a Long member (`literalMemberEnvelopes`): `Integer(1).equals(Long(1))` is false.
    expect(typed('g.inject([1, 2]).intersect([1L])')).toEqual(['set[]']);
    expect(typed('g.inject([1L, 2]).intersect([1L])')).toEqual(['set[1L]']);
  });
});

// A per-row tag is NOT a key of its own: a NULL tag means "infer from the value", so a tagged `constant(1)`
// and an untagged `identity()` 1 are ONE Integer. Every typed-equality site keys on the NORMALIZED class
// (`valueClass`, build.ts — the tag in the Gremlin vocabulary, else the value's inference), never on the raw
// tag column (`typedEquality` subsumes it) and never on NULL-means-tagged.
describe('a tagged and an untagged row of one class are one value at every typed-equality site', () => {
  const MERGED = 'union(identity(), constant(1))';
  test('dedup().by(identity()) — the window arm keys the by() key on the normalized class', () => {
    expect(typed(`g.inject(1, 2, 1).${MERGED}.dedup().by(identity()).fold()`)).toEqual(['[1i,2i]']);
    expect(typed(`g.inject(1).${MERGED}.dedup().by(identity()).fold()`)).toEqual(['[1i]']);
    expect(typed(`g.inject(1, 2).${MERGED}.dedup().by(identity()).count()`)).toEqual(['2L']);
    expect(typed("g.inject('a', 'b').union(identity(), constant('a')).dedup().by(identity()).count()")).toEqual(['2L']);
    expect(typed('g.inject(1.5).union(identity(), constant(1.5)).dedup().by(identity()).count()')).toEqual(['1L']);
  });

  test('plain dedup() — a payload whose tag is subsumed takes the window arm', () => {
    expect(typed(`g.inject(1, 2, 1).${MERGED}.dedup()`)).toEqual(['1i', '2i']);
    expect(typed('g.inject(1.5).union(identity(), constant(1.5)).dedup().count()')).toEqual(['1L']);
    expect(typed(`g.inject(1, 2, 1).${MERGED}.as('a').dedup('a').fold()`)).toEqual(['[1i,2i]']);
    // a record's field pairs `f0_v`/`f0_vtype` the same way
    expect(typed(`g.inject(1, 2, 1).${MERGED}.project('a').by(identity()).dedup().count()`)).toEqual(['2L']);
    // ...while an Integer and a Double stay two
    expect(typed('g.inject(1, 1.0).union(identity(), constant(1)).dedup().fold()')).toEqual(['[1i,1d]']);
  });

  test('groupCount()/group() keys — the key node is written with the normalized class', () => {
    // inject(1,2,1) → 1,2,1 and three constant(1)s: five Integer 1s and one 2.
    expect(typed(`g.inject(1, 2, 1).${MERGED}.groupCount()`)).toEqual(['{1i:5L,2i:1L}']);
    expect(typed(`g.inject(1, 2, 1).${MERGED}.group().by(identity()).by(count())`)).toEqual(['{1i:5L,2i:1L}']);
    expect(typed(`g.inject(1, 2, 1).${MERGED}.as('a').groupCount().by(select('a'))`)).toEqual(['{1i:5L,2i:1L}']);
  });

  test('a mixed inject keys a Double apart from an Integer, framed as itself', () => {
    // The host's tag is the inject's own per-row `vt` (`relHostTag`), not "infer" — `GroupCountStep`
    // keys `Integer(1)` and `Double(1.0)` apart.
    expect(typed('g.inject(1, 1.0).groupCount()')).toEqual(['{1d:1L,1i:1L}']);
    expect(typed('g.inject(1, 1.0).group().by(identity()).by(count())')).toEqual(['{1d:1L,1i:1L}']);
  });
});

// A stored whole Double is kept as INTEGER under a 'double' tag, so SQLite's JSON writer spelled it `1`
// where a computed 1.0 is `1.0` — and every site that compares a JSON TEXT (a label's history entry, a
// map key node) split one Double into two. `asExactReal` (build.ts) writes a floating-tagged value as the
// REAL it is, so `Double.equals(1.0, 1.0)` holds at each (DedupGlobalStep.java:80-88; a HashMap key).
describe('a stored whole Double and a computed one are one value at every JSON-text equality site', () => {
  const W = "g.V().outE().values('weight')";
  test('label-keyed dedup', () => {
    expect(typed(`${W}.union(identity(), constant(1.0)).as('a').dedup('a').count()`)).toEqual(['4L']);
    expect(typed(`${W}.union(identity(), constant(1.0)).as('a').dedup().by(select('a')).count()`)).toEqual(['4L']);
    expect(typed(`${W}.as('a').union(identity(), constant(1.0)).as('b').dedup('a', 'b').count()`)).toEqual(['7L']);
    expect(typed(`${W}.as('a').select('a').union(identity(), constant(1.0)).as('b').dedup('b').count()`)).toEqual(['4L']);
  });

  test('groupCount()/group() keys', () => {
    const KEYS = ['{0.2d:1L,0.4d:2L,0.5d:1L,1d:8L}'];
    expect(typed(`${W}.union(identity(), constant(1.0)).groupCount()`)).toEqual(KEYS);
    expect(typed(`${W}.union(identity(), constant(1.0)).group().by(identity()).by(count())`)).toEqual(KEYS);
    expect(typed(`${W}.union(identity(), constant(1.0)).as('a').groupCount().by(select('a'))`)).toEqual(KEYS);
    expect(typed(`${W}.union(identity(), constant(1.0)).groupCount('m').cap('m')`)).toEqual(KEYS);
    expect(typed(`${W}.union(identity(), constant(1.0)).fold().unfold().groupCount()`)).toEqual(KEYS);
  });

  test('a negative zero and an Integer stay apart', () => {
    expect(typed("g.inject(-0.0, 0.0).groupCount()")).toEqual(['{-0d:1L,0d:1L}']);
    expect(typed("g.inject(1, 1.0).as('a').dedup('a').fold()")).toEqual(['[1i,1d]']);
  });
});

describe('a label keeps a negative zero — the history entry is the JSON writer\'s, repaired', () => {
  test('select/dedup(label) read the signed zero back', () => {
    expect(typed("g.inject(-0.0, 0.0).as('a').select('a').fold()")).toEqual(['[-0d,0d]']);
    expect(typed("g.inject(-0.0, 0.0).as('a').dedup('a').fold()")).toEqual(['[-0d,0d]']);
    expect(typed("g.inject(-0.0, 0.0).as('a', 'b').dedup('a', 'b').fold()")).toEqual(['[-0d,0d]']);
    expect(typed("g.inject(1, 1.0).as('a').select('a').fold()")).toEqual(['[1i,1d]']);
  });
});

// A map KEY is a HashMap key, and `Double.equals(0.0, -0.0)` is false (it compares `doubleToLongBits`):
// `GroupCountStep`/`GroupStep` keep `0.0` and `-0.0` as two groups
// (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GroupCountStep.java).
// A label read as a key (`by(select('a'))`) used to drop its STATIC recorded type and hand `json_object` the
// bare REAL, whose writer spells `-0.0` as `0.0`, so the two keys merged into one `{0d:2L}`.
describe('a signed zero is its own map key at every key position', () => {
  const zeros = seededStore();
  executeQuery(zeros, "g.addV('z').property('x', 0.0d).addV('z').property('x', -0.0d).addV('z').property('x', 1.0d)", {});
  const at = (q: string) => typedAll(executeQuery(zeros, q, {}));
  test('groupCount/group over the traverser, a by(), a side effect and a label', () => {
    for (const [q, want] of [
      ['g.inject(0.0d, -0.0d).groupCount()', '{-0d:1L,0d:1L}'],
      ['g.inject(0.0d, -0.0d, 0.0d).groupCount()', '{-0d:1L,0d:2L}'],
      ['g.inject(1.0d, 1.0d, -0.0d).groupCount()', '{-0d:1L,1d:2L}'],
      ['g.inject(0.0d, -0.0d).group().by(identity())', '{-0d:[-0d],0d:[0d]}'],
      ['g.inject(0.0d, -0.0d).group().by().by(count())', '{-0d:1L,0d:1L}'],
      ["g.inject(0.0d, -0.0d).groupCount('m').cap('m')", '{-0d:1L,0d:1L}'],
      ["g.V().hasLabel('z').groupCount().by('x')", '{-0d:1L,0d:1L,1d:1L}'],
      ["g.V().hasLabel('z').group().by('x').by(count())", '{-0d:1L,0d:1L,1d:1L}'],
      ["g.inject(0.0d, -0.0d).as('a').groupCount().by(select('a'))", '{-0d:1L,0d:1L}'],
      ["g.inject(0.0d, -0.0d).as('a').group().by(select('a'))", '{-0d:[-0d],0d:[0d]}'],
      ["g.inject(0.0d, -0.0d).as('a').map(constant(1)).groupCount().by(select('a'))", '{-0d:1L,0d:1L}'],
      ["g.inject(0.0f, -0.0f).as('a').groupCount().by(select('a'))", '{-0f:1L,0f:1L}'],
      ["g.V().hasLabel('z').values('x').as('a').groupCount().by(select('a'))", '{-0d:1L,0d:1L,1d:1L}'],
    ] as const) expect(at(q), q).toEqual([want]);
  });
  test('the label key keeps its class and its 17 digits too', () => {
    expect(at("g.inject(0.30000000000000004d, 0.3d).as('a').groupCount().by(select('a'))")).toEqual(['{0.30000000000000004d:1L,0.3d:1L}']);
    expect(at("g.inject(1, 1.0d, 1L).as('a').groupCount().by(select('a'))")).toEqual(['{1d:1L,1i:1L,1L:1L}']);
  });
});

describe('a child inject WITH injections answers only where the first result is read', () => {
  test('a first-result consumer reads the host', () => {
    expect(typed("g.inject('a', 'b').concat(__.inject('c'))")).toEqual(['"aa"', '"bb"']);
  });

  test('an all-results consumer, or a body after the inject, declines', () => {
    // The first application adds the injections behind the host (`StartStep.processNextStart`) and the
    // latch hides them from every later one — an arrival-order answer a per-row value cannot give.
    for (const q of [
      'g.V(1).out().local(__.inject(-0.0, 0.0).dedup().fold())',
      'g.V(1).out().local(__.inject(1, 2))',
      'g.V(1).out().flatMap(__.inject(1))',
    ]) expect(() => typed(q), q).toThrow(/not supported/);
  });
});

// A dedup KEY is the projected OBJECT under `Objects.equals` — a label's object, a `by()`'s product, or a
// `List` of one per label (DedupGlobalStep.java:74-88, a HashSet). The label's history entry `v` and a
// bare projected value are one number for `Integer(3)`/`Long(3)` and `Float(3.0)`/`Double(3.0)`, so every
// such key carries the CLASS beside the value — the entry's `t` (`aliasKeyAt`, alias.ts) or what `byTyped`
// knows of the projection (`byEqualityKey`, modulator.ts) — through `classedKey` (build.ts), the same
// terms a merge keys on.
describe('a label- or by()-keyed dedup keeps Integer/Long and Float/Double apart', () => {
  const classes = seededStore();
  for (const q of [
    "g.addV('n').property('f', 3.0f).property('d', 3.0d).property('i', 3).property('l', 3L)",
    "g.addV('m').property('p', 3).property('q', 3.0f)",
    "g.addV('m').property('p', 3L).property('q', 3.0d)",
  ]) executeQuery(classes, q, {});
  const at = (q: string) => typedAll(executeQuery(classes, q, {}));

  test('dedup(label) and dedup().by(select(label))', () => {
    expect(at("g.inject(3, 3L).as('a').dedup('a').fold()")).toEqual(['[3i,3L]']);
    expect(at("g.inject(3, 3L, 3).as('a').dedup('a').fold()")).toEqual(['[3i,3L]']);
    expect(at("g.inject(3.0f, 3.0d).as('a').dedup('a').fold()")).toEqual(['[3f,3d]']);
    expect(at("g.inject(3, 3L).as('a').dedup().by(select('a')).fold()")).toEqual(['[3i,3L]']);
    expect(at("g.inject(3, 3L).as('a').union(identity(), constant(1)).as('b').dedup('a', 'b').count()")).toEqual(['4L']);
    expect(at("g.V().hasLabel('n').values('f', 'd', 'i', 'l').as('a').dedup('a').fold()")).toEqual(['[3f,3d,3i,3L]']);
    expect(at("g.V().hasLabel('m').values('p').as('a').dedup('a').count()")).toEqual(['2L']);
  });

  test('at depth — a union arm', () => {
    expect(at("g.inject(3, 3L).as('a').union(dedup('a')).count()")).toEqual(['2L']);
  });

  test('dedup().by(<projection>) over a stored property, a child, a property value', () => {
    expect(at("g.V().hasLabel('m').dedup().by('p').count()")).toEqual(['2L']);
    expect(at("g.V().hasLabel('m').dedup().by('q').count()")).toEqual(['2L']);
    expect(at("g.V().hasLabel('m').dedup().by(values('p')).count()")).toEqual(['2L']);
    expect(at("g.V().hasLabel('m').dedup().by(values('q')).count()")).toEqual(['2L']);
    expect(at("g.V().hasLabel('m').properties('p').dedup().by(value).count()")).toEqual(['2L']);
    expect(at("g.V().hasLabel('m').as('x').dedup('x').by('p').count()")).toEqual(['2L']);
    expect(at("g.V().hasLabel('m').as('x').dedup('x').by(values('q')).count()")).toEqual(['2L']);
  });

  test('equal objects still collapse', () => {
    expect(at("g.V().hasLabel('m', 'n').dedup().by(label).count()")).toEqual(['2L']);
    expect(at("g.inject(3, 3L).dedup().by(constant(1)).count()")).toEqual(['1L']);
    expect(at("g.V().hasLabel('m').values('p').as('a').union(identity(), identity()).dedup('a').count()")).toEqual(['2L']);
  });

  test('dedup().by(keys/values) over a map-entry stream keys on the entry side, not an internal error', () => {
    expect(at("g.inject(3, 3L).groupCount().unfold().dedup().by(keys)")).toEqual(['{3i:1L}', '{3L:1L}']);
    expect(at("g.inject(3, 3L, 3).groupCount().unfold().dedup().by(values)")).toEqual(['{3i:2L}', '{3L:1L}']);
    expect(at("g.V().hasLabel('m', 'n').group().by(label).unfold().dedup().by(keys).count()")).toEqual(['2L']);
  });
});

// A MIXED inject's per-row tag is NULL for an inferred member (`3`, an untagged `1.0d`'s INTEGER-free
// REAL) — and a NULL tag means "read the value" (`perRowSubject`, predicate.ts). A child predicate that
// dispatched on the raw tag took its never-true ELSE arm for every untagged row, so `map(is(gt(0)))`
// dropped `3` and `4`. Every child subject now normalizes the tag through `perRowSubject`.
describe('a child predicate over a mixed inject reads a NULL tag as the value\'s own class', () => {
  test('map/local/order/project/dedup over is(gt(0))', () => {
    expect(typed('g.inject(3, 3L, 4).order().by(is(gt(0))).fold()')).toEqual(['[3i,3L,4i]']);
    expect(typed('g.inject(3, 3L, 4).map(is(gt(0))).fold()')).toEqual(['[3i,3L,4i]']);
    expect(typed('g.inject(3, 3L, 4).local(is(gt(0))).fold()')).toEqual(['[3i,3L,4i]']);
    expect(typed("g.inject(3, 3L, 4).project('x').by(is(gt(0))).fold()")).toEqual(['[{"x":3i},{"x":3L},{"x":4i}]']);
    expect(typed('g.inject(1, 1.0d, 2).map(is(gt(0))).fold()')).toEqual(['[1i,1d,2i]']);
    expect(typed('g.inject(3, 3L, 4).dedup().by(is(gt(0))).fold()')).toEqual(['[3i,3L,4i]']);
    expect(typed('g.inject(3, 3L).union(dedup().by(is(gt(0)))).fold()')).toEqual(['[3i,3L]']);
    expect(typed('g.inject(3, 3L, 4).map(is(gt(0)).is(lt(4))).fold()')).toEqual(['[3i,3L]']);
    expect(typed("g.inject(3, 3L, 4).as('a').map(select('a').is(gt(0))).fold()")).toEqual(['[3i,3L,4i]']);
    expect(typed("g.inject(3, 3L, 4).as('a').project('x').by(select('a').is(gt(0))).fold()")).toEqual(['[{"x":3i},{"x":3L},{"x":4i}]']);
    expect(typed('g.inject(3, 3L, 4).union(identity(), constant(5)).map(is(gt(3))).fold()')).toEqual(['[5i,5i,4i,5i]']);
  });
});

// A by() child's MEMBER NODE (`scalarNode`, modulator.ts) is a map KEY compared by its JSON text, so its
// `t` must be the normalized class: GroupCountStep/GroupStep key on `Objects.equals`, under which
// `Integer(3)`, `Long(3)`, `Float(3.0)` and `Double(3.0)` are four keys. A NULL tag, or a correlated
// read's tag dropped to "infer" (`typedNodeOnce`), wrote them all as an Int. The same node is a pooled
// group VALUE member (`by(values('p').fold())`), which read no tag at all.
describe('a by() child keeps a value\'s class as a group key and as a pooled group member', () => {
  const classes = storeSeededWith([
    "g.addV('x').property('p', 3)", "g.addV('x').property('p', 3L)",
    "g.addV('x').property('p', 3.0f)", "g.addV('x').property('p', 3.0d)",
  ]);
  const at = (q: string) => typedAll(executeQuery(classes, q, {}));
  const FOUR = '{3d:1L,3f:1L,3i:1L,3L:1L}';

  test('an inject key', () => {
    expect(typed('g.inject(3, 3L, 4).groupCount().by(is(gt(0)))')).toEqual(['{3i:1L,4i:1L,3L:1L}']);
    expect(typed('g.inject(3, 3L, 4).group().by(is(gt(0))).by(fold())')).toEqual(['{3i:[3i],4i:[4i],3L:[3L]}']);
    expect(typed("g.inject(3, 3L, 4).as('a').groupCount().by(select('a').is(gt(0)))")).toEqual(['{3i:1L,4i:1L,3L:1L}']);
  });

  test('a stored key read through a child', () => {
    for (const q of [
      "g.V().groupCount().by(values('p'))",
      "g.V().groupCount().by(values('p').is(gt(0)))",
      "g.V().groupCount().by(coalesce(values('p'), constant(0)))",
      "g.V().groupCount().by(choose(has('p'), values('p'), constant(0)))",
      "g.V().properties('p').groupCount().by(value())",
    ]) expect(at(q), q).toEqual([FOUR]);
    expect(at("g.V().group().by(values('p').is(gt(0))).by(count())")).toEqual([FOUR]);
  });

  test('a pooled group value member', () => {
    expect(at("g.V().group().by(label()).by(values('p').fold())")).toEqual(['{"x":[3i,3L,3f,3d]}']);
    expect(at("g.V().group().by(label()).by(values('p').dedup().fold())")).toEqual(['{"x":[3i,3L,3f,3d]}']);
    expect(at("g.V().group().by(constant(1)).by(values('p').order().fold())")).toEqual(['{1i:[3i,3L,3f,3d]}']);
  });
});
