import type { Service, ServiceCallCtx } from './types.ts';
import { scopedMovementCount } from '../steps/child.ts';

// ---------- tinker.degree.centrality — per-vertex edge count (pure, Streaming) ----------
//
// Per input vertex, count its incident edges in `direction` (default IN). Lowers through
// the scoped-count child-scope seam (scopedDegreeCount → pushChildScope +
// lowerScopedScalarReducer) — the SAME per-parent-merged-by-ordinal substrate a count()
// child uses, so where(call("tinker.degree.centrality").is(n)) falls out of the child
// seam for free, and the result is a bulk-aware scalar per input.

/** Read the `direction` param: OUT/IN/BOTH (default IN). The value arrives either as a
 *  Direction enum token ({direction:'out'}) or a bare string. */
function directionOf(params: Record<string, unknown>): 'out' | 'in' | 'both' {
  const d = params.direction;
  const raw = (d && typeof d === 'object' && 'direction' in d ? (d as { direction: string }).direction
    : typeof d === 'string' ? d
    : 'in').toLowerCase();
  if (raw === 'out' || raw === 'in' || raw === 'both') return raw;
  throw new Error(`tinker.degree.centrality: unsupported direction '${raw}'`);
}

export const degreeCentralityService: Service = {
  name: 'tinker.degree.centrality',
  type: 'streaming',
  describeParams: () => ({ direction: 'Direction (OUT | IN | BOTH), default IN' }),
  resolve: (ctx: ServiceCallCtx) => ({
    kind: 'stream',
    build: (c) => {
      if (!c.parent || c.parent.kind !== 'elements' || !c.scope)
        throw new Error('tinker.degree.centrality must be called mid-traversal on vertices (e.g. g.V().call(...))');
      return scopedMovementCount(c.parent, c.scope, directionOf(c.params));
    },
  }),
};
