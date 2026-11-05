import { col, type Expr } from './expr.ts';
import { brandRel, type Rel } from './rel.ts';
import { relId, type RelId } from './types.ts';
import { exprRels, forEachExpr, forEachRel, mapRelExprs, rewriteExpr, rewriteRels } from './walk.ts';

/**
 * FRESH NAMES.
 *
 * Two relations may not share a `RelId` in one scope (every `Col` against it becomes ambiguous and
 * the last binding silently wins), and two FROM items may not share a SQL alias (`ambiguous column
 * name`). So any rewrite that introduces a relation — a `seek` probe — has to mint names nothing
 * else in the plan holds. It lives here rather than inside the one pass that uses it today because
 * the rule is the algebra's, not that pass's.
 */

export interface Minter {
  readonly id: (hint: string) => RelId;
  readonly alias: (hint: string) => string;
}

/**
 * Fresh relation ids and SQL aliases that cannot collide with anything already in the given plans.
 *
 * A `src/rel/` pass mints its own rather than taking the lowering's minter, because it may not reach
 * into `src/compiler/` — and because a pass must be runnable over any plan, including one a test
 * hand-built.
 *
 * ⚠️ **Seed it with the WHOLE plan, not the subtree being rewritten.** A name absent from the subtree
 * may still be taken by a sibling, and the collision that produces is a wrong ANSWER — the two
 * relations resolve to one.
 */
export function minter(...plans: readonly Rel[]): Minter {
  const ids = new Set<string>();
  const aliases = new Set<string>();
  for (const plan of plans) forEachRel(plan, (r) => { ids.add(r.id); if (r.kind === 'scan') aliases.add(r.alias); });
  const next = (taken: Set<string>, hint: string): string => {
    let n = 0;
    while (taken.has(`${hint}${n}`)) n++;
    taken.add(`${hint}${n}`);
    return `${hint}${n}`;
  };
  return { id: (hint) => relId(next(ids, hint)), alias: (hint) => next(aliases, hint) };
}

/**
 * A COPY of an expression whose correlated subplans may stand beside the original — every relation it
 * defines re-minted (id, and a scan's alias), every `Col` naming one re-pointed — or `null` where a
 * subplan holds something a copy cannot faithfully duplicate: a `Recursive` (its term is a closure over
 * its own self-reference) or a `Materialize` (a named CTE boundary — two copies would be two bindings).
 *
 * Two relations may not share a `RelId` (`minter`), so an expression with a subplan can appear in a
 * second place only as a copy. Columns naming relations OUTSIDE the expression are left alone: they are
 * its correlations, and the copy is correlated exactly as the original was.
 */
export function freshCopy(e: Expr, mint: Minter): Expr | null {
  const renamed = new Map<RelId, RelId>();
  let opaque = false;
  forEachExpr(e, (node) => exprRels(node).forEach((plan) => forEachRel(plan, (r) => {
    if (r.kind === 'recursive' || r.kind === 'self-ref' || r.kind === 'materialize') opaque = true;
    if (!renamed.has(r.id)) renamed.set(r.id, mint.id('cp'));
  })));
  if (opaque) return null;
  if (!renamed.size) return e;
  const swap = (node: Expr): Expr => (node.kind === 'col' && renamed.has(node.rel) ? col(renamed.get(node.rel)!, node.name) : node);
  const memo = new Map<Rel, Rel>();
  const copy = (plan: Rel): Rel => rewriteRels(plan, (mapped) => {
    const own = mapRelExprs(mapped, (x) => rewriteExpr(x, swap));
    return brandRel({ ...own, id: renamed.get(mapped.id)!, ...(own.kind === 'scan' ? { alias: mint.alias('rcp') } : {}) } as typeof own);
  }, memo);
  return rewriteExpr(e, swap, copy);
}
