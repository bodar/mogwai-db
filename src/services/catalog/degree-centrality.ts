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

/** The edge-movement step for a direction, used by the WEIGHTED body (which hops to edges to read a
 *  weight); the unweighted body hops to the adjacent VERTICES and counts them. */
const EDGE_STEP = { out: 'outE', in: 'inE', both: 'bothE' } as const;

/** The body the seam lowers. UNWEIGHTED: a movement in `direction`, then `count()` — `count` is a monoid
 *  (0 over no edges), so an isolated vertex is 0 for free. WEIGHTED (`relationshipWeightProperty`): the
 *  Σ of the incident edges' weights. `sum()` is a SEMIGROUP (NULL over no edges, not 0), so complete it to
 *  a monoid the honest, general way — `coalesce(<dir>E().values(w).sum(), constant(0))`, which the scalar-
 *  coalesce seam (`reduction.ts` `scalarCoalesceChild`) lowers to `COALESCE(Σw, 0)`. Written as IR, not
 *  parsed: the service NAMES its steps, and a synthesized `{nested: Step[]}` arm rides idempotently
 *  through `stepChain` exactly as a parsed nested body does (the substrate `strategies.ts` synthesis uses). */
const degreeBody = (direction: 'out' | 'in' | 'both', weightKey: string | undefined): readonly IRStep[] => {
  if (weightKey === undefined) return [{ name: direction, args: [] }, { name: 'count', args: [] }] as unknown as readonly IRStep[];
  const sumArm = [{ name: EDGE_STEP[direction], args: [] }, { name: 'values', args: [{ value: weightKey, type: null, name: null }] }, { name: 'sum', args: [] }];
  const zeroArm = [{ name: 'constant', args: [{ value: 0, type: null, name: null }] }];
  return [{ name: 'coalesce', args: [{ value: { nested: sumArm }, type: null, name: null }, { value: { nested: zeroArm }, type: null, name: null }] }] as unknown as readonly IRStep[];
};

export const degreeCentralityService: Service = {
  name: 'tinker.degree.centrality',
  type: 'streaming',
  describeParams: () => ({
    direction: 'Direction (OUT | IN | BOTH), default IN',
    relationshipWeightProperty: 'sum this edge property instead of counting edges (GDS weighted degree); default an unweighted count',
  }),
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
      const rw = site.params.relationshipWeightProperty;
      const weightKey = typeof rw === 'string' && rw.length > 0 ? rw : undefined;
      const value = site.child.scalar(degreeBody(directionOf(site.params), weightKey), site.host);
      return value && { kind: 'value', value };
    },
  }),
};
