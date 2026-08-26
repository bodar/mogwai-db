import type { BarrierRelation, Service } from '../../spi/types.ts';
import { NODE_SIMILARITY_SERVICE_NAME } from '../../spi/types.ts';
import type { GraphStore } from '../../../storage.ts';
import { STATE_INSERT, syncBarrier } from './kernel.ts';

// ---------- nodeSimilarity — Jaccard node similarity, the first PAIR-OUTPUT barrier ------------
//
// `g.call("nodeSimilarity")` returns a stream of `{node1, node2, similarity}` MAPS — a NEW output
// shape (a stream of maps), unlike the per-vertex `decorate` barriers, the stream-replacing `path`
// barrier, or the detached `federate`/`io`. `apply` computes the scored pairs into `barrier_state`
// (scope = node1, id = node2, channel 0 = similarity) and returns the `(run, round)` handle; the pair
// resume (`lowerPairResume`) frames each row as a map.
//
// Similarity = Jaccard of OUT-neighbour sets: |N(u) ∩ N(v)| / |N(u) ∪ N(v)| (GDS's default metric and
// orientation). One SQL statement, no iteration: a self-join of the neighbour relation on a shared
// neighbour gives the intersection size per ordered pair, and the union is |N(u)|+|N(v)|−|∩|. Only pairs
// sharing at least one neighbour appear (similarity > 0 — GDS's similarityCutoff excludes 0). Matched
// against GDS's own NodeSimilarityTest shape (vendor/gds/algo/.../similarity/, GPLv3 — re-expressed).

/** nodeSimilarity() over a store: a source-form PAIR barrier (global, no input). */
export function createNodeSimilarityService(store: GraphStore | undefined): Service {
  return {
    name: NODE_SIMILARITY_SERVICE_NAME,
    type: 'barrier',
    internal: true,
    describeParams: () => ({}),
    resolve: () => ({
      kind: 'barrier',
      residency: 'do',
      pairs: { key1: 'node1', key2: 'node2', valueKey: 'similarity', valueVtype: 'double' },
      ...syncBarrier((): BarrierRelation => {
        if (!store)
          throw new Error(`${NODE_SIMILARITY_SERVICE_NAME}: no graph store is available to compute node similarity`);
        const run = store.allocBarrierRun();
        // Jaccard over out-neighbour sets. `inter` = common out-neighbour count per ordered pair (u≠v);
        // union = deg(u)+deg(v)−inter. Both directions (u,v) and (v,u) are emitted (same score). A node
        // with no out-neighbours never enters `nbr`, so it forms no pair.
        store.query(
          `WITH nbr(x, y) AS (SELECT DISTINCT src, tgt FROM edges),
             deg(x, d) AS (SELECT x, COUNT(*) FROM nbr GROUP BY x),
             inter AS (SELECT a.x AS u, b.x AS v, COUNT(*) AS i
                         FROM nbr a JOIN nbr b ON a.y = b.y AND a.x <> b.x
                        GROUP BY a.x, b.x)
           ${STATE_INSERT}
             SELECT ?, 0, inter.u, inter.v, 0, 1.0 * inter.i / (du.d + dv.d - inter.i)
               FROM inter JOIN deg du ON du.x = inter.u JOIN deg dv ON dv.x = inter.v`,
          [run]);
        return { kind: 'relation-ref', run, round: 0 };
      }),
    }),
  };
}
