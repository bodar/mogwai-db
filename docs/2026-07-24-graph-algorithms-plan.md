# Graph-algorithm services

**Status: deferred.** Algorithms belong behind `call()` services, not as independent compiler
lowerings. The service is the extensible surface; TinkerPop's native OLAP names desugar to that
same service so there is one implementation.

## Architecture

An iterative algorithm is host-driven iteration over set-based SQL statements, never a
row-at-a-time traversal interpreter. A service may retain a graph-local working relation between
iterations, but each iteration is a bounded relational operation with explicit resource limits.

```
native Gremlin step ─┐
                     ├─ extract Pass → call('mogwai.<algorithm>', config)
mogwai.<algorithm> ──┘                        │
                                      barrier service / set-based SQL
                                                │
                              stream, mutate, stats, or element-decoration result
```

The native step's result contract is not necessarily the service's. For example, an OLAP-style
score step must rejoin scores to incoming elements and preserve the element stream; a direct service
call may return score rows. `shortestPath` is path-shaped and requires its own result adapter.

Anchor the implementation at `src/services/spi/types.ts` and the existing degree-centrality service.
The native names are already in the v4 grammar, but exact modulators, result property keys, and
error behaviour must be read from `vendor/tinkerpop/gremlin-core` and `gremlin-test` at the pin.

## Scope and limits

- Good candidates are bounded SQL passes: degree-like centrality, connected components, label
  propagation, triangle counts, unweighted paths, and selected iterative algorithms.
- Weighted/global algorithms are conditional on explicit graph-size and request-budget limits.
- Embeddings, approximate nearest-neighbour, gradient/ML pipelines, and work requiring UDFs or
  parallel in-memory state remain explicit refusals on this substrate.
- Long-running work may use a checkpointed service/alarm model; a live element-decoration query
  must finish within one request or fail clearly.

## Research sequence

1. **Contract probe.** For one native step, trace the core step and feature scenarios: input scope,
   configuration surface, result type, and whether it decorates incoming elements or emits a new
   stream.
2. **Service spike.** Implement the same algorithm only behind `call()` using a bounded set-based
   iteration. Measure convergence, dangling/empty cases, and a graph-size refusal on workerd.
3. **Result adapters.** Prove `stream`, mutation, and element-decoration modes agree where they
   represent the same result; add the native desugar only after this proof.
4. **Classify the next family.** Use a feasibility spike to decide whether it is recursive SQL,
   checkpointed iteration, or a permanent refusal. Do not promise approximate algorithms without a
   quality contract.

## Guardrails

- A named TinkerPop step only desugars; it never receives a second StepFn lowering.
- Reuse canonical TinkerPop names and use `mogwai.*` for extensions.
- Verify native and service modes agree where their result contracts overlap.
- Validate exact step semantics against the pinned TinkerPop core and feature corpus before adding a
  native name.
- Every unavailable algorithm or configuration fails closed with a useful message.
