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
import type { ForeignResult, ChangesFeed, RevsDiffRequest, RevsDiffResponse, BulkGetRef, WireChangeSet, ReplicateOptions, ReplicationStats, ConflictEntry } from '../api.ts';
import type { GraphWorkerHost } from './GraphWorkerHost.ts';
import { spawnGraphWorker, destroyGraphWorker } from './worker-spawn.ts';
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
  /** How many destroys each graph id has seen — a call that spans one was cut off by it (see `call`). */
  private readonly destroys = new Map<string, number>();

  constructor(private readonly source: GraphStubSource) {}

  /** Run `fn` against graph `id`'s current stub, retrying ONCE if the stub CHANGED across the failure —
   *  i.e. failover elected a new leader and the source disposed the dead stub (rejecting the hung call).
   *  A rejection with the SAME stub still current is a genuine query error and propagates unchanged (the
   *  router turns it into a GraphBinary trailer).
   *
   *  A call that a `destroy` of the same graph cut off is NOT a failover and is never retried: the stub
   *  changed because the graph is gone, so a retry would re-create the graph the destroy just removed and
   *  run the request against a fresh EMPTY one — a different question (a write re-applied to nothing, a
   *  read answered from no data, a runaway query restarted). It fails, naming why. */
  private async call<T>(id: string, fn: (stub: RpcStub<GraphWorkerHost>) => Promise<T>): Promise<T> {
    const epoch = this.destroys.get(id) ?? 0;
    const stub = await this.source.open(id);
    try {
      return await fn(stub);
    } catch (e) {
      if ((this.destroys.get(id) ?? 0) !== epoch) {
        throw new Error(`graph '${id}' was destroyed while this request was running`, { cause: e });
      }
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
      // The readable untyped-JSON path (content negotiation) — a JSON string needs no `rewrap` (unlike the
      // `Framed` buffers, it survives the port unchanged). `null` → the router falls back to GraphBinary.
      jsonAsync: (gremlin, params, paramTypes) =>
        this.call(id, ((s) => s.json(gremlin, params, paramTypes)) as Awaited$<string | null>),
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

  async changes(id: string, since: number, limit?: number, filter?: string): Promise<ChangesFeed> {
    return this.call(id, ((s) => s.changes(since, limit, filter)) as Awaited$<ChangesFeed>);
  }

  async matchSet(id: string, filter: string): Promise<readonly string[]> {
    return this.call(id, ((s) => s.matchSet(filter)) as Awaited$<string[]>);
  }

  async placement(id: string, placement: string, matchGids: readonly string[]): Promise<void> {
    return this.call(id, ((s) => s.placement(placement, matchGids)) as Awaited$<void>);
  }

  async revsDiff(id: string, request: RevsDiffRequest): Promise<RevsDiffResponse> {
    return this.call(id, ((s) => s.revsDiff(request)) as Awaited$<RevsDiffResponse>);
  }

  async bulkGet(id: string, refs: readonly BulkGetRef[]): Promise<WireChangeSet> {
    return this.call(id, ((s) => s.bulkGet(refs)) as Awaited$<WireChangeSet>);
  }

  async bulkDocs(id: string, changes: WireChangeSet): Promise<void> {
    await this.call(id, ((s) => s.bulkDocs(changes)) as Awaited$<void>);
  }

  async checkpoint(id: string, replicationId: string, seq?: number): Promise<number> {
    return this.call(id, ((s) => s.checkpoint(replicationId, seq)) as Awaited$<number>);
  }

  // The loop runs INSIDE the graph's Worker (it holds the store + outbound http), so the manager just
  // routes the call — the browser twin of the CF Worker→DO split.
  async replicate(id: string, opts: ReplicateOptions): Promise<ReplicationStats> {
    return this.call(id, ((s) => s.replicate(opts)) as Awaited$<ReplicationStats>);
  }

  async conflicts(id: string): Promise<readonly ConflictEntry[]> {
    return this.call(id, ((s) => s.conflicts()) as Awaited$<readonly ConflictEntry[]>);
  }

  async destroy(id: string): Promise<void> {
    this.destroys.set(id, (this.destroys.get(id) ?? 0) + 1); // before the source cuts in-flight calls off
    await this.source.destroy(id);
  }
}

/** A `GraphStubSource` for a context that CAN spawn dedicated Workers (a page, or a driver worker): it
 *  spawns one Worker per graph and holds the direct stub locally (idempotent — `open` returns the cached
 *  stub, so the manager's retry is a no-op here: a single context has no failover, and a rejection is a
 *  genuine query error). Used by the manager test and any non-SW host. */
export class LocalWorkerSource implements GraphStubSource {
  private readonly graphs = new Map<string, { worker: Worker; stub: RpcStub<GraphWorkerHost> }>();
  /** Teardowns in flight, by graph id. An `open` of that id waits for it, and a second `destroy` queues
   *  behind it: a Worker spawned mid-teardown would install its opfs-sahpool over a directory the old
   *  Worker still holds handles in, and the teardown's removal would then delete it under the NEW Worker. */
  private readonly destroying = new Map<string, Promise<void>>();

  /** `workerUrl` is the bundled graph-worker entry (`worker.ts`) served by the host; `config` (io()/
   *  federate host allowlist, etc.) rides each Worker's boot, matching the WorkerFactory path. */
  constructor(private readonly workerUrl: string | URL, private readonly config?: MogwaiConfig) {}

  async open(id: string): Promise<RpcStub<GraphWorkerHost>> {
    for (let p; (p = this.destroying.get(id)); ) await settled(p);
    let g = this.graphs.get(id);
    if (!g) {
      const { worker, port } = spawnGraphWorker(this.workerUrl, id, this.config);
      g = { worker, stub: newMessagePortRpcSession<GraphWorkerHost>(port) };
      this.graphs.set(id, g);
    }
    return g.stub;
  }

  /** Registers the teardown SYNCHRONOUSLY (before any await), so no `open` can slip in between the call
   *  and the old Worker leaving the map. */
  destroy(id: string): Promise<void> {
    const prev = this.destroying.get(id);
    const tracked: Promise<void> = (async () => {
      await settled(prev);
      const g = this.graphs.get(id);
      this.graphs.delete(id);
      try {
        g?.stub[Symbol.dispose]();
      } catch {
        /* already dead */
      }
      await destroyGraphWorker(g?.worker, id); // resolves only once the directory is gone
    })().finally(() => {
      if (this.destroying.get(id) === tracked) this.destroying.delete(id);
    });
    this.destroying.set(id, tracked);
    return tracked;
  }
}

/** Wait for an in-flight teardown to finish, whatever its outcome — its failure belongs to ITS caller. */
async function settled(p: Promise<void> | undefined): Promise<void> {
  await p?.catch(() => {});
}
