// The Service Worker's GraphStubSource — how the SW edge obtains (and KEEPS) a direct capnweb stub to
// each graph's Worker, across cross-tab leadership and failover. The SW cannot spawn a dedicated Worker,
// so it asks the WorkerFactory pages (over typed capnweb `openGraph`); whichever tab holds the graph's
// Web Lock spawns the Worker and pushes the SW a direct port.
//
// FAILOVER, and the one browser reality it turns on: a hard-killed leader tab does NOT gracefully close
// its MessagePort (capnweb only sees a close when the peer sends an explicit `null` via abort()), so the
// SW's stub to a dead Worker does not break on its own — an in-flight call HANGS. The reliable death
// signal is a DIFFERENT tab pushing a fresh port (its Web Lock callback fires when the dead tab's lock
// releases). So on a `mogwai-graph-port` from a NEW OWNER for a graph we already hold, we DISPOSE the old
// stub — which aborts its session and rejects its hung calls — and install the new one. BrowserGraphManager
// then sees a changed current stub on that rejection and retries the call once against the new leader.
//
// But a port re-delivered by the SAME owner (tab) is NOT a failover — it is a duplicate. On a COLD START
// the page can hold two control sessions to the SW briefly (the proactive `openControl()` plus one the SW
// solicits via `mogwai-need-control` when the first request races ahead), and a graph/registry
// solicitation fans out to both, so the one leader delivers a port TWICE. Disposing the live stub on that
// second (same-owner) delivery aborts the in-flight call — the "RPC session was shut down by disposing the
// main stub" 400 seen intermittently under load. So we key the decision on `owner`: same owner ⇒ keep the
// live stub and drop the redundant port; different owner ⇒ genuine failover, dispose and swap.
import { newMessagePortRpcSession, type RpcStub } from 'capnweb';
import type { GraphStubSource } from './BrowserGraphManager.ts';
import type { GraphWorkerHost } from './GraphWorkerHost.ts';
import type { ReplicatorRegistryHost } from './ReplicatorRegistryHost.ts';
import type { RegistryStubSource } from './StubReplicatorRegistry.ts';
import type { WorkerFactory } from './worker-factory.ts';
import type { BootstrapMessage } from './worker-spawn.ts';

export class FactoryStubSource implements GraphStubSource, RegistryStubSource {
  /** Control sessions to WorkerFactory pages (one per open factory tab). Cross-tab: openGraph goes to
   *  ALL of them; the tab that holds the lock answers. */
  private readonly factories = new Set<RpcStub<WorkerFactory>>();
  private factoryWaiters: Array<() => void> = [];

  /** The CURRENT direct stub per graph — replaced on failover. */
  private readonly current = new Map<string, RpcStub<GraphWorkerHost>>();
  /** The owner (tab) behind each current graph stub — a re-delivery from this owner is a duplicate, not a
   *  failover, so it must not dispose the live stub. */
  private readonly currentOwner = new Map<string, string>();
  /** Resolvers waiting for a graph's next port (a pending `open`). */
  private readonly portWaiters = new Map<string, Array<() => void>>();
  /** In-flight solicitations, so concurrent first-touchers share one `openGraph` round. */
  private readonly soliciting = new Map<string, Promise<RpcStub<GraphWorkerHost>>>();

  /** The CURRENT registry stub (singleton) — replaced on failover, exactly like a graph's. */
  private currentRegistry?: RpcStub<ReplicatorRegistryHost>;
  /** The owner (tab) behind the current registry stub — twin of {@link currentOwner}. */
  private currentRegistryOwner?: string;
  private registryWaiters: Array<() => void> = [];
  private solicitingRegistry?: Promise<RpcStub<ReplicatorRegistryHost>>;

  constructor(private readonly scope: ServiceWorkerGlobalScope) {
    scope.addEventListener('message', (event) => this.onMessage(event as ExtendableMessageEvent));
  }

  private onMessage(event: ExtendableMessageEvent): void {
    const data = event.data as BootstrapMessage | undefined;
    if (data?.kind === 'mogwai-control-port') {
      const factory = newMessagePortRpcSession<WorkerFactory>(data.port);
      this.factories.add(factory);
      const waiters = this.factoryWaiters;
      this.factoryWaiters = [];
      for (const w of waiters) w();
      // A late-joining tab must queue for leadership on everything already in flight, so it can take over
      // on failover — re-broadcast the active graphs AND the registry to it.
      for (const id of this.current.keys()) void factory.openGraph(id).catch(() => {});
      if (this.currentRegistry || this.solicitingRegistry) void factory.openRegistry().catch(() => {});
    } else if (data?.kind === 'mogwai-graph-port') {
      this.acceptPort(data.graphId, data.port, data.owner);
    } else if (data?.kind === 'mogwai-registry-port') {
      this.acceptRegistryPort(data.port, data.owner);
    }
  }

  /** A leader delivered the registry port. If we already hold a stub from a DIFFERENT owner this is a
   *  FAILOVER: dispose the old one — that aborts its session and rejects any hung call, which lets the
   *  wrapper retry against the new leader. If it is the SAME owner it is a duplicate re-delivery (cold-start
   *  double solicitation), so keep the live stub and drop the redundant port — disposing it would reject
   *  the in-flight call. */
  private acceptRegistryPort(port: MessagePort, owner: string): void {
    if (this.currentRegistry) {
      if (this.currentRegistryOwner === owner) { closePort(port); return; }
      try { this.currentRegistry[Symbol.dispose](); } catch { /* a dead stub throws on dispose — harmless */ }
    }
    this.currentRegistry = newMessagePortRpcSession<ReplicatorRegistryHost>(port);
    this.currentRegistryOwner = owner;
    const waiters = this.registryWaiters;
    this.registryWaiters = [];
    for (const w of waiters) w();
  }

  /** The current registry stub, soliciting one if we have none — the singleton twin of {@link open}. */
  openRegistry(): Promise<RpcStub<ReplicatorRegistryHost>> {
    if (this.currentRegistry) return Promise.resolve(this.currentRegistry);
    if (!this.solicitingRegistry) {
      this.solicitingRegistry = this.solicitRegistry();
      void this.solicitingRegistry.finally(() => { this.solicitingRegistry = undefined; });
    }
    return this.solicitingRegistry;
  }

  private async solicitRegistry(): Promise<RpcStub<ReplicatorRegistryHost>> {
    const factories = await this.ensureFactories();
    const arrived = new Promise<void>((resolve) => this.registryWaiters.push(resolve));
    for (const f of factories) void f.openRegistry().catch(() => {});
    await arrived;
    return this.currentRegistry!;
  }

  /** A leader delivered a port for `id`. If we already hold a stub from a DIFFERENT owner this is a
   *  FAILOVER (the old leader died): dispose it — that aborts its session and rejects any hung in-flight
   *  call, which is what lets the manager notice the change and retry against the new leader. If it is the
   *  SAME owner it is a duplicate re-delivery (cold-start double solicitation): keep the live stub and drop
   *  the redundant port, because disposing it would reject the in-flight call. Then install the new stub
   *  (failover / first delivery only) and wake any pending `open`. */
  private acceptPort(id: string, port: MessagePort, owner: string): void {
    const prev = this.current.get(id);
    if (prev) {
      if (this.currentOwner.get(id) === owner) { closePort(port); return; }
      try {
        prev[Symbol.dispose]();
      } catch {
        // a stub whose own port already died throws on dispose — harmless, the point is to break it.
      }
    }
    this.current.set(id, newMessagePortRpcSession<GraphWorkerHost>(port));
    this.currentOwner.set(id, owner);
    const waiters = this.portWaiters.get(id);
    if (waiters) {
      this.portWaiters.delete(id);
      for (const w of waiters) w();
    }
  }

  /** The current stub for `id`, soliciting one if we have none. Idempotent + cheap once a graph is live —
   *  the manager calls this on every request AND again after a failure to pick up a post-failover stub. */
  open(id: string): Promise<RpcStub<GraphWorkerHost>> {
    const cur = this.current.get(id);
    if (cur) return Promise.resolve(cur);
    let p = this.soliciting.get(id);
    if (!p) {
      p = this.solicit(id);
      this.soliciting.set(id, p);
      void p.finally(() => this.soliciting.delete(id));
    }
    return p;
  }

  private async solicit(id: string): Promise<RpcStub<GraphWorkerHost>> {
    const factories = await this.ensureFactories();
    const arrived = new Promise<void>((resolve) => {
      const list = this.portWaiters.get(id) ?? [];
      list.push(resolve);
      this.portWaiters.set(id, list);
    });
    for (const f of factories) void f.openGraph(id).catch(() => {}); // the lock holder answers
    await arrived; // acceptPort has set current[id]
    return this.current.get(id)!;
  }

  async destroy(id: string): Promise<void> {
    const factories = await this.ensureFactories().catch(() => new Set<RpcStub<WorkerFactory>>());
    await Promise.all([...factories].map((f) => f.destroyGraph(id).catch(() => {})));
    const cur = this.current.get(id);
    if (cur) {
      try {
        cur[Symbol.dispose]();
      } catch {
        /* already dead */
      }
      this.current.delete(id);
    }
    this.currentOwner.delete(id);
  }

  /** At least one control session, soliciting one from any open page if we have none. Bounded so a missing
   *  factory page becomes a clear failure (a 503 at the edge), never an unbounded hang. */
  private async ensureFactories(timeoutMs = 10_000): Promise<Set<RpcStub<WorkerFactory>>> {
    if (this.factories.size > 0) return this.factories;
    const clients = await this.scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) c.postMessage({ kind: 'mogwai-need-control' } satisfies BootstrapMessage);
    await new Promise<void>((resolve, reject) => {
      this.factoryWaiters.push(resolve);
      setTimeout(() => reject(new Error('no mogwai WorkerFactory page is open to host this graph')), timeoutMs);
    });
    return this.factories;
  }
}

/** Close a redundant duplicate port hand-off (a same-owner re-delivery) so the transferred channel and its
 *  orphaned worker-side session do not leak. Best-effort — an already-closed port is harmless. */
function closePort(port: MessagePort): void {
  try { port.close(); } catch { /* already closed */ }
}
