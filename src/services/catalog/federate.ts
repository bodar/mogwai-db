import type { Service, CallParams, BarrierOutput } from '../spi/types.ts';
import type { ForeignResult, ForeignRow, ForeignTerminal } from '../../api.ts';
import type { FederationSource } from '../../compiler/segment.ts';
import type { ContentDemand } from '../../compiler/ir/content-demand.ts';
import { isTraversalParam } from '../params/call-params.ts';
import { subTraversalToGremlin } from '../params/traversal-param.ts';
import { guardFederationDepth } from '../params/federation-depth.ts';
import { ENDPOINT_IDS_KEY } from '../../compiler/ir/injection.ts';

const mapValuesGremlin = (gremlin: string, label: string, param: string, reducer?: string): string | null => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rewritten = gremlin.replace(new RegExp(`select\\(\\s*(['"])${escaped}\\1\\s*\\)`, 'g'), 'select(Column.values)');
  if (rewritten === gremlin || !rewritten.startsWith('g.')) return null;
  return `g.inject(${param}).unfold().group().by(Column.keys).by(__.${rewritten.slice(2)}${reducer ? `.${reducer}()` : ''})`;
};

// ---------- federate — cross-graph query pushdown (async, Barrier) ----------
//
// g.call("federate", {graph, traversal}) runs `traversal` on a SIBLING graph
// (one graph = one Durable Object; cross-graph = cross-DO) and merges the results back as
// DETACHED references (foreign.ts). It is the one 'barrier' service: its rows arrive from an
// awaited sibling call, so it contributes an async `apply` (run by the executor's segment loop,
// the one await) rather than lowering to SQL inline.
//
// The projection reuses the EXISTING executor factory: source.executor(graph).runForeign(subGremlin,
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
    throw new Error('federate: a "graph" param (the sibling graph id) is required');
  return g;
}

/** Read the required `traversal` param and SYNTHESIZE its sibling Gremlin string — the RPC edge, the one
 *  place a sub-traversal becomes a string. `params.traversal` is a `TraversalParam` carrying PARSED
 *  `IRStep[]` (call-params.ts); `subTraversalToGremlin` reconstructs the rooted text from the steps' own
 *  `ctx`. A federated call runs it as a fresh SOURCE query on a sibling, so it MUST be source-rooted
 *  (`g.V()…`/`g.E()…`) — federate enforces that here (an anonymous body, e.g. an OLAP edge scope, is not a
 *  valid federate traversal). A raw STRING param is not a thing (the grammar always gives a nested
 *  traversal → steps); only a `TraversalParam` is accepted. */
function traversalOf(params: CallParams): string {
  const t = params.traversal;
  if (!isTraversalParam(t))
    throw new Error('federate: a "traversal" param (a nested __.V()… sub-traversal) is required');
  const gremlin = subTraversalToGremlin(t.steps);
  if (!gremlin.startsWith('g.V(') && !gremlin.startsWith('g.E('))
    throw new Error(`federate: the "traversal" must be source-rooted (start with V() or E()), got: ${gremlin.replace(/^g\./, '')}`);
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
  ex: FederationExecutor, edges: readonly ForeignRow[], depth: number,
): Promise<ForeignRow[]> {
  const ids = [...new Set(edges.flatMap((e) => (e.kind === 'edge' ? [e.src, e.tgt] : [])))];
  if (ids.length === 0) return [...edges];
  // The endpoint hop is always an ELEMENT fetch (`g.V(<ids>)`), so its result is the elements arm.
  const vertices = elementsOf(await ex.runForeign(`g.V(${ENDPOINT_IDS_KEY})`, { [ENDPOINT_IDS_KEY]: ids }, depth + 1));
  return [...edges, ...vertices];
}

type FederationExecutor = { runForeign(g: string, p: Record<string, unknown>, d: number, t?: Record<string, unknown>, terminal?: ForeignTerminal): Promise<ForeignResult> };

/** The elements arm of a `ForeignResult`. A hop this helper drives is always element-shaped (the
 *  sub-traversal ends vertex/edge, or is the `g.V(<ids>)` endpoint fetch), so a scalar here is a
 *  contract violation, not a user input — fail closed rather than mis-frame. */
const elementsOf = (r: ForeignResult): readonly ForeignRow[] => {
  if (r.kind !== 'elements') throw new Error(`federate: expected element rows from the sibling, got a ${r.kind} result`);
  return r.rows;
};

/** The federated service. Registered by standard.ts's extendedRegistry only. Takes the
 *  FederationSource — how to reach other graphs — at CONSTRUCTION, off the app scope where it
 *  already lived; the per-call values (params, this hop's depth) come from the CallSite
 *  `resolve` already receives, so `apply` carries only the rows that are genuinely per-call.
 *  The sibling runs one level deeper (depth + 1), guarded first. */
export const createFederateService = (source: FederationSource | undefined): Service => ({
  name: 'federate',
  type: 'barrier',
  describeParams: () => ({
    graph: 'string — the sibling graph id to run the sub-traversal on',
    traversal: 'OPTIONAL — a nested __.V()… sub-traversal to run on the sibling (you draw the boundary). '
      + 'OMIT it to just keep traversing after the call() — the compiler infers what runs on the sibling',
    // Honesty surfaced in --list --verbose: a federated read is not isolated across the await.
    '~note': 'results reflect the sibling graph state at call time; not single-snapshot isolated across the segment boundary',
  }),
  resolve: ({ params, boundParams, federationDepth: depth, tailDemand, pushdown, mapValues }) => ({
    kind: 'barrier',
    // The one barrier that leaves the DO: a per-request sibling hop is a REMOTE WAIT, and the Worker
    // driving it frees the DO across that wait (§4·3). `apply` is store-free — it closes over the
    // FederationSource, never the store — which is the fail-closed half of that residency.
    residency: 'worker',
    apply: async (rows: readonly ForeignRow[]): Promise<BarrierOutput> => {
      // Whether the subgraph endpoint hop pays off — decided ONCE here from the call-site tail demand
      // (a typed dependency of `resolve`), captured by `apply` as a plain value, not smuggled via params.
      const wantEndpoints = fetchEndpoints(params, tailDemand);
      const graph = graphOf(params);
      guardFederationDepth(depth + 1, graph);
      // The sibling Gremlin: either the user's explicit `traversal` arg (they drew the boundary — already
      // serialized with its own params resolved, so it runs with no outer binds), or the one SYNTHESIZED
      // by pushdown for the arg-less form (win 2a) from the pushable prefix's source text — which may
      // reference the OUTER traversal's bound params (a pushed `has("age", gt(x))`), so those ride along.
      // `pushdown` is a call-site fact the segment planner computed where the tail was visible.
      const gremlin = pushdown ? pushdown.siblingGremlin : traversalOf(params);
      const siblingBinds = pushdown ? boundParams : {};
      // Fail closed rather than answer a different question: a registry carrying this service in a
      // context with no way to reach siblings is a wiring mistake, not an empty result.
      if (!source) throw new Error('federate: no federation source is wired into this graph\'s app scope');
      const ex = source.executor(graph);

      // SOURCE form (g.call(...)): no local input rows — run the sub-traversal ONCE, unbound. The
      // traversal's own bound params ride along so a pushed `has("age", gt(x))` resolves `x` sibling-side.
      if (rows.length === 0) {
        // The pushed terminal's SHAPE decides the result, and `runForeign` reports it AUTHORITATIVELY from
        // the sibling's own `plan.shape` — `apply` does not predict it. The ONE thing shape cannot express
        // is reducer-vs-stream semantics (a `count()` and a `values(k)` both compile to `value`), so the
        // `'reduce'` hint (from `pushdown.reduces`, the plan-time terminal classification) is passed to
        // disambiguate that single case. Everything else — elements vs a value stream — is read off the
        // returned tag: a pushed reducer → `barrier-scalar`, a pushed value terminal → `barrier-values`
        // (each member re-emitted as a traverser), elements → the detached rows (with the optional endpoint
        // hop for a `.with("subgraph")` tail).
        const out = await ex.runForeign(gremlin, siblingBinds, depth + 1, {}, pushdown?.reduces ? 'reduce' : undefined);
        if (out.kind === 'scalar') return { kind: 'barrier-scalar', value: out.value };
        if (out.kind === 'values') return { kind: 'barrier-values', values: out.values };
        if (out.kind === 'map') return { kind: 'barrier-scalar', value: out.value };
        return wantEndpoints ? withEndpoints(ex, out.rows, depth) : out.rows;
      }

      // STANDARD mapValues injection for `as()/select()`: the parent identity is the ordinary map
      // KEY, so equal injected values remain distinct without a hidden correlation channel. The sibling
      // sees only standard Gremlin — `inject($map).unfold().group().by(Column.keys).by(...)` — and its
      // ordinary entry-value scope supplies the rewritten `select(Column.values)` operand.
      // `SelectStep` passes a scoped value through unchanged
      // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectStep.java:66-89`).
      if (mapValues) {
        const sibling = mapValuesGremlin(gremlin, mapValues.label, mapValues.param, mapValues.reduce?.partial);
        if (!sibling) throw new Error(`federate: could not rewrite select("${mapValues.label}") for mapValues injection`);
        const values = new Map(rows.map((row, ordinal) => [String(ordinal), row.injectedValue]));
        const out = await ex.runForeign(sibling, { ...siblingBinds, [mapValues.param]: values }, depth + 1);
        if (out.kind !== 'map') throw new Error(`federate: expected a keyed map from mapValues injection, got ${out.kind}`);
        // A bare reducer is the group's value traversal, so the ordinary map is already
        // `(parentId -> partial)`. Count supplies its 0 identity while sum/min/max emit nothing on
        // empty input (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/CountGlobalStep.java:41-42`,
        // `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SumGlobalStep.java:66-68`).
        return mapValues.reduce ? { kind: 'barrier-scalar', value: out.value } : { kind: 'barrier-map', value: out.value };
      }
      // A non-injecting mid traversal is still a valid constant sibling read. The resume performs its
      // ordinary CROSS scatter over the parent stream; only the removed marker spelling lacks a route.
      const out = await ex.runForeign(gremlin, siblingBinds, depth + 1, {}, pushdown?.reduces ? 'reduce' : undefined);
      if (out.kind === 'scalar') return { kind: 'barrier-scalar', value: out.value };
      if (out.kind === 'values') return { kind: 'barrier-values', values: out.values };
      if (out.kind === 'map') throw new Error('federate: mid traversal returned an internal mapValues result');
      return wantEndpoints ? withEndpoints(ex, out.rows, depth) : out.rows;
    },
  }),
});
