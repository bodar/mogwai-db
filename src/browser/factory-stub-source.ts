// The Service Worker's GraphStubSource — how the SW edge obtains (and KEEPS) a direct capnweb stub to
// each graph's Worker, across cross-tab leadership and failover. The SW cannot spawn a dedicated Worker,
// so it asks the WorkerFactory pages (over typed capnweb `openGraph`); whichever tab holds the graph's
// Web Lock spawns the Worker and pushes the SW a direct port.
//
// FAILOVER, and the one browser reality it turns on: a hard-killed leader tab does NOT gracefully close
// its MessagePort (capnweb only sees a close when the peer sends an explicit `null` via abort()), so the
// SW's stub to a dead Worker does not break on its own — an in-flight call HANGS. The reliable death
// signal is the NEW leader pushing a fresh port (its Web Lock callback fires when the dead tab's lock
// releases). So on a new `mogwai-graph-port` for a graph we already hold, we DISPOSE the old stub — which
// aborts its session and rejects its hung calls — and install the new one. BrowserGraphManager then sees
// a changed current stub on that rejection and retries the call once against the new leader.
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
  /** Resolvers waiting for a graph's next port (a pending `open`). */
  private readonly portWaiters = new Map<string, Array<() => void>>();
  /** In-flight solicitations, so concurrent first-touchers share one `openGraph` round. */
  private readonly soliciting = new Map<string, Promise<RpcStub<GraphWorkerHost>>>();

  /** The CURRENT registry stub (singleton) — replaced on failover, exactly like a graph's. */
  private currentRegistry?: RpcStub<ReplicatorRegistryHost>;
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
      this.acceptPort(data.graphId, data.port);
    } else if (data?.kind === 'mogwai-registry-port') {
      this.acceptRegistryPort(data.port);
    }
  }

  /** A leader delivered the registry port. On FAILOVER (we already held a stub) dispose the old one — that
   *  aborts its session and rejects any hung call, which lets the wrapper retry against the new leader. */
  private acceptRegistryPort(port: MessagePort): void {
    const next = newMessagePortRpcSession<ReplicatorRegistryHost>(port);
    const prev = this.currentRegistry;
    if (prev && prev !== next) {
      try { prev[Symbol.dispose](); } catch { /* a dead stub throws on dispose — harmless */ }
    }
    this.currentRegistry = next;
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

  /** A leader delivered a port for `id`. If we already held a stub (this is a FAILOVER — the old leader
   *  died), dispose it: that aborts its session and rejects any hung in-flight call, which is what lets
   *  the manager notice the change and retry. Then install the new stub and wake any pending `open`. */
  private acceptPort(id: string, port: MessagePort): void {
    const next = newMessagePortRpcSession<GraphWorkerHost>(port);
    const prev = this.current.get(id);
    if (prev && prev !== next) {
      try {
        prev[Symbol.dispose]();
      } catch {
        // a stub whose own port already died throws on dispose — harmless, the point is to break it.
      }
    }
    this.current.set(id, next);
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
