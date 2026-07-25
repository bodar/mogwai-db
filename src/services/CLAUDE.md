# src/services — call() + Service Registry + full-text search

_Scope: `src/services/**` (+ the `ftsSubstringPredicate` fast path in `compiler/plan/plan.ts`).
Design: `docs/2026-07-20-call-service-registry-plan.md`._

`call()` is the extensibility seam: a `Service` registers into a `ServiceRegistry` and contributes
to the compile. `g.call(…)` sources a stream; `V().call(…)` pushes a child scope. Services build
through the ordinary kernel + streams — no new orchestrator.

## Guardrails

- **Keep the registry cycle-free.** `spi/types.ts` (leaf) ◂ `spi/registry.ts` (mechanism the
  compiler core imports) ◂ `standard.ts` (service impls, reached ONLY by DI/entry points). Do not
  make the compiler core import the service impls — that reintroduces the cycle.
- **The registry is an app-scope dependency, not `Carry` state** (reached via
  `engineOf(stream).registry`). A `call()` with no injected registry throws "unknown service".
- **Standard services keep TinkerPop's canonical names** (`--list`, `tinker.search`,
  `tinker.degree.centrality`); our own extensions are `mogwai.*`.

## Full-text search — `property_fts`

One FTS5 **trigram** virtual table backs both `tinker.search` and the TextP substring predicates,
maintained in the write path (the stored typed tree needs app awareness, so no triggers).
Substring matching is **case-insensitive** — a deliberate divergence that lets the trigram index
serve `LIKE`; `regex` stays deferred (fail closed, never JS-filtered).

- **PERF TRAP: an FTS5 `DELETE` by an `UNINDEXED` column is an O(n) scan.** An unconditional
  per-write delete makes bulk writes O(n²). Delete FTS rows ONLY on a genuine overwrite.
- The `ftsSubstringPredicate` fast path routes ≥3-char positive substring predicates over stored
  properties through the index; generic `LIKE` stays the authority + fallback for everything else.
