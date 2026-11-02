import type { Expr } from './expr.ts';
import type { Rel } from './rel.ts';

/** How many rows a relation can yield: `min <= rows <= max`, `max = Infinity` where nothing bounds it. */
export interface RowBounds { readonly min: number; readonly max: number }

const UNBOUNDED: RowBounds = { min: 0, max: Infinity };

/** A compile-time row count — a literal the query TEXT fixed. A user PARAMETER is not one: its value is
 *  the user's to vary, so a plan must not depend on it (`bindsAsParameter`, `src/rel/expr.ts`). */
const literalCount = (expr: Expr): number | null =>
  expr.kind === 'lit' && expr.source !== 'parameter' && (typeof expr.value === 'number' || typeof expr.value === 'bigint')
    ? Math.max(0, Number(expr.value)) : null;

/** An ON that holds for every pair — absent, or a constant true literal. */
const provablyTrue = (on: Expr | undefined): boolean =>
  !on || (on.kind === 'lit' && on.source !== 'parameter' && (on.value === true || on.value === 1));

/**
 * THE ROW-COUNT AUTHORITY — the bounds on how many rows `rel` yields, as compile-time metadata over the
 * closed node set. Calcite's `RelMdMinRowCount`/`RelMdMaxRowCount` (`vendor/calcite/core/src/main/java/org/
 * apache/calcite/rel/metadata/RelMdMaxRowCount.java`) are the prior art, one handler per node kind.
 *
 * Callers ask `rowBounds(r).max <= 1` (a correlated SCALAR subquery is sound: SQL takes the first row of
 * whatever it is given, so several rows is an answer chosen by scan order) or `exactlyOneRow(r)` (a child's
 * `'always'` presence claim: over zero rows a scalar subquery reads NULL, and a host that kept the row
 * anyway has kept a traverser the body dropped — `TraversalMapStep.processNextStart` emits nothing on an
 * empty body, `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TraversalMapStep.java`).
 *
 * It is a SUFFICIENT bound, not an exact one, and every arm errs WIDER: a too-narrow `max` costs an
 * arbitrary row, a too-high `min` a traverser the body dropped; a too-wide bound costs only a guard or
 * a decline.
 */
export function rowBounds(rel: Rel): RowBounds {
  switch (rel.kind) {
    case 'values': return { min: rel.rows.length, max: rel.rows.length };
    // A reducing barrier with no grouping is one row by definition — `HAVING` can reject it.
    case 'aggregate': {
      const input = rowBounds(rel.input);
      if (rel.groupBy.length === 0) return { min: rel.having ? 0 : 1, max: 1 };
      return { min: rel.having ? 0 : Math.min(input.min, 1), max: input.max };
    }
    case 'distinct': {
      const input = rowBounds(rel.input);
      return { min: Math.min(input.min, 1), max: input.max };
    }
    case 'limit': {
      const input = rowBounds(rel.input);
      const offset = rel.offset ? literalCount(rel.offset) : 0;
      const count = rel.count ? literalCount(rel.count) : Infinity;
      if (count === null) return { min: 0, max: offset === null ? input.max : Math.max(0, input.max - offset) };
      if (offset === null) return { min: 0, max: Math.min(count, input.max) };
      return { min: Math.min(count, Math.max(0, input.min - offset)), max: Math.min(count, Math.max(0, input.max - offset)) };
    }
    case 'filter': return { min: 0, max: rowBounds(rel.input).max };
    case 'project': case 'sort': case 'window': case 'materialize': return rowBounds(rel.input);
    case 'join': {
      const left = rowBounds(rel.left);
      if (rel.join === 'semi' || rel.join === 'anti') return { min: 0, max: left.max };
      const right = rowBounds(rel.right);
      const max = left.max === 0 || right.max === 0 ? 0 : left.max * right.max;
      if (rel.join === 'left') return { min: left.min, max: left.max === 0 ? 0 : left.max * Math.max(1, right.max) };
      const min = rel.join === 'cross' || provablyTrue(rel.on) ? left.min * right.min : 0;
      return { min, max };
    }
    case 'union': {
      const each = rel.inputs.map(rowBounds);
      const max = each.reduce((sum, b) => sum + b.max, 0);
      if (rel.all) return { min: each.reduce((sum, b) => sum + b.min, 0), max };
      return { min: each.some((b) => b.min > 0) ? 1 : 0, max };
    }
    // `WITH RECURSIVE … seed UNION ALL step` (`emit.ts`): every seed row is a row, and the walk is unbounded.
    case 'recursive': return { min: rowBounds(rel.seed).min, max: Infinity };
    case 'scan': case 'self-ref': case 'ref': case 'explode': return UNBOUNDED;
    default: { const unknown: never = rel; return unknown; }
  }
}

/** Exactly one row — `rowBounds`' `{1, 1}`. */
export const exactlyOneRow = (rel: Rel): boolean => {
  const { min, max } = rowBounds(rel);
  return min === 1 && max === 1;
};

/** At most one row — what a correlated scalar subquery needs. */
export const atMostOneRow = (rel: Rel): boolean => rowBounds(rel).max <= 1;
