// THE STRING CONSTANT, END TO END — what a Gremlin string literal MEANS (the front end's `unescapeJava`) and
// how the compiler SPELLS it in SQL (`textLiteral`, the one authority every inlined string passes through).
// Both used to be partial: `\b`/`\f`/octal/`\uXXXX` read as their source text (`'aBb'` was 8 chars),
// and a NUL reached SQLite raw, which truncates the statement at it — `unrecognized token: "'ma"`.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { q, render, textLiteral } from '../src/sql/kernel/q.ts';
import { UnsupportedTraversal } from '../src/compiler/unsupported.ts';
import { unescapeJava } from '../src/gremlin/frontend.ts';
import { ValueParseError } from '../src/gremlin/coerce.ts';
import { run, seededStore } from './support/harness.ts';
import { executeQuery } from './support/executor.ts';
import { typedAll } from './support/decode.ts';
import { compilerParamName } from '../src/rel/expr.ts';

/** A NUL, or a surrogate outside a well-formed pair — the only strings SQL text cannot carry faithfully. */
const unsayable = (s: string): boolean => /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

describe('textLiteral is TOTAL: every string round-trips exactly or declines', () => {
  const db = new Database(':memory:');
  const roundTrip = (s: string): unknown => {
    const { sql, binds } = render(q`SELECT ${textLiteral(s)} AS v`);
    expect(binds).toEqual([]);   // a compile-time literal never spends a bind
    return (db.query(sql).get() as { v: unknown }).v;
  };

  test('every code point U+0001..U+10FFFF (surrogate block excluded) round-trips, in 4096-code-point literals', () => {
    let checked = 0;
    for (let start = 1; start <= 0x10ffff; start += 4096) {
      const points: number[] = [];
      for (let cp = start; cp < start + 4096 && cp <= 0x10ffff; cp++) if (cp < 0xd800 || cp > 0xdfff) points.push(cp);
      if (!points.length) continue;
      const s = String.fromCodePoint(...points);
      expect(roundTrip(s)).toBe(s);
      checked += points.length;
    }
    expect(checked).toBe(0x10ffff - 0x800);
  });

  test("a quote is doubled, never an injection: `'` and `''` and `'; DROP …` read back as themselves", () => {
    for (const s of ["'", "''", "a'b", "'; DROP TABLE nodes; --", '\\', '"', '']) expect(roundTrip(s)).toBe(s);
  });

  test('a NUL and every lone surrogate DECLINE (UnsupportedTraversal) — never a raw SQLite error', () => {
    const cases = ['\u0000', 'ma\u0000rko', '\u0000\u0000', 'x\u0000'];
    for (let unit = 0xd800; unit <= 0xdfff; unit++) cases.push(String.fromCharCode(unit), `a${String.fromCharCode(unit)}b`);
    cases.push('\udc00\ud800', '\ud83d\ud83d', '\ude00x');   // reversed / doubled high / leading low
    for (const s of cases) {
      expect(unsayable(s)).toBe(true);
      expect(() => textLiteral(s)).toThrow(UnsupportedTraversal);
    }
  });

  test('a well-formed surrogate PAIR is one astral character and round-trips', () => {
    for (const s of ['😀', 'a𐀀b', '􏿿']) expect(roundTrip(s)).toBe(s);
  });
});

describe('a Gremlin string literal decodes with unescapeJava (GenericLiteralVisitor.visitStringLiteral)', () => {
  // `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/language/grammar/GenericLiteralVisitor.java`
  // decodes every string/char literal with commons-text `StringEscapeUtils.unescapeJava`, over the escapes
  // `Gremlin.g4`'s `EscapeSequence`/`OctalEscape`/`UnicodeEscape`/`JoinLineEscape` admit.
  test.each([
    ['a\\bb', 'a\bb'], ['a\\fb', 'a\fb'], ['a\\tb', 'a\tb'], ['a\\nb', 'a\nb'], ['a\\rb', 'a\rb'],
    ["a\\'b", "a'b"], ['a\\"b', 'a"b'], ['a\\\\b', 'a\\b'],
    ['a\\u0042b', 'aBb'], ['\\uuu0041', 'A'], ['\\u00e9', 'é'], ['\\ud83d\\ude00', '😀'], ['\\ud83d', '\ud83d'],
    ['a\\101b', 'aAb'], ['\\0', '\0'], ['\\7', '\x07'], ['\\77', '?'], ['\\377', '\xff'],
    ['\\477', "'7"],   // a leading 4..7 takes TWO digits (OctalUnescaper): \47 = `'`, then a literal 7
    ['\\400', ' 0'],   // \40 = space, then 0
    ['\\08', '\x008'], // 8 is not octal
    ['\\\\u0041', '\\u0041'], // an escaped backslash, then the plain text `u0041`
    ['a\\\nb', 'a\nb'], ['a\\\r\nb', 'a\r\nb'], // JoinLineEscape: the backslash goes, the break stays
  ])('unescapeJava(%j) = %j', (source, expected) => {
    expect(unescapeJava(source)).toBe(expected);
  });

  const one = (gremlin: string): unknown => (run(seededStore(), gremlin) as { v: unknown }[])[0]?.v;
  test('end to end: the decoded literal is the value a step sees', () => {
    expect(one("g.inject('a\\u0042b')")).toBe('aBb');
    expect(one("g.inject('a\\u0042b').length()")).toBe(3);
    expect(one("g.inject('a\\bb').length()")).toBe(3);
    expect(one("g.inject('a\\101b')")).toBe('aAb');
    expect(one("g.inject('a\\fb').length()")).toBe(3);
    expect(one('g.inject("a\\u0042b")')).toBe('aBb');
    expect(one("g.V().has('name','mark\\u006f').values('name')")).toBe('marko');
  });

  test("an 's'-suffixed string literal is the string without its suffix (StringSuffixLiteral)", () => {
    expect(one("g.inject('abc's)")).toBe('abc');
    expect(one('g.inject("abc"s)')).toBe('abc');
    expect(one("g.inject(''s)")).toBe('');
  });

  test('a char literal decoding to other than ONE UTF-16 unit raises the reference error', () => {
    // `visitCharacterLiteral`: `inner.length() != 1` → "Character literal must contain exactly one character".
    expect(() => run(seededStore(), "g.inject('😀'c)")).toThrow(ValueParseError);
    expect(() => run(seededStore(), "g.inject('😀'c)")).toThrow('Character literal must contain exactly one character');
    expect(one("g.inject('\\u0041'c)")).toBe('A');
  });

  test('a decoded NUL or lone surrogate declines at every position that inlines it', () => {
    for (const gremlin of [
      "g.inject('a\\u0000b').length()", "g.inject('\\0')", "g.inject('\\ud83d')",
      "g.V().has('name', containing('ma\\u0000rko')).count()", "g.V().has('name','ma\\u0000rko').count()",
      "g.V().has('name', within('\\u0000','marko')).count()", "g.V().union(constant('\\u0000')).count()",
      "g.V().choose(has('name','a\\0'), constant(1), constant(2))", "g.V().where(values('name').is(neq('\\0')))",
      "g.V().project('a').by(constant('\\0'))", "g.V().group().by(constant('\\udc00'))", "g.V().values('\\0')",
      "g.addV('p').property('name','x\\ud83dy')",
    ]) expect(() => run(seededStore(), gremlin)).toThrow(UnsupportedTraversal);
  });
});

// THE STRING VALUE, wherever it enters SQL — not only as statement text: a BIND, a JSON text, stored DATA.
// SQLite's text functions answer in CODE POINTS (`length('😀')` is 1, Java's UTF-16 says 2) — a deliberate
// divergence (`docs/feature-support-matrix.md`).
describe('a string VALUE through SQLite', () => {
  const runP = (gremlin: string, params: Record<string, unknown> = {}): string[] =>
    typedAll(executeQuery(seededStore(), gremlin, params));
  const NUL = 'a\u0000bc';

  // A NUL arriving as DATA travels whole (a bind and a JSON escape both carry it).
  test('a NUL carried as data is exact where nothing reads it as text', () => {
    expect(runP('g.inject(x)', { x: NUL })).toEqual([JSON.stringify(NUL)]);
    expect(runP("g.inject(['k':'a\\u0000b']).select('k')")).toEqual([JSON.stringify('a\u0000b')]);
    expect(runP("g.V().has('name', x).count()", { x: NUL })).toEqual(['0L']);
  });

  test.each([
    ["g.inject('😀').length()", ['1i']], ["g.inject('a😀b').substring(1,3)", ['"😀b"']],
    ["g.inject(['😀','ab']).length(local)", ['[1i,2i]']],
  ] as const)('a counting text function counts code points: %s', (gremlin, expected) => {
    expect(runP(gremlin)).toEqual([...expected]);
  });

  test('BMP text, and astral text through a unit-agnostic function', () => {
    expect(runP("g.inject('abc').length()")).toEqual(['3i']);
    expect(runP("g.inject('abc').substring(1,3)")).toEqual(['"bc"']);
    expect(runP("g.inject('\\uffff').length()")).toEqual(['1i']);
    expect(runP("g.inject('a😀b').reverse()")).toEqual(['"b😀a"']);
    expect(runP("g.inject('a😀b').is(containing('😀'))")).toEqual(['"a😀b"']);
    expect(runP("g.V().values('name').length()")).toEqual(['5i', '5i', '3i', '4i', '6i', '5i']);
    expect(runP("g.V().has('name', containing(x)).values('name')", { x: 'ar' })).toEqual(['"marko"']);
  });
});

describe('a compiler-minted bind name is one no user parameter can spell', () => {
  test('a user parameter named like the old reserved survivor bind keeps its own value after a regex barrier', () => {
    const answer = typedAll(executeQuery(seededStore(),
      "g.V().has('name', regex('marko')).out().has('name', within(_mogwai_regex_survivors_1)).values('name')",
      { _mogwai_regex_survivors_1: ['lop'] }));
    expect(answer).toEqual(['"lop"']);
  });

  test("the minted name lies outside the grammar's Identifier alphabet", () => {
    // `Gremlin.g4` `Identifier: IdentifierStart IdentifierPart*` — `$`, `A-Z`, `_`, `a-z`, digits and non-ASCII ranges.
    expect(compilerParamName('x')).toMatch(/[~:]/);
    expect(() => run(seededStore(), `g.inject(${compilerParamName('x')})`)).toThrow(ValueParseError);
  });
});

describe('an uncoverable barrier RESUME declines as UnsupportedTraversal, never an internal error', () => {
  test.each([
    ["g.V().has('name', regex('m')).sideEffect(out()).values('name')"],
    ["g.V().has('name', regex('m')).local(out().has('name', regex('l'))).values('name')"],
    ["g.V().has('name', regex('m')).repeat(out()).until(has('name', regex('l'))).values('name')"],
    ["g.V().has('name', regex('m')).sideEffect(out().has('name', regex('l'))).values('name')"],
  ])('%s', (gremlin) => {
    let thrown: unknown;
    try { executeQuery(seededStore(), gremlin); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(UnsupportedTraversal);
    expect((thrown as Error).message).toStartWith('this traversal is not supported yet: ');
    expect((thrown as Error).name).toBe('UnsupportedTraversal');
  });
  test('a resumed local(values(k)) answers every value', () => {
    expect(typedAll(executeQuery(seededStore(), "g.V().has('name', regex('m')).out().has('name', regex('l')).local(values('name'))")))
      .toEqual(['"lop"']);
  });
});
