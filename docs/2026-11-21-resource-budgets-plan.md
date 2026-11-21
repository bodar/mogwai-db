# Resource budgets and cancellation — operator budgets on every runtime

**Status: PROPOSED (2026-11-21).** Not started. The owner decides the open questions in §7 before work
begins. Source analysis: `docs/reports/2026-11-21-production-readiness/01-resource-limits-and-cancellation.md`.

## 1. Goal

Give the operator a **time budget** and a **result-size budget** per query. Enforce both on Bun, on a
Cloudflare Durable Object (DO) and in the browser. Stop work when the client goes away. Do this without a
`repeat()` depth cap and without any decline keyed to data size.

A budget, as used here, has four properties:

1. The operator sets it (flag, env var, `CONFIG`). The compiler never reads it.
2. When it runs out, the request fails with one named error. No stream is ever truncated as if complete.
3. It applies the same way to every query shape.
4. A write that runs out of budget rolls back, through the existing atomic unit (`runSteps`,
   `src/program.ts:75-83`).

Out of scope: the algorithmic fix for the exponential unbounded walk. That is `walk-state-collapse` in
`docs/outstanding-work.md` §2. Budgets are the backstop, not the fix.

## 2. Current state (2026-11-20, trunk `1489c279`)

| Fact | Evidence |
|---|---|
| No deadline, timer or `AbortSignal` on the query path. | `src/router.ts:98-119`, `src/execute.ts:603-613`, `src/drive.ts:352-377` |
| No time or size setting in the shared config. | `src/config.ts:16-30` |
| `wrangler.jsonc` sets no `limits` block. | `wrangler.jsonc` |
| The client's `timeoutMillis` field is ignored. | `src/wire.ts:148-171`; sent by `vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/structure/io/binary/internals/GraphBinaryWriter.js:55-58` |
| Every statement runs to completion in one call (`.all()` / `.toArray()`). | `src/bun/BunSqlite.ts:39-42`, `src/cloudflare/DurableObjectSqlite.ts:14-16` |
| Neither SQLite API exposes `sqlite3_interrupt` or a progress handler. Both expose a row iterator. | `node_modules/bun-types/sqlite.d.ts` (`iterate`); `node_modules/@cloudflare/workers-types/index.d.ts` (`SqlStorageCursor.next`) |
| The whole result is in memory before the first response byte. | `src/execute.ts:25-29`, `src/execute.ts:497-511` |
| The response stream has no `cancel` handler. | `src/http.ts:81-98` |
| Outbound `fetch` has no timeout. | `src/http-federation.ts:48` |
| Bun runs every graph on one thread. | `src/bun/server.ts:70` |
| The browser can terminate a graph Worker, at destroy only. | `src/browser/worker-spawn.ts:72-77` |
| Writes are atomic per request. | `src/program.ts:75-83`, `src/cloudflare/DurableObjectSqlite.ts:18-20`, `src/bun/BunSqlite.ts:49-51` |

**Measured (scratch probes, Bun 1.3.11, cyclic graph of 30 vertices with out-degree 3):**

| Probe | Result |
|---|---|
| `repeat(out()).until(loops().is(k)).count()`, k = 12 → 13 | 247 ms → 710 ms (×3 per loop) |
| `repeat(out()).until(has('i',-1)).limit(3)` | no answer; killed at 600 s |
| Row-pull deadline (2 s, check every 1,024 rows) on `repeat(out()).emit()` | stopped at 2,003 ms |
| Same deadline on `repeat(out()).until(has('i',-1))` and on `repeat(out()).emit().count()` | not stopped; killed at 30 s (no row is ever produced) |
| `until(loops().is(12)).values('i')` on the JSON path | 531,441 values, +106 MB RSS |

The second-to-last row is the main design constraint. A row-pull check stops only a statement that
streams rows. A statement that aggregates, sorts, or filters out every row needs a stronger mechanism.

## 3. Design

### 3.1 One budget object, threaded like `CompileBudget`

Add `QueryBudget` with `deadline` (absolute ms) and `resultBytes` (max framed bytes). The router builds it
per request from the operator config and the client's `timeoutMillis`. The effective time budget is
`min(operator, client)`. A client can shorten the budget but never extend it.

The budget travels with the execution call, not with the compile. The compiler never sees it. This keeps
locked decision 5 (the compiler depends only on the IR) and the "no platform constant in the compiler" rule
(`docs/outstanding-work.md` Rules).

### 3.2 One error class

Add `BudgetExceeded` beside `RaisedByQuery` (`src/storage.ts`). Its message names the budget, the limit
and the setting that controls it. Example: `query time budget of 30000 ms exceeded (MOGWAI_QUERY_TIME_MS)`.
It crosses the DO RPC as a value through `rpcTry` (`src/rpc.ts:49-55`). It is not an
`UnsupportedTraversal`, because the query text is valid.

### 3.3 Three enforcement layers

| Layer | Stops | Runtimes |
|---|---|---|
| A. Row pull | A statement that streams rows past the deadline or past `resultBytes`. | Bun, DO, browser |
| B. Await points | Work between segments: barrier services, `io()` pages, federation hops, a client disconnect. | all |
| C. Hard stop | A statement that produces no row until it ends. | per runtime; see §3.4 |

**Layer A.** Add an optional `Sql.iterate` (or a `query` overload with a row callback). `BunSqlite` uses
`Statement.iterate`. `DurableObjectSqlite` uses `SqlStorageCursor.next`. `GraphStore.query` checks the
deadline every K rows and adds each row's size to a byte count. The check is in the store tier, not in
the compiler.

**Layer B.** Pass `req.signal` and the deadline into `driveSegmentsFrom`. Check both before each `await`.
Pass the signal to the outbound `Http` so `fetch` aborts. Add an operator timeout for outbound calls.

### 3.4 Layer C per runtime

| Runtime | Option | Cost |
|---|---|---|
| DO | Rely on the platform CPU limit (`limits.cpu_ms`). Measure it first (item `rb0-do-cpu`). | None in code. The client sees a platform error, not `BudgetExceeded`. |
| Bun | (a) Run each graph's store in a `Worker` thread and `terminate()` it past the deadline. | A message hop per query; a re-open after terminate. The browser runtime already works this way. |
| Bun | (b) Call `sqlite3_interrupt` through `bun:ffi`. | No new package, but depends on Bun internals. Fragile. |
| Bun | (c) Accept Layers A and B only, and document the gap. | No code. A non-streaming runaway still blocks the process. |
| Browser | Terminate the graph Worker past the deadline, as `destroyGraphWorker` does now. | Re-open cost of the OPFS database. |

### 3.5 Result-size budget

Count framed bytes in `frameResolved` and `resolveJson` (`src/execute.ts:509-530`), and row bytes in Layer
A. Fail with `BudgetExceeded` past `resultBytes`. Never return a partial result.

This is not a decline on data size in the sense the root `CLAUDE.md` forbids. The operator sets the number,
the error names it, and the operator can raise it. It protects the 128 MB DO isolate from an
out-of-memory reset, which also kills every other request on that DO.

### 3.6 What stays unchanged

- No `repeat()` depth cap. No traverser-count cap. No compile-time refusal based on a budget.
- The compile budget (`src/sql/kernel/budget.ts:23`) stays a query-text limit and stays separate.
- Default budgets: see open decision D1.

## 4. Work items

Each item lands with `mise run ci` green. IDs use the prefix `rb`.

### rb0-instruments — runaway fixtures (no product change)

- Add a test fixture: a cyclic graph with out-degree 3.
- Add three runaway shapes: streaming (`emit()`), non-emitting (`until(has('i',-1))`), aggregate
  (`emit().count()`).
- Run each in a subprocess with a wall-clock kill. Record today's behaviour.
- **Acceptance:** the test documents that all three run until killed on Bun. It turns red when a budget lands, so the
  assertion is then flipped.

### rb0-do-cpu — measure the DO backstop (no product change)

- Under `wrangler dev`, run the three shapes against a DO with and without `limits.cpu_ms`.
- Run a write program that becomes a runaway after its first write.
- Record: the error the client sees, whether the DO resets, whether the write is rolled back, and whether
  other in-flight requests to the same DO fail.
- **Acceptance:** a test in `test/cloudflare.test.ts` (or the `cf-probe` harness) that pins each observed
  fact. Update `docs/limitations.md` with the measured behaviour.

### rb1-config — budget settings

- Add `queryTimeMs`, `queryResultBytes` and `outboundTimeMs` to `MogwaiConfig` (`src/config.ts:16-30`).
- Read them from flags, `MOGWAI_QUERY_TIME_MS`, `MOGWAI_QUERY_RESULT_BYTES`, `MOGWAI_OUTBOUND_TIME_MS`, and
  `CONFIG` on Cloudflare.
- Read `timeoutMillis` in `parseRequest` (`src/wire.ts:148-171`) and `parseJsonQuery`.
- **Acceptance:** config unit tests for each source. A wire test shows `timeoutMillis` from the stock
  `gremlin` client reaches `ParsedQuery`.

### rb2-error — `BudgetExceeded`

- Add the class and its message format (§3.2).
- Frame it on the GraphBinary trailer, like any query failure (`src/http.ts:49-53`).
- **Acceptance:** an error-surface test (`test/error-surface.test.ts`) shows the message on Bun and on the
  DO, and shows no stack in the DO error log.

### rb3-row-pull — Layer A

- Add the iterator to the `Sql` interface and both drivers. Keep `CfLimitedSql` composing over it.
- Check the deadline and byte count in `GraphStore.query`.
- **Acceptance:** the streaming runaway from `rb0-instruments` fails with `BudgetExceeded` within deadline
  + 10% on Bun. A write program that runs out of budget after a write leaves the graph unchanged.
  `mise run L8` and `mise run test:cf-limits` stay green. No measured query regresses by more than 2×
  (`docs/archive/2026-11-16-ladder-retirement-plan.md` scope rule).

### rb4-await-points — Layer B and cancellation

- Thread `req.signal` and the deadline through `runQuery` → executor → `driveSegmentsFrom`.
- Check them at each `await` in `driveSegmentsFrom` (`src/drive.ts:360-366`), the `io()` page loop, and the
  replication loop.
- Pass the signal and `outboundTimeMs` to `Http`.
- **Acceptance:** a federated multi-hop query against a slow fake peer fails with `BudgetExceeded` at the
  deadline. A client abort during a federated query stops further hops (observed through the fake peer's
  call count).

### rb5-result-bytes — result-size budget

- Count bytes in `frameResolved` and `resolveJson`.
- Add `limit` defaulting for a direct `_changes` call, or apply `queryResultBytes` to it.
- **Acceptance:** `until(loops().is(12)).values('i')` with a 10 MB budget fails with `BudgetExceeded` and
  RSS growth stays under 2× the budget.

### rb6-hard-stop — Layer C on Bun and in the browser

- Implement the option the owner picks in D2.
- **Acceptance:** the non-emitting and aggregate runaways from `rb0-instruments` fail at the deadline. A
  second graph on the same Bun server answers a simple query while the runaway runs.

### rb7-docs — operator documentation

- Replace "runs until the request limit stops it" in `docs/feature-support-matrix.md` §7 with the budget
  name and setting.
- Add the settings to `--help` (`src/bun/server.ts:101-117`) and to `wrangler.jsonc` comments.
- **Acceptance:** each new setting appears in `--help`, in the docs, and in a config test.

## 5. Order

`rb0-instruments` and `rb0-do-cpu` first, in parallel. Then `rb1-config` → `rb2-error` → `rb3-row-pull` →
`rb4-await-points` → `rb5-result-bytes`. `rb6-hard-stop` waits for D2. `rb7-docs` closes each item's docs
as it lands.

## 6. Risks

| Risk | Check |
|---|---|
| The per-row check slows hot reads. | Check every K rows (K = 1,024 in the probe). Measure against the perf scaling witnesses; regression bar 2×. |
| A budget is read as a data-size decline. | Distinct error class; message names the operator setting; the compiler never reads the budget. |
| Row iteration on a DO changes when rows are read, so a later write in the same span sees a different state. | Pull every row of a statement before the next statement runs. Writes still run inside `runSteps`'s atomic unit. |
| A platform CPU reset on a DO also fails other requests on that DO. | Measure in `rb0-do-cpu`. Layer A should fire before the platform limit when the operator budget is lower. |
| Budget tests are timing-dependent and flaky. | Assert "failed with `BudgetExceeded`" and a generous upper bound, never an exact time. |
| A Bun worker-thread store changes the threading model of `BunGraphManager`. | Only if D2 picks option (a). Reuse the browser runtime's Worker host pattern. |

## 7. Open decisions for the owner

- **D1 — defaults.** Should budgets be off by default (today's behaviour), or on with a default (for example
  30 s and 64 MB)? A default on Bun protects a naive deployment. A default can also fail an existing
  long-running analytic query.
- **D2 — Bun hard stop.** Pick option (a) worker thread, (b) FFI `sqlite3_interrupt`, or (c) accept the gap
  (§3.4). Option (b) adds no package but depends on Bun internals. No option needs a new dependency.
- **D3 — status code.** Which status does `BudgetExceeded` carry on the GraphBinary trailer? Today every
  query failure is 500 (`src/http.ts:49-53`). Check what TinkerPop 4 Gremlin Server sends for a timeout
  before deciding.
- **D4 — client `timeoutMillis` above the operator budget.** This plan clamps to the operator value. Confirm
  that, or allow the operator to permit a longer client value.
- **D5 — browser.** Is a per-query terminate acceptable, given the OPFS re-open cost?
