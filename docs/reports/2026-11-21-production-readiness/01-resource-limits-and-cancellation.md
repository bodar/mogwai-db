# 01 — Resource limits and cancellation

**Reviewer concern.** "Prevents pathological queries from destabilising deployments." Audit item 5:
"Are timeouts, cancellation, recursion limits and memory limits enforced reliably across all runtimes?"

**Short answer.** No. The concern is valid. mogwai-db enforces limits on **query text** (statement size,
bind count, compile work, federation depth). It enforces **no limit on execution**: no time budget, no
result-size budget, no memory budget and no cancellation. On Cloudflare the platform's own per-request CPU
and memory limits are the only backstop. On Bun and in the browser there is no backstop.

Code state: trunk `1489c279` (2026-11-20). Plan for the missing features:
[`docs/2026-11-21-resource-budgets-plan.md`](../../2026-11-21-resource-budgets-plan.md).

Status keys: **exists**, **partial**, **missing**. "Measured" means a run in this audit. "Inferred" means
read from code or platform documentation, not run.

---

## 1. Summary table (Reference)

| # | Control | Bun | Cloudflare DO | Browser | Status | Evidence |
|---|---|---|---|---|---|---|
| 1 | Per-query wall-clock or CPU time budget | none | platform CPU limit only; not set in `wrangler.jsonc` | none | **missing** | §3.1 |
| 2 | Client `timeoutMillis` request field | ignored | ignored | ignored | **missing** | §3.2 |
| 3 | Cancellation on client disconnect | none | none | none | **missing** | §3.3 |
| 4 | Interrupt a running SQLite statement | not possible through `bun:sqlite` API | not possible through `ctx.storage.sql` API | `Worker.terminate()` at graph destroy only | **missing** | §3.4 |
| 5 | Result-size budget | none | none (128 MB isolate memory is the backstop) | none | **missing** | §3.5 |
| 6 | Memory budget | none | platform isolate memory only | none | **missing** | §3.5 |
| 7 | Streaming of results | chunk pacing over a fully built array | same | same | **partial** | §3.6 |
| 8 | Writes on failure | atomic rollback | atomic rollback | atomic rollback | **exists** | §3.7 |
| 9 | Statement text cap (100 KB), bind cap (100), value cap (2 MB) | asserted by `CfLimitedSql` in tests | enforced by platform | n/a | **exists** | §4.1 |
| 10 | Compile-work budget (400 KB per statement) | yes | yes | yes | **exists** | §4.2 |
| 11 | JavaScript stack depth at compile | clean decline | clean decline | clean decline | **exists** | §4.3 |
| 12 | Federation hop depth (4) | yes | yes | yes | **exists** | §4.4 |
| 13 | `repeat()` recursion depth | no cap, by design | no cap, by design | no cap, by design | **exists (deliberate)** | §2, §4.5 |
| 14 | `io()` memory bound | one page / one part | one page / one 8 MiB part | one page | **exists** | §4.6 |
| 15 | Replication pacing | operator knobs | operator knobs | operator knobs | **exists** | §4.7 |
| 16 | Request body size | Bun default 128 MB | platform default | n/a | **partial** | §3.8 |
| 17 | Outbound HTTP timeout (`federate`, `io()` over URL) | none | platform subrequest limits only | none | **missing** | §3.9 |
| 18 | Isolation between graphs | none: one thread for all graphs | one DO per graph | one Worker per graph | **partial** | §3.10 |

---

## 2. Why there is no depth cap, and what a budget is (Explanation)

### 2.1 The project rule

The root `CLAUDE.md` forbids a depth cap on `repeat()`. A cyclic body without `simplePath()` is infinite
per the Gremlin specification. The project compiles it as written. The DO's per-request limit is the named
backstop. `docs/feature-support-matrix.md` §7 states the same rule to users.

The root `CLAUDE.md` also says: never decline on data size. A refusal keyed to a traverser count, row count
or window size passes every test graph and fails only in production.

### 2.2 A cap and a budget are different things

A **cap** is a limit that the product applies to the query. It changes the answer or refuses the query. It
is keyed to a count that depends on the data. Example: "stop `repeat()` after 100 loops", or "refuse a
result over 10,000 rows".

A **budget** is a limit that the operator applies to a request's use of resources. Examples: wall-clock
time, CPU time, result bytes. A budget has four properties:

1. The operator sets it. It is a deployment setting, not a compiler constant.
2. It never changes an answer. When it runs out, the request fails with a named error. It never returns a
   truncated stream as if complete.
3. It is the same for every query shape. The compiler does not read it.
4. A write that runs out of budget rolls back, as any other failed write does (§3.7).

A budget can still fail a query on a large graph that passes on a small graph. This is acceptable because
the operator chose the number and can change it. The error says which budget ran out and which setting
controls it. A cap hides inside the product, and the operator cannot change it.

The Cloudflare CPU limit is already a budget in this sense. The plan proposes the same kind of control for
every runtime, owned by the operator.

### 2.3 Why the adversarial case matters

The reviewer's case is a recursive traversal on a power-law graph. mogwai-db has two `repeat()` regimes
(`docs/archive/2026-08-09-repeat-two-regimes-plan.md`):

- **Bounded** (`times(n)`): an unroll into phases. Each phase merges equal traversers into one row with a
  `bulk` count. The row count per phase is at most the number of distinct elements. Cost grows linearly
  in `n`.
- **Unbounded** (`until`/`emit` without `times`): a recursive CTE (`repeatWalk`,
  `src/compiler/rel/walk.ts:68`). A recursive SQL term cannot hold an aggregate, so equal traversers stay
  separate rows. Row count grows as (branching factor)^depth. This is the open item `walk-state-collapse`
  in `docs/outstanding-work.md` §2.

On a power-law graph the branching factor near a hub is large. So the unbounded regime can exhaust CPU,
memory or temporary disk in a few loops.

---

## 3. Missing and partial controls (Reference)

### 3.1 Per-query time budget — missing

- No source file reads a deadline, a timer or an `AbortSignal` on the query path. A search of `src/` for
  `AbortSignal`, `timeout`, `deadline` and `signal` finds only the replication scheduler timer
  (`src/scheduler.ts:121-132`) and the browser close timeout (`src/browser/worker-spawn.ts:77`).
- `MogwaiConfig` has no time or size setting (`src/config.ts:16-30`).
- `wrangler.jsonc` has no `limits` block. So a DO runs under the Cloudflare default CPU limit (inferred
  from platform documentation; not measured in this repo).
- `docs/outstanding-work.md` `io-residue` says nobody has measured a full `io()` round trip against the
  5-minute CPU budget.

**Measured on Bun** (cyclic graph: 30 vertices, out-degree 3, scratch probe; Bun 1.3.11):

| Query | Time | Result |
|---|---|---|
| `g.V(1).repeat(out()).times(12).count()` | 9.3 ms | 531,441 |
| `g.V(1).repeat(out()).until(loops().is(10)).count()` | 40.5 ms | 59,049 |
| `g.V(1).repeat(out()).until(loops().is(12)).count()` | 247.3 ms | 531,441 |
| `g.V(1).repeat(out()).until(loops().is(13)).count()` | 710.0 ms | 1,594,323 |
| `g.V(1).repeat(out()).until(has('i',-1)).limit(3)` | killed at 600 s | no answer |
| `g.V(1).repeat(out()).emit().limit(5)` | 5.2 ms | 5 rows |

The bounded regime answers 531,441 traversers in 9.3 ms. The unbounded regime takes about 3× longer per
extra loop, which is the out-degree. A walk whose `until` never holds runs until an outside process kills
it. A `limit()` after an `emit()` walk stops the recursion early, because SQLite stops a streaming
recursive CTE when the outer `LIMIT` is met.

### 3.2 Client `timeoutMillis` — missing

The TinkerPop 4 JavaScript client sends a `timeoutMillis` field in the request fields map
(`vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/structure/io/binary/internals/GraphBinaryWriter.js:55-58`,
`vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/driver/request-message.ts:28`). `parseRequest` reads
only `bindings`/`parameters`, `batchSize`, `g` and `bulkResults` (`src/wire.ts:148-171`). The field is
silently ignored. A client that sets a timeout gets no server-side enforcement.

### 3.3 Cancellation on client disconnect — missing

- `runQuery` reads the whole body, then awaits the full result, then builds the response
  (`src/router.ts:98-119`). It never reads `req.signal`.
- The response stream has no `cancel` handler. A disconnect only stops further pulls
  (`src/http.ts:59-61`, `src/http.ts:81-98`). By then the query has already run to completion.
- On Cloudflare the Worker calls the DO over RPC (`src/cloudflare/cloudflare-graph-manager.ts:29-58`). The
  RPC carries no signal. The DO runs the plan synchronously (`src/cloudflare/graph-store-do.ts:114-119`).
- The segment loop (`driveSegmentsFrom`, `src/drive.ts:352-377`) has `await` points between barrier
  segments. It does not check a signal at them.

### 3.4 Interrupting a running statement — missing

- `BunSqlite.query` calls `.all()` (`src/bun/BunSqlite.ts:39-42`). `DurableObjectSqlite.query` calls
  `.toArray()` (`src/cloudflare/DurableObjectSqlite.ts:14-16`). Both run one statement to completion in
  one synchronous call.
- Neither API exposes `sqlite3_interrupt` or a progress handler (`node_modules/bun-types/sqlite.d.ts`;
  `SqlStorage` in `node_modules/@cloudflare/workers-types/index.d.ts`). Inferred from the type
  declarations.
- Both APIs expose a row iterator (`Statement.iterate`, `SqlStorageCursor.next`). The code does not use
  them.

**Measured on Bun** (scratch probe: pull rows with `iterate()`, check a 2,000 ms deadline every 1,024 rows):

| Query | Rows before stop | Time | Stopped by deadline |
|---|---|---|---|
| `g.V(1).repeat(out()).emit()` | 670,720 | 2,003 ms | yes |
| `g.V(1).repeat(out()).until(has('i',-1))` | 0 | killed at 30 s | no |
| `g.V(1).repeat(out()).emit().count()` | 0 | killed at 30 s | no |

A row-pull deadline stops a query that streams rows. It cannot stop a query that produces no row until
the end, such as an aggregate or a walk whose filter never passes. Those need a statement interrupt, a
thread that can be killed, or the platform CPU limit.

**Browser.** `destroyGraphWorker` terminates a graph Worker that does not answer `close()` within
`CLOSE_TIMEOUT_MS = 2_000` (`src/browser/worker-spawn.ts:72-77`). This is the only interruption in the
code. It runs at graph destroy, not per query.

### 3.5 Result-size and memory budgets — missing

- The executor drains every row into a JavaScript array, then frames every row into a `Buffer`
  (`resolveNodes` and `frameResolved`, `src/execute.ts:497-511`).
- The JSON path builds one string for the whole result and expands every `bulk` (`resolveJson`,
  `src/execute.ts:523-530`).
- On Cloudflare the full `Framed[]` crosses the DO RPC as one value
  (`src/cloudflare/graph-store-do.ts:91-93`).

**Measured on Bun** (JSON path, same graph):

| Query | Values | Time | RSS growth |
|---|---|---|---|
| `g.V(1).repeat(out()).until(loops().is(11)).values('i')` | 177,147 | 176.5 ms | +42 MB |
| `g.V(1).repeat(out()).until(loops().is(12)).values('i')` | 531,441 | 460.9 ms | +106 MB |

A DO isolate has about 128 MB (root `CLAUDE.md`, `src/iostore.ts:8-12`). So a result of this size can
exhaust a DO's memory (inferred; not measured on a DO). `docs/outstanding-work.md` `cc5-order-phase-cost`
records a compile that reaches 367 MB of heap before the compile budget declines it.

`changesFeed` without a `limit` returns the whole feed in one array (`src/manager.ts:39-97`). The
replicator always pages it (`src/scheduler.ts:207-210`), but a direct `_changes` call can omit `limit`.

### 3.6 Streaming and backpressure — partial

`streamBuffers` sends `batchSize` values per HTTP chunk (default 64, `src/wire.ts:21`). It pulls the next
batch only when the consumer pulls (`src/http.ts:62-99`). So the response honours backpressure.

This is pacing, not streaming execution. The whole result exists in memory before the first byte is sent
(`src/execute.ts:25-29` states this). A flat (non-bulked) response expands a `bulk` lazily, so a
collapsed row of bulk N does not allocate N buffers (`src/http.ts:72-79`).

### 3.7 Writes on failure — exists

A write program runs inside one atomic unit (`runSteps`, `src/program.ts:75-83`). On Cloudflare the unit
is `ctx.storage.transactionSync` (`src/cloudflare/graph-store-do.ts:56`,
`src/cloudflare/DurableObjectSqlite.ts:18-20`). On Bun it is `db.transaction`
(`src/bun/BunSqlite.ts:49-51`). A throw inside the unit rolls back every write. Sibling report 03 lists the
tests and the crash cases.

Consequence for budgets: a future budget that throws inside `runSteps` rolls the write back. If the DO
isolate is killed by the platform during a write, the open transaction is not committed (inferred; sibling
report 03 §1.10).

### 3.8 Request body size — partial

`runQuery` reads the body with `req.arrayBuffer()` and no size check (`src/router.ts:100`). Bun's
`Bun.serve` default `maxRequestBodySize` is 128 MB (`node_modules/bun-types/serve.d.ts:676-678`);
`startServer` does not override it (`src/bun/server.ts:70`). Cloudflare applies its own plan limit
(inferred). The compile budget bounds compile work for any query text (§4.2).

### 3.9 Outbound HTTP timeout — missing

`defaultHttp` is a bare `fetch(request)` (`src/http-federation.ts:48`). The allowlist limits which hosts
are reached, not how long a call takes. A slow remote `federate` or `io()` target holds the request open.
On a DO the wait is not CPU time, so the CPU limit does not end it (inferred).

### 3.10 Isolation between graphs — partial

- **Cloudflare.** One DO per graph (`src/cloudflare/cloudflare-graph-manager.ts:108-110`). A runaway
  query blocks only its own graph. Compile runs on the Worker, so a costly compile uses Worker CPU
  (`src/cloudflare/cloudflare-graph-manager.ts:33`).
- **Bun.** One process, one JavaScript thread, one synchronous `bun:sqlite` call per query
  (`src/bun/server.ts:70`, `src/bun/BunSqlite.ts:39-42`). A runaway query on one graph blocks every graph
  on the server (inferred; sibling report 03 §1.9 says the same).
- **Browser.** One dedicated Worker per graph (`src/browser/worker-spawn.ts`). A runaway query blocks only
  that graph's Worker.

---

## 4. Controls that exist (Reference)

### 4.1 Durable Object statement limits

| Limit | Value | Where defined | How it is enforced |
|---|---|---|---|
| Bound parameters per statement | 100 | `src/do-limits.ts:13` | Platform; `CfLimitedSql` on Bun (`src/cf-limits.ts:148-168`); `mise run binds` statically |
| Statement text | 100 KB | `src/do-limits.ts:16` | Platform; `CfLimitedSql`; clean decline at `GraphStore.query` (`src/storage.ts:396-400`) |
| One value | 2 MiB | `src/do-limits.ts:23` | Platform; data-sized sets split under it (`src/json-chunks.ts`); named error at `src/storage.ts:383-394` |
| SQLite statement shape (64-table join, expression depth, …) | SQLite's own | `STATEMENT_SHAPE_LIMIT`, `src/storage.ts:26-27` | Clean decline at prepare time |

All four are properties of the statement text, not of the data. Tests: `test/cf-limits.test.ts`;
`mise run test:cf-limits` runs the L3 corpus under `CfLimitedSql`.

### 4.2 Compile-work budget

`COMPILE_BUDGET_BYTES = 400_000` per statement (`src/sql/kernel/budget.ts:23`). `CompileBudget.charge`
throws `CompileBudgetExceeded` past it (`src/sql/kernel/budget.ts:76-79`). It depends only on the query
text and schema. Test: `test/compiler/compile-budget.test.ts`.

### 4.3 JavaScript stack depth

A `RangeError` for call-stack depth during compile becomes a clean `UnsupportedTraversal`
(`tooDeep`, `src/compiler/compiler.ts:108-111`). The depth at which it fires depends on the runtime
(`docs/outstanding-work.md` `spine-cut-hosts`).

### 4.4 Federation depth

`MAX_FEDERATION_DEPTH = 4` (`src/services/params/federation-depth.ts:23`). A deeper or cyclic hop throws
`UnsupportedTraversal` (`src/services/params/federation-depth.ts:29-30`). Tests: `test/federation.test.ts`.

### 4.5 `repeat()` termination aids

- An unbounded walk with neither `until` nor `emit` is replaced with an empty relation, because it can
  produce nothing (`src/compiler/rel/walk.ts:395-410`). This changes no answer.
- Bounded `repeat` inside a child traversal works up to `times(63)` (`docs/limitations.md` §2).
- Long walks reach SQLite expression-depth or FROM-list limits and decline on query text
  (`docs/outstanding-work.md` `long-walk-sqlite-limits`).

### 4.6 `io()` memory bound

`io()` streams in both directions (`src/iostore.ts:8-20`). A drain reads keyset pages of 500
(`src/formats/drain.ts:49-58`). A load flushes every batch through `BatchingLoader` (`src/bulk.ts:656`).
The R2 sink uploads parts of 8 MiB (`PART_SIZE`, `src/cloudflare/R2IoStore.ts:55`). Peak memory is one
page or one part (`docs/feature-support-matrix.md` §14).

### 4.7 Replication pacing

`runDueReplications` takes operator knobs: `leaseMs`, `maxJobs`, `batchSize`, `maxBatchesPerWake`,
backoff (`src/scheduler.ts:199-216`). `maxBatchesPerWake` bounds how long one job occupies a DO. This is
the one subsystem that already uses operator budgets.

---

## 5. Operator settings that exist today (Reference)

| Setting | Bun | Cloudflare | Effect on resources |
|---|---|---|---|
| `--port` / `MOGWAI_PORT` | yes | n/a | none |
| `--data-dir` / `MOGWAI_DB_DIR` | yes | n/a | none |
| `--io-dir` / `MOGWAI_IO_DIR` | yes | R2 binding `IO` | enables `io()` |
| `--allow-host` / `MOGWAI_HTTP_ALLOWLIST` / `HTTP_ALLOWLIST` / `CONFIG.httpAllowlist` | yes | yes | which hosts outbound calls reach |
| `MOGWAI_LOG` / `CONFIG.log` | yes | yes | access log; logs no duration |
| `MOGWAI_SCHEDULER_INTERVAL_MS` | yes | Cron Trigger | replication tick rate |

Source: `src/config.ts:16-89`, `src/bun/server.ts:83-129`, `wrangler.jsonc`. No setting controls time,
memory or result size of a query.

**Platform settings not used by this repo.** Cloudflare documents a `limits.cpu_ms` setting for Workers
and Durable Objects. `wrangler.jsonc` does not set it. No test in this repo verifies its effect on a DO or
on a write in progress. Treat it as unverified until plan item `rb0-do-cpu` measures it.

---

## 6. How to limit risk with what exists today (How-to)

### 6.1 Write a walk that terminates (query author)

1. Prefer `times(n)` when the depth is known. It merges equal traversers (§2.3).
2. Add `simplePath()` to a walk over a graph that can have cycles.
3. Put `limit(k)` after an `emit()` walk when you need only k results. SQLite stops early (§3.1).
4. Do not rely on `until(…)` alone on a cyclic graph. If the condition never holds, the walk never ends.

### 6.2 Reproduce the walk measurements (developer)

1. Seed a cyclic graph with an out-degree of 3, for example 30 vertices with edges to the next three.
2. Run `g.V(1).repeat(out()).until(loops().is(k)).count()` for k = 10, 12, 13.
3. Run `g.V(1).repeat(out()).times(k).count()` for the same k.
4. Compare the times. Expect about 3× per loop for `until`, and near-constant time for `times`.

### 6.3 Check that statements fit Durable Object limits (developer)

1. Run `mise run test:cf-limits`.
2. Read `.logs/test:cf-limits.log` if the run fails.

### 6.4 Contain a Bun deployment (operator)

1. Run one Bun process per tenant or per trust domain. A runaway query then blocks only that process.
2. Put a process supervisor in front that restarts a process that stops answering health checks.
3. Do not expose a Bun server to untrusted query text. No time budget protects it.

---

## 7. Verdict on audit item 5

| Question | Answer |
|---|---|
| Timeouts enforced? | No, on any runtime. Cloudflare's CPU limit is the only stop, and only on Cloudflare. |
| Cancellation enforced? | No. A disconnect does not stop work. The client's `timeoutMillis` is ignored. |
| Recursion limits enforced? | Compile-time limits: yes (§4.2–4.4). Run-time `repeat()` depth: no, by design; a budget is the intended backstop, and it does not exist outside Cloudflare. |
| Memory limits enforced? | `io()`: yes. Query results: no. The whole result is in memory before the first byte. |
| Reliable across runtimes? | No. The three runtimes behave differently (§1, rows 1, 4, 18). |

The reviewer's adversarial case is real for the unbounded `repeat()` regime (measured, §3.1). The
algorithmic fix is `walk-state-collapse` (`docs/outstanding-work.md` §2). Operator budgets are the
backstop for what remains; see the plan.

---

## Glossary

| Term | Meaning |
|---|---|
| Budget | An operator-set limit on a request's time or resources. It fails the request with a named error and never changes an answer. |
| Cap | A product-set limit keyed to a count in the data. It changes or refuses an answer. The project forbids it. |
| Bounded regime | `repeat(…).times(n)`, compiled as an unroll that merges equal traversers. |
| Unbounded regime | `repeat` with `until`/`emit` and no `times`, compiled as a recursive CTE. |
| Bulk | The number of identical traversers that one row stands for. |
| DO | A Cloudflare Durable Object. One DO holds one graph. |
| Row-pull deadline | A time check made between rows while reading a statement's result. |
| Statement interrupt | Stopping one SQLite statement while it runs (`sqlite3_interrupt` or a progress handler). |
| Segment loop | The async loop that runs a plan across barrier services (`src/drive.ts`). |
