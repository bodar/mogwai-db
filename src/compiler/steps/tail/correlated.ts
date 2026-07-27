import { Query, derived, q, list, raw, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { type Step } from '../../../gremlin/frontend.ts';
import { type Elem } from '../../plan/plan.ts';
import { normalize } from '../../ir/passes.ts';
import { aliasColsOf, type Carried, type ElementStream, type LabelScope } from '../context/context.ts';
import type { Engine } from '../../engine/deps.ts';
import { mentionsLabel } from './child-shape.ts';

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
 * subqueries. Returns `{ rel, elem }` iff the WHOLE body consumed through the engine's one
 * element-body fold; null otherwise, so the caller keeps its clear deferral / falls through
 * to the materialized generic gate.
 *
 * `labels` is the outer row's LABEL SCHEMA (its alias map + the relation physically holding
 * the histories at the splice point). Supplied, its columns are PROJECTED INTO THE SEED, so
 * the correlated child carries the same per-traverser alias schema a materialized child gets
 * from pushChildScope — which is what lets as()/select(label)/where(label)/dedup(label)
 * compose inside a correlated body at any depth, with no second label mechanism. Omitted (a
 * site with no such relation in scope: until()/emit(), whose predicate rides the recursive
 * term's walk row), the body must not MENTION a label at all — see the decline below.
 *
 * Otherwise depends only on (idExpr, body, params) — never the outer Query — so it serves
 * until()'s recursive-CTE predicate identically to where()/filter()/choose().
 */
export function compileCorrelatedChild(
  engine: Engine,
  idExpr: Expression,
  body: Step[],
  params: Record<string, any> = {},
  labels?: LabelScope,
): { rel: Relation; elem: Elem } | null {
  const steps = normalize(body).steps;
  // With no LabelScope the seed is a bare id, so an alias column is physically absent here — and
  // absent is exactly what selectOneFromAlias reads as "never bound → drop every traverser". A
  // label is then outside this renderer's vocabulary entirely, so decline the body (rather than
  // answer it empty) and let the materialized generic gate, which carries the whole schema, have
  // it. WITH a scope the columns are really present, so an absent one is a genuinely unbound
  // label and the same drop-every-traverser answer is the correct one.
  if (!labels && mentionsLabel(steps, params)) return null;
  // A variant engine bound to a fresh InlineQuery (nested derived subqueries, not shared CTEs),
  // sharing the parent engine's fastPaths — so the movement/filter StepFns read the right config.
  const inlineEngine = engine.withQuery(new InlineQuery());
  const aliasCols = labels ? aliasColsOf(labels.aliases) : [];
  const carried: Carried = { aliases: labels?.aliases ?? new Map(), origins: [] };
  // The alias columns correlate OUTWARD exactly as `idExpr` does: a FROM-clause derived table is
  // not laterally visible to its siblings, so `p.a0` here resolves through the EXISTS boundary to
  // the true outer scope, never to an intermediate the child's own StepFns introduce. From the
  // seed on they are ordinary carried columns — every movement/filter CTE threads them via
  // carryFrag, with no change to `advance`/`Carry`.
  const seedProj = [q`${idExpr} AS id`, ...aliasCols.map((c) => q`${labels!.rel.c[c]} AS ${raw(c)}`)];
  const seed: ElementStream = {
    kind: 'elements',
    q: inlineEngine.q,
    params,
    rel: derived(q`SELECT ${list(seedProj, ', ')}`, ['id', ...aliasCols], 'x0'),
    elem: 'node',
    carried,
  };
  const stream = inlineEngine.tryLowerElementSteps(steps, seed);
  if (!stream) return null;
  // Alias columns are INERT to every consumer of this relation — each one reduces it to a boolean
  // or a scalar (EXISTS, COUNT, a projected LIMIT 1), so a seeded column riding through, or a
  // bind inside the body appending another, cannot change the answer. TinkerPop confines a bind
  // made inside a filter body anyway, which is precisely what dropping the relation does to it.
  // path/origins are different: they mean the body was NOT a pure movement+filter chain, so fall
  // through to the generic gate.
  if (stream.carried.path || stream.carried.origins.length) return null;
  return { rel: stream.rel, elem: stream.elem };
}
