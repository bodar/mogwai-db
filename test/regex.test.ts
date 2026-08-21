import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { decode } from './support/decode.ts';

// End-to-end for the REGEX BARRIER (`has(key, TextP.regex(...))`), on the real stack. `regex` cannot
// lower to SQL (DO SQLite has no regex function and we do not filter the traversal row-at-a-time), so
// it lowers as a barrier: a SQL head projects the candidate `values(key)`, one batched JS transform
// applies the regex, and the survivors re-inject as `within(<values>)` for the rest of the chain in
// SQL. Committed to JS-`RegExp` semantics (Java `matcher.find()`; `src/compiler/rel/regex.ts`). The 4
// Has.feature scenarios are covered by L3; these assert the mechanism composes AT DEPTH — the thing L3
// cannot see.

const mgr = new BunGraphManager(undefined, extendedRegistry);
const dec = (f: { buf: Buffer }) => decode(f.buf);
const names = (vs: any[]) => vs.map((v) => v.properties?.find((p: any) => p.label === 'name')?.value).sort();
const run = async (g: string, p: Record<string, any> = {}) =>
  await Promise.all((await mgr.executor('home').framedAsync(g, p)).map(dec));

beforeAll(async () => {
  for (const g of MODERN_SEED) await mgr.executor('home').framedAsync(g, {});
  // A software vertex whose name carries a unicode ©, for the Tinker scenarios.
  await mgr.executor('unicode').framedAsync('g.addV("software").property("name", "Apache TinkerPop©")', {});
});

describe('regex barrier — membership', () => {
  test('regex("^mar") selects marko (anchored search)', async () => {
    expect(names(await run('g.V().has("name", TextP.regex("^mar"))'))).toEqual(['marko']);
  });
  test('notRegex("^mar") selects everyone else (negation is existential)', async () => {
    expect(names(await run('g.V().has("name", TextP.notRegex("^mar"))')))
      .toEqual(['josh', 'lop', 'peter', 'ripple', 'vadas']);
  });
  test('regex("Tinker") is a PARTIAL search, not an anchored full match', async () => {
    const vals = (await Promise.all((await mgr.executor('unicode')
      .framedAsync('g.V().has("name", TextP.regex("Tinker")).values("name")', {})).map(dec)));
    expect(vals).toEqual(['Apache TinkerPop©']);
  });
  test('regex with a unicode metacharacter run', async () => {
    const vals = (await Promise.all((await mgr.executor('unicode')
      .framedAsync('g.V().has("name", TextP.regex("Tinker.*©")).values("name")', {})).map(dec)));
    expect(vals).toEqual(['Apache TinkerPop©']);
  });
  test('no value matches → empty', async () => {
    expect(await run('g.V().has("name", TextP.regex("^zzz"))')).toEqual([]);
  });
});

describe('regex barrier — at depth (the resume is the ordinary tail)', () => {
  test('has(name,regex).out().values(name) — the tail runs in SQL over survivors', async () => {
    // marko matches; marko -> lop, vadas, josh.
    expect((await run('g.V().has("name", TextP.regex("^mar")).out().values("name")')).sort())
      .toEqual(['josh', 'lop', 'vadas']);
  });
  test('a prefix predicate narrows the population before the regex', async () => {
    // Only person vertices, then names starting with a vowel-free ^[jm]. marko, josh.
    expect(names(await run('g.V().hasLabel("person").has("name", TextP.regex("^[jm]"))')))
      .toEqual(['josh', 'marko']);
  });
  test('count() over the regex result', async () => {
    const [c] = await run('g.V().has("name", TextP.regex("^(mar|jo)")).count()');
    expect(Number(c)).toBe(2); // marko, josh
  });
  test('TWO regex predicates chain — each becomes its own segment', async () => {
    // ^m on name (marko) then the same vertex's name must also match "rko$".
    expect(names(await run('g.V().has("name", TextP.regex("^m")).has("name", TextP.regex("rko$"))')))
      .toEqual(['marko']);
  });
});

describe('regex barrier — parameters and edges', () => {
  test('a bound-param pattern works (the pattern is a compile-time string, not a SQL bind)', async () => {
    expect(names(await run('g.V().has("name", TextP.regex(p))', { p: '^mar' }))).toEqual(['marko']);
  });
  test('regex over an EDGE property (weight is numeric → no string match)', async () => {
    // weight is a double; TextP is P<String>, so a non-string value never matches — empty, not a crash.
    expect(await run('g.E().has("weight", TextP.regex("0"))')).toEqual([]);
  });
});
