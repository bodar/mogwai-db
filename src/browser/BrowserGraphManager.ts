// The browser's GraphManager — the twin of CloudflareGraphManager (id → Durable Object) and
// BunGraphManager (id → in-process store). Here: id → a DIRECT capnweb stub to that graph's dedicated
// Worker. ONE manager engine (holds the stubs, implements executor/create/info/destroy, does the
// Framed[] Uint8Array→Buffer rewrap at one seam) over a `GraphStubSource` — the seam that decides HOW a
// graph's stub is obtained:
//   - `LocalWorkerSource` — this context spawns the Worker itself (a page, or a driver worker that can).
//   - the Service Worker edge's factory source (service-worker.entry.ts) — asks the WorkerFactory page
//     for a port, because a Service Worker cannot spawn a dedicated Worker.
// Concurrency is many graphs on many Workers (many threads), never within one graph — exactly where
// Cloudflare gets it (one DO, run-to-completion).
import { newMessagePortRpcSession, type RpcStub } from 'capnweb';
import type { GraphManager, GraphInfo, RemoteExecutor } from '../manager.ts';
import type { GraphWorkerHost } from './GraphWorkerHost.ts';
import { spawnGraphWorker, removeOpfsDir } from './worker-spawn.ts';

/** How the browser GraphManager OBTAINS a graph's direct capnweb stub — the one seam between a context
 *  that spawns its own Workers and the Service Worker edge that must ask the WorkerFactory for a port. */
export interface GraphStubSource {
  /** Open (spawn-or-request) graph `id`'s Worker and return a direct stub to its host. */
  open(id: string): Promise<RpcStub<GraphWorkerHost>>;
  /** Tear down graph `id`'s Worker + storage (idempotent). */
  destroy(id: string): Promise<void>;
}

interface Graph {
  stub: RpcStub<GraphWorkerHost>;
  /** Resolves once the Worker has opened the host — a first `info()` doubles as the open confirmation, so
   *  every op awaits it and an open FAILURE surfaces here (the stub rejects) rather than a query running
   *  against a store that never opened. */
  opened: Promise<GraphInfo>;
}

export class BrowserGraphManager implements GraphManager {
  private readonly graphs = new Map<string, Promise<Graph>>();

  constructor(private readonly source: GraphStubSource) {}

  /** Get (or open on demand) graph `id` — the browser twin of DO-on-first-access. Stored as a promise so
   *  concurrent first-touchers share one open, and a query issued immediately runs against an opened store. */
  private resolve(id: string): Promise<Graph> {
    let g = this.graphs.get(id);
    if (!g) {
      g = this.source.open(id).then((stub) => ({ stub, opened: Promise.resolve(stub.info()) }));
      this.graphs.set(id, g);
    }
    return g;
  }

  /** A RemoteExecutor bound to graph `id`'s Worker (the router needs only this). The framed buffers arrive
   *  as `Uint8Array` across the port, so re-wrap each as `Buffer` — restoring the `Framed` contract
   *  (`buf: Buffer`) the response framer (`streamBuffers` → `Buffer.concat`) relies on, at the one seam. */
  executor(id: string): RemoteExecutor {
    return {
      framedAsync: async (gremlin, params, paramTypes) => {
        const g = await this.resolve(id);
        await g.opened;
        return (await g.stub.framed(gremlin, params, paramTypes)).map((f) => ({ buf: Buffer.from(f.buf), bulk: f.bulk }));
      },
      runForeign: async (gremlin, params, depth, paramTypes, terminal) => {
        const g = await this.resolve(id);
        await g.opened;
        return g.stub.runForeign(gremlin, params, depth, paramTypes, terminal);
      },
    };
  }

  async create(id: string): Promise<void> {
    await (await this.resolve(id)).opened; // idempotent: opening runs the schema, materializing an empty graph
  }

  async info(id: string): Promise<GraphInfo> {
    const g = await this.resolve(id);
    await g.opened;
    return g.stub.info();
  }

  /** Teardown: drop the stub and hand the graph's Worker + storage to the source to destroy, so a
   *  re-address recreates the graph EMPTY (CF's deleteAll twin). Idempotent. */
  async destroy(id: string): Promise<void> {
    const g = this.graphs.get(id);
    this.graphs.delete(id);
    if (g) {
      try {
        (await g).stub[Symbol.dispose]();
      } catch {
        // a stub whose port already died (Worker gone) throws on dispose — the source teardown below is
        // what matters, and it is idempotent.
      }
    }
    await this.source.destroy(id);
  }
}

/** A `GraphStubSource` for a context that CAN spawn dedicated Workers (a page, or a driver worker): it
 *  spawns one Worker per graph and holds the direct stub locally. Used by the manager test and any non-SW
 *  host. (The Service Worker edge cannot use this — it uses the WorkerFactory source instead.) */
export class LocalWorkerSource implements GraphStubSource {
  private readonly workers = new Map<string, Worker>();

  /** `workerUrl` is the bundled graph-worker entry (`graph-worker.entry.ts`) served by the host. */
  constructor(private readonly workerUrl: string | URL) {}

  open(id: string): Promise<RpcStub<GraphWorkerHost>> {
    const { worker, port } = spawnGraphWorker(this.workerUrl, id);
    this.workers.set(id, worker);
    return Promise.resolve(newMessagePortRpcSession<GraphWorkerHost>(port));
  }

  async destroy(id: string): Promise<void> {
    const w = this.workers.get(id);
    if (w) {
      w.terminate(); // releases the graph's opfs-sahpool file handles
      this.workers.delete(id);
    }
    await removeOpfsDir(`.mogwai/${encodeURIComponent(id)}`);
  }
}
