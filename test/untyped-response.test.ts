// The content-negotiated UNTYPED-JSON data-plane response (`Accept: application/json`) — the readable
// form the browser docs "Test Request" panel shows. This asserts BOTH halves of the settled decision:
//   1. an opt-in JSON request renders a readable array WITH element properties (the whole reason this
//      renders from the decoded NODE TREE and not by decoding our GraphBinary back — the client's
//      element deserializers hardcode empty properties);
//   2. GraphBinary stays the DEFAULT and is BYTE-IDENTICAL to before — a MISSING `Accept` and an explicit
//      GraphBinary `Accept` both get the exact same bytes a stock GLV client always got (the safety line).
//
// The router path is exercised end to end (`makeRouter` over a `BunGraphManager`), so negotiation,
// fallback, and both verbs (POST + GET) are covered, not just the renderer in isolation.
import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { makeRouter } from '../src/router.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { ioc } from '../src/io.ts';
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

  test('a bulked result expands: the JSON array matches the flat GraphBinary multiset', async () => {
    // g.V().both() fans out and may RLE-collapse convergent traversers into (value, N) rows; the JSON
    // renderer expands the bulk exactly as the flat (un-bulked) GraphBinary frame does, so the two agree.
    const asJson = await jsonResults(await post('g.V().both()', JSON_MT));
    const asBinary = await binaryResults(await post('g.V().both()')); // default → flat, bulk-expanded
    expect(asJson.length).toBe(asBinary.length);
  });
});

describe('GraphBinary is the default and stays byte-identical', () => {
  test('a MISSING Accept → GraphBinary (stock GLV clients that omit Accept are never broken)', async () => {
    const data = await binaryResults(await post('g.V().count()')); // no Accept
    expect(data.map(Number)).toEqual([6]);
  });

  test('an explicit GraphBinary Accept → GraphBinary, and the bytes equal the no-Accept response', async () => {
    const bytesNoAccept = Buffer.from(await (await post('g.V()')).arrayBuffer());
    const bytesGb = Buffer.from(await (await post('g.V()', GRAPHBINARY_MT)).arrayBuffer());
    expect(bytesGb.equals(bytesNoAccept)).toBe(true); // byte-identical: the framing path is untouched
  });

  test('an Accept that lists BOTH json and graphbinary prefers GraphBinary (a GLV that also accepts json)', async () => {
    const res = await post('g.V().count()', `${JSON_MT}, ${GRAPHBINARY_MT}`);
    expect(res.headers.get('Content-Type')).toBe(GRAPHBINARY_MT);
  });

  test('a deferred result shape (path) with Accept: application/json FALLS BACK to GraphBinary', async () => {
    // `path` is not yet renderable as untyped JSON → resolveJson returns null → the router serves the
    // (unreadable-but-correct) GraphBinary response rather than a wrong JSON. Fail-closed.
    const res = await post('g.V().out().path()', JSON_MT);
    expect(res.headers.get('Content-Type')).toBe(GRAPHBINARY_MT);
  });
});

describe('the GET data plane negotiates the same way', () => {
  test('GET ?gremlin= with Accept: application/json → readable JSON', async () => {
    expect(await jsonResults(await get('g.V().count()', JSON_MT))).toEqual([6]);
  });

  test('GET ?gremlin= with no Accept → GraphBinary (byte-for-byte the POST default)', async () => {
    const data = await binaryResults(await get('g.V().count()'));
    expect(data.map(Number)).toEqual([6]);
  });
});
