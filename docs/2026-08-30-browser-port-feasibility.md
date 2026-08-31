# Browser port feasibility — mogwai-db entirely in the tab

**Status:** research / feasibility. No code. Written 2026-08-30.

**Verdict up front:** feasible, and *unusually* so. The architecture that made this a Durable
Object database is almost exactly the architecture a browser port wants, for one reason: the DO
forced a **synchronous SQLite seam behind an asynchronous, structured-clone RPC boundary**, and
that is precisely the shape the browser gives you — a synchronous OPFS-backed SQLite running inside
a Worker, addressed across an async `postMessage` boundary. The port is mostly *new leaves under
existing seams*, not a rewrite. The single cross-cutting task is `Buffer`. JSPI is **not** needed on
the recommended path (the user's instinct is correct); it is a contingency tied to one specific
storage choice, spelled out in §5.

This doc validates the proposed design against the actual seams in the tree, names the real work,
and names the genuinely new problems the browser introduces that neither Bun nor Cloudflare has.

---

## 1. Why the fit is this good — the structural mapping

The whole project is built around one runtime-agnostic core plus two thin platform leaves (Bun,
Cloudflare). The browser is a **third leaf** at the same seams. The Cloudflare model maps onto
browser primitives almost one-for-one:

| Cloudflare concept | Browser analog | Why it lines up |
|---|---|---|
| One DO = one isolated graph, single-threaded | One **dedicated Worker per graph** (in that graph's elected leader tab) | Single-threaded run-to-completion context per graph; cross-graph concurrency from having many Workers, exactly as Cloudflare gets it from many DOs |
| `ctx.storage.sql` — **synchronous** SQLite | SQLite-WASM over **OPFS `SyncAccessHandle`** (sync, inside a *dedicated* Worker) | Both are synchronous SQLite; the `Sql` seam is already sync *because of the DO* (`src/storage.ts:1`) |
| DO RPC — **structured-clone** args/results | Worker `postMessage` — **structured-clone** | Same serialization algorithm; the same constraint already shaped the data plane (see §3) |
| Worker edge (parse wire, frame HTTP) → DO (run) | Service Worker `fetch` handler → Worker (run) | `makeRouter` is already `Request → Response` (`src/router.ts:89`), i.e. the exact `FetchEvent.respondWith` contract |
| `idFromName` → a distinct DO per graph | a coordinator spawns a distinct Worker per graph id, on first access | mirrors `CloudflareGraphManager.getByName(id)` → distinct DO (`cloudflare-graph-manager.ts:96`), not `BunGraphManager`'s single-process `Map` |
| R2 bucket binding backing `io()` | OPFS directory via async File System Access API | `IoStore` is *already async* (`src/iostore.ts:42`); async OPFS slots straight in |
| 10 GB DO storage ceiling | Origin storage quota (OPFS) | Same "big store, small isolate" pressure the streaming `IoStore` was built for |

The payoff of the top rows is worth stating plainly: **the browser analog of a Durable Object is one
dedicated Worker *per graph*, in that graph's elected "leader" tab** — every other tab routes its
queries for that graph to its leader Worker. A `SharedWorker` is *not* the DO (it cannot open an OPFS
`SyncAccessHandle` — that method is spec-restricted to a dedicated Worker); its only role is brokering
messages between tabs. Web Locks elects each graph's leader independently and migrates it
automatically when that tab closes — the DO's one-instance-per-name guarantee, synthesized per graph,
so different graphs run concurrently (and may even be led by different tabs). The mechanism is a
small, proven pattern (rhashimoto's `SharedService`); the full topology is §7.

---

## 2. The three seams and their browser twins

The port is three new leaf implementations of interfaces that already exist. Nothing above them
changes.

### 2.1 `Sql` → a WASM SQLite driver (new leaf)

`Sql` is `exec(sql)` + `query(sql, binds) → T[]`, **synchronous** (`src/api.ts:20`,
`src/storage.ts:154`). Today it has two implementations: `BunSqlite` (`bun:sqlite`) and
`DurableObjectSqlite` (`ctx.storage.sql`). A third — `WasmSqlite` — wraps the official
[`@sqlite.org/sqlite-wasm`] OO1 API. Inside a Worker with the OPFS VFS, that API is synchronous
(`db.exec(...)` returns rows), so it satisfies the `Sql` contract with no impedance mismatch:

```
class WasmSqlite implements Sql {
  exec(sql) { this.db.exec(sql); }
  query(sql, binds) { return this.db.exec({ sql, bind: binds, returnValue: 'resultRows', rowMode: 'object' }); }
}
```

The bind-coercion seam (`GraphStore.query` → `coerceBindValue`, `src/storage.ts:161`) already
normalizes `boolean`/`bigint`/big-decimal so the DO's stricter `SqlStorageValue` accepts them. WASM
SQLite is more permissive than the DO but stricter than Bun; running the existing coercion is safe
and keeps one behavior across all three runtimes.

**VFS — `opfs-sahpool`, locked.** It pre-opens a pool of sync access handles, is the fastest OPFS
option, and requires **no COOP/COEP** — at the cost of a single connection (one dedicated Worker owns
the DB at a time). That single-connection constraint *is* the leader model (§7), which is the faithful
DO analog (one instance per graph), so it is a feature here, not a limitation. `createSyncAccessHandle`
is spec-restricted to a **dedicated** Worker, so the DB cannot live in a SharedWorker regardless. The
multi-connection VFSes are a documented fallback only (§8·1), not the default.

**Build — the *standard* `@sqlite.org/sqlite-wasm`, not the `SQLITE_WASM_BARE_BONES` variant.**
Verified against `ext/wasm/api/sqlite3-wasm.c`: the standard build defines `SQLITE_ENABLE_FTS5` and
enables JSON (so JSONB), both of which our schema requires — `property_fts` is an FTS5 **trigram**
index (`tinker.search` + `TextP` substring predicates) and collection values are stored as JSONB.
Bare-bones omits both (`SQLITE_OMIT_FTS5` / `SQLITE_OMIT_JSON`), so it is not an option. No custom
build is needed as long as we take the standard artifact.

### 2.2 `IoStore` → OPFS documents (new leaf)

`IoStore` (`src/iostore.ts:37`) hides where whole-graph documents live for `io()` import/export. It
is **already async and already streaming** (`readStream`/`writeStream` return Promises; the write
side is a chunk sink). It has two leaves today: `FileIoStore` (Bun, `node:fs` streams,
`src/bun/FileIoStore.ts`) and `R2IoStore` (R2 multipart). A third — `OpfsIoStore` — uses the async
File System Access API:
- read → `dirHandle.getFileHandle(path)` → `file.stream()` (a real `ReadableStream`, page-at-a-time).
- write → `fileHandle.createWritable()` → a `FileSystemWritableFileStream` the sink drains into;
  `close()` commits, `abort()` discards — exactly the `IoSink` contract (`src/iostore.ts:30`), and
  exactly R2 multipart's commit-on-close shape.

The "peak memory is one page, never the 10 GB document" invariant (`src/iostore.ts:8`) holds
because OPFS streams both ways. No buffering, no materialization, **no JSPI** — this seam was async
from birth.

### 2.3 `GraphManager` → the multi-graph owner + the postMessage edge

`GraphManager` (`src/manager.ts`) is lifecycle (create/info/destroy) **and** the executor factory /
federation source. Two browser-side pieces:

1. **Inside each per-graph Worker:** a single-graph `GraphStore` over `WasmSqlite` on *that* graph's
   `opfs-sahpool` pool, plus its executor — the DO's own in-process runner (the analog of
   `graph-store-do.ts`'s `executor()`). One Worker, one graph — not a `Map` of graphs.

2. **The coordinator (the browser `GraphManager`):** mirrors `CloudflareGraphManager`
   (`src/cloudflare/cloudflare-graph-manager.ts:87`), *not* `BunGraphManager`. It maps a graph id to
   that graph's **leader Worker** — spawning the Worker on first access if this tab holds the graph's
   Web Lock, otherwise routing to whichever tab does — and proxies over the `SharedService` channel
   (§7). `executor(id)` returns a `RemoteExecutor` whose `framedAsync` posts
   `{gremlin, params, paramTypes}` and awaits `Framed[]`; the direct analog of `GraphDatabase.framed`
   (`src/cloudflare/graph-store-do.ts:74`). Cross-graph `federate` routes Worker-to-Worker through
   this coordinator — the browser twin of Cloudflare's cross-DO `runForeign` RPC, which already exists.

Note what maps and what you get to **drop**: the CF *structural* edge/store split maps directly — the
**Service Worker is the edge** (`makeRouter` + the coordinator `GraphManager`, §7), and **each
per-graph Worker is the store** (executor), exactly as CF's edge Worker fronts its DOs. What you drop
is the edge-*compilation* optimization: CF compiles at the cheap edge and ships a rendered
`Executable` to the DO (`runFramed`) *only* because it bills edge and DO separately. In the browser
there's no billing boundary, so each per-graph Worker simply compiles + runs its own queries — the
`framed(gremlin)` string path (`graph-store-do.ts:74`) is all v1 needs; `runFramed`/`readHead` are a
pure optimization you can skip.

---

## 3. The data plane is *already* structured-clone-safe — the biggest de-risking fact

The hardest part of any "run it across a thread boundary" port is usually making the values cross.
Here it is already done and already tested, because **a workerd DO RPC structured-clones its
arguments and results** — the same algorithm `postMessage` uses. The project already hit and solved
this wall: a recursive `step` closure and `unique symbol` node brands did not survive the clone, so
`Program` ships **rendered** (`renderProgram` at the edge, `runSteps` at the DO), and `Compiled` was
always plain data. The RPC payload set is deliberately closed to clone-safe shapes: `Framed[]`
(byte buffers — clone *and* transfer), `ForeignResult`, `BarrierInput[]`, `Compiled`, `Executable`
(`src/cloudflare/rpc.ts:25`, `src/cloudflare/graph-store-do.ts`).

**Consequence for the browser:** the exact payloads that already cross the DO boundary cross the
Worker boundary unchanged. `Framed[]` is `Uint8Array`/`Buffer` chunks — you can *transfer* them
(zero-copy) rather than clone. And the error-as-value discipline (`rpcTry`/`rpcUnwrap`,
`src/cloudflare/rpc.ts:42`) that keeps a user's bad traversal from reading as a DO crash is directly
reusable to keep it from reading as an unhandled Worker error. The whole "make the boundary behave"
problem was paid for by Cloudflare and is inherited for free.

The only real test caveat carries over verbatim: **a green run in the main thread is not proof the
Worker boundary is clean** — just as green Bun CI does not prove the DO boundary
(`test/cloudflare.test.ts` on real workerd is what catches clone regressions). The browser needs an
equivalent: an actual Worker round-trip test. That is the browser twin of the workerd RPC test, and
it should exist before anything ships.

---

## 4. The sync/async boundary claim — validated precisely

The user's claim was: *"I think we've already got all the right sync/async boundaries."* This holds,
and here is the exact ledger — it is the crux of the whole feasibility:

| Layer | Shape today | Browser reality | Match? |
|---|---|---|---|
| `Sql.exec`/`query` | **sync** (`src/storage.ts:154`) | OPFS `SyncAccessHandle` in a Worker is **sync** | ✅ exact |
| compile (`compilePlan`) | **sync**, pure, no store (`cloudflare-graph-manager.ts:31`) | pure JS/WASM, no I/O | ✅ |
| `executor(id).framedAsync` | **async** at the manager seam | `postMessage` boundary is **async** | ✅ exact |
| `IoStore.readStream`/`writeStream` | **async** (`src/iostore.ts:42`) | async File System Access API | ✅ exact |
| `io()` service | a **single await barrier** at the executor's one suspension point | one async hop, isolated | ✅ |
| RPC payloads | **structured-clone-safe** (§3) | `postMessage` structured clone | ✅ exact |

The seam sits *at the SQL transport* precisely because "both runtimes are synchronous SQLite and
differ only in cursor mechanics" (`src/storage.ts:3`). The browser is a *third* synchronous SQLite.
Everything async in the system is above the Worker boundary, in JS, at seams that are *already*
async. There is no place where synchronous code must await something that only the browser makes
async. That is the property that makes JSPI unnecessary.

---

## 5. JSPI — not needed here, and exactly when it *would* be

JSPI (JavaScript Promise Integration) bridges **synchronous WASM code that must call an asynchronous
JS import** — it suspends the WASM stack across a JS `await`. You need it only when SQLite's *VFS
callbacks* (read/write a page) have to await.

On the recommended path they do not: the OPFS `SyncAccessHandle` read/write/getSize/flush methods
are **synchronous** (the spec moved them off Promises), so SQLite-WASM's VFS calls them
synchronously inside the Worker. No async import under WASM → no JSPI. The user's instinct is
correct.

JSPI (or the older SharedArrayBuffer + `Atomics.wait` proxy, which drags in COOP/COEP) would only
matter if SQLite were backed by *async* storage. The locked design isn't: `opfs-sahpool` is
synchronous inside the leader's dedicated Worker (§7), so nothing under WASM ever awaits — and even
the multi-connection fallback (§8·1) stays synchronous (`OPFSCoopSyncVFS` keeps its methods sync via
a return-error-then-retry wrapper). So JSPI is not needed on either path. **Do not reach for JSPI.**
Worth a one-hour browser spike to confirm current sync-handle support, but the design does not rest
on it.

---

## 6. `Buffer` — resolved

The platform coupling is genuinely a leaf. After the Bun-native cleanup (`process.env` → `Bun.env`;
`FileIoStore` on `Bun.file().exists()` + `Bun.Glob`), the only Node/Bun API surface left in
`src/bun/*` is `mkdir`/`rm` and `node:path` — directory and path ops Bun has **no** `Bun.*`
equivalent for (it implements `node:fs`/`node:path` natively, which *is* the idiomatic path), and
that whole leaf gets a browser twin (`WasmSqlite` / `OpfsIoStore`) rather than a port. Nothing
`bun:`/`node:` reaches the compiler / execute / wire / router core.

The one thing that touches the shared core is **`Buffer`** — a value the byte layer uses in exactly
four files (`execute.ts`, `serializers.ts`, `http.ts`, `router.ts`; LSP-measured, grep having counted
comments, `vendor/`, and `node_modules/` alike). The earlier "leak into
`compiler/rel/spine.ts`/`lower.ts`" was a false alarm — those are comments describing `execute.ts`'s
framers; the front-end/compiler boundary (decision #5) is intact and holds zero `Buffer` code.

**The resolution: treat `Buffer` as an ambient platform global, exactly like the core already treats
`Request`/`Response`/`ReadableStream`/`TextEncoder`.** The core does not import those Web globals; each
platform supplies them. `Buffer` is the same shape of thing — the one wrinkle being that it is *not* a
universal global (present in Bun, present in workerd under `nodejs_compat`, **absent in the browser**).
So the four core files reference the **bare global** and never import it; the platform provides it:

- **Bun** — global `Buffer` is always present. ✔ (full suite green)
- **Cloudflare** — `nodejs_compat` (already enabled, `wrangler.jsonc`) provides the global. **Verified**:
  with all four imports removed, the wrangler *build* of the CF bundle and the *real-workerd* runtime
  test (`test/cloudflare.test.ts`, 38 GraphBinary round-trips through the DO) both pass. This also
  avoids bundling a redundant polyfill *over* workerd's native `Buffer`.
- **Browser** — the one place the global is missing, so the **browser entry** (the root shared worker)
  supplies it, in *one* place: `import { Buffer } from 'buffer'; globalThis.Buffer = Buffer;`. That
  import triggers Bun's browser bundler to inject its own `buffer` polyfill automatically (measured: an
  imported `'buffer'` pulls a real ~52 KB polyfill; a bare global pulls nothing — the `buffer` npm
  package need not even be installed). There is **no `--inject`-style CLI flag** on `bun build` (only
  `--define`/`--banner`/`--external`/`--packages`), so the entry-file import is the idiomatic way to
  force it in — which also keeps the polyfill out of the Bun and Cloudflare builds, where it is not
  wanted.

So the core stays genuinely runtime-agnostic (it names `Buffer` the way it names `fetch`), and the
`buffer` polyfill is scoped to the browser build alone, provided at its single entry point — not
sprinkled through the shared layer. No `Uint8Array` rewrite and no upstreaming: the byte layer is
deliberately `Buffer`-shaped to interoperate with the `gremlin` client (decision #4), which is itself
built on the `buffer` API (its serializers *return* `Buffer` and use `writeInt32BE`/`readBigInt64BE`/…
that a plain `Uint8Array` lacks), so the browser build carries that polyfill regardless — automatic,
and negligible for an in-browser database.

Everything else — antlr4ng (pure JS), the generated parser (pure JS/TS), the compiler, `execute.ts`,
the Fetch-API router — is already browser-portable.

---

## 7. Topology — the leader Worker and the Service Worker edge

Two decisions settle the topology, both locked.

**Where the graph lives:** **one dedicated Worker per graph, in that graph's elected "leader" tab —
each Worker is a DO.** It runs a single-graph `GraphStore` + `WasmSqlite` over `opfs-sahpool` (§2.1),
each graph's pool in its own OPFS `directory` so per-graph pools never collide. It *cannot* be a
SharedWorker: `createSyncAccessHandle` is spec-restricted to a dedicated Worker. This is Cloudflare's
model exactly — `idFromName(graphId)` gives a distinct DO per graph; here the coordinator spawns a
distinct Worker per graph id on first access. **The payoff is real cross-graph concurrency:** graphs
A and B run on separate threads (and may be led by different tabs), while each graph stays
single-writer within itself — the same place Cloudflare gets its concurrency (many DOs), never within
one graph. Every other tab is a *client* that routes a graph's queries to that graph's leader and
gets `Framed[]` back.

**Multiple graphs never require multiple tabs.** A single tab hosts one Worker *per graph it opens*,
so one tab runs many graphs concurrently — a Worker each — exactly as one Cloudflare colo hosts many
DOs. Extra *tabs* matter only for *sharing one graph* across tabs; that is the only place per-graph
leadership and failover come into play. The common single-page case is one tab owning all its graphs'
Workers directly.

Cross-tab coordination is a proven ~200-line pattern — rhashimoto's **`SharedService`**:

- **Web Locks elects the leader per graph and watches its lifetime.** One lock per graph id; the
  first tab to hold graph X's lock hosts graph X's Worker, and on close *or crash* the lock releases
  and another tab takes over graph X and re-opens its pool (`opfs-sahpool` re-acquires its handles).
  Different graphs may have different leader tabs. This is the DO's one-instance-per-name guarantee,
  synthesized per graph — and the automatic failover is what makes it safe.
- **A Service Worker (or SharedWorker) brokers the `MessagePort`s** between tabs and the leader — used
  only as a message relay, never to hold OPFS.
- **Mid-migration correctness:** a write in flight when the leader migrates is re-sent to the new
  leader; an idempotent-retry / tx-dedup guard (rhashimoto's pattern) keeps it from double-applying.
  A detail to honor, not a blocker.

**The HTTP edge is a Service Worker — locked, and it is the whole point.** A **Service Worker
intercepts `fetch` for `/gremlin/*`** and forwards to the leader, returning its `Response`; since
`makeRouter` is already `Request → Response`, the SW is near pass-through. This is what carries the
project's thesis into the tab: **any client that speaks `fetch` just works, unmodified** — an
unmodified TinkerPop GLV, a bare `fetch()`, a third-party library, anything — with **no
monkey-patching of `fetch`** and no in-page shim to install. The SW is the seam; the client sees a
normal URL over a normal `fetch`, and never knows there is no network. And **one Service Worker does
double duty** — the `fetch` intercept *and* the `SharedService` `MessagePort` broker (rhashimoto's
`SharedService-sw` variant brokers ports through a Service Worker) — so the HTTP edge and the cross-tab
coordination are a single component.

**Library + VFS, locked:** the **official `@sqlite.org/sqlite-wasm`** build for the DB (canonical
SQLite, sync OO1 API fits the sync `Sql` seam) on **`opfs-sahpool`**, plus the **`SharedService`
*pattern*** for coordination (VFS/build-agnostic, ~200 lines). `wa-sqlite` is not adopted as a
library; its `OPFSCoopSyncVFS` is referenced only as the multi-connection fallback (§8·1).

---

## 8. Genuinely new problems the browser introduces

These have no Bun or Cloudflare analog and are where the real design attention goes:

1. **Multi-tab concurrency = single-writer election (resolved — §7).** A DO is single-writer by
   platform construction; in the browser we synthesize that with a **Web-Locks-elected leader Worker**
   (the `SharedService` pattern). This was the #1 design risk, and the spike closed it: the pattern is
   proven, ~200 lines, with automatic failover on tab close/crash. The one part still worth a *browser*
   test is that a hard-crashed leader releases its `opfs-sahpool` handles promptly enough for a clean
   takeover.
   **Fallback — multi-connection**, only if leader failover proves flaky in practice or a workload
   genuinely needs several tabs writing without a coordinator: it is not a free upgrade. It costs
   either COOP/COEP (the official `opfs` VFS needs `SharedArrayBuffer`) or a library swap to
   wa-sqlite's `OPFSCoopSyncVFS` (no COOP/COEP, but **high write-transaction overhead**), and buys
   little — even multi-connection VFSes serialize (*"no such thing as N concurrent readers"*). So it
   stays a fallback, not the default.

2. **COOP/COEP — avoided by the locked choice.** `opfs-sahpool` needs no cross-origin isolation, which
   matters because COOP/COEP breaks embedding third-party scripts/iframes. The headers would resurface
   only on the multi-connection fallback *if* it used the official `opfs` VFS (the wa-sqlite
   `OPFSCoopSyncVFS` fallback avoids them). On the primary path: **no COOP/COEP.**

3. **Storage durability / eviction.** OPFS is persistent and origin-scoped but evictable under
   pressure unless you call `navigator.storage.persist()`. Quota is generous (often a large fraction
   of disk) — the 10 GB DO ceiling analog. Request persistence explicitly; surface quota to the app.

4. **No process to restart the schema against.** The DO re-runs DDL on cold start / after
   `deleteAll()` (`ensureLive`, `graph-store-do.ts:51`); `GraphStore`'s ctor runs the idempotent
   schema (`storage.ts:150`) and sweeps orphaned barrier runs (`storage.ts:137`) — that
   hard-crash-recovery sweep is *more* relevant in the browser, where a tab can be killed mid-request
   with no `finally`. The existing sweep covers it; just confirm it fires on Worker (re)start.

---

## 9. What this unlocks (why it's worth doing)

This is not merely "same thing, new runtime." An in-browser mogwai is a **local-first, offline,
zero-backend graph database** that:

- speaks the **same Gremlin wire protocol**, runs the **same compiler**, and is reachable by an
  **unmodified TinkerPop GLV** via `fetch` — the project's thesis, with the server deleted;
- keeps data **on the device** (privacy, no egress) and works **offline**;
- is **zero-cost multitenant** in the most literal way — every user's browser tab is their own
  isolated "DO," with no per-tenant infrastructure at all.

It also lands squarely on the **agent-memory vision** (`docs/2026-07-17-agent-memory-vision.md`): a
graph memory that lives *in the agent's own client*, with no server round-trip, is a strong
local-first substrate for exactly that use case. The browser port and the agent-memory direction
reinforce each other.

---

## 10. Recommended validation path (spikes, in risk order)

Do the risky, cheap things first; each answers a yes/no that gates the rest.

1. **Concurrency owner — design resolved (§7); one browser test remains.** The leader model
   (`SharedService`: Web-Locks election + a dedicated-Worker DB) is locked. The test is the failover
   edge: kill the leader tab mid-write and confirm another tab takes over cleanly — the Web Lock
   releases, `opfs-sahpool` handles free, no corruption, and the in-flight write is dedup-safe.
2. **Sync SQLite over OPFS, no COOP/COEP (§2.1, §5).** Official `@sqlite.org/sqlite-wasm` with
   `opfs-sahpool` inside a dedicated Worker; run the existing schema DDL (`storage.ts` SCHEMA) and a
   handful of `query` round-trips through a `WasmSqlite` shim. Confirms the sync seam and settles JSPI.
3. **Worker-boundary clone test (§3).** Post a real query, get `Framed[]` back (transferred), frame a
   Response. This is the browser twin of `test/cloudflare.test.ts` — the thing green main-thread CI
   will *not* catch. Reuse `rpcTry`/`rpcUnwrap` verbatim.
4. **`Buffer` — resolved for Bun/CF, one line for the browser (§6).** The core uses the ambient
   global (verified: Bun + real-workerd both green with zero imports). The browser entry supplies it
   with `import { Buffer } from 'buffer'; globalThis.Buffer = Buffer;`, which triggers Bun's auto
   polyfill. The "compiler `Buffer` leak" was a false alarm (comments).
5. **`fetch` interception end-to-end (§7).** Register the Service Worker, `fetch('/gremlin/g')` from
   a page, reach the leader Worker (through the `SharedService` broker the same SW provides), get a
   GraphBinary response. This is the "unmodified client" proof — and exercises the SW's double duty.
6. **`IoStore` over OPFS (§2.2).** GraphSON export/import streaming through `OpfsIoStore`; confirm
   the two-pass adjacency load works page-at-a-time and peak memory stays bounded.

Only after 1–3 is the answer to "is this feasible?" fully de-risked; 4–6 turn it into a running
thing. Nothing in 1–3 requires touching the core — they are all leaf shims and topology — which is
the whole reason the estimate is "leaves, not a rewrite."

---

## 11. Testing the browser leaf

The browser-only paths (OPFS SQLite, the Service Worker edge, per-graph leader failover, `OpfsIoStore`)
can't run under `bun test` alone — they need a real browser. The harness mirrors the existing
`test/cloudflare.test.ts` pattern, which spawns `wrangler dev` and drives it over the wire:

- **`bun test` stays the single runner.** A test file `Bun.serve`s the built browser bundle on
  `http://localhost:PORT`, then drives a real browser with **Playwright as a *library*** — the
  `playwright` package's `chromium.launch()` / `page.goto()` / `page.evaluate()`, **not**
  `@playwright/test` — asserting with bun's own `expect`. Playwright is a browser *driver* here, not a
  second test runner, which honors the no-second-test-tool rule (CLAUDE.md).
- **localhost is a secure context**, so the Service Worker registers and OPFS is available over plain
  HTTP — no self-signed certs (verified: browsers treat `http://localhost` as trustworthy).
- **Contract reuse.** The same `graphContract` that drives Bun and Cloudflare drives the browser
  instance over `fetch`; because the Service Worker intercepts `/gremlin/*`, the contract needs no
  browser-specific variant — which is itself the proof of the unmodified-client thesis.
- **The browser-specific tests** are the remaining spikes turned into gates: the Worker
  structured-clone round-trip (§3, runnable in a bare Bun `Worker` even before Playwright), leader
  failover (kill a page mid-write; another takes over, §8·1), and OPFS streaming for `io()` (§2.2).
- **New CI lane.** This needs a Playwright-capable browser environment; it does not run in the current
  Bun-only `mise run ci`, so the browser suite is a separate lane (headless Chromium in CI), not folded
  into the existing gate.

**New dependencies this introduces** (all needing the usual explicit approval, CLAUDE.md): the
official **`@sqlite.org/sqlite-wasm`** (runtime, browser leaf only — kept out of the Bun/CF bundles by
per-target bundling) and **`playwright`** (dev, as a driver library). The `SharedService` coordination
is ~200 lines of Apache-2.0 code **ported** from wa-sqlite's demo, not an npm dependency on wa-sqlite.

---

## Appendix — the seam inventory (what changes, what doesn't)

| Interface | Bun leaf | Cloudflare leaf | **Browser leaf (new)** | Core above it |
|---|---|---|---|---|
| `Sql` (sync) | `BunSqlite` | `DurableObjectSqlite` | `WasmSqlite` (official `@sqlite.org/sqlite-wasm`, `opfs-sahpool`) | `GraphStore`, whole compiler — **unchanged** |
| `IoStore` (async, streaming) | `FileIoStore` | `R2IoStore` | `OpfsIoStore` | `io()` service, formats — **unchanged** |
| `GraphManager` (lifecycle + executor factory) | `BunGraphManager` (`Map` of graphs) | `CloudflareGraphManager` (id → DO) | `WasmGraphManager` — coordinator, id → per-graph leader Worker over `SharedService` (mirrors the CF one) | `makeRouter` — **unchanged** |
| entry point | `bun/server.ts` | `cloudflare/worker.ts` | a **Service Worker** (`makeRouter` + coordinator + `fetch` intercept + `SharedService` broker) fronting **one dedicated Worker per graph** (store + executor) | `application()` DI — **unchanged** |
| `Buffer` (ambient global) | Bun global | workerd `nodejs_compat` global | browser **entry** does `import { Buffer } from 'buffer'; globalThis.Buffer = Buffer` | wire/execute/http use the bare global — **unchanged** |

Everything in the rightmost "unchanged" column is the reason this is a feasibility *yes*.
