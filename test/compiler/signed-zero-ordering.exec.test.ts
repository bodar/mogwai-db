// `Double.compare`'s SIGNED ZERO at every ORDERING and COMPARISON position, whichever `by()` produced the
// number. ORDERABILITY (`order()`) and COMPARABILITY (`P.lt/lte/gt/gte/eq/neq`) both reach
// `NumberHelper.compare` for two Numbers, which is `Double.compare(-0.0, 0.0) = -1`
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:277,670-680`;
// `.../util/GremlinValueComparator.java:97-139`). SQLite calls the two equal, so a key that lost the sign
// term tied them — and `order().by('x').limit(1)` answered the WRONG ELEMENT. The sign term is applied at
// ONE authority per question (`orderedBy` for a sort, `signedCompare` for a compare) over every key kind,
// each key carrying its zero's NUMBER CLASS (`ZeroCarrier`, `orderingKey`), so the depth forms below are
// pinned rather than assumed.
import { test, expect, describe } from 'bun:test';
import { seededStore } from '../support/harness.ts';
import { executeQuery } from '../support/executor.ts';
import { typedAll } from '../support/decode.ts';
import { RaisedByQuery } from '../../src/rel/raise.ts';

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

// A BigInteger/BigDecimal zero EQUALS `-0.0d`: `NumberHelper.compare` promotes the pair to BigDecimal, and
// `BigDecimal.valueOf(-0.0)` is an unsigned zero (`NumberHelper.java:278-310,362-399,670-680`). So the sign
// rule needs the per-row NUMBER CLASS, which the ordering key carries (`orderingKey`); where the sort's
// zeros make the comparator intransitive, or a value stream has no arrival order to keep a tie in, it DEFERS.
describe('a BigInteger/BigDecimal zero ties -0.0d (NumberHelper promotes to BigDecimal)', () => {
  const big = seededStore();
  for (const [label, rows] of Object.entries({
    m: [['big', '0m'], ['neg', '-0.0d']], m2: [['neg', '-0.0d'], ['big', '0m']],
    n: [['big', '0n'], ['neg', '-0.0d']], n2: [['neg', '-0.0d'], ['big', '0n']],
    t: [['big', '0m'], ['neg', '-0.0d'], ['pos', '0.0d']],
    q: [['five', '5m'], ['ten', '10.0d'], ['seven', '7n']],
  })) for (const [name, x] of rows!) executeQuery(big, `g.addV('${label}').property('name','${name}').property('x', ${x})`, {});
  const names = (q: string) => typedAll(executeQuery(big, q, {}));

  test.each([
    ["g.V().hasLabel('m').order().by('x').values('name')", ['"big"', '"neg"']],
    ["g.V().hasLabel('m2').order().by('x').values('name')", ['"neg"', '"big"']],
    ["g.V().hasLabel('n').order().by('x').values('name')", ['"big"', '"neg"']],
    ["g.V().hasLabel('n2').order().by('x').values('name')", ['"neg"', '"big"']],
    ["g.V().hasLabel('m').order().by('x').limit(1).values('name')", ['"big"']],
    ["g.V().hasLabel('m').order().by('x', desc).values('name')", ['"big"', '"neg"']],
    ["g.V().hasLabel('m').order().by(values('x')).values('name')", ['"big"', '"neg"']],
    ["g.V().hasLabel('m2').order().by(values('x')).values('name')", ['"neg"', '"big"']],
    ["g.V().hasLabel('m').project('k','n').by('x').by('name').order().by(select('k')).select('n')", ['"big"', '"neg"']],
    ["g.V().hasLabel('m').fold().order(local).by('x').unfold().values('name')", ['"big"', '"neg"']],
    ["g.V().hasLabel('m2').fold().order(local).by('x').unfold().values('name')", ['"neg"', '"big"']],
    ["g.V().hasLabel('n').union(order().by('x').limit(1)).values('name')", ['"big"']],
  ])('%s', (q, expected) => expect(names(q)).toEqual(expected));

  test('where(a, P).by(x) compares a big zero EQUAL to -0.0d', () => {
    const pair = (label: string, op: string) =>
      names(`g.V().hasLabel('${label}').as('a').V().hasLabel('${label}').as('b').where('a', ${op}('b')).by('x').count()`);
    for (const label of ['m', 'n']) {
      expect(pair(label, 'neq')).toEqual(['0L']);
      expect(pair(label, 'lt')).toEqual(['0L']);
      expect(pair(label, 'gt')).toEqual(['0L']);
      expect(pair(label, 'eq')).toEqual(['4L']);
    }
    // ...while the two Double zeros of `t` still compare by sign.
    expect(names("g.V().hasLabel('t').as('a').V().hasLabel('t').as('b').where('a', lt('b')).by('x').select('a','b').by('name')"))
      .toEqual(['{"a":"neg","b":"pos"}']);
  });

  test('an intransitive zero set, or a value stream with no arrival order, DEFERS', () => {
    for (const q of [
      "g.V().hasLabel('t').order().by('x').values('name')", // 0m = -0.0d, 0m = 0.0d, -0.0d < 0.0d
      "g.V().hasLabel('t').fold().order(local).by('x').unfold().values('name')",
      "g.V().hasLabel('m').values('x').order()", // a value stream ties on its bytes ('0' TEXT), not its arrival
      "g.V().hasLabel('m2').values('x').order()",
    ]) expect(() => executeQuery(big, q, {})).toThrow(RaisedByQuery);
  });

  // A BigINTEGER zero beside both Double zeros: SQLite calls INTEGER `0` and REAL `±0.0` one value, so the
  // value stream's tie guard cannot see the group — the class flags must defer it, as the element sort does.
  // Java's binary-insertion sort over this intransitive comparator answers per arrival order
  // (`OrderGlobalStep.java:78`, `NumberHelper.java:278-310`); no answer here may be one of them by luck.
  test('a BigInteger zero among both signed zeros DEFERS in a value stream too, at every position', () => {
    const tri = seededStore();
    for (const x of ['0n', '0.0d', '-0.0d']) executeQuery(tri, `g.addV('z').property('x', ${x})`, {});
    for (const q of [
      "g.V().hasLabel('z').values('x').order().tail(1)",
      "g.V().hasLabel('z').values('x').order().range(1, 2)",
      "g.V().hasLabel('z').values('x').order().by(desc).limit(1)",
      "g.V().hasLabel('z').values('x').fold().order(local)",
      "g.V().hasLabel('z').local(values('x').order().limit(1))",
      "g.inject(0n, 0.0d, -0.0d).order().tail(1)",
      "g.inject(0.0d, -0.0d, 0n).order().limit(1)",
      "g.inject(0n, 0i, -0.0d).order().limit(1)", // 0i promotes to +0.0 against -0.0d: the same intransitive set
    ]) expect(() => executeQuery(tri, q, {})).toThrow(RaisedByQuery);
  });

  // A BigInteger/BigDecimal SUBJECT against a `-0.0d` LITERAL widens both to BigDecimal, where
  // `BigDecimal.valueOf(-0.0)` is an unsigned zero — EQUAL (`NumberHelper.java:362-399,850-859`). One rule in
  // `numericPair`, so every predicate site and depth agrees; the two Double zeros still compare by sign.
  describe('a stored big zero EQUALS a -0.0d literal, at every predicate site', () => {
    for (const big of ['0n', '0m']) {
      const s = seededStore();
      for (const x of [big, '-0.0d', '0.0d']) executeQuery(s, `g.addV('z').property('x', ${x})`, {});
      const at = (q: string) => typedAll(executeQuery(s, q, {}));
      test.each([
        ["g.V().hasLabel('z').values('x').is(eq(-0.0d)).count()", '2L'],
        ["g.V().hasLabel('z').has('x', -0.0d).count()", '2L'],
        ["g.V().hasLabel('z').has('x', neq(-0.0d)).count()", '1L'],
        ["g.V().hasLabel('z').values('x').is(lte(-0.0d)).count()", '2L'],
        ["g.V().hasLabel('z').values('x').is(gt(-0.0d)).count()", '1L'],
        ["g.V().hasLabel('z').values('x').is(lt(-0.0d)).count()", '0L'],
        ["g.V().hasLabel('z').has('x', within(-0.0d)).count()", '2L'],
        ["g.V().hasLabel('z').has('x', without(-0.0d)).count()", '1L'],
        ["g.V().hasLabel('z').has('x', inside(-0.0d, 1.0d)).count()", '1L'],
        ["g.V().hasLabel('z').has('x', between(-0.0d, 1.0d)).count()", '3L'],
        ["g.V().hasLabel('z').has('x', not(eq(-0.0d))).count()", '1L'],
        ["g.V().hasLabel('z').has('x', eq(-0.0d).or(eq(5))).count()", '2L'],
        ["g.V().hasLabel('z').where(values('x').is(eq(-0.0d))).count()", '2L'],
        ["g.V().hasLabel('z').filter(has('x', eq(-0.0d))).count()", '2L'],
        ["g.V().hasLabel('z').union(has('x', eq(-0.0d))).count()", '2L'],
        ["g.V().hasLabel('z').local(has('x', lte(-0.0d))).count()", '2L'],
        ["g.V().hasLabel('z').values('x').choose(is(eq(-0.0d)), constant(1), constant(0)).sum()", '2i'],
        [`g.inject(${big}).is(eq(-0.0d)).count()`, '1L'],
        [`g.inject(${big}).is(gt(-0.0d)).count()`, '0L'],
      ])(`${big}: %s`, (q, expected) => expect(at(q)).toEqual([expected]));
    }
    test('a SMALL integral zero still promotes to +0.0d, above -0.0d', () => {
      const s = seededStore();
      for (const x of ['0n', '0L', '0i', '-0.0d']) executeQuery(s, `g.addV('z').property('x', ${x})`, {});
      expect(typedAll(executeQuery(s, "g.V().hasLabel('z').values('x').is(eq(-0.0d)).count()", {}))).toEqual(['2L']);
      expect(typedAll(executeQuery(s, "g.V().hasLabel('z').values('x').is(gt(-0.0d)).count()", {}))).toEqual(['2L']);
      expect(typedAll(executeQuery(s, "g.inject(0L).is(gt(-0.0d)).count()", {}))).toEqual(['1L']);
    });
  });

  test('a value-stream tie SQLite also calls equal keeps arrival order', () => {
    // `0n` is stored INTEGER 0 and `-0.0d` REAL -0.0: equal bytes to SQLite, so the tie keeps the rows' order.
    expect(names("g.V().hasLabel('n').values('x').order().range(1, 2)")).toEqual(['-0d']);
    expect(names("g.V().hasLabel('n2').values('x').order().limit(1)")).toEqual(['-0d']);
  });

  // The same carrier, for the key's MAGNITUDE: a stored BigDecimal is decimal TEXT, so a child body's raw
  // value sorted after every number — `by(values('x'))` now reads the body's own type.
  test.each([
    "g.V().hasLabel('q').order().by(values('x')).values('name')",
    "g.V().hasLabel('q').order().by(coalesce(values('x'), constant(1))).values('name')",
    "g.V().hasLabel('q').order().by('x').values('name')",
  ])('%s orders 5m < 7n < 10.0d', (q) => expect(names(q)).toEqual(['"five"', '"seven"', '"ten"']));
});

// An edge `Property` orders by KEY then VALUE (`GremlinValueComparator`, `property.ts`) — its natural
// order is a VALUE key like any `by()`, so it goes through the same authority.
test("an edge Property's natural order orders -0.0 below 0.0", () => {
  const edges = seededStore();
  executeQuery(edges, "g.addV('e1').as('a').addE('r').from('a').to('a').property('w', 0.0d).iterate()", {});
  executeQuery(edges, "g.V().hasLabel('e1').as('a').addE('r').from('a').to('a').property('w', -0.0d).iterate()", {});
  const run = (q: string) => typedAll(executeQuery(edges, q, {}));
  expect(run("g.V().hasLabel('e1').outE('r').properties('w').order().value()")).toEqual(['-0d', '0d']);
  expect(run("g.V().hasLabel('e1').outE('r').properties('w').order().by(desc).value()")).toEqual(['0d', '-0d']);
  executeQuery(edges, "g.V().hasLabel('e1').as('a').addE('r').from('a').to('a').property('w', 0m).iterate()", {});
  expect(() => executeQuery(edges, "g.V().hasLabel('e1').outE('r').properties('w').order().value()", {})).toThrow(RaisedByQuery);
});

// A VALUE stream carries no arrival order (`orderRows`' scalar tie is the value), so a tie between two
// DISTINCT numbers the comparator calls equal fell to the value's REPRESENTATION — a stored BigDecimal is
// decimal TEXT, so `0m` sorted after `0.0d`/`0i`/`0L` whichever arrived first, and `limit(1)` took the wrong
// element. The reference stable-sorts over `NumberHelper.compare` and keeps ARRIVAL order
// (`.../step/map/OrderGlobalStep.java:78`, `.../util/NumberHelper.java:278-310`), which such a stream cannot
// state, so the tie DEFERS (`unstableTieGuard`) — in either insertion order, and through a branch whose
// input is realized by content (`positioned`). A by() sort carries the arrival order and answers it.
describe('a value-stream tie between distinct equal numbers defers rather than order by representation', () => {
  const ties = seededStore();
  const sets: Record<string, readonly [string, string]> = {
    b: ['0m', '0.0d'], rb: ['0.0d', '0m'], h: ['0m', '0i'], rh: ['0i', '0m'], u: ['0m', '0L'], ru: ['0L', '0m'],
    r: ['1m', '1.0d'], rr: ['1.0d', '1m'], mn: ['1m', '1n'],
  };
  for (const [label, xs] of Object.entries(sets)) for (const x of xs) executeQuery(ties, `g.addV('${label}').property('x', ${x})`, {});
  const forms = [
    "values('x').order()", "values('x').order().limit(1)", "values('x').order().range(1, 2)",
    "map(identity()).values('x').order()", "values('x').map(identity()).order()",
    "values('x').union(identity()).order()", "properties('x').value().order()",
  ];
  test.each(Object.keys(sets).flatMap((label) => forms.map((form) => [label, form] as const)))('%s: %s', (label, form) =>
    expect(() => executeQuery(ties, `g.V().hasLabel('${label}').${form}`, {})).toThrow(RaisedByQuery));

  test('an arrival-carrying sort answers the stable order', () => {
    const first = (label: string, q: string) => typedAll(executeQuery(ties, `g.V().hasLabel('${label}').${q}`, {}));
    expect(first('rb', "values('x').order().by(asc).limit(1)")).toEqual(['0d']);
    expect(first('rh', "values('x').order().by(identity(), asc).limit(1)")).toEqual(['0i']);
    expect(first('rr', "order().by('x').values('x').limit(1)")).toEqual(['1d']);
    expect(first('ru', "values('x').order().by(desc).limit(1)")).toEqual(['0L']);
  });
});
