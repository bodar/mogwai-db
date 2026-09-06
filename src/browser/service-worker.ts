// The Service Worker HTTP EDGE — the browser's front door, and the whole point of the port: it intercepts
// `fetch('/gremlin/*')` (and `/graphql/*`, and the bare `/gremlin`) so ANY client that speaks fetch — the
// unmodified TinkerPop GLV included — reaches the local graph with no monkey-patching.
//
// The SW IS the edge: it runs `makeRouter` and holds a DIRECT capnweb stub to each graph's dedicated
// Worker (one data-plane hop, SW → Worker). It cannot spawn a dedicated Worker itself (opfs-sahpool needs
// one, and `Worker` is undefined in a ServiceWorkerGlobalScope), so a page-hosted `WorkerFactory`
// (worker-factory.ts) spawns/owns the Workers and hands the SW a direct port per graph. Everything with
// meaning is a typed capnweb call — the data plane (`GraphWorkerHost` stubs) and the control plane (the
// `WorkerFactory` stub). The only native messages are the `Bootstrap` port hand-offs capnweb cannot carry.
import './buffer-global.ts'; // MUST be first — installs Buffer before the wire (http.ts/io.ts) inits
import { makeRouter } from '../router.ts';
import { VERSION } from '../version.ts';
import type { GraphManager } from '../manager.ts';
import { BrowserGraphManager } from './BrowserGraphManager.ts';
import { FactoryStubSource } from './factory-stub-source.ts';
import { StubReplicatorRegistry } from './StubReplicatorRegistry.ts';
import { runDueReplications } from '../scheduler.ts';
import { peerForRef, validateReplicationFilter } from '../replicate.ts';
import { allowlistedHttp } from '../http-allowlist.ts';
import type { Http } from '../api.ts';
import type { BootstrapMessage } from './worker-spawn.ts';
import { BROWSER_SCALAR_URL, BROWSER_BOOT_SCRIPT } from './docs-page.ts';

// `self` is the ServiceWorkerGlobalScope (the WebWorker-lib type); the ambient `self` cannot be that
// specific under a shared lib set, so cast once here.
const scope = self as unknown as ServiceWorkerGlobalScope;

// Activate immediately and take control of open pages, so a freshly-registered Service Worker serves the
// very page that registered it without a reload (the test lane, and a first visit, both depend on this).
scope.addEventListener('install', () => scope.skipWaiting());
scope.addEventListener('activate', (event) => event.waitUntil(scope.clients.claim()));

// The SW-side source owns the control sessions to the WorkerFactory pages, the per-graph direct stubs,
// and the cross-tab failover (dispose-the-dead-stub-on-new-port). The manager engine runs makeRouter over
// it, retrying once when a stub is swapped by failover.
const source = new FactoryStubSource(scope);
const manager: GraphManager = new BrowserGraphManager(source);
// The control plane (§9): the singleton registry lives in its own dedicated Worker (persistent OPFS), reached
// by a direct capnweb stub, so `/_replicator` CRUD survives a tab/SW restart. The scheduler runs at THIS
// edge (the SW) as a client of the graph Workers — never inside one — driven by `POST /_scheduler/run` (an
// elected tab ticks it on a timer, or an admin fires it once).
const registry = new StubReplicatorRegistry(source);
// The scheduler's outbound http (its remote peers) is the SW's global `fetch`, ALLOWLISTED from the config a
// factory page sends (`mogwai-config`) — empty ⇒ deny-all (fail closed), exactly as Bun/CF. Read at call
// time from a mutable allowlist, so a config arriving after SW start (or updated) takes effect without a
// rebuild. A local→local job needs no http (localPeer), so it works even before any config arrives.
let schedulerAllowlist: string[] = [];
// Same browser-only same-origin trust as the graph Worker (src/http-allowlist.ts `trustedOrigin`): the
// SW's OWN origin is permitted without an allowlist entry, so a same-origin replication peer works out of
// the box, uniformly with same-origin io()/federate — the user's browser reaching its own site is not an
// SSRF vector. Every other origin still goes through the (mutable) allowlist.
const schedulerHttp: Http = (req) => allowlistedHttp(schedulerAllowlist, undefined, { trustedOrigin: scope.location?.origin })(req);
const runTick = () => runDueReplications({ registry, manager, http: schedulerHttp });
// Save-time filter validation (filtered-replication-plan §2): trial-run against the source peer — a local
// source routes to its graph Worker (via the manager), a remote one through the SW's allowlisted http.
const validateFilter = (source: string, filter: string) => validateReplicationFilter(peerForRef(manager, schedulerHttp, source), filter);
// Two browser-only docs args (from docs-page.ts, the ONE place they live so this SW-served `/docs` and the
// static index.html cannot drift), both relative to the served page and both plain static assets the SW does
// NOT intercept (so neither bloats this worker bundle):
//   - `BROWSER_SCALAR_URL` (`./scalar.js`)   — the vendored Scalar UI, so the docs are self-contained (no CDN).
//   - `BROWSER_BOOT_SCRIPT` (`./mogwai-db.js`) — boots THIS page's WorkerFactory: the browser build serves the
//     docs shell as BOTH `/` and `/docs`, so it is the tab the user is on and must host the graph data plane
//     (else queries have no Worker).
//   - `VERSION` — the build-stamped version for the OpenAPI `info.version` (scripts/package.ts defines it).
//   - `docsBaseUrl` — the LAZY thunk below: the OpenAPI `servers[0].url` must be the sub-path base
//     (`/mogwai-db/`), which the SW STRIPS before routing, so the request can't reveal it. Passed as a
//     thunk because the SW cannot read its registration scope at construction (before it installs).
const router = makeRouter(manager, undefined, undefined, registry, runTick, validateFilter, BROWSER_SCALAR_URL, BROWSER_BOOT_SCRIPT, VERSION, docsBaseUrl);

scope.addEventListener('message', (event) => {
  const data = (event as ExtendableMessageEvent).data as BootstrapMessage | undefined;
  if (data?.kind === 'mogwai-config') schedulerAllowlist = data.config.httpAllowlist ?? [];
});

// The path this SW is registered under: `/` at a root deploy, `/mogwai-db/` on a GitHub Pages project
// site (or any sub-path host). Everything the router matches is rooted at `/`, so we STRIP this base
// before routing — which is what lets the SAME build serve the API and docs from any sub-path, with the
// bundle's `import.meta.url` sibling resolution already handling the script loads. Read LAZILY from the
// registration scope (computing it at module top-level risks throwing before the SW installs).
let base: string | undefined;
function scopeBase(): string {
  return (base ??= new URL(scope.registration.scope).pathname);
}

// The absolute base for the OpenAPI `servers[0].url` — the SW's full registration scope with the trailing
// slash trimmed (`https://owner.github.io/mogwai-db/` → `…/mogwai-db`; a root deploy `…/` → the bare
// origin), so the spec's `/gremlin/{graphId}` paths compose against it. Read LAZILY (like scopeBase) — the
// router calls this only when serving /openapi.json, by when the SW is active and the scope is readable.
function docsBaseUrl(): string {
  return new URL(scope.registration.scope).href.replace(/\/+$/, '');
}

scope.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const BASE = scopeBase();
  // Re-root the request against the SW's base so `/mogwai-db/gremlin/x` matches the router's `^/gremlin/`.
  const path = url.pathname.startsWith(BASE) ? '/' + url.pathname.slice(BASE.length) : url.pathname;
  if (!isRoutedPath(path)) return; // not ours — fall through to the network (the static index, assets, wasm)
  // Hand the router a base-stripped request. Rebuild it only when the base changed the path — and rebuild
  // it FIELD BY FIELD, never `new Request(newUrl, event.request)`: a top-level navigation (the /docs page
  // load) is mode 'navigate', which the Request constructor cannot reproduce and THROWS on, so that form
  // silently drops navigations to the network (a 404 on a sub-path). makeRouter returns query FAILURES as
  // GraphBinary trailers; a 503 here is only for an infra fault (no factory page open), never a user error.
  const routed = path === url.pathname ? event.request : reRoot(event.request, new URL(path + url.search, url.origin));
  event.respondWith(
    router(routed).catch((e) => new Response(String(e?.message ?? e), { status: 503 })),
  );
});

/** Rebuild a request against a new (base-stripped) URL, copying only what the router needs and NOT the
 *  restricted `navigate` mode. GET/HEAD carry no body; other verbs stream their body through (`duplex`
 *  is required by Chromium when a request body is a stream). */
function reRoot(req: Request, url: URL): Request {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers: req.headers };
  if (hasBody) { init.body = req.body; init.duplex = 'half'; }
  return new Request(url, init);
}

/** The paths this SW answers (base already stripped). `/gremlin` (bare + `/gremlin/{id}`) is the Gremlin
 *  data + management plane; `/graphql/{id}` is the GraphQL edge; `/_replicator` + `/_scheduler` are the
 *  replication control plane (§9); `/docs` + `/openapi.json` are the self-describing API reference (the
 *  browser build's UI). NOT `/` — the app root serves the static index.html (which IS the docs shell,
 *  byte-identical to `/docs`), so it falls through to the static host. Everything else passes through
 *  untouched. */
function isRoutedPath(pathname: string): boolean {
  return pathname === '/gremlin' || pathname.startsWith('/gremlin/') || pathname.startsWith('/graphql/')
    || pathname === '/_replicator' || pathname.startsWith('/_replicator/')
    || pathname.startsWith('/_scheduler/')
    || pathname === '/docs' || pathname === '/openapi.json';
}
