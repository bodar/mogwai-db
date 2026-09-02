import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { decode } from './support/decode.ts';

// End-to-end for the `split()` value-transform BARRIER (substrate A). `split()` turns each string
// traverser into a LIST of substrings (`SplitGlobalStep`/`StringUtil.split`); SQLite has no scalar for
// it, so — like `reverse()` — the GLOBAL form over a SCALAR value stream lowers as a SYNC barrier
// (`compiler/rel/split.ts`): the head is the value stream up to split, the JS `splitValue` splits each
// value (faithful to Commons `StringUtils`), and the computed lists re-inject as one `json_each` bind
// through `lowerListResume`, framed back as LISTS on the wire. `split(Scope.local, …)` over a folded
// list and a LIST-shaped head (the reference's non-string throw) are fail-closed deferrals for now.

const mgr = new BunGraphManager(undefined, extendedRegistry);
const dec = (f: { buf: Buffer }) => decode(f.buf);
const run = async (g: string) => await Promise.all((await mgr.executor('home').framedAsync(g, {})).map(dec));

beforeAll(async () => {
  for (const g of MODERN_SEED) await mgr.executor('home').framedAsync(g, {});
});

describe('split() — global scalar barrier (the corpus scenarios)', () => {
  test('split(sep) around each match, null passes through', async () => {
    expect(await run('g.inject("that", "this", "test", null).split("h")'))
      .toEqual([['t', 'at'], ['t', 'is'], ['test'], null]);
  });
  test('split(null) splits on whitespace', async () => {
    expect(await run('g.inject("hello world").split(null)')).toEqual([['hello', 'world']]);
  });
  test('split("") splits into characters', async () => {
    expect(await run('g.inject("that", "this", "test", null).split("")'))
      .toEqual([['t', 'h', 'a', 't'], ['t', 'h', 'i', 's'], ['t', 'e', 's', 't'], null]);
  });
  test('over a values() stream (no whitespace → single-member lists)', async () => {
    expect((await run('g.V().hasLabel("person").values("name").split(null)')).sort())
      .toEqual([['josh'], ['marko'], ['peter'], ['vadas']]);
  });
});

describe('split() — semantics faithful to StringUtil.split', () => {
  test('adjacent separators produce no empty members (splitByWholeSeparator)', async () => {
    expect(await run('g.inject("a,,b").split(",")')).toEqual([['a', 'b']]);
  });
  test('a non-string traverser is the reference IllegalArgumentException', async () => {
    await expect(mgr.executor('home').framedAsync('g.V().values("age").split("x")', {}))
      .rejects.toThrow(/can only take string as argument/);
  });
});

describe('split() — at depth (the list re-enters the ordinary list vocabulary)', () => {
  test('split(sep).unfold() explodes the produced lists', async () => {
    expect(await run('g.inject("a,b,c").split(",").unfold()')).toEqual(['a', 'b', 'c']);
  });
  test('a MULTI-traverser split().unfold() keeps stream order (earlier list before later)', async () => {
    // The re-injected list stream carries its position as an encounter channel; without it, unfold()
    // sorted by the inner member ordinal alone and interleaved the lists (x,p,y,q instead of x,y,p,q).
    expect(await run('g.inject("x,y","p,q").split(",").unfold()')).toEqual(['x', 'y', 'p', 'q']);
  });
  test('runs on the SYNC framed() path too (atomic sync barrier)', async () => {
    const out = await Promise.all(mgr.executor('home').framed('g.inject("a,b,c").split(",")', {}).map(dec));
    expect(out).toEqual([['a', 'b', 'c']]);
  });
});

describe('split() — deferred forms fail closed (never a wrong answer)', () => {
  test('a LIST-shaped head declines cleanly (the reference non-string throw, not built yet)', async () => {
    await expect(mgr.executor('home').framedAsync('g.inject(["a","b"]).split("a")', {}))
      .rejects.toThrow(/not supported/);
  });
  test('split(Scope.local, …) over a folded list declines cleanly', async () => {
    await expect(mgr.executor('home').framedAsync('g.V().hasLabel("person").values("name").order().fold().split(Scope.local, "a").unfold()', {}))
      .rejects.toThrow(/not supported/);
  });
});
