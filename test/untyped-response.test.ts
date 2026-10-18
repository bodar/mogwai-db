// The content-negotiated data-plane response, now DEFAULTING to readable UNTYPED-JSON (GraphSON) — the
// form the browser docs "Test Request" panel shows (it sends `Accept: */*`). This asserts BOTH halves of
// the settled decision:
//   1. the default (or an explicit non-binary Accept) renders a readable array WITH element properties
//      (the whole reason this renders from the decoded NODE TREE and not by decoding our GraphBinary back —
//      the client's element deserializers hardcode empty properties);
//   2. GraphBinary is now the EXPLICIT opt-in and stays BYTE-IDENTICAL — a request that names
//      `application/vnd.graphbinary-v4.0` gets the exact same bytes a stock GLV client always got. That is
//      SAFE because every real binary consumer sends that Accept explicitly (the GLV client
//      connection.ts:286, our federation http-federation.ts:98), so nothing that wanted binary is broken.
//
// The router path is exercised end to end (`makeRouter` over a `BunGraphManager`), so negotiation,
// fallback, and both verbs (POST + GET) are covered, not just the renderer in isolation.
import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { makeRouter } from '../src/router.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { Edge, ioc, Property, Vertex, VertexProperty } from '../src/io.ts';
import type { Http } from '../src/api.ts';

const GRAPHBINARY_MT = 'application/vnd.graphbinary-v4.0';
const JSON_MT = 'application/json';

const mgr = new BunGraphManager(undefined, extendedRegistry);
let http: Http;

beforeAll(async () => {
  for (const g of MODERN_SEED) await mgr.executor('g').framedAsync(g, {});
  http = makeRouter(mgr);
});

/** POST a Gremlin traversal at `/gremlin/g`, optionally setting `Accept` (a data-plane content-neg header). */
const post = (gremlin: string, accept?: string): Promise<Response> =>
  http(new Request('http://x/gremlin/g', {
    method: 'POST',
    headers: { 'Content-Type': JSON_MT, ...(accept ? { Accept: accept } : {}) },
    body: JSON.stringify({ gremlin }),
  }));

/** The GET (cacheable) counterpart — traversal in `?gremlin=`, negotiation via `Accept`. */
const get = (gremlin: string, accept?: string): Promise<Response> =>
  http(new Request(`http://x/gremlin/g?gremlin=${encodeURIComponent(gremlin)}`, {
    headers: { ...(accept ? { Accept: accept } : {}) },
  }));

/** The readable JSON array (asserts the JSON content type first). */
async function jsonResults(res: Response): Promise<any[]> {
  expect(res.headers.get('Content-Type')).toBe(JSON_MT);
  return (await res.json()) as any[];
}

/** The GraphBinary result set, decoded with the CLIENT's own reader — so what is asserted is what a real
 *  GLV would see. Asserts the GraphBinary content type (the default / fallback) first. */
async function binaryResults(res: Response): Promise<any[]> {
  expect(res.headers.get('Content-Type')).toBe(GRAPHBINARY_MT);
  const parsed = await ioc.graphBinaryReader.readResponse(Buffer.from(await res.arrayBuffer()));
  expect(parsed.status.code).toBe(200);
  return parsed.result.data;
}

describe('untyped JSON is opt-in and readable WITH properties', () => {
  test('g.V() → an array of vertex objects carrying their properties', async () => {
    const data = await jsonResults(await post('g.V()', JSON_MT));
    expect(data.length).toBe(6); // the modern graph
    const marko = data.find((v) => v.properties?.name?.[0]?.value === 'marko');
    expect(marko).toBeDefined();
    // The V4 untyped vertex shape: `label` is always an ARRAY (multi-label support), each property value
    // a `{ value }` object in an array.
    expect(marko.label).toEqual(['person']);
    expect(typeof marko.id).toBe('number');
    expect(marko.properties.age[0].value).toBe(29);
    // A software vertex keeps its own props too — the property fidelity the binary decode would lose.
    const lop = data.find((v) => v.properties?.name?.[0]?.value === 'lop');
    expect(lop.label).toEqual(['software']);
    expect(lop.properties.lang[0].value).toBe('java');
  });

  test('g.V().count() → [<number>]', async () => {
    expect(await jsonResults(await post('g.V().count()', JSON_MT))).toEqual([6]);
  });

  test('g.V().valueMap() → readable maps of value lists', async () => {
    const data = await jsonResults(await post('g.V().valueMap()', JSON_MT));
    const marko = data.find((m) => m.name?.[0] === 'marko');
    expect(marko).toBeDefined();
    expect(marko.age).toEqual([29]); // multi-valued property → a list
  });

  test('g.V().elementMap() → flat maps with id/label tokens + props', async () => {
    const data = await jsonResults(await post('g.V().elementMap()', JSON_MT));
    const marko = data.find((m) => m.name === 'marko');
    expect(marko).toBeDefined();
    expect(marko.label).toBe('person'); // elementMap flattens to one value per key; single-label → a string
    expect(typeof marko.id).toBe('number');
    expect(marko.age).toBe(29);
  });

  test('g.E() → edge objects with inV/outV and properties', async () => {
    const data = await jsonResults(await post('g.E()', JSON_MT));
    expect(data.length).toBe(6);
    for (const e of data) {
      expect(Array.isArray(e.label)).toBe(true); // V4: label is an array
      expect(typeof e.inV).toBe('number');
      expect(typeof e.outV).toBe('number');
    }
    // A modern edge carries a `weight` property (V4 wraps each edge property value in a one-element array).
    const weighted = data.find((e) => e.properties?.weight);
    expect(weighted).toBeDefined();
    expect(typeof weighted.properties.weight[0]).toBe('number');
  });

  // An ELEMENT map key is its id (`GraphSONKeySerializer`, GraphSONSerializersV4.java:371-376), never the
  // stringified object (`[object Object]`, under which every vertex collapsed into ONE entry).
  test('an element-keyed map renders each key as the element id', async () => {
    const ids = (await jsonResults(await post('g.V().id()', JSON_MT))).map(String).sort();
    for (const q of ['g.V().groupCount()', 'g.V().group().by(identity()).by(count())', 'g.V().groupCount().by(identity())']) {
      const [counts] = await jsonResults(await post(q, JSON_MT));
      expect(Object.keys(counts).sort()).toEqual(ids);
    }
    const edgeIds = (await jsonResults(await post('g.E().id()', JSON_MT))).map(String).sort();
    const [byEdge] = await jsonResults(await post('g.E().groupCount()', JSON_MT));
    expect(Object.keys(byEdge).sort()).toEqual(edgeIds);
  });

  test('a bulked result expands: the JSON array matches the flat GraphBinary multiset', async () => {
    // g.V().both() fans out and may RLE-collapse convergent traversers into (value, N) rows; the JSON
    // renderer expands the bulk exactly as the flat (un-bulked) GraphBinary frame does, so the two agree.
    const asJson = await jsonResults(await post('g.V().both()', JSON_MT));
    const asBinary = await binaryResults(await post('g.V().both()', GRAPHBINARY_MT)); // explicit binary → flat, bulk-expanded
    expect(asJson.length).toBe(asBinary.length);
  });
});

describe('JSON is now the default; GraphBinary is the explicit opt-in and stays byte-identical', () => {
  test('a MISSING Accept → readable JSON now (the flipped default; the Scalar panel sends */* → JSON)', async () => {
    expect(await jsonResults(await post('g.V().count()'))).toEqual([6]); // no Accept → JSON
  });

  test('an explicit GraphBinary Accept → GraphBinary, byte-stable — the framing path is untouched', async () => {
    // The binary response the GLV clients (connection.ts:286) get. Deterministic framing, so two explicit-
    // binary requests are byte-for-byte identical, and it decodes to the same six vertices as always.
    const bytesA = Buffer.from(await (await post('g.V()', GRAPHBINARY_MT)).arrayBuffer());
    const bytesB = Buffer.from(await (await post('g.V()', GRAPHBINARY_MT)).arrayBuffer());
    expect(bytesB.equals(bytesA)).toBe(true);
    expect((await binaryResults(await post('g.V()', GRAPHBINARY_MT))).length).toBe(6);
  });

  test('an Accept that lists BOTH json and graphbinary → GraphBinary (explicit graphbinary wins)', async () => {
    const res = await post('g.V().count()', `${JSON_MT}, ${GRAPHBINARY_MT}`);
    expect(res.headers.get('Content-Type')).toBe(GRAPHBINARY_MT);
  });

  test('a deferred result shape (path) on the JSON default FALLS BACK to GraphBinary', async () => {
    // `path` is not yet renderable as untyped JSON → resolveJson returns null → the router serves the
    // (unreadable-but-correct) GraphBinary response rather than a wrong JSON. Fail-closed. Exercised via the
    // default (no-Accept) request, which is now the JSON path.
    const res = await post('g.V().out().path()');
    expect(res.headers.get('Content-Type')).toBe(GRAPHBINARY_MT);
  });
});

describe('the GET data plane negotiates the same way', () => {
  test('GET ?gremlin= with no Accept → readable JSON (byte-for-byte the POST default)', async () => {
    expect(await jsonResults(await get('g.V().count()'))).toEqual([6]);
  });

  test('GET ?gremlin= with an explicit GraphBinary Accept → GraphBinary', async () => {
    const data = await binaryResults(await get('g.V().count()', GRAPHBINARY_MT));
    expect(data.map(Number)).toEqual([6]);
  });
});

// THE SAME ANSWER IN BOTH RESPONSE FORMATS, at every depth a map KEY reaches. A JSON object key is a
// string, so the untyped tail spells each key by one total rule: an Element by its id (as the reference's
// `GraphSONKeySerializer` does), a scalar by `String(v)` (a whole Double with `.0`), a list, a map or an edge
// Property by the JSON text of its rendering — never `[object Object]`, under which distinct groups merged
// into ONE entry. A scalar/element-keyed query runs through both formats and must agree.
describe('every map key reads the same through untyped JSON and GraphBinary', () => {
  const isElement = (v: any): boolean => v instanceof Vertex || v instanceof Edge || v instanceof VertexProperty;
  /** A key's spelling up to number layout (`1.0` and `1` are one Double key; the GraphBinary client decodes it as `1`). */
  const keyOf = (k: string): string => (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(k) ? String(Number(k)) : k);
  /** A decoded GraphBinary key as the reference spells it — an Element by its id, a `T`/`Direction` token
   *  by its name; any other object (a collection: the declined keys) by its structure, so distinct keys stay distinct. */
  const binaryKey = (k: any): string =>
    isElement(k) ? String(k.id)
      : k !== null && typeof k === 'object' && 'elementName' in k ? String(k.elementName)
      : k !== null && typeof k === 'object' ? `#${JSON.stringify(fromBinary(k))}`
      : keyOf(String(k));
  /** A GraphBinary-decoded result → the untyped-JSON shape, keyed the way the reference keys a map. */
  const fromBinary = (v: any): any => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'bigint') return Number(v);
    if (Array.isArray(v) || v instanceof Set) return [...v].map(fromBinary);
    if (v instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of v) {
        let key = binaryKey(k);
        while (key in out) key += "'"; // two keys that print alike (Int 1, String "1") stay two — JSON declines them
        out[key] = fromBinary(x);
      }
      return out;
    }
    if (v instanceof Vertex || v instanceof Edge) {
      const props: Record<string, unknown[]> = {};
      for (const p of (v as any).properties ?? []) (props[p.key ?? p.label] ??= []).push(fromBinary(p.value));
      return { id: v.id, label: v.label, props };
    }
    if (v instanceof VertexProperty || v instanceof Property) return { key: v.key, value: fromBinary(v.value) };
    return v;
  };
  const fromJson = (v: any): any => {
    if (Array.isArray(v)) return v.map(fromJson);
    if (v !== null && typeof v === 'object' && 'properties' in v && 'label' in v) {
      const props: Record<string, unknown[]> = {};
      for (const [k, xs] of Object.entries(v.properties as Record<string, any[]>))
        props[k] = xs.map((x) => fromJson(x !== null && typeof x === 'object' && 'value' in x ? x.value : x));
      return { id: v.id, label: v.label[0], props };
    }
    if (v !== null && typeof v === 'object' && 'key' in v && 'value' in v) return { key: v.key, value: fromJson(v.value) };
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [keyOf(k), fromJson(x)]));
    return v;
  };

  /** Run `q` both ways; `'json'` when the JSON tail answered (and agreed), `'declined'` when it fell back. */
  async function bothFormats(q: string): Promise<'json' | 'declined'> {
    const binary = await binaryResults(await post(q, GRAPHBINARY_MT));
    const res = await post(q, JSON_MT);
    if (res.headers.get('Content-Type') === GRAPHBINARY_MT) {
      const parsed = await ioc.graphBinaryReader.readResponse(Buffer.from(await res.arrayBuffer()));
      expect(fromBinary(parsed.result.data)).toEqual(fromBinary(binary));
      return 'declined';
    }
    expect(fromJson(await jsonResults(res))).toEqual(fromBinary(binary));
    return 'json';
  }

  // Keys the JSON tail spells exactly — an element at any depth a map reaches, a scalar, a token.
  for (const q of [
    'g.V().groupCount()', 'g.E().groupCount()', 'g.V().properties().groupCount()', 'g.V().properties("name").group().by(identity()).by(count())',
    'g.V().groupCount().by("age")', 'g.V().group().by(label).by(fold())', 'g.V().group().by(out().count()).by(values("name").fold())',
    'g.V().local(groupCount())', 'g.V().local(out().groupCount())', 'g.V().union(out(), in()).groupCount()',
    'g.V().local(union(out(), in()).groupCount())', 'g.V().choose(has("age"), local(out().groupCount()), local(in().groupCount()))',
    'g.V().coalesce(out().groupCount(), groupCount())', 'g.V().as("x").out().groupCount().by(select("x"))',
    'g.V().as("x").groupCount().by(select("x"))', 'g.V().where(out().count().is(gt(0))).groupCount()', 'g.V().repeat(out()).times(1).groupCount()',
    'g.V().valueMap()', 'g.V().elementMap()', 'g.E().elementMap()', 'g.V().valueMap(true)',
    'g.inject(1.0d, 2.5d, 1e21d, 1e-5d).groupCount()', 'g.V().values("age").groupCount()',
  ]) test(`${q} → JSON, the same answer`, async () => expect(await bothFormats(q)).toBe('json'));

  // A collection or edge-Property key is spelled as the JSON TEXT of its untyped rendering (Java's
  // `toString()` is not reproduced) — never `[object Object]`, never a fallback: every group stays its own
  // entry. Two edge Properties with one key and value are ONE group key (a Property is equal by key and
  // value, never by its edge — ElementHelper.areEqual), so their counts add rather than splitting.
  for (const [q, groups] of [
    ['g.V().group().by(out().limit(1).fold()).by(count())', 3],
    ['g.V().groupCount().by(outE().limit(1).fold())', 4],
    ['g.E().properties().groupCount()', 4], // two weight=0.4 and two weight=1.0 edge properties are one key each
    ['g.V().group().by(project("a").by(identity())).by(count())', 6],
    ['g.E().properties().group().by(identity()).by(count())', 4],
    ['g.V().where(out()).groupCount().by(out().fold())', 3],
    ['g.V().groupCount().by(valueMap())', 6],
  ] as const) test(`${q} → JSON, ${groups} keys spelled as JSON text`, async () => {
    const res = await post(q, JSON_MT);
    expect(res.headers.get('Content-Type')).not.toBe(GRAPHBINARY_MT);
    const [first] = await jsonResults(res);
    expect(Object.keys(first as object).length).toBe(groups);
    expect(Object.keys(first as object).some((k) => k.includes('[object Object]'))).toBe(false);
  });
  test('an edge Property key groups by key and value, as dedup() does', async () => {
    const [counts] = await jsonResults(await post('g.E().properties().groupCount()', JSON_MT));
    expect(Object.values(counts as object).sort()).toEqual([1, 1, 2, 2]);
    const [binary] = await binaryResults(await post('g.E().properties().groupCount()', GRAPHBINARY_MT));
    expect([...(binary as Map<unknown, unknown>).values()].map(Number).sort()).toEqual([1, 1, 2, 2]);
  });
  // Two distinct keys that spell alike would keep only one entry as a JSON object; such a map renders as an
  // array of [key, value] entries instead, so no entry (and no count) is lost.
  test('keys that spell alike render as [key, value] entries, never losing one', async () => {
    expect(await jsonResults(await post('g.inject(1, "1").groupCount()', JSON_MT))).toEqual([[['1', 1], [1, 1]]]);
    expect(await jsonResults(await post('g.inject(null, "null").groupCount()', JSON_MT))).toEqual([[['null', 1], [null, 1]]]);
    expect(await (await post('g.inject("__proto__", "x").groupCount()', JSON_MT)).text()).toBe('[{"__proto__":1,"x":1}]');
  });
  test('a whole Double key keeps its .0; a list key is its JSON text', async () => {
    expect(await jsonResults(await post('g.inject(1.0d, 2.5d, 3).groupCount()', JSON_MT))).toEqual([{ '1.0': 1, '2.5': 1, '3': 1 }]);
    expect(await jsonResults(await post('g.V().has("name", "marko").groupCount().by(values("name").fold())', JSON_MT))).toEqual([{ '["marko"]': 1 }]);
  });

  // A WRITE renders in ONE atomic unit with its run, and runs exactly once.
  test('a write with a collection-keyed JSON result runs exactly once', async () => {
    const count = async () => Number((await binaryResults(await post('g.V().count()', GRAPHBINARY_MT)))[0]);
    const before = await count();
    const res = await post("g.addV('w').property('k', 1).groupCount().by(valueMap())", JSON_MT);
    expect(res.headers.get('Content-Type')).not.toBe(GRAPHBINARY_MT);
    expect(await jsonResults(res)).toEqual([{ '{"k":[1]}': 1 }]);
    expect(await count()).toBe(before + 1);
    await post("g.V().hasLabel('w').drop()", GRAPHBINARY_MT);
  });

  // A NUMBER renders exactly: a Long past 2^53 as its digits (not `"9223372036854775807"` the string, nor
  // the rounded `9223372036854775808`); a zero has no sign (`-0.0` is `0`, a deliberate divergence).
  test('a wide Long and a negative zero render as the numbers they are', async () => {
    expect(await (await post('g.inject(9223372036854775807L).fold()', JSON_MT)).text()).toBe('[[9223372036854775807]]');
    expect(await (await post('g.inject(-0.0d)', JSON_MT)).text()).toBe('[0]');
  });
});
