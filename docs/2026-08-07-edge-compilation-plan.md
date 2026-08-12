# Compile at the edge

**Status: deferred.** A Durable Object is a single-threaded graph/database queue; compilation is
pure work that does not require graph storage. When execution plans are data rather than closures,
the Worker may compile and the DO may execute.

## Boundary

The Worker compiles the canonical Gremlin request, parameters, and types to a serializable plan. A
DO receives that plan, executes it against its own graph, and frames rows near storage. Bun continues
to use the same loop in-process. This is placement, not a second compiler or a new query language.

Only data crosses the RPC boundary. A `Compiled` read or RelIR `Program` can cross; a closure-backed
plan cannot. The prerequisite is complete set-based write lowering: a program's bindings and retained
rows are data, while a legacy `run(store)` is not.

The enabling claim must remain tested: compilation has no `Sql` access. A plan carries SQL, binds,
framing, and retained-row transport—not a parser-specific or versioned traversal serialization.
Framing stays near the rows unless a concrete edge consumer needs decoded values.

## Segmented services

The Worker should drive a segmented/federated plan: request a fully drained local head, call sibling
graphs in parallel, then resume the next segment. A graph DO must not remain occupied while a sibling
does storage work. The trade-off is additional Worker↔DO transfers, so carry detached rows—not
GraphBinary buffers—and measure row volume as well as occupancy.

Services divide by resource ownership: a service needing the graph store stays in the DO; an external
service may run at the edge; a mixed operation is explicitly split. Never let a service's current
implementation choose this policy accidentally.

## Guardrails

- The fallback remains the current request path until every executable plan is serializable.
- The plan RPC is an authority/security boundary and must remain graph-scoped.
- No cursor crosses an `await`; segment heads are fully drained before external work.
- Evaluate the change by DO occupancy, not only request latency.

## Research and delivery order

First extract the segment driver into a store-injected function and prove Bun keeps identical
behaviour. Next, measure a read-plan RPC on workerd: Worker↔DO serialization, DO occupancy, and
cold-start effect. Only after every executable plan is data should the Worker drive segmented
federation and write programs.

The deciding measurements are: non-storage share of DO occupancy, size/cost of a serialized
`Program`, and whether Worker-driven federation frees the top DO enough to repay extra row transfers.
Use a workload with many small graphs; a single warm Bun process cannot answer those questions.
