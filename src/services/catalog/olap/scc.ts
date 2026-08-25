import type { Service } from '../../spi/types.ts';
import { SCC_SERVICE_NAME } from '../../spi/types.ts';
import type { GraphStore } from '../../../storage.ts';
import { STATE_INSERT, decorateBarrier, stringParam } from './kernel.ts';

// ---------- mogwai.scc — strongly connected components, a ONE-SHOT decorate barrier ----------
//
// `g.V().call("mogwai.scc")` decorates each vertex with its strongly-connected-component id and passes
// it through. Unlike connectedComponent() (mogwai.wcc, UNDIRECTED union-find), an SCC respects edge
// DIRECTION: u and v share a component iff u reaches v AND v reaches u over the directed edges. The
// partition is algorithm-independent (any correct SCC yields the same grouping — the property GDS's own
// SccTest asserts, `vendor/gds/algo/src/test/java/org/neo4j/gds/scc/SccTest.java`, GPLv3 — re-expressed),
// so we compute it correct-by-construction from mutual reachability rather than replaying GDS's Tarjan.
//
// Like triangleCount it needs NO BSP iteration: ONE INSERT..SELECT whose recursive `reach` CTE is the
// directed transitive closure (bounded by V², dedup via UNION), then a mutual self-join groups each
// vertex to the lexicographically-smallest external id in its component — the same representative
// convention wcc uses, so both component families read the same way. `apply` runs it into `barrier_state`
// round 0; the decorate resume reads it as a synthetic property, so has()/order().by()/project().by()
// compose over the live stream. The compute is one bulk SQL read plus a bounded closure (the barrier
// model, `docs/2026-08-21-barrier-substrate-design.md`), never row-at-a-time interpretation.

const SCC_COMPONENT_KEY = 'componentId';

/** strongly connected components over a store: a ONE-SHOT directed DECORATE barrier. */
export function createSccService(store: GraphStore | undefined): Service {
  return decorateBarrier({
    name: SCC_SERVICE_NAME,
    store,
    describeParams: () => ({ propertyName: `the vertex property key to write the component id under (default ${SCC_COMPONENT_KEY})` }),
    plan: (params) => {
      const key = stringParam(params, 'propertyName', SCC_COMPONENT_KEY);
      return {
        channels: [{ key, channel: 0, vtype: 'string' }], // component id = min external-id STRING (wcc convention)
        core: (store, run): number => {
          // reach(a, b): a reaches b over directed edges (incl. a=a). Extend the frontier by following the
          // out-edges of the reached endpoint b. UNION dedups, so it converges in ≤ diameter expansions.
          // scc(v, rep): for each v, the min external-id over all u that are MUTUALLY reachable with v
          // (r1: v→u, r2: u→v). v is always its own co-member (reach holds (v,v)), so every vertex is
          // covered and gets at least itself as a candidate representative.
          store.query(
            `WITH RECURSIVE
               reach(a, b) AS (
                 SELECT id, id FROM nodes
                 UNION
                 SELECT r.a, e.tgt FROM reach r JOIN edges e ON e.src = r.b),
               scc(v, rep) AS (
                 SELECT r1.a, MIN(CAST(COALESCE(n.uid, n.id) AS TEXT))
                   FROM reach r1
                   JOIN reach r2 ON r2.a = r1.b AND r2.b = r1.a
                   JOIN nodes n ON n.id = r1.b
                  GROUP BY r1.a)
             ${STATE_INSERT}
               SELECT ?, 0, 0, n.id, 0, scc.rep FROM nodes n JOIN scc ON scc.v = n.id`,
            [run]);
          return 0;
        },
      };
    },
  });
}
