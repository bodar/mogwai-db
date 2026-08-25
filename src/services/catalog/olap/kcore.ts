import type { Service } from '../../spi/types.ts';
import { KCORE_SERVICE_NAME } from '../../spi/types.ts';
import type { GraphStore } from '../../../storage.ts';
import { STATE_INSERT, UND, changedCount, decorateBarrier, iterateInSql, nodeCount, stringParam, type Slot } from './kernel.ts';

// ---------- mogwai.kcore — k-core decomposition (coreness), a BSP fixpoint decorate barrier ----------
//
// `g.call("mogwai.kcore")` decorates each vertex with its CORENESS: the largest k such that the vertex
// belongs to a maximal subgraph in which every vertex has degree ≥ k. UNDIRECTED.
//
// Coreness is a well-defined VALUE, independent of algorithm. GDS computes it by stateful peeling
// (remove smallest-degree vertices, order-dependent) — awkward as SQL. We use the equivalent DISTRIBUTED
// fixpoint (Montresor, Pellegrini & Miorandi, "Distributed k-core decomposition"): est[v] starts at the
// vertex's degree and each round becomes the H-INDEX of its neighbours' estimates — the largest k such
// that ≥ k neighbours have estimate ≥ k. It decreases monotonically to the true coreness, so it is a
// clean `barrier_state` fixpoint like wcc/peerPressure. Matched against GDS's own test values
// (vendor/gds/algo/.../kcore/, GPLv3 — re-expressed).

const KCORE_KEY = 'coreValue';

/** kcore() over a store: a BSP fixpoint DECORATE barrier. */
export function createKCoreService(store: GraphStore | undefined): Service {
  return decorateBarrier({
    name: KCORE_SERVICE_NAME,
    store,
    describeParams: () => ({ propertyName: `the vertex property key for the coreness (default ${KCORE_KEY})` }),
    plan: (params) => {
      const key = stringParam(params, 'propertyName', KCORE_KEY);
      return {
        channels: [{ key, channel: 0, vtype: 'int' }],
        core: (store, run): number => {
          const backstop = nodeCount(store) + 1;
          // Seed est[v] = undirected degree (0 for an isolated vertex, which then stays 0).
          const seed = () => store.query(
            `WITH ${UND}
             ${STATE_INSERT} SELECT ?, 0, 0, n.id, 0, COALESCE(d.c, 0)
               FROM nodes n LEFT JOIN (SELECT x, COUNT(*) AS c FROM und GROUP BY x) d ON d.x = n.id`,
            [run]);
          // est[v] ← H-INDEX of neighbours' estimates: rank neighbour ests desc, take the largest rank r
          // whose est ≥ r. An isolated vertex has no neighbour rows → 0.
          const step = (prev: Slot, next: Slot) => store.query(
            `WITH ${UND},
               pe AS (SELECT id, cval AS est FROM barrier_state WHERE run = ? AND round = ? AND channel = 0),
               ne AS (SELECT und.x AS v, pe.est AS e FROM und JOIN pe ON pe.id = und.y),
               ranked AS (SELECT v, e, ROW_NUMBER() OVER (PARTITION BY v ORDER BY e DESC) AS r FROM ne),
               hidx AS (SELECT v, COALESCE(MAX(CASE WHEN e >= r THEN r END), 0) AS h FROM ranked GROUP BY v)
             ${STATE_INSERT}
               SELECT ?, ?, 0, n.id, 0, COALESCE(hidx.h, 0) FROM nodes n LEFT JOIN hidx ON hidx.v = n.id`,
            [run, prev, run, next]);
          return iterateInSql(store, run, seed, step,
            (p, n) => changedCount(store, run, p, n), backstop, (d) => d === 0);
        },
      };
    },
  });
}
