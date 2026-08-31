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
| One DO = one isolated graph, single-threaded | One **Worker** owning one (or N) SQLite-WASM database(s) | Single-threaded run-to-completion context; no shared-memory races inside it |
| `ctx.storage.sql` — **synchronous** SQLite | SQLite-WASM over **OPFS `SyncAccessHandle`** (sync, inside a Worker) | Both are synchronous SQLite; the `Sql` seam is already sync *because of the DO* (`src/storage.ts:1`) |
| DO RPC — **structured-clone** args/results | Worker `postMessage` — **structured-clone** | Same serialization algorithm; the same constraint already shaped the data plane (see §3) |
| Worker edge (parse wire, frame HTTP) → DO (run) | Service Worker `fetch` handler → Worker (run) | `makeRouter` is already `Request → Response` (`src/router.ts:89`), i.e. the exact `FetchEvent.respondWith` contract |
| `idFromName` provisions a DO on first access | `WasmGraphManager` opens an OPFS db on first access | `BunGraphManager` already does exactly this with a `Map<id, store>` (`src/bun/BunGraphManager.ts:63`) |
| R2 bucket binding backing `io()` | OPFS directory via async File System Access API | `IoStore` is *already async* (`src/iostore.ts:42`); async OPFS slots straight in |
| 10 GB DO storage ceiling | Origin storage quota (OPFS) | Same "big store, small isolate" pressure the streaming `IoStore` was built for |

The payoff of that last row is worth stating plainly: **the closest browser analog to a Durable
Object is a `SharedWorker`** — one instance shared across every same-origin tab, single-threaded,
owning the storage. Tabs are the "clients." That is the DO's isolation and lifetime model, in the
browser, for free. (Caveat and the dedicated-Worker fallback: §7.)

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

**One thing to decide:** which OPFS VFS.
- `opfs-sahpool` (SAH Pool) — pre-opens a pool of sync access handles, **no COOP/COEP headers
  required**, fastest, but single-connection (one Worker owns the file). Best default (see §7, §8).
- Default `OpfsDb` VFS — also uses `SyncAccessHandle`, supports the standard file model. Also no
  COOP/COEP on the modern sync-handle path.
- The legacy SharedArrayBuffer async proxy — **requires COOP/COEP** cross-origin isolation. Avoid
  unless forced (see §5, §8).

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

1. **Inside the Worker:** `WasmGraphManager`, a near-verbatim copy of `BunGraphManager` — a
   `Map<id, GraphStore>` over OPFS-backed `WasmSqlite` handles, create-on-demand
   (`src/bun/BunGraphManager.ts:63`). One Worker can own N graphs, exactly as one Bun process does.
   (Or one Worker per graph for stronger DO-style isolation — a topology choice, §7, not a code
   difference at this seam.)

2. **Across the thread boundary:** a `PostMessageGraphManager` that mirrors
   `CloudflareGraphManager` (`src/cloudflare/cloudflare-graph-manager.ts:87`). Where the CF manager
   proxies to a DO via `ns.getByName(id)` + RPC, this one proxies to the Worker via `postMessage`
   with a request id and a `MessageChannel` (or a promise-keyed correlation map). `executor(id)`
   returns a `RemoteExecutor` whose `framedAsync` posts `{gremlin, params, paramTypes}` and awaits
   `Framed[]` back. This is the direct analog of `GraphDatabase.framed`
   (`src/cloudflare/graph-store-do.ts:74`).

Note what you get to **drop**: the CF edge/DO split exists because Cloudflare bills a cheap stateless
edge separately from a stateful DO, so compiling at the edge and shipping a rendered `Executable`
(`runFramed`) is a real optimization. In the browser there is no such billing boundary and no
network hop — the edge and the store are the same machine. **Run the whole `makeRouter` + manager +
store in the one Worker.** The `framed(gremlin)` string path is all you need for v1; edge-compilation
(`runFramed`/`readHead`) is a pure optimization you can skip.

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

JSPI (or the older SharedArrayBuffer + `Atomics.wait` proxy, which drags in the COOP/COEP
requirement) becomes relevant **only if you deliberately back SQLite with async storage** — e.g.
async OPFS without sync handles, or IndexedDB — which you would consider only to work around the
multi-tab single-writer limitation (§8). So JSPI is a *contingency of a storage decision*, not a
baseline dependency. Recommendation: **do not reach for JSPI**; if multi-tab write concurrency
forces async storage, prefer leader-election (§8) over an async VFS, and keep the whole stack
synchronous. Worth a one-hour spike to confirm current browser sync-handle support, but the design
does not rest on JSPI.

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

## 7. Topology — Service Worker vs dedicated Worker vs SharedWorker

Three viable shapes. The choice turns on one question: **do you want unmodified `fetch('/gremlin/g')`
to reach the in-browser database?** That property — an unmodified TinkerPop GLV talking HTTP to a
database with no server — is the project's entire thesis, extended to the tab.

**Recommended: SharedWorker (the DO) + optional Service Worker (the HTTP edge).**

- A **`SharedWorker`** is the tightest DO analog: one instance per origin, shared across all tabs,
  single-threaded, owning the SQLite-WASM-over-OPFS store. It runs `makeRouter` + `WasmGraphManager`
  + `WasmSqlite`. This is where the graph lives, once, for the whole origin — exactly a DO's
  one-instance-per-name model.
- A **Service Worker** intercepts `fetch` for `/gremlin/*` and forwards to the SharedWorker,
  returning its `Response`. Because `makeRouter` is already `Request → Response`, the Service Worker
  is almost pass-through. This is what preserves the unmodified-client property: a GLV does
  `fetch('/gremlin/g')` and never knows there is no network.

Two real browser constraints shape this and must be respected:

- **A Service Worker cannot spawn nested dedicated Workers**, and its lifecycle is
  terminate-when-idle — so you must *not* run SQLite inside the Service Worker itself (OPFS handles
  would thrash on every SW restart). The SW is a thin forwarder; the SharedWorker holds the store.
  The SharedWorker is created by the page (or handed to the SW as a `MessagePort` the page transfers),
  because the SW can't create it.
- **`SharedWorker` support:** Chrome/Firefox yes; Safari dropped it and restored it in Safari 16
  (2022). If the target matrix includes older Safari, the fallback is a **dedicated Worker elected as
  the single owner via the Web Locks API** (`navigator.locks` — one tab holds the lock and owns the
  store; others proxy to it over `BroadcastChannel`). Slightly more plumbing, same single-owner
  guarantee. The spike should confirm the current support matrix rather than trust this paragraph.

**Simplest shape, if you don't need `fetch()` interception:** skip the Service Worker entirely. The
in-page client talks to the (Shared)Worker through a thin `fetch`-shaped shim — a function that
takes a Request-like and returns a Response-like over `postMessage`. You lose the "literal fetch"
magic but the whole app collapses to *page + one Worker*. Good for an embedded/library use where the
consumer is your own code, not an unmodified GLV.

---

## 8. Genuinely new problems the browser introduces

These have no Bun or Cloudflare analog and are where the real design attention goes:

1. **Multi-tab concurrency = single-writer election.** A DO is single-writer by platform
   construction. In the browser, N tabs of one origin share OPFS, and the SAH-Pool VFS is
   single-connection (one Worker may hold the file). The SharedWorker/Web-Locks topology (§7) *is* the
   answer: elect exactly one owner of the store; all tabs route through it. Get this right and you
   never touch async storage or JSPI. Get it wrong (two Workers both opening the OPFS db) and you get
   corruption or lock errors. **This is the #1 design risk of the whole port** — not the SQLite, not
   the Buffer, but the concurrency-owner election. It deserves the first spike.

2. **COOP/COEP cross-origin isolation.** Only the legacy SharedArrayBuffer OPFS proxy needs it;
   the SAH / sync-handle path does **not**. Choosing `opfs-sahpool` (§2.1) buys you out of the header
   requirement entirely, which matters because COOP/COEP breaks embedding third-party scripts/iframes
   and is a deployment headache. Decide this on day one: **sync-handle VFS, no COOP/COEP.**

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

1. **Concurrency owner (highest risk, §8·1).** SharedWorker (or Web-Locks-elected dedicated Worker)
   owning one OPFS SQLite db, two tabs writing. Prove single-writer holds and no corruption. If
   SharedWorker's support matrix disqualifies it, prove the Web-Locks fallback here.
2. **Sync SQLite over OPFS, no COOP/COEP (§2.1, §5).** `@sqlite.org/sqlite-wasm` with `opfs-sahpool`
   inside a Worker; run the existing schema DDL (`storage.ts` SCHEMA) and a handful of `query`
   round-trips through a `WasmSqlite` shim. Confirms the sync seam and kills the JSPI question.
3. **Worker-boundary clone test (§3).** Post a real query, get `Framed[]` back (transferred), frame a
   Response. This is the browser twin of `test/cloudflare.test.ts` — the thing green main-thread CI
   will *not* catch. Reuse `rpcTry`/`rpcUnwrap` verbatim.
4. **`Buffer` — resolved for Bun/CF, one line for the browser (§6).** The core uses the ambient
   global (verified: Bun + real-workerd both green with zero imports). The browser entry supplies it
   with `import { Buffer } from 'buffer'; globalThis.Buffer = Buffer;`, which triggers Bun's auto
   polyfill. The "compiler `Buffer` leak" was a false alarm (comments).
5. **`fetch` interception end-to-end (§7).** Register the Service Worker, `fetch('/gremlin/g')` from
   a page, hit the SharedWorker, get a GraphBinary response. This is the "unmodified client" proof.
6. **`IoStore` over OPFS (§2.2).** GraphSON export/import streaming through `OpfsIoStore`; confirm
   the two-pass adjacency load works page-at-a-time and peak memory stays bounded.

Only after 1–3 is the answer to "is this feasible?" fully de-risked; 4–6 turn it into a running
thing. Nothing in 1–3 requires touching the core — they are all leaf shims and topology — which is
the whole reason the estimate is "leaves, not a rewrite."

---

## Appendix — the seam inventory (what changes, what doesn't)

| Interface | Bun leaf | Cloudflare leaf | **Browser leaf (new)** | Core above it |
|---|---|---|---|---|
| `Sql` (sync) | `BunSqlite` | `DurableObjectSqlite` | `WasmSqlite` (OPFS SAH) | `GraphStore`, whole compiler — **unchanged** |
| `IoStore` (async, streaming) | `FileIoStore` | `R2IoStore` | `OpfsIoStore` | `io()` service, formats — **unchanged** |
| `GraphManager` (lifecycle + executor factory) | `BunGraphManager` | `CloudflareGraphManager` | `WasmGraphManager` + `PostMessageGraphManager` | `makeRouter` — **unchanged** |
| entry point | `bun/server.ts` | `cloudflare/worker.ts` | `sharedworker.ts` + optional `sw.ts` | `application()` DI — **unchanged** |
| `Buffer` (ambient global) | Bun global | workerd `nodejs_compat` global | browser **entry** does `import { Buffer } from 'buffer'; globalThis.Buffer = Buffer` | wire/execute/http use the bare global — **unchanged** |

Everything in the rightmost "unchanged" column is the reason this is a feasibility *yes*.
