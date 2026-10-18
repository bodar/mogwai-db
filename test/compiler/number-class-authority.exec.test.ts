// THE NUMBER CLASS IS EXACT (build plan §6·7, decided 2026-10-17) — every result reproduces the reference's
// Java class, through ONE authority: `reducer.ts`'s `numberWidth`/`numberFloating` read a row's
// `NumberHelper.getHighestCommonNumberInfo` pair, `commonNumberClass` names `determineNumberClass` of it
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:362-390,861-874`),
// and every producer (a reducer, the sack's folds) states its class there. A `min`/`max` winner keeps its OWN
// class — a deliberate divergence from `NumberHelper.max`'s promotion (`docs/feature-support-matrix.md`).
//
// Asserted through the WIRE: each result is rendered with its GraphBinary type code at every depth
// (`5i` an Int, `5L` a Long, `5d` a Double, `5f` a Float, `5s` a Short, `5b` a Byte, `5N` a BigInteger,
// `<unscaled>e-<scale>M` a BigDecimal), because a class defect is invisible to a JS value compare.
//
// Where exactness is not reachable the traversal DECLINES (`UnsupportedTraversal`) or DEFERS in-statement
// (`RaisedByQuery`) — never a different answer.
import { test, expect, describe } from 'bun:test';
import { UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { RaisedByQuery } from '../../src/rel/raise.ts';
import { seededStore } from '../support/harness.ts';
import { executeFramed } from '../support/executor.ts';

/** A floating value's spelling, its SIGN included — `${-0}` is `0`, which would hide a lost negative zero. */
const signed = (v: number): string => (Object.is(v, -0) ? '-0' : String(v));

/** One GraphBinary value, rendered with its class at every depth. */
function render(b: Buffer, at: { i: number }): string {
  const type = b[at.i++]!;
  if (b[at.i++]! & 1) return 'null';
  const bigint = (n: number): bigint => {
    let v = 0n;
    for (let k = 0; k < n; k++) v = (v << 8n) | BigInt(b[at.i + k]!);
    if (n && b[at.i]! & 0x80) v -= 1n << BigInt(8 * n);
    at.i += n;
    return v;
  };
  const many = (n: number, one: () => string): string[] => Array.from({ length: n }, one);
  switch (type) {
    case 0x01: { const v = b.readInt32BE(at.i); at.i += 4; return `${v}i`; }
    case 0x02: { const v = b.readBigInt64BE(at.i); at.i += 8; return `${v}L`; }
    case 0x07: { const v = b.readDoubleBE(at.i); at.i += 8; return `${signed(v)}d`; }
    case 0x08: { const v = b.readFloatBE(at.i); at.i += 4; return `${signed(v)}f`; }
    case 0x24: { const v = b.readInt8(at.i); at.i += 1; return `${v}b`; }
    case 0x26: { const v = b.readInt16BE(at.i); at.i += 2; return `${v}s`; }
    case 0x27: return b[at.i++] ? 'true' : 'false';
    case 0x04: { const year = b.readInt32BE(at.i); at.i += 18; return `Date(${year})`; }
    case 0x03: { const n = b.readInt32BE(at.i); at.i += 4; const s = b.toString('utf8', at.i, at.i + n); at.i += n; return JSON.stringify(s); }
    case 0x23: { const n = b.readInt32BE(at.i); at.i += 4; return `${bigint(n)}N`; }
    case 0x22: { const scale = b.readInt32BE(at.i); at.i += 4; const n = b.readInt32BE(at.i); at.i += 4; return `${bigint(n)}e-${scale}M`; }
    case 0x09: { const n = b.readInt32BE(at.i); at.i += 4; return `[${many(n, () => render(b, at)).join(',')}]`; }
    case 0x0b: { const n = b.readInt32BE(at.i); at.i += 4; return `set[${many(n, () => render(b, at)).join(',')}]`; }
    case 0x0a: { const n = b.readInt32BE(at.i); at.i += 4; return `{${many(n, () => `${render(b, at)}:${render(b, at)}`).join(',')}}`; }
    default: throw new Error(`type 0x${type.toString(16)}`);
  }
}

/** The traversal's results, each rendered with its class; `;;`-separated statements run in order on one
 *  store and the last one is answered. */
async function classes(q: string): Promise<string[]> {
  const store = seededStore();
  const parts = q.split(' ;; ');
  for (const part of parts.slice(0, -1)) executeFramed(store, part);
  return executeFramed(store, parts.at(-1)!).map((frame) => render(frame.buf, { i: 0 }));
}
const DATE = "datetime('2020-01-01T00:00:00Z')";

describe('a BigInteger compares exactly in an ordering predicate, or defers', () => {
  // `NumberHelper.compare` widens a BigInteger pair to BigInteger; SQLite's `CAST(… AS INTEGER)` saturates
  // past int64, so a bound AT the edge used to read every wider subject as equal to it.
  const answered: [string, string[]][] = [
    ["g.inject('99999999999999999999').asNumber().is(P.gt(9223372036854775807L))", ['99999999999999999999N']],
    ["g.inject('9223372036854775808').asNumber().where(is(P.gt(9223372036854775807L)))", ['9223372036854775808N']],
    ['g.inject(99999999999999999999n).is(P.gt(99999999999999999998n))', ['99999999999999999999N']],
    ['g.inject(99999999999999999999n).is(P.lt(99999999999999999998n))', []],
    ['g.inject(99999999999999999999n).is(P.gte(99999999999999999999n))', ['99999999999999999999N']],
    ['g.inject(-99999999999999999999n).is(P.lt(-99999999999999999998n))', ['-99999999999999999999N']],
    ['g.inject(-99999999999999999999n).is(P.gt(-99999999999999999998n))', []],
    ['g.inject(-9223372036854775809n).is(P.lt(-9223372036854775808L))', ['-9223372036854775809N']],
    ['g.inject(-9223372036854775809n).is(P.gte(-9223372036854775808L))', []],
    ['g.inject(9223372036854775808n).is(P.lte(9223372036854775807L))', []],
    ['g.inject(9223372036854775808n).is(P.gt(1.5d))', ['9223372036854775808N']],
    ['g.inject(5L).is(P.lt(99999999999999999999n))', ['5L']],
    ['g.inject(1.5d).is(P.lt(99999999999999999999n))', ['1.5d']],
    ["g.V(1).property('b', 99999999999999999999n) ;; g.V().has('b', P.gt(99999999999999999998n)).values('name')", ['"marko"']],
    ["g.V(1).property('b', 99999999999999999999n) ;; g.V(1).values('b').is(P.gt(9223372036854775807L))", ['99999999999999999999N']],
    ["g.V(1).property('s', '99999999999999999999') ;; g.V(1).values('s').asNumber().is(P.gt(9223372036854775807L))", ['99999999999999999999N']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
  // A floating bound at or past ±2^63 against a subject past int64 widens to `BigDecimal.valueOf` — exact.
  test('g.inject(9223372036854775808n).is(P.lt(1e300d))', async () => expect(await classes('g.inject(9223372036854775808n).is(P.lt(1e300d))')).toEqual(['9223372036854775808N']));
  test('g.inject(1e300d).is(P.lt(99999999999999999999n))', async () => expect(await classes('g.inject(1e300d).is(P.lt(99999999999999999999n))')).toEqual([]));
});

describe("asNumber() is createNumber's class — Float, Double or BigDecimal — and a Date's epoch Long", () => {
  // `NumberUtils.createNumber`'s decimal ladder (commons-lang3 at `vendor/tinkerpop/pom.xml`'s pin): a Float
  // where it prints as the Double does, else a Double where the decimal IS the Double, else the BigDecimal.
  const answered: [string, string[]][] = [
    ["g.inject('1.5').asNumber()", ['1.5f']],
    ["g.inject('5.').asNumber()", ['5f']],
    ["g.inject('1.5e3').asNumber()", ['1500f']],
    ["g.inject('0.123456789').asNumber()", ['0.123456789d']],
    ["g.inject('12345678901234567890.5').asNumber()", ['123456789012345678905e-1M']],
    ["g.inject('9007199254740993.0').asNumber()", ['90071992547409930e-1M']],
    ["g.inject('9007199254740993.0').asNumber().is(9007199254740992L)", []],
    ["g.inject('9007199254740993.0').asNumber(GType.LONG)", ['9007199254740993L']],
    ["g.inject('9007199254740993.0').asNumber(GType.BIGDECIMAL)", ['90071992547409930e-1M']],
    ["g.V(1).property('s', '12345678901234567890.5') ;; g.V(1).values('s').asNumber()", ['123456789012345678905e-1M']],
    ["g.V(1).property('s', '1.5') ;; g.V(1).values('s').asNumber()", ['1.5f']],
    ["g.V(1).property('d', 1.0d) ;; g.V(1).values('d').asNumber()", ['1d']],
    // `AsNumberStep.java:62-65`: a Date is `getTime()`, its epoch-millis Long — at the root as at any depth.
    [`g.inject(${DATE}).asNumber()`, ['1577836800000L']],
    [`g.inject(${DATE}).asNumber().is(1577836800000L)`, ['1577836800000L']],
    [`g.V(1).property('d', ${DATE}) ;; g.V(1).values('d').asNumber()`, ['1577836800000L']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
  // A BigDecimal with no plain spelling (a negative scale) declines rather than frame an infinity.
  test("declines: g.inject('1e400').asNumber()", () => expect(classes("g.inject('1e400').asNumber()")).rejects.toThrow(UnsupportedTraversal));
});

describe('a min/max winner keeps its own class — no NumberHelper promotion', () => {
  const answered: [string, string[]][] = [
    ['g.inject(5, 2.0d).max()', ['5i']],
    ['g.inject(5, 2.0d).min()', ['2d']],
    ['g.inject(5L, 2).max()', ['5L']],
    ['g.inject(1.5d, 2).max()', ['2i']],
    ['g.inject(1b, 2s).max()', ['2s']],
    ['g.inject(5, 2.0d).fold().max(local)', ['5i']],
    ['g.inject(5L, 2).fold().min(local)', ['2i']],
    ['g.inject([1b, 2s]).max(local)', ['2s']],
    ["g.inject('a', 'b').max()", ['"b"']],
    ["g.V().values('age').max()", ['35i']],
    // `Max.feature` g_V_hasLabelXsoftwareX_group_byXnameX_byXbothE_weight_maxX: `d[1.0].d`.
    ['g.V().hasLabel("software").group().by("name").by(__.bothE().values("weight").max())', ['{"lop":0.4d,"ripple":1d}']],
    ['g.V(5).bothE().values("weight").max()', ['1d']],
    ['g.V().local(union(values("age"), outE().values("weight")).fold()).max(local)', ['29i', '27i', '32i', '35i']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('a sum and a list member keep their class', () => {
  const answered: [string, string[]][] = [
    ['g.inject(1, 2L, 3.5d).sum()', ['6.5d']],
    ['g.inject(2147483647, 1).sum()', ['2147483648L']],
    ['g.inject([1b, 2s]).sum(local)', ['3s']],
    ['g.inject([1b, 2s, 3L, 1.5f, 2])', ['[1b,2s,3L,1.5f,2i]']],
    ['g.inject(1.0d)', ['1d']],
    ['g.inject([1.0d, 2.5d])', ['[1d,2.5d]']],
    ['g.inject(1.0d, 2.5d).fold()', ['[1d,2.5d]']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
  test("constant(1L) keys stay Long: g.V().coalesce(values('age'), constant(1L)).groupCount()", async () =>
    expect(await classes("g.V().coalesce(values('age'), constant(1L)).groupCount()")).toEqual(['{27i:1L,29i:1L,32i:1L,35i:1L,1L:2L}']));
});

describe('a branch arm keeps its tag through every re-read', () => {
  // `coalesce`'s arm tag is a Gremlin type, framed per row exactly as `choose`'s is, so a Boolean or Date
  // arm read back out of a `project(…)` map is that Boolean or Date at every depth.
  const coalesced = "g.V().project('a').by(coalesce(values('age'), constant(true)))";
  const answered: [string, string[]][] = [
    [`${coalesced}.select('a').fold()`, ['[29i,27i,true,32i,true,35i]']],
    // Each row is one traverser in arrival order — no TraverserSet merge regroups the two `true`s.
    [`${coalesced}.select('a').asString()`, ['"29"', '"27"', '"true"', '"32"', '"true"', '"35"']],
    [`${coalesced}.select('a').groupCount()`, ['{true:2L,27i:1L,29i:1L,32i:1L,35i:1L}']],
    ["g.V().project('a','b').by(coalesce(values('age'), constant(true))).by('name').select('a').fold()", ['[29i,27i,true,32i,true,35i]']],
    [`g.V().project('a').by(coalesce(values('age'), constant(${DATE}))).select('a').fold()`, ['[29i,27i,Date(2020),32i,Date(2020),35i]']],
    ["g.V().project('a').by(coalesce(values('age'), constant(1L))).select('a').fold()", ['[29i,27i,1L,32i,1L,35i]']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('the sack carries its class', () => {
  // The fold's class is a simple meet (`meetClass`, src/compiler/rel/sack.ts): floating if either side is,
  // else Long if either side is or the value left 32 bits, else Integer — a Byte/Short fold is an Integer.
  const answered: [string, string[]][] = [
    ['g.withSack(1.0d).V().sack()', Array(6).fill('1d')],
    ['g.withSack(1.0d).V().sack(sum).by(constant(1)).sack()', Array(6).fill('2d')],
    ['g.withSack(127b).inject(1b).sack(sum).sack()', ['128i']],
    ['g.withSack(-128b).inject(1b).sack(minus).sack()', ['-129i']],
    ['g.withSack(-128b).inject(-1b).sack(div).sack()', ['128i']],
    ['g.withSack(32767s).inject(1s).sack(sum).sack()', ['32768i']],
    ['g.withSack(2147483647i).inject(1i).sack(sum).sack()', ['2147483648L']],
    ['g.withSack(127b).inject(0.5f).sack(div).sack()', ['254f']],
    ['g.withSack(2).V().sack(div).by(constant(4)).limit(1).sack()', ['0i']],
    ['g.withSack(2).V().sack(div).by(constant(4.0d)).limit(1).sack()', ['0.5d']],
    ['g.withSack(0L).V(1).sack(sum).by("age").sack()', ['29L']],
    ['g.withSack(0.0d).V(4).outE("created").sack(sum).by("weight").sack()', ['1d', '0.4d']],
    ["g.withSack('a').inject('b').sack(min).sack()", ['"a"']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
  for (const q of ["g.withSack('a').inject(1).sack(sum).sack()", 'g.withSack(1).inject(0).sack(div).sack()'])
    test(`defers: ${q}`, () => expect(classes(q)).rejects.toThrow(RaisedByQuery));
});

describe("asString() of a Double is SQLite's text of it — a whole value keeps its .0", () => {
  const answered: [string, string[]][] = [
    ["g.V(1).property('d', 1.0d) ;; g.V(1).values('d').asString()", ['"1.0"']],
    ['g.inject(1.0d).asString()', ['"1.0"']],
    ['g.withSack(1.0d).V(1).sack().asString()', ['"1.0"']],
    ["g.E().values('weight').order().asString()", ['"0.2"', '"0.4"', '"0.4"', '"0.5"', '"1.0"', '"1.0"']],
    ["g.E().values('weight').fold().asString(local)", ['["0.5","1.0","0.4","1.0","0.4","0.2"]']],
    ['g.inject([1.0d, 2.5d]).asString()', ['"[1.0, 2.5]"']],
    // A Float literal lands on its shortest float32 decimal (`floatCanonical`), so it prints `Float.toString`'s.
    ['g.inject(0.123456789f).asString()', ['"0.12345679"']],
    // A zero has no sign (a deliberate divergence): `-0.0` prints `0.0`, as SQLite's text does.
    ['g.inject(-0.0d).asString()', ['"0.0"']],
    // Not Java's `Double.toString` layout (`1.0E10`, 17 digits) — a deliberate divergence.
    ['g.inject(1.0e10d).asString()', ['"10000000000.0"']],
    ['g.inject(1.0e-5d).asString()', ['"1.0e-05"']],
    ["g.V().values('age').math('_/3').asString()", ['"9.66666666666667"', '"9.0"', '"10.6666666666667"', '"11.6666666666667"']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('a reducer states its class per row (`REDUCED_TYPE`), so it survives every child depth and re-read', () => {
  // At every depth a correlated `by()`/`local()` body states the class as the top-level reducer does, and a
  // projected member re-read through `select` keeps it. `Max.feature`'s `d[1.0].d`, read back at depth.
  const answered: [string, string[]][] = [
    ["g.V(1).project('m').by(union(constant(5),constant(2.0d)).max())", ['{"m":5i}']],
    ["g.V(1).project('m').by(union(constant(5),constant(2.0d)).min())", ['{"m":2d}']],
    ['g.V(1,2).local(union(constant(5),constant(2.0d)).max()).fold()', ['[5i,5i]']],
    ['g.V(1,2).map(union(constant(5),constant(2.0d)).max()).fold()', ['[5i,5i]']],
    ["g.V().project('m').by(outE().values('weight').max()).select('m').fold()", ['[1d,1d,0.2d]']],
    ["g.V().project('m').by(outE().values('weight').max()).select('m').asString()", ['"1.0"', '"1.0"', '"0.2"']],
    ["g.V().project('m').by(outE().values('weight').max()).select('m').groupCount()", ['{0.2d:1L,1d:2L}']],
    ["g.V().project('a').by(project('m').by(outE().values('weight').max())).select('a').select('m').fold()", ['[1d,1d,0.2d]']],
    ["g.V().local(outE().values('weight').max()).as('x').select('x').fold()", ['[1d,1d,0.2d]']],
    ["g.V().project('s').by(outE().values('weight').sum()).select('s').fold()", ['[1.9d,1.4d,0.2d]']],
    ["g.V().project('s').by(outE().values('weight').max()).select('s').is(1.0d).count()", ['2L']],
    // A census row: the folded weights' `sum(local)` re-read through `as()`/`select()` is the Double 1.0.
    ["g.V().as('v').map(bothE().values('weight').fold()).sum(local).as('s').select('s').fold()", ['[1.9d,0.5d,1d,2.4d,1d,0.2d]']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe("the sack's class rides to every consumer — a group key, a project member, a by() child", () => {
  // `SackStep.map` returns the held object as is: a Double sack is a Double key and a Double member.
  const answered: [string, string[]][] = [
    ['g.withSack(1.0d).V().sack().groupCount()', ['{1d:6L}']],
    ['g.withSack(1.0d).V().group().by(sack()).by(count())', ['{1d:6L}']],
    ['g.withSack(1.0d).V().sack(sum).by(constant(1)).sack().groupCount()', ['{2d:6L}']],
    ['g.withSack(1.0d).V().sack().map(identity()).groupCount()', ['{1d:6L}']],
    ['g.withSack(1L).V().sack().groupCount()', ['{1L:6L}']],
    ["g.withSack(1.0d).V(1).project('s').by(sack())", ['{"s":1d}']],
    ["g.withSack(1.0d).V(1,2).project('s').by(sack()).select('s').fold()", ['[1d,1d]']],
    ['g.withSack(1.0d).V(1,2).local(sack()).fold()', ['[1d,1d]']],
    ["g.withSack(1.0d).V(1,2).sack().as('x').select('x').fold()", ['[1d,1d]']],
    ['g.withSack(1.0d).V().group().by(label).by(sack().sum())', ['{"person":4d,"software":2d}']],
    ['g.withSack(1.0d).V(1).repeat(out()).times(1).sack().groupCount()', ['{1d:3L}']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('a Float rides as the Double of its literal, rounded to float32 only at the wire', () => {
  // A deliberate divergence (`docs/feature-support-matrix.md`): Java widens 0.1f to 0.10000000149011612
  // before a compare (`NumberHelper.java:252-277,670-681`); here 0.1f IS 0.1, so it equals 0.1d — the
  // answer a user means. The WIRE still frames class Float as float32, so the rendered value is the float.
  const answered: [string, string[]][] = [
    ["g.inject('0.1').asNumber()", ['0.10000000149011612f']],
    ["g.inject('0.1').asNumber().is(0.1d)", ['0.10000000149011612f']],
    ["g.inject('0.1').asNumber().where(is(0.1d))", ['0.10000000149011612f']],
    ["g.inject('0.1').asNumber().is(P.within(0.1d,5))", ['0.10000000149011612f']],
    ["g.inject('0.1').asNumber().choose(is(0.1d),constant('y'),constant('n'))", ['"y"']],
    ["g.inject('0.1').asNumber().is(P.gt(0.1d))", []],
    ["g.inject('0.1').asNumber().project('a').by(identity()).select('a').is(0.1d).count()", ['1L']],
    ["g.V(1).property('s','0.1') ;; g.V().values('s').asNumber().is(0.1d)", ['0.10000000149011612f']],
    ["g.V(1).property('s','0.1') ;; g.V().values('s').asNumber().is(P.gt(0.1d))", []],
    ["g.V(1).property('f',0.1f) ;; g.V().has('f', P.gt(0.1d)).values('name')", []],
    ["g.V(1).property('f',0.1f) ;; g.V().has('f', 0.1f).values('name')", ['"marko"']],
    ['g.inject(0.1f).is(0.1d)', ['0.10000000149011612f']],
    ['g.inject(0.1f).is(0.1f)', ['0.10000000149011612f']],
    ['g.inject(0.1d).is(0.1f)', ['0.1d']],
    ['g.inject(0.1d).is(P.lt(0.1f))', []],
    ['g.inject(0.1f).is(0.1m)', ['0.10000000149011612f']],
    ['g.inject(0.1m).is(0.1f)', ['1e-1M']],
    ['g.inject(0.1f).is(P.gt(0.1m))', []],
    ['g.inject(3.0f).is(3)', ['3f']],
    ["g.inject(0.1f).math('_ * 2')", ['0.2d']],
    ['g.inject(0.1f, 0.1d).max()', ['0.10000000149011612f']],
    ["g.inject('0.1').asNumber().asString()", ['"0.1"']],
    ["g.inject('0.1').asNumber().asNumber(GType.DOUBLE)", ['0.1d']],
    ["g.V(1).property('f',0.1f) ;; g.V().values('f').asNumber(GType.DOUBLE)", ['0.1d']],
    ["g.V(1).property('f',0.1f) ;; g.V().values('f').asNumber(GType.BIGDECIMAL)", ['1e-1M']],
    ['g.inject(0.1d).asNumber(GType.FLOAT).is(0.1f)', ['0.10000000149011612f']],
    ["g.inject('16777217.0').asNumber()", ['16777217d']],
    ["g.inject('16777217.000000001').asNumber()", ['16777217000000001e-9M']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('a Float is ONE value whichever carrier it came by — a literal, a typed wire parameter, asNumber(FLOAT)', () => {
  // A GLV sends a Float parameter as its float32 (0.10000000149011612); it lands on the same carrier the
  // literal `0.1f` does (`floatCanonical`), so has/dedup/group see one value, not two.
  const p = { p: Math.fround(0.1) };
  const t = { p: 'float' as const };
  const seeded = () => {
    const store = seededStore();
    executeFramed(store, "g.V(1).property('f',0.1f)");
    executeFramed(store, "g.V(2).property('f',p)", p, t);
    return store;
  };
  const answer = (store: ReturnType<typeof seededStore>, q: string, params = {}, types = {}) =>
    executeFramed(store, q, params, types).map((frame) => render(frame.buf, { i: 0 }));
  test("has('f',0.1f) finds both", () => expect(answer(seeded(), "g.V().has('f',0.1f).values('name')")).toEqual(['"marko"', '"vadas"']));
  test("has('f',p) finds both", () => expect(answer(seeded(), "g.V().has('f',p).values('name')", p, t)).toEqual(['"marko"', '"vadas"']));
  test("has('f',eq(p)) finds both", () => expect(answer(seeded(), "g.V().has('f',eq(p)).values('name')", p, t)).toEqual(['"marko"', '"vadas"']));
  test("has('f',within(p)) over a typed list parameter finds both", () => expect(answer(seeded(),
    "g.V().has('f',within(p)).values('name')", { p: [Math.fround(0.1)] }, { p: { t: 'list', items: ['float'] } })).toEqual(['"marko"', '"vadas"']));
  test('dedup sees one value', () => expect(answer(seeded(), "g.V().values('f').dedup().count()")).toEqual(['1L']));
  test('group sees one key', () => expect(answer(seeded(), "g.V().group().by(values('f')).by(count())")).toEqual(['{0.10000000149011612f:2L}']));
  // asNumber(GType.FLOAT) at compile time lands on the carrier too: 0.123456789d becomes the Float 0.12345679.
  test('asNumber(FLOAT) equals the literal of its framed value', () =>
    expect(answer(seededStore(), 'g.inject(0.123456789d).asNumber(GType.FLOAT).is(0.12345679f)')).toEqual(['0.12345679104328156f']));
});

describe('Float arithmetic is double arithmetic, framed in the Float class', () => {
  // A deliberate divergence: `FLOAT_NUMBER_HELPER` rounds to a float at every step (`NumberHelper.java:225-229`);
  // here a Float adds in double and the class stays Float, promoted to a Double past `Float.MAX_VALUE`.
  const ten = Array.from({ length: 10 }, () => "'0.1'").join(',');
  const answered: [string, string[]][] = [
    ['g.inject(1.0f,2.0f,3.0f).sum()', ['6f']],
    ['g.inject(1f,2f,3f).fold().sum(local)', ['6f']],
    ['g.inject(1.5f,2.5f,3.0f).sum()', ['7f']],
    ['g.inject(1.5f,2.5f,3.0f).mean()', ['2.3333333333333335d']],
    ['g.withSack(127b).inject(0.5f).sack(div).sack()', ['254f']],
    ['g.withSack(2147483647i).inject(0.5f).sack(div).sack()', ['4294967296f']],
    ['g.withSack(0.1f).inject(0.2f).sack(sum).sack()', ['0.30000001192092896f']],
    ['g.withSack(1.0f).inject(3.0f).sack(div).sack()', ['0.3333333432674408f']],
    ['g.withSack(1.0f).inject(3.0f).sack(div).sack().is(P.gt(0.3333333333333333d))', []],
    // Float sum/mean answer at any length — they declined before.
    [`g.inject(${ten}).asNumber().sum()`, ['1f']],
    [`g.inject(${ten}).asNumber().fold().sum(local)`, ['1f']],
    ["g.inject('3.4e38','3.4e38').asNumber().sum()", ['6.8e+38d']],
    ['g.inject(0.1f,0.2f).mean()', ['0.15000000000000002d']],
    ['g.inject(0.1f,0.2f).sum()', ['0.30000001192092896f']],
    ['g.inject(0.1f,0.1f,0.1f).sum()', ['0.30000001192092896f']],
    ['g.inject(0.1f,0.2d).sum()', ['0.30000000000000004d']],
    ['g.inject(3.0e38f,3.0e38f).sum()', ['6e+38d']],
    ['g.inject(0.1f,0.2f).union(identity(), identity()).sum()', ['0.6000000238418579f']],
    ['g.inject(0.1f,0.2f).fold().sum(local)', ['0.30000001192092896f']],
    ['g.inject(0.1f,0.1f).sum()', ['0.20000000298023224f']],
    ['g.inject(16777216f, 1.0f).sum()', ['16777216f']],
    ["g.V(1).property('f',0.1f) ;; g.V().values('f').sum()", ['0.10000000149011612f']],
    ["g.V(1).property('f',0.1f) ;; g.V(2).property('f',0.2f) ;; g.V().values('f').sum()", ['0.30000001192092896f']],
    ["g.V(1).property('f',0.1f) ;; g.V(2).property('f',0.2f) ;; g.V().values('f').mean()", ['0.15000000000000002d']],
    ['g.withSack(16777217).inject(1.5f).sack(max).sack()', ['16777216f']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe("a zero is one zero and a BigDecimal widening compares as NumberHelper's", () => {
  const answered: [string, string[]][] = [
    // No signed zero (a deliberate divergence): `-0.0` and `0.0` compare equal, as in SQLite.
    ['g.inject(0.0d).is(-0.0d)', ['0d']],
    ['g.inject(0).is(-0.0d)', ['0i']],
    ['g.inject(0.0d).is(P.gt(-0.0d))', []],
    ['g.inject(-0.0d).is(P.within(0.0d))', ['0d']],
    ["g.inject(0.0d).math('-_').asString()", ['"0.0"']],
    // A BigInteger against a Double widens to `BigDecimal.valueOf(d)`, the decimal of `Double.toString`.
    ['g.inject(99999999999999999999n).is(P.lt(1e30d))', ['99999999999999999999N']],
    ['g.inject(1e30d).is(P.gt(99999999999999999998n))', ['1e+30d']],
    ['g.inject(1000000000000000000000000000000n).is(1e30d)', ['1000000000000000000000000000000N']],
    ['g.inject(1e30d).is(1000000000000000000000000000000n)', ['1e+30d']],
    ['g.inject(4611686018427387903n).is(P.gt(4.611686018427388E18d))', []],
    ['g.inject(4.611686018427388E18d).is(4611686018427388000n)', ['4611686018427388000d']],
    ['g.inject(0.1d).is(0.1m)', ['0.1d']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});


describe('a Float PRINTS as the Double it rides as wherever it is printed — a folded list, a label re-read, a subnormal', () => {
  // ONE printing rule (`asStringOf`, `receiver.ts`, mirrored by `gremlin-string.ts`): a Float rides as the
  // Double of its literal, so it prints that Double as SQLite spells a REAL (15 significant digits — a
  // computed Float is `9.66666666666667`, not Java's `9.666667`). A Float that crosses a JSON entry (a fold
  // member, an `as()` history) keeps its 17 digits, so its re-read compares and prints as it was.
  const answered: [string, string[]][] = [
    ['g.inject(0.1f).fold().asString()', ['"[0.1]"']],
    ['g.inject(0.1f,0.2f).fold().asString()', ['"[0.1, 0.2]"']],
    ["g.inject('0.1').asNumber().fold().asString()", ['"[0.1]"']],
    ['g.V(1).local(constant(0.1f).fold()).asString()', ['"[0.1]"']],
    ["g.inject(0.1f).aggregate('x').cap('x').asString()", ['"[0.1]"']],
    ["g.V().values('age').is(29).math('_/3').asNumber(GType.FLOAT).fold().asString()", ['"[9.66666666666667]"']],
    ['g.inject(1.4e-45f).fold().asString()', ['"[1.4e-45]"']],
    ['g.inject(1.0e10f).fold().asString()', ['"[10000000000.0]"']],
    ['g.inject(1.0d).fold().asString()', ['"[1.0]"']],
    ['g.inject(true).fold().asString()', ['"[true]"']],
    // An `as()` label's history is JSON: the Float rides its exact 17 digits, not SQLite's 15.
    ["g.inject(0.1f).as('a').select('a').is(0.1f)", ['0.10000000149011612f']],
    ["g.inject(0.1f).as('a').select('a').where(is(eq(0.1f)))", ['0.10000000149011612f']],
    ["g.inject(0.1f).as('a').select('a').asNumber(GType.DOUBLE)", ['0.1d']],
    ["g.inject(0.1f).as('a').select('a').math('_*1')", ['0.1d']],
    ["g.V(1).property('f',0.1f) ;; g.V(1).values('f').as('a').select('a').asString()", ['"0.1"']],
    // A SUBNORMAL Float rides as the Double of its literal, so it widens as that Double does.
    ['g.inject(1.4e-45f).asNumber(GType.DOUBLE)', ['1.4e-45d']],
    ['g.inject(2.8e-45f).asNumber(GType.DOUBLE)', ['2.8e-45d']],
    ['g.inject(1.4e-45f).asNumber(GType.BIGDECIMAL)', ['14e-46M']],
    ["g.V(1).property('f',1.4e-45f) ;; g.V(1).values('f').asNumber(GType.DOUBLE)", ['1.4e-45d']],
    ["g.V(1).property('f',1.4e-45f) ;; g.V(1).values('f').asNumber(GType.BIGDECIMAL)", ['14e-46M']],
    ["g.V().values('age').is(29).math('_*1e-46').asNumber(GType.FLOAT)", ['2.802596928649634e-45f']],
    ["g.V().values('age').is(29).math('_*1e-46').asNumber(GType.FLOAT).asNumber(GType.DOUBLE)", ['2.9e-45d']],
    // createNumber's Float rung: a decimal is a Float only in float's NORMAL range, with digits that survive
    // float32 — so a subnormal spelling is a Double, and `Float.MIN_NORMAL`'s Double spelling
    // `1.17549435E-38` (below the float it rounds to) is a Double too, as on the JDK 19+ reference.
    ["g.inject('1e-45').asNumber()", ['1e-45d']],
    ["g.inject('1e-45').asNumber().is(1.0e-45d)", ['1e-45d']],
    ["g.inject('1.4e-45').asNumber()", ['1.4e-45d']],
    ["g.inject('1.17549435E-38').asNumber()", ['1.17549435e-38d']],
    // A Double's BigDecimal is `BigDecimal.valueOf(d)`, of its `Double.toString` — never an exponent
    // spelling the BigDecimal framer cannot parse.
    ['g.inject(1.0e-7d).asNumber(GType.BIGDECIMAL)', ['10e-8M']],
    ['g.inject(1.0d).asNumber(GType.BIGDECIMAL)', ['10e-1M']],
    ["g.V().values('age').is(29).math('_*1e21').asNumber(GType.BIGDECIMAL)", ['29e--21M']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('a BigDecimal is EQUAL by value — compareTo across every class, any scale, at every depth', () => {
  // `NumberHelper.compare` widens a pair to BigDecimal whenever either side is one and compares by
  // `compareTo`, which ignores scale (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:362-398,670-681`);
  // a bound widens through `bigDecimalValue` (`:850-859`) — a Double through `BigDecimal.valueOf`, a Float
  // through `Float.toString`. A BigDecimal rides as decimal TEXT, so raw SQLite `=` matched none of these.
  const answered: [string, string[]][] = [
    // `asNumber(BIGDECIMAL)` of a Double literal (`BigDecimal.valueOf(d)`, its scale kept).
    ['g.inject(0.5d).asNumber(GType.BIGDECIMAL).is(0.5d)', ['5e-1M']],
    ['g.inject(1.0d).asNumber(GType.BIGDECIMAL).is(1)', ['10e-1M']],
    ['g.inject(100.0d).asNumber(GType.BIGDECIMAL).is(100)', ['1000e-1M']],
    ['g.inject(12345678.0d).asNumber(GType.BIGDECIMAL).is(12345678)', ['12345678e-0M']],
    ['g.inject(12345678.0d).asNumber(GType.BIGDECIMAL).is(P.neq(12345678))', []],
    ['g.inject(1.0e21d).asNumber(GType.BIGDECIMAL).is(1.0e21d)', ['10e--20M']],
    // A widening of scale ≤ 0 rides as the number at compile time as at run time, so both frame `BigDecimal.valueOf`'s
    // scale (Java's `1.0E+21` is (10, −20), `1.2345678E7` is (12345678, 0)); a NEGATIVE scale below 10^21
    // (`1.0E7`, (10, −6)) declines — see the run-time widening block.
    ['g.V(1).property("d", 1.0e21d) ;; g.V(1).values("d").asNumber(GType.BIGDECIMAL)', ['10e--20M']],
    ['g.inject(1.0e-7d).asNumber(GType.BIGDECIMAL).is(1.0e-7d)', ['10e-8M']],
    ['g.inject(0.5d).asNumber(GType.BIGDECIMAL).is(P.within(0.5d))', ['5e-1M']],
    // A BigDecimal literal against every class, either side.
    ['g.inject(1).is(1.0m)', ['1i']],
    ['g.inject(1L).is(1.0m)', ['1L']],
    ['g.inject(1.0m).is(1m)', ['10e-1M']],
    ['g.inject(1.0m).is(1)', ['10e-1M']],
    ['g.inject(1.0m).is(P.neq(1))', []],
    ['g.inject(1.5m).is(1)', []],
    ['g.inject(0.5m).is(0.5d)', ['5e-1M']],
    ['g.inject(0.1m).is(0.1f)', ['1e-1M']],
    ['g.inject(0m).is(-0.0d)', ['0e-0M']],
    ['g.inject(0.000m).is(0)', ['0e-3M']],
    ['g.inject(1.0m).is(P.within(1, 2))', ['10e-1M']],
    ['g.inject(1.0m).is(P.without(1, 2))', []],
    ['g.inject(0.5m, 1m, 2.50m).is(P.within(0.5d, 2.5d))', ['5e-1M', '250e-2M']],
    ['g.inject(9007199254740993L).is(9007199254740993.0m)', ['9007199254740993L']],
    ['g.inject(9007199254740993L).is(9007199254740992.0m)', []],
    ['g.inject(12345678901234567890n).is(12345678901234567890.0m)', ['12345678901234567890N']],
    ['g.inject(0.5m).is(NaN)', []],
    // At depth: a child filter, a branch, a label re-read, an unfolded member, a stored property.
    ['g.inject(0.5m).where(is(0.5d))', ['5e-1M']],
    ["g.inject(0.5m).choose(is(0.5d), constant('y'), constant('n'))", ['"y"']],
    ["g.inject(0.5m).as('a').select('a').is(0.5d)", ['5e-1M']],
    ['g.inject(0.5m).fold().unfold().is(0.5d)', ['5e-1M']],
    ["g.addV().property('e', 1.0m) ;; g.V().values('e').is(1)", ['10e-1M']],
    ["g.addV().property('e', 1.0m) ;; g.V().values('e').is(P.within(1, 3))", ['10e-1M']],
    ["g.V().has('age', P.within(29.0m, 27m)).values('name')", ['"marko"', '"vadas"']],
    ["g.V().values('age').asNumber(GType.BIGDECIMAL).is(29.0m)", ['29e-0M']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
  // `BigDecimal.valueOf(Infinity)` throws: deferred, never an answer.
  test('defers: g.inject(0.5m).is(Infinity)', () => expect(classes('g.inject(0.5m).is(Infinity)')).rejects.toThrow(RaisedByQuery));
});

describe('a list member PRINTS by its class at every depth — one recursive authority', () => {
  // `memberNode` (`src/compiler/rel/asstring-barrier.ts`) re-attaches each member's class down the list
  // shape, so a nested whole Double is `1.0` and a nested Boolean `true`.
  const answered: [string, string[]][] = [
    ['g.inject(1.5d).fold().fold().fold().asString()', ['"[[[1.5]]]"']],
    ["g.inject(1.0d).fold().as('x').select('x').fold().asString()", ['"[[1.0]]"']],
    ['g.inject(1.0d, 2.5d).fold().fold().asString()', ['"[[1.0, 2.5]]"']],
    ['g.inject(1.0d).fold().fold().asString(Scope.local)', ['["[1.0]"]']],
    ['g.inject(true).fold().fold().asString()', ['"[[true]]"']],
    ['g.inject(1.0d).fold().fold().asString()', ['"[[1.0]]"']],
    ["g.V().values('age').math('_/3').fold().fold().asString()", ['"[[9.66666666666667, 9.0, 10.6666666666667, 11.6666666666667]]"']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('a zero has no sign at any depth — a list member, a map value, a slice, a stored property', () => {
  // A deliberate divergence (`docs/feature-support-matrix.md`): `-0.0` is `0.0`, as SQLite's JSON writer,
  // `printf` and `CAST AS TEXT` print it. Its CLASS is kept: it is still a Double (a Float), never an Int.
  const answered: [string, string[]][] = [
    ['g.inject(-0.0d).fold()', ['[0d]']],
    ['g.inject(-0.0f).fold()', ['[0f]']],
    ['g.inject([a:-0.0d])', ['{"a":0d}']],
    ['g.inject(-0.0d).fold().unfold()', ['0d']],
    ["g.V(1).property('z', -0.0d) ;; g.V(1).values('z')", ['0d']],
    // A 17-digit Double re-collected from a list keeps its digits.
    ["g.inject(1).math('1/3').fold().tail(Scope.local)", ['[0.3333333333333333d]']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('conjoin() prints each member as asString() does, keyed by the member class', () => {
  const answered: [string, string[]][] = [
    ["g.inject(1.0d).fold().conjoin('-')", ['"1.0"']],
    ["g.inject(-0.0d).fold().conjoin('-')", ['"0.0"']],
    ["g.inject(true).fold().conjoin('-')", ['"true"']],
    ["g.inject(1, 2.5d).fold().conjoin('-')", ['"1-2.5"']],
    ["g.V().values('name').fold().conjoin(',')", ['"marko,vadas,lop,josh,ripple,peter"']],
    ["g.inject(1).math('1/3').fold().conjoin('-')", ['"0.333333333333333"']],
    ["g.inject(1.0e10d).fold().conjoin('-')", ['"10000000000.0"']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('a run-time BigDecimal widening of a Double is its shortest digits — a whole Double at scale 0', () => {
  // The widening is the JS framer's (`bigDecimalOfCarrier`): a fractional Double is `BigDecimal.valueOf(d)`'s
  // digits and scale; a WHOLE Double below 10^21 that reaches a scalar frame is scale 0 (`100.0` is `100`,
  // `1.0E7` is `10000000`) where the reference keeps `Double.toString`'s scale — a deliberate divergence.
  const answered: [string, string[]][] = [
    ['g.inject(12345678.0d).asNumber(GType.BIGDECIMAL)', ['12345678e-0M']],
    ['g.inject(12345678.0d).asNumber(GType.BIGDECIMAL).fold()', ['[12345678e-0M]']],
    ["g.V(1).values('age').math('_*0+12345678').asNumber(GType.BIGDECIMAL)", ['12345678e-0M']],
    ["g.V(1).values('age').math('_*0+12345678').asNumber(GType.BIGDECIMAL).fold()", ['[12345678e-0M]']],
    ["g.V(1).values('age').math('_*1e21').asNumber(GType.BIGDECIMAL)", ['29e--21M']],
    ["g.V(1).values('age').math('_*1e21').asNumber(GType.BIGDECIMAL).fold()", ['[29e--21M]']],
    ["g.V(1).values('age').math('_*1e21').asNumber(GType.BIGDECIMAL).fold().asString()", ['"[29000000000000000000000]"']],
    // An unread value raises nothing: `count()` never evaluates the widening (the fence's own rule).
    ["g.V(1).values('age').math('_*0+1e7').asNumber(GType.BIGDECIMAL).count()", ['1L']],
    ['g.inject(100d).asNumber(GType.BIGDECIMAL)', ['1000e-1M']],
    ["g.V(1).values('age').math('_*0+100').asNumber(GType.BIGDECIMAL)", ['100e-0M']],
    ["g.V(1).values('age').asNumber(GType.DOUBLE).asNumber(GType.BIGDECIMAL)", ['29e-0M']],
    ["g.V(1).values('age').asNumber(GType.BIGDECIMAL)", ['29e-0M']],
    ['g.inject(1.234e-5d).asNumber(GType.BIGDECIMAL)', ['1234e-8M']],
    ["g.V(1).values('age').math('_*0-0.000012345').asNumber(GType.BIGDECIMAL)", ['-12345e-9M']],
    ["g.V(1).values('age').math('_*0+1e-4').asNumber(GType.BIGDECIMAL)", ['10e-5M']],
    ["g.V(1).values('age').math('_*0+0.1+0.2').asNumber(GType.BIGDECIMAL)", ['30000000000000004e-17M']],
    ["g.V(1).values('age').math('_/3').asNumber(GType.BIGDECIMAL)", ['9666666666666666e-15M']],
    ["g.V(1).values('age').math('_*0').asNumber(GType.BIGDECIMAL)", ['0e-0M']],
    ['g.inject(0.1f).asNumber(GType.BIGDECIMAL)', ['1e-1M']],
    // Equality is `compareTo`, blind to scale.
    ['g.inject(0.5d).asNumber(GType.BIGDECIMAL).is(0.5d)', ['5e-1M']],
    ["g.V().values('age').math('_*1.0').asNumber(GType.BIGDECIMAL).is(29)", ['29e-0M']],
    ["g.V().values('age').math('_*1.0').asNumber(GType.BIGDECIMAL).order()", ['27e-0M', '29e-0M', '32e-0M', '35e-0M']],
    // A NEGATIVE scale at run time, at every depth it is framed …
    ["g.V(1).values('age').math('_*0+1e7').asNumber(GType.BIGDECIMAL)", ['10000000e-0M']],
    ["g.V(1).values('age').math('_*0-2.5e8').asNumber(GType.BIGDECIMAL)", ['-250000000e-0M']],
    ["g.V(1).values('age').math('_*1e6').asNumber(GType.BIGDECIMAL).fold()", ['[29e--6M]']],
    ["g.V(1).values('age').math('_*0+1e7').asNumber(GType.BIGDECIMAL).fold().asString()", ['"[10000000]"']],
    ["g.V(1).values('age').math('_*0+1e7').asNumber(GType.BIGDECIMAL).fold().unfold()", ['10000000e-0M']],
    ["g.V(1).values('age').math('_*0+1e7').asNumber(GType.BIGDECIMAL).project('a').by(identity())", ['{"a":10e--6M}']],
    ["g.V(1).values('age').math('_*0+1e7').asNumber(GType.BIGDECIMAL).groupCount()", ['{10e--6M:1L}']],
    ["g.V(1).project('a').by(values('age').math('_*0+1e7').asNumber(GType.BIGDECIMAL))", ['{"a":10e--6M}']],
    ["g.V(1).values('age').math('_*0+1e7').asNumber(GType.BIGDECIMAL).max()", ['10000000e-0M']],
    // … and where it is never observed, answering as trunk did.
    ["g.V(1).values('age').math('_*0+1e7').asNumber(GType.BIGDECIMAL).is(P.neq(10000000))", []],
    ["g.V(1).property('d',1.0e7d) ;; g.V(1).values('d').asNumber(GType.BIGDECIMAL).asNumber(GType.INT)", ['10000000i']],
    ["g.V(1).property('d',1.0e7d) ;; g.V(1).values('d').asNumber(GType.BIGDECIMAL).math('_+1')", ['10000001d']],
    ["g.V(1).property('d',1.0e7d) ;; g.V(1).values('d').asNumber(GType.BIGDECIMAL).is(P.lt(0))", []],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
  test("g.V(1).values('age').math('_*0+1e-310').asNumber(GType.BIGDECIMAL)", async () =>
    expect(await classes("g.V(1).values('age').math('_*0+1e-310').asNumber(GType.BIGDECIMAL)")).toEqual(['10e-311M']));
  // A BigDecimal SUM is exact BigDecimal arithmetic, not SQL's.
  for (const q of ["g.V().values('age').math('_*1.0').asNumber(GType.BIGDECIMAL).sum()",
    "g.V(1).values('age').math('_*0+1e7').asNumber(GType.BIGDECIMAL).sum()"])
    test(`defers: ${q}`, () => expect(classes(q)).rejects.toThrow(RaisedByQuery));
  const literal: [string, string[]][] = [
    ['g.inject(1.0e7d).asNumber(GType.BIGDECIMAL)', ['10000000e-0M']],
    ['g.inject(1.0e7d).asNumber(GType.BIGDECIMAL).fold()', ['[10000000e-0M]']],
    ['g.inject(1.0e7d).asNumber(GType.BIGDECIMAL).is(P.neq(10000000))', []],
    ['g.inject(-2.5e10d).asNumber(GType.BIGDECIMAL)', ['-25000000000e-0M']],
  ];
  for (const [q, expected] of literal) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('the set-op family keeps every member class — combine/product/merge/intersect/difference/disjunct', () => {
  // A set op's members re-enter a list under the fold's runtime rule (`withLossyFlag`), each with its own
  // class, and compare by value plus family — `1` and `1L` are one member (a deliberate divergence from
  // `IntersectStep.java:68-80`'s class-typed `equals`). A zero has no sign.
  const answered: [string, string[]][] = [
    ['g.inject(1.5f).fold().combine([1]).asString()', ['"[1.5, 1]"']],
    ['g.inject([1.5f]).combine([4L]).asString()', ['"[1.5, 4]"']],
    ['g.inject([1.5f]).product([1]).asString()', ['"[[1.5, 1]]"']],
    ['g.inject([1.5f]).combine([1]).range(local,0,1).asString()', ['"[1.5]"']],
    ["g.V(1).property('f', 1.5f) ;; g.V(1).values('f').fold().combine([1]).asString()", ['"[1.5, 1]"']],
    ["g.inject([1.5f]).combine([4L]).conjoin(',')", ['"1.5,4"']],
    ['g.inject([1.5f,1]).merge([2]).unfold().asString()', ['"1"', '"1.5"', '"2"']],
    ['g.inject([1.5f]).combine([4L]).unfold().asString()', ['"1.5"', '"4"']],
    ['g.inject([0.1f]).combine([4L])', ['[0.10000000149011612f,4L]']],
    ["g.E().values('weight').fold().combine([7L])", ['[0.5d,1d,0.4d,1d,0.4d,0.2d,7L]']],
    ["g.E().values('weight').fold().merge([7L])", ['set[0.2d,0.4d,0.5d,1d,7L]']],
    ['g.inject([0.1f,2.0d]).intersect([0.1f]).unfold()', ['0.10000000149011612f']],
    ['g.inject([1,2]).intersect([1L,2])', ['set[1i,2i]']],
    ['g.inject([1,2,1L]).merge([1])', ['set[1i,2i]']],
    ["g.inject([1,'a']).disjunct([1L,'a'])", ['set[]']],
    ['g.inject([-0.0d, 0.0d]).merge([0.0d])', ['set[0d]']],
    ['g.inject([1,2]).product([1L])', ['[[1i,1L],[2i,1L]]']],
    ['g.inject([1,2]).combine([3])', ['[1i,2i,3i]']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('a zero is one zero at every reduction and every dedup', () => {
  // A zero has no sign (a deliberate divergence): a sum of `-0.0`s is `0.0` and `-0.0`/`0.0` dedup to one.
  // Equal numbers of any class are one value too: `1` and `1.0` dedup to one.
  const answered: [string, string[]][] = [
    ['g.inject(-0.0d,-0.0d).sum()', ['0d']],
    ['g.inject(-0.0f).sum()', ['0f']],
    ['g.inject(-0.0d).mean()', ['0d']],
    ['g.inject(-0.0d,0.0d).dedup().count()', ['1L']],
    ['g.inject(1, 1.0).dedup().count()', ['1L']],
    ['g.inject([1, 1L, 1]).dedup(local)', ['set[1i]']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('a BigDecimal member keeps its SCALE at every depth — one carrier authority', () => {
  // `NumberHelper.castTo` widens an integral source through `BigDecimal.valueOf(long)` (scale 0) and a Double
  // through `BigDecimal.valueOf(double)` (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:850-859`);
  // `asString()` prints it with `BigDecimal.toString` (scientific past an adjusted exponent of −6 or for a
  // negative scale). `bigDecimalOfCarrier` (`src/gremlin/float.ts`) reads every carrier the one way — the
  // wire framer and the printer both — so a member inside a list, a map value, a projected record or a
  // group's fold frames and prints the scale the scalar does.
  const answered: [string, string[]][] = [
    ['g.inject(1000).asNumber(GType.BIGDECIMAL).fold().asString()', ['"[1000]"']],
    ['g.inject(1234567).asNumber(GType.BIGDECIMAL).fold().asString()', ['"[1234567]"']],
    ['g.inject(10000000).asNumber(GType.BIGDECIMAL).fold().asString()', ['"[10000000]"']],
    ['g.inject(10000000L).asNumber(GType.BIGDECIMAL).fold().asString()', ['"[10000000]"']],
    ["g.inject('10000000').asNumber(GType.BIGDECIMAL).fold().asString()", ['"[10000000]"']],
    ["g.inject(10000000).asNumber(GType.BIGDECIMAL).project('a').by(identity()).asString()", ['"{a=10000000}"']],
    ["g.inject(10000000).asNumber(GType.BIGDECIMAL).group().by(constant('k')).by(fold()).asString()", ['"{k=[10000000]}"']],
    ['g.inject(1000).asNumber(GType.BIGDECIMAL).fold()', ['[1000e-0M]']],
    ["g.inject(1000).asNumber(GType.BIGDECIMAL).aggregate('x').cap('x')", ['[1000e-0M]']],
    ["g.inject(1000).asNumber(GType.BIGDECIMAL).group().by(constant('k')).by(fold())", ['{"k":[1000e-0M]}']],
    ['g.inject(1000).asNumber(GType.BIGDECIMAL).fold().fold().asString()', ['"[[1000]]"']],
    ["g.V().values('age').asNumber(GType.BIGDECIMAL).fold().asString()", ['"[29, 27, 32, 35]"']],
    // A Double source keeps `Double.toString`'s scale, and prints in `BigDecimal.toString`'s layout.
    ['g.inject(100.0d).asNumber(GType.BIGDECIMAL).fold()', ['[1000e-1M]']],
    ['g.inject(100.0d).asNumber(GType.BIGDECIMAL).fold().asString()', ['"[100.0]"']],
    ['g.inject(1.0e-7d).asNumber(GType.BIGDECIMAL).fold().asString()', ['"[0.00000010]"']],
    ['g.inject(1.0e21d).asNumber(GType.BIGDECIMAL).fold().asString()', ['"[1000000000000000000000]"']],
    ['g.inject(-12345678.0d).asNumber(GType.BIGDECIMAL).fold().asString()', ['"[-12345678]"']],
    ['g.inject(1.5m).fold().asString()', ['"[1.5]"']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('the substrate-A audit forms keep their class — a by() fold, a map key, a stored -0.0d, dedup', () => {
  // A member keeps its class (1.0 stays a Double); a group KEY merges equal numbers by value plus family,
  // framed as one of the merged arrivals (a zero has no sign: `-0.0` is `0.0`).
  const answered: [string, string[]][] = [
    ["g.V(1).project('a').by(constant([1,2,1.0]).unfold().barrier().fold())", ['{"a":[1i,2i,1d]}']],
    ["g.V(1).project('a').by(constant([1.0]).unfold().fold())", ['{"a":[1d]}']],
    ['g.V(1).group().by(label).by(constant([1.0]).unfold().fold())', ['{"person":[1d]}']],
    ['g.inject(1,2,1.0).groupCount()', ['{1d:2L,2i:1L}']],
    ['g.inject(1,2,1.0).group().by().by(count())', ['{1d:2L,2i:1L}']],
    ["g.inject(1,2,1.0).groupCount('g').cap('g')", ['{1d:2L,2i:1L}']],
    ["g.addV('n').property('x',-0.0d).values('x')", ['0d']],
    ["g.addV('n').property('x',-0.0d) ;; g.addV('n').property('x',0.0d) ;; g.V().values('x').barrier().fold()", ['[0d,0d]']],
    ['g.inject(-0.0, 0.0).dedup().fold()', ['[0d]']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('a NaN literal VALUE declines; a negative-scale BigDecimal literal answers at scale 0', () => {
  // SQLite stores a NaN as NULL, so a NaN traverser would frame, sum and compare as a null. `uncarriedLiteral`
  // declines it in a VALUE position at every depth; a predicate OPERAND, and a NaN the next step drops as it
  // drops a null, answer. A negative-scale BigDecimal (`1e7m` is (1, −7)) rides as its plain decimal text, the
  // same value at scale 0 — a deliberate divergence.
  const declined = [
    'g.inject(NaN)', 'g.inject(NaN, 1, NaN).fold()', 'g.inject(NaN, 1).sum()', 'g.inject(1).constant(NaN)',
    'g.inject([NaN])', "g.inject(1).project('a').by(constant(NaN))", 'g.inject(1).local(constant(NaN).fold())',
    "g.addV('n').property('x', NaN)", 'g.inject(NaN).is(P.eq(null))', 'g.inject(NaN).is(P.neq(1.0d))',
    'g.inject(NaN).is(P.lte(null))',
  ];
  for (const q of declined) test(`declines: ${q}`, () => expect(classes(q)).rejects.toThrow(UnsupportedTraversal));
  const answered: [string, string[]][] = [
    ['g.inject(NaN).is(P.eq(1.0d))', []],
    ['g.inject(NaN).is(P.lt(NaN))', []],
    ['g.inject(NaN, 2).is(P.gte(1))', ['2i']],
    ['g.inject(NaN).asBool()', ['false']],
    ['g.inject(1.0d).is(P.neq(NaN))', ['1d']],
    ['g.inject(10000000m).is(1e7m)', ['10000000e-0M']],
    ['g.inject(1e7m)', ['10000000e-0M']],
    ['g.inject(1e7m).fold()', ['[10000000e-0M]']],
    // A filter FALSE for a NaN and for a null alike, however composed, or a `where`/`filter` of one.
    ['g.inject(NaN).is(P.eq(NaN).or(P.eq(1)))', []],
    ['g.inject(NaN).is(P.eq(1).and(P.lt(3)))', []],
    ['g.inject(NaN).is(P.within(1,2))', []],
    ['g.inject(NaN).is(P.within([1,2]))', []],
    ['g.inject(NaN).where(is(P.eq(NaN)))', []],
    ['g.inject(NaN).filter(is(P.lt(1)))', []],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
  // A filter that KEEPS a null or a NaN would observe the NaN as a null.
  for (const q of ['g.inject(NaN).is(P.within(1,null))', 'g.inject(NaN).is(P.not(P.eq(1)))'])
    test(`declines: ${q}`, () => expect(classes(q)).rejects.toThrow(UnsupportedTraversal));
});

describe('a min/max TIE is answered, never deferred', () => {
  // NumberHelper's `max` is `x >= y ? x : y` and `min` `x <= y ? x : y` (`NumberHelper.java:252-310`): the
  // FIRST argument keeps a tie. `MaxLocalStep`/`MinLocalStep` fold `max(next, result)` (`MaxLocalStep.java:52`),
  // so a LOCAL reducer's later member wins; a sack/fold applies `(accumulator, value)`, so the accumulator
  // wins; a GLOBAL reducer's first traverser wins (`ReducingBarrierStep.java:110`) — an arrival order the
  // stream does not carry, so it takes whichever the order puts first (a deliberate divergence). A zero has no
  // sign (a deliberate divergence), so `-0.0` beside `0.0` is no observable tie and answers `0.0`.
  const answered: [string, string[]][] = [
    ['g.inject(1.0m,1.00m).fold().max(local)', ['100e-2M']],
    ['g.inject(1.0m,1.00m).fold().min(local)', ['100e-2M']],
    ['g.inject(1.00m,1.0m).fold().max(local)', ['10e-1M']],
    ['g.inject(-0.0d,0.0d).max()', ['0d']],
    ['g.inject(0, -0.0d).max()', ['0i']],
    ['g.inject([0.0d,-0.0d]).min(local)', ['0d']],
    ['g.withSack(-0.0d).inject(1).sack(max).by(constant(0.0d)).sack()', ['0d']],
    // A tie only in a LOSING group is no tie of the winner's, at every depth.
    ['g.inject(1.0m,1.00m,0.5m).min()', ['5e-1M']],
    ["g.E(7).property('weight',-0.0d) ;; g.E(8).property('weight',0.0d) ;; g.E(9).property('weight',-1.0d) ;; g.V(1).project('m').by(outE().values('weight').max())", ['{"m":0d}']],
    ['g.inject(1, 1.0d).max()', ['1i']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
  // A global tie of two representations answers ONE of them — the value is the same either way.
  for (const q of ['g.inject(1.0m, 1.00m).max()', 'g.inject(1.00m, 1.0m).min()'])
    test(q, async () => expect(['10e-1M', '100e-2M']).toContain((await classes(q))[0]!));
  // A BigDecimal SUM/MEAN is BigDecimal scale arithmetic — named as such, not as a 2^53 tail.
  for (const q of ['g.inject(1.5m,1.5m).sum()', "g.V().values('age').asNumber(GType.DOUBLE).asNumber(GType.BIGDECIMAL).sum()",
    "g.V().values('age').asNumber(GType.BIGDECIMAL).mean()", 'g.inject(1.5m,2.5m).fold().sum(local)'])
    test(`defers: ${q}`, () => expect(classes(q)).rejects.toThrow('BigDecimal scale arithmetic'));
  test("g.V().values('age').asNumber(GType.BIGDECIMAL).sum()", async () =>
    expect(await classes("g.V().values('age').asNumber(GType.BIGDECIMAL).sum()")).toEqual(['123e-0M']));
});

describe('a REAL-carried BigDecimal keeps all 17 digits inside a container — the JSON entry is exact for its tag', () => {
  // A Double widened by `asNumber(GType.BIGDECIMAL)` rides as the REAL. SQLite's JSON writer spells a REAL to 15
  // significant digits (`json_array(1.0000000000000002E20)` is `[1.0e+20]`), so a 16/17-digit widening came back
  // ANOTHER BigDecimal under fold/project/select/groupCount, while the top level was exact. The `bigdecimal` tag
  // now takes the same exact entry a Double does (`jsonMember` → `asExactReal`, gated on the REAL storage class
  // so decimal TEXT keeps its scale), and the scalar framer spells through that same entry.
  const D17 = "g.V(1).values('age').math('_*0+1.0000000000000002E20')"; // (10000000000000002, −4)
  const D16 = "g.V(1).values('age').math('_*0+1.234567890123456E20')"; // (1234567890123456, −5)
  const W17 = `${D17}.asNumber(GType.BIGDECIMAL)`;
  const W16 = `${D16}.asNumber(GType.BIGDECIMAL)`;
  const answered: [string, string[]][] = [
    [W17, ['10000000000000002e--4M']],
    [`${W17}.fold()`, ['[10000000000000002e--4M]']],
    [`${W17}.fold().asString()`, ['"[100000000000000020000]"']],
    [`${W17}.fold().unfold()`, ['10000000000000002e--4M']],
    [`${W17}.project('a').by(identity())`, ['{"a":10000000000000002e--4M}']],
    [`${W17}.as('a').select('a')`, ['10000000000000002e--4M']],
    [`${W17}.groupCount()`, ['{10000000000000002e--4M:1L}']],
    [`${W17}.aggregate('x').cap('x')`, ['[10000000000000002e--4M]']],
    [W16, ['1234567890123456e--5M']],
    [`${W16}.fold()`, ['[1234567890123456e--5M]']],
    [`${W16}.project('a').by(identity())`, ['{"a":1234567890123456e--5M}']],
    [`${W16}.as('a').select('a')`, ['1234567890123456e--5M']],
    [`${W16}.groupCount()`, ['{1234567890123456e--5M:1L}']],
    // Scale 0: `1.234567890123456E15` is `new BigDecimal("1.234567890123456E15")`, i.e. 1234567890123456.
    ["g.V(1).values('age').math('_*0+1234567890123456').asNumber(GType.BIGDECIMAL).fold().asString()", ['"[1234567890123456]"']],
    // 17 digits from arithmetic — `27 × 1.1E110` is 2.9699999999999997E111 (inside the range SQLite's decimal text is exact in).
    ["g.V().values('age').is(27).math('_*1.1e110').asNumber(GType.BIGDECIMAL).fold()", ['[29699999999999997e--95M]']],
    ["g.V().values('age').is(27).math('_*1.1e110').asNumber(GType.BIGDECIMAL).fold().asString()", ['"[2969999999999999700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000]"']],
    // A row-correlated value, keyed and nested.
    ["g.V().has('age').group().by('name').by(values('age').math('_*0+1.0000000000000002E20').asNumber(GType.BIGDECIMAL))",
      ['{"josh":10000000000000002e--4M,"marko":10000000000000002e--4M,"peter":10000000000000002e--4M,"vadas":10000000000000002e--4M}']],
    // A min/max winner keeps its own class (a Double), all 17 digits intact.
    ["g.V(1).values('age').math('_*0-1.0000000000000002E20').union(identity(), constant(0.5m)).min().fold()", ['[-100000000000000020000d]']],
    ["g.V(1).project('a').by(union(values('age').math('_*0+1.0000000000000002E20'), constant(0.5m)).max())", ['{"a":100000000000000020000d}']],
    // The scalar framer spells through the same entry: a REAL whose shortest form is short stays short.
    ["g.V().values('age').is(35).math('_*1.1e110').asNumber(GType.BIGDECIMAL)", ['385e--109M']],
    // A Double member already took the exact entry, and decimal TEXT keeps its scale.
    ["g.V(1).values('age').math('_*0+0.30000000000000004').fold()", ['[0.30000000000000004d]']],
    ["g.V(1).values('age').math('_*0+0.30000000000000004').project('a').by(identity())", ['{"a":0.30000000000000004d}']],
    ["g.V(1).values('age').math('_*0+0.30000000000000004').groupCount()", ['{0.30000000000000004d:1L}']],
    ['g.inject(1.50m).fold()', ['[150e-2M]']],
    ['g.inject(1.50m).groupCount()', ['{150e-2M:1L}']],
    ["g.V(1).values('age').math('_*0+100').asNumber(GType.BIGDECIMAL).fold()", ['[1000e-1M]']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe("outside the range SQLite's decimal text is exact in, a Double ANSWERS — a last ulp may move", () => {
  // SQLite's own decimal <-> binary64 conversion is not correctly rounded far from 1 (exact in [1e-82, 1e118) on
  // 3.51.2, a few ulps off for 10-45% of values beyond): `printf('%!.17g')` spells 3.7430242338180544E203 as
  // …546E203. That is an accepted divergence (`docs/feature-support-matrix.md`, "Extreme-magnitude Doubles"):
  // every shape below answers, with the value or its last-ulp neighbour, and never declines.
  const BIG = "g.V(1).values('age').math('_*0+3.7430242338180544E203')";
  const BIG2 = "g.V(1).values('age').math('_*0+3.2101885945796966E119')";
  const TINY = "g.V(1).values('age').math('_*0+1.5e-300')";
  for (const q of [
    `${BIG}.fold()`, `${BIG}.asNumber(GType.BIGDECIMAL)`, `${BIG}.asNumber(GType.BIGDECIMAL).fold()`,
    `${BIG}.union(identity(), constant(0.5m)).max()`, `${BIG}.union(identity(), constant(0.5m)).max().fold()`,
    `${BIG2}.fold()`, `${BIG2}.asNumber(GType.BIGDECIMAL)`, `${BIG2}.asNumber(GType.BIGDECIMAL).fold()`,
    `${BIG2}.union(identity(), constant(0.5m)).max()`, `${BIG2}.union(identity(), constant(0.5m)).max().project('a').by(identity())`,
    `${BIG2}.project('a').by(identity())`, `${BIG2}.as('a').select('a')`, `${BIG2}.groupCount()`,
    `${BIG2}.group().by(constant(1))`, `${BIG2}.aggregate('x').cap('x')`, `${BIG2}.fold().unfold()`,
    `${TINY}.fold()`, `${TINY}.asNumber(GType.BIGDECIMAL)`, `${TINY}.project('a').by(identity())`,
    "g.V().values('age').is(35).math('_*1.1e300').asNumber(GType.BIGDECIMAL).fold()",
    "g.V().values('age').is(27).math('_*1.1e300').asNumber(GType.BIGDECIMAL)",
    'g.inject(1.5e-300d).fold()', 'g.inject([1.5e-300d]).unfold()', 'g.inject(3.2101885945796966E119d).as(\'a\').select(\'a\')',
    "g.V(1).property('s', '1.5e-300') ;; g.V(1).values('s').asNumber()",
  ]) test(`answers: ${q}`, async () => expect((await classes(q)).length).toBeGreaterThan(0));

  const answered: [string, string[]][] = [
    // The top level reads the REAL itself.
    [BIG, ['3.743024233818054e+203d']],
    [BIG2, ['3.2101885945796967e+119d']],
    // A literal is read by SQLite's own decimal reader: `1.5e-300` lands its last-ulp neighbour, consistently on
    // both sides of a compare.
    [TINY, ['1.4999999999999998e-300d']],
    ['g.inject(1.5e-300d)', ['1.4999999999999998e-300d']],
    ['g.inject(1.5e-300d).is(1.5e-300d)', ['1.4999999999999998e-300d']],
    ['g.withSack(1.5e-300d).V(1).sack()', ['1.4999999999999998e-300d']],
    ['g.inject(3.2101885945796966E119d, 1d).max()', ['3.2101885945796967e+119d']],
    [`${BIG2}.dedup()`, ['3.2101885945796967e+119d']],
    // ±Infinity and zero spell exactly everywhere.
    ["g.V(1).values('age').math('_ * 1e308 * 10').fold()", ['[Infinityd]']],
    // Just inside the range, 16 and 17 digits are carried exactly at every depth.
    ["g.V(1).values('age').math('_*0+1.2345678901234567E-79').fold()", ['[1.2345678901234567e-79d]']],
    ["g.V(1).values('age').math('_*0+1.2345678901234567E-79').asNumber(GType.BIGDECIMAL).fold()", ['[12345678901234567e-95M]']],
    ["g.V(1).values('age').math('_*0+9.999999999999998E115').fold()", ['[9.999999999999998e+115d]']],
    ["g.V(1).values('age').math('_*0+9.999999999999998E115').asNumber(GType.BIGDECIMAL).fold()", ['[9999999999999998e--100M]']],
    ["g.V().values('age').is(27).math('_*1.1e110').union(identity(), constant(0.5m)).max().fold()", ['[2.9699999999999997e+111d]']],
    ["g.V().values('age').is(27).math('_*1.1e110').groupCount()", ['{2.9699999999999997e+111d:1L}']],
    ["g.V().values('age').is(27).math('_*1.1e110').as('a').select('a')", ['2.9699999999999997e+111d']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe("a reducer's class is read through the ONE row-tag reading by every consumer — a branch condition, a local() host", () => {
  // `streamRowTag`: the stored `vtype`, else the framing's PER-ROW tag column (a reducer's `vt`), else the static
  // tag. A consumer that read `vtype` alone judged a reducer result by its storage class — a BigDecimal winner
  // carried as decimal TEXT failed `is(P.gt(0.9m))` inside `choose`/`local`, and `local()` re-framed a Double
  // winner as an Int.
  const answered: [string, string[]][] = [
    ["g.V(1).union(constant(1.0d), constant(0.5m)).max().choose(is(P.gt(0.9m)), constant('y'), constant('n'))", ['"y"']],
    ["g.V(1).union(constant(1.0d), constant(0.5m)).fold().max(local).choose(is(P.gt(0.9m)), constant('y'), constant('n'))", ['"y"']],
    ["g.V(1).union(constant(1.0d), constant(0.5m)).max().local(is(P.gt(0.9m)))", ['1d']],
    ["g.V(1).union(constant(5), constant(0.5m)).max().local(is(P.gt(0.9m)))", ['5i']],
    ["g.V(1).union(constant(5), constant(2.5d)).max().local(is(P.gt(3)))", ['5i']],
    ["g.V(1).union(constant(5), constant(2.5d)).max().local(identity())", ['5i']],
    ["g.V(1).values('age').max().local(is(P.gt(3)))", ['29i']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('a sum where a Double meets a 128-bit row adds in double, framed as their common class (BigDecimal)', () => {
  // `NumberHelper.add` widens each addend through `bigDecimalValue` and adds at the larger scale
  // (`NumberHelper.java:362-390,850-859`): `1.0d + 5n` is 6.0, `0.1d + 0.2d + 5n` 5.30000000000000004. SQLite's REAL
  // `SUM` gives the same value to 17 digits, at the scale the JS framer reads — a deliberate divergence.
  const answered: [string, string[]][] = [
    ["g.V(1).union(constant(1.0d), constant(5n)).sum()", ['6e-0M']],
    ["g.V(1).union(constant(0.1d), constant(0.2d), constant(5n)).sum()", ['53e-1M']],
    ["g.V(1).union(constant(1.0d), constant(5n)).fold().sum(local)", ['6e-0M']],
    ["g.V(1).local(union(constant(1.0d), constant(5n)).sum())", ['6e-0M']],
    ["g.V(1).union(constant(1.0d), constant(5).asNumber(GType.BIGDECIMAL)).sum()", ['6e-0M']],
    ["g.V(1).union(constant(1), constant(5n)).sum()", ['6N']],
    ["g.V(1).union(constant(1), constant(5).asNumber(GType.BIGDECIMAL)).sum()", ['6e-0M']],
    ["g.V(1).union(constant(1.5d), constant(5L)).sum()", ['6.5d']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('a 16- or 17-digit Double LITERAL inside a container is exact — whole or not, under unfold, fold and is()', () => {
  // SQLite's JSON writer prints a REAL at 15 significant digits, so a compiler-written literal entering a JSON
  // container — an `inject([…])`/`constant([…])` member, its `{t:'double'}` envelope, a map value — came back
  // ANOTHER Double: `inject([1.0000000000000002E20d])` framed [1.0E20] and `is(gt(1.0E20d))` filtered it out.
  // The emitter's ONE JSON-entry rule (`jsonEntry`, src/rel/emit.ts) now spells such a literal as the JSON
  // number of its shortest round-trip form; the run-time twin is `asExactReal` (compiler/rel/build.ts).
  const answered: [string, string[]][] = [
    ['g.inject([9.999999999999998E115d]).unfold()', ['9.999999999999998e+115d']],
    ['g.inject([1.0000000000000002E20d])', ['[100000000000000020000d]']],
    ['g.inject([1.2345678901234567E30d]).unfold()', ['1.2345678901234567e+30d']],
    ['g.inject([1.2345678901234567E16d]).unfold()', ['12345678901234568d']],
    ['g.inject([1.2345678901234567E16d]).unfold().fold()', ['[12345678901234568d]']],
    ['g.inject(1).constant([1.2345678901234567E30d])', ['[1.2345678901234567e+30d]']],
    ['g.inject(1).constant([1.2345678901234567E16d]).unfold().fold()', ['[12345678901234568d]']],
    ['g.inject([1.2345678901234567E30d]).unfold().is(1.2345678901234567E30d)', ['1.2345678901234567e+30d']],
    ['g.inject([1.0000000000000002E20d]).unfold().is(gt(1.0E20d))', ['100000000000000020000d']],
    ['g.inject(1).constant([1.2345678901234567E16d]).unfold().is(1.2345678901234567E16d)', ['12345678901234568d']],
    ['g.inject([0.30000000000000004d, -0.0d, 2.0d, 1.0E7d]).unfold()', ['0.30000000000000004d', '0d', '2d', '10000000d']],
    ['g.inject([0.30000000000000004, 3, 1L]).unfold()', ['0.30000000000000004d', '3i', '1L']],
    ['g.inject(1).constant([1.2345678901234567E16d, 1L, 2b, 3.5f]).unfold()', ['12345678901234568d', '1L', '2b', '3.5f']],
    ["g.inject(['k':1.0000000000000002E20d]).select('k')", ['100000000000000020000d']],
    ["g.inject(1).constant(['k':1.2345678901234567E16d])", ['{"k":12345678901234568d}']],
    ['g.inject([3.0d, 1.2345678901234567E16d]).merge([1.0000000000000002E20d])', ['set[3d,12345678901234568d,100000000000000020000d]']],
    ['g.inject([1.2345678901234567E16d]).unfold().asNumber(GType.BIGDECIMAL).fold()', ['[12345678901234568e-0M]']],
    // A top-level literal re-entering a container through a step, at every depth.
    ['g.inject(1.2345678901234567E16d).fold()', ['[12345678901234568d]']],
    ["g.inject(1.2345678901234567E16d).project('a').by(identity())", ['{"a":12345678901234568d}']],
    ["g.inject(1.0000000000000002E20d).as('a').select('a')", ['100000000000000020000d']],
    ['g.inject(1.0000000000000002E20d).groupCount()', ['{100000000000000020000d:1L}']],
    ["g.inject(1).project('x').by(constant(1.2345678901234567E16d))", ['{"x":12345678901234568d}']],
    ['g.inject(1).union(constant(0.30000000000000004d), constant(1.0000000000000002E20d)).fold()', ['[0.30000000000000004d,100000000000000020000d]']],
    ['g.withSack(1.0000000000000002E20d).V(1).sack().fold()', ['[100000000000000020000d]']],
    ["g.V(1).as('a').constant([1.2345678901234567E16d]).as('b').select('a','b').select('b')", ['[12345678901234568d]']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});

describe('a COMPUTED 16- or 17-digit Double is exact inside every container — fold, project, select, groupCount, a min/max winner', () => {
  const D16 = "g.V().values('age').is(35).math('_*0+1.2345678901234567E16')";
  const D17 = "g.V().values('age').is(35).math('_*0+0.30000000000000004')";
  const answered: [string, string[]][] = [
    [`${D17}.fold()`, ['[0.30000000000000004d]']],
    [`${D17}.project('a').by(identity())`, ['{"a":0.30000000000000004d}']],
    [`${D17}.as('a').select('a')`, ['0.30000000000000004d']],
    [`${D17}.groupCount()`, ['{0.30000000000000004d:1L}']],
    [`${D16}.fold()`, ['[12345678901234568d]']],
    [`${D16}.asNumber(GType.BIGDECIMAL).fold()`, ['[12345678901234568e-0M]']],
    [`${D16}.asNumber(GType.BIGDECIMAL).fold().asString()`, ['"[12345678901234568]"']],
    ["g.V().values('age').is(35).math('_*0-1.0000000000000002E20').union(identity(), constant(0.5m)).min().fold()", ['[-100000000000000020000d]']],
    ["g.V().values('age').is(35).math('_*0+1.0000000000000002E20').asNumber(GType.BIGDECIMAL).groupCount()", ['{10000000000000002e--4M:1L}']],
  ];
  for (const [q, expected] of answered) test(q, async () => expect(await classes(q)).toEqual(expected));
});
