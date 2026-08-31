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
`ServiceWorkerGlobalScope`; `navigator.locks` IS available there). So Worker-spawning lives in a PAGE. The
first landed cut (single-tab E2E, proven in a real browser) had the SW broker `fetch`→a page that ran
`makeRouter` and held the graph Workers:

```
unmodified gremlin GLV / plain fetch  ->  globalThis.fetch  ->  Service Worker intercept
  ->  page edge  ->  makeRouter  ->  BrowserGraphManager  ->  per-graph dedicated Worker
  ->  WasmSqlite on opfs-sahpool  ->  GraphBinary response back through the SW
```

### Direction pivot (Dan, 2026-08-31) — SW is the edge; the page is a Worker factory, NOT in the data path

The single-tab cut works, but it routes **every request through a double hop** (SW → page → Worker),
because `makeRouter` and the manager live in the page. That is the interim shape, not the target. Two
platform facts let us collapse it:

1. **A `MessagePort` stays entangled after transfer to *any* agent — a Service Worker included.** So the
   page never has to sit in the message path. The page spawns graph `G`'s Worker `W`, makes a
   `MessageChannel {p1,p2}`, transfers `p1` **to `W`** and `p2` **to the SW**; now the SW and `W` hold
   entangled ports and talk **directly**, capnweb over that port. The page has stepped out.
2. **There is exactly ONE Service Worker per (origin, scope), shared across every tab** — the SW is not
   one-per-tab, it is the origin-wide singleton edge by spec. So there is no "shared server" to build and
   no `SharedWorker` for the edge: the SW already IS it.

So the target architecture is the one the seams table below always described — **SW = the edge (runs
`makeRouter`, holds a direct capnweb stub to each graph's Worker); the page = a pure `WorkerFactory` +
owner + leader** (only a Window can spawn a dedicated Worker, and a dedicated Worker dies with its owner
document, so some tab must spawn and *keep* it). `makeRouter`'s `executor(id)` on the SW side is just "the
stub over the port the factory handed me." **Data plane: one hop, SW → Worker.** **Control plane (rare — SW
cold-start, a new graph, or a failover): the SW asks the factory `openGraph(graphId)` over a typed capnweb
`WorkerFactory` interface** — not a hand-rolled message.

**Everything meaningful is strongly-typed capnweb — data plane AND control plane.** No hop carries a
hand-rolled byte protocol; **no wire needs a custom `RpcTransport`**. The ONE irreducible native message is
the capnweb **bootstrap**: handing a `MessagePort` to an agent so a session can exist (capnweb's own
`MessagePortTransport` does `port.postMessage(message)` with no transfer list, so it *cannot itself* carry
a port — a port must be delivered natively before any typed call is possible). We give it a single shared
type — `interface Bootstrap { port: MessagePort; graphId?: string }` — carrying only a port and a tag,
with no application fields to grow. Every other message, in both directions, is a typed capnweb call.

**The one remaining measure-in-a-browser unknown: cross-tab leader election + failover** — which tab
spawns/owns each graph's single Worker, and a clean handover when that tab is hard-killed. Note this is
*only* about the Worker-owning tab; the edge is already a shared singleton. **Decision (Dan, 2026-08-31):
clean-room TypeScript**, using rhashimoto's `SharedService` (`rhashimoto/wa-sqlite`
`demo/SharedService-sw/`, MIT) as a REFERENCE for the **Web-Locks election/liveness primitives only** — we
do NOT need its port-broker machinery, because our SW can transfer ports itself. The design is below.

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
- **A `MessagePort` transferred to a Service Worker stays entangled** with the port held by a dedicated
  Worker (HTML spec: transfer preserves entanglement, and a SW can receive a transferred port — page→SW
  via `controller.postMessage(msg, [port])`, arriving as `event.ports`; page→Worker via
  `worker.postMessage(msg, [port])`). This is what lets the SW hold a **direct** capnweb `MessagePort`
  session to a graph's Worker with the page out of the data path — so the custom `RpcTransport`/opaque-relay
  the earlier plan reached for is **NOT needed**. (`RpcSession`+custom `RpcTransport` remains available if a
  future need arises, but nothing in this port uses it.)

**Hop 1 — page↔graph-worker. ✅ LANDED 2026-08-31 (`b248efd`).** `GraphWorkerHost extends RpcTarget`;
`graph-worker-protocol.ts` and `GraphWorkerClient.ts` DELETED (the protocol is now the host's TS
signatures, the stub is `newMessagePortRpcSession<GraphWorkerHost>(port1)`); `graph-worker.entry.ts`
shrank to boot-then-expose over a page-created `MessageChannel`, serving the host as an `RpcPromise`
over `open()` (so an open failure rejects calls, fail closed, no fake host);
`BrowserGraphManager.executor(id)` holds the stub and delegates, with the `Framed[]`→`Buffer` rewrap at
that seam. `graph-worker-rpc.test.ts` drives the capnweb stub (clone-boundary + failure-as-value kept).
Net −102 LOC. Browser lane 33/33; full `ci` green.

**Hop 2 — SW is the edge; the page is the `WorkerFactory`; SW talks to the Worker DIRECTLY. ✅ LANDED
2026-08-31 (`b691da7`).** Replaced the interim "SW → page → Worker" double hop with a single data-plane
hop; every proven-in-a-real-browser unknown (a SW *receiving* a transferred `MessagePort`, its entanglement
with a dedicated Worker's port, capnweb over that port from SW scope) is now confirmed by the green
`service-worker-edge` test. The pieces as built:

- **`makeRouter` + the response framing move into `service-worker.entry.ts`.** The SW becomes the real
  edge: on an intercepted `fetch('/gremlin/{id}')` it runs `makeRouter`, whose `executor(id)` returns the
  capnweb stub over the SW's **direct** port to graph `id`'s Worker. (No SQLite/compiler in the SW bundle —
  only the wire/framing; those stay in the Worker.)
- **`page-edge.ts` becomes the `WorkerFactory`** (rename the file to `worker-factory.ts` — it is a Worker
  factory + owner, not an "edge"; the SW is the edge now). It exposes a typed capnweb `WorkerFactory`
  `RpcTarget` — `openGraph(graphId): Promise<GraphInfo>` — over a control-plane capnweb session with the
  SW. On `openGraph(G)` it spawns `G`'s Worker if this tab is `G`'s leader, makes a `MessageChannel`,
  bootstraps the Worker's session with one end (`Bootstrap` → the Worker serves `newMessagePortRpcSession(
  port, host)`, Hop 1's surface unchanged) and bootstraps the SW's DIRECT session with the other end
  (`Bootstrap{ port, graphId: G }` → `controller.postMessage(msg, [port])`). Then it is out of the data
  path; it keeps owning the Worker (a dedicated Worker dies with its document). (`registerServiceWorker`
  moves here — the factory tab registers the SW, then opens the control session by bootstrapping it a port.)
- **The SW keeps `graphId → RpcStub<GraphWorkerHost>`** (over the bootstrapped direct port) plus a
  `RpcStub<WorkerFactory>` per factory tab. On a miss — first request for a graph, or after the browser
  reaped the SW and its in-memory ports — it calls `factory.openGraph(id)` and pairs the resulting
  `Bootstrap{graphId:id}` with the direct stub it builds. On a stub rejection meaning the port died (owner
  tab gone), it evicts and re-calls `openGraph`.
- **`BrowserGraphManager` splits:** the SW-side half is the router's `executor(id)`/`info`/`create` over
  the direct stub; the page-side half is the factory (spawn/own/leadership). Hop 1's `GraphWorkerHost` and
  `graph-worker.entry.ts` are untouched — only *who holds the other end of the port* moves from the page to
  the SW.

`service-worker-edge.test.ts` (plain fetch + management GET + unmodified GLV) is the contract and stays
green — it drives the client's `fetch`, so the SW-internal rewiring is invisible to it. This is the
substrate the cross-tab story below wants, so we build it once here rather than building the in-page
version and tearing it out.

## Cross-tab failover — ✅ LANDED + PROVEN 2026-08-31 (`5c5d777` mechanism, `0b6dbe8` proof)

Built and proven in a real browser: two tabs share one origin; tab A leads a graph with two acked writes;
A is HARD-KILLED (page closed); tab B takes over, re-opens opfs-sahpool over the committed data, and keeps
serving — count intact, a further acked write applied once (`test/browser/failover.test.ts`, stable
~1.1s). This settled the two flagged unknowns: **a hard-killed leader's SAH handles release promptly
enough** for the new leader to re-open the DB (no corruption, no lost data), and **the read issued straight
after the kill retries across the handoff** (a hard-killed tab never closes its MessagePort — capnweb only
sees a close via an explicit `null` from `abort()` — so the dead-stub call HANGS until the new leader's
port disposes it, then the manager retries once). `navigator.storage.persist()` is requested on factory
install (OPFS is otherwise evictable). What was built matches the design below.

### The design (as built)

Because the SW is a **single origin-wide edge shared by all tabs** (above), cross-tab is NOT about routing
between edges — there is one edge. It is *only* about **which tab spawns and owns each graph's single
Worker thread**, and handing that ownership over cleanly when the owner tab dies. That narrows the problem
sharply, and the port-transfer fact narrows it further: the SW holds a direct port to the Worker, so a
dead owner tab shows up as the **port breaking** — the death signal is free.

**The one valuable primitive we keep from `SharedService`: election + liveness in ONE Web Lock.** The
owner ("leader") tab holds `navigator.locks.request('mogwai-graph-<id>', {signal})` for its whole life.
Only one holder exists; other tabs with that graph open queue on the same lock. Release (tab
closed/crashed) fires the next waiter's callback → it becomes leader. That single lock IS the election AND
the failover — no heartbeats, no announcement protocol.

**What we DROP from `SharedService` (and why we can):**
- The **`BroadcastChannel` port-broker** and the whole "can't transfer a port, so route by clientId"
  dance — our SW transfers ports itself, directly to a client and to a Worker.
- The **per-`clientId` death-detection lock** — the SW's direct stub rejecting (its entangled port broke
  when the owner tab's document was destroyed) IS the death signal; no second lock needed to notice it.
- The generic `Proxy`/`createSharedServicePort` and the SharedWorker path — our RPC is the typed capnweb
  `GraphWorkerHost` stub, and the edge is the SW, not a SharedWorker.

**The handshake (control plane, typed capnweb).** The SW holds a `RpcStub<WorkerFactory>` per factory tab
(each bootstrapped once when the tab registers). On a `fetch('/gremlin/{id}')` for which the SW has no live
stub, it calls `openGraph(id)` on the factory stubs; the tab that is `id`'s leader (holds the lock) spawns
the Worker if it hasn't and bootstraps the SW a direct port (`Bootstrap{graphId:id}`), then `openGraph`
resolves with the `GraphInfo`. The SW pairs the arriving port with the call and builds the direct
`RpcStub<GraphWorkerHost>`. If NO tab yet leads `id`, a tab with it open acquires the lock (that is how it
becomes leader) and answers. The ONLY native message in any of this is the `Bootstrap` port hand-off.

**Failover (corrected by the build — the port does NOT break).** A hard-killed tab does NOT gracefully
close its MessagePort: capnweb's `MessagePortTransport` only registers a close when the peer sends an
explicit `null` (its `abort()`), which a destroyed document never does. So the SW's stub to the dead
Worker does **not** break on its own — an in-flight call HANGS. The reliable death signal is instead the
**released Web Lock promoting a new leader**, which spawns the Worker (**re-opening the opfs-sahpool DB
after the dead tab's SAH handles release** — the one timing only a real browser settles, and it does) and
**pushes the SW a fresh port**. On that push the SW **disposes the old stub** — which aborts its session
and makes the hung call reject — installs the new stub, and the manager **retries the call once** against
the new leader. So a request in flight at the instant of a hard kill completes rather than erroring, with
no reliance on a port-close that never comes.

**Carry these robustness fixes** (from the reference audit, still apply): BOUND the "no leader yet" wait
and surface a clear 503/"no leader" state rather than spin forever (same unbounded-hang shape as the
SW-control race already fixed); retry an in-flight RPC exactly once across a failover, then fail closed;
`crypto.randomUUID()` for any handshake nonce; a write that was acknowledged must not be double-applied
across a handover (tx-dedup).

**Phased plan — all ✅ landed (`5c5d777`/`0b6dbe8`), except a small residue below.**
1. ✅ **Per-graph leadership in the `WorkerFactory`** — `mogwai-graph-<id>` held for the tab's life via
   `navigator.locks.request({signal})`; `openGraph` enqueues once per id (the granted tab spawns +
   delivers, the rest queue as leaders-in-waiting); `destroyGraph` aborts the lock.
2. ✅ **SW-side `FactoryStubSource`** — control sessions to the factory tabs, the per-graph current stub,
   the bounded "no factory → 503" wait, and late-tab re-queueing for active graphs.
3. ✅ **Failover** — new-leader push disposes the dead stub; `BrowserGraphManager` retries once on a
   changed stub; opfs-sahpool re-opens over the committed data. Proven by `failover.test.ts`.
4. ✅ **`navigator.storage.persist()`** requested on factory install.

**Residue (not blocking; fail-safe as-is):**
- **Surface quota** (`navigator.storage.estimate()`, the 10 GB DO-ceiling analog) — not yet exposed
  anywhere, because there is no consumer for it yet.
- **Write exactly-once tail.** An ACKED write is never retried, so it is applied once (the test asserts
  this). A write that COMMITTED on the old leader but whose ack was lost to the hard kill is retried
  (at-least-once) — the narrow committed-but-unacked window. Exactly-once there needs write idempotency
  keys, out of this increment's scope.

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
| `executor(id).framedAsync` | **async** | capnweb `MessagePort` session, SW → Worker DIRECT ✅ (Hop 1) |
| `IoStore.readStream`/`writeStream` (`src/iostore.ts:42`) | **async**, streaming | async OPFS `stream()`/`createWritable()` ✅ proven |
| RPC payloads (`Framed[]`, `Executable`) | **structured-clone-safe** (already, for the DO) | capnweb `encodingLevel: structuredClonable` — `Uint8Array`/`bigint` sent native (a copy, but no base64/JSON blowup) |

The data plane is already clone-safe because the DO RPC boundary already structured-clones it
(`Program` ships rendered, `Compiled`/`Executable` are plain data — `src/cloudflare/rpc.ts`). Across the
browser Worker boundary, capnweb turns a query failure into a stub rejection automatically, so the browser
side needs no `rpcTry`/`rpcUnwrap` (those stay for the DO boundary, `src/rpc.ts`); `graph-worker-rpc.test.ts`
is the browser twin of `test/cloudflare.test.ts` that a green main-thread run won't catch.

## The three seams (new leaves under unchanged interfaces)

| Interface | Bun | Cloudflare | **Browser (new)** |
|---|---|---|---|
| `Sql` (sync) | `BunSqlite` | `DurableObjectSqlite` | `WasmSqlite` — official `@sqlite.org/sqlite-wasm`, `opfs-sahpool` |
| `IoStore` (async, streaming) | `FileIoStore` | `R2IoStore` | `OpfsIoStore` — `file.stream()` / `createWritable()` (the `IoSink` contract) |
| `GraphManager` (lifecycle + executor factory) | `BunGraphManager` (`Map`) | `CloudflareGraphManager` (id→DO) | SW-side `executor(id)` → a direct capnweb stub to `id`'s Worker; the `WorkerFactory` (page) spawns/owns Workers, Web-Lock leader per graph |
| entry point | `bun/server.ts` | `cloudflare/worker.ts` | a **Service Worker** = the edge (`makeRouter` + `fetch` intercept + a direct capnweb stub per graph); a `WorkerFactory` page spawns **one Worker per graph** |
| `Buffer` | Bun global | workerd `nodejs_compat` global | ambient global; the SW entry supplies it: `import { Buffer } from 'buffer'; globalThis.Buffer = Buffer` (Bun's bundler auto-polyfills the import) |

Everything above these leaves — `GraphStore`, the whole compiler, `execute.ts`, wire, `makeRouter` — is
unchanged. The bind-coercion seam (`coerceBindValue`, `storage.ts:161`) already normalizes types across
runtimes; real SQLite in the browser is *more* permissive than the DO, so it's covered. `Buffer` is used
as a bare ambient global in the four wire files (verified: Bun + real workerd both green without imports).

## Locked decisions

1. **Official `@sqlite.org/sqlite-wasm`, standard build** (FTS5 + JSONB), VFS **`opfs-sahpool`**.
2. **One dedicated Worker per graph**; **Web Locks** per-graph leader election. `SharedService` is a
   REFERENCE for the lock election/liveness primitives only — no port-broker, no wa-sqlite dependency.
3. **Service Worker** as the HTTP edge — unconditional; unmodified `fetch` clients work. **All browser RPC
   is strongly-typed capnweb** (data plane SW↔Worker; control plane SW↔`WorkerFactory`); the only native
   message is the capnweb `Bootstrap` port hand-off, which capnweb cannot itself carry.
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
  bundles by per-target bundling), `playwright` (dev driver), `capnweb` (runtime, browser-leaf only — all
  browser RPC). `SharedService` is a REFERENCE for the Web-Lock primitives, not ported code and not a dep.

## Build plan

New leaf `src/browser/`, plus a Service Worker entry and a Playwright test lane:

- ✅ `WasmSqlite.ts` — `Sql` over `@sqlite.org/sqlite-wasm` / `opfs-sahpool` (LANDED; full conformance
  contract green in-process via `test/bun-wasm.test.ts`).
- ✅ `OpfsIoStore.ts` — `IoStore` over async OPFS streaming (LANDED; proven against real OPFS via the
  Playwright lane, `test/browser/browser.test.ts`).
- ✅ `BrowserGraphManager` — now ONE `GraphManager` engine over a `GraphStubSource` seam (LANDED, Hop 2):
  `LocalWorkerSource` (spawns its own Workers — the manager test) or the SW's factory source (asks the
  `WorkerFactory` for a port). Holds the stubs + `executor`/`create`/`info`/`destroy` + the `Framed[]`→
  `Buffer` rewrap once.
- ✅ **Hop 2 — SW is the edge; page is the `WorkerFactory`; direct SW↔Worker capnweb** (`b691da7`).
  `makeRouter` + framing moved into `service-worker.entry.ts` (660 KB bundle — wire only, no SQLite/
  compiler); `page-edge.ts → worker-factory.ts` exposes the typed `WorkerFactory` (`openGraph`/
  `destroyGraph`) over a control-plane capnweb session; the SW holds a direct `GraphWorkerHost` stub per
  graph and a `WorkerFactory` stub. `worker-spawn.ts` holds the shared spawn/bootstrap helpers + the one
  native `Bootstrap` message type. Interim double hop gone. `service-worker-edge.test.ts` unchanged + green.
- ✅ Cross-tab failover — Web-Locks per-graph leader election (`WorkerFactory`) + `FactoryStubSource`
  (SW-side control + failover stub swap) + `BrowserGraphManager` retry-once. LANDED + PROVEN in a real
  browser (`failover.test.ts`: hard-kill the leader, another tab takes over, data intact).
- ✅ graph Worker STORE tier + transport — `GraphWorkerHost.ts` (now `extends RpcTarget`) +
  `graph-worker.entry.ts` (Cap'n Web session over a MessagePort). LANDED, proven in-browser over
  opfs-sahpool, clone boundary tested. (Hop 1 replaced the hand-rolled `GraphWorkerClient`/protocol.)
- ✅ service worker entry — `service-worker.entry.ts` (LANDED, Hop 2: the SW IS the edge — runs
  `makeRouter` and holds a direct capnweb stub to each graph's Worker; a page-hosted `WorkerFactory`
  spawns the Workers on its behalf, since a SW cannot spawn a dedicated Worker).
- ✅ `test/browser/` — the Playwright lane (LANDED: `runBrowserWorker`/`runBrowserPage` harness + the
  OpfsIoStore, GraphWorkerHost, transport, coordinator, and SW-edge contracts + the clone-boundary test).
  Later: fuller `graphContract` coverage in-browser + the crash-failover tests.
