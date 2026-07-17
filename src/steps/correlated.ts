import { Query, derived, q, type Expression, type Relation } from '../q.ts';
import { type Step } from '../frontend.ts';
import { type Elem } from '../plan.ts';
import { normalize } from '../strategies.ts';
import { DEFAULT_FAST_PATHS, type FastPathConfig } from '../fast-paths.ts';
import { type ElementStream } from './context.ts';
import { lowerElementSteps } from './index.ts';

// ---------- correlated inline-child rendering ----------
//
// The correlated predicate fast path (where/filter/and/or/choose/until) is the GENERIC
// child pipeline rendered in an inline-correlated MODE: the real movement/filter StepFns
// compile the child body, but instead of registering materialized CTEs they emit nested
// correlated `derived()` subqueries seeded from the outer row's id. Same StepFns, same
// plumbing — only the rendering differs (an EXPLAIN shows the nested-derived form stays
// index-only, far leaner than the materialized child-existence gate; see the equivalence
// test in test/compiler.test.ts).
//
// Alias safety (the crux): each StepFn wraps the previous relation as a FROM-clause
// derived table (`(<prev>) p`), and SQL FROM-clause derived tables are NOT laterally
// visible to their siblings. So the innermost seed's correlated reference to the outer
// row (e.g. `n.id` / a walk row's `e.tgt`) can never bind to an intermediate `nodes n` /
// `edges e` the child's own StepFns introduce — those live behind FROM boundaries. The
// reference resolves outward through the WHERE-clause EXISTS boundary to the true outer
// scope. This is why the child needs no bespoke `xe`/`xn` alias scheme (the flat
// hand-rolled EXISTS did, to avoid a self-shadow).

/** A `Query`-shaped context for an inline correlated child: `.cte` returns a nested
 *  `derived()` subquery (alias `x0,x1,…`, distinct from the outer's `c*`/`n`/`p`/`e`)
 *  instead of registering a shared CTE, so the movement/filter fold emits nested
 *  correlated relations with no change to `advance`/`Carry`. A correlated child has no
 *  shared WITH and is never rendered standalone, and a recursive term cannot reference
 *  an outer row — so `.recursiveCte`/`.render` are unreachable here and fail closed. */
class InlineQuery extends Query {
  private k = 0;
  override cte(body: Expression, cols: readonly string[] = ['id']): Relation {
    return derived(body, cols, `x${++this.k}`);
  }
  override recursiveCte(): never {
    throw new Error('correlated inline child cannot contain a recursive CTE (repeat())');
  }
  override render(): never {
    throw new Error('correlated inline child is never rendered standalone');
  }
}

/**
 * Compile a movement/filter child body as ONE nested correlated relation seeded from
 * `idExpr` (the outer row's id — the current traverser's `n.id`, an aliased column, or a
 * recursive-walk row's id). The real StepFns fold over an `ElementStream` whose Query is
 * the inline shim, so the body's movement (out/in/both/…E/…V) and current-element filters
 * (has/hasLabel/hasId/where/…) render exactly as they do at root, just as nested
 * subqueries. Returns `{ rel, elem }` iff the WHOLE body consumed as pure movement +
 * current-element filter and introduced no carried columns (aliases/path/origin); returns
 * null otherwise, so the caller keeps its clear deferral / falls through to the
 * materialized generic gate. Depends ONLY on (idExpr, body, params) — never the outer
 * Query — so it serves until()'s recursive-CTE predicate (correlate on the walk id)
 * identically to where()/filter()/choose().
 */
export function compileCorrelatedChild(
  idExpr: Expression,
  body: Step[],
  params: Record<string, any> = {},
  fastPaths: FastPathConfig = DEFAULT_FAST_PATHS,
): { rel: Relation; elem: Elem } | null {
  const steps = normalize(body).steps;
  const seed: ElementStream = {
    kind: 'elements',
    q: new InlineQuery(),
    params,
    fastPaths,
    rel: derived(q`SELECT ${idExpr} AS id`, ['id'], 'x0'),
    elem: 'node',
    carried: { aliases: new Map(), origins: [] },
  };
  const { stream, next } = lowerElementSteps(steps, seed);
  if (next !== steps.length) return null;
  // The correlated form carries no per-traverser schema (a bare id relation); a body that
  // bound an alias / path / origin is not a pure movement+filter chain → fall through.
  if (stream.carried.aliases.size || stream.carried.path || stream.carried.origins.length) return null;
  return { rel: stream.rel, elem: stream.elem };
}
