import type { BarrierRelation, CallParams, Service } from '../spi/types.ts';
import {
  PAGERANK_SERVICE_NAME, WCC_SERVICE_NAME, PEER_PRESSURE_SERVICE_NAME, SHORTEST_PATH_SERVICE_NAME,
} from '../spi/types.ts';
import type { GraphStore } from '../../storage.ts';

// ---------- mogwai.pageRank / .wcc / .peerPressure / .shortestPath — the OLAP algorithm layer ----------
//
// The four canonical TinkerPop OLAP steps (pageRank/connectedComponent/peerPressure/shortestPath)
// desugar to a call() on one of these services (ir/strategies.ts `desugarGraphAlgos`); a GDS-style
// `g.call("mogwai.pageRank", …)` reaches the same service directly. One implementation, two
// front-ends (`docs/2026-07-24-graph-algorithms-plan.md`, principle #2).
//
// All four are INTERNAL (`internal: true`): they back native TinkerPop steps, so a reference-exact
// conformance host must serve them, yet they are not part of the reference provider surface the
// official `--list`/`g_call` scenarios assert — so they are registered in BOTH registries and
// enumerated by neither, exactly as `mogwai.io` is (services/catalog/io.ts, standard.ts).

/** A not-yet-implemented OLAP service: resolvable by name, desugared into by its native step, but
 *  fails closed with a clear deferral until its compute lands. NOT a silent decline (`null`) — that
 *  would hand the traversal on as merely uncovered; this states that the service exists and its
 *  execution is pending. `type` declares the eventual contribution shape. */
function pendingAlgoService(name: string, type: Service['type']): Service {
  return {
    name,
    type,
    internal: true,
    describeParams: () => ({}),
    resolve: () => {
      throw new Error(`${name}: graph algorithm execution is not implemented yet`);
    },
  };
}

export const pageRankService: Service = pendingAlgoService(PAGERANK_SERVICE_NAME, 'barrier');
export const peerPressureService: Service = pendingAlgoService(PEER_PRESSURE_SERVICE_NAME, 'barrier');
export const shortestPathService: Service = pendingAlgoService(SHORTEST_PATH_SERVICE_NAME, 'streaming');

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

/** The decorated key: the `~tinkerpop.connectedComponent.propertyName` override, else the canonical
 *  reference key. */
function componentKey(params: CallParams): string {
  const name = params[CC_PROPERTY_NAME];
  return typeof name === 'string' && name.length > 0 ? name : CC_COMPONENT_KEY;
}

/** Weakly-connected components by union-find over the (undirected) edge list, labelling each component
 *  with the lexicographically-smallest external-id string among its members — the reference's exact
 *  `id().toString()`/string-`compareTo` rule. Returns one `(rowid → component)` tuple per vertex. */
export function connectedComponents(
  nodes: readonly { readonly id: number; readonly ext: string | number }[],
  edges: readonly { readonly src: number; readonly tgt: number }[],
): BarrierRelation['tuples'] {
  const parent = new Map<number, number>();
  for (const n of nodes) parent.set(n.id, n.id);
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // Path compression, so a large component's repeated finds stay near-constant.
    let c = x;
    while (parent.get(c) !== r) { const next = parent.get(c)!; parent.set(c, r); c = next; }
    return r;
  };
  for (const e of edges) {
    // An edge to a vertex not in `nodes` cannot arise (FK), but guard so a bad row cannot NaN the map.
    if (!parent.has(e.src) || !parent.has(e.tgt)) continue;
    parent.set(find(e.src), find(e.tgt));
  }
  // Component label = the lexicographically-smallest external-id STRING among the component's members.
  const label = new Map<number, string>();
  for (const n of nodes) {
    const root = find(n.id);
    const s = String(n.ext);
    const cur = label.get(root);
    if (cur === undefined || s < cur) label.set(root, s);
  }
  return nodes.map((n) => ({ id: n.id, value: label.get(find(n.id))! }));
}

/** connectedComponent() over a store: an async DECORATE barrier computing WCC globally. The store is
 *  captured at construction (app-scope DI, like federate/io); a compile-only scope has none, but a
 *  DECORATE barrier is `'do'` residency and its `apply` runs only where the store exists. */
export function createWccService(store: GraphStore | undefined): Service {
  return {
    name: WCC_SERVICE_NAME,
    type: 'barrier',
    internal: true,
    describeParams: () => ({ propertyName: `the vertex property key to write the component id under (default ${CC_COMPONENT_KEY})` }),
    resolve: (site) => {
      const mode = site.params.mode;
      if (mode !== undefined && mode !== 'decorate')
        throw new Error(`${WCC_SERVICE_NAME}: only decorate mode (the native connectedComponent() step) is implemented yet, not "${String(mode)}"`);
      if (site.params[CC_EDGES] !== undefined)
        throw new Error(`${WCC_SERVICE_NAME}: a custom edge scope (.with("${CC_EDGES}", …)) is not supported yet — only the default undirected (bothE) message scope`);
      const key = componentKey(site.params);
      return {
        kind: 'barrier',
        residency: 'do',
        decorate: { key },
        apply: async (): Promise<BarrierRelation> => {
          if (!store)
            throw new Error(`${WCC_SERVICE_NAME}: no graph store is available to compute connected components`);
          const nodes = store.query<{ id: number; ext: string | number }>('SELECT id, COALESCE(uid, id) AS ext FROM nodes');
          const edges = store.query<{ src: number; tgt: number }>('SELECT src, tgt FROM edges');
          return { kind: 'relation-tuples', tuples: connectedComponents(nodes, edges) };
        },
      };
    },
  };
}

/** The OLAP services with NO store dependency (pending stubs). `mogwai.wcc` is store-backed, so it is
 *  built with `createWccService(app.store)` at the registry composition root (standard.ts). */
export const pendingGraphAlgorithmServices: readonly Service[] =
  [pageRankService, peerPressureService, shortestPathService];
