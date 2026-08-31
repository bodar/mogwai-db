// The browser's GraphManager — the twin of CloudflareGraphManager (id → Durable Object) and
// BunGraphManager (id → in-process store). Here: id → that graph's dedicated Worker. It runs in a PAGE
// (a Window), because only a Window can spawn dedicated Workers — a Service Worker cannot (verified:
// `Worker` is undefined in ServiceWorkerGlobalScope). So the Service Worker HTTP edge brokers an
// intercepted fetch to a page hosting this manager; the manager spawns/holds the graph Workers and hands
// `makeRouter` a RemoteExecutor per graph. Concurrency is many graphs on many Workers (many threads),
// never within one graph — exactly where Cloudflare gets it (one DO, run-to-completion).
//
// This is the SINGLE-TAB manager: one page owns its graphs' Workers. Cross-tab leader election + failover
// (one graph shared across tabs via Web Locks + a SharedService port broker) is a separate, deferred
// increment; nothing here forecloses it — a leader-elected variant wraps the same spawn.
import { newMessagePortRpcSession, type RpcStub } from 'capnweb';
import type { GraphManager, GraphInfo, RemoteExecutor } from '../manager.ts';
import type { GraphWorkerHost } from './GraphWorkerHost.ts';

interface Graph {
  worker: Worker;
  /** The Cap'n Web stub to the graph's GraphWorkerHost (over a per-graph MessagePort). Calls made
   *  before the Worker finishes opening its host queue on the port, so the create-on-demand gap is safe. */
  stub: RpcStub<GraphWorkerHost>;
  /** Resolves once the Worker has booted the host — a first `info()` doubles as the open confirmation.
   *  Every op awaits it so a query issued immediately after first addressing a graph runs against an
   *  opened store, and an open FAILURE surfaces here (the stub rejects) rather than hanging. */
  opened: Promise<GraphInfo>;
}

export class BrowserGraphManager implements GraphManager {
  private readonly graphs = new Map<string, Graph>();

  /** `workerUrl` is the bundled graph-worker entry (graph-worker.entry.ts) the page serves; `type:
   *  'module'` because it is an ESM bundle. */
  constructor(private readonly workerUrl: string | URL) {}

  /** Get (or spawn on demand) graph `id`'s Worker — the browser twin of DO-on-first-access. Spawns the
   *  Worker, opens a MessageChannel, hands the Worker `port2` + the graphId as its first message (so it
   *  opens THIS graph's host and serves RPC there), and holds the Cap'n Web stub over `port1`. */
  private resolve(id: string): Graph {
    let g = this.graphs.get(id);
    if (!g) {
      const worker = new Worker(this.workerUrl, { type: 'module', name: id });
      const channel = new MessageChannel();
      worker.postMessage({ port: channel.port2, graphId: id }, [channel.port2]);
      const stub = newMessagePortRpcSession<GraphWorkerHost>(channel.port1);
      // `info()` resolves only after the Worker's `open` completes, so awaiting it confirms the graph is
      // live (and rejects with the reason if open failed) — it stands in for the old explicit `open` RPC.
      g = { worker, stub, opened: Promise.resolve(stub.info()) };
      this.graphs.set(id, g);
    }
    return g;
  }

  /** A RemoteExecutor bound to graph `id`'s Worker (the router needs only this). Every call awaits the
   *  graph's open first, so the store is live before a query runs. The framed buffers arrive as
   *  `Uint8Array` across the port, so re-wrap each as `Buffer` — that restores the `Framed` contract
   *  (`buf: Buffer`) the response framer (`streamBuffers` → `Buffer.concat`) relies on, at the one seam. */
  executor(id: string): RemoteExecutor {
    const g = this.resolve(id);
    return {
      framedAsync: async (gremlin, params, paramTypes) => {
        await g.opened;
        return (await g.stub.framed(gremlin, params, paramTypes)).map((f) => ({ buf: Buffer.from(f.buf), bulk: f.bulk }));
      },
      runForeign: async (gremlin, params, depth, paramTypes, terminal) => {
        await g.opened;
        return g.stub.runForeign(gremlin, params, depth, paramTypes, terminal);
      },
    };
  }

  async create(id: string): Promise<void> {
    await this.resolve(id).opened; // idempotent: opening runs the schema, materializing an empty graph
  }

  async info(id: string): Promise<GraphInfo> {
    const g = this.resolve(id);
    await g.opened;
    return g.stub.info();
  }

  /** Teardown: terminate the graph's Worker (releasing its opfs-sahpool file handles) and drop it, then
   *  remove its OPFS database directory so a re-address recreates the graph EMPTY (CF's deleteAll twin).
   *  Best-effort removal — a still-releasing handle is retried-free here; the schema DDL on the next
   *  open restores a clean empty graph regardless. */
  async destroy(id: string): Promise<void> {
    const g = this.graphs.get(id);
    if (g) {
      g.stub[Symbol.dispose](); // drop the RPC session; terminating the Worker tears down its port too
      g.worker.terminate();
      this.graphs.delete(id);
    }
    await removeOpfsDir(`.mogwai/${encodeURIComponent(id)}`);
  }
}

/** Remove an OPFS directory (recursively) if present; a missing directory is a no-op. Navigates to the
 *  PARENT and removes only the leaf, so `.mogwai/<id>` never removes the whole `.mogwai` tree. */
async function removeOpfsDir(path: string): Promise<void> {
  const segs = path.split('/').filter((s) => s.length > 0);
  const leaf = segs.pop();
  if (leaf === undefined) return;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const seg of segs) dir = await dir.getDirectoryHandle(seg, { create: false });
    await dir.removeEntry(leaf, { recursive: true });
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
  }
}
