# Production readiness report — 2026-11-21

This report answers an external review of mogwai-db. The reviewer could not read `src/` or `test/`.
This report answers each concern from the code, with `path:line` evidence and some one-off measurements.
The writing uses Simplified Technical English. Each file labels its sections with a Diátaxis type:
Explanation, Reference or How-to.

No code was changed. A new feature has a plan file in `docs/`. Each plan lists open decisions for the owner.

## Verdicts (Reference)

| # | Area | Status | Report | Plan |
|---|---|---|---|---|
| 1 | Resource limits and cancellation | Partial. Limits on query text exist. Execution budgets (time, result size, memory, cancellation) are missing. | [01](01-resource-limits-and-cancellation.md) | [resource budgets](../../2026-11-21-resource-budgets-plan.md) |
| 2 | Authentication and access control | Missing. Only the outbound SSRF allowlist exists. | [02](02-authentication-and-access-control.md) | [auth](../../2026-11-21-auth-access-control-plan.md) |
| 3 | Recovery, transactions, concurrency | Partial. One write request is atomic on both runtimes, and tests prove it. Crash, parallel-request and real-DO tests are missing. | [03](03-recovery-transactions-and-concurrency.md) | [test plan](../../2026-11-21-recovery-concurrency-test-plan.md) |
| 4 | Query plan inspection (`explain()` / `profile()`) | Missing for users. Every pipeline stage is inspectable internally. | [04](04-query-plan-inspection.md) | [explain/profile](../../2026-11-21-explain-profile-plan.md) |
| 5 | Agent-memory reference app | Missing. All five memory operations answer when probed. | [05](05-agent-memory-reference-app.md) | [reference app](../../2026-11-21-agent-memory-reference-app-plan.md) |
| 6 | Remaining Gremlin edge cases | Partial. L3 passes 2,065 of 2,246 reachable scenarios. Six common gaps remain. | [06](06-gremlin-edge-cases.md) | — (untracked items listed in §7) |
| 7 | Engineering quality (reviewer items 1, 2, 3, 6) | RelIR: strong. Invariants: adequate. SQL separation: adequate. Testing: strong. | [07](07-engineering-quality.md) | [quality](../../2026-11-21-engineering-quality-plan.md) |
| 8 | Performance evidence | Partial. Guards on plan shape exist. Benchmarks and baselines are missing. | [08](08-performance-evidence.md) | [benchmark suite](../../2026-11-21-benchmark-suite-plan.md) |

## Main findings (Explanation)

- **Reviewer item 4 (partial writes) is answered.** One write program runs in one transaction
  (`src/program.ts:75-83`). Five committed tests fail if that transaction is removed. One gap remains:
  on the GraphBinary path, the element refresh runs after the commit (report 03, G1).
- **Reviewer item 2 (invariants) is partly answered.** `checkPlan` runs on every compile in production.
  It checks multiplicity, fold order, nullability and path rules. The physical passes (`fuse`, `leading`,
  `magic`) have no on/off differential test (report 07).
- **Runaway queries are the largest operational risk.** No deadline and no cancellation exist. A
  disconnected client does not stop work. Bun runs all graphs on one thread, so one runaway query blocks
  every graph (report 01).
- **There is no authentication.** Any caller can write, delete a graph or read another graph through
  `federate` (report 02). Put Cloudflare Access or a proxy in front now; report 02 has the How-to.
- **Performance, one-off probe at 100k vertices:** 1–5 hops cost 2.4–7.1× a hand-written SQLite schema.
  Property aggregation costs 15.9×. The database is 6.8× larger. Compile time is about 37× execution time
  for a point query, and compiled SQL is not cached (report 08, report 04).
- **`explain()` is feasible with clean hook points.** Report 04 §2 shows a real query as
  Step[] → RelIR → SQL → `EXPLAIN QUERY PLAN`. The plan returns a TinkerPop-shaped Map and adds
  `mogwai:*` keys, so every client can decode it.

## Recommended order (Explanation)

1. Auth in front of the deployment (How-to in report 02), then the auth plan.
2. Resource budgets: the instruments and the measurement of the DO CPU limit, then the row-pull and
   await-point budgets.
3. `explain()`/`profile()`: probe E0, the printers E1–E2, the trace E3. These give the compile and
   per-statement timings that the benchmark needs.
4. Benchmark tier S (B1–B6). It needs no new dependency.
5. Recovery and concurrency tests. The quality plan Q1 (layer-import gate).
6. The agent-memory app, after the auth fix and the JSON-map parameter fix.

## Housekeeping found by the agents

- Fixed in this commit: pointers to feature-support-matrix §17 for divergences now point to
  `docs/limitations.md` §3, and `src/sql/CLAUDE.md` no longer cites deleted `compiler/steps/` paths.
- Still open: `test/CLAUDE.md`, `test/L7-census/README.md` and `src/compiler/CLAUDE.md:59` have old counts
  (corpus size, `@Unsupported` count, fast-path count). They need a re-measure, not a text edit.
- Untracked items for `docs/outstanding-work.md`: report 06 §7, the `loadBulk` peak memory (report 08),
  and the stale L6 baseline (3 queries now answer).
