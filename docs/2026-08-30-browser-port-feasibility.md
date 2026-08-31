# mogwai-db in the browser — locked design + proof

**Status:** design **locked** and **empirically proven** in a real browser (2026-08-31). Build in
progress against this plan.

## Landed

- **`WasmSqlite` (the `Sql` leaf)** — `src/browser/WasmSqlite.ts`, the synchronous `Sql` seam over
  `@sqlite.org/sqlite-wasm`'s OO1 API, VFS-agnostic (`:memory:` for dev/tests, `opfs-sahpool` for a
  browser Worker). Proven DEEP without a browser: because the OO1 API is synchronous and runs a real
  WASM SQLite (3.53.0, FTS5 + JSON) in-process, the whole conformance contract runs under `bun test`
  against it — `test/bun-wasm.test.ts` (all 38 contract assertions: data plane, management, io
  formats, federation, and the `barrier_state` OLAP SQL). Only the VFS differs in a real browser.
- **`BunGraphManager` is now storage-agnostic** — a `makeSql` factory seam (default `bun:sqlite`,
  unchanged) lets the SAME battle-tested manager back the WASM leaf; the browser graph-Worker reuses it.
- **`OpfsIoStore` (the `IoStore` leaf)** — `src/browser/OpfsIoStore.ts`, streaming read/write over OPFS
  (`file.stream()` / `createWritable()`), fail-closed absence, prefix listing, truncating rewrite,
  abort-leaves-nothing. The browser twin of `FileIoStore`/`R2IoStore`, reached from inside a graph's
  dedicated Worker; keys resolve under a shared base dir (per-deployment io namespace).
- **The Playwright browser lane** — `test/browser/` (outside `bun test`'s `test/` root). Playwright as a
  DRIVER LIBRARY (`chromium.launch`) drives GitHub's / this machine's **system Chrome** (no browser
  download), bundling a dedicated worker with `Bun.build`, serving it over `localhost`, asserting on what
  the worker posts back. `test/browser/support/harness.ts` (`runBrowserWorker`) is the reusable driver
  every later browser leaf reuses; `test/browser/browser.test.ts` runs the OpfsIoStore contract against
  REAL OPFS. Its own CI job (`browser`), separate from the Bun-only aggregate; `mise run test:browser`
  locally. `tsconfig` gained DOM libs (measured 0-conflict) so the browser leaves type-check in the main gate.
- **`GraphWorkerHost` (the store tier)** — `src/browser/GraphWorkerHost.ts`, what runs inside a graph's
  dedicated Worker: a `GraphStore` over its own opfs-sahpool WASM SQLite database + the `Executor`
  (self-federation; cross-worker federation fail-closed, routed by the coordinator). PROVEN: the WHOLE
  core (compiler → executor → GraphBinary wire, encode AND decode) runs in a real Chrome Worker over the
  production opfs-sahpool VFS — `test/browser/graph-worker.test.ts` runs the gremlin data plane and
  decodes with the vendored client's own reader. Only the postMessage TRANSPORT fronting it is deferred
  to the coordinator increment (its RPC protocol is designed there).
- **Browser-bundle infra** (needed by every browser worker running the core, all measured from the real
  bundle): `node-util-shim.ts` (the one `node:util` export — `isDeepStrictEqual` — the client needs and
  Bun's browser polyfill lacks), `bundle.ts` (shared `Bun.build` config so the test lane and production
  build share shims), `buffer-global.ts` (installs `Buffer` as a global, imported first so it beats
  `http.ts`/`io.ts` module-init).
- **Graph-worker RPC — now Cap'n Web (Hop 1 LANDED 2026-08-31, `b248efd`)** — `graph-worker.entry.ts`
  (boot-then-expose: the page transfers a `MessagePort` + graphId as the worker's first message; the
  worker opens the host and serves it as an `RpcPromise` over the `open()` promise). `GraphWorkerHost`
  extends capnweb's `RpcTarget`, so its `framed()`/`runForeign()`/`info()` signatures ARE the protocol —
  the hand-rolled `GraphWorkerClient.ts` + `graph-worker-protocol.ts` are DELETED. A query failure OR an
  open failure rejects the caller's stub with its reason (capnweb exception support), so no `rpcTry`/
  `rpcUnwrap` wrapper on this boundary. `BrowserGraphManager.executor(id)` holds
  `newMessagePortRpcSession<GraphWorkerHost>(port1)` and delegates; the `Framed[]` Uint8Array→Buffer
  rewrap lives at that one seam. Proven in-browser (`graph-worker-rpc.test.ts`, still 5/5): `Framed[]`
  crosses NATIVE (no base64/JSON blowup), and a failing query rejects (no hang). `src/rpc.ts` is
  UNCHANGED — it is the Cloudflare DO boundary (native workerd RPC), a different transport.
- **Deps added:** `@sqlite.org/sqlite-wasm` (runtime, browser-leaf only — per-target bundling keeps it
  out of the Bun/CF bundles; nothing on those paths imports `src/browser/*`), `playwright` (dev driver).

- **Service Worker edge + page edge (single-tab)** — `service-worker.entry.ts` (intercepts
  `/gremlin|/graphql` fetches, brokers them to a controlled page over a per-request MessageChannel),
  `page-edge.ts` (`installMogwaiPageEdge` runs the local router; `registerServiceWorker` resolves once the
  SW controls the page). Proven (`service-worker-edge.test.ts`): a plain fetch AND the **unmodified TinkerPop GLV**
  reach the local opfs-sahpool graph with no monkey-patching.

## Coordination-layer decision (2026-08-31) — SINGLE-TAB E2E COMPLETE

Verified: a **Service Worker cannot spawn dedicated Workers** (`Worker`/`SharedWorker` are `undefined` in
`ServiceWorkerGlobalScope`; `navigator.locks` IS available there). So Worker-spawning lives in a PAGE and
the SW brokers `fetch`→page-hosted-Worker. Chosen approach (Dan, 2026-08-31): **single-tab end-to-end
first** — now DONE and proven in a real browser. The full stack runs:

```
unmodified gremlin GLV / plain fetch  ->  globalThis.fetch  ->  Service Worker intercept
  ->  page edge  ->  makeRouter  ->  BrowserGraphManager  ->  per-graph dedicated Worker
  ->  WasmSqlite on opfs-sahpool  ->  GraphBinary response back through the SW
```

**The one remaining increment: cross-tab leader election + failover** (share one graph across tabs; a
hard-killed leader releases its Web Lock and pool and another tab takes over). This is the doc's flagged
measure-in-a-real-browser unknown. **Decision (Dan, 2026-08-31): clean-room TypeScript reimplementation**,
using rhashimoto's `SharedService` (`rhashimoto/wa-sqlite` `demo/SharedService-sw/`, MIT) as a REFERENCE
only — not a vendor/port. The design that reference yields is below.

## Browser RPC → Cap'n Web (decided 2026-08-31)

**Decision (Dan):** replace ALL hand-rolled RPC hops **in the browser** with Cap'n Web (`capnweb`, MIT,
zero-deps, added as a runtime dep — browser-leaf only, kept out of the Bun/CF bundles by per-target
bundling). **Nothing outside the browser changes** — the Cloudflare DO keeps its native workerd RPC; this
is not about CF. Do it as green increments: **page↔worker first**, then the Service-Worker↔page hop.

**Spike-proven (scratch, Bun, capnweb 0.12.0) — every risk cleared:**
- `Framed[]` = `{buf: Uint8Array, bulk: bigint}[]` round-trips **native/raw** over a `MessagePort` — the
  `MessagePortTransport` uses `encodingLevel: "structuredClonable"`, so `TypedArray`/`bigint` are sent
  as-is (no base64/JSON blowup). This was the make-or-break.
- A thrown `Error` arrives as a rejection **with message + stack** → failure-as-value for free; the
  browser-boundary `rpcTry`/`rpcUnwrap` go away (`src/rpc.ts` STAYS — it's the CF-DO boundary).
- Bundles for the browser (~104 KB unmin / ~16 KB gz — negligible vs the 3.5 MB worker bundle). Has
  first-class `bun` + `workerd` export conditions; its `RpcTarget` on workerd IS the DO one.

**API facts (from `node_modules/capnweb/dist/index.d.ts` + source):**
- `newMessagePortRpcSession(port: MessagePort, localMain?, opts?) → RpcStub<T>` — symmetric; `localMain`
  is what THIS side exposes, the return is a typed stub to the PEER's `localMain`.
- `RpcTarget` (exported base class) — extend it to expose an object. Methods may be sync or async;
  args/returns must be `RpcCompatible` (our `Framed[]`/`GraphInfo`/`ForeignResult`/`TypeNode` are).
- `MessagePortTransport` calls `port.start()` + `addEventListener('message')`, so it needs a REAL
  `MessagePort`, NOT a Worker/WorkerGlobalScope. Use an explicit `MessageChannel`: the page (spawner)
  creates it, transfers `port2` + the `graphId` to the worker via the worker's first `postMessage`, and
  uses `port1`; the worker `open`s the host then `newMessagePortRpcSession(port2, host)`. Calls sent
  before the worker's session exists queue on the port, so the async `open` gap is fine.
- Custom transport (for the SW hop): `interface RpcTransport { send(msg): void|Promise; receive():
  Promise<msg>; abort?(reason) }`, then `new RpcSession(transport, localMain).getRemoteMain()`. Messages
  are OPAQUE; the docs bless a transparent relay A→B→C (B forwards frames unparsed) — exactly the SW
  bounce. Framing + ordering must be preserved.

**Hop 1 — page↔graph-worker. ✅ LANDED 2026-08-31 (`b248efd`).** `GraphWorkerHost extends RpcTarget`;
`graph-worker-protocol.ts` and `GraphWorkerClient.ts` DELETED (the protocol is now the host's TS
signatures, the stub is `newMessagePortRpcSession<GraphWorkerHost>(port1)`); `graph-worker.entry.ts`
shrank to boot-then-expose over a page-created `MessageChannel`, serving the host as an `RpcPromise`
over `open()` (so an open failure rejects calls, fail closed, no fake host);
`BrowserGraphManager.executor(id)` holds the stub and delegates, with the `Framed[]`→`Buffer` rewrap at
that seam. `graph-worker-rpc.test.ts` drives the capnweb stub (clone-boundary + failure-as-value kept).
Net −102 LOC. Browser lane 33/33; full `ci` green.

**Hop 2 — client fetch → Service Worker → page (after hop 1).** The SW↔page forwarding in
`service-worker.entry.ts` + `page-edge.ts` becomes a capnweb session over a custom `RpcTransport`: the
page exposes an `RpcTarget` (`{ fetch(reqInit): respInit }` running `makeRouter`), the SW calls it,
relaying opaque frames. This also sets up the cross-tab failover transport (client → SW → leader page).

## Cross-tab failover — design (from the SharedService audit)

**The pattern, distilled.** rhashimoto's `SharedService` makes a same-origin singleton with automatic
leader election + crash failover out of THREE primitives, and the genuinely valuable idea is using Web
Locks for two jobs at once:

1. **Election + liveness in one lock.** The leader ("provider") holds `navigator.locks.request(
   'SharedService-<name>', {signal})` for its whole life. Only one holder exists; the rest queue. Release
   (tab closed/crashed/aborted) fires the next waiter's callback → it becomes leader. That single lock IS
   the election AND the failover — no heartbeats, no election protocol.
2. **A second per-`clientId` lock = death detection.** Each context holds a lock named after its own id;
   anyone detects that context dying by *requesting* that lock (grantable only once the holder is gone).
   The leader uses exactly this to close a dead client's port — crash-safe cleanup with no polling.
3. **A broker to TRANSFER a MessagePort to a specific client.** `BroadcastChannel` carries the "who is
   leader" announcements and the clients' port *requests*, but cannot transfer a port; so a broker (the
   `-sw` variant's Service Worker, routing by `clients.get(clientId)`) hands the port to the right client.
   Then a per-client `MessageChannel` carries the actual nonce-matched RPC.

**Audit — carry these fixes into our TS version** (the reference is clever and sound; the rough edges are
small): guard the response-callback lookup (a late/duplicate response for a deleted nonce throws today);
BOUND the "no provider yet" retry loop and surface a "no leader" state rather than spin forever (same
unbounded-hang shape as the SW-control race we already fixed); reject-and-retry-once in-flight RPCs across
a failover instead of just failing them; `crypto.randomUUID()` nonces, not `Math.random()`; fail closed on
unknown method names (no `target[method]` reaching the prototype). Keep the subtlety that the leader needs
its OWN `BroadcastChannel` instance to serve its own request.

**What we KEEP vs. DROP** — our shape is far narrower than the general library:
- **Keep** the two-lock scheme: a per-graph lock `mogwai-graph-<id>` = "which page hosts this graph's
  Worker," and a per-page-`clientId` lock for death detection.
- **Reuse, don't add:** we already run the Service Worker as broker, and it already has `event.clientId`
  and `clients.get(id)`. Today `forwardToPage` picks `matchAll()[0]`; the failover version routes
  `/gremlin/{id}` to the LEADER page for that graph (its clientId), electing it via the per-graph lock.
- **Drop** the generic `Proxy`/`createSharedServicePort` (our client↔Worker RPC is already the typed
  `GraphWorkerClient` / `graph-worker-protocol`), the SharedWorker path, and the `fetch('./clientId')`
  polling (`page-edge.ts` already resolves SW control).
- New work: the leader acquires the per-graph lock → spawns the Worker; a non-leader tab's fetch routes
  through the SW to the leader; on leader death the lock releases, a new leader acquires it and **re-opens
  the opfs-sahpool DB after the dead tab's SAH handles release**.

**Phased plan.**
1. **Per-graph leadership in the coordinator.** `BrowserGraphManager` acquires `mogwai-graph-<id>` before
   spawning a Worker; a page that does not hold the lock does NOT spawn — it registers with the SW as a
   *client* of that graph (its clientId) instead. One Worker per graph across the whole origin.
2. **SW routes by leader, not `matchAll()[0]`.** The SW keeps a `graphId → leader clientId` map (fed by
   the leader announcing on a `BroadcastChannel`), and `forwardToPage` targets `clients.get(leaderId)`;
   503 with a clear body when no leader is currently elected.
3. **Failover.** On leader death its per-graph lock releases; the next waiting page's `locks.request`
   callback fires, it spawns the Worker (re-opening the opfs-sahpool DB) and announces itself the new
   leader; the SW re-points the map; in-flight requests retry once against the new leader.
4. **`navigator.storage.persist()`** requested once, and surface quota (the 10 GB DO-ceiling analog).

**Tests (multi-tab Playwright — the unknowns live HERE).** Two `context`s (or two pages) sharing one
graph: (a) both read/write the same graph, only one Worker exists; (b) **hard-kill the leader** (close its
context) and confirm the other takes over and re-opens the DB with no corruption and no lost committed
data — the handle-release-on-failover timing is the ONE thing only this test settles; (c) a request
in-flight at the moment of failover completes (retry) rather than erroring; (d) tx-dedup: a write that was
acknowledged is not double-applied across the handoff. These extend the existing `runBrowserPage` harness
(now multi-context on one shared browser).

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
`SharedService` pattern (~200 lines, **MIT** — © Roy T. Hashimoto, `rhashimoto/wa-sqlite`
`demo/SharedService/`; a Service-Worker broker variant lives at `demo/SharedService-sw/`. Verified
2026-08-31; an earlier draft said Apache-2.0, which is wrong. **ported** — we do not depend on wa-sqlite). A
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
  contract green in-process via `test/bun-wasm.test.ts`).
- ✅ `OpfsIoStore.ts` — `IoStore` over async OPFS streaming (LANDED; proven against real OPFS via the
  Playwright lane, `test/browser/browser.test.ts`).
- ✅ `coordinator.ts` — the `GraphManager`: id → per-graph Worker; spawns Workers (LANDED, page-hosted;
  single-tab routing is first-party MessagePort RPC, not SharedService).
- ⏳ Cross-tab failover — Web-Locks per-graph leader election + SW-routed-by-leader + handoff. The one
  remaining increment; DESIGN DONE (clean-room TS, see "Cross-tab failover — design" above), not built.
- ✅ graph Worker STORE tier + transport — `GraphWorkerHost.ts` (now `extends RpcTarget`) +
  `graph-worker.entry.ts` (Cap'n Web session over a MessagePort). LANDED, proven in-browser over
  opfs-sahpool, clone boundary tested. (Hop 1 replaced the hand-rolled `GraphWorkerClient`/protocol.)
- ✅ service worker entry — `service-worker.entry.ts` (LANDED; the SW BROKERS an intercepted fetch to
  the page, because it cannot spawn the store's Worker — `makeRouter` runs in the page, `page-edge.ts`).
- ✅ `test/browser/` — the Playwright lane (LANDED: `runBrowserWorker`/`runBrowserPage` harness + the
  OpfsIoStore, GraphWorkerHost, transport, coordinator, and SW-edge contracts + the clone-boundary test).
  Later: fuller `graphContract` coverage in-browser + the crash-failover tests.
