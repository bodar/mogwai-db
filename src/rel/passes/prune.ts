import { channelCols } from '../../channels.ts';
import type { Expr } from '../expr.ts';
import { project } from '../factory.ts';
import type { Rel } from '../rel.ts';
import type { RelId } from '../types.ts';
import { forEachExpr, relChildren, relExprs, rewrite } from '../walk.ts';

const refs = (expression: Expr, relation: RelId, out: Set<string>): void =>
  forEachExpr(expression, (e) => { if (e.kind === 'col' && e.rel === relation) out.add(e.name); });

/**
 * Remove unobserved Project outputs while preserving every carried channel.
 *
 * Two passes, because the plan is a DAG: a shared node has more than one consumer, and pruning it
 * to what ONE parent reads breaks the other. Pass 1 accumulates each node's need as the UNION over
 * its consumers, to a fixpoint; pass 2 rebuilds bottom-up through the sharing-preserving rewrite.
 *
 * Only `Project` outputs are pruned. Below a `Join`/`Union`/`Aggregate`/`Recursive` every declared
 * column is required, so the walk continues but prunes nothing — the column-level rules for those
 * nodes are the pass's declared remainder, not an accident of where the recursion stopped.
 */
export function prune(plan: Rel, required: readonly string[] = plan.type.cols.map((col) => col.name)): Rel {
  const needs = new Map<Rel, Set<string>>();
  const queue: Rel[] = [];
  const require = (r: Rel, cols: Iterable<string>): void => {
    const need = needs.get(r) ?? new Set<string>();
    const before = need.size;
    for (const col of cols) need.add(col);
    if (!needs.has(r) || need.size !== before) { needs.set(r, need); queue.push(r); }
  };
  const preserves = (r: Rel): boolean =>
    r.kind === 'filter' || r.kind === 'sort' || r.kind === 'limit' || r.kind === 'distinct'
    || r.kind === 'window' || r.kind === 'explode' || r.kind === 'materialize';

  require(plan, required);
  while (queue.length) {
    const r = queue.pop()!;
    const need = new Set(needs.get(r));
    if (r.kind === 'project') {
      const keep = new Set([...need, ...channelCols(r.channels)]);
      const inputNeed = new Set(channelCols(r.input.channels));
      r.exprs.filter(([name]) => keep.has(name)).forEach(([, expression]) => refs(expression, r.input.id, inputNeed));
      require(r.input, inputNeed);
      continue;
    }
    for (const child of relChildren(r)) {
      const childNeed = new Set(preserves(r) ? [...need, ...channelCols(child.channels)] : child.type.cols.map((col) => col.name));
      for (const expression of relExprs(r)) refs(expression, child.id, childNeed);
      require(child, childNeed);
    }
  }

  return rewrite(plan, (mapped, original) => {
    if (mapped.kind !== 'project') return mapped;
    const keep = new Set([...(needs.get(original) ?? []), ...channelCols(mapped.channels)]);
    const exprs = mapped.exprs.filter(([name]) => keep.has(name));
    if (exprs.length === mapped.exprs.length) return mapped;
    return project({
      id: mapped.id, input: mapped.input, channels: mapped.channels,
      type: { cols: mapped.type.cols.filter((col) => keep.has(col.name)) }, exprs,
    });
  });
}
