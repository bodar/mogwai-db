// The Service Worker HTTP EDGE — the browser's front door, and the whole point of the port: it
// intercepts `fetch('/gremlin/*')` (and `/graphql/*`, and the bare `/gremlin`) so ANY client that
// speaks fetch — the unmodified TinkerPop GLV included — reaches the local graph with no monkey-patching.
//
// The Service Worker cannot host the store (it can spawn no dedicated Worker, and opfs-sahpool needs
// one), so it is a BROKER: it forwards an intercepted request to a controlled PAGE that hosts the
// manager + graph Workers (installMogwaiPageEdge, page-edge.ts), and streams the page's response back
// to the client. This mirrors the Cloudflare structural split — edge here, page-hosted Worker = store —
// with only the edge-compilation optimization dropped. A request/response crosses page↔edge as bytes over
// a per-request MessageChannel; the request/response bodies transfer zero-copy.
//
// `self` is the ServiceWorkerGlobalScope (the WebWorker-lib type); the ambient `self` cannot be that
// specific under a shared lib set, so cast once here.
const scope = self as unknown as ServiceWorkerGlobalScope;

// Activate immediately and take control of open pages, so a freshly-registered Service Worker serves the
// very page that registered it without a reload (the test lane, and a first visit, both depend on this).
scope.addEventListener('install', () => scope.skipWaiting());
scope.addEventListener('activate', (event) => event.waitUntil(scope.clients.claim()));

scope.addEventListener('fetch', (event) => {
  const { pathname } = new URL(event.request.url);
  if (!isGraphPath(pathname)) return; // not ours — fall through to the network (page, assets, wasm)
  event.respondWith(forwardToPage(event.request));
});

/** The paths the graph edge owns. `/gremlin` (bare + `/gremlin/{id}`) is the Gremlin data + management
 *  plane; `/graphql/{id}` is the GraphQL edge. Everything else passes through untouched. */
function isGraphPath(pathname: string): boolean {
  return pathname === '/gremlin' || pathname.startsWith('/gremlin/') || pathname.startsWith('/graphql/');
}

/** Forward one request to a page hosting the store, and turn its reply back into a Response. */
async function forwardToPage(request: Request): Promise<Response> {
  const client = (await scope.clients.matchAll({ type: 'window', includeUncontrolled: true }))[0];
  if (!client) {
    // No page is open to host the graph's Worker — a graph is only serveable while a hosting page lives.
    return new Response('no mogwai page is open to serve this graph', { status: 503 });
  }
  // Bodyless methods (GET/HEAD) carry no body; others ship their bytes to the page.
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.arrayBuffer() : null;
  const channel = new MessageChannel();
  const reply = new Promise<Response>((resolve) => {
    channel.port1.onmessage = (e) => {
      const r = e.data as PageEdgeResponse;
      resolve(new Response(r.body ?? null, { status: r.status, headers: r.headers }));
    };
  });
  const message: PageEdgeRequest = {
    type: 'mogwai-request',
    url: request.url,
    method: request.method,
    headers: [...request.headers],
    body,
  };
  const transfer: Transferable[] = [channel.port2];
  if (body) transfer.push(body);
  client.postMessage({ ...message, port: channel.port2 }, transfer);
  return reply;
}

/** The message a Service Worker forwards to a hosting page (see page-edge.ts). `port` (a transferred
 *  MessagePort) is added alongside these fields; the page replies on it with a {@link PageEdgeResponse}. */
export interface PageEdgeRequest {
  type: 'mogwai-request';
  url: string;
  method: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

/** The page's reply on the per-request port. */
export interface PageEdgeResponse {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer | null;
}
