import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { decode } from './support/decode.ts';

// End-to-end for the `reverse()` value-transform BARRIER (substrate A). SQLite has no `reverse`
// scalar function; the shape it CAN be given — a per-row recursive CTE — was large, slow and
// string-only, so top-level scalar reverse lowers instead as a SYNC barrier (`compiler/rel/reverse.ts`):
// the head is the value stream up to reverse, the JS map reverses each value, and the survivors
// re-inject as one `json_each` bind seeding the resumed stream (`lowerValueResume`). The LIST/path form
// keeps its own list-order path (`list.ts`); a NESTED scalar reverse is a fail-closed deferral (a
// barrier cannot segment a child body).

const mgr = new BunGraphManager(undefined, extendedRegistry);
const dec = (f: { buf: Buffer }) => decode(f.buf);
const run = async (g: string) => await Promise.all((await mgr.executor('home').framedAsync(g, {})).map(dec));

beforeAll(async () => {
  for (const g of MODERN_SEED) await mgr.executor('home').framedAsync(g, {});
});

describe('reverse() — scalar barrier', () => {
  test('reverses each string value', async () => {
    expect((await run('g.V().hasLabel("person").values("name").reverse()')).sort())
      .toEqual(['hsoj', 'okram', 'retep', 'sadav']);
  });
  test('is IDENTITY for non-strings (ReverseStep passes numbers through)', async () => {
    expect((await run('g.V().values("age").reverse()')).sort()).toEqual([27, 29, 32, 35]);
  });
  test('null passes through', async () => {
    expect(await run('g.inject(null).reverse()')).toEqual([null]);
  });
  test('a single multi-value inject (stream order preserved)', async () => {
    expect(await run('g.inject("feature", "test one", null).reverse()'))
      .toEqual(['erutaef', 'eno tset', null]);
  });
});

describe('reverse() — at depth (the resumed value stream is the ordinary tail)', () => {
  test('reverse().is(<reversed>) — the tail lowers over the value-source seed', async () => {
    expect(await run('g.V().hasLabel("person").values("name").reverse().is("okram")')).toEqual(['okram']);
  });
  test('reverse().count()', async () => {
    expect(Number((await run('g.V().hasLabel("person").values("name").reverse().count()'))[0])).toBe(4);
  });
  test('runs on the SYNC framed() path too (atomic sync barrier)', async () => {
    const out = await Promise.all(mgr.executor('home').framed('g.V().hasLabel("person").values("name").reverse()', {}).map(dec));
    expect(out.sort()).toEqual(['hsoj', 'okram', 'retep', 'sadav']);
  });
});

describe('reverse() — list/path forms keep their own list-order path', () => {
  test('fold().reverse() reverses the list', async () => {
    expect(await run('g.V().hasLabel("person").values("name").order().fold().reverse()'))
      .toEqual([['vadas', 'peter', 'marko', 'josh']]);
  });
  test('inject(list).reverse()', async () => {
    expect(await run('g.inject(["a","b","c"]).reverse()')).toEqual([['c', 'b', 'a']]);
  });
});

describe('reverse() — nested scalar reverse is a fail-closed deferral', () => {
  test('order().by(__.values(name).reverse()) declines cleanly (barrier cannot segment a child body)', async () => {
    await expect(mgr.executor('home').framedAsync('g.V().order().by(__.values("name").reverse())', {}))
      .rejects.toThrow(/not supported/);
  });
});
