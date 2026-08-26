import type { Service } from '../../spi/types.ts';
import { PEER_PRESSURE_SERVICE_NAME } from '../../spi/types.ts';
import type { GraphStore } from '../../../storage.ts';
import { STATE_INSERT, VEC, adjacencyCte, changedCount, decorateBarrier, edgeScopeOf, iterateInSql, stringParam, type Slot } from './kernel.ts';

// ---------- peerPressure — peerPressure(), a DECORATE barrier ----------
//
// `g.V().peerPressure()` decorates each vertex with its cluster id under
// `gremlin.peerPressureVertexProgram.cluster` and passes it through. The cluster is a vertex id,
// assigned by peer-pressure label propagation: each vertex adopts the cluster held by the greatest
// total vote among itself + its in-neighbours (default `outE` scope, vote strength 1.0), ties broken by
// the lexicographically-smallest cluster-id STRING, iterated to a fixpoint (≤30 rounds). See
// `vendor/tinkerpop/gremlin-core/.../clustering/peerpressure/PeerPressureVertexProgram.java:150-172`
// (`vertex.id()` seed; `largestCount` majority with a `.toString().compareTo` tie-break).

const PP_CLUSTER_KEY = 'gremlin.peerPressureVertexProgram.cluster';
const PP_PROPERTY_NAME = '~tinkerpop.peerPressure.propertyName';
const PP_EDGES = '~tinkerpop.peerPressure.edges';
const PP_MAX_ITERATIONS = 30;

/** peerPressure() over a store: an async DECORATE barrier. */
export function createPeerPressureService(store: GraphStore | undefined): Service {
  return decorateBarrier({
    name: PEER_PRESSURE_SERVICE_NAME,
    store,
    describeParams: () => ({ propertyName: `the vertex property key to write the cluster id under (default ${PP_CLUSTER_KEY})` }),
    plan: (params) => {
      const scope = edgeScopeOf(params[PP_EDGES], 'out', PEER_PRESSURE_SERVICE_NAME);
      const key = stringParam(params, PP_PROPERTY_NAME, PP_CLUSTER_KEY);
      return {
        channels: [{ key, channel: 0, vtype: 'int' }], // a cluster id is a vertex id (integer rowid, modern graph)
        core: (store, run): number => {
          const { cte, labelBinds } = adjacencyCte(scope);
          // Seed each cluster to the vertex's external id (in `cval`, in SQL). Each round: every vertex
          // tallies the votes of {itself} ∪ {its voters} (strength 1 each; `e` is voter→receiver) and
          // adopts the max-total cluster, ties to the smallest cluster-id STRING (CAST … AS TEXT,
          // matching the reference's .toString().compareTo). ROW_NUMBER picks the winner per vertex,
          // written to the next slot.
          const seed = () => store.query(
            `${STATE_INSERT} SELECT ?, 0, 0, id, 0, COALESCE(uid, id) FROM nodes`,
            [run]);
          const step = (prev: Slot, next: Slot) => store.query(
            `WITH ${cte},
               ${VEC},
               votes AS (SELECT id, v AS c FROM vec
                         UNION ALL SELECT e.tgt AS id, voter.v AS c FROM e JOIN vec voter ON voter.id = e.src),
               tally AS (SELECT id, c, COUNT(*) AS total FROM votes GROUP BY id, c),
               ranked AS (SELECT id, c, ROW_NUMBER() OVER (PARTITION BY id ORDER BY total DESC, CAST(c AS TEXT) ASC) AS rn FROM tally)
             ${STATE_INSERT}
               SELECT ?, ?, 0, id, 0, c FROM ranked WHERE rn = 1`,
            [...labelBinds, run, prev, run, next]);
          return iterateInSql(store, run, seed, step,
            (p, n) => changedCount(store, run, p, n), PP_MAX_ITERATIONS, (d) => d === 0);
        },
      };
    },
  });
}
