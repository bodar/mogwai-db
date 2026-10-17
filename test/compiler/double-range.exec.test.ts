// EVERY FINITE DOUBLE, through every text seam it crosses — or a deferral that leaves the graph as it was.
//
// Outside [1e-80, 1e116] SQLite's decimal <-> binary64 conversion is not correctly rounded in either
// direction (`src/rel/exact-decimal.ts`), so no decimal TEXT carries such a Double through a JSON text SQL
// reads again. Three rules follow, each pinned here at more than one depth:
//
// 1. An ELEMENT payload is read only by the framer, so a stored property rides there as the exact wire
//    carrier (`binary64Carrier` → `binary64OfCarrier`): one `property('x', 1e300d)` no longer makes
//    `g.V()`, `g.E()`, a write echo or any element-carrying shape raise for the whole graph.
// 2. A JSON member SQL may re-read still DEFERS (`RaisedByQuery`) — and a write program that defers is ONE
//    atomic unit (`runSteps`, `src/program.ts`), so the write it follows is rolled back, never committed
//    behind a failure.
// 3. An UNTYPED number (a JSON request, a typeless client) is classed as the reference GLV classes it
//    (`numberClassOf`, `src/gremlin/types.ts`): a whole number past 2^53 is a Double, never a Long
//    (past 2^63 no Long exists, and every later read raised).
import { test, expect, describe } from 'bun:test';
import { RaisedByQuery } from '../../src/rel/raise.ts';
import { binary64OfCarrier } from '../../src/rel/exact-decimal.ts';
import { numberClassOf } from '../../src/gremlin/types.ts';
import { parseElementJson } from '../../src/json-exact.ts';
import { seededStore } from '../support/harness.ts';
import { executeFramed, executeQuery } from '../support/executor.ts';
import { decodeAll, typedAll } from '../support/decode.ts';

/** A deterministic stream of finite non-zero doubles, uniform over BIT PATTERNS — so every exponent, the
 *  subnormals included, is as likely as any other (most of them outside the exact range). */
function bitPatternDoubles(n: number, seed: number): number[] {
  let state = seed >>> 0;
  const next = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const view = new DataView(new ArrayBuffer(8));
  const out: number[] = [];
  while (out.length < n) {
    view.setUint32(0, next()); view.setUint32(4, next());
    const x = view.getFloat64(0);
    if (Number.isFinite(x) && x !== 0) out.push(x);
  }
  return out;
}

const EDGES: readonly number[] = [
  Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE,
  2.2250738585072014e-308, 2.225073858507201e-308, // the smallest normal, the largest subnormal
  2 ** -1000, 2 ** -1000 * (1 - 2 ** -53), 2 ** 1000, 2 ** 1000 * (1 - 2 ** -53), // around the carrier's bands
  1e-190, 1.0000000000000002e-190, 9.999999999999999e-191, 2 ** -640, 2 ** 640, 2 ** -500, 2 ** 500,
  1e-81, 9.99999999999e-81, 2e116, 1.0000000000000002e116,
  1.5e300, 1.5e-300, 3.7430242338180544e203, -4.9406564584124654e-322,
];

describe('a stored Double outside the exact range rides the element payload exactly', () => {
  const values = [...EDGES, ...bitPatternDoubles(400, 0x5eed)];

  test('g.V() — every vertex property, every value, bit for bit', async () => {
    const store = seededStore();
    const ids: number[] = [];
    for (const x of values) ids.push((await decodeAll(executeQuery(store, "g.addV('f').property('x', p).id()", { p: x }, { p: 'double' })))[0]);
    const byId = new Map<number, number>();
    for (const v of await decodeAll(executeQuery(store, "g.V().hasLabel('f')"))) byId.set(v.id, v.properties[0].value);
    const wrong = values.filter((x, i) => !Object.is(byId.get(ids[i]!), x));
    expect(wrong).toEqual([]);
  });

  test('g.E() — an edge property', async () => {
    const store = seededStore();
    for (const x of EDGES) executeQuery(store, "g.V(1).addE('f').to(V(2)).property('w', p)", { p: x }, { p: 'double' });
    const got = (await decodeAll(executeQuery(store, "g.E().hasLabel('f')"))).map((e) => e.properties[0].value);
    expect(got.map(String)).toEqual(EDGES.map(String));
  });

  // The write echo is an element payload too: the write commits AND reports what it wrote.
  for (const q of [
    "g.addV('n').property('x', 1e300d)",
    "g.addV('n').property('x', 4.9E-324d)",
    "g.V(1).property('x', -1.7976931348623157E308d)",
    "g.V(1).addE('n').to(V(2)).property('x', 1e-300d)",
  ]) test(`echoes: ${q}`, async () => {
    const store = seededStore();
    const [echo] = await decodeAll(executeQuery(store, q));
    const prop = echo.properties.find((p: { key: string }) => p.key === 'x');
    expect(prop.value).toBe(Number(q.match(/'x', ([^)]+)d\)/)![1]));
  });

  // One stored out-of-range property answers every element-carrying shape — a top-level element, a folded
  // element, a grouped one, a path's, a projected one, a selected one — rather than raising for the graph.
  for (const q of [
    'g.V()', 'g.E()', 'g.V().fold()', 'g.V().group().by(label)', "g.V().has('x').path()",
    "g.V().has('x').project('a').by()", "g.V().has('x').as('a').select('a')", "g.V().has('x').values('x')",
    "g.V().has('x').properties()", "g.V().valueMap('name')",
  ]) test(`answers beside a 1e300d property: ${q}`, async () => {
    const store = seededStore();
    executeQuery(store, "g.addV('n').property('x', 1e300d)");
    expect((await decodeAll(executeQuery(store, q))).length).toBeGreaterThan(0);
  });
});

describe('a member SQL re-reads defers, and the write it follows is rolled back', () => {
  for (const q of [
    "g.addV('zz').property('x', 1e300d).values('x').fold()",
    "g.addV('zz').property('x', 1e300d).valueMap()",
    "g.addV('zz').property('x', 1e-300d).elementMap()",
    "g.addV('zz').property('x', 1e300d).project('a').by(values('x'))",
  ]) test(`defers and rolls back: ${q}`, () => {
    const store = seededStore();
    expect(() => executeQuery(store, q)).toThrow(RaisedByQuery);
    expect(typedAll(executeQuery(store, "g.V().hasLabel('zz').count()"))).toEqual(['0L']);
  });
});

describe('an untyped number is classed as the reference GLV classes it', () => {
  test('numberClassOf', () => {
    expect([1, -2147483648, 2147483648, 2 ** 53 - 1, -(2 ** 53 - 1), 2 ** 53, 9.3e18, 2 ** 63, 1.5, -0, 1e300].map(numberClassOf))
      .toEqual(['int', 'int', 'long', 'long', 'long', 'double', 'double', 'double', 'double', 'double', 'double']);
  });

  // A whole JS number >= 2^63 (and anything past 2^53) is a Double, so every later read answers.
  for (const x of [9.3e18, 1.0000000000000002e20, 2 ** 63, -(2 ** 64)]) test(`untyped ${x} writes and reads back as a Double`, () => {
    const store = seededStore();
    executeQuery(store, "g.V(1).property('q', x)", { x });
    const d = `${x}d`;
    expect(typedAll(executeQuery(store, "g.V(1).values('q')"))).toEqual([d]);
    expect(typedAll(executeQuery(store, "g.V(1).values('q').fold()"))).toEqual([`[${d}]`]);
    expect(typedAll(executeQuery(store, "g.V(1).valueMap('q')"))).toEqual([`{"q":[${d}]}`]);
    expect(typedAll(executeQuery(store, 'g.V().has(\'q\', x).count()', { x }))).toEqual(['1L']);
  });

  test('a safe integer past int32 is still a Long', () => {
    const store = seededStore();
    executeQuery(store, "g.V(1).property('q', x)", { x: 9007199254740991 });
    expect(typedAll(executeQuery(store, "g.V(1).values('q')"))).toEqual(['9007199254740991L']);
  });
});

describe('the wire carrier', () => {
  test('reads only its own spelling', () => {
    expect(binary64OfCarrier('1.0p640')).toBe(2 ** 640);
    expect(binary64OfCarrier('-1.5p-1000')).toBe(-1.5 * 2 ** -1000);
    for (const other of ['12.50', '1e300', 'p640', '1.0p200', '1.0p641', 1e300, null]) expect(binary64OfCarrier(other)).toBeNull();
  });

  test('parseElementJson decodes a binary64 leaf and nothing else', () => {
    const bag = parseElementJson('{"x":[{"t":"double","v":"1.0p640"}],"s":[{"t":"string","v":"1.0p640"}]}');
    expect(bag.x[0].v).toBe(2 ** 640);
    expect(bag.s[0].v).toBe('1.0p640');
  });
});

// The executor's own framed path agrees with the buffer path (a smoke check that the shared reader is wired
// at the framed entry as well).
test('executeFramed frames a carried property', () => {
  const store = seededStore();
  executeQuery(store, "g.addV('n').property('x', 1e300d)");
  expect(executeFramed(store, "g.V().hasLabel('n')").length).toBe(1);
});
