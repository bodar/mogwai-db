import type { Service } from '../../spi/types.ts';
import { TRIANGLE_COUNT_SERVICE_NAME, LCC_SERVICE_NAME } from '../../spi/types.ts';
import type { GraphStore } from '../../../storage.ts';
import { STATE_INSERT, UND, decorateBarrier, stringParam } from './kernel.ts';

// ---------- mogwai.triangleCount + mogwai.localClusteringCoefficient — ONE-SHOT decorate barriers ------
//
// Unlike the BSP algorithms these need NO iteration: a triangle count is a single undirected self-join,
// so `apply` runs ONE INSERT..SELECT into `barrier_state` round 0. Both are UNDIRECTED (GDS projects the
// graph undirected — a `a→x→a` back-and-forth is NOT a triangle, one undirected edge; self-loops and
// parallel edges collapse via DISTINCT). A vertex's triangle count is the number of edges AMONG its
// neighbours; its local clustering coefficient is 2·triangles/(deg·(deg−1)), 0 below degree 2.
// Ported/matched against GDS's own tests (vendor/gds/algo/.../triangle/, GPLv3 — re-expressed): a
// 5-clique gives every vertex 6 triangles and coefficient 1.0; a line/2-cycle gives 0.

/** Per-vertex triangle count `tri(v, c)`: for each vertex, the number of connected neighbour PAIRS
 *  (`nv.y < nw.y` counts each triangle once). A vertex in no triangle is simply absent (LEFT JOIN → 0). */
const TRI = 'tri(v, c) AS (SELECT nv.x, COUNT(*) FROM und nv '
  + 'JOIN und nw ON nv.x = nw.x AND nv.y < nw.y '
  + 'JOIN und e ON e.x = nv.y AND e.y = nw.y GROUP BY nv.x)';

/** A one-shot decorate barrier: `apply` runs ONE INSERT..SELECT (`sql`, bound with the run token) that
 *  writes the score per vertex at (round 0, scope 0, channel 0); the decorate resume reads it. `sql` is a
 *  full statement whose single `?` is the run token. */
function oneShotDecorate(serviceName: string, defaultKey: string, vtype: string, sql: string, store: GraphStore | undefined): Service {
  return decorateBarrier({
    name: serviceName,
    store,
    describeParams: () => ({ propertyName: `the vertex property key for the score (default ${defaultKey})` }),
    plan: (params) => ({
      channels: [{ key: stringParam(params, 'propertyName', defaultKey), channel: 0, vtype }],
      core: (store, run): number => { store.query(sql, [run]); return 0; },
    }),
  });
}

/** triangleCount — the number of triangles each vertex participates in (undirected). */
export const createTriangleCountService = (store: GraphStore | undefined): Service =>
  oneShotDecorate(TRIANGLE_COUNT_SERVICE_NAME, 'triangleCount', 'int',
    `WITH ${UND}, ${TRI}\n${STATE_INSERT} SELECT ?, 0, 0, n.id, 0, COALESCE(tri.c, 0) FROM nodes n LEFT JOIN tri ON tri.v = n.id`,
    store);

/** localClusteringCoefficient — 2·triangles/(deg·(deg−1)), the fraction of a vertex's neighbour pairs
 *  that are themselves connected; 0 below degree 2 (no pairs, and no division by zero). */
export const createLocalClusteringService = (store: GraphStore | undefined): Service =>
  oneShotDecorate(LCC_SERVICE_NAME, 'localClusteringCoefficient', 'double',
    `WITH ${UND}, ${TRI}, deg(id, d) AS (SELECT x, COUNT(*) FROM und GROUP BY x)\n`
      + `${STATE_INSERT} SELECT ?, 0, 0, n.id, 0, `
      + 'CASE WHEN COALESCE(deg.d, 0) < 2 THEN 0.0 ELSE 2.0 * COALESCE(tri.c, 0) / (deg.d * (deg.d - 1)) END '
      + 'FROM nodes n LEFT JOIN deg ON deg.id = n.id LEFT JOIN tri ON tri.v = n.id',
    store);
