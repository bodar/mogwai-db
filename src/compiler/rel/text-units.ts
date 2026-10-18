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
