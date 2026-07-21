import type { Service, CallParams } from './types.ts';
import type { ForeignRow } from '../api.ts';
import type { FederationSource } from '../segment.ts';
import { isTraversalParam } from './call-params.ts';
import { guardFederationDepth } from './federation-depth.ts';

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

/** Read the required `traversal` param — a nested sub-traversal already serialized to a rooted
 *  Gremlin string (a TraversalParam), or a bare rooted Gremlin string. */
function traversalOf(params: CallParams): string {
  const t = params.traversal;
  if (isTraversalParam(t)) return t.gremlin;
  if (typeof t === 'string' && t.length > 0) return t;
  throw new Error('mogwai.graph.federate: a "traversal" param (a nested __.V()… sub-traversal, or a rooted Gremlin string) is required');
}

/** The federated service. Registered by standard.ts's extendedRegistry only (the presence of a
 *  federation source is the gate). The FederationSource + this hop's depth are threaded to
 *  `apply` at execution time; the sibling runs one level deeper (depth + 1), guarded first. */
export const federateService: Service = {
  name: 'mogwai.graph.federate',
  type: 'barrier',
  describeParams: () => ({
    graph: 'string — the sibling graph id to run the sub-traversal on',
    traversal: 'a nested __.V()… sub-traversal (or a rooted Gremlin string) to run on the sibling',
    // Honesty surfaced in --list --verbose: a federated read is not isolated across the await.
    '~note': 'results reflect the sibling graph state at call time; not single-snapshot isolated across the segment boundary',
  }),
  resolve: () => ({
    kind: 'barrier',
    // A source-form g.call(...) ignores the (empty) input rows and runs the sub-traversal once on
    // the sibling, returning its detached rows. (Mid-traversal per-parent dispatch is 6b.) The
    // sibling hop is depth + 1, guarded before the call so a cyclic/too-deep chain fails closed.
    apply: async (_rows: readonly ForeignRow[], params: CallParams, source: FederationSource, depth: number): Promise<ForeignRow[]> => {
      const graph = graphOf(params);
      guardFederationDepth(depth + 1, graph);
      return source.executor(graph).raw(traversalOf(params), {}, depth + 1);
    },
  }),
};
