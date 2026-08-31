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
import { newMessagePortRpcSession, type RpcStub } from 'capnweb';
import { makeRouter } from '../router.ts';
import type { GraphManager } from '../manager.ts';
import { BrowserGraphManager, type GraphStubSource } from './BrowserGraphManager.ts';
import type { GraphWorkerHost } from './GraphWorkerHost.ts';
import type { WorkerFactory } from './worker-factory.ts';
import type { BootstrapMessage } from './worker-spawn.ts';

// `self` is the ServiceWorkerGlobalScope (the WebWorker-lib type); the ambient `self` cannot be that
// specific under a shared lib set, so cast once here.
const scope = self as unknown as ServiceWorkerGlobalScope;

// Activate immediately and take control of open pages, so a freshly-registered Service Worker serves the
// very page that registered it without a reload (the test lane, and a first visit, both depend on this).
scope.addEventListener('install', () => scope.skipWaiting());
scope.addEventListener('activate', (event) => event.waitUntil(scope.clients.claim()));

// ── Control plane: the capnweb session to the WorkerFactory page ────────────────────────────────────
// The factory opens it (a `mogwai-control-port` Bootstrap); the SW may also solicit one after a cold
// start (`mogwai-need-control`). A single factory stub for now — cross-tab leadership routes per-graph.
let factory: RpcStub<WorkerFactory> | undefined;
let factoryWaiters: (() => void)[] = [];

/** Await the WorkerFactory stub, soliciting a control session if none is live. Bounded: past the deadline
 *  it rejects so a missing factory page reads as a 503, never an unbounded hang. */
async function ensureFactory(timeoutMs = 10_000): Promise<RpcStub<WorkerFactory>> {
  if (factory) return factory;
  const clients = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clients) c.postMessage({ kind: 'mogwai-need-control' } satisfies BootstrapMessage);
  await new Promise<void>((resolve, reject) => {
    factoryWaiters.push(resolve);
    setTimeout(() => reject(new Error('no mogwai WorkerFactory page is open to host this graph')), timeoutMs);
  });
  return factory!;
}

// Per-graph port bootstraps that have not yet been paired with their `openGraph` caller.
const pendingPorts = new Map<string, (port: MessagePort) => void>();

scope.addEventListener('message', (event) => {
  const data = event.data as BootstrapMessage | undefined;
  if (data?.kind === 'mogwai-control-port') {
    factory = newMessagePortRpcSession<WorkerFactory>(data.port);
    for (const w of factoryWaiters) w();
    factoryWaiters = [];
  } else if (data?.kind === 'mogwai-graph-port') {
    pendingPorts.get(data.graphId)?.(data.port);
    pendingPorts.delete(data.graphId);
  }
});

// ── The SW-side GraphStubSource: ask the factory for a graph, pair the arriving port into a direct stub.
const source: GraphStubSource = {
  async open(id) {
    const f = await ensureFactory();
    const portArrives = new Promise<MessagePort>((res) => pendingPorts.set(id, res));
    await f.openGraph(id); // factory spawns/reuses the Worker and posts us a `mogwai-graph-port`
    return newMessagePortRpcSession<GraphWorkerHost>(await portArrives);
  },
  async destroy(id) {
    pendingPorts.delete(id);
    await (await ensureFactory()).destroyGraph(id);
  },
};

const manager: GraphManager = new BrowserGraphManager(source);
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
