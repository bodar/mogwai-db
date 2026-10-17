import type { Step } from '../../gremlin/frontend.ts';
import { arg, isPred } from '../../gremlin/frontend.ts';
import type { BarrierInput } from '../../services/spi/types.ts';
import type { Plan, SegmentPlan } from '../segment.ts';
import { lowerToRel, type Lowering } from './lower.ts';
import { valueHead } from './barrier-value.ts';
import { UnsupportedTraversal } from '../unsupported.ts';

// ---------- regex as a barrier — `has(key, TextP.regex(...))`, on the RelIR route ----------
//
// DO SQLite has no regex function and this project does not filter the TRAVERSAL row-at-a-time
// (root `CLAUDE.md` decision #3), so `regex` cannot lower to SQL like `containing`/`startingWith`
// (LIKE) do. It lowers instead as a BARRIER — the one admissible home for a non-SQL predicate
// (`docs/2026-08-12-regex-as-a-barrier-research.md`): a SQL head narrows and projects the candidate
// VALUES, a single BATCHED JS transform applies the regex over them, and the survivors re-inject as
// an ordinary `within()` that the rest of the chain continues from in SQL. The traversal stays
// compiled on both sides of the one opaque set-transform; that is what distinguishes a barrier from
// the row-at-a-time interpretation the decision forbids.
//
// **It is a VALUE bound-join, not an id landing** (the doc's §correction). The survivors are LOCAL
// elements, so nothing is landed as a DETACHED foreign row (which would lose live adjacency); the
// head projects `values(key)`, the barrier keeps the matching VALUES, and the resume swaps the regex
// predicate for `has(key, within(<survivors>))` over the SAME prefix. Re-applying the whole prefix is
// what makes value re-injection exact: the population is constrained identically in head and resume,
// so an element survives the resume iff it carries a key-value that matched — `has`'s own existential
// semantics, preserved. The survivor set is DATA-SIZED, so it crosses as ONE `json_each` bind
// (`predicate.ts` `jsonEachInSet`, a named collection operand), never an inline IN-list — the DO
// 100-bind / 100-KB wall the federate injection's 25-literal cap runs into.
//
// **Residency is `'do'`.** The regex is pure CPU over a batch already resident in the DO — no remote
// wait to free the DO across — so, like `io()`, it stays beside the store; only a REMOTE WAIT
// (federate) earns `'worker'` (`services/spi/types.ts`, `BarrierResidency`).
//
// ## Semantics: committed to JS `RegExp`, divergence from Java `Pattern` documented
//
// TinkerPop's `regex` is Java `Pattern.compile(expression).matcher(value).find()`, negated for
// `notRegex` (`vendor/tinkerpop/gremlin-core/.../process/traversal/Text.java:180,195-196`). `.find()`
// is a partial SEARCH (not an anchored full match), which is exactly JS `new RegExp(pattern).test(v)`
// (no `g` flag → stateless). The predicate is `P<String>`, so a non-string value is not a match at
// all, mirroring the LIKE path's `textSubject` type gate (`predicate.ts`).
//
// The matcher is JS `RegExp`, but the PATTERN is Java's: `javaPatternAsJs` reads it as Java does and
// spells that in JS (`.`/`\s`/`$` translated to Java's meaning, `u` flag for code points), and DECLINES
// every construct the two dialects read differently — `\p{...}`, `\Q…\E`, `\A`/`\z`, lookbehind,
// class set algebra, inline flags, back-references, … — rather than answer JS's reading of a Java
// pattern. It covers every construct the conformance corpus exercises (`^`, `.*`, literal runs,
// `\uXXXX` — `Has.feature` `g_V_hasXname_regexX…X`). Bringing a Java-faithful engine would be a new
// dependency (root working rules); declining the rest is what keeps the subset exact.

/** The reserved bind name the resume's re-injected `within(<survivors>)` at chain position `at` carries.
 *  Underscore-prefixed and mogwai-namespaced so it cannot collide with a user bound-param. It names the
 *  ONE `json_each` bind that survivor set crosses as, and it is PER POSITION because a resumed statement
 *  can hold SEVERAL re-injected `within`s: a further regex in the tail becomes the next segment, whose
 *  resume re-injects into the chain that still carries the first barrier's `within`. A name is the
 *  bind-dedup's REUSE KEY (`keyedValue`, `rel/emit.ts`), so one shared name made both `within`s read ONE
 *  survivor set — `has(name, regex('marko')).out().has(name, regex('lop'))` answered `[]`. Positions in
 *  one chain are distinct, so the names are too. */
const regexSurvivorsParam = (at: number): string => `_mogwai_regex_survivors_${at}`;

/** A `has(key, regex/notRegex(pattern))` occurrence in the chain — the ONLY position regex is lifted
 *  to a barrier. Every other position (`is(regex)`, `where(...regex)`, `match`, a composed predicate)
 *  has no stable membership identity to re-inject onto and stays a fail-closed deferral: the predicate
 *  vocabulary declines regex everywhere (`predicate.ts`), and this finder recognises only the one
 *  shape that maps cleanly. */
export interface RegexBarrier {
  readonly at: number;
  readonly key: string;
  readonly pattern: string;
  readonly negated: boolean;
}

/** Read a `has(key, pred)` step's regex, or `null` if it is not a top-level `has(key, regex)`. The
 *  2-arg form only: `has(label, key, pred)` and a regex nested inside a composed predicate are not
 *  this shape and stay deferred. The pattern is the operand's RESOLVED value (a literal or a bound
 *  parameter alike — a parameter's pattern is still a compile-time-known string for building the
 *  matcher; it is not a SQL bind). */
function regexOf(step: Step): { key: string; pattern: string; negated: boolean } | null {
  if (step.name !== 'has' || step.args.length !== 2) return null;
  const [keyArg, predArg] = step.args;
  if (typeof keyArg!.value !== 'string' || !isPred(predArg!.value)) return null;
  const pred = predArg!.value;
  const negated = pred.op === 'notRegex';
  if (pred.op !== 'regex' && !negated) return null;
  const pattern = pred.operands[0]?.value;
  if (typeof pattern !== 'string') return null;
  return { key: keyArg!.value, pattern, negated };
}

/** THE FIRST regex barrier in the chain, or `null`. Asked beside the `call()` barrier finder so the
 *  EARLIEST boundary wins (`segment.ts`), for the same reason that one is asked before the route:
 *  a regex `has()` is a segment boundary, not a lowering `null`. */
export function regexBarrierIn(steps: readonly Step[]): RegexBarrier | null {
  for (let at = 0; at < steps.length; at++) {
    const found = regexOf(steps[at]!);
    if (found) return { at, ...found };
  }
  return null;
}

/** The chain with the regex `has(key, regex)` at `at` replaced by `has(key, within(<survivors>))` — a
 *  named collection operand, so it lowers to the ONE `json_each` bind (`predicate.ts` `jsonEachInSet`).
 *  The rest of the chain is untouched: the prefix re-narrows the population and the tail continues,
 *  both in ordinary SQL. */
function reinject(steps: readonly Step[], at: number, key: string, survivors: readonly string[]): Step[] {
  const within = arg({ op: 'within', operands: [arg([...survivors], null, regexSurvivorsParam(at))] });
  const has: Step = { ...steps[at]!, args: [arg(key), within] };
  return steps.map((s, i) => (i === at ? has : s));
}

/** A CODE POINT as a `\u{…}` escape — valid in a `u`-flag pattern wherever it sits, so a Java literal
 *  (an escaped punctuator, a stray `}`/`]`) never meets the `u` flag's stricter identity-escape rules. A whole
 *  code point, never a code unit: Java's `Pattern` reads its pattern as code points, so `\😀` is the ONE
 *  character U+1F600, while a `\ud83d` escape followed by a raw low surrogate never pairs under `u` and
 *  matches nothing. */
const unit = (c: string): string => `\\u{${c.codePointAt(0)!.toString(16)}}`;
/** The whole code point starting at `pattern[at]` — both halves of a surrogate pair, as `Pattern` reads it. */
const codePointAt = (pattern: string, at: number): string => String.fromCodePoint(pattern.codePointAt(at)!);
/** Java's `\s` WITHOUT `UNICODE_CHARACTER_CLASS`: `[ \t\n\x0B\f\r]` — JS's `\s` adds every Unicode space. */
const JAVA_SPACE = ' \\t\\n\\x0B\\f\\r';
/** Java's line terminators — what `.` excludes and what `$` may precede (`Pattern` "Line terminators"). */
const JAVA_LINE_END = '\\n\\r\\u0085\\u2028\\u2029';
/** Java's non-MULTILINE `$`: at the end of input, or before ONE final line terminator — never between a
 *  final `\r\n` (`Pattern.Dollar.match`). JS's `$` is the end of input only. */
const JAVA_DOLLAR = '(?:$|(?=\\r\\n$)|(?<!\\r)(?=\\n$)|(?=[\\r\\u0085\\u2028\\u2029]$))';

/**
 * A Java `Pattern` as a JS `RegExp` (`u` flag) that FINDS exactly what `Pattern.compile(p).matcher(v).find()`
 * finds (`Text.java`'s `RegexPredicate`), or `null` when the pattern uses a construct the two dialects read
 * differently — the caller DECLINES then, never answering JS's reading of a Java pattern. Translated, not
 * passed through, where the meaning differs but has an exact JS spelling: `.` (Java excludes `\u0085`),
 * `\s`/`\S` (Java's is ASCII), `$` (Java matches before a final line terminator), and every escaped
 * punctuator (a `\uXXXX`, legal under `u`). The `u` flag makes `.`/a class match a CODE POINT, as Java does
 * (non-`u` JS matches half a surrogate pair). Declined: `\Q…\E`, `\p{…}`, `\A`/`\z`/`\Z`/`\G`/`\R`/`\h`/
 * `\v`/`\b`/`\B` (Java's word boundary is not ASCII before JDK 19), back-references, octal, `\x{…}`, inline
 * flags, atomic groups, lookbehind (Java demands a bound JS does not), a nested class or `&&` intersection
 * (Java set algebra, a literal in JS), a `[]`-leading class, and a `{` that is not a quantifier (a Java
 * syntax error, a literal in JS).
 */
export function javaPatternAsJs(pattern: string): string | null {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') {
      const escape = javaEscape(pattern, i, false);
      if (!escape) return null;
      out += escape.js;
      i = escape.end;
    } else if (c === '[') {
      let j = i + 1;
      let cls = '[';
      if (pattern[j] === '^') { cls += '^'; j++; }
      if (pattern[j] === ']') return null;
      for (; j < pattern.length && pattern[j] !== ']'; j++) {
        const k = pattern[j]!;
        if (k === '[' || (k === '&' && pattern[j + 1] === '&')) return null;
        if (k === '\\') {
          const escape = javaEscape(pattern, j, true);
          if (!escape) return null;
          cls += escape.js;
          j = escape.end;
        } else if (k === '-' || /[A-Za-z0-9 ]/.test(k)) cls += k;
        else { const point = codePointAt(pattern, j); cls += unit(point); j += point.length - 1; }
      }
      if (j >= pattern.length) return null;
      out += `${cls}]`;
      i = j;
    } else if (c === '(') {
      if (pattern[i + 1] !== '?') out += '(';
      else {
        const named = /^\(\?<([A-Za-z][A-Za-z0-9]*)>/.exec(pattern.slice(i));
        const kind = pattern.slice(i, i + 3);
        if (named) { out += named[0]; i += named[0].length - 1; }
        else if (kind === '(?:' || kind === '(?=' || kind === '(?!') { out += kind; i += 2; }
        else return null;
      }
    } else if (c === '{') {
      const quantifier = /^\{\d+(,\d*)?\}/.exec(pattern.slice(i));
      if (!quantifier) return null;
      out += quantifier[0];
      i += quantifier[0].length - 1;
    } else if (c === '.') out += `[^${JAVA_LINE_END}]`;
    else if (c === '$') out += JAVA_DOLLAR;
    else if (c === '}' || c === ']') out += unit(c);
    else { const point = codePointAt(pattern, i); out += point; i += point.length - 1; }
  }
  return out;
}

/** One Java escape at `pattern[at] === '\\'`, as its JS spelling (a class MEMBER spelling when `inClass`)
 *  and the index of its last character — or `null` for an escape the dialects read differently. */
function javaEscape(pattern: string, at: number, inClass: boolean): { js: string; end: number } | null {
  if (at + 1 >= pattern.length) return null;
  const n = codePointAt(pattern, at + 1);   // a CODE POINT: `\😀` escapes the whole astral character
  if ('dDwW'.includes(n) || 'tnrf'.includes(n)) return { js: `\\${n}`, end: at + 1 };
  if (n === 's') return { js: inClass ? JAVA_SPACE : `[${JAVA_SPACE}]`, end: at + 1 };
  if (n === 'S') return inClass ? null : { js: `[^${JAVA_SPACE}]`, end: at + 1 };
  if (n === 'u') return /^[0-9a-fA-F]{4}$/.test(pattern.slice(at + 2, at + 6)) ? { js: pattern.slice(at, at + 6), end: at + 5 } : null;
  if (n === 'x') return /^[0-9a-fA-F]{2}$/.test(pattern.slice(at + 2, at + 4)) ? { js: pattern.slice(at, at + 4), end: at + 3 } : null;
  // A non-alphanumeric escape is that character, literally, in both dialects — the WHOLE code point, so an
  // escaped astral character ends at its low surrogate (`Pattern` reads its pattern as code points).
  if (!/[A-Za-z0-9]/.test(n)) return { js: unit(n), end: at + n.length };
  return null;
}

/** The ONE character a Java escape at `pattern[at] === '\\'` certainly denotes, or `null` when it denotes
 *  a class, an anchor, a control character, or anything else this prefilter will not vouch for — with
 *  the index of the escape's LAST character either way. The escape's extent comes from `javaEscape`, the
 *  same tokenizer `javaPatternAsJs` reads the pattern with, so the two can never disagree about where an
 *  escape ends: `\x61` is ONE atom (`a`), never `\x` followed by the literal run `61`. Decoded, all from
 *  `Pattern`'s escape table: an escaped non-alphanumeric is itself, a whole CODE POINT (`\.` → `.`, `\😀` →
 *  `😀`, never a lone low surrogate left behind as a run), `\xhh` and `\uhhhh` are the code unit they
 *  spell — except a SURROGATE, which Java pairs across escapes and this code-point run could split, so it
 *  ends the run. Every other escape `javaEscape` admits (`\d`, `\s`, `\t`, …) ends the
 *  run; the forms it declines (`\x{h..h}`, `\0ooo`, `\cX`, `\Q..\E`, `\p{..}`, …) never get here, because
 *  `extractMandatoryLiteral` extracts nothing from a pattern `javaPatternAsJs` declines. */
function escapedLiteral(pattern: string, at: number, inClass: boolean): { char: string | null; end: number } | null {
  const escape = javaEscape(pattern, at, inClass);
  if (!escape) return null;
  const n = codePointAt(pattern, at + 1);
  let code: number | null = null;
  if (n === 'x' || n === 'u') code = parseInt(pattern.slice(at + 2, escape.end + 1), 16);
  else if (!/[A-Za-z0-9]/.test(n)) code = n.codePointAt(0)!;   // the whole code point, astral included
  // A NUL is a real character of every match, but SQL text cannot carry it (`textLiteral` declines it), so
  // it ends the run like an uncertain escape: the prefilter only NARROWS, so a shorter run stays exact.
  const certain = code != null && code !== 0 && !(code >= 0xd800 && code <= 0xdfff);
  return { char: certain ? String.fromCodePoint(code!) : null, end: escape.end };
}

/**
 * The longest LITERAL RUN a match must contain (>= 3 code points), or `null`. Used to PREFILTER the
 * barrier's head with `has(key, containing(L))` so the trigram index narrows candidates before the JS
 * regex — the standard trigram-indexed-regex technique (Cox, *Regular Expression Matching with a Trigram
 * Index* / Google Code Search).
 *
 * It NARROWS, never decides: over-selecting is corrected by the exact regex in the barrier, but MISSING
 * a true match would be a WRONG ANSWER — so extraction is CONSERVATIVE. It emits a run only when every
 * match provably contains it, and emits nothing (an honest full scan) whenever unsure — in particular for
 * every pattern `javaPatternAsJs` declines, so the extractor only ever reads the dialect subset whose
 * tokens it shares (`escapedLiteral`). A run is a maximal sequence of EXACTLY-ONCE literal CODE POINTS
 * (an astral character is one atom, so a quantifier after it drops all of it, never half a surrogate
 * pair); a quantifier, a metacharacter (`.`/anchor), a class or a group ENDS it, alternation (`|`) BAILS
 * the whole pattern, and an escape contributes the one character it certainly spells or ends the run.
 * `*`/`?` make the PRECEDING atom optional (drop it); `+` keeps it (>= 1) but ends the run; `{…}` is
 * treated as optional (dropped) — safe under-extraction rather than counting the guaranteed minimum.
 */
export function extractMandatoryLiteral(pattern: string): string | null {
  if (javaPatternAsJs(pattern) == null) return null;
  let best: string[] = [];
  let cur: string[] = [];
  let inClass = false;
  // A GROUP contributes no mandatory literal: it may be optional (`(abc)?`), a lookaround (`(?!abc)`), or
  // open with `?:`/`?<n>` syntax that is no literal at all — reading its text as a run made `(?<n>a)`
  // prefilter on `<n>a` and drop every true match.
  let depth = 0;
  const flush = () => { if (cur.length > best.length) best = cur; cur = []; };
  for (let i = 0; i < pattern.length; i++) {
    const c = String.fromCodePoint(pattern.codePointAt(i)!);
    if (c === '\\') {
      // Every escape, in a class, a group or the top level, is consumed WHOLE — its extent is the
      // tokenizer's, never one character.
      const escape = escapedLiteral(pattern, i, inClass);
      if (!escape) return null;
      i = escape.end;
      if (inClass || depth > 0) continue;
      if (escape.char == null) flush();
      else cur.push(escape.char);
      continue;
    }
    i += c.length - 1;
    if (inClass) {
      if (c === ']') inClass = false;
      continue;                            // a class contributes no mandatory literal
    }
    if (depth > 0) {
      if (c === '[') inClass = true;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      continue;
    }
    switch (c) {
      case '|': return null;                                  // alternation — bail
      case '[': flush(); inClass = true; break;
      case '(': flush(); depth++; break;
      case ')': case '.': case '^': case '$': flush(); break;
      case '*': case '?': cur.pop(); flush(); break;          // preceding atom optional
      case '+': flush(); break;                               // preceding atom mandatory, run ends
      case '{': cur.pop(); flush(); while (i < pattern.length && pattern[i] !== '}') i++; break;
      case '\0': flush(); break;                              // unsayable in SQL text (`textLiteral`)
      default: cur.push(c);                                   // a literal character
    }
  }
  flush();
  return best.length >= 3 ? best.join('') : null;
}

/**
 * Plan the traversal as a regex barrier SEGMENT, or `null` to decline WHOLE (the traversal then fails
 * closed as before — no regression).
 *
 * The head is `prefix [+ has(key, containing(<literal>))] + values(key)`: one candidate VALUE per
 * (element, value) row, over the population the prefix narrowed AND (the TRIGRAM PREFILTER) the elements
 * whose key value contains the regex's mandatory literal run. It must land as a SCALAR `value` read —
 * anything else is a shape this barrier does not know how to read, so it declines rather than guess.
 * `planOf` turns the resumed chain into its `Plan` (chaining a further regex in the tail into the next
 * segment); it is injected so this module does not import `segmentPlan` back.
 */
export function buildRegexSegment(
  steps: readonly Step[], barrier: RegexBarrier, lowering: Lowering, planOf: (steps: readonly Step[]) => Plan,
): SegmentPlan | null {
  const at = barrier.at;
  const prefix = steps.slice(0, at);
  const read: Step = { name: 'values', args: [arg(barrier.key)], ctx: steps[at]!.ctx };
  // TRIGRAM PREFILTER: a regex match must contain the pattern's mandatory literal run, so narrow the
  // head to elements whose key value CONTAINS it — a >=3-char literal reaches the `property_fts` trigram
  // index through the existing `trigramSeek` fast path (`rel/passes/semijoin.ts`), turning the worst case
  // (regex-only, whole graph) from all rows into trigram candidates. `containing` is a case-insensitive
  // SUPERSET, so it can only OVER-select candidates the JS regex then rejects — never drop a true match.
  // Head-only (the resume's `within(<survivors>)` is the semantic authority), and best-effort: if the
  // prefiltered head does not lower, fall back to the bare head, so the prefilter can never turn a
  // working regex into a decline. POSITIVE regex ONLY: a `notRegex` survivor is a NON-match, which need
  // not contain the literal (usually does not) — prefiltering by `containing(L)` would wrongly drop it.
  const literal = barrier.negated ? null : extractMandatoryLiteral(barrier.pattern);
  const prefilter: Step | null = literal
    ? { name: 'has', args: [arg(barrier.key), arg({ op: 'containing', operands: [arg(literal)] })], ctx: steps[at]!.ctx }
    : null;
  const lowered = (prefilter && lowerToRel([...prefix, prefilter, read], lowering))
    || lowerToRel([...prefix, read], lowering);
  const head = valueHead(lowered);
  if (!head) return null;

  // JS-`RegExp`, no `g` flag → `test` is a stateless partial SEARCH (Java `matcher.find()`). A pattern JS
  // cannot compile DECLINES: it is either invalid in Java too — whose answer is `Pattern.compile`'s
  // `PatternSyntaxException` (`Text.java`'s `RegexPredicate` compiles in its constructor), a message this
  // engine cannot reproduce — or valid only in Java's dialect. Either way not the JS `SyntaxError`, which
  // used to reach the user raw. A pattern JS CAN compile is first read as the JAVA pattern it is
  // (`javaPatternAsJs`): passed through raw, `(?<n>a)`/`\Qa\E`/`\p{L}+` silently answered JS's reading.
  const translated = javaPatternAsJs(barrier.pattern);
  if (translated == null)
    throw UnsupportedTraversal.because(`regex(${JSON.stringify(barrier.pattern)}): a construct Java's Pattern and JavaScript read differently`);
  let re: RegExp;
  try { re = new RegExp(translated, 'u'); } catch (error) {
    throw UnsupportedTraversal.because(`regex(${JSON.stringify(barrier.pattern)}): a pattern the JavaScript engine cannot compile (${error instanceof Error ? error.message : String(error)})`);
  }

  // A regex barrier is SYNCHRONOUS (`compiler/segment.ts`) — no `apply`, no `residency`. There is NO
  // async transform: the head is read synchronously, `resume` filters those rows with the regex and
  // re-injects the survivors as `within()`, and the whole thing runs as one atomic stretch that cannot
  // interleave with anything and never leaves the DO. The survivors are VALUES, not detached elements —
  // no `ForeignRow` payload is involved.
  return {
    kind: 'segment',
    mode: 'sync',
    head,
    resume: (headRows: readonly BarrierInput[]): Plan =>
      planOf(reinject(steps, at, barrier.key, survivorsOf(headRows, re, barrier.negated))),
  };
}

/** The DISTINCT candidate values that match — the barrier's whole transform. A non-string value is not
 *  a `P<String>` match under regex or notRegex alike (the LIKE path's `textSubject` type gate), so it
 *  is neither tested nor a survivor. `negated !== test` is Java's `negate != matcher.find()`. */
function survivorsOf(headRows: readonly BarrierInput[], re: RegExp, negated: boolean): string[] {
  const seen = new Set<string>();
  const survivors: string[] = [];
  for (const row of headRows) {
    const value = row.injectedValue;
    if (typeof value !== 'string' || seen.has(value)) continue;
    seen.add(value);
    if (negated !== re.test(value)) survivors.push(value);
  }
  return survivors;
}
