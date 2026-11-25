// A Boolean in the untyped JSON response is JSON `true`/`false` — never the 1/0 SQLite stores it as.
// JSON has a native Boolean and Jackson writes one (`GraphSONSerializersV4`, NO_TYPES). The renderer
// reads the node's `boolean` TAG (the same tag GraphBinary frames from), so an untagged 0/1 stays a
// number and `inject(true, 1)` keeps the two apart. Every scalar leaf passes `untypedLeaf` and every
// scalar map key `scalarKey` (`src/untyped.ts`), so each position below is one of those two seams.
import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { makeRouter } from '../src/router.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import type { Http } from '../src/api.ts';

const JSON_MT = 'application/json';
const mgr = new BunGraphManager(undefined, extendedRegistry);
let http: Http;

beforeAll(async () => {
  for (const g of MODERN_SEED) await mgr.executor('g').framedAsync(g, {});
  await mgr.executor('g').framedAsync("g.V().has('name','marko').property('active', true)", {});
  await mgr.executor('g').framedAsync("g.V().has('name','marko').addE('k').to(V().has('name','josh')).property('w', false)", {});
  http = makeRouter(mgr);
});

/** POST a traversal (with optional parameters) and return the untyped JSON result array. */
async function json(gremlin: string, parameters?: Record<string, unknown>): Promise<unknown[]> {
  const res = await http(new Request('http://x/gremlin/g', {
    method: 'POST',
    headers: { 'Content-Type': JSON_MT, Accept: JSON_MT },
    body: JSON.stringify({ gremlin, ...(parameters ? { parameters } : {}) }),
  }));
  expect(res.headers.get('Content-Type')).toBe(JSON_MT);
  return (await res.json()) as unknown[];
}

const marko = "g.V().has('name','marko')";

describe('a Boolean renders as JSON true/false', () => {
  test('a stream value: inject, constant, a parameter, a choose arm', async () => {
    expect(await json('g.inject(true)')).toEqual([true]);
    expect(await json('g.inject(false)')).toEqual([false]);
    expect(await json('g.V().limit(1).constant(false)')).toEqual([false]);
    expect(await json('g.inject(x)', { x: true })).toEqual([true]);
    expect(await json('g.V().count().choose(is(gt(0)),constant(true),constant(false))')).toEqual([true]);
  });

  test('an untagged number stays a number: inject(true, 1) → [true, 1]', async () => {
    expect(await json('g.inject(true,1)')).toEqual([true, 1]);
  });

  test('a stored vertex property through values / valueMap / elementMap / properties / the vertex', async () => {
    expect(await json(`${marko}.values('active')`)).toEqual([true]);
    expect(await json(`${marko}.valueMap('active')`)).toEqual([{ active: [true] }]);
    expect(((await json(`${marko}.elementMap()`))[0] as any).active).toBe(true);
    expect(((await json(`${marko}.properties('active')`))[0] as any).value).toBe(true);
    expect(((await json(marko))[0] as any).properties.active).toEqual([{ value: true }]);
  });

  test('a stored edge property through valueMap / properties / the edge', async () => {
    expect(await json("g.E().has('w').valueMap()")).toEqual([{ w: false }]);
    expect(await json("g.E().has('w').properties()")).toEqual([{ key: 'w', value: false }]);
    expect(((await json("g.E().has('w')"))[0] as any).properties.w).toEqual([false]);
  });

  test('inside containers: a fold() list, a project() value, a nested child', async () => {
    expect(await json('g.inject(true).fold()')).toEqual([[true]]);
    expect(await json("g.V().limit(1).project('x').by(constant(true))")).toEqual([{ x: true }]);
    expect(await json(`${marko}.local(values('active').fold())`)).toEqual([[true]]);
    expect(await json(`${marko}.union(values('active'), constant(false)).fold()`)).toEqual([[true, false]]);
    expect(await json("g.inject(true).project('a').by(project('b').by(identity()))")).toEqual([{ a: { b: true } }]);
    expect(await json(`${marko}.as('a').values('active').as('b').select('a','b').by('name').by()`))
      .toEqual([{ a: 'marko', b: true }]);
  });

  test('a map key: groupCount by a Boolean keys "true"; Int 1 and Boolean true stay distinct', async () => {
    expect(await json('g.V().groupCount().by(constant(true))')).toEqual([{ true: 6 }]);
    expect(await json('g.inject(1,true).groupCount()')).toEqual([{ 1: 1, true: 1 }]);
    // The String "true" spells alike, so the map falls back to [key, value] entries and keeps both.
    expect(await json("g.inject(true,'true').groupCount()")).toEqual([[[true, 1], ['true', 1]]]);
  });
});
