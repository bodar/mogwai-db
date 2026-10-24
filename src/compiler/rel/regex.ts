import type { Step } from '../../gremlin/frontend.ts';
import { arg, isPred } from '../../gremlin/frontend.ts';
import type { BarrierInput } from '../../services/spi/types.ts';
import type { Plan, SegmentPlan } from '../segment.ts';
import { lowerToRel, type Lowering } from './lower.ts';
import { valueHead } from './barrier-value.ts';
import { UnsupportedTraversal } from '../unsupported.ts';
import { compilerParamName } from '../../rel/expr.ts';

// ---------- regex as a barrier — `has(key, TextP.regex(...))`, on the RelIR route ----------
//
// DO SQLite has no regex function and this project does not filter the TRAVERSAL row-at-a-time
// (root `CLAUDE.md` decision #3), so `regex` cannot lower to SQL like `containing`/`startingWith`
// (LIKE) do. It lowers instead as a BARRIER — the one admissible home for a non-SQL predicate
// (`docs/archive/2026-08-12-regex-as-a-barrier-research.md`): a SQL head narrows and projects the candidate
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
// The PATTERN is read in JS's dialect too (`compileRegex`), not translated from Java's: where the two
// differ (`$` before a final newline, `\s`'s Unicode spaces, `\p{…}`, `\Q…\E`, …) the answer is the
// JS reading — an accepted divergence (`docs/feature-support-matrix.md`, Deliberate divergences). Every
// construct the conformance corpus exercises (`^`, `.*`, literal runs, `\uXXXX` — `Has.feature`
// `g_V_hasXname_regexX…X`) reads the same in both.

/** The reserved bind name the resume's re-injected `within(<survivors>)` at chain position `at` carries.
 *  Minted by `compilerParamName`, so no user parameter can spell it (`rel/expr.ts`). It names the
 *  ONE `json_each` bind that survivor set crosses as, and it is PER POSITION because a resumed statement
 *  can hold SEVERAL re-injected `within`s: a further regex in the tail becomes the next segment, whose
 *  resume re-injects into the chain that still carries the first barrier's `within`. A name is the
 *  bind-dedup's REUSE KEY (`keyedValue`, `rel/emit.ts`), so one shared name made both `within`s read ONE
 *  survivor set — `has(name, regex('marko')).out().has(name, regex('lop'))` answered `[]`. Positions in
 *  one chain are distinct, so the names are too. */
const regexSurvivorsParam = (at: number): string => compilerParamName(`regex_survivors_${at}`);

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

/** A backslash (not itself escaped) before a high surrogate. */
const ESCAPED_ASTRAL = /(?:^|[^\\])(?:\\\\)*\\[\ud800-\udbff]/;

/** The pattern as a JS `RegExp`: the `u` flag first (code-point matching, the modern dialect), then no
 *  flag (Annex B's lenient reading — `\-`, a literal `{`, an escaped astral half, …), and ONE
 *  `UnsupportedTraversal` when neither compiles, never the raw JS `SyntaxError`. No `g` flag, so `test`
 *  is a stateless partial SEARCH — Java's `matcher.find()`. The dialect is JS's, an accepted divergence
 *  (`docs/feature-support-matrix.md`, Deliberate divergences). */
export function compileRegex(pattern: string): RegExp {
  // An escaped ASTRAL character is a `u`-mode SyntaxError by the spec (V8, the DO runtime), but JSC (Bun)
  // accepts it as an escaped lone high surrogate that never matches — so skip `u` and let both runtimes
  // take the non-`u` reading, where `\😀` is the two halves in sequence, i.e. the character.
  if (!ESCAPED_ASTRAL.test(pattern))
    try { return new RegExp(pattern, 'u'); } catch { /* fall through to the non-`u` reading */ }
  try { return new RegExp(pattern); } catch (error) {
    throw UnsupportedTraversal.because(`regex(${JSON.stringify(pattern)}): not a valid JavaScript regular expression (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** Escapes whose letter is safe to read: a class (`\d\D\w\W\s\S`), a control character (`\t\n\r\f`) or an
 *  anchor (`\b\B`) — each just ENDS a literal run. Any other alphanumeric escape (`\x41`, `A`, `\cA`,
 *  `\0`, a back-reference, `\p{…}`, `\k<n>`, …) makes the scanner extract nothing. */
const RUN_BREAKING_ESCAPES = new Set('dDwWsStnrfbB');
/** A lone surrogate half: SQL text cannot carry one faithfully, so it ends a run like a NUL does. */
const isSurrogate = (c: string): boolean => c.length === 1 && c >= '\ud800' && c <= '\udfff';

/**
 * The longest LITERAL RUN a match must contain (>= 3 code points), or `null`. Used to PREFILTER the
 * barrier's head with `has(key, containing(L))` so the trigram index narrows candidates before the JS
 * regex — the standard trigram-indexed-regex technique (Cox, *Regular Expression Matching with a Trigram
 * Index* / Google Code Search).
 *
 * It NARROWS, never decides: over-selecting is corrected by the exact regex in the barrier, but MISSING
 * a true match would be a WRONG ANSWER — so the scan is CONSERVATIVE, over the RAW pattern, and holds
 * under both readings `compileRegex` may pick (`u` and non-`u`). A run is a maximal sequence of
 * exactly-once literal CODE POINTS. A quantifier, `.`, an anchor, a class, a group or a safe escape ENDS
 * it; a top-level `|` or any other alphanumeric escape BAILS the whole pattern; an escaped
 * non-alphanumeric is that character. `*`/`?`/`{…}` drop the preceding atom; `+` keeps it and ends the
 * run. A NUL or a lone surrogate also ends it (SQL text cannot carry either — `textLiteral`).
 */
export function extractMandatoryLiteral(pattern: string): string | null {
  let best: string[] = [];
  let cur: string[] = [];
  let inClass = false;
  let depth = 0;   // a group contributes nothing: it may be optional, a lookaround, or `(?<n>…)` syntax
  const flush = () => { if (cur.length > best.length) best = cur; cur = []; };
  for (let i = 0; i < pattern.length; i++) {
    const c = String.fromCodePoint(pattern.codePointAt(i)!);
    i += c.length - 1;
    if (c === '\\') {
      if (i + 1 >= pattern.length) return null;
      const next = String.fromCodePoint(pattern.codePointAt(i + 1)!);
      i += next.length;
      const alnum = /^[A-Za-z0-9]$/.test(next);
      if (alnum && !RUN_BREAKING_ESCAPES.has(next)) return null;
      if (inClass || depth > 0) continue;
      if (alnum || next === '\0' || isSurrogate(next)) flush();
      else cur.push(next);
      continue;
    }
    if (inClass) { if (c === ']') inClass = false; continue; }
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
      case ')': case '.': case '^': case '$': case '\0': flush(); break;
      case '*': case '?': cur.pop(); flush(); break;          // preceding atom optional
      case '+': flush(); break;                               // preceding atom mandatory, run ends
      case '{': {                                             // a quantifier drops its atom; else a run-breaker
        const quantifier = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i));
        if (quantifier) { cur.pop(); i += quantifier[0].length - 1; }
        flush();
        break;
      }
      default: if (isSurrogate(c)) flush(); else cur.push(c);
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
  // (regex-only, whole graph) from all rows into trigram candidates. Every match contains that run exactly,
  // so `containing` (exact too) is a SUPERSET: it can only OVER-select candidates the JS regex then rejects — never drop a true match.
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

  const re = compileRegex(barrier.pattern);

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
