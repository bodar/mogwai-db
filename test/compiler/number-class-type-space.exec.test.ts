// A value's CLASS survives every re-read, or the traversal declines — the fix-forward of the cluster C
// number-class stopgap's non-policy half. Asserted through the wire, because the defects are TYPE defects
// only the GraphBinary type code (or the decoded JS class) can see.
//
// 1. `asNumber()` over a numeric STRING is `NumberUtils.createNumber`'s Integer → Long → BigInteger ladder,
//    parsed EXACTLY (`AsNumberStep.parseNumber`,
//    vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/AsNumberStep.java:98-103).
//    Folded at compile time it used to type every integral parse as an Int, so '2147483648' reached the
//    GraphBinary Int writer as an internal RangeError; read at run time it rounded through a double.
// 2. EQUALITY NEVER CROSSES A TYPE SPACE (`Compare.eq` → `GremlinValueComparator.COMPARABILITY.equals`,
//    vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java:71-74,314-363):
//    a Boolean riding as 0/1 or a Date as epoch millis never equals a Number, at any depth.
// 3. A MEMBER keeps its tag: a group key, a group-by-value fold member and a collected member of a
//    `coalesce`/`choose` arm or a stored value read through a traversal `by()` frame as the class they
//    are — never a Boolean or Date re-read as a Number, never a wide long re-read as a String.
//
// The classes WITHIN Number (min/max promotion, a decimal string's Float, a sack's class) are pinned in
// `number-class-authority.exec.test.ts` — §6·7 decided the class is exact (2026-10-17).
import { test, expect, describe } from 'bun:test';
import { UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { RaisedByQuery } from '../../src/rel/raise.ts';
import { bagOf, seededStore } from '../support/harness.ts';
import { executeFramed } from '../support/executor.ts';
import { decode } from '../support/decode.ts';

/** GraphBinary type codes (`DataType` in the client) for the classes these tests tell apart. */
const T = { int: 0x01, long: 0x02, bigint: 0x23 } as const;

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
const WIDE = "g.V(1).property('x', 9007199254740993L) ;; ";
const DATE = "datetime('2020-01-01T00:00:00Z')";

describe('asNumber() over a numeric string picks createNumber\'s class exactly', () => {
  const folded: [string, unknown, number][] = [
    ["g.inject('5').asNumber()", 5, T.int],
    ["g.inject('2147483647').asNumber()", 2147483647, T.int],
    ["g.inject('2147483648').asNumber()", 2147483648, T.long],
    ["g.inject('-2147483649').asNumber()", -2147483649, T.long],
    ["g.inject('9007199254740993').asNumber()", 9007199254740993n, T.long],
    ["g.inject('99999999999999999999').asNumber()", 99999999999999999999n, T.bigint],
    // HEX takes createNumber's own ladder, by the count of significant hex digits — not the value.
    ["g.inject('0x7FFFFFFF').asNumber()", 2147483647, T.int],
    ["g.inject('0x80000000').asNumber()", 2147483648, T.long],
    ["g.inject('-0x80000000').asNumber()", -2147483648, T.long],
    ["g.inject('0x7FFFFFFFFFFFFFFF').asNumber()", 9223372036854775807n, T.long],
    ["g.inject('0x8000000000000000').asNumber()", 9223372036854775808n, T.bigint],
    ["g.inject('0xFFFFFFFFFFFFFFFFFFFF').asNumber()", 0xFFFFFFFFFFFFFFFFFFFFn, T.bigint],
    ["g.inject('0x00000000FF').asNumber()", 255, T.int],
    ["g.inject(' -0x10 ').asNumber()", -16, T.int],
    ["g.inject('0x1e5').asNumber()", 485, T.int],
    // A leading 0 is OCTAL (`Integer.decode`).
    ["g.inject('010').asNumber()", 8, T.int],
    ["g.inject('-010').asNumber()", -8, T.int],
  ];
  for (const [q, value, code] of folded)
    test(`folded: ${q}`, async () => expect(await typed(q)).toEqual([[value, code]]));

  test('a folded wide parse compares as the exact Long it is', async () =>
    expect(await values("g.inject('9007199254740993').asNumber().is(9007199254740993L)")).toEqual([9007199254740993n]));

  // `createNumber` skips an infinite Double and answers a BigDecimal; the fold has no exact carrier for
  // it here, so it declines rather than frame the infinity as a null.
  test("folded: a decimal past Double's range declines", () =>
    expect(typed("g.inject('1e400').asNumber()")).rejects.toThrow(UnsupportedTraversal));

  // `isCreatable` refuses what JS's Number() reads: binary/octal-literal prefixes, Infinity, '#' hex, an
  // octal digit past 7, an exponent on an octal spelling.
  for (const s of ['0b101', '0o17', 'Infinity', '#FF', '08', '0123e2', '0x'])
    for (const q of [`g.inject('${s}').asNumber()`, `g.inject('${s}').asNumber(GType.INT)`, `g.V(1).property('s', '${s}') ;; g.V(1).values('s').asNumber()`])
      test(`refused: ${q}`, () => expect(typed(q)).rejects.toThrow(`Can't parse string '${s}' as number.`));

  // A type qualifier (createNumber's requested class) and an underflow to zero (its BigDecimal) decline.
  for (const s of ['5L', '1.5f', '2d', '1e-400'])
    test(`folded: '${s}' declines`, () => expect(typed(`g.inject('${s}').asNumber()`)).rejects.toThrow(UnsupportedTraversal));

  test("folded: an octal spelling converts by its value", async () =>
    expect(await typed("g.inject('010').asNumber(GType.LONG)")).toEqual([[8, T.long]]));

  // At run time the barrier re-injects each value TYPED (`typedValueSeed`), its exact carrier as TEXT —
  // so a wide Long or a BigInteger is the exact number, and only what has no carrier defers.
  const runTime: [string, unknown, number][] = [
    ['9007199254740993', 9007199254740993n, T.long],
    ['99999999999999999999', 99999999999999999999n, T.bigint],
    ['0xFFFFFFFFFFFFFFFFFFFF', 0xFFFFFFFFFFFFFFFFFFFFn, T.bigint],
  ];
  for (const [s, value, code] of runTime)
    test(`run time: a stored '${s}' is the exact number`, async () =>
      expect(await typed(`g.V(1).property('s', '${s}') ;; g.V(1).values('s').asNumber()`)).toEqual([[value, code]]));
  for (const s of ['1e400', '5L', '1e-400'])
    test(`run time: a stored '${s}' defers`, () =>
      expect(typed(`g.V(1).property('s', '${s}') ;; g.V(1).values('s').asNumber()`)).rejects.toThrow(RaisedByQuery));
  test("run time: a stored '2147483648' is the number", async () =>
    expect(await values("g.V(1).property('s', '2147483648') ;; g.V(1).values('s').asNumber()")).toEqual([2147483648]));
});

describe('equality never crosses a type space', () => {
  const empty = [
    "g.V().coalesce(values('age'), constant(true)).is(1)",
    "g.V().union(values('age'), constant(true)).is(1)",
    "g.V().choose(has('age'), values('age'), constant(true)).is(1)",
    "g.V().map(coalesce(values('age'), constant(true))).is(1)",
    "g.V().local(coalesce(values('age'), constant(true)).is(1))",
    "g.V().where(coalesce(values('age'), constant(true)).is(1)).values('name')",
    "g.V().where(coalesce(values('age'), constant(true)).is(P.within(1, 2))).values('name')",
    `g.V().where(coalesce(values('age'), constant(${DATE})).is(1577836800000L)).values('name')`,
    `g.V().coalesce(values('age'), constant(${DATE})).is(1577836800000L)`,
    'g.inject(true).is(1)',
    'g.inject(true).is(P.eq(1))',
    "g.V(1).property('b', true) ;; g.V().has('b', 1).values('name')",
    "g.V(1).property('b', true) ;; g.V().has('b', P.within(1, 2)).values('name')",
    // An UNTAGGED subject (an inject int literal) frames by inference — a Number, never a Boolean/Date.
    'g.inject(1).is(true)',
    'g.inject(0).is(false)',
    'g.inject(1).is(P.within(true))',
    'g.inject(1).where(is(true))',
    "g.inject(1).is(datetime('1970-01-01T00:00:00.001Z'))",
    'g.inject(1).is(P.gt(true))',
  ];
  for (const q of empty) test(`empty: ${q}`, async () => expect(await values(q)).toEqual([]));

  // The same confinement through an ordering op, and the negations that it makes TRUE.
  const answered: [string, unknown[]][] = [
    ["g.V().where(coalesce(values('age'), constant(true)).is(P.gt(0))).values('name')", ['marko', 'vadas', 'josh', 'peter']],
    ["g.V().where(coalesce(values('age'), constant(true)).is(P.neq(1))).values('name')", ['marko', 'vadas', 'lop', 'josh', 'ripple', 'peter']],
    ["g.V().where(coalesce(values('age'), constant(true)).is(true)).values('name')", ['lop', 'ripple']],
    ["g.V().where(coalesce(values('age'), constant(true)).is(P.within(1, 29))).values('name')", ['marko']],
    ["g.V(1).property('b', true) ;; g.V().has('b', true).values('name')", ['marko']],
    ["g.V(1).property('b', true) ;; g.V().has('b', P.neq(1)).values('name')", ['marko']],
    ["g.V().has('age', P.within(29, 27)).values('name')", ['marko', 'vadas']],
    ['g.inject(1).is(1)', [1]],
    ['g.inject(1).is(P.neq(true))', [1]],
    ['g.inject(1).is(P.without(true))', [1]],
  ];
  for (const [q, want] of answered) test(`answered: ${q}`, async () => expect(bagOf(await values(q))).toEqual(bagOf(want)));
});

describe('a member keeps its class through a group key and a collected fold', () => {
  const keysOf = async (q: string) => [...((await values(q))[0] as Map<unknown, unknown>).keys()];

  test('a Boolean arm is a Boolean group key', async () =>
    expect(await values("g.V().group().by(coalesce(values('age'), constant(true))).by(count()).select(keys).unfold()"))
      .toEqual([true, 27, 29, 32, 35]));
  test('a Boolean choose arm is a Boolean group key', async () =>
    expect(await keysOf("g.V().group().by(choose(has('age'), values('age'), constant(true))).by(count())"))
      .toEqual([true, 27, 29, 32, 35]));
  // A fold collects in traverser order — marko (29) before vadas (27), the vertex order the coalesce emits in.
  test('a Boolean arm is a Boolean fold member inside a group value', async () =>
    expect((await values("g.V().group().by(label).by(coalesce(values('age'), constant(true)).fold())"))[0])
      .toEqual(new Map<string, unknown[]>([['person', [29, 27, 32, 35]], ['software', [true, true]]])));
  test('a Date arm is a Date group key', async () => {
    const keys = await keysOf(`g.V().group().by(coalesce(values('age'), constant(${DATE}))).by(count())`);
    expect(keys.filter((k) => k instanceof Date).map((k) => (k as Date).toISOString())).toEqual(['2020-01-01T00:00:00.000Z']);
  });
  test('a Date arm is a Date fold member', async () => {
    const [map] = await values(`g.V().group().by(label).by(coalesce(values('age'), constant(${DATE})).fold())`);
    expect(((map as Map<string, unknown[]>).get('software') ?? []).every((m) => m instanceof Date)).toBe(true);
  });

  const wide: [string, unknown[]][] = [
    [`${WIDE}g.V().group().by(values('x')).by(count()).select(keys).unfold()`, [9007199254740993n]],
    [`${WIDE}g.V().group().by(coalesce(values('x'), values('name'))).by(count()).select(keys).unfold().is(P.typeOf(GType.LONG))`, [9007199254740993n]],
    [`${WIDE}g.V().groupCount().by(coalesce(values('x'), values('age'))).select(keys).unfold().is(9007199254740993L)`, [9007199254740993n]],
    [`${WIDE}g.V().group().by(label).by(values('x').fold()).select(values).unfold().unfold()`, [9007199254740993n]],
  ];
  for (const [q, want] of wide) test(`a wide long stays a Long: ${q}`, async () => expect(await values(q)).toEqual(want));
});

// The sack is one UNTAGGED column read back by inference (`sackRead`), so a value whose class is not its
// storage class's declines — at compile time where the class is known, per row where only the row knows.
// The reference returns the held object as is (SackStep.map).
describe('a sack never re-reads a Boolean, a Date or a wide long as another class', () => {
  // The sack carries its own per-row type tag (`sack.ts` `SACK_TYPE_COL`), so a Boolean, a Date and a wide
  // Long come back as themselves — `SackStep.map` returns the held object as is.
  const kept: [string, number][] = [
    ['g.withSack(true).V(1).sack()', 0x27],
    [`g.withSack(${DATE}).V(1).sack()`, 0x04],
    ['g.withSack(true).V(1).sack().is(true)', 0x27],
    ['g.inject(1).sack(assign).by(constant(true)).sack()', 0x27],
    [`g.V(1).sack(assign).by(constant(${DATE})).sack()`, 0x04],
    ["g.V(1).property('b', true) ;; g.V(1).sack(assign).by('b').sack()", 0x27],
    [`${WIDE}g.V(1).sack(assign).by('x').sack()`, T.long],
  ];
  for (const [q, code] of kept) test(`kept: ${q}`, async () => expect((await typed(q)).map(([, t]) => t)).toEqual([code]));
  const answered: [string, unknown[]][] = [
    ["g.V().sack(assign).by('age').sack()", [29, 27, 32, 35]],
    ["g.V().hasLabel('software').sack(assign).by('name').sack()", ['lop', 'ripple']],
    ['g.V(1).sack(assign).by(T.label).sack()', ['person']],
    ["g.withSack('hello').V(1).sack()", ['hello']],
    ['g.withSack(1.5).V(1).sack().is(1.5)', [1.5]],
  ];
  for (const [q, want] of answered) test(`answered: ${q}`, async () => expect(bagOf(await values(q))).toEqual(bagOf(want)));
});

// A sum over a BigInteger past int64: SQLite's CAST saturates at 2^63-1, so the sum answered
// 9223372036854775807 where `NumberHelper.add` gives the exact BigInteger. It defers (the int64 overflow
// deferral), on both sides of the range and in a local sum; a mean names the exact tail it cannot carry.
describe('a sum never saturates past int64', () => {
  const deferred: [string, string][] = [
    ["g.inject('9223372036854775808').asNumber().sum()", 'integer arithmetic past 64 bits'],
    ["g.inject('99999999999999999999').asNumber().sum()", 'integer arithmetic past 64 bits'],
    ["g.inject('0x8000000000000000').asNumber().sum()", 'integer arithmetic past 64 bits'],
    ["g.inject('-9223372036854775809').asNumber().sum()", 'integer arithmetic past 64 bits'],
    ['g.inject(9223372036854775808n).sum()', 'integer arithmetic past 64 bits'],
    ['g.inject(9223372036854775808n).fold().sum(local)', 'integer arithmetic past 64 bits'],
    ["g.inject('99999999999999999999').asNumber().fold().sum(local)", 'integer arithmetic past 64 bits'],
    // A MEAN over a BigInteger is a BigDecimal division (`MeanNumber.getFinal`), never the Double SQL's is.
    ["g.inject('99999999999999999999').asNumber().mean()", 'BigDecimal scale arithmetic'],
    ['g.inject(9223372036854775808n).mean()', 'BigDecimal scale arithmetic'],
  ];
  for (const [q, message] of deferred) test(`deferred: ${q}`, () => expect(typed(q)).rejects.toThrow(message));
  const answered: [string, [unknown, number][]][] = [
    ["g.inject('9007199254740993').asNumber().sum()", [[9007199254740993n, T.long]]],
    ['g.inject(5n).sum()', [[5n, T.bigint]]],
    ['g.inject(5n, 6n).fold().sum(local)', [[11n, T.bigint]]],
  ];
  for (const [q, want] of answered) test(`answered: ${q}`, async () => expect(await typed(q)).toEqual(want));
});

// The REDUCER reads the rows' own tag at every site (`reducerAggregate`'s required row tag): a Boolean or
// a Date stored as a number is never added or ordered as one — in a group value, a local reduction or the
// top-level reducer alike — and a wide Long held as text is never ordered (or framed) as a String.
describe('a reducer never reads a Boolean, a Date or a wide long through its storage class', () => {
  const deferred = [
    "g.V().group().by(label).by(coalesce(values('age'), constant(true)).max())",
    "g.V().group().by(label).by(coalesce(values('age'), constant(true)).min())",
    "g.V().group().by(label).by(coalesce(values('age'), constant(true)).mean())",
    "g.V().group().by(label).by(coalesce(values('age'), constant(true)).sum())",
    "g.V().group().by(label).by(choose(has('age'), values('age'), constant(true)).max())",
    "g.V().coalesce(values('age'), constant(true)).fold().sum(local)",
    "g.V().hasLabel('software').coalesce(values('age'), constant(true)).fold().sum(local)",
    "g.V().coalesce(values('age'), constant(true)).fold().mean(local)",
    "g.V().choose(has('age'), values('age'), constant(true)).fold().sum(local)",
    `g.V().group().by(label).by(coalesce(values('age'), constant(${DATE})).max())`,
    `g.V().group().by(label).by(coalesce(values('age'), constant(${DATE})).sum())`,
    `g.V().coalesce(values('age'), constant(${DATE})).fold().sum(local)`,
    "g.V(1).property('b', true) ;; g.V().group().by(label).by(values('b').max())",
    "g.V(1).property('b', true) ;; g.V().values('b').fold().sum(local)",
    `${WIDE}g.V().group().by(label).by(values('x').max())`,
    `${WIDE}g.V().group().by(label).by(values('x').min())`,
  ];
  for (const q of deferred) test(`deferred: ${q}`, () => expect(typed(q)).rejects.toThrow(RaisedByQuery));
  const answered: [string, unknown[]][] = [
    ["g.V().hasLabel('software').coalesce(values('age'), constant(true)).max()", [true]],
    ["g.V().group().by(label).by(values('age').sum()).select(values).unfold()", [123]],
    ["g.V().group().by(label).by(values('age').max()).select(values).unfold()", [35]],
    ["g.V().group().by(label).by(values('age').mean()).select(values).unfold()", [30.75]],
    [`${WIDE}g.V().values('x').max()`, [9007199254740993n]],
  ];
  for (const [q, want] of answered) test(`answered: ${q}`, async () => expect(bagOf(await values(q))).toEqual(bagOf(want)));
});

// `asNumber()` converts BY TYPE (`AsNumberStep.map`, AsNumberStep.java:55-71): a Boolean raises, a Date is
// its epoch-milli Long — wherever the tag rides (a stored vtype, a branch arm, a min/max winner).
describe('asNumber() reads the value\'s type, not its storage class', () => {
  const raised = [
    "g.V().coalesce(values('age'), constant(true)).asNumber()",
    "g.V().choose(has('age'), values('age'), constant(true)).asNumber()",
    "g.V(1).property('b', true) ;; g.V(1).values('b').asNumber()",
    "g.V().hasLabel('software').coalesce(values('age'), constant(true)).max().asNumber()",
    "g.V().hasLabel('software').constant(true).max().asNumber()",
  ];
  for (const q of raised) test(`raised: ${q}`, () => expect(typed(q)).rejects.toThrow("Can't parse type Boolean as number."));
  test('a Date arm is its epoch-milli Long', async () =>
    expect((await typed(`g.V().hasLabel('software').coalesce(values('age'), constant(${DATE})).asNumber()`)))
      .toEqual([[1577836800000, T.long], [1577836800000, T.long]]));
});

// `asString()` is `String.valueOf` (AsStringGlobalStep.java:42-46): a Boolean is `true`, not `1`. A Date or
// Duration renders through Java's toString, which is not reproduced — it declines or defers, never the millis.
describe('asString() reads the value\'s type, not its storage class', () => {
  const answered: [string, unknown[]][] = [
    ['g.inject(true).asString()', ['true']],
    ['g.inject(false).asString()', ['false']],
    ["g.V().hasLabel('software').constant(true).asString()", ['true', 'true']],
    ["g.V().hasLabel('software').coalesce(values('age'), constant(true)).asString()", ['true', 'true']],
    ["g.V(1).property('b', true) ;; g.V(1).values('b').asString()", ['true']],
    ["g.V().hasLabel('software').coalesce(values('age'), constant(true)).max().asString()", ['true']],
    ["g.V(1).project('a').by(constant(true).asString()).select('a')", ['true']],
    ['g.inject(true, 1).fold().asString(local)', [['true', '1']]],
    ["g.V().values('age').asString()", ['29', '27', '32', '35']],
  ];
  for (const [q, want] of answered) test(`answered: ${q}`, async () => expect(bagOf(await values(q))).toEqual(bagOf(want)));
  test('a Date arm defers', () =>
    expect(typed(`g.V().coalesce(values('age'), constant(${DATE})).asString()`)).rejects.toThrow(RaisedByQuery));
  test('a Date fold member defers', () =>
    expect(typed(`g.V().coalesce(values('age'), constant(${DATE})).fold().asString()`)).rejects.toThrow(RaisedByQuery));
  test('a static Date declines', () =>
    expect(typed(`g.inject(${DATE}).asString()`)).rejects.toThrow(UnsupportedTraversal));
});

// A bare list literal has no member tag, so a Boolean/Date member written as its storage number would be
// re-read as a Number by every member op after (`inject([true,1])` framed `[1,1]`) — it declines.
describe('a list literal never carries a Boolean or Date member as a bare number', () => {
  for (const q of ['g.inject([true, 1])', 'g.inject([true, 1]).unfold()', `g.inject([${DATE}, 1])`, 'g.V().constant([true, 1]).unfold()'])
    test(`declined: ${q}`, () => expect(typed(q)).rejects.toThrow(UnsupportedTraversal));
  test('a numeric list literal still answers', async () => expect(await values('g.inject([1, 2]).unfold()')).toEqual([1, 2]));
});
