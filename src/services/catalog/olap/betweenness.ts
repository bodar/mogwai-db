import type { Service } from '../../spi/types.ts';
import { BETWEENNESS_SERVICE_NAME } from '../../spi/types.ts';
import type { GraphStore } from '../../../storage.ts';
import { STATE_INSERT, adjacencyCte, decorateBarrier, edgeScopeOf, nodeCount, stringParam } from './kernel.ts';

// ---------- betweenness — Brandes betweenness centrality ----------------------------------------
//
// `g.call("betweenness")` decorates each vertex with its betweenness — the number of shortest
// (source, target) paths that pass through it. DIRECTED by default (GDS's default orientation; the
// undirected variant halves and is left for a `direction` param).
//
// Brandes, and the first consumer of BOTH remaining barrier_state dimensions at once
// (docs/archive/2026-08-23-barrier-substrate-reshape-plan.md): it is MULTI-SOURCE (scope = source vertex) and it
// KEEPS ALL ROUNDS (round = BFS level), because the algorithm's two phases run in opposite directions:
//   FORWARD  — a level-synchronous BFS from every source at once; σ[s][v] (channel 0) = the number of
//              shortest s→v paths = Σ σ of the level-(L−1) predecessors. Node v lands in round dist(s,v).
//   BACKWARD — walk the retained levels in REVERSE; δ[s][v] (channel 1) = Σ over successors w on a
//              shortest path (dist(s,w)=dist(s,v)+1) of (σ[s][v]/σ[s][w])·(1+δ[s][w]).
// Betweenness[v] = Σ over sources s≠v of δ[s][v], written at (scope 0, channel 0) for the decorate.
//
// The scope dimension turns "run Brandes from each source" into ONE multi-source BFS; keeping every level
// is exactly the reverse-pass RETENTION the plan names as the third barrier_state limit. Matched against
// GDS's own BetweennessCentralityTest (GPLv3 — re-expressed): directed line/cycle/diamond.

const BETWEENNESS_KEY = 'betweenness';
const BE_EDGES = '~tinkerpop.betweenness.edges';
const SIGMA = 0;
const DELTA = 1;

/** betweenness() over a store: a multi-source, keep-all-rounds DECORATE barrier. */
export function createBetweennessService(store: GraphStore | undefined): Service {
  return decorateBarrier({
    name: BETWEENNESS_SERVICE_NAME,
    store,
    describeParams: () => ({
      propertyName: `the vertex property key for the score (default ${BETWEENNESS_KEY})`,
      edges: 'the message scope — a Direction or an anonymous outE/inE(labels?) edge traversal (default outE = GDS NATURAL)',
    }),
    plan: (params) => {
      const key = stringParam(params, 'propertyName', BETWEENNESS_KEY);
      // Directed adjacency, default out-edges (GDS's NATURAL orientation) — shared with every OLAP
      // algorithm through `adjacencyCte` (no more inline copy), which also gives betweenness a label
      // scope for free. `both` is refused: undirected betweenness HALVES the score (each undirected path
      // counted from both endpoints), which this directed Brandes does not do — fail closed, not a
      // silently-doubled score.
      const scope = edgeScopeOf(params[BE_EDGES], 'out', BETWEENNESS_SERVICE_NAME);
      if (scope.direction === 'both')
        throw new Error(`${BETWEENNESS_SERVICE_NAME}: only a directed (outE/inE) edge scope is supported yet, not bothE (undirected betweenness halves the score)`);
      return {
        channels: [{ key, channel: 0, vtype: 'double' }],
        core: (store, run): number => {
          const N = nodeCount(store);
          const { cte: E, labelBinds } = adjacencyCte(scope);

          // FORWARD: seed level 0 — every node is its own source with one shortest path to itself.
          store.query(`${STATE_INSERT} SELECT ?, 0, id, id, ${SIGMA}, 1 FROM nodes`, [run]);
          let maxLevel = 0;
          for (let level = 0; level < N; level++) {
            // Nodes one hop beyond level `level` not yet reached (for that source): σ = Σ predecessors' σ.
            const inserted = store.query(
              `WITH ${E},
                 frontier AS (SELECT scope, id, cval AS sigma FROM barrier_state WHERE run = ? AND round = ? AND channel = ${SIGMA}),
                 nextf AS (SELECT f.scope AS scope, e.tgt AS id, SUM(f.sigma) AS sigma
                             FROM frontier f JOIN e ON e.src = f.id GROUP BY f.scope, e.tgt)
               ${STATE_INSERT}
                 SELECT ?, ?, nf.scope, nf.id, ${SIGMA}, nf.sigma FROM nextf nf
                  WHERE NOT EXISTS (SELECT 1 FROM barrier_state s
                          WHERE s.run = ? AND s.channel = ${SIGMA} AND s.round <= ? AND s.scope = nf.scope AND s.id = nf.id)
               RETURNING id`,
              [...labelBinds, run, level, run, level + 1, run, level]);
            if (inserted.length === 0) break;
            maxLevel = level + 1;
          }

          // BACKWARD: walk levels in reverse; δ at level L reads the already-computed δ at level L+1.
          for (let level = maxLevel; level >= 0; level--) {
            store.query(
              `WITH ${E},
                 cur AS (SELECT scope, id, cval AS sigma FROM barrier_state WHERE run = ? AND round = ? AND channel = ${SIGMA}),
                 up AS (SELECT s.scope, s.id, s.cval AS sigma, COALESCE(d.cval, 0) AS delta
                          FROM barrier_state s
                          LEFT JOIN barrier_state d ON d.run = ? AND d.round = ? AND d.channel = ${DELTA} AND d.scope = s.scope AND d.id = s.id
                         WHERE s.run = ? AND s.round = ? AND s.channel = ${SIGMA}),
                 contrib AS (SELECT cur.scope, cur.id, SUM(1.0 * cur.sigma / up.sigma * (1.0 + up.delta)) AS d
                               FROM cur JOIN e ON e.src = cur.id JOIN up ON up.scope = cur.scope AND up.id = e.tgt
                              GROUP BY cur.scope, cur.id)
               ${STATE_INSERT}
                 SELECT ?, ?, cur.scope, cur.id, ${DELTA}, COALESCE(contrib.d, 0)
                   FROM cur LEFT JOIN contrib ON contrib.scope = cur.scope AND contrib.id = cur.id`,
              // cur=level L (run,L); up=successors at level L+1 — BOTH its σ (s.round) and δ (d.round) are
              // at L+1; insert δ for level L (run,L).
              [...labelBinds, run, level, run, level + 1, run, level + 1, run, level]);
          }

          // Betweenness[v] = Σ over sources s≠v of δ[s][v]. Written at (scope 0, channel 0) in a fresh
          // round the BFS never used, so the decorate binding reads exactly this. Every vertex gets a row.
          const finalRound = maxLevel + 1;
          store.query(
            `${STATE_INSERT}
               SELECT ?, ?, 0, n.id, 0, COALESCE(SUM(bs.cval), 0)
                 FROM nodes n
                 LEFT JOIN barrier_state bs ON bs.run = ? AND bs.channel = ${DELTA} AND bs.scope <> bs.id AND bs.id = n.id
                GROUP BY n.id`,
            [run, finalRound, run]);
          return finalRound;
        },
      };
    },
  });
}
