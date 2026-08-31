// The PAGE-side Worker FACTORY + owner. It is NOT the edge — the Service Worker is (it runs makeRouter and
// holds a direct capnweb stub to each graph's Worker). The factory exists for one reason: only a Window
// can spawn a dedicated Worker, and a dedicated Worker dies with its owner document, so some tab must
// spawn and KEEP each graph's Worker. Once it hands the SW a direct port, it leaves the data path.
//
// It exposes ONE typed capnweb interface to the SW — `WorkerFactory` (openGraph/destroyGraph) — over a
// control-plane capnweb session. The only native messages are the `Bootstrap` port hand-offs, which
// capnweb cannot itself carry (worker-spawn.ts).
import { newMessagePortRpcSession, RpcTarget } from 'capnweb';
import { spawnGraphWorker, bootSession, removeOpfsDir, type BootstrapMessage } from './worker-spawn.ts';

/** The capnweb interface the SW edge calls. Spawning + ownership live here; the SW holds the data-plane
 *  stubs. Every method is a typed capnweb call — the port hand-off it triggers is the one native message. */
export class WorkerFactory extends RpcTarget {
  private readonly workers = new Map<string, Worker>();

  /** `workerUrl` is the bundled graph-worker entry (`graph-worker.entry.ts`) the page serves. */
  constructor(private readonly workerUrl: string | URL) {
    super();
  }

  /** Ensure graph `id`'s Worker exists (spawn on first call), then hand the controlling SW a fresh DIRECT
   *  session port to it (a `mogwai-graph-port` Bootstrap). Returns once dispatched; the SW pairs the
   *  arriving port with this call. Open failures surface on the SW's first stub call (the Worker serves
   *  its host as an RpcPromise over open()), so this need not await the open. */
  async openGraph(id: string): Promise<void> {
    let worker = this.workers.get(id);
    let port: MessagePort;
    if (!worker) {
      const s = spawnGraphWorker(this.workerUrl, id);
      worker = s.worker;
      this.workers.set(id, worker);
      port = s.port;
    } else {
      port = bootSession(worker, id); // already spawned — just a fresh session over the existing host
    }
    this.deliver({ kind: 'mogwai-graph-port', graphId: id, port });
  }

  /** Tear down graph `id`'s Worker + storage (idempotent) — the factory owns the Worker, so teardown is
   *  its job (terminate releases the opfs-sahpool handles; then remove the OPFS database). */
  async destroyGraph(id: string): Promise<void> {
    const w = this.workers.get(id);
    if (w) {
      w.terminate();
      this.workers.delete(id);
    }
    await removeOpfsDir(`.mogwai/${encodeURIComponent(id)}`);
  }

  /** Post a Bootstrap (port hand-off) to the controlling Service Worker, transferring the port. */
  private deliver(msg: Extract<BootstrapMessage, { port: MessagePort }>): void {
    navigator.serviceWorker.controller?.postMessage(msg, [msg.port]);
  }
}

/** Install the page-side factory: open a control-plane capnweb session with the Service Worker (so the SW
 *  can call `openGraph`), and re-open one whenever the SW solicits (`mogwai-need-control`, after the SW or
 *  its ports were reaped). Returns a disposer that removes the listener. Call once, after the SW controls
 *  the page (see {@link registerServiceWorker}). */
export function installWorkerFactory(workerUrl: string | URL): () => void {
  const factory = new WorkerFactory(workerUrl);
  const openControl = () => {
    const channel = new MessageChannel();
    newMessagePortRpcSession(channel.port1, factory); // this page exposes the factory over port1
    const msg: BootstrapMessage = { kind: 'mogwai-control-port', port: channel.port2 };
    navigator.serviceWorker.controller?.postMessage(msg, [channel.port2]);
  };
  const onMessage = (event: MessageEvent) => {
    if ((event.data as BootstrapMessage | undefined)?.kind === 'mogwai-need-control') openControl();
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  openControl(); // proactively open one now so the first request is fast
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}

/** Register the Service Worker and resolve once it CONTROLS this page — so the first intercepted fetch
 *  is not raced by activation. In a fresh page the SW installs (skipWaiting) and claims (clients.claim),
 *  which sets `serviceWorker.controller` (firing `controllerchange`).
 *
 *  Race-free by construction: a naive `await ready; if (!controller) await once('controllerchange')` can
 *  MISS the event when it fires between `ready` resolving and the listener attaching — an infinite hang
 *  that surfaces only under CI timing. So this listens AND polls, re-checking `controller` on both, and is
 *  BOUNDED: past the deadline it resolves anyway, turning a would-be hang into a clear downstream failure
 *  (an un-intercepted fetch gets the page HTML, not GraphBinary) rather than a timeout with no diagnosis. */
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
