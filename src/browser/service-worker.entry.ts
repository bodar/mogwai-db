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
import type { GraphManager } from '../manager.ts';
import { BrowserGraphManager } from './BrowserGraphManager.ts';
import { FactoryStubSource } from './factory-stub-source.ts';

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
const manager: GraphManager = new BrowserGraphManager(new FactoryStubSource(scope));
const router = makeRouter(manager);

scope.addEventListener('fetch', (event) => {
  const { pathname } = new URL(event.request.url);
  if (!isGraphPath(pathname)) return; // not ours — fall through to the network (page, assets, wasm)
  // makeRouter returns query FAILURES as GraphBinary trailers; a 503 here is only for an infra fault
  // (no factory page open), never a user query error.
  event.respondWith(
    router(event.request).catch((e) => new Response(String(e?.message ?? e), { status: 503 })),
  );
});

/** The paths the graph edge owns. `/gremlin` (bare + `/gremlin/{id}`) is the Gremlin data + management
 *  plane; `/graphql/{id}` is the GraphQL edge. Everything else passes through untouched. */
function isGraphPath(pathname: string): boolean {
  return pathname === '/gremlin' || pathname.startsWith('/gremlin/') || pathname.startsWith('/graphql/');
}
