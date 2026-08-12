# Graph-algorithm services

**Status: deferred.** Algorithms belong behind the existing `call()` service boundary, not in the
Gremlin compiler. A service receives a graph-local relation, performs one bounded computation, and
returns a typed relation that ordinary lowering can continue to traverse.

Build only reusable substrate first:

1. A graph-local service contract with typed inputs, results, and clear resource limits.
2. A recursive/iterative relational primitive that can expose convergence and reject work exceeding
   Durable Object budgets.
3. Result adapters for stream, map, and path-shaped outputs.

Use one algorithm such as PageRank or shortest path only as an end-to-end proof of those primitives.
Do not add an interpreter, GraphComputer compatibility layer, or a separate algorithm query language.
Each service must define result shape, direction/label filtering, weighting, determinism, and its
failure mode before implementation.
