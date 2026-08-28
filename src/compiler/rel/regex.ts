import type { Step } from '../../gremlin/frontend.ts';
import { arg, isPred } from '../../gremlin/frontend.ts';
import type { BarrierInput } from '../../services/spi/types.ts';
import type { Plan, SegmentPlan } from '../segment.ts';
import { lowerToRel, type Lowering } from './lower.ts';
import { valueHead } from './barrier-value.ts';

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
// We COMMIT to JS-`RegExp` semantics. It agrees with Java `Pattern` on every construct the conformance
// corpus exercises (`^`, `.*`, literal runs, `\uXXXX` — `Has.feature` `g_V_hasXname_regexX…X`). It
// DIVERGES on Java-only constructs no corpus scenario uses — Unicode property escapes `\p{...}` under
// Java rules, possessive quantifiers, `\A`/`\z`, Java named-group syntax — and a pattern that is valid
// in Java but not in JS throws a clear query failure at compile (a user typo, not a crash). Bringing a
// Java-faithful engine would be a new dependency (root working rules); the committed divergence is the
// deliberate product decision that unblocks the wall.

/** The reserved bind name the resume's re-injected `within(<survivors>)` carries. Underscore-prefixed
 *  and mogwai-namespaced so it cannot collide with a user bound-param. It
 *  names the ONE `json_each` bind the survivor set crosses as; only one such `within` exists per
 *  resumed statement (a further regex in the tail becomes the NEXT segment), so there is nothing for
 *  the bind-dedup to conflate. */
const REGEX_SURVIVORS_PARAM = '_mogwai_regex_survivors';

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
function reinject(steps: readonly Step[], at: number, key: string, survivors: readonly unknown[]): Step[] {
  const within = arg({ op: 'within', operands: [arg([...survivors], null, REGEX_SURVIVORS_PARAM)] });
  const has: Step = { ...steps[at]!, args: [arg(key), within] };
  return steps.map((s, i) => (i === at ? has : s));
}

/** The regex metacharacters an escape turns into a literal: `\.` is a literal `.`. */
const METACHARS = new Set(['.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '^', '$', '\\', '/']);

/**
 * The longest LITERAL RUN a match must contain (>= 3 chars), or `null`. Used to PREFILTER the barrier's
 * head with `has(key, containing(L))` so the trigram index narrows candidates before the JS regex — the
 * standard trigram-indexed-regex technique (Cox, *Regular Expression Matching with a Trigram Index* /
 * Google Code Search).
 *
 * It NARROWS, never decides: over-selecting is corrected by the exact regex in the barrier, but MISSING
 * a true match would be a WRONG ANSWER — so extraction is CONSERVATIVE. It emits a run only when every
 * match provably contains it, and emits nothing (an honest full scan) whenever unsure. A run is a
 * maximal sequence of EXACTLY-ONCE literal characters; a quantifier, a metacharacter (`.`/class/anchor/
 * group), or a class ENDS it, alternation (`|`) BAILS the whole pattern, and an escaped metacharacter
 * (`\.`) contributes its literal char while any other escape (`\d`, `\uXXXX`, …) ends the run. `*`/`?`
 * make the PRECEDING char optional (drop it); `+` keeps it (>= 1) but ends the run; `{…}` is treated as
 * optional (dropped) — safe under-extraction rather than counting the guaranteed minimum.
 */
export function extractMandatoryLiteral(pattern: string): string | null {
  let best = '';
  let cur = '';
  let inClass = false;
  const flush = () => { if (cur.length > best.length) best = cur; cur = ''; };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (inClass) {
      if (c === '\\') i++;                 // skip an escaped char inside the class
      else if (c === ']') inClass = false;
      continue;                            // a class contributes no mandatory literal
    }
    switch (c) {
      case '|': return null;                                  // alternation — bail
      case '[': flush(); inClass = true; break;
      case '(': case ')': case '.': case '^': case '$': flush(); break;
      case '*': case '?': cur = cur.slice(0, -1); flush(); break;  // preceding char optional
      case '+': flush(); break;                               // preceding char mandatory, run ends
      case '{': cur = cur.slice(0, -1); flush(); while (i < pattern.length && pattern[i] !== '}') i++; break;
      case '\\': {
        const next = pattern[i + 1];
        i++;
        if (next !== undefined && METACHARS.has(next)) cur += next;   // `\.` → literal `.`
        else flush();                                                 // `\d`/`\uXXXX`/… → run-breaker
        break;
      }
      default: cur += c;                                      // a literal character
    }
  }
  flush();
  return best.length >= 3 ? best : null;
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

  // JS-`RegExp`, no `g` flag → `test` is a stateless partial SEARCH (Java `matcher.find()`). A pattern
  // valid in Java but not in JS throws here — a clear compile-time query failure, the committed
  // divergence's honest failure mode rather than a silent different answer.
  const re = new RegExp(barrier.pattern);

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
function survivorsOf(headRows: readonly BarrierInput[], re: RegExp, negated: boolean): unknown[] {
  const seen = new Set<string>();
  const survivors: unknown[] = [];
  for (const row of headRows) {
    const value = row.injectedValue;
    if (typeof value !== 'string' || seen.has(value)) continue;
    seen.add(value);
    if (negated !== re.test(value)) survivors.push(value);
  }
  return survivors;
}
