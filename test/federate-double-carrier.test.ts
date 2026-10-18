// A FEDERATED READ OF A DOUBLE IS THE DIRECT READ OF IT — exact inside [1e-80, 1e116], within an ulp per hop outside.
//
// A barrier `call("federate")` lands the sibling's detached elements as ONE JSON text SQLite reads back
// (`src/compiler/rel/foreign.ts`), written by the one JSON writer of a text headed into SQLite (`stringifyExact`,
// `src/json-exact.ts`), so an `Infinity` lands as itself, never null (a `-0.0d` reads back `0.0` everywhere —
// a zero has no sign, as in SQLite). SQLite's decimal reader is not correctly rounded outside [1e-80, 1e116],
// so a value there may come back an ulp away per crossing — an accepted divergence (`docs/feature-support-matrix.md`):
// every tail ANSWERS, none declines.
//
// Both transports land through that one seam: the in-process `runForeign` (a sibling graph of the same
// manager) and the HTTP peer (`src/foreign-decode.ts`, the peer's own router as the client's transport).
import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { makeRouter } from '../src/router.ts';
import { UnsupportedTraversal } from '../src/compiler/unsupported.ts';
import { decode } from './support/decode.ts';

/** Finite non-zero doubles uniform over BIT PATTERNS, so every exponent (subnormals too) is as likely as any
 *  other — most of them outside the exact range. */
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

const NAMED: readonly number[] = [
  1.5e300, 4.9e-324, 3.7430242338180544e203, -1e-300, Number.MAX_VALUE, -Number.MIN_VALUE,
  2.2250738585072014e-308, 2 ** -1000, 2 ** 1000, 1e-190, 2 ** 640, 2 ** -500, 1e-81, 2e116,
  // exact everywhere (`Infinity` is lost by a bare `JSON.stringify`; `-0` reads back `0`, as SQLite's)
  -0, Infinity, -Infinity, 0.5, 1e-80, 1e116,
];
const VALUES = [...NAMED, ...bitPatternDoubles(300, 0xfed5)];
/** Inside [1e-80, 1e116] (and at zero and the infinities) SQLite's decimal text is exact. */
const hasExactDecimal = (x: number): boolean => { const m = Math.abs(x); return m === 0 || !Number.isFinite(m) || (m >= 1e-80 && m <= 1e116); };
const INSIDE = VALUES.filter(hasExactDecimal);

const peer = new BunGraphManager(undefined, extendedRegistry);
const local = new BunGraphManager(undefined, extendedRegistry, undefined, undefined, undefined, makeRouter(peer));
/** The two transports, each naming the sibling graph from `home`: in-process, and the HTTP peer. */
const TRANSPORTS = [
  { name: 'in-process', sibling: (g: string) => local.executor(g), graph: (g: string) => g },
  { name: 'HTTP', sibling: (g: string) => peer.executor(g), graph: (g: string) => `http://peer.example/gremlin/${g}` },
] as const;

const run = async (ex: { framedAsync: (g: string, p: Record<string, unknown>, t?: Record<string, any>) => Promise<{ buf: Buffer }[]> }, g: string, p: Record<string, unknown> = {}, t: Record<string, any> = {}) =>
  Promise.all((await ex.framedAsync(g, p, t)).map((f) => decode(f.buf)));
const fed = (graph: string, sub: string, tail = '') => `g.call("federate").with("graph","${graph}").with("traversal", ${sub})${tail}`;
/** Compare doubles exactly, order-free, over the two sorted spellings (a zero has no sign: `String(-0)` is `0`). */
const bits = (xs: readonly number[]): string[] => xs.map((x) => String(x)).sort();
const bitsOf = (x: number): bigint => { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, Math.abs(x)); return v.getBigInt64(0); };
/** Each value of `got` (sorted) is its `want` (sorted) — exactly inside the range, and outside it within one ulp
 *  per SQLite decimal crossing: the sibling's payload, then the landing, so two. */
const near = (got: readonly number[], want: readonly number[]): [number, number][] => {
  const g = [...got].sort((a, b) => a - b), w = [...want].sort((a, b) => a - b);
  if (g.length !== w.length) return [[g.length, w.length]];
  return w.flatMap((x, i) => {
    const y = g[i]!;
    if (x === y) return [];
    const d = Math.sign(x) === Math.sign(y) ? bitsOf(x) - bitsOf(y) : 1n << 62n;
    return (d < 0n ? -d : d) > (hasExactDecimal(x) ? 0n : 2n) ? [[x, y] as [number, number]] : [];
  });
};

beforeAll(async () => {
  for (const { sibling } of TRANSPORTS) {
    // `all`: every value; `inside`: only the values SQLite's decimal text carries exactly.
    for (const [g, xs] of [['all', VALUES], ['inside', INSIDE]] as const) {
      for (const [i, x] of xs.entries())
        await sibling(g).framedAsync("g.addV('n').property('i', i).property('x', x)", { i, x }, { i: 'int', x: 'double' });
      for (let i = 0; i + 1 < xs.length; i++)
        await sibling(g).framedAsync("g.V().has('i', a).addE('e').to(V().has('i', b)).property('w', w)", { a: i, b: i + 1, w: xs[i] }, { a: 'int', b: 'int', w: 'double' });
    }
  }
  await local.executor('home').framedAsync("g.addV('h')", {});
}, 120_000); // ~1,250 sequential writes per transport

const vertexXs = (vs: any[]): number[] => vs.map((v) => v.properties.find((p: any) => p.label === 'x').value);
const edgeWs = (es: any[]): number[] => es.map((e) => e.properties.find((p: any) => p.key === 'w').value);

for (const t of TRANSPORTS) {
  describe(`federate over ${t.name}: a federated Double is the direct one`, () => {
    test('the direct read (the oracle)', async () => {
      expect(near(vertexXs(await run(t.sibling('all'), 'g.V()')), VALUES)).toEqual([]);
    });

    test('a bare resume carries EVERY value — vertices and edges, source and mid-traversal form', async () => {
      const graph = t.graph('all');
      expect(near(vertexXs(await run(local.executor('home'), fed(graph, '__.V()'))), VALUES)).toEqual([]);
      expect(near(edgeWs(await run(local.executor('home'), fed(graph, '__.E()'))), VALUES.slice(0, -1))).toEqual([]);
      const mid = `g.V().call("federate").with("graph","${graph}").with("traversal", __.V())`;
      expect(near(vertexXs(await run(local.executor('home'), mid)), VALUES)).toEqual([]);
    }, 30_000);

    test('a local tail over in-range values answers the direct values bit for bit', async () => {
      const graph = t.graph('inside');
      const direct = await run(t.sibling('inside'), 'g.V().values("x")');
      expect(bits(direct)).toEqual(bits(INSIDE));
      expect(bits(await run(local.executor('home'), fed(graph, '__.V()', '.values("x")')))).toEqual(bits(direct));
      expect(bits(await run(local.executor('home'), fed(graph, '__.E()', '.values("w")')))).toEqual(bits(INSIDE.slice(0, -1)));
      const sum = await run(local.executor('home'), fed(graph, '__.V().has("i", 0)', '.values("x").sum()'));
      expect(bits(sum)).toEqual(bits(await run(t.sibling('inside'), 'g.V().has("i", 0).values("x").sum()')));
    }, 30_000);

    // Every tail that reads the landing in SQL, at several depths, ANSWERS — within an ulp per crossing of the stored value.
    test('a local tail over an out-of-range landing answers', async () => {
      const graph = t.graph('all');
      expect(near(await run(local.executor('home'), fed(graph, '__.V()', '.values("x")')), VALUES)).toEqual([]);
      expect(near(await run(local.executor('home'), fed(graph, '__.E()', '.values("w")')), VALUES.slice(0, -1))).toEqual([]);
      const one = await run(local.executor('home'), fed(graph, '__.V().has("i", 0)', '.values("x").sum()'));
      expect(near(one, [VALUES[0]!])).toEqual([]);
      for (const tail of ['.label()', '.count()', '.local(__.values("x"))', '.union(__.values("x"), __.values("x"))', '.where(__.values("x").is(gt(0d)))'])
        // A step this resume has no lowering for declines on its own (structurally, whatever the data);
        // every other tail answers.
        await run(local.executor('home'), fed(graph, '__.V().has("i", 0)', tail)).then(
          (answer) => expect(answer.length).toBeGreaterThan(0),
          (error: unknown) => expect(error).toBeInstanceOf(UnsupportedTraversal));
      const walk = `g.call("federate").with("graph","${graph}").with("subgraph", true).with("traversal", __.E().has("w", gt(1e300d))).outV().values("x")`;
      expect((await run(local.executor('home'), walk)).length).toBeGreaterThan(0);
    }, 30_000);
  });
}

// THE TWO TRANSPORTS LAND ONE LEAF FORM. The HTTP decoder (`src/foreign-decode.ts`) used to hand back the
// GraphBinary client's JS carriers — a `bigint` for every BigInteger and every Long past 2^53, a `BigDecimal`,
// a `Date` — where the in-process `runForeign` hands back the stored leaf form (`leafStore`,
// `src/gremlin/types.ts`). The landing writes ONE JSON text, so EVERY HTTP federate over a sibling holding
// any such value raised the raw `TypeError: JSON.stringify cannot serialize BigInt.`. Each value-bearing
// shape, at several depths, must equal the sibling's direct read — over both transports.
describe('federate: a BigInteger / BigDecimal / wide Long / datetime / duration sibling reads as the direct one', () => {
  const ADD = `g.addV('n').property('x', 5n).property('b', 12345678901234567890123n).property('y', 1.5m).property('z', 1.10m)
    .property('l', 9007199254740993L).property('dt', datetime('2023-01-02T03:04:05.678Z')).property('du', Duration(5, 7))
    .property('li', [3n, 1.5m, 9007199254740993L]).property('m', [a: 1n, (2L): 1.5m]).property('bo', true)`;
  const EDGE = "g.V().addE('e').to(V()).property('w', 3n).property('d', 2.5m).property('l', 9007199254740993L)";
  beforeAll(async () => {
    for (const { sibling } of TRANSPORTS) { await sibling('wide').framedAsync(ADD, {}); await sibling('wide').framedAsync(EDGE, {}); }
  });
  // [the federated traversal, the local tail after it, the same question asked of the sibling directly]
  const CASES: readonly [string, string, string][] = [
    ['__.V()', '', 'g.V()'],
    ['__.E()', '', 'g.E()'],
    ['__.V().values("x")', '', 'g.V().values("x")'],
    ['__.V().values()', '', 'g.V().values()'],
    ['__.V().values("x").fold()', '', 'g.V().values("x").fold()'],
    ['__.V().valueMap()', '', 'g.V().valueMap()'],
    ['__.V().values("l").max()', '', 'g.V().values("l").max()'],
    ['__.V()', '.values()', 'g.V().values()'],
    ['__.V()', '.values("b")', 'g.V().values("b")'],
    ['__.V()', '.values("y")', 'g.V().values("y")'],
    ['__.V()', '.values("dt")', 'g.V().values("dt")'],
    ['__.V()', '.values("du")', 'g.V().values("du")'],
    ['__.V()', '.values("m")', 'g.V().values("m")'],
    ['__.V()', '.values("l").max()', 'g.V().values("l").max()'],
    ['__.V()', '.values("x").sum()', 'g.V().values("x").sum()'],
    ['__.E()', '.values()', 'g.E().values()'],
  ];
  for (const t of TRANSPORTS) {
    for (const [sub, tail, direct] of CASES) {
      test(`${t.name}: ${sub}${tail}`, async () => {
        // A multiset: neither side orders its stream, so each comes back in its own plan's order.
        const bag = (xs: unknown[]) => xs.map((x) => [Bun.inspect(x), x] as const).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, x]) => x);
        const oracle = bag(await run(t.sibling('wide'), direct));
        expect(bag(await run(local.executor('home'), fed(t.graph('wide'), sub, tail)))).toEqual(oracle);
      });
    }
    test(`${t.name}: the subgraph walk and the mid-traversal rejoin`, async () => {
      const sub = `g.call("federate").with("graph","${t.graph('wide')}").with("subgraph", true).with("traversal", __.E()).outV().values("b")`;
      expect(await run(local.executor('home'), sub)).toEqual([12345678901234567890123n]);
      const mid = `g.V().call("federate").with("graph","${t.graph('wide')}").with("traversal", __.V())`;
      expect(await run(local.executor('home'), mid)).toEqual(await run(t.sibling('wide'), 'g.V()'));
    });
  }
  // What the HTTP decoder has no leaf form for is a DECLINE, never a defect.
  test('HTTP: an undecodable peer type (elementMap\'s T keys) declines', async () => {
    await expect(run(local.executor('home'), fed(TRANSPORTS[1].graph('wide'), '__.V().elementMap()'))).rejects.toThrow(UnsupportedTraversal);
  });
});
