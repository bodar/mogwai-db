// ---------- format(): the template PARSE ----------
//
// TinkerPop's `format("…%{token}…")` substitutes `%{name}` and `%{_}` references in a
// template with property values, scope values or `by()` modulator results, and filters
// the traverser when any reference cannot be resolved
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/
// traversal/step/map/FormatStep.java`).
//
// What is SHAREABLE is the split into literal and token parts, and only that — unlike
// `math()`, a template part carries no non-derivable SQL fact, so the shared form is a
// plain part list rather than an ops record. Each spine then resolves the tokens in its
// own object model and concatenates in its own algebra.
//
// It lives here for the reason `validate.ts` and `coerce.ts` do: the PATTERN is
// TinkerPop's, not a lowering's, and re-deriving it is how the two spines came to
// disagree about the escape (below).

/** One piece of a parsed template. A `token` names a variable; the reference resolves
 *  `_` through the `by()` ring and anything else as a property-then-scope-key read. */
export type FormatPart =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'token'; readonly name: string };

/** TinkerPop's name for "take the next `by()` modulator" (`FormatStep.FROM_BY`). */
export const FORMAT_FROM_BY = '_';

/**
 * THE REFERENCE'S PATTERN, VERBATIM — `(?<!%)%\{(.*?)\}` (`FormatStep.VARIABLE_PATTERN`).
 *
 * Two details, and both were wrong in the hand-rolled copies this replaces:
 *
 * - **the negative lookbehind is an ESCAPE.** `%%{x}` is not a variable and is copied
 *   through as literal text — nothing is unescaped, the reference simply does not match
 *   there. A pattern without it reads `%%{x}` as a reference to `x` and then filters the
 *   traverser when `x` does not resolve, which is a wrong answer with the right arity.
 * - **the body is LAZY** (`.*?`), so `%{a}%{b}` is two tokens rather than one named
 *   `a}%{b`. A greedy `[^}]*` agrees on every template without a `}` inside a name and
 *   differs the moment one appears.
 */
const VARIABLE_PATTERN = /(?<!%)%\{(.*?)\}/g;

/**
 * Split a template into its alternating literal and token parts, in order.
 *
 * Empty literals are never emitted, so a part list is exactly what a concatenation
 * needs. A template with no tokens is one literal (or, for `""`, no parts at all —
 * which is the empty string, not a missing value).
 */
export function formatTemplate(template: string): readonly FormatPart[] {
  const parts: FormatPart[] = [];
  let last = 0;
  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    const at = match.index!;
    if (at > last) parts.push({ kind: 'literal', text: template.slice(last, at) });
    parts.push({ kind: 'token', name: match[1]! });
    last = at + match[0].length;
  }
  if (last < template.length) parts.push({ kind: 'literal', text: template.slice(last) });
  return parts;
}
