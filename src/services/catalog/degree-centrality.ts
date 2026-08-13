import type { IRStep } from '../../compiler/ir/step.ts';
import type { RelCallSite, RelContribution, Service } from '../spi/types.ts';

// ---------- tinker.degree.centrality — per-vertex edge count (pure, Streaming) ----------
//
// Per input vertex, count its incident edges in `direction` (default IN).
//
// It is a `streaming` service and therefore contributes a per-parent VALUE, not a relation — which
// is TinkerPop's own `Service.Type` distinction and the reason `RelContribution` is a union. The
// value is built by handing the CHILD SEAM the body `[<direction>, count]`: the very same
// correlated movement-then-reducer a `by(__.in().count())` is, so this service needs no substrate
// of its own and gains bulk-awareness, productivity and the `long` tag from the seam that already
// has them. `where(call("tinker.degree.centrality").is(3))` composes for the same reason.

/** Read the `direction` param: OUT/IN/BOTH (default IN). The value arrives either as a
 *  Direction enum token ({direction:'out'}) or a bare string. */
function directionOf(params: Record<string, unknown>): 'out' | 'in' | 'both' {
  const d = params.direction;
  // This registry leaf deliberately stays independent of the parser/front-end import
  // graph (services are resolved while compiler scopes are assembled). The token has
  // already been declared at the front-end boundary; this is a local structural read
  // of a service parameter, not a second parser vocabulary.
  const raw = (d && typeof d === 'object' && 'direction' in d ? (d as { direction: string }).direction
    : typeof d === 'string' ? d
    : 'in').toLowerCase();
  if (raw === 'out' || raw === 'in' || raw === 'both') return raw;
  throw new Error(`tinker.degree.centrality: unsupported direction '${raw}'`);
}

/** The body the seam lowers — a movement in `direction`, then `count()`. Written as IR rather than
 *  parsed from Gremlin text because that is what it IS: the service is not quoting a traversal, it is
 *  naming two steps. */
const degreeBody = (direction: 'out' | 'in' | 'both'): readonly IRStep[] =>
  [{ name: direction, args: [] }, { name: 'count', args: [] }] as unknown as readonly IRStep[];

export const degreeCentralityService: Service = {
  name: 'tinker.degree.centrality',
  type: 'streaming',
  describeParams: () => ({ direction: 'Direction (OUT | IN | BOTH), default IN' }),
  resolve: () => ({
    kind: 'rel',
    buildRel: (site: RelCallSite): RelContribution | null => {
      // THE POSITION CHECK IS A THROW, NOT A DECLINE — §6·5's "the answer is an ERROR". A `start`
      // position for a `streaming` service is not a shape to decline; it is invalid Gremlin, and the
      // compiler is the only thing that can raise it.
      if (!site.host || !site.child)
        throw new Error('tinker.degree.centrality must be called mid-traversal on vertices (e.g. g.V().call(...))');
      if (site.host.kind !== 'element')
        throw new Error('tinker.degree.centrality must be called mid-traversal on vertices (e.g. g.V().call(...))');
      const value = site.child.scalar(degreeBody(directionOf(site.params)), site.host);
      return value && { kind: 'value', value };
    },
  }),
};
