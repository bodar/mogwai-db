import type { Service } from '../../spi/types.ts';
import { PAGERANK_SERVICE_NAME } from '../../spi/types.ts';
import type { GraphStore } from '../../../storage.ts';
import { STATE_INSERT, VEC, adjacencyCte, decorateBarrier, edgeScopeOf, iterateInSql, nodeCount, stringParam, sumAbsDelta, weightedAdjacencyCte, type Slot } from './kernel.ts';

// ---------- pageRank — pageRank(), a DECORATE barrier ----------
//
// `g.V().pageRank()` decorates each vertex with its PageRank under
// `gremlin.pageRankVertexProgram.pageRank` and passes it through. It is a faithful replay of the
// reference BSP (`vendor/tinkerpop/gremlin-core/.../ranking/pagerank/PageRankVertexProgram.java:162-212`),
// including dangling-node redistribution via the global teleportation energy — a host-driven iteration
// inside `apply` (the barrier model), not row-at-a-time interpretation. Default message scope is `outE`
// (rank flows along out-edges; a sink's rank redistributes through teleport), α=0.85, ε=1e-5, ≤20 iters.
//
// This tranche implements the DEFAULT scope only. A custom edge scope
// (`~tinkerpop.pageRank.edges`), an explicit iteration count (`~tinkerpop.pageRank.times`), and reading
// the score through values()/valueMap()/math() land with the edge-config + numeric-read substrate;
// order().by(propertyName)/has(propertyName)/project().by(propertyName-as-string) compose today.

const PR_PAGERANK_KEY = 'gremlin.pageRankVertexProgram.pageRank';
const PR_PROPERTY_NAME = '~tinkerpop.pageRank.propertyName';
const PR_EDGES = '~tinkerpop.pageRank.edges';
const PR_TIMES = '~tinkerpop.pageRank.times';
const PR_ALPHA_DEFAULT = 0.85;
const PR_EPSILON = 0.00001;
const PR_MAX_ITERATIONS = 20;

/** pageRank() over a store: an async DECORATE barrier. The store is captured at construction (app-scope
 *  DI); `apply` reads the graph and replays the reference BSP. */
export function createPageRankService(store: GraphStore | undefined): Service {
  return decorateBarrier({
    name: PAGERANK_SERVICE_NAME,
    store,
    describeParams: () => ({
      propertyName: `the vertex property key to write the rank under (default ${PR_PAGERANK_KEY})`,
      relationshipWeightProperty: 'weight messages by this edge property (GDS-style weighted PageRank); default unweighted',
    }),
    plan: (params) => {
      // Default message scope is outE (rank flows along out-edges); a custom scope is honoured.
      const scope = edgeScopeOf(params[PR_EDGES], 'out', PAGERANK_SERVICE_NAME);
      const alpha = typeof params.dampingFactor === 'number' ? params.dampingFactor : PR_ALPHA_DEFAULT;
      // relationshipWeightProperty (GDS): weight each message by an edge property. Weighted PageRank
      // sends α·pr[u]·w(u,v) / weightedOutDegree[u], and a vertex whose out-edges have total weight 0 is
      // dangling (its rank teleports) — the `HAVING SUM(w) > 0` drops it from `od` so it reads as NULL
      // exactly like an out-degree-0 sink. Absent → the unweighted path, byte-for-byte as before.
      const rw = params.relationshipWeightProperty;
      const weightKey = typeof rw === 'string' && rw.length > 0 ? rw : undefined;
      // `~tinkerpop.pageRank.times` caps the PROPAGATION rounds (VertexProgramStep sets maxIterations =
      // times + 1; the reference's iteration 1 is the seed, so `times` is the number of propagation
      // rounds after it). Absent → run to ε-convergence, ≤ PR_MAX_ITERATIONS.
      const timesParam = params[PR_TIMES];
      const times = typeof timesParam === 'number' && Number.isInteger(timesParam) ? timesParam : undefined;
      const key = stringParam(params, PR_PROPERTY_NAME, PR_PAGERANK_KEY);
      return {
        channels: [{ key, channel: 0, vtype: 'double' }], // a PageRank score is a double
        seedFromInput: true, // initial rank = incoming count
        core: (store, run, rows): number => {
          const N = nodeCount(store); // one scalar, not the vertex set
          const { cte, labelBinds } = weightKey ? weightedAdjacencyCte(scope, weightKey) : adjacencyCte(scope);
          // out-degree = message denominator: a weighted count (Σw, dangling when 0) or a plain count.
          const odCte = weightKey
            ? 'od AS (SELECT src AS id, SUM(w) AS c FROM e GROUP BY src HAVING SUM(w) > 0)'
            : 'od AS (SELECT src AS id, COUNT(*) AS c FROM e GROUP BY src)';
          // per-edge message: weighted by e.w, or the unweighted even split.
          const msgVal = weightKey ? '? * vec.v * e.w / od.c' : '? * vec.v / od.c';
          // SEED slot 0, in SQL. A bare source → the uniform 1/N rank. A non-bare prefix hands us its
          // incoming per-vertex traverser count (`rows`, one per traverser carrying the EXTERNAL id) —
          // TinkerPop's HaltedTraversersCount — which cross as ONE json bind (O(input traversers), the
          // input that already crossed the boundary), matched to internal ids and counted per vertex.
          // Both then iterate the SAME relaxation; only the seed differs (PageRankVertexProgram:164,181-183).
          const seed = rows.length > 0
            ? () => store.query(
                `${STATE_INSERT}
                   SELECT ?, 0, 0, n.id, 0, COUNT(j.value) FROM nodes n
                     LEFT JOIN json_each(?) j ON CAST(COALESCE(n.uid, n.id) AS TEXT) = CAST(j.value AS TEXT)
                   GROUP BY n.id`,
                [run, JSON.stringify(rows.map((r) => r.injectedValue))])
            : () => store.query(
                `${STATE_INSERT} SELECT ?, 0, 0, id, 0, 1.0 / ? FROM nodes`,
                [run, N]);
          // TELEPORTATION ENERGY off the prev slot — one scalar: Σ (1−α)·rank over all vertices, plus
          // α·rank for the DANGLING ones (out-degree 0 sinks redistribute their whole rank). Then each
          // round: messages[v] = Σ_{u→v} α·pr[u]/outdeg[u] (in SQL, joining the real edges) plus the
          // teleport share localTerminal = teleport/N, written to the next slot.
          const teleportOf = (prev: Slot): number => store.query<{ t: number }>(
            `WITH ${cte}, ${odCte},
               ${VEC}
             SELECT COALESCE(SUM((1 - ?) * vec.v + CASE WHEN od.c IS NULL THEN ? * vec.v ELSE 0 END), 0) AS t
               FROM vec LEFT JOIN od ON od.id = vec.id`,
            [...labelBinds, run, prev, alpha, alpha])[0].t;
          const step = (prev: Slot, next: Slot) => {
            const localTerminal = teleportOf(prev) / N;
            store.query(
              `WITH ${cte}, ${odCte},
                 ${VEC},
                 msg AS (SELECT e.tgt AS id, SUM(${msgVal}) AS m
                           FROM e JOIN vec ON vec.id = e.src JOIN od ON od.id = e.src GROUP BY e.tgt)
               ${STATE_INSERT}
                 SELECT ?, ?, 0, n.id, 0, COALESCE(msg.m, 0) + ? FROM nodes n LEFT JOIN msg ON msg.id = n.id`,
              [...labelBinds, run, prev, alpha, run, next, localTerminal]);
          };
          // `times` caps propagation rounds exactly (no ε short-circuit — times=0 means output the seed
          // as-is; times=1 means one round); default runs to ε-convergence within PR_MAX_ITERATIONS.
          const maxRounds = times ?? PR_MAX_ITERATIONS;
          const stop = times !== undefined ? () => false : (d: number) => d < PR_EPSILON;
          return iterateInSql(store, run, seed, step,
            (p, n) => sumAbsDelta(store, run, p, n), maxRounds, stop);
        },
      };
    },
  });
}
