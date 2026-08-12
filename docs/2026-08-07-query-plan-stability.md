# Query-plan stability

**Status: open.** The order fence and `propertySeek` landed. Two safeguards have not: SQLite statistics must be refreshed after bulk load and on the Durable Object alarm, and a plan-stability gate must prevent regression.

An unanalyzed 20,000-vertex graph made a selective lookup plus hop take 9.8 s; `PRAGMA optimize` reduced it to 19 ms. The indexes already existed. SQLite chose a scan from an output-property table until statistics made the selective lookup the driver.

## Required work

1. Run bounded `PRAGMA optimize` after bulk load and periodically from the graph's alarm. Measure the workerd form before choosing its schedule.
2. Add a representative large-graph `EXPLAIN QUERY PLAN` assertion. It must require the selective property access path, not merely compare result rows or elapsed time.

`propertySeek` is a physical rewrite, not a substitute for statistics: it protects the important lookup shape, while statistics keep the rest of the planner's choices credible. Keep the test under both ordinary and perturbed-order execution.

## Scope

This is RelIR-only. Do not revive the deleted legacy compiler to solve it. The relevant implementation is `src/rel/passes/seek.ts`; the platform probe belongs in `test/cf-probe/`.
