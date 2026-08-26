import type { Service, CallParams } from '../spi/types.ts';
import type { ForeignRow } from '../../api.ts';
import type { FederationSource } from '../../compiler/segment.ts';
import type { ContentDemand } from '../../compiler/ir/content-demand.ts';
import { isTraversalParam } from '../params/call-params.ts';
import { guardFederationDepth } from '../params/federation-depth.ts';
import { ENDPOINT_IDS_KEY, INJECT_VALUES_KEY } from '../../compiler/ir/injection.ts';

// ---------- mogwai.graph.federate — cross-graph query pushdown (async, Barrier) ----------
//
// g.call("mogwai.graph.federate", {graph, traversal}) runs `traversal` on a SIBLING graph
// (one graph = one Durable Object; cross-graph = cross-DO) and merges the results back as
// DETACHED references (foreign.ts). It is the one 'barrier' service: its rows arrive from an
// awaited sibling call, so it contributes an async `apply` (run by the executor's segment loop,
// the one await) rather than lowering to SQL inline.
//
// The projection reuses the EXISTING executor factory: source.executor(graph).raw(subGremlin,
// {}, depth) IS "run a traversal on another graph, raw." The sub-traversal arrived as a nested
// __.-traversal param, already serialized to a canonical rooted Gremlin string (call-params.ts →
// traversal-param.ts). The sibling runs the SAME engine on it — genuine federated pushdown; if
// the sub-traversal itself contains a federate call(), that recurses (bounded by the depth guard:
// each hop is depth+1, guarded before the sibling call).
//
// Registered only in the EXTENDED registry (standard.ts), so a reference-exact context (the L3
// conformance host) neither lists nor resolves it — correct-by-design.

/** Read the required `graph` param (the sibling graph id) — a plain string. */
function graphOf(params: CallParams): string {
  const g = params.graph;
  if (typeof g !== 'string' || g.length === 0)
    throw new Error('mogwai.graph.federate: a "graph" param (the sibling graph id) is required');
  return g;
}

/** Read the required `traversal` param — a nested sub-traversal serialized to a Gremlin string (a
 *  TraversalParam), or a bare Gremlin string. A federated call runs it as a fresh SOURCE query on a
 *  sibling, so it MUST be source-rooted (`g.V()…`/`g.E()…`); the serializer no longer enforces that
 *  (an OLAP edge scope carries an anonymous body through the same seam), so federate enforces its own
 *  need here — an anonymous `__.…` body fails closed rather than becoming an invalid `g.…` query. */
function traversalOf(params: CallParams): string {
  const t = params.traversal;
  const gremlin = isTraversalParam(t) ? t.gremlin : typeof t === 'string' && t.length > 0 ? t : null;
  if (gremlin === null)
    throw new Error('mogwai.graph.federate: a "traversal" param (a nested __.V()… sub-traversal, or a rooted Gremlin string) is required');
  if (!gremlin.startsWith('g.V(') && !gremlin.startsWith('g.E('))
    throw new Error(`mogwai.graph.federate: the "traversal" must be source-rooted (start with V() or E()), got: ${gremlin.replace(/^g\./, '')}`);
  return gremlin;
}

/** `.with("subgraph", true)` — the sub-traversal is EDGE-producing and the caller wants a traversable
 *  SUBGRAPH back, not detached edges: the edges (which carry `src`/`tgt` adjacency) PLUS their distinct
 *  incident vertices, WITH data. The local tail then walks it (`inV`/`outV` join the landed vertices) —
 *  the movement-over-a-bound-`Ref` substrate (`docs/2026-08-21-barrier-substrate-design.md`). */
const wantsSubgraph = (params: CallParams): boolean => params.subgraph === true;

/** Whether to actually FETCH the subgraph's endpoint vertices — decided ONCE at plan time in `resolve`,
 *  from the call-site's `tailDemand`. A `.with("subgraph", true)` asks for a traversable subgraph, but the
 *  endpoint hop only pays off if the LOCAL TAIL reaches the endpoint vertices (a movement/endpoint hop or a
 *  `.V()` re-source or an edge `elementMap()` — `ContentDemand.reachesAdjacency`). An edges-only or reducing
 *  tail (`…count()`, `.E()…`) does not, so we skip the second sibling hop and the wasted vertex
 *  materialization (`docs/2026-08-26-federate-pushdown-design.md`, phase 3). No `tailDemand` (a caller that
 *  planned no segment tail) = assume it is needed — the safe over-fetch. The demand only ever NARROWS, so a
 *  wrong analysis over-fetches, never under-fetches (the wrong-answer direction). */
const fetchEndpoints = (params: CallParams, tailDemand: ContentDemand | undefined): boolean =>
  wantsSubgraph(params) && (tailDemand ? tailDemand.reachesAdjacency : true);

/**
 * A subgraph result: the edges the sub-traversal produced, followed by their DISTINCT incident
 * vertices (fetched with a second sibling hop, WITH data). The mixed-kind array IS the signal to the
 * resume that this is a subgraph — a normal federated result is homogeneous (all one element kind).
 *
 * The endpoint fetch is `g.V(<ids>)` on the same sibling: bounded by the edge set, one hop. The ids
 * cross as ONE bound-collection param (`ENDPOINT_IDS_KEY`), which the sibling's `elementScan` explodes
 * via `json_each` — the id set never enters the sibling's statement text, for ANY subgraph size (the
 * data-not-in-text rule applied across the wire). This is the same "data-sized set = one bind" substrate
 * the mid-traversal value injection below uses, and the base-graph `V($ids)` path (`source.ts`).
 */
async function withEndpoints(
  ex: { raw(g: string, p: Record<string, unknown>, d: number): Promise<ForeignRow[]> },
  edges: readonly ForeignRow[], depth: number,
): Promise<ForeignRow[]> {
  const ids = [...new Set(edges.flatMap((e) => (e.kind === 'edge' ? [e.src, e.tgt] : [])))];
  if (ids.length === 0) return [...edges];
  const vertices = await ex.raw(`g.V(${ENDPOINT_IDS_KEY})`, { [ENDPOINT_IDS_KEY]: ids }, depth + 1);
  return [...edges, ...vertices];
}

/** The federated service. Registered by standard.ts's extendedRegistry only. Takes the
 *  FederationSource — how to reach other graphs — at CONSTRUCTION, off the app scope where it
 *  already lived; the per-call values (params, this hop's depth) come from the CallSite
 *  `resolve` already receives, so `apply` carries only the rows that are genuinely per-call.
 *  The sibling runs one level deeper (depth + 1), guarded first. */
export const createFederateService = (source: FederationSource | undefined): Service => ({
  name: 'mogwai.graph.federate',
  type: 'barrier',
  describeParams: () => ({
    graph: 'string — the sibling graph id to run the sub-traversal on',
    traversal: 'a nested __.V()… sub-traversal (or a rooted Gremlin string) to run on the sibling',
    // Honesty surfaced in --list --verbose: a federated read is not isolated across the await.
    '~note': 'results reflect the sibling graph state at call time; not single-snapshot isolated across the segment boundary',
  }),
  resolve: ({ params, federationDepth: depth, tailDemand }) => ({
    kind: 'barrier',
    // The one barrier that leaves the DO: a per-request sibling hop is a REMOTE WAIT, and the Worker
    // driving it frees the DO across that wait (§4·3). `apply` is store-free — it closes over the
    // FederationSource, never the store — which is the fail-closed half of that residency.
    residency: 'worker',
    apply: async (rows: readonly ForeignRow[]): Promise<ForeignRow[]> => {
      // Whether the subgraph endpoint hop pays off — decided ONCE here from the call-site tail demand
      // (a typed dependency of `resolve`), captured by `apply` as a plain value, not smuggled via params.
      const wantEndpoints = fetchEndpoints(params, tailDemand);
      const graph = graphOf(params);
      guardFederationDepth(depth + 1, graph);
      const gremlin = traversalOf(params);
      // Fail closed rather than answer a different question: a registry carrying this service in a
      // context with no way to reach siblings is a wiring mistake, not an empty result.
      if (!source) throw new Error('mogwai.graph.federate: no federation source is wired into this graph\'s app scope');
      const ex = source.executor(graph);

      // SOURCE form (g.call(...)): no local input rows — run the sub-traversal ONCE, unbound.
      if (rows.length === 0) {
        const result = await ex.raw(gremlin, {}, depth + 1);
        return wantEndpoints ? withEndpoints(ex, result, depth) : result;
      }

      // MID-TRAVERSAL form (V().call(...)): each head row carries a per-parent injected scalar
      // (values(k)/id()/label()) — the value the sub-traversal's `T.value` marker operand stands in
      // for (e.g. __.V().has('sku', T.value)). BATCH: supply the DISTINCT injected values under the
      // reserved INJECT_VALUES_KEY params entry and run the sibling ONCE; the sibling's has()/is()
      // compile substitutes a within(<distinct>) for the marker (see injection.ts). The const/single-
      // value case is the natural degenerate collapse (a 1- or 0-element set). Results are then
      // SCATTERED back over the parents: each returned element re-matches the injected value it
      // satisfies (by property /
      // id / label — see the resume rejoin), so apply returns the sibling's flat pool and the
      // per-parent fan-out happens in resume's SQL. Here apply just runs the one batched hop.
      const distinct = [...new Map(rows.map((r) => [JSON.stringify(r.injectedValue), r.injectedValue])).values()];
      const result = await ex.raw(gremlin, { [INJECT_VALUES_KEY]: distinct }, depth + 1);
      return wantEndpoints ? withEndpoints(ex, result, depth) : result;
    },
  }),
});
