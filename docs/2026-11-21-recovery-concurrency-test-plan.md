# Recovery and concurrency — test plan

**Status: PROPOSED (2026-11-21). Not started.** Evidence and gap list (G1-G14):
`docs/reports/2026-11-21-production-readiness/03-recovery-transactions-and-concurrency.md` (called
"report 03" below). Related index items: `docs/outstanding-work.md` `operations` (`:1595-1599`),
`failover-double-write` (`:263-269`), `io-residue` (`:1588-1593`), `index-build-on-deploy` (`:1821-1825`).

## 1. Goal

Turn every recovery, atomicity and concurrency claim in report 03 into a test that fails when the claim
breaks. Fix the code only where a test shows a real wrong answer (G1, G2, G9, and the decisions in §6).

The reviewer's main question is: "Can multi-statement writes fail partway through without leaving partial
graph mutations?" The answer today is no for one request (report 03 §1.2, §2.1). This plan makes that answer
**systematic** (every write shape, every failure point) and extends it to crashes, a real DO and parallel
requests.

## 2. Current state (with citations)

| Fact | Source |
|---|---|
| A write program runs in one atomic unit. | `src/program.ts:75-83` |
| Bun, DO and browser atomic primitives. | `src/bun/BunSqlite.ts:48-51`; `src/cloudflare/DurableObjectSqlite.ts:18-20`; `src/browser/WasmSqlite.ts:44` |
| Five committed tests fail when the unit is removed. | report 03 §2.1 |
| The GraphBinary path refreshes after the unit; the JSON path inside it. | `src/execute.ts:497-511,523-529` |
| A streaming load uses an undo journal and a construction-time sweep. | `src/bulk.ts:646-735`; `src/storage.ts:297-302` |
| A dump is paged across awaits. | `src/formats/drain.ts:48-60,97-107` |
| The Bun io sink writes the target file in place and deletes it on abort. | `src/bun/FileIoStore.ts:49-60` |
| A decorator over `Sql` already exists as a pattern (DO limits on Bun). | `src/cf-limits.ts` |
| Schema DDL is `IF NOT EXISTS`, with one explicit upgrade. | `src/storage.ts:339-357` |
| No test sends parallel requests; no test kills a process. | report 03 §2.3 |

## 3. Design of the test substrate

### 3.1 A fault-injecting `Sql` decorator

Add `test/support/fault-sql.ts`: a `Sql` wrapper (same shape as `src/cf-limits.ts`) that throws on the
N-th `query` or `exec` call after it is armed. It passes `atomically` through to the inner driver. It
counts statements, so a test can first run a traversal clean to learn its statement count `K`, then rerun
it with the fault at each `N` in `1..K`.

### 3.2 A whole-graph fingerprint

Add `test/support/fingerprint.ts`: one function that reads every user table (`nodes`, `edges`,
`vertex_labels`, `vertex_properties`, `edge_properties`, `property_fts`, `tombstones`, `conflicts`,
`bulk_journal`, `update_seq`) in a fixed order and returns a hash. Equal fingerprints mean the graph is
unchanged. `test/io-streaming.test.ts` already does a smaller form of this (`snapshot`).

### 3.3 Process-kill harness (Bun)

A test spawns `bun src/bun/server.ts --data-dir <tmp>` with `Bun.spawn`, sends a request, and kills the
process with `SIGKILL` at a chosen moment. A test-only env var makes the server pause at named points
(for example "after statement N", "between load batches"). It then reopens the files with `GraphStore`
and checks the fingerprint. The pause hook lives in `test/support/`, wired through the `makeSql` factory
that `BunGraphManager` already takes (`src/bun/BunGraphManager.ts:57-63`). No production code path changes.

### 3.4 Real-DO runs

Reuse the `wrangler dev` harness in `test/cloudflare.test.ts` and the shared `test/contract.ts`, so each
scenario that can run over HTTP runs on both runtimes.

## 4. Ordered work items

Each item: scenario, then acceptance criteria. "Unchanged" means the fingerprint (§3.2) equals the one
taken before the request.

### R1 — Every write shape, every failure point (G-item: reviewer item 4)

- **Scenario.** Take every write traversal in the L1 corpus and the L6 workload that executes today. Run each
  clean on a seeded store to get `K`. Then, for each `N` in `1..K`, run it with the fault at statement `N`.
- **Accept.** Every faulted run throws, and the graph is unchanged. Zero exceptions.
- **Accept.** A clean run after the faulted runs gives the same answer as the first clean run.
- **Budget.** Cap total statements per run in CI; the full sweep runs as `mise run` task outside `ci` if
  it exceeds the bracket time (decision D3).

### R2 — The refresh is part of the write (G1)

- **Code.** Wrap the program branch of `frameResolved` in `store.atomically`, as `resolveJson` already does
  (`src/execute.ts:523-529`).
- **Scenario.** Fault the first statement of `refreshElements` for a write sent with the GraphBinary
  `Accept` header, and again with JSON.
- **Accept.** Both paths throw, and the graph is unchanged, including the `dirty` flags.
- **Accept.** R1's sweep counts refresh statements in `K`.

### R3 — Rollback on a real DO (G8)

- **Scenario.** On `wrangler dev`, send each of the three measured write-then-raise traversals in report 03
  §1.2 with each response type.
- **Accept.** Each returns the error on the trailer (or the JSON error), and `g.V().hasLabel('w').count()`
  is 0 afterwards.

### R4 — Kill inside a write program (G7)

- **Scenario.** Bun with `--data-dir`. Pause after statement `N` of a multi-statement write (for example a
  vertex `drop()` with cascade). Send `SIGKILL`. Reopen.
- **Accept.** The graph is unchanged. `PRAGMA integrity_check` returns `ok`.
- **Scenario.** Same, but kill after the commit and before the response is sent.
- **Accept.** The write is fully present, with `gid` and `seq` set once R2 has landed.

### R5 — Kill inside a streaming load and a dump (G7, G2)

- **Scenario.** Kill between load batches. Reopen.
- **Accept.** Unchanged (this extends `test/io-streaming.test.ts:195` to a real process kill).
- **Code (G2).** Make `FileIoStore.writeStream` write to `<path>.partial-<token>` and rename on `close`;
  delete the temp file on `abort`.
- **Scenario.** Write `backup.json`; then start a second dump to the same path and kill the process mid-way;
  separately, make the second dump fail.
- **Accept.** In both cases `backup.json` still holds the first dump byte for byte. No temp file is listed
  by `io` after a clean `abort`.

### R6 — Parallel requests to one graph (G6)

- **Scenario A.** 200 parallel `g.addV('p').property('n', i)` requests to one graph, on Bun and on
  `wrangler dev`.
- **Accept.** Exactly 200 vertices; 200 distinct `n`; every element has a distinct `seq`; `update_seq`
  equals the highest `seq`.
- **Scenario B.** 100 parallel `g.V().has('c').property('c', __.values('c').math('_+1'))` on one vertex with
  `c = 0`.
- **Accept.** Final `c` is 100 (each write is one synchronous unit; nothing is lost).
- **Scenario C.** Parallel reads during a streaming load of a 20,000-vertex document.
- **Accept.** Every read returns a count that is a multiple of the batch size or the final count (it sees
  whole batches only); after the load, the count is exact.

### R7 — Load rollback versus a concurrent writer (G4)

- **Scenario.** During a load that will fail, another request adds an edge to a loaded vertex.
- **Accept (today).** The test asserts the documented behaviour: the edge is gone and the other request
  received success. It also asserts the edge's deletion is **not** silent: decision D1 chooses between
  refusing writes that touch journaled rows, or reporting it.

### R8 — Dump under concurrent writes (G5)

- **Scenario.** Start a dump of a 20,000-vertex graph; during it, drop 100 vertices and add 100 edges.
- **Accept (minimum).** The document reloads into an empty graph with no error.
- **Accept (if D2 = snapshot).** The reloaded graph equals the graph as it was when the dump started.

### R9 — Schema upgrade (G9)

- **Code.** Add a `schema_version` row (one table, one integer) written by `initSchema`; add an ordered list
  of upgrade steps, each in one atomic unit.
- **Fixtures.** Commit small SQLite files written by earlier trunk commits (one per schema change that
  matters: before `gid`/`seq`, before signed FTS rowids, before `e_pair`).
- **Accept.** Each fixture opens, upgrades, answers the L1 read corpus subset that its data supports, and
  reports the current `schema_version`.

### R10 — Teardown during work (G12)

- **Scenario.** `DELETE /{prefix}/{g}` while a load or a `federate` traversal on `g` is in flight, on both
  runtimes.
- **Accept.** The in-flight request fails with a clear error or completes; no internal error reaches the
  client; afterwards the graph is empty and usable.

### R11 — Remote transactions fail closed (G14)

- **Scenario.** The stock client calls `g.tx().begin()`.
- **Accept.** `begin()` rejects; a following plain write still runs; nothing reports a commit.

### R12 — Replication crash between apply and checkpoint

- **Scenario.** Fault the checkpoint write after a successful apply; run the job again.
- **Accept.** The target fingerprint equals a clean single run; no conflict rows appear.

### R13 — Bun long query (G10)

- **Scenario.** One request runs an unbounded `repeat(both())` on a cyclic graph; a second request reads
  another graph.
- **Accept (after D4).** The second request answers within 1 s, or the first is stopped by the chosen limit
  with a clear error.

## 5. Risks

| Risk | Check |
|---|---|
| R1 is slow (corpus × statements). | Measure first; split into a CI subset and a full `mise run` task (D3). |
| Kill-timing tests flake. | Pause at named hooks, never by sleeping; kill only while paused. |
| R6 on `wrangler dev` measures local workerd, not production. | State it in the test header; a production run is part of `operations` (deploy). |
| R9 fixtures go stale. | Each fixture names the commit that wrote it. |

## 6. Open decisions for the owner

| # | Decision | Options |
|---|---|---|
| D1 | Load rollback versus another writer's edge (G4). | (a) keep and document in `docs/limitations.md`; (b) refuse writes that touch journaled rows while a load is open; (c) hold the whole load in one DO request with no other writer. |
| D2 | Dump consistency (G5). | (a) document "not a snapshot", rely on fail-closed reload; (b) dump only rows with `seq <= start seq` and replay tombstones; (c) refuse writes during a dump. |
| D3 | Where R1's full sweep runs. | Inside `ci` / a separate scheduled task (note: CLAUDE.md prefers no scheduled jobs for L5). |
| D4 | Bun per-query limit (G10). | (a) SQLite progress handler with a time budget; (b) worker thread per graph; (c) document "one process per graph". Option (a) needs `bun:sqlite` support for a progress handler — check before choosing. |
| D5 | Idempotency keys for writes (G11). | Add a request id that the server remembers for N minutes / leave to the client. |
| D6 | Multi-process Bun on one data dir (G13). | Support (set `busy_timeout`, drop the open-graph cache) / refuse with a lock file. |

No new dependency is needed for R1-R12.

## Glossary

- **Fingerprint:** a hash of every user table, used to prove a graph is unchanged.
- **Fault injection:** a test wrapper that makes the N-th storage call throw.
- **Statement count `K`:** the number of SQL calls one clean run of a traversal makes.
