// The PAGE-side Worker FACTORY + owner. It is NOT the edge — the Service Worker is (it runs makeRouter and
// holds a direct capnweb stub to each graph's Worker). The factory exists for one reason: only a Window
// can spawn a dedicated Worker, and a dedicated Worker dies with its owner document, so some tab must
// spawn and KEEP each graph's Worker. Once it hands the SW a direct port, it leaves the data path.
//
// It exposes ONE typed capnweb interface to the SW — `WorkerFactory` (openGraph/destroyGraph) — over a
// control-plane capnweb session. The only native messages are the `Bootstrap` port hand-offs, which
// capnweb cannot itself carry (worker-spawn.ts).
import { newMessagePortRpcSession, RpcTarget } from 'capnweb';
import {
  spawnGraphWorker, bootSession, spawnRegistryWorker, bootRegistrySession, removeOpfsDir, type BootstrapMessage,
} from './worker-spawn.ts';
import type { MogwaiConfig } from '../config.ts';

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
  /** This tab's identity, stamped on every port hand-off so the SW can distinguish a same-tab re-delivery
   *  (keep the live stub) from a cross-tab failover (swap it) — see `BootstrapMessage.owner`. Unique per
   *  WorkerFactory instance = per tab; a tab holds a graph's Web Lock for life, so it never re-elects
   *  itself, which is why "same owner" always means a duplicate delivery and never a new Worker. */
  private readonly ownerId = crypto.randomUUID();
  private readonly graphs = new Map<string, Leadership>();
  /** This tab's stake in the SINGLETON registry Worker — the same Web-Lock leadership as a graph, keyed
   *  `mogwai-registry`, so exactly one tab owns the registry Worker and the rest fail over to it. */
  private registry?: Leadership;

  /** `workerUrl` is the bundled graph-worker entry (`worker.ts`); `registryWorkerUrl` the registry-worker
   *  entry (`registry-worker.ts`) — both served by the page. `config` (read from the page's inline
   *  `<script>` JSON) rides each GRAPH Worker's boot for its allowlisted Http seam (the registry needs none). */
  constructor(
    private readonly workerUrl: string | URL,
    private readonly registryWorkerUrl: string | URL,
    private readonly config?: MogwaiConfig,
  ) {
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

  /** The SW wants the singleton registry Worker. Identical leadership to `openGraph` but for the ONE
   *  registry (lock `mogwai-registry`): the tab that holds the lock spawns the registry Worker and pushes
   *  the SW a direct port; others queue and take over on failover. Idempotent. */
  async openRegistry(): Promise<void> {
    if (!this.registry) {
      const abort = new AbortController();
      const L: Leadership = { abort, isLeader: false };
      this.registry = L;
      navigator.locks
        .request('mogwai-registry', { signal: abort.signal }, () => {
          L.isLeader = true;
          this.deliverRegistry(L);
          return heldUntilAborted(abort.signal);
        })
        .catch((e: unknown) => {
          if (!(e instanceof DOMException && e.name === 'AbortError')) throw e;
        });
    } else if (this.registry.isLeader) {
      this.deliverRegistry(this.registry);
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
    const port = g.worker ? bootSession(g.worker, id, this.config) : (() => {
      const s = spawnGraphWorker(this.workerUrl, id, this.config);
      g.worker = s.worker;
      return s.port;
    })();
    this.post({ kind: 'mogwai-graph-port', graphId: id, port, owner: this.ownerId });
  }

  /** As registry leader: spawn the registry Worker if we don't own one yet (on failover re-opens its
   *  opfs-sahpool over the committed configs), then push the SW a fresh session port. */
  private deliverRegistry(g: Leadership): void {
    const port = g.worker ? bootRegistrySession(g.worker) : (() => {
      const s = spawnRegistryWorker(this.registryWorkerUrl);
      g.worker = s.worker;
      return s.port;
    })();
    this.post({ kind: 'mogwai-registry-port', port, owner: this.ownerId });
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

/** Options for {@link installMogwai}. All optional — the defaults resolve the two sibling scripts RELATIVE
 *  to the bootstrap bundle (`import.meta.url`), so the three files (`mogwai.js` + `service-worker.js` +
 *  `worker.js`) can live at any path together and find each other. */
export interface MogwaiOptions {
  /** The Service Worker script URL. Default: `./service-worker.js` beside this bundle. */
  serviceWorker?: string | URL;
  /** The per-graph Worker script URL. Default: `./worker.js` beside this bundle. */
  worker?: string | URL;
  /** The singleton registry Worker script URL. Default: `./registry-worker.js` beside this bundle. */
  registryWorker?: string | URL;
  /** The Service Worker scope. Default: the SW's own directory (root, for a root deploy) — widen it (and
   *  serve the SW with `Service-Worker-Allowed`) only to intercept `/gremlin/*` above the SW's path. */
  scope?: string;
  /** The runtime config (io()/federate host allowlist, etc.), handed to each graph Worker at boot. The
   *  `mogwai.ts` entry reads it from the page's inline `<script>` JSON; a programmatic caller passes it
   *  directly. Omitted ⇒ deny-all (io()/federate over http off until an allowlist is set). */
  config?: MogwaiConfig;
}

/** The page bootstrap: register the Service Worker and install this tab's WorkerFactory. This is the whole
 *  of what a consuming page does — the two sibling scripts default to resolving beside this bundle, so a
 *  page includes ONE `<script type="module" src=".../mogwai.js">` and everything else self-wires. */
export async function installMogwai(opts: MogwaiOptions = {}): Promise<() => void> {
  const serviceWorker = opts.serviceWorker ?? new URL('./service-worker.js', import.meta.url);
  const worker = opts.worker ?? new URL('./worker.js', import.meta.url);
  const registryWorker = opts.registryWorker ?? new URL('./registry-worker.js', import.meta.url);
  await registerServiceWorker(serviceWorker, opts.scope); // resolves once the SW controls this page
  return installWorkerFactory(worker, registryWorker, opts.config);
}

/** Install the page-side factory: open a control-plane capnweb session with the Service Worker (so the SW
 *  can call `openGraph`), and re-open one whenever the SW solicits (`mogwai-need-control`, after the SW or
 *  its ports were reaped). Returns a disposer that removes the listener. Call once, after the SW controls
 *  the page (see {@link registerServiceWorker}). */
export function installWorkerFactory(workerUrl: string | URL, registryWorkerUrl: string | URL, config?: MogwaiConfig): () => void {
  // Ask the browser to make this origin's OPFS PERSISTENT — otherwise it is evictable under storage
  // pressure, which would silently drop a graph's committed data (the 10 GB DO ceiling has no such risk).
  // Fire-and-forget: it may prompt, be auto-granted, or be denied; storage still works either way.
  void navigator.storage?.persist?.().catch(() => {});
  const factory = new WorkerFactory(workerUrl, registryWorkerUrl, config);
  const openControl = () => {
    const channel = new MessageChannel();
    newMessagePortRpcSession(channel.port1, factory); // this page exposes the factory over port1
    const msg: BootstrapMessage = { kind: 'mogwai-control-port', port: channel.port2 };
    navigator.serviceWorker.controller?.postMessage(msg, [channel.port2]);
    // The scheduler's outbound-http allowlist lives at the SW edge (it runs the runner); send the config
    // so a remote-peer replication ("pull from Cloudflare into this tab") is permitted — else deny-all.
    if (config) navigator.serviceWorker.controller?.postMessage({ kind: 'mogwai-config', config } satisfies BootstrapMessage);
  };
  const onMessage = (event: MessageEvent) => {
    if ((event.data as BootstrapMessage | undefined)?.kind === 'mogwai-need-control') openControl();
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  openControl(); // proactively open one now so the first request is fast
  // The browser's background scheduler (§9): a Web-Lock-elected tab ticks `POST /_scheduler/run` every
  // `schedulerIntervalMs`, waking the SW to run due jobs. ONE tab ticks (the rest queue and take over on
  // failover — the same primitive as graph leadership); opt-in (unset ⇒ off, a `POST /_scheduler/run` still
  // works manually), matching Bun.
  const stopTicker = config?.schedulerIntervalMs && config.schedulerIntervalMs > 0
    ? startSchedulerTicker(config.schedulerIntervalMs)
    : undefined;
  return () => {
    navigator.serviceWorker.removeEventListener('message', onMessage);
    stopTicker?.();
  };
}

/** Start this tab's replication-scheduler ticker: contend for the `mogwai-scheduler` Web Lock, and WHILE
 *  elected, `POST /_scheduler/run` every `intervalMs` (the SW runs the due jobs). Only the lock holder ticks;
 *  the rest wait and one takes over when the holder tab dies — the browser's continuous-replication driver.
 *  Returns a stop function (releases the lock / ends the loop). */
function startSchedulerTicker(intervalMs: number): () => void {
  const abort = new AbortController();
  navigator.locks
    .request('mogwai-scheduler', { signal: abort.signal }, async () => {
      while (!abort.signal.aborted) {
        try { await fetch('/_scheduler/run', { method: 'POST' }); } catch { /* SW asleep / transient — next tick */ }
        await new Promise<void>((resolve) => {
          if (abort.signal.aborted) return resolve();
          const t = setTimeout(resolve, intervalMs);
          abort.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
      }
    })
    .catch((e: unknown) => {
      if (!(e instanceof DOMException && e.name === 'AbortError')) throw e;
    });
  return () => abort.abort();
}

/** Register the Service Worker and resolve once it CONTROLS this page — so the first intercepted fetch
 *  is not raced by activation. In a fresh page the SW installs (skipWaiting) and claims (clients.claim),
 *  which sets `serviceWorker.controller` (firing `controllerchange`).
 *
 *  Purely EVENT-DRIVEN, and race-free WITHOUT polling: `controllerchange` can only be dispatched on a
 *  later event-loop turn, so as long as the listener is ATTACHED before the final `controller` re-check —
 *  both of which run synchronously inside the Promise executor — no transition can slip between them. (The
 *  hang the earlier poll guarded against came from the opposite order: check `controller`, THEN attach, so
 *  an event firing in the gap was lost. Attach-then-recheck closes that gap outright.) `controller` being
 *  set is a stronger signal than `serviceWorker.ready` (an active registration that may not yet control
 *  this page), so it is the only condition awaited. BOUNDED by a deadline so a SW that never claims fails
 *  loudly downstream (an un-intercepted fetch gets the page HTML, not GraphBinary) rather than hanging. */
export async function registerServiceWorker(url: string | URL, scope?: string, controlTimeoutMs = 30_000): Promise<ServiceWorkerRegistration> {
  const sw = navigator.serviceWorker;
  const reg = await sw.register(url.toString(), { type: 'module', ...(scope ? { scope } : {}) });
  if (sw.controller) return reg; // warm start: an existing SW already controls this page
  await new Promise<void>((resolve) => {
    const done = () => { sw.removeEventListener('controllerchange', onChange); clearTimeout(deadline); resolve(); };
    const onChange = () => { if (sw.controller) done(); };
    const deadline = setTimeout(done, controlTimeoutMs); // bound: never hang, fail loudly downstream
    sw.addEventListener('controllerchange', onChange);
    if (sw.controller) done(); // re-check AFTER attaching — closes the attach/fire gap with no poll
  });
  return reg;
}
