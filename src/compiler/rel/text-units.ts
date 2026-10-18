import { compilerInt, compilerText, type Expr } from '../../rel/expr.ts';
import { deferralExpr } from '../../rel/raise.ts';
import { forEachExpr } from '../../rel/walk.ts';

// ---------- what SQLite's text FUNCTIONS cannot see: a NUL, and the UTF-16 unit ----------
//
// A string VALUE can reach SQL whole and still be misread by the function applied to it. Two readings
// diverge from the reference's `java.lang.String`, and both are decided by the DATA, so they are answered
// where the function is called, at run time — the ONE authority every such call routes through:
//
//  - A NUL (U+0000). A bind and a JSON escape carry it whole (`assertCarriable`, `sql/kernel/q.ts`), but
//    SQLite's `length`, `substr` and `like` read their text as a C string and stop at it:
//    `length('a'||char(0)||'bc')` is 1 where `"a\u0000bc".length()` is 4, and `like('%b%', …)` misses.
//    Only a NUL arriving as DATA — a user parameter, a map literal's JSON, a stored value — gets here; a
//    NUL in statement text already declined (`textLiteral`).
//  - A character outside the Basic Multilingual Plane. Java counts and slices UTF-16 UNITS
//    (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/LengthGlobalStep.java:53`
//    is `String.length()`, `SubstringGlobalStep` is `String.substring`), where SQLite counts CODE POINTS:
//    `'😀'.length()` is 2, SQLite's `length('😀')` is 1, and every index past one is off by one per astral
//    character. Containment (`like`) does not count, so it is unit-agnostic and only the NUL concerns it.
//
// Either one DEFERS for that row (`deferralExpr`) — never a different answer. `instr(x, char(0))` searches
// the whole text (it reads the byte length, not the C string), and `GLOB` ranges compare code points, so
// `[𐀀-􏿿]` is exactly "holds an astral character". Making the counting functions UTF-16 exact instead is
// the open alternative; this stopgap only refuses what it would miscount.

/**
 * Java's whitespace set — `Character.isWhitespace(char)`, the exact code units the Gremlin `trim` family
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/util/StringLocalStep.java:75-94`)
 * strips and `split(null)` splits on (`StringUtil.split` → Commons `StringUtils.splitByWholeSeparator(s, null)`,
 * whose worker tests `Character.isWhitespace` per char; `.../gremlin/util/StringUtil.java:42-52`). Excludes
 * the non-breaking spaces (U+00A0 NBSP, U+2007 figure, U+202F narrow NBSP) and U+FEFF, which Java also
 * excludes; includes U+001C..U+001F and U+3000 ideographic space (the suite's fullwidth-space case). Every
 * member is in the BMP, as `isWhitespace(char)` is per UTF-16 unit. Built from explicit code points so the
 * source carries no literal control/space chars. ONE list for both consumers: a second, re-derived one is
 * how `split(null)` came to split on NBSP (JS `\s`) while `trim()` did not.
 */
export const JAVA_WHITESPACE = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x205f, 0x3000,
].map((c) => String.fromCharCode(c)).join('');

/** The run-time deferral a misread string raises. */
export const UNREADABLE_TEXT = "a string holding a NUL, or a character outside the Basic Multilingual Plane, through SQLite's text functions is not supported yet";

const holdsNul = (x: Expr): Expr => ({ kind: 'binary', op: '>', left: { kind: 'call', fn: 'instr', args: [x, { kind: 'call', fn: 'char', args: [compilerInt(0)] }] }, right: compilerInt(0) });
const holdsAstral = (x: Expr): Expr => ({ kind: 'binary', op: 'glob', left: x, right: compilerText('*[\u{10000}-\u{10ffff}]*') });
const or = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: 'or', left, right });
/** The deferral's `dependsOn`: `random()` is never constant, so SQLite cannot hoist the arm — and the
 *  subject (often a correlated property read) is not spelled a third time for it. */
const ROW: Expr = { kind: 'call', fn: 'random', args: [] };

/** `body` — a COUNTING text function (`length`, `substr`) over `subject` — or the deferral where the
 *  subject holds a NUL or an astral character. NULL passes through (`CASE WHEN NULL` takes the ELSE). */
export const countedText = (subject: Expr, body: Expr): Expr => ({
  kind: 'case', whens: [[or(holdsNul(subject), holdsAstral(subject)), deferralExpr(UNREADABLE_TEXT, ROW)]], else: body,
});

/** `body` — a CONTAINMENT text function (`like`) of `pattern` over `subject` — or the deferral where either
 *  holds a NUL. The subject is always tested: even a compile-time one may be read out of a JSON literal,
 *  whose `\u0000` escape no statement-text check sees. A pattern built from compiler text alone was
 *  already proved NUL-free by `textLiteral`, so only a data-carrying one (a parameter) is tested. */
export const containedText = (subject: Expr, pattern: Expr, body: Expr): Expr => {
  const test = carriesData(pattern) ? or(holdsNul(subject), holdsNul(pattern)) : holdsNul(subject);
  return { kind: 'case', whens: [[test, deferralExpr(UNREADABLE_TEXT, ROW)]], else: body };
};

/** Does `e` read anything but compiler text — a column, a bind, a subquery? */
function carriesData(e: Expr): boolean {
  let data = false;
  forEachExpr(e, (x) => {
    if (x.kind === 'col' || x.kind === 'scalar' || x.kind === 'exists' || x.kind === 'in-query') data = true;
    else if (x.kind === 'lit' && (x.source === 'parameter' || x.source === 'bound')) data = true;
  });
  return data;
}

// ---------- what SQLite's CASE functions cannot see: a non-ASCII cased character ----------
//
// `toUpper()`/`toLower()` are Java's Unicode `String.toUpperCase()`/`toLowerCase()`
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ToUpperGlobalStep.java:52`,
// `ToLowerGlobalStep.java:52`, and the `Local` twins at `:50`) — `'é'` → `'É'`, `'ß'` → `'SS'`, a final
// `'Σ'` → `'ς'` — where SQLite's `upper()`/`lower()` fold ASCII only and return every other character
// unchanged. The two agree EXACTLY on a string holding no non-ASCII CASED character (an uncased one — CJK,
// an emoji, a digit — is left alone by both), so such a string keeps SQLite's answer and one holding a cased
// character DEFERS for that row. Making the mapping exact needs a Unicode case table SQLite does not have;
// this stopgap only refuses what it would mis-case.
//
// `CASED` is every code point >= U+0080 that JavaScript's own Unicode case mapping changes, upper or lower
// (`test/compiler/text-units.test.ts` re-derives it from the running engine and fails on any character it
// misses). Java's tables are an older Unicode version than the engine's, so the set is a SUPERSET of Java's:
// it can only over-defer. The GLOB reads the subject through `json_quote`, because `GLOB` reads a C string
// and would stop at the first NUL (so would `replace`, which takes a NUL pattern for an empty one):
// `json_quote` reads the whole text and escapes a NUL as `\u0000`, and every character it escapes is
// ASCII, so the quoted text holds exactly the subject's non-ASCII characters.

/** Hex code-point ranges (`lo-hi`, or a single `cp`), space separated — see `CASED`. */
const CASED_RANGES =
  'b5 c0-d6 d8-f6 f8-137 139-18c 18e-19a 19c-1a9 1ac-1b9 1bc-1bd 1bf 1c4-220 222-233 23a-254 256-257 259 ' +
  '25b-25c 260-261 263 265-266 268-26c 26f 271-272 275 27d 280 282-283 287-28c 292 29d-29e 345 370-373 ' +
  '376-377 37b-37d 37f 386 388-38a 38c 38e-3a1 3a3-3d1 3d5-3f5 3f7-3fb 3fd-481 48a-52f 531-556 561-587 ' +
  '10a0-10c5 10c7 10cd 10d0-10fa 10fd-10ff 13a0-13f5 13f8-13fd 1c80-1c88 1c90-1cba 1cbd-1cbf 1d79 1d7d ' +
  '1d8e 1e00-1e9b 1e9e 1ea0-1f15 1f18-1f1d 1f20-1f45 1f48-1f4d 1f50-1f57 1f59 1f5b 1f5d 1f5f-1f7d ' +
  '1f80-1fb4 1fb6-1fbc 1fbe 1fc2-1fc4 1fc6-1fcc 1fd0-1fd3 1fd6-1fdb 1fe0-1fec 1ff2-1ff4 1ff6-1ffc 2126 ' +
  '212a-212b 2132 214e 2160-217f 2183-2184 24b6-24e9 2c00-2c70 2c72-2c73 2c75-2c76 2c7e-2ce3 2ceb-2cee ' +
  '2cf2-2cf3 2d00-2d25 2d27 2d2d a640-a66d a680-a69b a722-a72f a732-a76f a779-a787 a78b-a78d a790-a794 ' +
  'a796-a7ae a7b0-a7ca a7d0-a7d1 a7d6-a7d9 a7f5-a7f6 ab53 ab70-abbf fb00-fb06 fb13-fb17 ff21-ff3a ' +
  'ff41-ff5a 10400-1044f 104b0-104d3 104d8-104fb 10570-1057a 1057c-1058a 1058c-10592 10594-10595 ' +
  '10597-105a1 105a3-105b1 105b3-105b9 105bb-105bc 10c80-10cb2 10cc0-10cf2 118a0-118df 16e40-16e7f ' +
  '1e900-1e943';

/** The cased code points as inclusive `[lo, hi]` pairs, decoded from `CASED_RANGES`. */
export const CASED: readonly (readonly [number, number])[] = CASED_RANGES.split(' ').map((range) => {
  const [lo, hi = lo] = range.split('-') as [string, string?];
  return [parseInt(lo, 16), parseInt(hi, 16)] as const;
});

/** The run-time deferral a string `upper()`/`lower()` would mis-case raises. */
export const UNCASEABLE_TEXT = 'toUpper()/toLower() over a string holding a non-ASCII cased character is not supported yet';

/** A GLOB matching a string that holds any `CASED` character — a class of code-point ranges (`GLOB`
 *  decodes UTF-8, so `[À-Ö]` is a code-point range). Every member is non-ASCII, so none is a class
 *  metacharacter. */
const CASED_GLOB = `*[${CASED.map(([lo, hi]) => (lo === hi ? String.fromCodePoint(lo) : `${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}`)).join('')}]*`;

/** `body` — a CASE-MAPPING text function (`upper`, `lower`) over `subject` — or the deferral where the
 *  subject holds a non-ASCII character Java's Unicode case mapping would change. NULL passes through. */
export const casedText = (subject: Expr, body: Expr): Expr => {
  // Only a TEXT subject is quoted: `json_quote` of a BLOB is an SQLite error, and a non-string subject is
  // the reference's own exception, raised elsewhere — never this guard's to turn into a crash.
  const isText: Expr = { kind: 'binary', op: '=', left: { kind: 'call', fn: 'typeof', args: [subject] }, right: compilerText('text') };
  const nulEscaped: Expr = { kind: 'case', whens: [[isText, { kind: 'call', fn: 'json_quote', args: [subject] }]], else: compilerText('') };
  return {
    kind: 'case',
    whens: [[{ kind: 'binary', op: 'glob', left: nulEscaped, right: compilerText(CASED_GLOB) }, deferralExpr(UNCASEABLE_TEXT, ROW)]],
    else: body,
  };
};
