// THE ERROR SURFACE — every way a traversal may FAIL is one of three, and nothing else reaches a user:
//   - `UnsupportedTraversal` — the decline: what this engine cannot answer exactly (`src/compiler/unsupported.ts`);
//   - `ValueParseError` — the traversal's ANSWER is the reference's own error, decided from its TEXT;
//   - `RaisedByQuery` — the answer is an error the DATA (or the document an io() reads) decided.
// Each case below was a silent wrong answer or a raw internal error (a JS `SyntaxError`, SQLite's
// `datatype mismatch`, a bare `Error`) before; the exact-answer cases pin values that used to frame wrong.
import { describe, expect, test } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { UnsupportedTraversal } from '../src/compiler/unsupported.ts';
import { ValueParseError } from '../src/gremlin/coerce.ts';
import { RaisedByQuery } from '../src/rel/raise.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { typedAll } from './support/decode.ts';

let graphs = 0;
/** `gremlin` over a fresh modern graph — after `setup` has written to it, where a case needs a stored
 *  value of a chosen class. */
async function run(gremlin: string, setup: readonly string[] = []): Promise<string[]> {
  const manager = new BunGraphManager(undefined, extendedRegistry);
  const id = `g${graphs++}`;
  for (const seed of [...MODERN_SEED, ...setup]) await manager.executor(id).framedAsync(seed, {});
  const framed = await manager.executor(id).framedAsync(gremlin, {});
  const buffers: Buffer[] = [];
  for (const f of framed as { buf: Buffer; bulk?: number | bigint }[])
    for (let i = 0; i < Number(f.bulk ?? 1); i++) buffers.push(f.buf);
  return typedAll(buffers);
}

async function failure(gremlin: string, setup: readonly string[] = []): Promise<Error> {
  try { await run(gremlin, setup); } catch (error) { return error as Error; }
  throw new Error(`${gremlin} answered; expected it to fail`);
}

describe('a map-literal key is the literal it spells, or the traversal declines', () => {
  // `GenericLiteralVisitor.visitGenericMapLiteral` visits a numeric key AS A NUMBER; the source text as a
  // String key was a different map. Integer/Long keys are carried; what a JS Map cannot key faithfully declines.
  test('an Integer key is stored as a number, not its source text', async () => {
    expect(await run("g.V(1).property('m',[1:'a']).values('m')")).toEqual(['{1i:"a"}']);
  });
  test.each([
    "g.inject([1.5:'a'])", "g.inject([Infinity:1])", "g.inject([NaN:1])", "g.inject([null:1])",
    "g.inject([[1]:1])", "g.inject([{1}:1])", "g.inject([['a':1]:1])",
    "g.inject([1:'a',1L:'b'])", "g.inject([1:'a','1':'b'])",
    "g.inject([1:'a']).select(keys).unfold().is(1)",
  ])('%s declines', async (q) => {
    expect(await failure(q)).toBeInstanceOf(UnsupportedTraversal);
  });
  // An enum (`T`/`Direction`) key or member has no faithful STORED spelling yet: it was written as the
  // front-end tag and framed back as the map key `{"token":"id"}`. Every depth meets the one encoder
  // (`types.ts` `valueNodeOf`), so every depth declines; the top-level literal stays exact.
  test.each([
    "g.V(1).property('m',[(T.id):'a']).values('m')", "g.V(1).property('m',[(OUT):'a']).values('m')",
    "g.V(1).property('m',[(T.key):'a'])", "g.V(1).property('m',['x':[(T.label):'a']])",
    "g.V(1).property('m',[T.id])", "g.V(1).property('m',[[(T.id):'a']])", "g.inject(['x':[(T.id):'a']])",
    "g.addV('p').property('m',[(T.id):'a'])", "g.V(1).union(__.property('m',[(T.id):'a'])).values('m')",
  ])('%s declines', async (q) => {
    expect(await failure(q)).toBeInstanceOf(UnsupportedTraversal);
  });
  test('a top-level T-keyed literal is the enum key', async () => {
    expect(await run("g.inject([(T.id):'a'])")).toEqual(['{T.id:"a"}']);
  });
});

describe('±Infinity survives every collection carrier', () => {
  test.each([
    ["g.inject(['a':Infinity,'b':1]).order(local).by(values)", '{"b":1i,"a":Infinityd}'],
    ["g.inject(['a':Infinity,'b':1]).order(local).by(keys)", '{"a":Infinityd,"b":1i}'],
    ["g.inject(['b':-Infinity,'a':1]).order(local).by(keys,desc)", '{"b":-Infinityd,"a":1i}'],
    ['g.inject([Infinity,2]).product([1])', '[[Infinityd,1i],[2i,1i]]'],
    // `ConjoinStep` appends each member's `toString`: `Double.toString` spells `Infinity`, and a whole
    // Double keeps its `.0` (the modern graph's weight 1.0 is stored as INTEGER 1).
    ["g.inject([Infinity,2]).conjoin(',')", '"Infinity,2"'],
    ["g.inject([-Infinity,2.5d]).conjoin('-')", '"-Infinity-2.5"'],
    ["g.E().values('weight').fold().conjoin(';')", '"0.5;1.0;0.4;1.0;0.4;0.2"'],
  ])('%s', async (q, want) => {
    expect(await run(q)).toEqual([want]);
  });
  test("conjoin() of a Double SQLite cannot print as Java does raises a deferral", async () => {
    expect(await failure("g.inject([0.30000000000000004d,2]).conjoin(',')")).toBeInstanceOf(RaisedByQuery);
  });
});

describe('NaN is never answered as null', () => {
  test.each([
    'g.inject(NaN)', "g.inject(['a':NaN])", 'g.inject([1,NaN])', 'g.inject(1).constant(NaN)',
    "g.addV('x').property('a',NaN)", "g.addV('x').property('a',[NaN])",
  ])('a NaN value declines: %s', async (q) => {
    expect(await failure(q)).toBeInstanceOf(UnsupportedTraversal);
  });
  test.each([
    'g.inject(Infinity,-Infinity).sum()', 'g.inject([Infinity,-Infinity]).sum(local)',
    'g.inject(Infinity,-Infinity).mean()', "g.inject(Infinity).math('_ - _')",
    "g.inject(-1d).math('sqrt(_)')", 'g.withSack(Infinity).inject(1).sack(sum).by(constant(-Infinity)).sack()',
  ])('a NaN result raises a deferral rather than answer null or drop the row: %s', async (q) => {
    expect(await failure(q)).toBeInstanceOf(RaisedByQuery);
  });
  // A NaN OPERAND compares as no value does — `neq` holds, every other comparison fails
  // (`semantics/Comparability.feature`); the predicate is its constant truth value.
  test.each([
    ['g.inject(1.0d).is(P.neq(NaN))', ['1d']], ['g.inject(1.0d).is(P.eq(NaN))', []],
    ['g.inject(null).is(P.neq(NaN))', ['null']], ['g.inject(1d).not(is(P.gt(NaN)))', ['1d']],
    ["g.V().has('age',within(NaN,29)).values('age')", ['29i']],
  ])('%s', async (q, want) => {
    expect(await run(q)).toEqual(want);
  });
});

describe("the reference's own message, never an internal error", () => {
  test.each([
    ["g.inject(1).mergeV([a:1]).option(onMatch, [(T.id):1])", 'option(onMatch) expects keys in Map to be of String - check: id'],
    ["g.mergeV([(Direction.OUT):1])", 'mergeV() and option(onCreate) args expect keys in Map to be either String or [id, label] - check: OUT'],
    ["g.mergeV([1:'a'])", 'mergeV() and option(onCreate) args expect keys in Map to be either String or [id, label] - check: 1'],
    ['g.mergeV([(T.id):null])', 'mergeV() does not allow null Map values - check: id'],
    ["g.V(1).property('a',1,'m')", 'The provided key/value array length must be a multiple of two'],
    ["g.V(1).property('a',1,2,3)", 'The provided key/value array must have a String, T, or Traversal on even array indices'],
  ])('%s', async (q, message) => {
    const error = await failure(q);
    expect(error).toBeInstanceOf(ValueParseError);
    expect(error.message).toBe(message);
  });

  test.each([
    "g.V().has('name', regex('['))", "g.V().has('name', notRegex('('))",
    'g.inject(1).limit(9999999999999999999999)', 'g.inject(1,2).skip(9999999999999999999999)',
    "g.inject(1).math('1 +')", "g.inject(1).math('1 $ 2')", "g.inject(1).math('(1')",
  ])('declines rather than leak a JS/SQLite error: %s', async (q) => {
    expect(await failure(q)).toBeInstanceOf(UnsupportedTraversal);
  });

  test('an io() with no binding is the query\'s answer, not an internal fault', async () => {
    const error = await failure("g.io('missing.json').read()");
    expect(error).toBeInstanceOf(RaisedByQuery);
    expect(error.message).toContain('no io binding is configured');
  });

  // Not a server fault at all: the test decoder lost its cursor on an enum (T.id) inside a map.
  test('elementMap() of a fresh vertex frames its T keys', async () => {
    expect(await run("g.addV('x').property('m',1.5d).elementMap()")).toEqual(['{T.id:7i,T.label:"x","m":1.5d}']);
  });
});

describe('a slice count is decoded EXACTLY, at one authority (`sliceOf` / `countOf`)', () => {
  // A count past 2^53 lost precision through `Number()`, and a `bigint` count was skipped by the tail
  // decoder, which then answered `tail(1)`. No stream holds 2^53 members, so a long past it is "all".
  test.each([
    ['g.inject(1,2).tail(9223372036854775807L)', ['1i', '2i']],
    ['g.inject(1,2).tail(9007199254740992)', ['1i', '2i']],
    ['g.inject([1,2]).tail(local,9223372036854775807L)', ['[1i,2i]']],
    ['g.inject(1,2).limit(9223372036854775807L)', ['1i', '2i']],
    ['g.inject(1,2,3).range(1,9223372036854775807L)', ['2i', '3i']],
    ['g.inject(1,2,3).range(9223372036854775806L,9223372036854775807L)', []],
    ["g.V().local(values('age').fold().tail(local,9223372036854775807L))", ['[29i]', '[27i]', '[]', '[32i]', '[]', '[35i]']],
    // `RangeGlobalStep`/`RangeLocalStep`: a negative low counts from the first member, a negative high
    // other than -1 is empty.
    ['g.inject(1,2,3,4,5,6,7).range(-1,5)', ['1i', '2i', '3i', '4i', '5i']],
    ['g.inject(1,2,3,4,5,6,7).range(-3,5)', ['1i', '2i', '3i', '4i', '5i']],
    ['g.inject(1,2,3).range(-5,-3)', []],
    ['g.inject(1,2,3).skip(-2)', ['1i', '2i', '3i']],
    ['g.inject([1,2,3,4,5,6,7]).range(local,-3,5)', ['[1i,2i,3i,4i,5i]']],
    ["g.inject(['a':1,'b':2]).range(local,-1,1)", ['{"a":1i}']],
  ])('%s', async (q, want) => {
    expect(await run(q)).toEqual(want);
  });
  test.each([
    ['g.inject(1,2,3).limit(-2)', 'Not a legal range: [0, -2]'],
    ['g.inject(1,2,3).range(0,-5)', 'Not a legal range: [0, -5]'],
    ['g.inject([1,2,3]).limit(local,-2)', 'Not a legal range: [0, -2]'],
    ['g.inject(1).range(9223372036854775807L,9223372036854775806L)', 'Not a legal range: [9223372036854775807, 9223372036854775806]'],
  ])("%s raises the reference constructor's error", async (q, message) => {
    const error = await failure(q);
    expect(error).toBeInstanceOf(ValueParseError);
    expect(error.message).toBe(message);
  });
  test.each([
    'g.inject(1,2).tail(9999999999999999999999)', 'g.inject([1,2]).tail(local,9999999999999999999999)',
    "g.V().local(values('age').fold().tail(local,9999999999999999999999))",
    "g.V().group().by(label).by(values('name').tail(9999999999999999999999))",
    'g.inject(1,2).tail(-5)', 'g.inject(1,2).sample(9223372036854775807L)',
  ])('declines a count no long (or int) the reference holds: %s', async (q) => {
    expect(await failure(q)).toBeInstanceOf(UnsupportedTraversal);
  });
});

describe('dateAdd() never leaks a JS RangeError', () => {
  test.each([
    "g.inject(datetime('2020-01-01T00:00:00Z')).dateAdd(DT.day, 9223372036854775807L)",
    "g.inject(datetime('2020-01-01T00:00:00Z')).dateAdd(DT.day, 2147483647)",
    "g.inject(datetime('2020-01-01T00:00:00Z')).dateAdd(DT.day, 100000000)",
    "g.V(1).property('d', datetime('2020-01-01T00:00:00Z')).values('d').dateAdd(DT.day, 100000000)",
    "g.V(1).property('d', datetime('2020-01-01T00:00:00Z')).values('d').dateAdd(DT.day, 100000000).fold()",
  ])('an instant past what a date frames declines: %s', async (q) => {
    expect(await failure(q)).toBeInstanceOf(UnsupportedTraversal);
  });
});

describe('a negative zero keeps its sign through every set op', () => {
  test.each([
    ['g.inject([-0.0d,2]).product([1])', '[[-0d,1i],[2i,1i]]'],
    ['g.inject([2]).product([-0.0d])', '[[2i,-0d]]'],
    ['g.inject([-0.0d,2]).combine([1])', '[-0d,2i,1i]'],
    ['g.inject(-0.0d,1).fold().combine([1])', '[-0d,1i,1i]'],
    ['g.inject(-0.0d,1).fold().merge([1])', 'set[-0d,1i]'],
    ['g.inject(-0.0d,1).fold().difference([0.0d])', 'set[-0d,1i]'],
    ["g.inject(-0.0d,'a').fold().product([1])", '[[-0d,1i],["a",1i]]'],
  ])('%s', async (q, want) => {
    expect(await run(q)).toEqual([want]);
  });
});

test("math()'s NULL-result deferral names an infinity as well as a NaN (`log(0)` is -Infinity in exp4j)", async () => {
  const error = await failure("g.inject(1).math('log(0)')");
  expect(error).toBeInstanceOf(RaisedByQuery);
  expect(error.message).toContain('infinity');
});

describe('a NaN element id declines, never an internal TypeError', () => {
  // `elementScan` honours a `constLit` decline at its one site rather than asserting it away.
  test.each([
    'g.V(NaN)', 'g.E(NaN)', 'g.V(1,NaN)', 'g.V([NaN])', 'g.inject(1).V(NaN)', 'g.V(NaN).drop()',
    'g.V().where(__.V(NaN))', 'g.V().local(__.V(NaN))',
  ])('%s', async (q) => {
    expect(await failure(q)).toBeInstanceOf(UnsupportedTraversal);
  });
  test('an Infinity id is no element: g.V(Infinity)', async () => {
    expect(await run('g.V(Infinity)')).toEqual([]);
  });
});

describe('asNumber() parses a String as NumberUtils.createNumber does, never an internal error', () => {
  // `AsNumberStep.parseNumber`: a numeral `isCreatable` refuses raises "Can't parse string '…' as number."
  test.each([
    "g.inject('Infinity').asNumber()", "g.inject('-Infinity').asNumber()", "g.inject('NaN').asNumber()",
    "g.inject('Infinity').asNumber(GType.DOUBLE)", "g.inject('1,000').asNumber()", "g.inject('#5').asNumber()",
  ])('%s raises the parse error', async (q) => {
    const error = await failure(q);
    expect(error).toBeInstanceOf(ValueParseError);
    expect(error.message).toMatch(/^Can't parse string '.*' as number\.$/);
  });
  test.each([
    ["g.inject('99999999999999999999').asNumber().asString()", '"99999999999999999999"'],
    ["g.inject('3000000000').asNumber()", '3000000000L'],
    ["g.inject('1.5').asNumber()", '1.5f'], ["g.inject('2.0').asNumber()", '2f'],
    ["g.inject('0.123456789').asNumber()", '0.123456789d'], ["g.inject('010').asNumber()", '8i'],
    ["g.inject('0x5').asNumber()", '5i'], ["g.inject('0xFFFFFFFF').asNumber()", '4294967295L'],
  ])('%s', async (q, want) => {
    expect(await run(q)).toEqual([want]);
  });
  // `bigDecimalValue(±Infinity)` is a NumberFormatException: declined, never the BigDecimal framer's
  // JS SyntaxError.
  test.each(['g.inject(Infinity).asNumber(GType.BIGDECIMAL)', 'g.inject(-Infinity).asNumber(GType.BIGDECIMAL)'])('%s declines', async (q) => {
    expect(await failure(q)).toBeInstanceOf(UnsupportedTraversal);
  });
});

describe("a per-row bare asNumber() answers the value's own class", () => {
  // `AsNumberStep.map` returns a Number UNCHANGED and parses a String as `createNumber` does.
  const asNumber = "g.V(1).values('s').asNumber()";
  test.each([
    ["g.V(1).property('s','5')", '5i'], ["g.V(1).property('s','3000000000')", '3000000000L'],
    ["g.V(1).property('s',1.5d)", '1.5d'], ["g.V(1).property('s',2.0d)", '2d'], ["g.V(1).property('s',5L)", '5L'],
    ["g.V(1).property('s',1.5f)", '1.5f'], ["g.V(1).property('s','2.0')", '2f'],
  ])('%s', async (setup, want) => {
    expect(await run(asNumber, [setup])).toEqual([want]);
  });
  test('a stored unparseable String raises the reference error', async () => {
    const error = await failure(asNumber, ["g.V(1).property('s','Infinity')"]);
    expect(error).toBeInstanceOf(ValueParseError);
    expect(error.message).toBe("Can't parse string 'Infinity' as number.");
  });
  // The runtime CAST to BIGDECIMAL fences a non-finite REAL rather than hand the framer an infinity.
  test.each([
    ["g.V(1).values('s').asNumber(GType.BIGDECIMAL)", "g.V(1).property('s',Infinity)"],
    ["g.V(1).values('s').asNumber(GType.BIGDECIMAL)", "g.V(1).property('s',-Infinity)"],
    ['g.inject(1n, Infinity).sum()', 'g.V(1)'],
  ])('%s over a non-finite value raises a deferral', async (q, setup) => {
    expect(await failure(q, [setup])).toBeInstanceOf(RaisedByQuery);
  });
});

describe('Double.toString spells an infinity `Infinity`, at the one asString() authority', () => {
  test.each([
    ["g.inject([Infinity,2]).conjoin(',')", '"Infinity,2"'], ["g.inject([-Infinity,2.5d]).conjoin('-')", '"-Infinity-2.5"'],
    ['g.inject(Infinity).asString()', '"Infinity"'], ['g.inject(-Infinity).asString()', '"-Infinity"'],
    ["g.inject([Infinity,2.5f]).conjoin(',')", '"Infinity,2.5"'], ["g.inject(1).local(__.constant(Infinity).asString())", '"Infinity"'],
  ])('%s', async (q, want) => {
    expect(await run(q)).toEqual([want]);
  });
  test('a stored infinity', async () => {
    expect(await run("g.V(1).values('s').asString()", ["g.V(1).property('s',-Infinity)"])).toEqual(['"-Infinity"']);
  });
});

describe("regex() reads its pattern as Java's Pattern does, or declines", () => {
  test.each([
    ['(?<n>a)', ['"marko"', '"vadas"']], ['(?:mar)ko', ['"marko"']], ['(?!mar)ko', ['"marko"']],
    ['(mar)?ko$', ['"marko"']], ['\\\\s', []], ['jo.*h', ['"josh"']],
    // A hex escape is ONE character to Pattern; the trigram prefilter read its digits as a literal run
    // (`containing("61rko")`) and dropped every true match.
    ['ma\\\\u0072ko', ['"marko"']], ['m\\\\x61rko', ['"marko"']], ['[m]\\\\x61rko', ['"marko"']],
    ['\\\\u0061', ['"marko"', '"vadas"']], ['\\\\x6aosh', ['"josh"']],
  ] as const)('regex(%s)', async (pattern, want) => {
    expect(await run(`g.V().has('name', regex('${pattern}')).values('name')`)).toEqual([...want]);
  });
  test.each(['(?<=m)a', '\\\\Qa\\\\E', '\\\\p{L}+', '[\\\\w&&[^a]]', 'a{2', '\\\\bm', '['])('regex(%s) declines', async (pattern) => {
    expect(await failure(`g.V().has('name', regex('${pattern}')).values('name')`)).toBeInstanceOf(UnsupportedTraversal);
  });
  test("Java's `$` matches before a final line terminator", async () => {
    expect(await run("g.V().has('t', regex('a$')).values('name')", ["g.V(1).property('t','a\\n')"])).toEqual(['"marko"']);
  });
});

describe('a set op keeps each member its class', () => {
  // `HashSet.contains` keeps Long(1) apart from Integer(1) (`DifferenceStep`).
  test.each([
    ['g.inject(1L,2L).fold().combine([1])', '[1L,2L,1i]'], ['g.inject(1L,2L).fold().difference([1])', 'set[1L,2L]'],
    ['g.inject(1L,2L).fold().product([1])', '[[1L,1i],[2L,1i]]'], ['g.inject(1.5f).fold().combine([1])', '[1.5f,1i]'],
  ])('%s', async (q, want) => {
    expect(await run(q)).toEqual([want]);
  });
  test('a stored Long member', async () => {
    expect(await run("g.V().values('x').fold().difference([1])", ["g.V(1).property('x',1L)"])).toEqual(['set[1L]']);
  });
});
