// EVERY FINITE DOUBLE, through every text seam it crosses — the value, or its neighbour a last ulp away.
//
// Outside about [1e-80, 1e116] SQLite's decimal <-> binary64 conversion is not correctly rounded, so a Double
// there that crosses a JSON text inside SQLite (an element payload, a fold, a valueMap, a bulk load) may come
// back ONE ulp away. That is an accepted divergence (`docs/feature-support-matrix.md`): a value at an extreme
// magnitude a last ulp off is a sensible answer, a decline or a lost row is not. Pinned here:
//
// 1. every element-carrying and member-carrying shape ANSWERS beside such a value, within one ulp, and is
//    exact inside the range;
// 2. an UNTYPED number (a JSON request, a typeless client) is classed as the reference GLV classes it
//    (`numberClassOf`, `src/gremlin/types.ts`): a whole number past 2^53 is a Double, never a Long
//    (past 2^63 no Long exists, and every later read raised);
// 3. a bulk load lands whole or not at all.
import { test, expect, describe } from 'bun:test';
import { numberClassOf } from '../../src/gremlin/types.ts';
import { loadGraphson, writeGraphson } from '../../src/formats/graphson.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { seededStore } from '../support/harness.ts';
import { exec, executeQuery } from '../support/executor.ts';
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

const bitsOf = (x: number): bigint => { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, Math.abs(x)); return v.getBigInt64(0); };
/** How many representable doubles apart two same-signed doubles are (`Infinity` across a sign). */
const ulps = (a: number, b: number): number => {
  if (Object.is(a, b) || a === b) return 0;
  if (Math.sign(a) !== Math.sign(b)) return Infinity;
  const d = bitsOf(a) - bitsOf(b);
  return Number(d < 0n ? -d : d);
};
/** Inside [1e-80, 1e116] SQLite's decimal text is exact, so the value is; outside it, within one ulp. */
const INSIDE = (x: number): boolean => { const m = Math.abs(x); return m >= 1e-80 && m <= 1e116; };
const far = (got: readonly number[], want: readonly number[]): [number, number][] =>
  want.flatMap((x, i) => (ulps(got[i]!, x) > (INSIDE(x) ? 0 : 1) ? [[x, got[i]!] as [number, number]] : []));

const EDGES: readonly number[] = [
  Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE,
  2.2250738585072014e-308, 2.225073858507201e-308, // the smallest normal, the largest subnormal
  2 ** -1000, 2 ** -1000 * (1 - 2 ** -53), 2 ** 1000, 2 ** 1000 * (1 - 2 ** -53), // around the carrier's bands
  1e-190, 1.0000000000000002e-190, 9.999999999999999e-191, 2 ** -640, 2 ** 640, 2 ** -500, 2 ** 500,
  1e-81, 9.99999999999e-81, 2e116, 1.0000000000000002e116,
  1.5e300, 1.5e-300, 3.7430242338180544e203, -4.9406564584124654e-322,
];

describe('a stored Double outside the exact range reads back within one ulp', () => {
  const values = [...EDGES, ...bitPatternDoubles(400, 0x5eed)];

  test('g.V() — every vertex property, every value', async () => {
    const store = seededStore();
    const ids: number[] = [];
    for (const x of values) ids.push((await decodeAll(executeQuery(store, "g.addV('f').property('x', p).id()", { p: x }, { p: 'double' })))[0]);
    const byId = new Map<number, number>();
    for (const v of await decodeAll(executeQuery(store, "g.V().hasLabel('f')"))) byId.set(v.id, v.properties[0].value);
    expect(far(ids.map((id) => byId.get(id)!), values)).toEqual([]);
  }, 60_000); // ~425 sequential writes + a read: >5 s under the cored fan-out, so bun's 5 s default flakes

  test('g.E() — an edge property', async () => {
    const store = seededStore();
    for (const x of EDGES) executeQuery(store, "g.V(1).addE('f').to(V(2)).property('w', p)", { p: x }, { p: 'double' });
    const got = (await decodeAll(executeQuery(store, "g.E().hasLabel('f')"))).map((e) => e.properties[0].value);
    expect(far(got, EDGES)).toEqual([]);
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
    expect(ulps(prop.value, Number(q.match(/'x', ([^)]+)d\)/)![1]))).toBeLessThanOrEqual(1);
  });

  // One stored out-of-range property answers every element- and member-carrying shape — a top-level element,
  // a folded element, a grouped one, a path's, a projected one, a selected one, a folded value, a map.
  for (const q of [
    'g.V()', 'g.E()', 'g.V().fold()', 'g.V().group().by(label)', "g.V().has('x').path()",
    "g.V().has('x').project('a').by()", "g.V().has('x').as('a').select('a')", "g.V().has('x').values('x')",
    "g.V().has('x').properties()", "g.V().valueMap('name')", "g.V().has('x').values('x').fold()",
    "g.V().has('x').valueMap()", "g.V().has('x').elementMap()", "g.V().has('x').project('a').by(values('x'))",
  ]) test(`answers beside a 1e300d property: ${q}`, async () => {
    const store = seededStore();
    executeQuery(store, "g.addV('n').property('x', 1e300d)");
    expect((await decodeAll(executeQuery(store, q))).length).toBeGreaterThan(0);
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

// THE SAME ANSWER IN BOTH RESPONSE FORMATS. The untyped-JSON tail (`Accept: application/json`,
// `resolveJson` → `untyped.ts`) reads the element payload by its own route — a list column parsed
// whole — so each query below must read the same in both formats, at every depth an element list reaches.
describe('an out-of-range property reads the same through GraphBinary and untyped JSON', () => {
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
    expect(fromJson(JSON.parse(text!))).toEqual(binary);
    expect(JSON.stringify(binary)).toMatch(/e\+300|e-30[01]|e-324/); // the comparison saw the values
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

// The bulk loader (`io()` read, a backup restore) lands its rows as ONE JSON text SQLite reads — within one
// ulp outside the exact range — and a load lands whole or not at all (`BulkLoader.flush` is one atomic unit).
describe('a GraphSON load carries every Double, or writes nothing', () => {
  test('our own dump reloads every value', async () => {
    const source = seededStore();
    for (const x of EDGES) executeQuery(source, "g.addV('f').property('x', p)", { p: x }, { p: 'double' });
    executeQuery(source, "g.V(1).addE('f').to(V(2)).property('w', 1.5e-300d)");
    const target = new GraphStore(new BunSqlite(':memory:'));
    loadGraphson(target, writeGraphson(source));
    const values = (await decodeAll(executeQuery(target, "g.V().hasLabel('f').order().by(id)"))).map((v) => v.properties[0].value);
    expect(far(values, EDGES)).toEqual([]);
    const [w] = (await decodeAll(executeQuery(target, "g.E().hasLabel('f')"))).map((e) => e.properties[0].value);
    expect(ulps(w, 1.5e-300)).toBeLessThanOrEqual(1);
    expect(typedAll(executeQuery(target, "g.V().has('x', gt(1e300d)).count()"))).toEqual([`${EDGES.filter((x) => x > 1e300).length}L`]);
  });

  test('a collection holding one loads', async () => {
    const doc = writeGraphson(seededStore()).replace('"name":[',
      '"zz":[{"id":{"@type":"g:Int64","@value":999},"value":{"@type":"g:List","@value":[{"@type":"g:Double","@value":1.5e300}]}}],"name":[');
    const target = new GraphStore(new BunSqlite(':memory:'));
    loadGraphson(target, doc);
    const [list] = await decodeAll(executeQuery(target, "g.V().values('zz')"));
    expect(ulps(list[0], 1.5e300)).toBeLessThanOrEqual(1);
  });

  test('a batch that fails part-way leaves the graph as it was', () => {
    const target = new GraphStore(new BunSqlite(':memory:'));
    const line = '{"id":{"@type":"g:Int64","@value":1},"label":["a"],"outE":{"e":[{"id":{"@type":"g:Int64","@value":7},"inV":{"@type":"g:Int64","@value":99}}]}}';
    expect(() => loadGraphson(target, line)).toThrow('unknown vertex');
    expect(typedAll(executeQuery(target, 'g.V().count()'))).toEqual(['0L']);
  });
});
