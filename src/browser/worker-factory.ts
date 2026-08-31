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

/** This tab's stake in one graph: a queued (or granted) per-graph Web Lock and, once granted, the Worker
 *  it owns. `abort` cancels the queue / releases the lock on destroy. */
interface Leadership {
  worker?: Worker;
  abort: AbortController;
  isLeader: boolean;
}

/** The capnweb interface the SW edge calls. Spawning + ownership + cross-tab leadership live here; the SW
 *  holds the data-plane stubs. Every method is a typed capnweb call — the port hand-off it triggers is the
 *  one native message.
 *
 *  Leadership is a per-graph Web Lock (`mogwai-graph-<id>`), held for this tab's LIFE — election and crash
 *  liveness in ONE primitive: only one tab holds it (the owner that spawns the graph's Worker), the rest
 *  queue, and when the owner tab is destroyed the browser releases the lock and the next queued tab's
 *  callback fires → it becomes leader, spawns the Worker (re-opening opfs-sahpool over the committed data)
 *  and pushes the SW a fresh port. No heartbeats, no announcement protocol. */
export class WorkerFactory extends RpcTarget {
  private readonly graphs = new Map<string, Leadership>();

  /** `workerUrl` is the bundled graph-worker entry (`graph-worker.entry.ts`) the page serves. */
  constructor(private readonly workerUrl: string | URL) {
    super();
  }

  /** The SW wants graph `id`. Ensure this tab is IN the leadership queue for it (enqueue once); the tab
   *  that HOLDS the lock spawns the Worker and hands the SW a fresh DIRECT port. A tab that is queued but
   *  not (yet) leader does nothing — the current leader delivers, and if the leader dies this tab's lock
   *  callback fires and delivers then (failover). Idempotent per id. */
  async openGraph(id: string): Promise<void> {
    let g = this.graphs.get(id);
    if (!g) {
      const abort = new AbortController();
      g = { abort, isLeader: false };
      this.graphs.set(id, g);
      const L = g;
      // Held for life: the callback resolves only when `abort` fires (destroyGraph) — otherwise the
      // browser releases the lock when this tab's document is destroyed, promoting the next waiter.
      navigator.locks
        .request(`mogwai-graph-${id}`, { signal: abort.signal }, () => {
          L.isLeader = true;
          this.deliver(id, L); // granted leadership (initial election OR failover) → spawn + push a port
          return heldUntilAborted(abort.signal);
        })
        .catch((e: unknown) => {
          if (!(e instanceof DOMException && e.name === 'AbortError')) throw e; // aborted = destroyGraph, fine
        });
    } else if (g.isLeader) {
      this.deliver(id, g); // already leader; SW re-asked (e.g. it never got the first port) → fresh port
    }
  }

  /** Tear down graph `id` (idempotent): release/cancel this tab's lock (so a queued tab does not later
   *  resurrect a destroyed graph), terminate the Worker if we own it, and remove the OPFS database. */
  async destroyGraph(id: string): Promise<void> {
    const g = this.graphs.get(id);
    if (g) {
      g.abort.abort();
      g.worker?.terminate();
      this.graphs.delete(id);
    }
    await removeOpfsDir(`.mogwai/${encodeURIComponent(id)}`);
  }

  /** As leader for `id`: spawn its Worker if we don't own one yet (on failover this re-opens opfs-sahpool
   *  over the committed data), then hand the controlling SW a fresh session port to it. */
  private deliver(id: string, g: Leadership): void {
    const port = g.worker ? bootSession(g.worker, id) : (() => {
      const s = spawnGraphWorker(this.workerUrl, id);
      g.worker = s.worker;
      return s.port;
    })();
    this.post({ kind: 'mogwai-graph-port', graphId: id, port });
  }

  /** Post a Bootstrap (port hand-off) to the controlling Service Worker, transferring the port. */
  private post(msg: Extract<BootstrapMessage, { port: MessagePort }>): void {
    navigator.serviceWorker.controller?.postMessage(msg, [msg.port]);
  }
}

/** A promise that resolves only when `signal` aborts — used to HOLD a Web Lock for the tab's life (or
 *  until an explicit release). */
function heldUntilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** Install the page-side factory: open a control-plane capnweb session with the Service Worker (so the SW
 *  can call `openGraph`), and re-open one whenever the SW solicits (`mogwai-need-control`, after the SW or
 *  its ports were reaped). Returns a disposer that removes the listener. Call once, after the SW controls
 *  the page (see {@link registerServiceWorker}). */
export function installWorkerFactory(workerUrl: string | URL): () => void {
  // Ask the browser to make this origin's OPFS PERSISTENT — otherwise it is evictable under storage
  // pressure, which would silently drop a graph's committed data (the 10 GB DO ceiling has no such risk).
  // Fire-and-forget: it may prompt, be auto-granted, or be denied; storage still works either way.
  void navigator.storage?.persist?.().catch(() => {});
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
