// The STORE tier of the browser port: what runs INSIDE a graph's dedicated Worker. One
// GraphWorkerHost = one graph = one Durable Object — a GraphStore over WasmSqlite on that graph's own
// opfs-sahpool database, plus the Executor that compiles + runs + frames its queries. The doc's
// mapping: Service Worker = edge (makeRouter + manager); per-graph Worker = store (this). The edge-compilation
// optimization (runFramed) is dropped in the browser — each Worker compiles and runs its own queries.
//
// This is the substance; the postMessage TRANSPORT that fronts it (the dedicated-worker entry the
// manager spawns) is a thin wrapper landed with the manager, where its RPC protocol is designed
// alongside the manager's routing. Keeping the host transport-free is what lets the browser lane
// drive it directly and prove the whole compiler+executor+wire stack runs in a browser over the REAL
// opfs-sahpool VFS (test/browser/workers/graph-worker.worker.ts).
import { GraphStore, type Sql } from '../storage.ts';
import { graphInfo, type GraphInfo } from '../manager.ts';
import { Executor, type Framed } from '../execute.ts';
import type { ForeignResult, ForeignTerminal } from '../api.ts';
import type { TypeNode } from '../gremlin/types.ts';
import type { RegistryProvider } from '../scopes.ts';
import type { FederationSource } from '../compiler/segment.ts';
import type { IoStore } from '../iostore.ts';
import { extendedRegistry } from '../services/standard.ts';
import { opfsSahpoolWasmSql } from './WasmSqlite.ts';

/** How a graph's synchronous store is opened. Defaults to that graph's own opfs-sahpool database (one
 *  DB per graph = one DO); a test injects an in-memory factory. Async only for the WASM/pool init. */
export type GraphSqlFactory = (graphId: string) => Promise<Sql>;

const opfsSahpoolFactory: GraphSqlFactory = (graphId) => opfsSahpoolWasmSql(`.mogwai/${encodeURIComponent(graphId)}`);

export interface GraphWorkerHostOptions {
  /** The service registry (federation on by default). */
  registry?: RegistryProvider;
  /** Where io() reads/writes documents — the browser's OpfsIoStore in production. Omitted → io() fails
   *  closed naming the missing binding. */
  io?: IoStore;
  /** How to open this graph's store. Defaults to its opfs-sahpool database. */
  makeSql?: GraphSqlFactory;
}

export class GraphWorkerHost {
  private constructor(
    readonly graphId: string,
    private readonly store: GraphStore,
    /** This graph's executor — also the endpoint a manager routes a SIBLING'S federated hop INTO
     *  (its `runForeign`), which is the cross-Worker twin of the Cloudflare DO's `raw`/`runForeign` RPC. */
    readonly executor: Executor,
  ) {}

  /** Open (or create-on-open) graph `graphId`'s store and build its executor. Idempotent at the SQL
   *  level: `GraphStore`'s ctor runs the schema DDL `IF NOT EXISTS`, so re-opening an existing graph's
   *  opfs-sahpool database restores a live host over its data. */
  static async open(graphId: string, opts: GraphWorkerHostOptions = {}): Promise<GraphWorkerHost> {
    const sql = await (opts.makeSql ?? opfsSahpoolFactory)(graphId);
    const store = new GraphStore(sql);
    let host: GraphWorkerHost;
    // Federation source: SELF resolves to this graph's own executor (a federate to one's own graph is
    // in-process); a SIBLING is a cross-Worker hop the manager routes, so fail closed here naming it
    // rather than silently opening the sibling's data in the wrong Worker. The closure reads `host` only
    // at federate time, by when it is assigned.
    const source: FederationSource = {
      executor: (id) => {
        if (id === graphId) return host.executor;
        throw new Error(
          `graph worker "${graphId}": cross-worker federation to "${id}" is routed by the manager, not the graph worker`,
        );
      },
    };
    const executor = new Executor(store, opts.registry ?? extendedRegistry, source, undefined, opts.io);
    host = new GraphWorkerHost(graphId, store, executor);
    return host;
  }

  /** Compile + run + frame a query to GraphBinary value buffers — what the manager/Service Worker streams back
   *  to the client. Async because a federated top-level call() drives its segment loop here. */
  framed(gremlin: string, params: Record<string, unknown>, paramTypes?: Record<string, TypeNode>): Promise<Framed[]> {
    return this.executor.framedAsync(gremlin, params, paramTypes);
  }

  /** The detached-row transfer a sibling's federated hop lands through — the manager invokes this
   *  when another graph's Worker federates INTO this one (the browser twin of the DO `runForeign` RPC). */
  runForeign(gremlin: string, params: Record<string, unknown>, depth: number, paramTypes?: Record<string, TypeNode>, terminal?: ForeignTerminal): Promise<ForeignResult> {
    return this.executor.runForeign(gremlin, params, depth, paramTypes, terminal);
  }

  /** Element counts (the management GET). */
  info(): GraphInfo {
    return graphInfo(this.store);
  }
}
// Lifecycle (removing this graph's opfs-sahpool database, terminating its Worker + releasing the pool's
// file handles) is the manager's concern — it owns the Worker — so the host exposes no close/destroy.
