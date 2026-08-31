// The COORDINATOR — the browser's GraphManager, the twin of CloudflareGraphManager (id → Durable
// Object) and BunGraphManager (id → in-process store). Here: id → that graph's dedicated Worker. It
// runs in a PAGE (a Window), because only a Window can spawn dedicated Workers — a Service Worker
// cannot (verified: `Worker` is undefined in ServiceWorkerGlobalScope). So the Service Worker HTTP edge brokers an
// intercepted fetch to a page hosting this coordinator; the coordinator spawns/holds the graph Workers
// and hands `makeRouter` a RemoteExecutor per graph. Concurrency is many graphs on many Workers (many
// threads), never within one graph — exactly where Cloudflare gets it (one DO, run-to-completion).
//
// This is the SINGLE-TAB coordinator: one page owns its graphs' Workers. Cross-tab leader election +
// failover (one graph shared across tabs via Web Locks + a SharedService port broker) is a separate,
// deferred increment; nothing here forecloses it — a leader-elected variant wraps the same spawn.
import type { GraphManager, GraphInfo, RemoteExecutor } from '../manager.ts';
import { GraphWorkerClient } from './GraphWorkerClient.ts';

interface Graph {
  worker: Worker;
  client: GraphWorkerClient;
  /** Resolves once `open` has booted the host — every op awaits it, so a query issued immediately after
   *  first addressing a graph still runs against an opened store (create-on-demand, like the DO). */
  opened: Promise<GraphInfo>;
}

export class BrowserCoordinator implements GraphManager {
  private readonly graphs = new Map<string, Graph>();

  /** `workerUrl` is the bundled graph-worker entry (graph-worker.entry.ts) the page serves; `type:
   *  'module'` because it is an ESM bundle. */
  constructor(private readonly workerUrl: string | URL) {}

  /** Get (or spawn on demand) graph `id`'s Worker — the browser twin of DO-on-first-access. */
  private resolve(id: string): Graph {
    let g = this.graphs.get(id);
    if (!g) {
      const worker = new Worker(this.workerUrl, { type: 'module', name: id });
      const client = new GraphWorkerClient(worker);
      g = { worker, client, opened: client.open(id) };
      this.graphs.set(id, g);
    }
    return g;
  }

  /** A RemoteExecutor bound to graph `id`'s Worker (the router needs only this). Every call awaits the
   *  graph's `open` first, so the store is live before a query runs. */
  executor(id: string): RemoteExecutor {
    const g = this.resolve(id);
    return {
      framedAsync: async (gremlin, params, paramTypes) => {
        await g.opened;
        return g.client.framed(gremlin, params, paramTypes);
      },
      runForeign: async (gremlin, params, depth, paramTypes, terminal) => {
        await g.opened;
        return g.client.runForeign(gremlin, params, depth, paramTypes, terminal);
      },
    };
  }

  async create(id: string): Promise<void> {
    await this.resolve(id).opened; // idempotent: opening runs the schema, materializing an empty graph
  }

  async info(id: string): Promise<GraphInfo> {
    const g = this.resolve(id);
    await g.opened;
    return g.client.info();
  }

  /** Teardown: terminate the graph's Worker (releasing its opfs-sahpool file handles) and drop it, then
   *  remove its OPFS database directory so a re-address recreates the graph EMPTY (CF's deleteAll twin).
   *  Best-effort removal — a still-releasing handle is retried-free here; the schema DDL on the next
   *  open restores a clean empty graph regardless. */
  async destroy(id: string): Promise<void> {
    const g = this.graphs.get(id);
    if (g) {
      g.client.terminate();
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
