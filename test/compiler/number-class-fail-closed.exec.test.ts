// The NUMBER/TYPE channel's wrong answers, each pinned either to the reference answer or to a deferral
// (`UnsupportedTraversal` at compile time, a `RaisedByQuery` deferral mid-statement). Asserted through
// the wire, because the defects are TYPE defects — an Int for a Long, a String for a Long — which only
// the GraphBinary type code can see.
//
// 1. ORDERABILITY never ties silently: a `{t:null, v}` member (a computed group KEY) is classified by its
//    `v`, a token orders by its enum's declaration order, and anything else declines.
// 2. A reducer never DROPS a text value: a `sum`/`mean` over one, and a `min`/`max` over text among
//    numbers, defer — at every depth, because every reducer site shares the one guard.
// 3. A sum/min/max over a known `long` class is stated as one, so a predicate after it compares the number —
//    beside `result: 'number'`, so a branch merge after it still declines.
// 4. A runtime `asNumber(GType.X)` defers where a SQLite CAST and `NumberHelper` disagree.
// 5. A computed property value is stored with its type, or the write declines.
// 6. A `constant()` inside a body keeps its declared type through a branch merge.
import { test, expect, describe } from 'bun:test';
import { UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { RaisedByQuery } from '../../src/rel/raise.ts';
import { orderabilityCompare } from '../../src/compiler/rel/orderability.ts';
import { seededStore } from '../support/harness.ts';
import { executeFramed } from '../support/executor.ts';
import { decode } from '../support/decode.ts';

/** GraphBinary type codes (`DataType` in the client) for the classes these tests tell apart. */
const T = { int: 0x01, long: 0x02, string: 0x03, double: 0x07, float: 0x08, byte: 0x24, short: 0x26, bigint: 0x23, map: 0x0a } as const;

/** Each result as `[value, type code]`; `;;`-separated statements run in order on one store and the last
 *  one is returned. */
async function typed(q: string): Promise<[unknown, number][]> {
  const store = seededStore();
  const parts = q.split(' ;; ');
  for (const p of parts.slice(0, -1)) executeFramed(store, p);
  const out: [unknown, number][] = [];
  for (const f of executeFramed(store, parts.at(-1)!)) out.push([await decode(f.buf), f.buf[0]!]);
  return out;
}
const values = async (q: string) => (await typed(q)).map(([v]) => v);

describe('ORDERABILITY classifies or declines, never ties', () => {
  // GremlinValueComparator.Type puts Number before String
  // (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java:243-255).
  test('a computed group key {t:null,v} ranks by its value: numbers, then strings', async () => {
    const [[map]] = await typed("g.V().group().by(__.coalesce(__.values('age').sum(), __.values('name'))).by(count()).order(local).by(keys)");
    expect([...(map as Map<unknown, unknown>).keys()]).toEqual([27, 29, 32, 35, 'lop', 'ripple']);
  });

  test('tokens order by their enum: Direction before T, T by declaration (label, id)', async () => {
    const [[map]] = await typed('g.E(7).elementMap().order(local).by(keys)');
    expect([...(map as Map<any, unknown>).keys()].map((k) => (typeof k === 'string' ? k : k.elementName)))
      .toEqual(['weight', 'OUT', 'IN', 'label', 'id']);
  });

  test('an unclassifiable member declines rather than tying', () => {
    expect(() => orderabilityCompare({ t: 'mystery', v: 1 }, { t: 'mystery', v: 2 })).toThrow(UnsupportedTraversal);
    expect(() => orderabilityCompare({ not: 'a member' }, 1)).toThrow(UnsupportedTraversal);
    expect(orderabilityCompare({ t: null, v: 2 }, { t: null, v: 'a' })).toBeLessThan(0);
  });
});

describe('a reducer never drops a text value', () => {
  // NumberHelper adds a wide long exactly and throws on a String
  // (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:452);
  // the storage class cannot tell the two apart, so both defer.
  const deferred = [
    "g.inject(1).union(__.constant(9007199254740992L), __.constant(2)).sum()",
    "g.V(1).union(__.constant(9007199254740992L), __.values('age')).sum()",
    "g.V(1).union(__.constant(9007199254740992L), __.values('age')).sum().is(9007199254741021L)",
    "g.V(1).union(__.constant(9007199254740992L), __.values('age')).sum().is(P.neq(9007199254741021L))",
    "g.V(1).union(__.constant(9007199254740992L), __.values('age')).mean()",
    "g.V(1).local(__.union(__.constant(9007199254740992L), __.values('age')).sum())",
    "g.V(1).union(__.constant(9007199254740992L), __.values('age')).fold().sum(local)",
    "g.V().group().by('name').by(__.union(__.constant(9999999999999970L), __.values('age')).sum())",
    "g.V().values('name').sum()",
    "g.V(1).property('x', 9007199254740993L) ;; g.V().values('x').sum()",
    "g.V(1).property('x', 9007199254740993L) ;; g.V().where(__.values('x').sum().is(9007199254740993L)).values('name')",
  ];
  for (const q of deferred) test(`sum/mean defers: ${q}`, () => expect(typed(q)).rejects.toThrow(RaisedByQuery));

  // NumberHelper.max/min compare across classes with compareTo, which throws
  // (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:582-597).
  for (const q of [
    "g.V().group().by('name').by(__.union(__.constant(9999999999999970L), __.values('age')).max())",
    "g.V().group().by('name').by(__.union(__.constant(-9999999999999970L), __.values('age')).min())",
  ]) test(`min/max over text among numbers defers: ${q}`, () => expect(typed(q)).rejects.toThrow(RaisedByQuery));

  test('single-class reducers answer as before', async () => {
    expect(await typed("g.V().values('age').sum()")).toEqual([[123, T.int]]);
    expect(await typed("g.V().values('age').mean()")).toEqual([[30.75, T.double]]);
    expect(await values("g.V().group().by(label).by(__.values('name').max())"))
      .toEqual([new Map([['person', 'vadas'], ['software', 'ripple']])]);
  });
});

describe('a sum over a known long class compares as a number', () => {
  const WIDE = 'g.inject(9007199254740992L, 29L).sum()';
  test.each([
    [`${WIDE}.is(P.gt(100))`, [9007199254741021n]],
    [`${WIDE}.is(P.lt(10007199254741021L))`, [9007199254741021n]],
    [`${WIDE}.is(P.gt(10007199254741021L))`, []],
    [`${WIDE}.is(9007199254741021L)`, [9007199254741021n]],
    [`${WIDE}.is(P.neq(9007199254741021L))`, []],
    [`${WIDE}.is(P.within(9007199254741021L, 1L))`, [9007199254741021n]],
    [`${WIDE}.where(__.is(P.gt(10007199254741021L)))`, []],
    [`${WIDE}.as('a').where(__.select('a').is(P.lt(10007199254741021L))).select('a')`, [9007199254741021n]],
    ['g.inject(-9007199254740992L, -29L).sum().is(P.lt(-100))', [-9007199254741021n]],
    ['g.inject(9007199254740992L, 29L).fold().sum(local).is(P.lt(10007199254741021L))', [9007199254741021n]],
    ['g.inject(9007199254740993L, 1L).max().is(P.gt(100))', [9007199254740993n]],
    ['g.inject(9007199254740993L, 1L).fold().max(local).is(P.gt(100))', [9007199254740993n]],
    ['g.inject(1L, 2L).sum().as(\'a\').select(\'a\')', [3]],
    [`${WIDE}.as('a').select('a')`, [9007199254741021n]],
  ])('%s', async (q, want) => {
    expect(await typed(q)).toEqual(want.map((v) => [v, T.long]));
  });

  // The class rides beside `result: 'number'`, never in place of it: every consumer not audited for a
  // reducer result (a branch merge, a filter body) still DECLINES, rather than merging the arms into a
  // stream whose follow-on reducer types by storage class (an Int, where Long + Long is a Long —
  // vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:452).
  for (const q of [
    "g.inject(1L,2L).sum().union(__.identity(), __.constant(5L)).sum()",
    "g.inject(1L,2L).sum().union(__.identity(), __.constant(5L)).fold().sum(local)",
    "g.inject(1L,2L).fold().sum(local).union(__.identity(), __.constant(5L)).sum()",
    "g.inject(1L,2L).sum().union(__.identity(), __.constant(5)).sum()",
    "g.inject(1L,2L).sum().union(__.identity(), __.constant(5)).max()",
    "g.inject(1L,2L).sum().coalesce(__.is(4), __.constant(0))",
    "g.inject(1L,2L).sum().choose(__.is(3), __.identity(), __.constant(1))",
    "g.inject(9007199254740993L, 1L).max().union(__.identity(), __.constant(5L)).sum()",
  ]) test(`declines: ${q}`, () => expect(typed(q)).rejects.toThrow(UnsupportedTraversal));

  test('asNumber over a known long sum narrows as before: in range, or the reference overflow message', async () => {
    expect(await typed('g.inject(1L,2L).sum().asNumber(GType.INT)')).toEqual([[3, T.int]]);
    expect(await typed(`${WIDE}.asNumber(GType.DOUBLE)`)).toEqual([[9007199254741020, T.double]]);
    // NumberHelper.java:766's message, raised by the reducer-result overflow guard over the decimal TEXT.
    await expect(typed(`${WIDE}.asNumber(GType.INT)`)).rejects.toThrow("Can't convert number of type Long to Integer due to overflow.");
  });
});

describe('a runtime asNumber defers where the cast and NumberHelper disagree', () => {
  // NumberHelper.performConversion throws on overflow and on infinity
  // (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:724-800).
  for (const q of [
    "g.V(1).values('age').math('_*100000000').asNumber(GType.INT)",
    "g.V(1).values('age').math('_*10').asNumber(GType.BYTE)",
    "g.V(1).values('age').math('_*1e30').asNumber(GType.LONG)",
    "g.V(1).values('age').math('_*1e30').asNumber(GType.BIGINT)",
    "g.V(1).values('age').math('_*1e300').asNumber(GType.FLOAT)",
    "g.V(1).values('name').asNumber(GType.INT)",
    "g.V(1).values('name').asNumber(GType.DOUBLE)",
    "g.V().project('a').by(__.values('age').math('_*100000000').asNumber(GType.INT))",
    "g.V().values('age').math('_*100000000').fold().unfold().asNumber(GType.INT)",
    "g.V(1).values('age').math('_*1e300*1e300').asNumber(GType.LONG)",
  ]) test(`defers: ${q}`, () => expect(typed(q)).rejects.toThrow(RaisedByQuery));

  test('inside the range the cast is the reference: truncation toward zero, the target class', async () => {
    expect(await typed("g.V(1).values('age').math('_*1.5').asNumber(GType.INT)")).toEqual([[43, T.int]]);
    expect(await typed("g.V(1).values('age').asNumber(GType.BYTE)")).toEqual([[29, T.byte]]);
    expect(await typed("g.V().values('age').sum().asNumber(GType.BYTE)")).toEqual([[123, T.byte]]);
    expect(await typed("g.V().values('age').mean().asNumber(GType.INT)")).toEqual([[30, T.int]]);
  });
});

describe('a computed property value is stored with its type, or the write declines', () => {
  test.each([
    ["g.V(1).property('n', __.values('age').asNumber(GType.BYTE)) ;; g.V(1).values('n')", [[29, T.byte]]],
    ["g.V(1).property('n', __.values('age').asNumber(GType.SHORT)) ;; g.V(1).values('n')", [[29, T.short]]],
    ["g.V(1).property('n', __.values('age').asNumber(GType.BIGINT)) ;; g.V(1).values('n')", [[29n, T.bigint]]],
    ["g.V(1).property('n', __.outE().values('weight').max()) ;; g.V(1).values('n')", [[1, T.double]]],
  ])('%s', async (q, want) => {
    expect(await typed(q)).toEqual(want as [unknown, number][]);
  });

  test('a type a NULL vtype would retype declines (a Date read back as an Int)', () => {
    return expect(typed("g.V(1).property('n', __.values('age').asDate())")).rejects.toThrow(UnsupportedTraversal);
  });
});

describe('a constant inside a body keeps its declared type', () => {
  test.each([
    ["g.V(1).flatMap(__.coalesce(__.constant(1L), __.constant('x')))", [[1, T.long]]],
    ["g.V(1).map(__.coalesce(__.constant(1L), __.constant('x')))", [[1, T.long]]],
    ["g.V(1).local(__.coalesce(__.constant(1b), __.constant('x')))", [[1, T.byte]]],
    ["g.V(1).flatMap(__.coalesce(__.constant(1.5f), __.constant(2.5d)))", [[1.5, T.float]]],
    ["g.V(3).flatMap(__.choose(__.has('age'), __.constant(1L), __.constant('x')))", [['x', T.string]]],
    ["g.V(1).flatMap(__.choose(__.has('age'), __.constant(1L), __.constant('x')))", [[1, T.long]]],
    ["g.V(2).flatMap(__.coalesce(__.out().values('age').sum(), __.constant(1L)))", [[1, T.long]]],
  ])('%s', async (q, want) => {
    expect(await typed(q)).toEqual(want as [unknown, number][]);
  });
});

// Review round 3. Each case below is a value a probe found wrong (or an internal error) at the parent.
const X = "g.V(1).property('x', 9007199254740993L) ;; ";

describe('a number compares in the reference common class, at every depth', () => {
  // NumberHelper.compare converts both sides to getHighestCommonNumberClass first: a Long against a Double
  // is a DOUBLE compare (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:362-398,670-681;
  // Compare.java:66-69), where SQLite compares an INTEGER and a REAL exactly.
  test.each([
    // 9007199254741021 is 9007199254741020.0 as a double, so it is not greater.
    ['g.inject(9007199254740992L,29L).sum().is(P.gt(9007199254741020.0d))', []],
    ['g.inject(9007199254740992L,29L).sum().is(P.gt(9007199254741020.5d))', []],
    ['g.inject(9007199254740992L,29L).fold().sum(local).is(P.gt(9007199254741020.0d))', []],
    ['g.inject(9007199254740993L,1L).max().is(P.gt(9007199254740992.0d))', []],
    ['g.inject(9007199254741021L).is(P.gt(9007199254741020.0d))', []],
    ['g.inject(9007199254740992L,2L).sum().is(P.eq(9007199254740994.0d))', [[9007199254740994n, T.long]]],
    ['g.inject(9007199254740993L).is(P.eq(9007199254740992.0d))', [[9007199254740993n, T.long]]],
    ['g.inject(9007199254740993L).is(P.within(9007199254740992.0d, 1.5d))', [[9007199254740993n, T.long]]],
    ['g.inject(9007199254740993L).is(P.neq(9007199254740992.0d))', []],
    ['g.inject(9007199254740992.0d).is(P.eq(9007199254740993L))', [[9007199254740992, T.double]]],
    ['g.inject(9007199254740992.0d).is(P.gte(9007199254740993L))', [[9007199254740992, T.double]]],
    ['g.inject(9007199254740992L,29L).sum().is(P.gt(28.5d))', [[9007199254741021n, T.long]]],
    // A Long is never equal to a String, however it is spelled (GremlinValueComparator.java:71-74).
    ["g.inject(9007199254740992L,2L).sum().is(P.eq('9007199254740994'))", []],
    ["g.inject(9007199254740994L).is(P.eq('9007199254740994'))", []],
    // A Boolean is not a Number, so a numeric bound never matches it.
    ['g.inject(true, 1).is(P.gt(0))', [[1, T.int]]],
    [`${X}g.V().has('x', 9007199254740992.0d).values('name')`, [['marko', T.string]]],
    [`${X}g.V().has('x', P.gt(9007199254740992.0d)).values('name')`, []],
    [`${X}g.V().has('x', '9007199254740993').values('name')`, []],
    [`${X}g.V().where(__.values('x').is(P.eq(9007199254740992.0d))).values('name')`, [['marko', T.string]]],
    [`${X}g.V().values('x').as('a').select('a').is(P.gt(9007199254740992.0d))`, []],
    [`${X}g.V().union(__.values('x'), __.values('age')).is(P.eq(9007199254740992.0d))`, [[9007199254740993n, T.long]]],
    ["g.V().has('age', 29.0d).values('name')", [['marko', T.string]]],
  ])('%s', async (q, want) => {
    expect(await typed(q)).toEqual(want as [unknown, number][]);
  });

  // An Integer against a Float is a FLOAT compare; past 2^24 SQLite cannot round like one, so it defers.
  test('an int past 2^24 against a float bound defers', () =>
    expect(typed('g.inject(16777217).is(P.eq(16777216.0f))')).rejects.toThrow(RaisedByQuery));
});

describe('a min/max winner off a stored vtype compares as its own type', () => {
  test.each([
    `${X}g.V().values('x','age').max().is(P.gt(100))`,
    `${X}g.V().values('x','age').fold().max(local).is(P.gt(100))`,
    `${X}g.V().values('x','age').max().as('a').select('a').is(P.gt(100))`,
    `${X}g.V().project('a').by(__.values('x','age').max()).select('a').is(P.gt(100))`,
  ])('%s', async (q) => {
    expect(await typed(q)).toEqual([[9007199254740993n, T.long]]);
  });
  test('a where() over it', async () => {
    expect(await values(`${X}g.V().where(__.values('x','age').max().is(P.gt(100))).values('name')`)).toEqual(['marko']);
  });
});

describe('min/max over values of different types defers at every reducer site', () => {
  // compareTo across classes throws (NumberHelper.java:582-597).
  for (const q of [
    "g.V().values('age','name').max()",
    "g.V().values('age','name').min()",
    "g.V().local(__.values('name','age').max())",
    "g.V().project('m').by(__.values('name','age').max())",
    "g.V().values('age','name').fold().max(local)",
    "g.inject(datetime('2020-01-01'), 1).max()",
    'g.inject(true, 1).min()',
  ]) test(`defers: ${q}`, () => expect(typed(q)).rejects.toThrow(RaisedByQuery));

  test('one type still answers', async () => {
    expect(await typed("g.V().values('age').max()")).toEqual([[35, T.int]]);
    expect(await typed("g.V().values('name').min()")).toEqual([['josh', T.string]]);
    expect(await typed('g.inject(1, 2.5d).max()')).toEqual([[2.5, T.double]]);
  });
});

describe('a sum over a non-Number, or past 64 bits, defers', () => {
  // SumGlobalStep adds through NumberHelper.add(Number, Number); a Long past 2^63 promotes to a BigInteger
  // (NumberHelper.java:430-452), which this store cannot carry.
  for (const q of [
    'g.inject(true, 1).sum()',
    "g.inject(datetime('2020-01-01'), 1).sum()",
    'g.inject(9223372036854775807L, 1L).sum()',
  ]) test(`defers: ${q}`, () => expect(typed(q)).rejects.toThrow(RaisedByQuery));
  test('a static non-Number stream declines', () => expect(typed('g.inject(true, false).sum()')).rejects.toThrow(UnsupportedTraversal));
});

describe('a raising asNumber raises where only its existence is read', () => {
  // TraversalFilterStep/ChooseStep evaluate the body (hasNext()), so the conversion throws there too.
  for (const q of [
    "g.V().where(__.values('age').math('_*10').asNumber(GType.BYTE))",
    "g.V().filter(__.values('age').math('_*10').asNumber(GType.BYTE))",
    "g.V().not(__.values('age').math('_*10').asNumber(GType.BYTE))",
    "g.V().where(__.values('age').math('_*1e300').asNumber(GType.LONG))",
    "g.V().where(__.values('name').asNumber(GType.INT))",
    "g.V().choose(__.values('name').asNumber(GType.INT), __.constant(1), __.constant(2))",
    "g.V().values('name').asNumber(GType.INT).count()",
    "g.V().coalesce(__.values('name').asNumber(GType.INT), __.constant(0))",
  ]) test(`defers: ${q}`, () => expect(typed(q)).rejects.toThrow(RaisedByQuery));
  test('a body the filter could drop as inert is not dropped', () =>
    expect(typed("g.V().where(__.values('age').math('_*10').asNumber(GType.BYTE).count())")).rejects.toThrow(UnsupportedTraversal));
  test('a converting body still filters', async () => {
    expect(await values("g.V().where(__.values('age').asNumber(GType.BYTE)).values('name')")).toEqual(['marko', 'vadas', 'josh', 'peter']);
  });
});

describe('asNumber keeps a wide long exact, and a literal converts as performConversion does', () => {
  test.each([
    ['g.inject(9007199254740992L,29L).sum().asNumber(GType.LONG)', [[9007199254741021n, T.long]]],
    ['g.inject(9007199254740992L,29L).sum().asNumber(GType.BIGINT)', [[9007199254741021n, T.bigint]]],
    ['g.inject(9007199254740992L,29L).fold().sum(local).asNumber(GType.LONG)', [[9007199254741021n, T.long]]],
    [`${X}g.V().values('x').asNumber(GType.LONG)`, [[9007199254740993n, T.long]]],
    [`${X}g.V().values('x').asNumber(GType.LONG).is(P.gt(9007199254740992L))`, [[9007199254740993n, T.long]]],
    ['g.inject(9007199254740993L,1L).max().asNumber(GType.LONG)', [[9007199254740993n, T.long]]],
    ['g.inject(9007199254741021L).asNumber(GType.LONG)', [[9007199254741021n, T.long]]],
    ['g.inject(9007199254741021L).asNumber(GType.BIGINT)', [[9007199254741021n, T.bigint]]],
    ['g.inject(9007199254741021L).asNumber()', [[9007199254741021n, T.long]]],
    ['g.inject(9007199254741021L).asNumber(GType.DOUBLE)', [[9007199254741020, T.double]]],
    ['g.inject(1.1f).asNumber(GType.DOUBLE)', [[1.1, T.double]]],
    ['g.inject(1.5m).asNumber(GType.INT)', [[1, T.int]]],
    ['g.inject(9.223372036854775807E18d).asNumber(GType.LONG)', [[9223372036854775807n, T.long]]],
  ])('%s', async (q, want) => {
    expect(await typed(q)).toEqual(want as [unknown, number][]);
  });

  // NumberHelper.performConversion / longValue, at the pin (NumberHelper.java:724-805): the message names
  // the SOURCE class.
  test.each([
    ['g.inject(1.0e300d).asNumber(GType.FLOAT)', "Can't convert number of type Double to Float due to overflow."],
    ['g.inject(1.0e300d).asNumber(GType.LONG)', "Can't convert number of type Double to Long due to overflow."],
    ['g.inject(-1.0e300d).asNumber(GType.LONG)', "Can't convert number of type Double to Long due to underflow."],
    ['g.inject(9007199254741021L).asNumber(GType.INT)', "Can't convert number of type Long to Integer due to overflow."],
    ["g.inject('300.5').asNumber(GType.BYTE)", "Can't convert number of type Float to Byte due to overflow."],
  ])('%s', (q, message) => expect(typed(q)).rejects.toThrow(message));

  test('a wide integral double property is stored, not an internal error', async () => {
    expect(await typed("g.V(1).property('w', 1.0e20d) ;; g.V(1).values('w')")).toEqual([[1e20, T.double]]);
  });
});
