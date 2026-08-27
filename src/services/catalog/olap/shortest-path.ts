import type { BarrierRelation, PathSpec, Service } from '../../spi/types.ts';
import { SHORTEST_PATH_SERVICE_NAME } from '../../spi/types.ts';
import type { GraphStore } from '../../../storage.ts';
import type { IRStep } from '../../../compiler/ir/step.ts';
import { edgeScopeOf, parseAnonBodyIR, relaxShortestPath, syncBarrier } from './kernel.ts';

// ---------- shortestPath — shortestPath(), a recursive-CTE path walk (Template B) ----------
//
// `g.V().shortestPath()` emits, from each incoming source vertex, its shortest path(s) to every
// reachable target. Unlike the three DECORATE algorithms it is NOT a barrier: an unweighted all-pairs
// shortest path is one recursive `Recursive` term (P1/P2), so it is a PURE `rel` contribution lowered
// inline (`src/compiler/rel/shortestpath.ts`, `docs/2026-07-24-graph-algorithms-plan.md` Template B).
// This service parses the `~tinkerpop.shortestPath.*` config and hands the compiler builder the incoming
// element relation via `site.stream`; the builder produces the PATH-framed result.
//
// This tranche implements the UNWEIGHTED family: the default `bothE` scope and the `.edges` direction
// override (`Direction.IN`/`__.outE()`/`__.bothE()`), `.includeEdges`, and the unweighted `.maxDistance`
// hop cap. A label-scoped `.edges`, a `.target` filter and a weighted `.distance` fail CLOSED with a
// clear deferral until their increments land — never a mis-execution.

const SP_EDGES = '~tinkerpop.shortestPath.edges';
const SP_INCLUDE_EDGES = '~tinkerpop.shortestPath.includeEdges';
const SP_TARGET = '~tinkerpop.shortestPath.target';
const SP_DISTANCE = '~tinkerpop.shortestPath.distance';
const SP_MAX_DISTANCE = '~tinkerpop.shortestPath.maxDistance';

/** Parse a `~tinkerpop.shortestPath.target` value — an anonymous vertex traversal used as an ENDPOINT
 *  predicate — to its body IR (the anonymous body's steps), or `undefined` when no target is set. Same
 *  read as `edgeScopeOf`: a `TraversalParam` carries the PARSED steps directly. */
function targetBody(value: unknown): readonly IRStep[] | undefined {
  if (value === undefined) return undefined;
  return parseAnonBodyIR(value, (_kind, g) => {
    throw new Error(`${SHORTEST_PATH_SERVICE_NAME}: target must be an anonymous vertex traversal, got ${g}`);
  }).steps;
}

/** shortestPath() — ONE substrate: a BSP relaxation BARRIER for BOTH weighted and unweighted searches.
 *  `apply` relaxes the shortest distance from the incoming source vertices into `barrier_state`
 *  (`relaxShortestPath`, scope = source, channel 0 — weighted sums edge weights, unweighted sums hops) and
 *  returns the `(run, round)` handle; the resume (`lowerPathResume`) reconstructs the shortest paths from
 *  that relation, walking only shortest-path edges (`dist[s][v] = dist[s][u] + w`). This REPLACES the
 *  recursive-CTE walk, whose enumerate-then-MIN is exponential and hangs on a dense graph even unweighted
 *  (a min-distance relaxation is an aggregate a recursive term forbids — P3 / repeat-two-regimes §1a). The
 *  compute is a synchronous in-SQL core (`syncBarrier`): `apply` yields in production, `applySync` drives
 *  the sync/census path. */
export function createShortestPathService(store: GraphStore | undefined): Service {
  return {
    name: SHORTEST_PATH_SERVICE_NAME,
    type: 'streaming',
    internal: true,
    describeParams: () => ({
      edges: 'the message scope — a Direction or an anonymous edge traversal (default bothE)',
      includeEdges: 'interleave the traversed edges in the path',
      distance: 'a weight property key — makes the search weighted (least edge-weight sum)',
      maxDistance: 'a hop cap (unweighted) or a final weight cap (weighted)',
    }),
    resolve: (site) => {
      const mode = site.params.mode;
      if (mode !== undefined && mode !== 'path')
        throw new Error(`${SHORTEST_PATH_SERVICE_NAME}: only the native shortestPath() (path mode) is implemented yet, not "${String(mode)}"`);
      const scope = edgeScopeOf(site.params[SP_EDGES], 'both', SHORTEST_PATH_SERVICE_NAME);
      const includeEdges = SP_INCLUDE_EDGES in site.params;
      const target = targetBody(site.params[SP_TARGET]);
      const distanceKey = site.params[SP_DISTANCE];
      if (distanceKey !== undefined && typeof distanceKey !== 'string')
        throw new Error(`${SHORTEST_PATH_SERVICE_NAME}: distance must be a weight property name, got ${String(distanceKey)}`);
      // maxDistance caps the FINAL shortest distance per pair — a hop cap (integer) unweighted, a weight
      // cap (any number) weighted. Applied at reconstruction, not as a walk prune (a weight may be negative).
      let maxWeight: number | undefined;
      if (SP_MAX_DISTANCE in site.params) {
        const md = site.params[SP_MAX_DISTANCE];
        if (typeof md !== 'number')
          throw new Error(`${SHORTEST_PATH_SERVICE_NAME}: maxDistance must be a number, got ${String(md)}`);
        if (distanceKey === undefined && !Number.isInteger(md))
          throw new Error(`${SHORTEST_PATH_SERVICE_NAME}: an unweighted maxDistance must be an integer hop count, got ${md}`);
        maxWeight = md;
      }
      const path: PathSpec = { direction: scope.direction, labels: scope.labels, includeEdges, distanceKey, maxWeight, target };
      return {
        kind: 'barrier', residency: 'do', path,
        ...syncBarrier((rows): BarrierRelation => {
          if (!store)
            throw new Error(`${SHORTEST_PATH_SERVICE_NAME}: no graph store is available to compute shortest paths`);
          // The sources are the incoming traverser vertices (the head projected their ids), deduped.
          const sourceIds = [...new Set(rows.map((r) => Number(r.injectedValue)))];
          const run = store.allocBarrierRun();
          const round = relaxShortestPath(store, run, sourceIds, scope, distanceKey);
          return { kind: 'relation-ref', run, round };
        }),
      };
    },
  };
}
