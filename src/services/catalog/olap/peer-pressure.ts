import type { BarrierRelation, Service } from '../../spi/types.ts';
import { PEER_PRESSURE_SERVICE_NAME } from '../../spi/types.ts';
import type { GraphStore } from '../../../storage.ts';
import { STATE_INSERT, VEC, adjacencyCte, changedCount, edgeScopeOf, iterateInSql, syncBarrier, type Slot } from './kernel.ts';

// ---------- mogwai.peerPressure — peerPressure(), a DECORATE barrier ----------
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
  return {
    name: PEER_PRESSURE_SERVICE_NAME,
    type: 'barrier',
    internal: true,
    describeParams: () => ({ propertyName: `the vertex property key to write the cluster id under (default ${PP_CLUSTER_KEY})` }),
    resolve: (site) => {
      const mode = site.params.mode;
      if (mode !== undefined && mode !== 'decorate')
        throw new Error(`${PEER_PRESSURE_SERVICE_NAME}: only decorate mode (the native peerPressure() step) is implemented yet, not "${String(mode)}"`);
      const scope = edgeScopeOf(site.params[PP_EDGES], 'out', PEER_PRESSURE_SERVICE_NAME);
      const nameOverride = site.params[PP_PROPERTY_NAME];
      const key = typeof nameOverride === 'string' && nameOverride.length > 0 ? nameOverride : PP_CLUSTER_KEY;
      return {
        kind: 'barrier',
        residency: 'do',
        decorate: { channels: [{ key, channel: 0, vtype: 'int' }] }, // a cluster id is a vertex id (integer rowid, modern graph)
        ...syncBarrier((): BarrierRelation => {
          if (!store)
            throw new Error(`${PEER_PRESSURE_SERVICE_NAME}: no graph store is available to compute clusters`);
          const run = store.allocBarrierRun();
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
          const round = iterateInSql(store, run, seed, step,
            (p, n) => changedCount(store, run, p, n), PP_MAX_ITERATIONS, (d) => d === 0);
          return { kind: 'relation-ref', run, round };
        }),
      };
    },
  };
}
