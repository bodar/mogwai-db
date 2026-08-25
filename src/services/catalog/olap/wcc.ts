import type { Service } from '../../spi/types.ts';
import { WCC_SERVICE_NAME } from '../../spi/types.ts';
import type { GraphStore } from '../../../storage.ts';
import { STATE_INSERT, VEC, adjacencyCte, changedCount, decorateBarrier, edgeScopeOf, iterateInSql, nodeCount, stringParam, type Slot } from './kernel.ts';

// ---------- mogwai.wcc — connectedComponent(), a DECORATE barrier ----------
//
// `g.V().connectedComponent()` decorates each vertex with its connected-component id under
// `gremlin.connectedComponentVertexProgram.component` and passes it through. The component id is the
// LEXICOGRAPHICALLY-smallest external id STRING in the vertex's component, over the UNDIRECTED graph
// (the reference's default message scope `__.bothE()`) — see
// `vendor/tinkerpop/gremlin-core/.../clustering/connected/ConnectedComponentVertexProgram.java:122,142`
// (`vertex.id().toString()` seed; `candidateComponent.compareTo(currentComponent) < 0` propagation).
//
// It is an ASYNC DECORATE barrier: the compute is GLOBAL (reads the whole graph inside `apply`,
// residency `'do'` — it must run beside the store), and its product is an `(id → component)` relation,
// not detached rows. The segment's decorate resume (compiler/rel/segment.ts, `lowerDecorateResume`)
// keeps the element stream LIVE and reads the component as a synthetic property under the key, so
// `has(key)`/`order().by(key)`/`project().by(key)` compose. `apply` reading the edge list and computing
// components with union-find is NOT row-at-a-time traversal interpretation — it is one bulk SQL read of
// the data plus a bounded in-JS graph computation, the barrier model (`docs/2026-08-21-barrier-substrate-design.md`).

const CC_COMPONENT_KEY = 'gremlin.connectedComponentVertexProgram.component';
const CC_PROPERTY_NAME = '~tinkerpop.connectedComponent.propertyName';
const CC_EDGES = '~tinkerpop.connectedComponent.edges';

/** connectedComponent() over a store: an async DECORATE barrier computing WCC globally. The store is
 *  captured at construction (app-scope DI, like federate/io); a compile-only scope has none, but a
 *  DECORATE barrier is `'do'` residency and its `apply` runs only where the store exists. */
export function createWccService(store: GraphStore | undefined): Service {
  return decorateBarrier({
    name: WCC_SERVICE_NAME,
    store,
    describeParams: () => ({ propertyName: `the vertex property key to write the component id under (default ${CC_COMPONENT_KEY})` }),
    plan: (params) => {
      // connectedComponent is UNDIRECTED (default bothE); union-find is symmetric, so a `both` scope is
      // exactly right and a directional (out/in) scope is a different, directional min-propagation we do
      // not model yet — fail closed rather than answer the undirected question for a directed scope.
      const scope = edgeScopeOf(params[CC_EDGES], 'both', WCC_SERVICE_NAME);
      if (scope.direction !== 'both')
        throw new Error(`${WCC_SERVICE_NAME}: only an undirected (bothE) edge scope is supported yet, not ${scope.direction}E`);
      const key = stringParam(params, CC_PROPERTY_NAME, CC_COMPONENT_KEY);
      return {
        channels: [{ key, channel: 0, vtype: 'string' }], // a component id is the min external-id STRING
        core: (store, run): number => {
          const { cte, labelBinds } = adjacencyCte(scope);
          // Seed each component to the vertex's external-id STRING (stored in `cval`, in SQL). Each
          // round takes the lexicographic MIN over {self} ∪ {neighbours} (the `e` CTE carries both
          // directions for bothE), writing the next slot. Fixpoint in ≤ diameter rounds; |V|+1 is the
          // safe backstop — one scalar COUNT, not the vertex vector.
          const backstop = nodeCount(store) + 1;
          const seed = () => store.query(
            `${STATE_INSERT} SELECT ?, 0, 0, id, 0, CAST(COALESCE(uid, id) AS TEXT) FROM nodes`,
            [run]);
          const step = (prev: Slot, next: Slot) => store.query(
            `WITH ${cte},
               ${VEC},
               adj AS (SELECT e.tgt AS id, vec.v AS v FROM e JOIN vec ON vec.id = e.src
                       UNION ALL SELECT id, v FROM vec)
             ${STATE_INSERT}
               SELECT ?, ?, 0, n.id, 0, MIN(adj.v) FROM nodes n JOIN adj ON adj.id = n.id GROUP BY n.id`,
            [...labelBinds, run, prev, run, next]);
          return iterateInSql(store, run, seed, step,
            (p, n) => changedCount(store, run, p, n), backstop, (d) => d === 0);
        },
      };
    },
  });
}
