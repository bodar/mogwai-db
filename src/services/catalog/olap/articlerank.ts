import type { Service } from '../../spi/types.ts';
import { ARTICLE_RANK_SERVICE_NAME } from '../../spi/types.ts';
import type { GraphStore } from '../../../storage.ts';
import { STATE_INSERT, adjacencyCte, decorateBarrier, edgeScopeOf, nodeCount, stringParam, weightedAdjacencyCte } from './kernel.ts';
import { execute, q, value } from '../../../sql/kernel/q.ts';

// ---------- articleRank — ArticleRank, a MULTI-CHANNEL BSP decorate barrier ----------
//
// `g.call("articleRank")` decorates each vertex with its ArticleRank and passes it through.
// ArticleRank is a PageRank variant that damps a node's outgoing influence by (out-degree + AVERAGE
// degree) rather than just out-degree, so a hub with many out-edges contributes less rank per edge — it
// suppresses the influence of high-degree nodes relative to PageRank. No native TinkerPop step, so it is
// call-only, GDS-style. A faithful replay of GDS's DELTA-ACCUMULATION Pregel formulation
// (`vendor/gds/algo/src/main/java/org/neo4j/gds/pagerank/ArticleRankComputation.java`, GPLv3 —
// re-expressed in SQL, never transcribed):
//   init:  rank = delta = alpha,  where alpha = 1 − dampingFactor
//   round: delta[v] = damping · Σ_{u→v, prevDelta[u] > tolerance} prevDelta[u] / (outdeg[u] + avgDegree)
//          rank[v]  = prevRank[v] + delta[v]
// where avgDegree = |E| / |V| (mean out-degree). Running on DELTAS (not the whole rank) is what keeps the
// scores from exploding; a node whose delta drops to the tolerance stops contributing (GDS's voteToHalt),
// which the `prevDelta[u] > tolerance` sender gate reproduces exactly (a later message re-activates it).
//
// This is the SECOND multi-channel consumer after HITS: rank is channel 0 (the decorated score), the
// per-round delta is channel 1 (internal working state, not decorated). Rounds are KEPT (round r holds
// iteration r's two channels, like HITS); the decorate resume reads channel 0 of the final round. The
// compute is host-driven iteration over bulk SQL reads (the barrier model), never row-at-a-time interp.
//
// This tranche implements the DEFAULT (unweighted, non-personalised) case. A relationship weight and
// source-node personalisation land with the weighted/seed substrate; a custom edge scope
// (`~tinkerpop.articleRank.edges`) composes today via `edgeScopeOf`.

const AR_KEY = 'articleRank';
const AR_EDGES = '~tinkerpop.articleRank.edges';
const AR_DAMPING_DEFAULT = 0.85;
const AR_TOLERANCE_DEFAULT = 0.0000001; // GDS default tolerance (1e-7)
const AR_MAX_ITERATIONS = 20;           // GDS default maxIterations
const AR_RANK_CHANNEL = 0;
const AR_DELTA_CHANNEL = 1;

/** articleRank() over a store: a multi-channel BSP DECORATE barrier. The store is captured at
 *  construction (app-scope DI); `apply` reads the graph and replays GDS's delta-accumulation. */
export function createArticleRankService(store: GraphStore | undefined): Service {
  return decorateBarrier({
    name: ARTICLE_RANK_SERVICE_NAME,
    store,
    describeParams: () => ({
      propertyName: `the vertex property key to write the rank under (default ${AR_KEY})`,
      maxIterations: `iteration cap (default ${AR_MAX_ITERATIONS})`,
      dampingFactor: `damping factor (default ${AR_DAMPING_DEFAULT})`,
      tolerance: `per-node halt tolerance on the delta (default ${AR_TOLERANCE_DEFAULT})`,
      relationshipWeightProperty: 'weight messages by this edge property (GDS weighted ArticleRank); default unweighted',
    }),
    plan: (params) => {
      const scope = edgeScopeOf(params[AR_EDGES], 'out', ARTICLE_RANK_SERVICE_NAME);
      const damping = typeof params.dampingFactor === 'number' ? params.dampingFactor : AR_DAMPING_DEFAULT;
      // relationshipWeightProperty (GDS): the sender's degree becomes its WEIGHTED out-degree (Σw), the
      // avgDegree becomes the weighted mean (Σw_all/N), and each message is scaled by the edge weight —
      // `pageRankDegreeFunction(…, hasRelationshipWeightProperty)` + `applyRelationshipWeight` in
      // `vendor/gds/algo/.../pagerank/{DegreeFunctions,ArticleRankComputation}.java`. A Σw=0 sender does
      // not send (`if (degree > 0)`), which `HAVING SUM(w) > 0` reproduces. Absent → unweighted, unchanged.
      const rw = params.relationshipWeightProperty;
      const weightKey = typeof rw === 'string' && rw.length > 0 ? rw : undefined;
      const tolerance = typeof params.tolerance === 'number' ? params.tolerance : AR_TOLERANCE_DEFAULT;
      const maxIterParam = params.maxIterations;
      const maxIterations = typeof maxIterParam === 'number' && Number.isInteger(maxIterParam) && maxIterParam >= 1
        ? maxIterParam : AR_MAX_ITERATIONS;
      const key = stringParam(params, 'propertyName', AR_KEY);
      return {
        channels: [{ key, channel: AR_RANK_CHANNEL, vtype: 'double' }], // rank is the decorated channel; delta (1) is internal
        core: (store, run): number => {
          const N = nodeCount(store);
          const alpha = 1 - damping;
          const cte = weightKey ? weightedAdjacencyCte(scope, weightKey) : adjacencyCte(scope);
          // per-sender out-degree denominator: weighted (Σw, absent when 0 → does not send) or a count.
          const odCte = weightKey
            ? q`od AS (SELECT src AS id, SUM(w) AS c FROM e GROUP BY src HAVING SUM(w) > 0)`
            : q`od AS (SELECT src AS id, COUNT(*) AS c FROM e GROUP BY src)`;
          // per-edge message numerator: the delta, scaled by the edge weight when weighted.
          const msgNum = weightKey ? q`pd.d * e.w` : q`pd.d`;
          // avgDegree = mean (weighted) out-degree over the scope = (Σw or |E|) / |N| — one scalar,
          // matching GDS's DegreeFunctions over Orientation.NATURAL (weighted when a weight is set).
          const E = execute<{ c: number }>(store,
            q`WITH ${cte} SELECT ${weightKey ? q`COALESCE(SUM(w), 0)` : q`COUNT(*)`} AS c FROM e`)[0].c;
          const avgDeg = E / N;
          // SEED round 0: rank = delta = alpha for every vertex (GDS init + the initial superstep's send).
          for (const channel of [AR_RANK_CHANNEL, AR_DELTA_CHANNEL])
            execute(store, q`${STATE_INSERT} SELECT ${value(run)}, 0, 0, id, ${value(channel)}, ${value(alpha)} FROM nodes`);
          // GDS runs maxIterations SUPERSTEPS (0..maxIterations−1); superstep 0 only sends, so there are
          // maxIterations−1 ACCUMULATION rounds after the seed.
          for (let r = 1; r < maxIterations; r++) {
            // delta[r][v] = damping · Σ over senders u→v with prevDelta[u] > tolerance of
            //   prevDelta[u] / (outdeg[u] + avgDeg). od = per-sender out-degree in the scope.
            execute(store,
              q`WITH ${cte}, ${odCte},
                 pd AS (SELECT id, cval AS d FROM barrier_state WHERE run = ${value(run)} AND round = ${value(r - 1)} AND channel = ${value(AR_DELTA_CHANNEL)}),
                 msg AS (SELECT e.tgt AS id, SUM(${msgNum} / (od.c + ${value(avgDeg)})) AS m
                           FROM e JOIN pd ON pd.id = e.src JOIN od ON od.id = e.src
                          WHERE pd.d > ${value(tolerance)} GROUP BY e.tgt)
               ${STATE_INSERT}
                 SELECT ${value(run)}, ${value(r)}, 0, n.id, ${value(AR_DELTA_CHANNEL)}, ${value(damping)} * COALESCE(msg.m, 0) FROM nodes n LEFT JOIN msg ON msg.id = n.id`);
            // rank[r][v] = prevRank[v] + delta[r][v].
            execute(store,
              q`WITH pr AS (SELECT id, cval AS rk FROM barrier_state WHERE run = ${value(run)} AND round = ${value(r - 1)} AND channel = ${value(AR_RANK_CHANNEL)}),
                 nd AS (SELECT id, cval AS d FROM barrier_state WHERE run = ${value(run)} AND round = ${value(r)} AND channel = ${value(AR_DELTA_CHANNEL)})
               ${STATE_INSERT}
                 SELECT ${value(run)}, ${value(r)}, 0, n.id, ${value(AR_RANK_CHANNEL)}, COALESCE(pr.rk, 0) + COALESCE(nd.d, 0)
                   FROM nodes n LEFT JOIN pr ON pr.id = n.id LEFT JOIN nd ON nd.id = n.id`);
          }
          return maxIterations - 1;
        },
      };
    },
  });
}
