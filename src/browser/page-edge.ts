// The PAGE side of the Service Worker edge. The SW (service-worker.entry.ts) intercepts a client's
// `fetch('/gremlin/*')` and forwards it here, to a page that hosts the coordinator + graph Workers; this
// runs the local `router` and replies on the per-request port. So the SW is a pure broker and the PAGE
// is the store host — the only split that respects "a Service Worker cannot spawn a dedicated Worker".
import type { PageEdgeRequest, PageEdgeResponse } from './service-worker.entry.ts';

/** The router the page serves — `makeRouter(coordinator)`, `Request → Promise<Response>`. */
export type EdgeRouter = (req: Request) => Promise<Response>;

/** Install the page-side edge: answer requests the Service Worker forwards by running `router` and
 *  replying on the request's port. Returns a disposer that removes the listener. Call once, after the SW
 *  controls the page (see {@link registerServiceWorker}). */
export function installMogwaiPageEdge(router: EdgeRouter): () => void {
  const onMessage = async (event: MessageEvent) => {
    const data = event.data as (PageEdgeRequest & { port?: MessagePort }) | undefined;
    if (data?.type !== 'mogwai-request') return;
    const port = data.port ?? event.ports[0];
    try {
      // GET/HEAD carry no body; others rebuild it from the forwarded bytes.
      const hasBody = data.method !== 'GET' && data.method !== 'HEAD';
      const request = new Request(data.url, { method: data.method, headers: data.headers, body: hasBody ? data.body : null });
      const res = await router(request);
      const body = await res.arrayBuffer();
      const reply: PageEdgeResponse = { status: res.status, headers: [...res.headers], body };
      port.postMessage(reply, [body]);
    } catch (e: any) {
      // Never leave the client hanging: an edge fault comes back as a 500 with the message.
      const body = new TextEncoder().encode(String(e?.message ?? e)).buffer as ArrayBuffer;
      port.postMessage({ status: 500, headers: [['content-type', 'text/plain']], body } satisfies PageEdgeResponse, [body]);
    }
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}

/** Register the Service Worker and resolve once it CONTROLS this page — so the first intercepted fetch
 *  is not raced by activation. In a fresh page the SW installs (skipWaiting) and claims (clients.claim),
 *  which sets `serviceWorker.controller` (firing `controllerchange`).
 *
 *  Race-free by construction: a naive `await ready; if (!controller) await once('controllerchange')`
 *  can MISS the event when it fires between `ready` resolving and the listener attaching — an infinite
 *  hang that surfaces only under CI timing. So this listens AND polls, re-checking `controller` on both,
 *  and is BOUNDED: past the deadline it resolves anyway, turning a would-be hang into a clear downstream
 *  failure (an un-intercepted fetch gets the page HTML, not GraphBinary) rather than a timeout with no
 *  diagnosis. */
export async function registerServiceWorker(url: string, controlTimeoutMs = 30_000): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(url, { type: 'module' });
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return reg;
  await new Promise<void>((resolve) => {
    const done = () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      clearInterval(poll);
      clearTimeout(deadline);
      resolve();
    };
    const onChange = () => { if (navigator.serviceWorker.controller) done(); };
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    const poll = setInterval(() => { if (navigator.serviceWorker.controller) done(); }, 50);
    const deadline = setTimeout(done, controlTimeoutMs); // bound: never hang, fail loudly downstream
  });
  return reg;
}
