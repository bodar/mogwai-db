# Query-plan stability

Generated SQL must not depend on SQLite guessing the wrong join order on skewed graph data. This is
correctness under Durable Object request budgets, not an optional micro-optimization.

## Rule

When a correlated property predicate is selective, drive the query from the selective property
relation and join back to elements, rather than hoping the planner starts there. The relational
meaning must stay identical: preserve multiplicity with `DISTINCT` where a list-cardinality property
can supply duplicate matching rows, and retain the original predicate as semantic authority.

This is a RelIR physical rewrite (`seek`), not a second lowering or a hand-written SQL special case.
It must be optional and differential-tested: disabling it may change an access path, never supported
semantics, cardinality, or observable order unless an ordering contract explicitly permits it.

## Verification

Use a representative large/skewed fixture and reduce `EXPLAIN QUERY PLAN` to stable index decisions;
do not snapshot SQL text or planner aliases. Test both rewrite positions for equal results and add a
performance ceiling only where it represents a request-budget safety boundary. Re-measure after
SQLite/workerd changes rather than treating an old plan as a permanent planner fact.

Do not solve this with unbounded `ANALYZE`/statistics assumptions: production graph distributions
and Durable Object lifecycle make that a complement to, not a substitute for, a robust access path.

## Platform and evidence anchors

`Join.ordered` is the relational order fence; SQLite emits it as `CROSS JOIN ... ON ...`, whose
left side stays the outer loop. The lowering owns this because it knows which side is the traverser
frontier. `src/rel/passes/seek.ts` recognizes the algebraic form rather than a list of Gremlin steps,
so new source predicates do not silently miss the optimization.

The necessary indexes are defined in `src/storage.ts`; `test/support/sql-core.ts` reduces
`EXPLAIN QUERY PLAN` to stable access-path decisions. On the DO runtime, statistics may be gathered,
but bounded `analysis_limit` is not authorized. Therefore post-load or alarm-time statistics are a
possible complement, never the mechanism that keeps first-request plans safe.

## Research direction

Maintain a bulk-loaded, skewed fixture large enough to expose a bad join order. For canonical point
lookup, movement, property projection, and ordered-page shapes, compare results and reduced plans
with and without statistics. Investigate any plan that scans a property/label relation when a
selective frontier exists. Re-measure on workerd after SQLite changes; emit SQL is an implementation
detail, the access path and request budget are the contract.
