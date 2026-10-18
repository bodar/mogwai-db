import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { decode } from './support/decode.ts';
import { seeded } from './support/graph.ts';
import { exec } from './support/executor.ts';
import { DEFAULT_FAST_PATHS } from '../src/compiler/options/fast-paths.ts';
import { compileRegex, extractMandatoryLiteral } from '../src/compiler/rel/regex.ts';

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
  test('TWO barriers with DIFFERENT survivor sets keep both — each re-injected within() has its own bind', async () => {
    // The second segment's chain still carries the first barrier's `within`; one shared reserved bind
    // name made the bind-dedup read ONE survivor set for both, and every one of these answered [] / 0.
    expect(await run("g.V().has('name', regex('marko')).out().has('name', regex('lop')).values('name')")).toEqual(['lop']);
    expect(await run("g.V().has('name', regex('m')).out().has('name', regex('l')).values('name')")).toEqual(['lop']);
    expect(await run("g.V().has('name', regex('ma')).out().has('lang', regex('ja')).values('name')")).toEqual(['lop']);
    expect((await run("g.V().has('name', regex('marko')).out().has('name', regex('lop')).count()")).map(Number)).toEqual([1]);
    expect((await run("g.V().has('name', regex('^[mj]')).out().has('name', regex('^[lr]')).has('lang', regex('va$')).values('name')")).sort())
      .toEqual(['lop', 'lop', 'ripple']);
  });
  test('a NUL in the pattern is matched by the regex, never inlined into the prefilter SQL', async () => {
    // A NUL in the prefilter literal reached `containing(...)`, whose SQL text SQLite truncates at the
    // NUL — a raw `unrecognized token` reached the user.
    expect(extractMandatoryLiteral('mar\\x00ko')).toBeNull();
    expect(extractMandatoryLiteral('ab\\u0000cd')).toBeNull();
    expect(extractMandatoryLiteral('abc\u0000de')).toBe('abc');
    expect(extractMandatoryLiteral('abc\\\u0000de')).toBe('abc');
    expect(await run("g.V().has('name', regex('mar\\\\x00')).values('name')")).toEqual([]);
    expect(await run("g.V().has('name', regex('ab\\\\u0000cd')).values('name')")).toEqual([]);
    expect((await run("g.V().has('name', regex('mar\\\\x00ko')).count()")).map(Number)).toEqual([0]);
    expect(await run("g.V().out().has('name', regex('lo\\\\x00p')).values('name')")).toEqual([]);
  });
});

describe('regex barrier — trigram prefilter', () => {
  // The head prefilters with has(key, containing(<mandatory literal>)) so the trigram index narrows
  // candidates before the JS regex. It must be answer-INVARIANT: over-selecting is fine, dropping a
  // true match is not. These pin the extractor's CONSERVATIVE contract and the invariance.
  test('extractMandatoryLiteral is conservative (>=3-char exactly-once run, else null)', () => {
    expect(extractMandatoryLiteral('^mar')).toBe('mar');
    expect(extractMandatoryLiteral('Tinker')).toBe('Tinker');
    expect(extractMandatoryLiteral('Tinker.*©')).toBe('Tinker');
    expect(extractMandatoryLiteral('rko$')).toBe('rko');
    expect(extractMandatoryLiteral('^SKU-\\d+')).toBe('SKU-');
    expect(extractMandatoryLiteral('a?bcd')).toBe('bcd');   // a? optional → dropped
    expect(extractMandatoryLiteral('^m')).toBeNull();        // literal too short
    expect(extractMandatoryLiteral('^(mar|jo)')).toBeNull(); // alternation → bail
    expect(extractMandatoryLiteral('ab+cd')).toBeNull();     // no >=3 contiguous run
  });

  test('an escape is consumed WHOLE; any alphanumeric escape but a class/control/anchor bails', () => {
    // Reading `\x` as the escape and `61` as text prefiltered `m\x61rko` on "61rko" and dropped marko.
    // The scanner does not decode `\x`/`\u` at all — it extracts nothing rather than risk a wrong run.
    expect(extractMandatoryLiteral('m\\x61rko')).toBeNull();
    expect(extractMandatoryLiteral('ma\\u0072ko')).toBeNull();
    expect(extractMandatoryLiteral('ab\\.cd')).toBe('ab.cd');
    expect(extractMandatoryLiteral('abc\\tdef')).toBe('abc');          // a control escape ends the run
    expect(extractMandatoryLiteral('\\Babc')).toBe('abc');             // so does an anchor escape
    expect(extractMandatoryLiteral('ab😀?cd')).toBeNull();              // an astral char is ONE optional atom
    // An ESCAPED astral char is one code point too — never a lone low surrogate left behind as a run.
    expect(extractMandatoryLiteral('\\😀abc')).toBe('😀abc');
    expect(extractMandatoryLiteral('ab\\😀?cd')).toBeNull();
    expect(extractMandatoryLiteral('[\\]]abc')).toBe('abc');           // a class's escapes are consumed whole
    expect(extractMandatoryLiteral('(\\))abc')).toBe('abc');           // so are a group's
    for (const p of ['\\x{61}abc', '\\0141abc', '\\cAabc', '\\Qabc\\E', '\\p{L}abc', 'abc\\', '\\1abc', '\\k<n>abc', '[\\x5d]abc'])
      expect(extractMandatoryLiteral(p)).toBeNull();
  });

  test('DIFFERENTIAL: every string the pattern finds contains the extracted literal (randomized)', () => {
    // The extractor's whole contract: a match MUST contain the run, or the prefilter drops a true match.
    // A deterministic PRNG builds patterns from atoms that reach every escape form (the bailing ones
    // too), quantifier, group, lookaround and class, and subjects two ways: random noise, and a string
    // SAMPLED from the pattern's own atoms (so long literal runs match and the run is really exercised).
    // The oracle is the barrier's own matcher, `compileRegex` — whichever reading (`u` or not) it picks.
    let state = 0x9e3779b9;
    const rand = (n: number) => { // mulberry32
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), state | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    const pick = <T>(xs: readonly T[]): T => xs[rand(xs.length)]!;
    // [pattern atom, strings it may match]
    const atoms: readonly (readonly [string, readonly string[]])[] = [
      ['a', ['a']], ['b', ['b']], ['c', ['c']], ['m', ['m']], ['a', ['a']], ['b', ['b']], ['😀', ['😀']], ['.', ['a', '😀', '-']],
      ['\\.', ['.']], ['\\-', ['-']], ['{', ['{']], ['}', ['}']], [']', [']']],
      ['\\d', ['1']], ['\\s', [' ', '\t']], ['\\t', ['\t']], ['\\b', ['']],
      ['\\😀', ['😀']], ['\\🙂', ['🙂']], ['[\\😀b]', ['😀', 'b']], ['[😀-🙂]', ['😀', '🙂']],
      ['[ab]', ['a', 'b']], ['[^a]', ['b', 'm']], ['[\\]c]', [']', 'c']], ['(ab)', ['ab']], ['(?:a\\.)', ['a.']],
      ['(?=a)', ['']], ['(?!b)', ['']], ['(?<n>c)', ['c']], ['(?<=a)', ['']], ['^', ['']], ['$', ['']],
    ];
    // Escapes the scanner bails on — rarer, or almost no pattern would extract anything.
    const rare: readonly (readonly [string, readonly string[]])[] = [
      ['\\x61', ['a']], ['\\u0063', ['c']], ['\\uD83D\\uDE00', ['😀']], ['\\x{61}', ['a']], ['\\0', ['\0']], ['\\cA', ['\u0001']], ['\\p{L}', ['a']], ['\\k<n>', ['']], ['\\1', ['']],
    ];
    const quantifiers: readonly (readonly [string, readonly number[]])[] = [
      ['*', [0, 1, 2]], ['+', [1, 2]], ['?', [0, 1]], ['{2}', [2]], ['{0,1}', [0, 1]], ['+?', [1, 2]], ['??', [0, 1]],
    ];
    const noise = ['a', 'b', 'c', 'm', '.', '-', '1', ' ', '\t', '{', '}', ']', '😀', '🙂', '\ud83d', '\ude00', 'A'];
    const randomNoise = () => { let s = ''; for (let k = rand(5); k > 0; k--) s += pick(noise); return s; };
    let extracted = 0;
    let matched = 0;
    for (let n = 0; n < 20000; n++) {
      let pattern = '';
      let sample = '';
      for (let k = 1 + rand(8); k > 0; k--) {
        const [atom, spells] = rand(20) === 0 ? pick(rare) : pick(atoms);
        const [quantifier, counts] = rand(3) === 0 ? pick(quantifiers) : ['', [1]] as const;
        pattern += atom + quantifier;
        for (let r = pick(counts); r > 0; r--) sample += pick(spells);
      }
      if (rand(12) === 0) pattern += '|' + pick(atoms)[0];
      const literal = extractMandatoryLiteral(pattern);
      if (literal == null) continue;
      let re: RegExp;
      try { re = compileRegex(pattern); } catch { continue; }
      extracted++;
      const subjects = [sample, randomNoise() + sample + randomNoise()];
      for (let s = 0; s < 20; s++) subjects.push(randomNoise() + randomNoise());
      for (const subject of subjects) {
        if (!re.test(subject)) continue;
        matched++;
        expect({ pattern, literal, subject, contains: subject.includes(literal) }).toEqual({ pattern, literal, subject, contains: true });
      }
    }
    expect(extracted).toBeGreaterThan(500);
    expect(matched).toBeGreaterThan(500);
  });

  test('answer-invariant under the trigram toggle (containing() falls back to LIKE)', async () => {
    const store = seeded(MODERN_SEED);
    const names = async (fts: boolean) => (await Promise.all(
      exec(store, undefined, { ...DEFAULT_FAST_PATHS, ftsSubstringPredicate: fts })
        .framed('g.V().has("name", TextP.regex("^mar"))', {})
        .map((f) => decode(f.buf))
    )).map((v: any) => v.properties.find((p: any) => p.label === 'name')?.value).sort();
    expect(await names(true)).toEqual(['marko']);
    expect(await names(false)).toEqual(await names(true));   // trigram on ≡ off — the prefilter only picks the access path
  });

  test('the case-insensitive prefilter is a safe SUPERSET — the regex stays case-sensitive', async () => {
    // containing("Tinker") matches "tinker" too (case-insensitive index), but the exact JS regex must
    // reject it: only "Tinker" survives. A buggy prefilter that DECIDED would wrongly keep "tinker".
    const store = seeded(['g.addV("x").property("name","Tinker")', 'g.addV("x").property("name","tinker")']);
    const out = await Promise.all(
      exec(store).framed('g.V().has("name", TextP.regex("Tinker")).values("name")', {}).map((f) => decode(f.buf)),
    );
    expect(out.sort()).toEqual(['Tinker']);
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
