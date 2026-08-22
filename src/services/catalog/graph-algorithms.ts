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
        decorate: { key, vtype: 'string' }, // a component id is the min external-id STRING
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

// ---------- mogwai.pageRank — pageRank(), a DECORATE barrier ----------
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

/** PageRank over the default `outE` scope, a faithful replay of the reference BSP. `alpha` is the
 *  damping factor (`pageRank(α)`); dangling vertices (out-degree 0) redistribute their rank through the
 *  global teleportation energy, exactly as `PageRankVertexProgram` does — which is what makes the modern
 *  graph's sinks (vadas/lop/ripple) rank correctly. Returns one `(rowid → score)` tuple per vertex. */
export function pageRankScores(
  nodes: readonly { readonly id: number }[],
  edges: readonly { readonly src: number; readonly tgt: number }[],
  alpha: number,
): BarrierRelation['tuples'] {
  const ids = nodes.map((n) => n.id);
  const N = ids.length;
  if (N === 0) return [];
  const out = new Map<number, number[]>(ids.map((id) => [id, []]));
  for (const e of edges) out.get(e.src)?.push(e.tgt);
  const outdeg = new Map<number, number>(ids.map((id) => [id, out.get(id)!.length]));
  const pr = new Map<number, number>(ids.map((id) => [id, 0])); // the reported property (orElse 0)
  let messages = new Map<number, number>(ids.map((id) => [id, 0]));
  let teleport = 1.0; // TELEPORTATION_ENERGY seed (no initialRankTraversal)
  for (let k = 1; k <= PR_MAX_ITERATIONS; k++) {
    const teleportK = teleport;
    const localTerminal = teleportK > 0 ? teleportK / N : 0;
    const nextMessages = new Map<number, number>(ids.map((id) => [id, 0]));
    let nextTeleport = 0; // net of the reference's -localTerminal (×N = -teleportK) + (1-α)pr + dangling
    let convergence = 0;
    for (const id of ids) {
      // iter 1 seeds from teleport only (initial rank 0); later iters sum incoming messages.
      let rank = (k === 1 ? 0 : messages.get(id)!) + (teleportK > 0 ? localTerminal : 0);
      convergence += Math.abs(rank - pr.get(id)!);
      pr.set(id, rank);
      nextTeleport += (1 - alpha) * rank;
      const send = alpha * rank;
      const od = outdeg.get(id)!;
      if (od > 0) { const share = send / od; for (const t of out.get(id)!) nextMessages.set(t, nextMessages.get(t)! + share); }
      else nextTeleport += send; // a sink redistributes its rank through teleport (dangling nodes)
    }
    teleport = nextTeleport;
    messages = nextMessages;
    if (convergence < PR_EPSILON) break;
  }
  return ids.map((id) => ({ id, value: pr.get(id)! }));
}

/** pageRank() over a store: an async DECORATE barrier. The store is captured at construction (app-scope
 *  DI); `apply` reads the graph and replays the reference BSP. */
export function createPageRankService(store: GraphStore | undefined): Service {
  return {
    name: PAGERANK_SERVICE_NAME,
    type: 'barrier',
    internal: true,
    describeParams: () => ({ propertyName: `the vertex property key to write the rank under (default ${PR_PAGERANK_KEY})` }),
    resolve: (site) => {
      const mode = site.params.mode;
      if (mode !== undefined && mode !== 'decorate')
        throw new Error(`${PAGERANK_SERVICE_NAME}: only decorate mode (the native pageRank() step) is implemented yet, not "${String(mode)}"`);
      if (site.params[PR_EDGES] !== undefined)
        throw new Error(`${PAGERANK_SERVICE_NAME}: a custom edge scope (.with("${PR_EDGES}", …)) is not supported yet — only the default outE message scope`);
      if (site.params[PR_TIMES] !== undefined)
        throw new Error(`${PAGERANK_SERVICE_NAME}: a fixed iteration count (.with("${PR_TIMES}", …)) is not supported yet — pageRank runs to convergence (α=${PR_ALPHA_DEFAULT}, ε=${PR_EPSILON}, ≤${PR_MAX_ITERATIONS} iterations)`);
      const alpha = typeof site.params.dampingFactor === 'number' ? site.params.dampingFactor : PR_ALPHA_DEFAULT;
      const nameOverride = site.params[PR_PROPERTY_NAME];
      const key = typeof nameOverride === 'string' && nameOverride.length > 0 ? nameOverride : PR_PAGERANK_KEY;
      return {
        kind: 'barrier',
        residency: 'do',
        decorate: { key, vtype: 'double' }, // a PageRank score is a double
        apply: async (): Promise<BarrierRelation> => {
          if (!store)
            throw new Error(`${PAGERANK_SERVICE_NAME}: no graph store is available to compute PageRank`);
          const nodes = store.query<{ id: number }>('SELECT id FROM nodes');
          const edges = store.query<{ src: number; tgt: number }>('SELECT src, tgt FROM edges');
          return { kind: 'relation-tuples', tuples: pageRankScores(nodes, edges, alpha) };
        },
      };
    },
  };
}

/** The OLAP services with NO store dependency (pending stubs). `mogwai.wcc` and `mogwai.pageRank` are
 *  store-backed, so they are built with their `create*Service(app.store)` factories at the registry
 *  composition root (standard.ts). */
export const pendingGraphAlgorithmServices: readonly Service[] =
  [peerPressureService, shortestPathService];
