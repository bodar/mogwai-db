// `Double.compare`'s SIGNED ZERO at every ORDERING and COMPARISON position, whichever `by()` produced the
// number. ORDERABILITY (`order()`) and COMPARABILITY (`P.lt/lte/gt/gte/eq/neq`) both reach
// `NumberHelper.compare` for two Numbers, which is `Double.compare(-0.0, 0.0) = -1`
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:277,670-680`;
// `.../util/GremlinValueComparator.java:97-139`). SQLite calls the two equal, so a key that lost the sign
// term tied them — and `order().by('x').limit(1)` answered the WRONG ELEMENT. The sign term is applied at
// ONE authority per question (`orderingTerms` for a sort, `signedCompare` for a compare) for every key kind
// that can carry a float (`byKeyMaySignZero`), so the depth forms below are pinned rather than assumed.
import { test, expect, describe } from 'bun:test';
import { seededStore } from '../support/harness.ts';
import { executeQuery } from '../support/executor.ts';
import { typedAll } from '../support/decode.ts';

const store = seededStore();
// Inserted 0.0, -0.0, 1.0 — so insertion order is NOT the answer, and a tie keeps the wrong one first.
for (const q of ["g.addV('z').property('x', 0.0d)", "g.addV('z').property('x', -0.0d)", "g.addV('z').property('x', 1.0d)",
  "g.addV('w').property('x', -0.0d)", "g.addV('w').property('x', 0i)", "g.addV('w').property('x', 0.0d)"]) executeQuery(store, q, {});
const typed = (q: string) => typedAll(executeQuery(store, q, {}));

describe('order() by a PROJECTED key orders -0.0 below 0.0', () => {
  const ASC = ['[-0d,0d,1d]'];
  test.each([
    "g.V().hasLabel('z').order().by('x').values('x').fold()",
    "g.V().hasLabel('z').order().by(__.values('x')).values('x').fold()",
    "g.V().hasLabel('z').values('x').order().by(__.math('_ * 1')).fold()",
    "g.V().hasLabel('z').values('x').as('a').order().by(select('a')).fold()",
    "g.V().hasLabel('z').project('k').by('x').order().by(select('k')).select('k').fold()",
    "g.V().hasLabel('z').project('k','j').by('x').by(constant(1)).order().by(select('k')).select('k').fold()",
    "g.V().hasLabel('z').values('x').project('a').by(identity()).order().by(select('a')).select('a').fold()",
    "g.inject(1.0d,0.0d,-0.0d).order().by(__.math('_')).fold()",
    "g.inject(1.0d,0.0d,-0.0d).as('a').order().by(select('a')).fold()",
    "g.V().hasLabel('z').order().by(__.values('x').math('_ * 1')).values('x').fold()",
    "g.V().hasLabel('z').order().by(coalesce(values('x'), constant(5))).values('x').fold()",
    "g.V().hasLabel('z').order().by(choose(has('x'), values('x'), constant(5))).values('x').fold()",
    "g.V().hasLabel('z').order().by(__.values('x').min()).values('x').fold()",
    "g.V().hasLabel('z').order().by(constant(-0.0d)).by('x').values('x').fold()",
    "g.V().hasLabel('z').order().by('x').by(T.id).values('x').fold()",
    "g.V().hasLabel('z').properties('x').order().by(T.value).value().fold()",
    "g.V().hasLabel('z').properties('x').order().by(value).value().fold()",
    "g.V().hasLabel('z').fold().order(local).by('x').unfold().values('x').fold()",
  ])('%s', (q) => expect(typed(q)).toEqual(ASC));

  test('desc reverses the zeros too', () => {
    expect(typed("g.V().hasLabel('z').order().by('x', desc).values('x').fold()")).toEqual(['[1d,0d,-0d]']);
    expect(typed("g.V().hasLabel('z').values('x').order().by(__.math('-_')).fold()")).toEqual(['[1d,0d,-0d]']);
    expect(typed("g.V().hasLabel('z').values('x').order().by(__.math('-_'), desc).fold()")).toEqual(['[-0d,0d,1d]']);
  });

  test('a slice after the sort takes the RIGHT element, at depth too', () => {
    expect(typed("g.V().hasLabel('z').order().by('x').limit(1).values('x')")).toEqual(['-0d']);
    expect(typed("g.V().hasLabel('z').order().by('x').range(1,2).values('x')")).toEqual(['0d']);
    expect(typed("g.V().hasLabel('z').union(__.order().by('x').limit(1)).values('x')")).toEqual(['-0d']);
    expect(typed("g.V().hasLabel('z').order().by('x').values('x').fold().limit(local, 1)")).toEqual(['[-0d]']);
    expect(typed("g.V().hasLabel('z').group().by(constant(1)).by(order().by('x').values('x').fold())")).toEqual(['{1i:[-0d,0d,1d]}']);
  });

  test('an Int 0 ties a +0.0 and sits above a -0.0 (promoted to Double)', () => {
    expect(typed("g.V().hasLabel('w').order().by('x').values('x').fold()")).toEqual(['[-0d,0i,0d]']);
    expect(typed("g.V().hasLabel('w').order().by('x', desc).values('x').fold()")).toEqual(['[0i,0d,-0d]']);
  });
});

describe('where(a, P).by(key) compares -0.0 and 0.0 as Double.compare does', () => {
  const pairs = (op: string) => typed(`g.V().hasLabel('w').as('a').V().hasLabel('w').as('b').where('a', ${op}('b')).by('x').select('a','b').by('x')`);
  test('lt / gt', () => {
    expect(pairs('lt')).toEqual(['{"a":-0d,"b":0i}', '{"a":-0d,"b":0d}']);
    expect(pairs('gt')).toEqual(['{"a":0i,"b":-0d}', '{"a":0d,"b":-0d}']);
  });
  test('eq / neq: -0.0 is not 0.0, an Int 0 is 0.0', () => {
    expect(pairs('eq')).toEqual(['{"a":-0d,"b":-0d}', '{"a":0i,"b":0i}', '{"a":0i,"b":0d}', '{"a":0d,"b":0i}', '{"a":0d,"b":0d}']);
    expect(pairs('neq')).toEqual(['{"a":-0d,"b":0i}', '{"a":-0d,"b":0d}', '{"a":0i,"b":-0d}', '{"a":0d,"b":-0d}']);
  });
  test('lte, and a compound ring', () => {
    expect(pairs('lte')).toHaveLength(7);
    expect(typed("g.V().hasLabel('w').as('a').V().hasLabel('w').as('b').where('a', gt('b').or(eq('b'))).by('x').select('a','b').by('x')"))
      .toEqual(['{"a":-0d,"b":-0d}', '{"a":0i,"b":-0d}', '{"a":0i,"b":0i}', '{"a":0i,"b":0d}', '{"a":0d,"b":-0d}', '{"a":0d,"b":0i}', '{"a":0d,"b":0d}']);
  });
});
