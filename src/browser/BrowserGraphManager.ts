// The browser's GraphManager — the twin of CloudflareGraphManager (id → Durable Object) and
// BunGraphManager (id → in-process store). Here: id → a DIRECT capnweb stub to that graph's dedicated
// Worker. ONE manager engine (executor/create/info/destroy + the Framed[] Uint8Array→Buffer rewrap +
// retry-once-on-failover) over a `GraphStubSource` — the seam that owns HOW a graph's stub is obtained
// AND kept current:
//   - `LocalWorkerSource` — this context spawns the Worker itself (a page, or a driver worker that can).
//   - `FactoryStubSource` (the Service Worker edge) — asks the WorkerFactory pages for a port, and swaps
//     the stub across cross-tab failover.
// Concurrency is many graphs on many Workers (many threads), never within one graph — exactly where
// Cloudflare gets it (one DO, run-to-completion).
import { newMessagePortRpcSession, type RpcStub } from 'capnweb';
import type { GraphManager, GraphInfo, RemoteExecutor } from '../manager.ts';
import type { Framed } from '../execute.ts';
import type { ForeignResult, ChangesFeed, RevsDiffRequest, RevsDiffResponse } from '../api.ts';
import type { GraphWorkerHost } from './GraphWorkerHost.ts';
import { spawnGraphWorker, removeOpfsDir } from './worker-spawn.ts';
import type { MogwaiConfig } from '../config.ts';

// capnweb stub methods return an `RpcPromise` whose type `Stubify`s the payload (an over-approximation for
// a proxy we never pipeline — we `await` it immediately, and the real value crosses as plain structured
// clone). These aliases pin the awaited type back to what the host actually returns, at the one seam.
type Awaited$<T> = (stub: RpcStub<GraphWorkerHost>) => Promise<T>;

/** How the browser GraphManager OBTAINS and KEEPS a graph's direct capnweb stub. `open(id)` returns the
 *  CURRENT stub (cheap + idempotent once live); the manager calls it again after a failure to pick up a
 *  stub the source swapped in across failover. */
export interface GraphStubSource {
  open(id: string): Promise<RpcStub<GraphWorkerHost>>;
  /** Tear down graph `id`'s Worker + storage (idempotent). */
  destroy(id: string): Promise<void>;
}

/** Restore the `Framed` contract (`buf: Buffer`) the response framer relies on — the buffers arrive as
 *  `Uint8Array` across the port. */
const rewrap = (framed: Framed[]): Framed[] => framed.map((f) => ({ buf: Buffer.from(f.buf), bulk: f.bulk }));

export class BrowserGraphManager implements GraphManager {
  constructor(private readonly source: GraphStubSource) {}

  /** Run `fn` against graph `id`'s current stub, retrying ONCE if the stub CHANGED across the failure —
   *  i.e. failover elected a new leader and the source disposed the dead stub (rejecting the hung call).
   *  A rejection with the SAME stub still current is a genuine query error and propagates unchanged (the
   *  router turns it into a GraphBinary trailer). */
  private async call<T>(id: string, fn: (stub: RpcStub<GraphWorkerHost>) => Promise<T>): Promise<T> {
    const stub = await this.source.open(id);
    try {
      return await fn(stub);
    } catch (e) {
      const fresh = await this.source.open(id);
      if (fresh !== stub) return await fn(fresh); // failover → retry once against the new leader
      throw e;
    }
  }

  /** A RemoteExecutor bound to graph `id` (the router needs only this). */
  executor(id: string): RemoteExecutor {
    return {
      framedAsync: (gremlin, params, paramTypes) =>
        this.call(id, ((s) => s.framed(gremlin, params, paramTypes)) as Awaited$<Framed[]>).then(rewrap),
      runForeign: (gremlin, params, depth, paramTypes, terminal) =>
        this.call(id, ((s) => s.runForeign(gremlin, params, depth, paramTypes, terminal)) as Awaited$<ForeignResult>),
    };
  }

  async create(id: string): Promise<void> {
    await this.call(id, ((s) => s.info()) as Awaited$<GraphInfo>); // opening runs the schema, materializing an empty graph
  }

  async info(id: string): Promise<GraphInfo> {
    return this.call(id, ((s) => s.info()) as Awaited$<GraphInfo>);
  }

  async changes(id: string, since: number): Promise<ChangesFeed> {
    return this.call(id, ((s) => s.changes(since)) as Awaited$<ChangesFeed>);
  }

  async revsDiff(id: string, request: RevsDiffRequest): Promise<RevsDiffResponse> {
    return this.call(id, ((s) => s.revsDiff(request)) as Awaited$<RevsDiffResponse>);
  }

  async destroy(id: string): Promise<void> {
    await this.source.destroy(id);
  }
}

/** A `GraphStubSource` for a context that CAN spawn dedicated Workers (a page, or a driver worker): it
 *  spawns one Worker per graph and holds the direct stub locally (idempotent — `open` returns the cached
 *  stub, so the manager's retry is a no-op here: a single context has no failover, and a rejection is a
 *  genuine query error). Used by the manager test and any non-SW host. */
export class LocalWorkerSource implements GraphStubSource {
  private readonly graphs = new Map<string, { worker: Worker; stub: RpcStub<GraphWorkerHost> }>();

  /** `workerUrl` is the bundled graph-worker entry (`worker.ts`) served by the host; `config` (io()/
   *  federate host allowlist, etc.) rides each Worker's boot, matching the WorkerFactory path. */
  constructor(private readonly workerUrl: string | URL, private readonly config?: MogwaiConfig) {}

  open(id: string): Promise<RpcStub<GraphWorkerHost>> {
    let g = this.graphs.get(id);
    if (!g) {
      const { worker, port } = spawnGraphWorker(this.workerUrl, id, this.config);
      g = { worker, stub: newMessagePortRpcSession<GraphWorkerHost>(port) };
      this.graphs.set(id, g);
    }
    return Promise.resolve(g.stub);
  }

  async destroy(id: string): Promise<void> {
    const g = this.graphs.get(id);
    if (g) {
      try {
        g.stub[Symbol.dispose]();
      } catch {
        /* already dead */
      }
      g.worker.terminate(); // releases the graph's opfs-sahpool file handles
      this.graphs.delete(id);
    }
    await removeOpfsDir(`.mogwai/${encodeURIComponent(id)}`);
  }
}
