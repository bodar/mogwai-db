// A FEDERATED READ OF A DOUBLE IS THE DIRECT READ OF IT — bit for bit, or a deferral, never another number.
//
// A barrier `call("federate")` lands the sibling's detached elements as ONE JSON text SQLite reads back
// (`src/compiler/rel/foreign.ts`). That text used to be a bare `JSON.stringify`, and SQLite's decimal reader is
// not correctly rounded outside [1e-80, 1e116] (`src/rel/exact-decimal.ts`): a sibling storing `1.5e300d`
// answered 1.4999999999999998E300 through `….values("x")`, an edge's `-1e-300d` -9.999999999999999E-301,
// a `-0.0d` lost its sign and an `Infinity` became null. The landing now goes through the one exact JSON
// writer (`stringifyExact`, `src/json-exact.ts`), so:
//
// 1. a resume with NO local tail (only the framer reads the landed payload) carries every binary64 exactly,
//    an out-of-range one as the wire carrier a native element payload holds (`binary64Carrier`);
// 2. a resume with a local tail answers exactly inside the range, and DEFERS (`RaisedByQuery`,
//    `INEXACT_DECIMAL`) for a landing holding a Double outside it — never a rounding. The deferral is per
//    LANDING, not per read: any tail may read `props` in SQL, so even a `label()` tail defers (a stopgap —
//    carrying the value into the bound readers is the open item).
//
// Both transports land through that one seam: the in-process `runForeign` (a sibling graph of the same
// manager) and the HTTP peer (`src/foreign-decode.ts`, the peer's own router as the client's transport).
import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { makeRouter } from '../src/router.ts';
import { RaisedByQuery } from '../src/rel/raise.ts';
import { UnsupportedTraversal } from '../src/compiler/unsupported.ts';
import { hasExactDecimal, INEXACT_DECIMAL } from '../src/rel/exact-decimal.ts';
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
  // exact everywhere, and each lost by a bare `JSON.stringify` (`-0` → `0`, `Infinity` → `null`)
  -0, Infinity, -Infinity, 0.5, 1e-80, 1e116,
];
const VALUES = [...NAMED, ...bitPatternDoubles(300, 0xfed5)];
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
/** Compare doubles by bit pattern, order-free: `Object.is` per member of the two sorted spellings. */
const bits = (xs: readonly number[]): string[] => xs.map((x) => (Object.is(x, -0) ? '-0' : String(x))).sort();

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
    test('the direct read is exact (the oracle)', async () => {
      expect(bits(vertexXs(await run(t.sibling('all'), 'g.V()')))).toEqual(bits(VALUES));
    });

    test('a bare resume carries EVERY value exactly — vertices and edges, source and mid-traversal form', async () => {
      const graph = t.graph('all');
      expect(bits(vertexXs(await run(local.executor('home'), fed(graph, '__.V()'))))).toEqual(bits(VALUES));
      expect(bits(edgeWs(await run(local.executor('home'), fed(graph, '__.E()'))))).toEqual(bits(VALUES.slice(0, -1)));
      const mid = `g.V().call("federate").with("graph","${graph}").with("traversal", __.V())`;
      expect(bits(vertexXs(await run(local.executor('home'), mid)))).toEqual(bits(VALUES));
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

    // Every tail that reads the landing in SQL, at several depths: a deferral, never a rounded answer.
    for (const tail of ['.values("x")', '.values()', '.values("x").sum()', '.values("x").fold()', '.label()',
      '.local(__.values("x"))', '.union(__.values("x"), __.values("x"))', '.where(__.values("x").is(gt(0d)))']) {
      test(`a local tail over an out-of-range landing defers: ${tail}`, async () => {
        const settled = await run(local.executor('home'), fed(t.graph('all'), '__.V().has("i", 0)', tail)).then(
          (answer) => ({ answer }), (error: unknown) => ({ error }));
        if ('answer' in settled) throw new Error(`answered ${JSON.stringify(settled.answer)} over a landed 1.5e300d`);
        expect(settled.error).toBeInstanceOf(Error);
        // A step this resume has no lowering for declines on its own; any value read defers on the carrier.
        if (settled.error instanceof RaisedByQuery) expect(settled.error.message).toBe(INEXACT_DECIMAL);
        else expect((settled.error as Error).constructor.name).toBe('UnsupportedTraversal');
      });
    }

    test('an edge tail and a subgraph walk over an out-of-range landing defer', async () => {
      for (const q of [
        fed(t.graph('all'), '__.E().limit(1)', '.values("w")'),
        `g.call("federate").with("graph","${t.graph('all')}").with("subgraph", true).with("traversal", __.E().limit(1)).outV().values("x")`,
      ]) await expect(run(local.executor('home'), q)).rejects.toThrow(INEXACT_DECIMAL);
    });
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
        const oracle = await run(t.sibling('wide'), direct);
        expect(await run(local.executor('home'), fed(t.graph('wide'), sub, tail))).toEqual(oracle);
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
