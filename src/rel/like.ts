import { compilerText, type Expr } from './expr.ts';
import { rewriteExpr } from './walk.ts';

/**
 * The LIKE ESCAPE ENCODING of a substring term, and its one inverse.
 *
 * `likePattern` (`src/compiler/rel/predicate.ts`) spells a TextP term as an escaped LIKE pattern so the user's
 * `%`/`_`/`\` match themselves; the `property_fts` readers (`trigramSeek` in `passes/semijoin.ts`,
 * `tinker.search`) need the term back UNESCAPED for the index probe. Encoder and decoder read one table, so the
 * two cannot drift. It lives in `src/rel/` because the decoder's caller is a RelIR pass, and `src/rel/` imports
 * nothing from `src/compiler/`.
 */

/** The escapes, innermost first: `replace(replace(replace(X,'\','\\'),'%','\%'),'_','\_')`. */
const LIKE_ESCAPES: readonly (readonly [string, string])[] = [['\\', '\\\\'], ['%', '\\%'], ['_', '\\_']];

/** `term` with its LIKE metacharacters escaped (for a `like(pattern, subject, '\')`). `term` stays whatever the
 *  user sent — a compiler-text literal, or a wire parameter, which must not be folded to its current value. */
export const likeEscaped = (term: Expr): Expr =>
  LIKE_ESCAPES.reduce<Expr>((x, [from, to]) => ({ kind: 'call', fn: 'replace', args: [x, compilerText(from), compilerText(to)] }), term);

/** The `X` of a `likeEscaped(X)` chain, or `null` for any other expression. */
function escapedTerm(e: Expr): Expr | null {
  let x = e;
  for (let i = LIKE_ESCAPES.length - 1; i >= 0; i--) {
    const [from, to] = LIKE_ESCAPES[i]!;
    if (x.kind !== 'call' || x.fn !== 'replace' || x.args.length !== 3) return null;
    const [inner, f, t] = x.args as readonly [Expr, Expr, Expr];
    if (f.kind !== 'lit' || f.value !== from || t.kind !== 'lit' || t.value !== to) return null;
    x = inner;
  }
  return x;
}

/**
 * The TRIGRAM PROBE form of an escaped LIKE pattern: every `likeEscaped(X)` chain collapsed to its raw `X`, the
 * `%` prefix/suffix shape kept — with the (first) term `X` beside it — or `null` for a pattern that holds no chain.
 *
 * Why the probe is unescaped: FTS5's trigram tokenizer serves `text LIKE p` from its index only when `xBestIndex`
 * is offered the LIKE CONSTRAINT, which SQLite offers for the infix operator and the TWO-argument `like(p, text)`
 * alone. The three-argument `like(p, text, '\')` an escaped pattern needs is an opaque function call to it, so the
 * table is SCANNED (`VIRTUAL TABLE INDEX 0:` in the plan, where the probe reads `INDEX 0:L…`) and every row
 * re-checked — pinned in `test/L2-sql/filter.sql.test.ts`. Unescaped, a user's `%`/`_` is a wildcard again, which
 * only WIDENS what the probe admits; `\` was never special to a LIKE without ESCAPE. So the probe is a SUPERSET
 * access path and never an answer: its caller keeps the escaped LIKE (or the whole generic predicate) as the test.
 */
export function likeProbePattern(pattern: Expr): { readonly pattern: Expr; readonly term: Expr } | null {
  let term: Expr | null = null;
  const probe = rewriteExpr(pattern, (n) => {
    const x = escapedTerm(n);
    if (!x) return n;
    term ??= x;
    return x;
  });
  return term ? { pattern: probe, term } : null;
}

/** `text LIKE pattern` in the two-argument form FTS5's `xBestIndex` can serve from the trigram index — the one
 *  spelling every `property_fts` seek probes by. Case-blind and wildcard-widened (`likeProbePattern`), so it is a
 *  SUPERSET: the caller always keeps an exact test beside it. */
export const trigramProbe = (pattern: Expr, text: Expr): Expr => ({ kind: 'call', fn: 'like', args: [pattern, text] });
