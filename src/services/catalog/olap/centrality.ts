import type { BarrierRelation, Service } from '../../spi/types.ts';
import { CLOSENESS_SERVICE_NAME, HARMONIC_SERVICE_NAME } from '../../spi/types.ts';
import type { GraphStore } from '../../../storage.ts';
import { STATE_INSERT, relaxShortestPath, syncBarrier } from './kernel.ts';

// ---------- mogwai.closeness — closeness centrality, a scope-keyed DECORATE barrier ----------
//
// `g.call("mogwai.closeness")` decorates each vertex with its closeness centrality — the first
// pair-keyed-state consumer beyond shortestPath, reusing the SAME scope-keyed `barrier_state` that
// `relaxShortestPath` writes (scope = source, channel 0 = distance). GDS's DefaultCentralityComputer:
// closeness[v] = reached[v] / farness[v], where farness[v] = Σ dist(u→v) over all u that REACH v and
// reached[v] is how many do (0 when none). The IN direction is the algorithm's, proven by GDS's own
// directed test (`vendor/gds/algo/src/test/java/org/neo4j/gds/closeness/ClosenessCentralityDirectedTest.java`
// — a=2/3, b=1, c=0 only reproduce with reverse-edge BFS; GPLv3, re-expressed). On an undirected graph
// in ≡ out. Compute: relax unweighted distances FROM every vertex over reversed edges (so scope=v holds
// dist(u→v) for each reaching u), then aggregate per scope into one closeness score at (scope 0, channel 0).

const CLOSENESS_KEY = 'closeness';
const HARMONIC_KEY = 'harmonic';

/** THE SHARED ENGINE for the distance-based centralities (closeness, harmonic). Relax unweighted
 *  distances from EVERY vertex over REVERSED edges (`direction:'in'`), so `barrier_state[scope=v][id=u]`
 *  holds dist(u→v) for each u that reaches v; then reduce each scope's reached distances to ONE score via
 *  `scoreExpr(nodeCount)` — a SQL aggregate over `bs.cval` (the reaching distances; self is excluded by
 *  `cval > 0`) — written at (scope 0, channel 0) for the decorate resume. Every vertex gets a row (LEFT
 *  JOIN), so an unreached vertex aggregates over zero rows; `scoreExpr` must be null-safe there. The two
 *  algorithms differ ONLY in that one expression, which is why they share this. */
function distanceCentrality(store: GraphStore, run: number, scoreExpr: (nodeCount: number) => string): BarrierRelation {
  const ids = store.query<{ id: number }>('SELECT id FROM nodes').map((r) => r.id);
  if (ids.length === 0) return { kind: 'relation-ref', run, round: 0 };
  const distRound = relaxShortestPath(store, run, ids, { direction: 'in', labels: [] }, undefined);
  const scoreRound = 2; // relaxShortestPath alternates slots 0/1 only, so 2 is a free round
  store.query('DELETE FROM barrier_state WHERE run = ? AND round = ?', [run, scoreRound]);
  store.query(
    `${STATE_INSERT}
       SELECT ?, ?, 0, n.id, 0, ${scoreExpr(ids.length)}
         FROM nodes n
         LEFT JOIN barrier_state bs
           ON bs.run = ? AND bs.round = ? AND bs.channel = 0 AND bs.scope = n.id AND bs.cval > 0
        GROUP BY n.id`,
    [run, scoreRound, run, distRound]);
  return { kind: 'relation-ref', run, round: scoreRound };
}

/** One distance-centrality DECORATE barrier — closeness or harmonic — given its name, default property
 *  key, and the per-scope reduction expression. Both are call-only, `internal: true`, GDS-style. */
function distanceCentralityService(
  serviceName: string, defaultKey: string, scoreExpr: (nodeCount: number) => string, store: GraphStore | undefined,
): Service {
  return {
    name: serviceName,
    type: 'barrier',
    internal: true,
    describeParams: () => ({ propertyName: `the vertex property key for the score (default ${defaultKey})` }),
    resolve: (site) => {
      const nameOverride = site.params.propertyName;
      const key = typeof nameOverride === 'string' && nameOverride.length > 0 ? nameOverride : defaultKey;
      return {
        kind: 'barrier',
        residency: 'do',
        decorate: { channels: [{ key, channel: 0, vtype: 'double' }] },
        ...syncBarrier((): BarrierRelation => {
          if (!store)
            throw new Error(`${serviceName}: no graph store is available`);
          return distanceCentrality(store, store.allocBarrierRun(), scoreExpr);
        }),
      };
    },
  };
}

/** closeness = reached / farness (GDS DefaultCentralityComputer): count of reaching nodes over the sum
 *  of their distances; 0 when none reach. */
export const createClosenessService = (store: GraphStore | undefined): Service =>
  distanceCentralityService(CLOSENESS_SERVICE_NAME, CLOSENESS_KEY,
    () => 'CASE WHEN COALESCE(SUM(bs.cval), 0) > 0 THEN CAST(COUNT(bs.cval) AS REAL) / SUM(bs.cval) ELSE 0.0 END',
    store);

/** harmonic = (Σ 1/dist over reaching nodes) / (N−1) — GDS HarmonicCentrality. Unlike closeness it sums
 *  the RECIPROCAL distances (so an unreached pair contributes 0, not ∞), normalised by N−1. `N−1` is a
 *  compiler-held constant inlined into the expression; N≤1 → 0 (no other nodes, and no division by zero). */
export const createHarmonicService = (store: GraphStore | undefined): Service =>
  distanceCentralityService(HARMONIC_SERVICE_NAME, HARMONIC_KEY,
    (n) => n <= 1 ? '0.0' : `COALESCE(SUM(1.0 / bs.cval), 0) / ${n - 1}.0`,
    store);
