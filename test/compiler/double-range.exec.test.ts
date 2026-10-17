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
import { binary64OfCarrier, INEXACT_DECIMAL } from '../../src/rel/exact-decimal.ts';
import { numberClassOf } from '../../src/gremlin/types.ts';
import { parseElementJson } from '../../src/json-exact.ts';
import { loadGraphson, writeGraphson } from '../../src/formats/graphson.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { seededStore } from '../support/harness.ts';
import { exec, executeFramed, executeQuery } from '../support/executor.ts';
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
  }, 60_000); // ~425 sequential writes + a read: >5 s under the cored fan-out, so bun's 5 s default flakes

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

// THE SAME ANSWER IN BOTH RESPONSE FORMATS. The untyped-JSON tail (`Accept: application/json`,
// `resolveResultNodes` → `untyped.ts`) reads the element payload by its own route — a list column parsed
// whole — and once printed the raw wire carrier (`"3.28…e+107p640"`) where the GraphBinary path decoded
// it. Every carrier now decodes in the ONE element-payload reader (`parseElementJson`, which also walks an
// already-parsed tree), so each query below must read the same in both formats, at every depth an element
// list reaches.
describe('a carried property reads the same through GraphBinary and untyped JSON', () => {
  /** A GraphBinary-decoded result → the untyped JSON's shape (an element → `{id, props}`). */
  const fromBinary = (v: any): any => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'bigint') return Number(v);
    if (Array.isArray(v) || v instanceof Set) return [...v].map(fromBinary);
    if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), fromBinary(x)]));
    if (typeof v === 'object' && 'id' in v && 'properties' in v) {
      const props: Record<string, unknown[]> = {};
      for (const p of v.properties ?? []) (props[p.label ?? p.key] ??= []).push(fromBinary(p.value));
      return { id: v.id, props };
    }
    return v;
  };
  /** An untyped JSON result → the same shape (a vertex property is `{value}`, an edge's is bare). */
  const fromJson = (v: any): any => {
    if (Array.isArray(v)) return v.map(fromJson);
    if (v !== null && typeof v === 'object' && 'id' in v && 'properties' in v) {
      const props: Record<string, unknown[]> = {};
      for (const [k, xs] of Object.entries(v.properties as Record<string, any[]>))
        props[k] = xs.map((x) => fromJson(x !== null && typeof x === 'object' && 'value' in x ? x.value : x));
      return { id: v.id, props };
    }
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromJson(x)]));
    return v;
  };
  const store = seededStore();
  executeQuery(store, "g.addV('n').property('x', 1.5e300d).property('y', 4.9E-324d)");
  executeQuery(store, "g.V().hasLabel('n').addE('m').to(V(1)).property('w', -1e-300d)");
  const executor = exec(store);
  for (const q of [
    "g.V().hasLabel('n')", "g.E().hasLabel('m')",
    "g.V().hasLabel('n').fold()", "g.E().hasLabel('m').fold()", "g.V().hasLabel('n').outE().fold()",
    "g.V().hasLabel('n').aggregate('a').cap('a')", "g.V().hasLabel('n').local(fold())", "g.V().hasLabel('n').flatMap(fold())",
    "g.V().hasLabel('n').union(fold(), fold())", "g.V().hasLabel('n').fold().fold()",
    "g.V().hasLabel('n').repeat(identity()).times(2).fold()", "g.V().hasLabel('n').dedup().fold()", "g.V().hasLabel('n').order().fold()",
    "g.V().hasLabel('n').fold().order(local)", "g.V().hasLabel('n').fold().range(local, 0, 1)", "g.V().hasLabel('n').fold().tail(local)",
    "g.V().hasLabel('n').map(identity()).fold()", "g.V().hasLabel('n').V().hasLabel('n').fold()", "g.inject(1).V().hasLabel('n').fold()",
    "g.V().hasLabel('n').choose(constant(true), fold(), fold())", "g.V().hasLabel('n').fold().as('a').select('a')",
    "g.V().hasLabel('n').fold().combine(V().hasLabel('n').fold())", "g.V().hasLabel('n').fold().unfold()",
    "g.V().hasLabel('n').group().by(label).by(fold())", "g.V().hasLabel('n').as('a').outE().as('b').select('a', 'b')",
    "g.V().hasLabel('n').project('a').by(identity())",
  ]) test(q, async () => {
    const binary = fromBinary(await decodeAll(executeQuery(store, q)));
    const text = await executor.jsonAsync(q, {});
    expect(text).not.toBeNull();
    expect(text!).not.toMatch(/\dp-?\d/); // no wire carrier reaches a reader
    expect(fromJson(JSON.parse(text!))).toEqual(binary);
    expect(JSON.stringify(binary)).toMatch(/1\.5e\+300|1e-300|5e-324/); // the comparison saw the values
  });

  test('parseElementJson decodes an already-parsed tree, and returns a carrier-free one unchanged', () => {
    const parsed = JSON.parse('[{"props":{"x":[{"t":"double","v":"1.0p640"}],"s":[{"t":"string","v":"1.0p640"}]}}]');
    const decoded = parseElementJson(parsed);
    expect(decoded[0].props.x[0].v).toBe(2 ** 640);
    expect(decoded[0].props.s[0].v).toBe('1.0p640');
    const plain = { x: [{ t: 'double', v: 1.5 }] };
    expect(parseElementJson(plain)).toBe(plain);
  });
});

// `asNumber()` over an UNTYPED number: its class is `numberClassOf`'s, as the reference GLV serializes it
// (`vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/structure/io/binary/internals/NumberSerializationStrategy.js:77-95`)
// — a whole number past 2^53 and a negative zero are Doubles, returned as is, and an overflow names Double
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:770,782`).
describe('asNumber over an untyped number', () => {
  const store = seededStore();
  for (const [x, want] of [[9.3e18, '9300000000000000000d'], [2 ** 53, '9007199254740992d'], [-0, '-0d'], [5, '5i'], [2 ** 40, '1099511627776L'], [1.5, '1.5d']] as const)
    test(`g.inject(${Object.is(x, -0) ? '-0' : x}).asNumber()`, () => {
      expect(typedAll(executeQuery(store, 'g.inject(x).asNumber()', { x }))).toEqual([want]);
    });
  for (const [x, gtype, target] of [[9.3e18, 'LONG', 'Long'], [2 ** 53, 'INT', 'Integer']] as const)
    test(`g.inject(${x}).asNumber(GType.${gtype}) names Double`, () => {
      expect(() => executeQuery(store, `g.inject(x).asNumber(GType.${gtype})`, { x }))
        .toThrow(`Can't convert number of type Double to ${target} due to overflow.`);
    });
});

// The bulk loader (`io()` read, a backup restore) lands its rows as ONE JSON text SQLite reads, so a scalar
// Double outside the exact range crosses as its exact pair (`binary64Cell`), and a load lands whole or not
// at all (`BulkLoader.flush` is one atomic unit).
describe('a GraphSON load carries every Double, or writes nothing', () => {
  test('our own dump reloads bit for bit', async () => {
    const source = seededStore();
    for (const x of EDGES) executeQuery(source, "g.addV('f').property('x', p)", { p: x }, { p: 'double' });
    executeQuery(source, "g.V(1).addE('f').to(V(2)).property('w', 1.5e-300d)");
    const target = new GraphStore(new BunSqlite(':memory:'));
    loadGraphson(target, writeGraphson(source));
    const values = (await decodeAll(executeQuery(target, "g.V().hasLabel('f').order().by(id)"))).map((v) => v.properties[0].value);
    expect(values.map(String)).toEqual(EDGES.map(String));
    expect((await decodeAll(executeQuery(target, "g.E().hasLabel('f')"))).map((e) => e.properties[0].value)).toEqual([1.5e-300]);
    expect(typedAll(executeQuery(target, "g.V().has('x', gt(1e300d)).count()"))).toEqual([`${EDGES.filter((x) => x > 1e300).length}L`]);
  });

  test('a collection holding one is refused before anything lands', () => {
    const doc = writeGraphson(seededStore()).replace('"name":[',
      '"zz":[{"id":{"@type":"g:Int64","@value":999},"value":{"@type":"g:List","@value":[{"@type":"g:Double","@value":1.5e300}]}}],"name":[');
    const target = new GraphStore(new BunSqlite(':memory:'));
    expect(() => loadGraphson(target, doc)).toThrow(INEXACT_DECIMAL);
    expect(typedAll(executeQuery(target, 'g.V().count()'))).toEqual(['0L']);
  });

  test('a batch that fails part-way leaves the graph as it was', () => {
    const target = new GraphStore(new BunSqlite(':memory:'));
    const line = '{"id":{"@type":"g:Int64","@value":1},"label":["a"],"outE":{"e":[{"id":{"@type":"g:Int64","@value":7},"inV":{"@type":"g:Int64","@value":99}}]}}';
    expect(() => loadGraphson(target, line)).toThrow('unknown vertex');
    expect(typedAll(executeQuery(target, 'g.V().count()'))).toEqual(['0L']);
  });
});
