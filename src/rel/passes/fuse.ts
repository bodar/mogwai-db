import type { Expr } from '../expr.ts';
import { filter } from '../factory.ts';
import type { Rel } from '../rel.ts';
import type { RelId } from '../types.ts';
import { mapRelExprs, rewrite, rewriteExpr } from '../walk.ts';

/** Re-point every `Col` naming one relation at another, including inside correlated subplans —
 * a `Scalar`/`Exists`/`InQuery` body may reference the relation being fused away. */
const rebind = (expression: Expr, from: RelId, to: RelId): Expr => {
  const column = (e: Expr): Expr => (e.kind === 'col' && e.rel === from ? { ...e, rel: to } : e);
  const inside = (plan: Rel): Rel => rewrite(plan, (node) => mapRelExprs(node, (e) => rewriteExpr(e, column, inside)));
  return rewriteExpr(expression, column, inside);
};

/** Structural fusion with no cost model: adjacent filters become one predicate. */
export function fuse(plan: Rel): Rel {
  return rewrite(plan, (r) => {
    if (r.kind !== 'filter' || r.input.kind !== 'filter') return r;
    const input = r.input;
    const pred: Expr = { kind: 'binary', op: 'and', left: input.pred, right: rebind(r.pred, input.id, input.input.id) };
    return filter({ id: r.id, input: input.input, layout: r.layout, type: r.type, pred });
  });
}
