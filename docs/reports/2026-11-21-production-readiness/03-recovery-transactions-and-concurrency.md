# 03 — Recovery, transactions and concurrency

**Reviewer concern:** this area "establishes operational confidence". Audit item 4, the reviewer's main
concern: "Can multi-statement writes fail partway through without leaving partial graph mutations?"

**Short answer to item 4:** for a single Gremlin write request, **no partial mutation is left**. A compiled
write is several SQL statements, and they run as one atomic unit on both runtimes. This was measured on
2026-11-21, and five committed tests fail when the atomic unit is removed (section 2.1). There are four
narrower gaps, listed in section 5:

1. The post-write metadata refresh (global id, revision, change sequence, full-text index) runs **after**
   the atomic unit on the GraphBinary response path (G1).
2. A traversal with an asynchronous barrier (`federate`, `io()`) is not isolated across the barrier (G3).
3. A streaming `io()` load is all-or-nothing, but other requests can see it half-done, and its rollback
   deletes edges that other requests attached to it (G4).
4. Several crash, eviction and concurrency claims rest on platform documentation or on reading code. No
   test proves them (G6-G10).

Status keys: **exists** = in code and proven by a test; **partial** = in code, proof incomplete;
**missing** = not in code. "Measured" = observed in a throwaway script on 2026-11-21 on Bun (SQLite
3.51.2). "Inferred" = read from code or from platform documentation, not run.

This report does not repeat `docs/outstanding-work.md`. Related items there: `operations` ("Transaction
and session semantics are missing", `docs/outstanding-work.md:1595-1599`), `failover-double-write`
(`:263-269`), `browser-runtime` (`:1601-1606`), `io-residue` (`:1588-1593`) and `index-build-on-deploy`
(`:1821-1825`). The test plan for the gaps is `docs/2026-11-21-recovery-concurrency-test-plan.md`.

---

## 1. The model per runtime (Explanation)

### 1.1 The unit of work is one request

One HTTP request carries one traversal. The server compiles it to SQL and runs it. There is no session and
no transaction that spans requests.

TinkerPop 4 remote transactions are not supported. The client's `tx().begin()` sends the script
`g.tx().begin()` (`vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/process/transaction.ts:70-80`).
**Measured:** mogwai answers it with `UnsupportedTraversal: … no lowering covers a traversal source with no
steps`. So `begin()` throws in the client, and no later request runs under a transaction the client
believes is open. This fails closed. The `X-Transaction-Id` header that the client sends is ignored
(`src/wire.ts:148-169` reads no such field). No test pins this behaviour.

### 1.2 A compiled write is one atomic unit

A write traversal compiles to a **program**: an ordered list of SQL statements. Later statements read the
rows that earlier statements returned. `runSteps` runs the whole list inside one atomic unit
(`src/program.ts:75-83`):

```ts
return store.atomically ? store.atomically(() => runStepsIn(store, program)) : runStepsIn(store, program);
```

`atomically` is each runtime's own primitive:

| Runtime | Primitive | Source |
|---|---|---|
| Bun (`bun:sqlite`) | `db.transaction(fn)()`; a nested call becomes a `SAVEPOINT` | `src/bun/BunSqlite.ts:48-51` |
| Cloudflare DO | `ctx.storage.transactionSync(fn)` | `src/cloudflare/graph-store-do.ts:56`, `src/cloudflare/DurableObjectSqlite.ts:18-20` |
| Browser (OO1 wasm) | `savepoint` | `src/browser/WasmSqlite.ts:44` |

A DO cannot issue `BEGIN` or `SAVEPOINT` through `sql.exec`, so `transactionSync` is its only atomic unit
(`src/cloudflare/DurableObjectSqlite.ts:3-6`). If any statement throws, or a guard step raises (for
example "id already exists", `src/program.ts:106-119`), the whole program rolls back. The code cites
TinkerPop's contract for this (`src/program.ts:76-81`).

**Measured** on Bun, through `Executor.framedAsync` and `jsonAsync`. Each traversal writes a vertex and then
raises at run time:

| Traversal | Error | Vertices left with atomic unit | Left with atomic unit removed |
|---|---|---|---|
| `g.addV('w').property('k',1).addLabel(__.values('k'))` | `RaisedByQuery` | 0 | 1 per run |
| `g.addV('w').property('k',1).V().hasLabel('w').addLabel(__.values('k'))` | `RaisedByQuery` | 0 | 1 per run |
| `g.addV('w').property('k',1).V().hasLabel('w').property('k2', __.values('k').math('_/0'))` | `Division by zero!` | 0 | 1 per run |

The control run proves that the writes really happen before the error. So the atomic unit, not an early
check, is what removes them.

### 1.3 The post-write refresh

After a write program, `refreshElements` gives every touched element its global id (`gid`), revision
(`rev`) and change sequence (`seq`), and updates the full-text index (`src/refresh.ts:145-150`). It finds the
touched rows by a `dirty` flag (`src/refresh.ts:8-14`).

The two response paths place it differently:

| Path | Who uses it | Refresh inside the atomic unit? | Source |
|---|---|---|---|
| GraphBinary (`frameResolved`) | Every GLV client; federation | **No.** `runSteps` commits, then `refreshElements` runs. | `src/execute.ts:497-511` |
| Untyped JSON (`resolveJson`) | Default for curl, browsers, docs | Yes. The whole render is wrapped in `store.atomically`. | `src/execute.ts:523-529` |

So on the GraphBinary path, if the refresh throws, the write stays committed and the client receives an
error. The rows keep `dirty` set, so the next write's refresh picks them up (inferred from
`src/refresh.ts:8-14`). Until then, those elements have no `gid` or `seq`, so they are missing from the
replication feed and from full-text search (inferred). No test injects a refresh failure. This is gap G1.

### 1.4 Asynchronous barriers split a traversal into segments

Most traversals are one SQL statement or one program. A traversal with an **asynchronous barrier**
(`federate`, `io()`) is a chain of segments: read the head rows, `await` the barrier, then run the next
segment (`src/compiler/segment.ts:1-21`, `src/drive.ts:51-62`). A synchronous transaction cannot cross an
`await`. So the segments are not one atomic or isolated unit. The code states this: an async barrier "is NOT
single-snapshot isolated across the boundary" (`src/compiler/segment.ts:40-60`).

On Cloudflare the Worker drives a `federate` traversal. The head runs on the DO in one RPC (`readHead`), and
the final plan runs in a second RPC (`runFramed`) (`src/cloudflare/cloudflare-graph-manager.ts:38-55`).
Other requests can change the graph between the two RPCs. The final segment, if it writes, is still one
atomic program (§1.2).

A **synchronous** barrier (`regex`) runs head, transform and resume with no `await`, so it stays atomic
(`src/compiler/segment.ts:46-52`). Tests: `test/split.test.ts:60` and `test/reverse.test.ts:47` ("runs on
the SYNC framed() path too (atomic sync barrier)").

### 1.5 A streaming `io()` load: all-or-nothing through an undo journal

`g.io("x.json").read()` streams a document that can be larger than memory. It awaits the byte stream
between batches, so no single transaction can hold it (`src/storage.ts:276-285`). Instead
`BatchingLoader` works like this (`src/bulk.ts:646-735`):

1. Each batch of 5,000 elements lands in its own atomic unit.
2. Each batch writes the row ids it created into the `bulk_journal` table, in the same unit.
3. The last batch clears the journal in its unit (`done`, `src/bulk.ts:699-705`).
4. On any failure, `abort` deletes every journaled row in one unit (`src/bulk.ts:709-713`).
5. `loadStreaming` always calls `abort` on a throw (`src/bulk.ts:719-735`).
6. If the process or isolate dies between batches, the next `GraphStore` construction finds the journal and
   undoes the load (`src/storage.ts:297-302`).

A GraphSON load reads the document twice: all vertices, then all edges, so an edge can name a later vertex
(root `CLAUDE.md`, "IoStore" note).

Two side effects follow, both by design and both tested:

- **No isolation.** Other requests run between batches. They can read a half-loaded graph.
- **Rollback removes other writers' edges.** If another request attaches an edge to a loaded vertex and the
  load then fails, the rollback deletes that edge too (`src/storage.ts:306-313`). Test:
  `test/io-streaming.test.ts` "an edge another writer attached to a loaded vertex goes with it". That
  other request was told its write succeeded. This is gap G4.

### 1.6 A streaming `io()` write (dump) is not a snapshot

`g.io("x.json").write()` drains the graph in keyset pages (`src/formats/drain.ts:48-60`) and awaits the sink
between pages (`pumpLinesToSink`, `src/formats/drain.ts:97-107`). So other requests can write between pages. The document is
not a point-in-time snapshot (inferred). If the graph changes during the dump, the document can hold an
edge whose endpoint vertex is missing. A later load of it then fails closed with "unknown vertex" and
leaves the graph unchanged (§1.5). No test covers a dump under concurrent writes. This is gap G5.

On failure, `drainTo` calls `sink.abort` (`src/services/catalog/io.ts:93-101`):

| Store | Write | Abort | Effect on an older document at the same path |
|---|---|---|---|
| Bun `FileIoStore` | `Bun.file(path).writer()` writes the target file directly (`src/bun/FileIoStore.ts:49-53`). | Deletes the file (`src/bun/FileIoStore.ts:58`). | **Lost.** The writer replaces the old file from the first byte, and abort deletes the partial one (inferred). |
| R2 `R2IoStore` | One `put`, or a multipart upload completed at the end (`src/cloudflare/R2IoStore.ts:63-104`). | Aborts the multipart upload (`src/cloudflare/R2IoStore.ts:99-101`). | Kept until the new object completes (inferred from R2 behaviour). |

If the process dies during a Bun dump, `abort` does not run, so a truncated file stays (inferred). This is
gap G2 for backups.

### 1.7 Replication applies a change set atomically

`applyChanges` and `applyWire` run deletes, upserts and the uid pass in one atomic unit
(`src/replicate.ts:94-99,418-425`). Re-applying the same change set changes nothing (idempotent). So a crash
between "apply" and "save checkpoint" only causes a re-apply on the next run (inferred from the two
properties; no crash test). The scheduler claims a job with a 60-second lease, so two ticks do not run one
job twice (`src/scheduler.ts:35-36,100`).

### 1.8 Durability per runtime

| Runtime | Default storage | Journal and sync | Source |
|---|---|---|---|
| Bun, no `--data-dir` | **In memory. Lost on restart.** The replicator registry is in memory too. | — | `src/bun/BunGraphManager.ts:87`, `src/bun/server.ts:44-51` |
| Bun, `--data-dir` | One SQLite file per graph | `journal_mode=wal`, `synchronous=2` (FULL) — measured | `src/bun/BunSqlite.ts:31` |
| Cloudflare DO | DO SQLite storage | Platform-managed | `src/cloudflare/graph-store-do.ts:56` |

With WAL and `synchronous=FULL`, a committed transaction survives a power loss (SQLite documentation;
inferred, not tested here). On a DO, the platform's output gate holds the response until the write is
durable (Cloudflare documentation; inferred, not tested here).

There is no backup schedule. A backup is a manual `g.io("…json").write()` (typed GraphSON, lossless,
`docs/feature-support-matrix.md` §14). Restore is `g.io("…json").read()` into an empty graph. The GraphSON
writer round trip is tested (`test/graphson.test.ts:247-337`).

### 1.9 Concurrency per runtime

**Cloudflare DO.** One DO is single-threaded. Compile runs on the Worker; the DO only runs the plan
(`src/cloudflare/graph-store-do.ts:103-119`). A plan runs synchronously, so two requests to one graph never
interleave inside a plan. Other requests can run only at an `await`: an async barrier, an R2 read or write,
or a sibling-DO RPC (§1.4-1.6). Requests to different graphs run in different DOs, in parallel. The DO's
per-request CPU limit ends a runaway query (root `CLAUDE.md`). This model is inferred from the code and the
platform documentation. No test sends parallel requests to one DO.

**Bun.** One process has one JavaScript thread. Each graph has one `bun:sqlite` connection
(`src/bun/BunGraphManager.ts:84-92`). `query` is synchronous (`src/bun/BunSqlite.ts:39-42`). So, as on a
DO, requests interleave only at an `await`. A long query blocks **every** graph in the process, because
there is no per-query timeout (inferred). Two Bun processes on one `--data-dir` are not handled: no
`busy_timeout` is set and the manager caches open graphs, so a second process can get `SQLITE_BUSY`
(inferred). No test sends parallel requests.

**Retries.** A write has no idempotency key. If the client loses the response and retries, the write runs
twice (inferred). `docs/outstanding-work.md` records the same gap for the browser runtime
(`failover-double-write`, `browser-runtime`).

### 1.10 Crash, eviction and teardown

| Event | Behaviour | Evidence |
|---|---|---|
| Throw inside a write program | Rolled back. | Measured (§1.2); tests in §2.1 |
| Isolate or process dies inside a write program | The open SQLite transaction is not committed, so SQLite discards it on reopen. | Inferred (SQLite and `transactionSync` semantics). No test. |
| Process dies between `io()` load batches | Load undone at next open. | `test/io-streaming.test.ts:195` (Bun file; simulated by reopening) |
| Process dies during an OLAP barrier | Scratch rows in `barrier_state` deleted at next open. | `src/storage.ts:291-297`. No crash test; reclaim on success is tested in `test/contract.ts:150`. |
| DO evicted between requests | Nothing is in flight. The constructor re-runs schema DDL and both sweeps. | `src/cloudflare/graph-store-do.ts:52-57` |
| `DELETE /{prefix}/{g}` during an in-flight `io()` load on that graph | Not handled. The load keeps writing to a store whose tables are gone; `ensureLive` restores them only through `executor()` (`src/cloudflare/graph-store-do.ts:63-68`). | Inferred. No test. |

### 1.11 Schema upgrade

`initSchema` runs every DDL statement with `IF NOT EXISTS` on each construction (`src/storage.ts:339-342`).
So a new table or index appears on the first request after a deploy. A new index on a large graph is built
inside that first request (`docs/outstanding-work.md` `index-build-on-deploy`). There is one explicit
data migration: `upgradePropertyFts` rebuilds the old full-text table in one atomic unit
(`src/storage.ts:347-357`).

There is no schema version number and no `ALTER TABLE … ADD COLUMN` path for the element tables. So a
schema change that adds a column to `nodes` or `edges` has no upgrade mechanism (inferred). The replicator
registry has a small add-column helper (`src/replicator-registry.ts:135-140`). The `wrangler.jsonc`
`migrations` only register the DO classes. No test opens a database written by an older schema.

---

## 2. Tests and what each proves (Reference)

### 2.1 Mutation check: tests that fail when the atomic unit is removed

On 2026-11-21 these test files ran with `BunSqlite.prototype.atomically` set to `undefined` by a preload
script (no source change): `double-range`, `untyped-response`, `rel-spine`, `runtime-label`, `program`,
`setwrite`, `io-streaming`, `io`, `replicate-apply`, `bulk`. Result: 817 pass, **5 fail**. The five that
fail are the tests that prove atomicity:

| Test | Proves |
|---|---|
| `test/compiler/runtime-label.exec.test.ts:60` "the reference refusals, before anything is written" | A compiled write program that raises leaves no write. |
| `test/replicate-apply.test.ts:90` "a change set refused part-way applies none of it" | Replication apply is atomic. |
| `test/compiler/double-range.exec.test.ts:228` "a batch that fails part-way leaves the graph as it was" | A bulk batch is atomic. |
| `test/io.test.ts:190` "a read the document refuses part-way leaves the graph as it was" | An `io()` load is all-or-nothing, end to end. |
| `test/io-streaming.test.ts:206` "loadGraphsonStreaming: an edge-pass failure undoes the vertex pass" | The journal rollback across the two passes. |

So the main claim of item 4 has regression protection. The other `io-streaming` journal tests pass even
without the atomic unit, because the journal rollback, not the per-batch unit, does their work.

### 2.2 Other tests in this area

| Test | Proves | Status |
|---|---|---|
| `test/io-streaming.test.ts:129-202` (7 tests) | A streaming load fails all-or-nothing for: unknown endpoint, collision, source error, isolate death between batches; a completed load leaves no journal. | exists |
| `test/io-streaming.test.ts:176` "an edge another writer attached … goes with it" | Rollback deletes another request's edge (pins G4 as intended behaviour). | exists |
| `test/rel-spine.test.ts:1541-1561` | A `mergeE` id-collision guard raises with no edge created. | exists |
| `test/untyped-response.test.ts:314-323` | A write on the JSON path runs exactly once. | exists |
| `test/tombstones.test.ts:57` | A create-and-drop in one program records no tombstone. | exists |
| `test/replicate-apply.test.ts:53` | Re-applying a change set changes nothing. | exists |
| `test/replicate-transfer.test.ts:64` | Transferring twice leaves the target unchanged. | exists |
| `test/replicate-conflict.test.ts:28-107` (4 tests) | Divergent edits reach the same winner on both peers; losers are kept and surfaced. | exists |
| `test/replicate-referential.test.ts:48` | Delete-vs-concurrent-edit: the live edit wins. ("Concurrent" here means two peers, not two requests to one store.) | exists |
| `test/replicate-loop.test.ts:38` | A re-pull resumes from the checkpoint. | exists |
| `test/replicate-paging.test.ts:99` | A bounded run applies one page and resumes. | exists |
| `test/scheduler.test.ts:89` | The lease stops two ticks from running one job. | exists |
| `test/scheduler.test.ts:98` | A failing job backs off exponentially. | exists |
| `test/graphson.test.ts:247-337` | Backup format round trip, including types and multi-label. | exists |
| `test/split.test.ts:60`, `test/reverse.test.ts:47` | A sync barrier runs as one synchronous stretch. | exists |
| `test/cloudflare-edge.test.ts:138` | Compile on the Worker touches the store zero times. | exists |
| `test/contract.ts:150` | OLAP scratch rows are reclaimed after a successful run (Bun and wrangler dev). | exists |
| `test/cloudflare.test.ts` (via `test/contract.ts`) | The contract suite passes on a live DO under `wrangler dev`. No test in it checks rollback or concurrency. | partial |
| L6 workload (`test/L6-workload/`) | Answers to ~300 app-shaped queries. Not a recovery or concurrency test. | not applicable |

### 2.3 Claims with no test

| Claim | Basis |
|---|---|
| `g.tx().begin()` fails closed | Measured only (§1.1). |
| Write program is atomic on a real DO (`transactionSync`) | Code (`src/cloudflare/graph-store-do.ts:56`). The mutation check in §2.1 ran on Bun only. |
| Refresh failure handling on the GraphBinary path | Code reading (§1.3). |
| A crash inside a write program loses nothing committed and keeps nothing partial | SQLite semantics. |
| Parallel requests to one graph serialize correctly | Code reading (§1.9). |
| A dump under concurrent writes reloads | Not claimed by the code; unknown. |
| An older database file opens after an upgrade | Unknown. |
| `DELETE` during an in-flight load | Unknown. |
| Two Bun processes on one data directory | Unknown. |

---

## 3. Atomicity, durability and isolation at a glance (Reference)

| Operation | Atomic | Isolated from other requests | Durable after response | Proof |
|---|---|---|---|---|
| Read traversal (one SQL statement) | — | Yes (one statement) | — | SQLite semantics |
| Write traversal, JSON response | Yes, including refresh | Yes | Bun: with `--data-dir`. DO: platform. | §2.1; measured |
| Write traversal, GraphBinary response | Program yes; refresh no (G1) | Yes, inside the synchronous span | Same | §2.1; code |
| Traversal with `federate` | Per segment only (G3) | No, across the barrier | Same | code comment |
| `io()` read | All-or-nothing by journal | No (G4) | Same | §2.1, §2.2 |
| `io()` write | Bun: no (G2); R2: yes | No (G5) | Bun: file; R2: object | code |
| Replication apply | Yes | Yes | Same | §2.1 |
| Multi-request transaction (`tx()`) | Not supported; begin fails closed | — | — | measured |

---

## 4. Gaps (Reference)

| ID | Gap | Severity | Status | Fix type |
|---|---|---|---|---|
| G1 | On the GraphBinary path, `refreshElements` runs after the write commits (`src/execute.ts:497-511`). A refresh failure reports an error for a committed write, and leaves elements without `gid`/`seq` until the next write. | medium | partial | code + test |
| G2 | A Bun `io().write()` to an existing path destroys the old document before the new one completes; a crash leaves a truncated file. | high for backups | missing | code + test |
| G3 | A traversal with an async barrier is not isolated across the barrier. | low (documented) | exists as stated | document in `docs/limitations.md` |
| G4 | A streaming load is visible half-done, and its rollback deletes other requests' edges to loaded vertices. | medium | exists as designed | decision + document |
| G5 | A dump is not a snapshot; under concurrent writes it can produce a document that does not reload. | medium | missing | decision + test |
| G6 | No test sends parallel requests to one graph, on Bun or on a DO. | medium | missing | test |
| G7 | No crash test (process kill) inside a write program or a dump. | medium | missing | test |
| G8 | No test runs the rollback checks on a real DO. | medium | missing | test |
| G9 | No schema version and no test that opens an older database file. | medium | missing | code + test |
| G10 | No per-query timeout on Bun; one long query blocks every graph in the process. | high for Bun in production | missing | decision + code |
| G11 | No idempotency key; a retried write applies twice. | medium | missing | decision |
| G12 | `DELETE` of a graph during an in-flight load or barrier is not handled. | low | missing | test, then code |
| G13 | Two Bun processes on one data directory are not handled. | low | missing | decision |
| G14 | The `tx()` fail-closed behaviour has no test. | low | missing | test |

The test scenarios, with acceptance criteria, are in `docs/2026-11-21-recovery-concurrency-test-plan.md`.

---

## Glossary

- **Atomic unit:** a group of writes that is kept in full or undone in full.
- **Async barrier:** a step whose result comes from outside SQLite and arrives after an `await`, for example `federate` or `io()`.
- **Durable Object (DO):** a Cloudflare single-threaded object with its own SQLite storage. One DO holds one graph.
- **Input gate / output gate:** Cloudflare DO mechanisms. The input gate stops new events while storage work is pending; the output gate holds outgoing messages until writes are durable.
- **Journal (`bulk_journal`):** a table that records the rows a streaming load created, so the load can be undone.
- **Keyset page:** a page read with `WHERE id > last_id ORDER BY id LIMIT n`.
- **Program:** the compiled form of a write traversal: ordered SQL statements whose later steps read earlier steps' returned rows.
- **Refresh:** the post-write pass that sets `gid`, `rev`, `seq` and the full-text index for touched elements.
- **Segment:** one SQL part of a traversal that an async barrier splits.
- **WAL:** SQLite write-ahead-log journal mode.
