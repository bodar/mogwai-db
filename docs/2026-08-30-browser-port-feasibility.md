# mogwai-db in the browser — locked design + proof

**Status:** design **locked** and **empirically proven** in a real browser (2026-08-31). Build in
progress against this plan.

## Landed

- **`WasmSqlite` (the `Sql` leaf)** — `src/browser/WasmSqlite.ts`, the synchronous `Sql` seam over
  `@sqlite.org/sqlite-wasm`'s OO1 API, VFS-agnostic (`:memory:` for dev/tests, `opfs-sahpool` for a
  browser Worker). Proven DEEP without a browser: because the OO1 API is synchronous and runs a real
  WASM SQLite (3.53.0, FTS5 + JSON) in-process, the whole conformance contract runs under `bun test`
  against it — `test/browser-wasm.test.ts` (all 38 contract assertions: data plane, management, io
  formats, federation, and the `barrier_state` OLAP SQL). Only the VFS differs in a real browser.
- **`BunGraphManager` is now storage-agnostic** — a `makeSql` factory seam (default `bun:sqlite`,
  unchanged) lets the SAME battle-tested manager back the WASM leaf; the browser graph-Worker reuses it.
- **`OpfsIoStore` (the `IoStore` leaf)** — `src/browser/OpfsIoStore.ts`, streaming read/write over OPFS
  (`file.stream()` / `createWritable()`), fail-closed absence, prefix listing, truncating rewrite,
  abort-leaves-nothing. The browser twin of `FileIoStore`/`R2IoStore`, reached from inside a graph's
  dedicated Worker; keys resolve under a shared base dir (per-deployment io namespace).
- **The Playwright browser lane** — `test-browser/` (outside `bun test`'s `test/` root). Playwright as a
  DRIVER LIBRARY (`chromium.launch`) drives GitHub's / this machine's **system Chrome** (no browser
  download), bundling a dedicated worker with `Bun.build`, serving it over `localhost`, asserting on what
  the worker posts back. `test-browser/support/harness.ts` (`runBrowserWorker`) is the reusable driver
  every later browser leaf reuses; `test-browser/browser.test.ts` runs the OpfsIoStore contract against
  REAL OPFS. Its own CI job (`browser`), separate from the Bun-only aggregate; `mise run test:browser`
  locally. `tsconfig` gained DOM libs (measured 0-conflict) so the browser leaves type-check in the main gate.
- **`GraphWorkerHost` (the store tier)** — `src/browser/GraphWorkerHost.ts`, what runs inside a graph's
  dedicated Worker: a `GraphStore` over its own opfs-sahpool WASM SQLite database + the `Executor`
  (self-federation; cross-worker federation fail-closed, routed by the coordinator). PROVEN: the WHOLE
  core (compiler → executor → GraphBinary wire, encode AND decode) runs in a real Chrome Worker over the
  production opfs-sahpool VFS — `test-browser/graph-worker.test.ts` runs the gremlin data plane and
  decodes with the vendored client's own reader. Only the postMessage TRANSPORT fronting it is deferred
  to the coordinator increment (its RPC protocol is designed there).
- **Browser-bundle infra** (needed by every browser worker running the core, all measured from the real
  bundle): `node-util-shim.ts` (the one `node:util` export — `isDeepStrictEqual` — the client needs and
  Bun's browser polyfill lacks), `bundle.ts` (shared `Bun.build` config so the test lane and production
  build share shims), `buffer-global.ts` (installs `Buffer` as a global, imported first so it beats
  `http.ts`/`io.ts` module-init).
- **Graph-worker postMessage transport** — `graph-worker.entry.ts` (the dedicated-Worker entry the
  coordinator spawns), `GraphWorkerClient.ts` (page-side promise-RPC, reused by the coordinator),
  `graph-worker-protocol.ts`. Proven in-browser (`graph-worker-rpc.test.ts`): a nested Worker is spawned,
  `Framed[]` crosses the structured-clone boundary and decodes, and a failing query rejects as a value
  (no hang). The failure-as-value helpers moved `src/cloudflare/rpc.ts` → `src/rpc.ts` (runtime-neutral;
  same contract serves the DO RPC and the browser Worker postMessage boundaries).
- **Deps added:** `@sqlite.org/sqlite-wasm` (runtime, browser-leaf only — per-target bundling keeps it
  out of the Bun/CF bundles; nothing on those paths imports `src/browser/*`), `playwright` (dev driver).

- **Service Worker edge + page edge (single-tab)** — `service-worker.entry.ts` (intercepts
  `/gremlin|/graphql` fetches, brokers them to a controlled page over a per-request MessageChannel),
  `page-edge.ts` (`installMogwaiPageEdge` runs the local router; `registerServiceWorker` resolves once the
  SW controls the page). Proven (`sw-edge.test.ts`): a plain fetch AND the **unmodified TinkerPop GLV**
  reach the local opfs-sahpool graph with no monkey-patching.

## Coordination-layer decision (2026-08-31) — SINGLE-TAB E2E COMPLETE

Verified: a **Service Worker cannot spawn dedicated Workers** (`Worker`/`SharedWorker` are `undefined` in
`ServiceWorkerGlobalScope`; `navigator.locks` IS available there). So Worker-spawning lives in a PAGE and
the SW brokers `fetch`→page-hosted-Worker. Chosen approach (Dan, 2026-08-31): **single-tab end-to-end
first** — now DONE and proven in a real browser. The full stack runs:

```
unmodified gremlin GLV / plain fetch  ->  globalThis.fetch  ->  Service Worker intercept
  ->  page edge  ->  makeRouter  ->  BrowserCoordinator  ->  per-graph dedicated Worker
  ->  WasmSqlite on opfs-sahpool  ->  GraphBinary response back through the SW
```

**The one remaining increment: cross-tab leader election + failover** (share one graph across tabs; a
hard-killed leader releases its Web Lock and pool and another tab takes over). This is the doc's flagged
measure-in-a-real-browser unknown, and it still carries an unresolved design decision — the SharedService
strategy (depend on wa-sqlite's / vendor rhashimoto's Apache-2.0 port / clean-room reimplement). It should
be its own focused session with a design pass.

## Verdict

Feasible, de-risked end to end. The architecture that made this a Durable Object database is the one
the browser wants: a **synchronous SQLite seam behind an asynchronous, structured-clone boundary**.
The port is **three new platform leaves under interfaces that already exist** (Bun and Cloudflare are
the other two implementations) — not a rewrite of the core. Every decision below is locked, and the
load-bearing browser facts aren't just documented — they *run*.

## Proven live (Playwright-driven Chrome, exercising the real APIs)

Verified by driving a headless Chrome with Playwright (as a library, under `bun test` — no MCP, no new
test runner) against pages served over `http://localhost`:

| Check | Result |
|---|---|
| Real `@sqlite.org/sqlite-wasm` on **`opfs-sahpool`**, in a **dedicated Worker**, running our **actual 16-statement `storage.ts` schema** | ✅ all ran |
| — FTS5 **trigram** `property_fts` table + index-served substring `LIKE` | ✅ `hasFTS5:true` (from `pragma_compile_options`), match works |
| — **JSONB** round-trip (`json(jsonb(...))`) | ✅ |
| — **`WITHOUT ROWID`** `barrier_state` table | ✅ |
| SQLite version in the WASM build | **3.53.0** — same as the Bun dev runtime (the DO is 3.47) |
| **Synchronous** `SyncAccessHandle` write→read in a dedicated Worker | ✅ `writeIsSync:true` — the primitive that makes SQLite sync with **no JSPI** |
| **Service Worker** registration over plain `http://localhost` | ✅ (localhost is a secure context) |
| **Web Locks** acquire (`navigator.locks`) | ✅ — leader election viable |
| **OPFS** async read/write round-trip (`createWritable`/`getFile`) | ✅ — the `io()` streaming substrate |

**No COOP/COEP** (opfs-sahpool needs none), **no JSPI**, **no `SharedArrayBuffer`**. The stock
`@sqlite.org/sqlite-wasm` (standard build, **not** `SQLITE_WASM_BARE_BONES`) ships FTS5+JSON, so no
custom build is needed.

## Architecture — the DO model, rendered in the browser

**One dedicated Worker per graph = one DO.** Each graph lives in its own dedicated Worker, over its
own `opfs-sahpool` pool in its own OPFS `directory` (verified: per-graph pools don't collide). This is
`idFromName(graphId) → distinct DO` exactly. Concurrency comes from **many graphs on many Workers**
(different threads), never within one graph — the same place Cloudflare gets it. `createSyncAccessHandle`
is spec-restricted to a *dedicated* Worker, so the DB cannot live in a SharedWorker.

**Web Locks + `SharedService` synthesize the DO's one-instance guarantee.** One Web Lock per graph id;
the tab holding it hosts that graph's Worker, and on close/crash the lock releases and another tab takes
over and re-opens the pool (automatic failover). Cross-tab routing to the current host is rhashimoto's
`SharedService` pattern (~200 lines, Apache-2.0, **ported** — we do not depend on wa-sqlite). A
`SharedWorker`, if used at all, is only a `MessagePort` broker — never the store.

**Multiple graphs never require multiple tabs.** One tab hosts one Worker per graph it opens, running
many graphs concurrently. Extra *tabs* matter only for sharing one graph across tabs (leadership +
failover). The common single-page case is one tab owning all its graphs' Workers.

**The Service Worker is the HTTP edge — and the whole point.** It intercepts `fetch('/gremlin/*')` and
forwards to the graph's leader Worker; since `makeRouter` is already `Request → Response`
(`src/router.ts:89`), it's near pass-through. So **any client that speaks `fetch` just works,
unmodified** — no monkey-patching. One Service Worker does double duty: the `fetch` intercept *and* the
`SharedService` port broker. The CF *structural* edge/store split maps directly (SW = edge running
`makeRouter` + the coordinator; per-graph Worker = store running the executor); only the edge-*compilation*
optimization (`runFramed`) is dropped — each Worker just compiles + runs its own queries.

**Federation** (`federate`) is cross-Worker routing through the coordinator — the browser twin of
Cloudflare's cross-DO `runForeign` RPC (`graph-store-do.ts`), which already exists and is already
structured-clone-hardened.

## The synchronous seam behind the async boundary

The whole design rests on this alignment, and it now runs: SQLite is **sync** inside the Worker
(`opfs-sahpool` `SyncAccessHandle`); everything the browser makes async sits *above* the Worker, at
seams that are *already* async in the core.

| Layer | Shape | Browser |
|---|---|---|
| `Sql.exec`/`query` (`src/storage.ts:154`) | **sync** | `opfs-sahpool` in a dedicated Worker — sync ✅ proven |
| compile (`compilePlan`) | **sync**, pure | pure JS/WASM ✅ |
| `executor(id).framedAsync` | **async** | `postMessage`/`SharedService` boundary ✅ |
| `IoStore.readStream`/`writeStream` (`src/iostore.ts:42`) | **async**, streaming | async OPFS `stream()`/`createWritable()` ✅ proven |
| RPC payloads (`Framed[]`, `Executable`) | **structured-clone-safe** (already, for the DO) | `postMessage` structured clone — same algorithm; transfer `Framed[]` buffers zero-copy |

The data plane is already clone-safe because the DO RPC boundary already structured-clones it
(`Program` ships rendered, `Compiled`/`Executable` are plain data — `src/cloudflare/rpc.ts`). The one
test that green main-thread runs won't catch — a payload that fails to cross the Worker boundary — is
the browser twin of `test/cloudflare.test.ts`; reuse `rpcTry`/`rpcUnwrap` verbatim.

## The three seams (new leaves under unchanged interfaces)

| Interface | Bun | Cloudflare | **Browser (new)** |
|---|---|---|---|
| `Sql` (sync) | `BunSqlite` | `DurableObjectSqlite` | `WasmSqlite` — official `@sqlite.org/sqlite-wasm`, `opfs-sahpool` |
| `IoStore` (async, streaming) | `FileIoStore` | `R2IoStore` | `OpfsIoStore` — `file.stream()` / `createWritable()` (the `IoSink` contract) |
| `GraphManager` (lifecycle + executor factory) | `BunGraphManager` (`Map`) | `CloudflareGraphManager` (id→DO) | coordinator: id → per-graph leader Worker over `SharedService` (mirrors the CF one) |
| entry point | `bun/server.ts` | `cloudflare/worker.ts` | a **Service Worker** (`makeRouter` + coordinator + `fetch` + broker) fronting **one Worker per graph** |
| `Buffer` | Bun global | workerd `nodejs_compat` global | ambient global; the SW entry supplies it: `import { Buffer } from 'buffer'; globalThis.Buffer = Buffer` (Bun's bundler auto-polyfills the import) |

Everything above these leaves — `GraphStore`, the whole compiler, `execute.ts`, wire, `makeRouter` — is
unchanged. The bind-coercion seam (`coerceBindValue`, `storage.ts:161`) already normalizes types across
runtimes; real SQLite in the browser is *more* permissive than the DO, so it's covered. `Buffer` is used
as a bare ambient global in the four wire files (verified: Bun + real workerd both green without imports).

## Locked decisions

1. **Official `@sqlite.org/sqlite-wasm`, standard build** (FTS5 + JSONB), VFS **`opfs-sahpool`**.
2. **One dedicated Worker per graph**; **Web Locks** leader election; **`SharedService`** pattern ported for coordination (not a wa-sqlite dependency).
3. **Service Worker** as the HTTP edge — unconditional; unmodified `fetch` clients work.
4. **`Buffer`** stays an ambient platform global in the core; only the browser entry provides it.
5. **No COOP/COEP, no JSPI, no second test runner.**

## Kept as a fallback (only): multi-connection

If per-graph leader failover ever proves flaky in practice, the fallback is a multi-connection VFS —
but it is *not* a free upgrade and stays a fallback: it costs either COOP/COEP (the official `opfs`
VFS needs `SharedArrayBuffer`) or a library swap to wa-sqlite's `OPFSCoopSyncVFS` (no COOP/COEP, but
**high write-transaction overhead**), and buys little since even multi-connection VFSes serialize
("no such thing as N concurrent readers"). Not the default.

## Remaining unknowns (browser-only, learn-by-building)

Everything paper- and API-verifiable is done. What's left can only be measured in a real browser:

1. **Crash-failover handoff.** A cleanly-closed leader releases its Web Lock and pool; confirm a
   *hard-killed* tab releases its `opfs-sahpool` handles promptly enough for the next tab to take over
   with no corruption, and that an in-flight write is dedup-safe (rhashimoto's tx-dedup pattern).
2. **Storage durability.** OPFS is persistent but evictable under pressure unless
   `navigator.storage.persist()` is requested; surface quota (the 10 GB DO-ceiling analog).
3. **Schema recovery on Worker (re)start.** `GraphStore`'s ctor already runs idempotent DDL and sweeps
   orphaned barrier runs (`storage.ts:137,150`) — *more* relevant here, since a tab can die
   mid-request; confirm it fires on Worker start.

## Testing (locked; proven)

- **`bun test` stays the single runner.** A test `Bun.serve`s the built bundle on `http://localhost`
  and drives real Chrome with **Playwright as a driver library** (`chromium.launch()`, not
  `@playwright/test`) — mirroring `test/cloudflare.test.ts`'s spawn-and-drive. Proven to work here.
- **localhost is a secure context**, so SW + OPFS + Web Locks work over plain HTTP — no certs.
- **Contract reuse:** the same `graphContract` that drives Bun and Cloudflare drives the browser over
  `fetch` (the SW intercept means no browser-specific variant) — itself the proof of the unmodified-client thesis.
- **New CI lane** (Playwright-capable, headless Chromium) — separate from the current Bun-only `mise run ci`.
- **Deps (approved):** `@sqlite.org/sqlite-wasm` (runtime, browser-leaf only — kept out of the Bun/CF
  bundles by per-target bundling), `playwright` (dev driver). `SharedService` is ported code, not a dep.

## Build plan

New leaf `src/browser/`, plus a Service Worker entry and a Playwright test lane:

- ✅ `WasmSqlite.ts` — `Sql` over `@sqlite.org/sqlite-wasm` / `opfs-sahpool` (LANDED; full conformance
  contract green in-process via `test/browser-wasm.test.ts`).
- ✅ `OpfsIoStore.ts` — `IoStore` over async OPFS streaming (LANDED; proven against real OPFS via the
  Playwright lane, `test-browser/browser.test.ts`).
- ✅ `coordinator.ts` — the `GraphManager`: id → per-graph Worker; spawns Workers (LANDED, page-hosted;
  single-tab routing is first-party MessagePort RPC, not SharedService).
- ⏳ `sharedservice.ts` — Web-Locks-election + MessagePort routing for CROSS-TAB failover. The one
  DEFERRED increment (its own design pass — see the decision section above).
- ✅ graph Worker STORE tier + transport — `GraphWorkerHost.ts` + `graph-worker.entry.ts` +
  `GraphWorkerClient.ts` (LANDED, proven in-browser over opfs-sahpool, clone boundary tested).
- ✅ service worker entry — `service-worker.entry.ts` (LANDED; the SW BROKERS an intercepted fetch to
  the page, because it cannot spawn the store's Worker — `makeRouter` runs in the page, `page-edge.ts`).
- ✅ `test-browser/` — the Playwright lane (LANDED: `runBrowserWorker`/`runBrowserPage` harness + the
  OpfsIoStore, GraphWorkerHost, transport, coordinator, and SW-edge contracts + the clone-boundary test).
  Later: fuller `graphContract` coverage in-browser + the crash-failover tests.
