# Compile at the edge

**Status: deferred architectural work.** Compilation is pure: it does not touch graph storage. A Durable Object is single-threaded, so parsing, lowering, and Worker-driven federation occupy the graph's serial queue despite needing no graph-local state. Move that work to the Worker once every executable is serializable data.

## Dependency

The remaining closure-backed write execution must disappear. The seam may carry only `Compiled` reads and serializable multi-statement `Program`s; a closure cannot cross Worker ↔ Durable Object. This is the RelIR write substrate, not a separate edge feature.

## Design

- The Worker parses and compiles, then calls the graph DO with a plan.
- The DO executes and frames results; it remains the sole owner of its SQLite state.
- The Worker drives federated segments, so no graph DO waits while another graph works.
- Services that need graph-local storage remain in the DO; pure services may move with compilation.

## Before building

Measure on workerd: Worker↔DO round trips, plan deserialization, cold-start share, and DO occupancy before and after. Occupancy—not client latency—is the decision metric. Start with read-plan RPC after the serializable-executable dependency is closed; add programs and federation together.
