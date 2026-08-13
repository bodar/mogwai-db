# src/services — call() + Service Registry + full-text search

_Scope: `src/services/**` (+ the `ftsSubstringPredicate` rewrite, `src/rel/passes/fts.ts`)._

`call()` is the extensibility seam: a `Service` registers into a `ServiceRegistry` and contributes
to the compile. `g.call(…)` contributes a RELATION spliced in at the head of the chain; `V().call(…)`
contributes a per-parent VALUE through the one child seam — the split follows TinkerPop's own
`Service.Type` (`start` vs `streaming`), which is why `RelContribution` is a union. Services build
through the ordinary fold — no new orchestrator, and nothing here builds SQL beside the plan.

## Guardrails

- **Keep the registry cycle-free.** `spi/types.ts` (leaf) ◂ `spi/registry.ts` (mechanism the
  compiler core imports) ◂ `standard.ts` (service impls, reached ONLY by DI/entry points). Do not
  make the compiler core import the service impls — that reintroduces the cycle.
- **The registry is an app-scope dependency, not `LoweringState` state** (reached via
  `engineOf(stream).registry`). A `call()` with no injected registry throws "unknown service".
- **Standard services keep TinkerPop's canonical names** (`--list`, `tinker.search`,
  `tinker.degree.centrality`); our own extensions are `mogwai.*`.

## Full-text search — `property_fts`

One FTS5 **trigram** virtual table backs both `tinker.search` and the TextP substring predicates,
maintained in the write path (the stored typed tree needs app awareness, so no triggers).
Substring matching is **case-insensitive** — a deliberate divergence that lets the trigram index
serve `LIKE`; `regex` fails closed today, never JS-filtered — INTENDED work, not a permanent wall
(`docs/2026-08-12-regex-as-a-barrier-research.md`, which is also why the trigram index matters beyond
substrings).

- **PERF TRAP: an FTS5 `DELETE` by an `UNINDEXED` column is an O(n) scan.** An unconditional
  per-write delete makes bulk writes O(n²). Delete FTS rows ONLY on a genuine overwrite.
- The `ftsSubstringPredicate` rewrite routes ≥3-char positive substring predicates over stored
  properties through the index; generic `LIKE` stays the authority + fallback for everything else. It
  is a PHYSICAL rewrite over the finished algebra (`src/rel/passes/fts.ts`, applied in `lowered`), not
  a step-level special case. ⚠️ `FtsSubstringFastPath` in `compiler/plan/plan.ts` is legacy-spine
  residue with no importers — not the live path.
