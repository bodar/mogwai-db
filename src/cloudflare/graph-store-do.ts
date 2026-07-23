import { DurableObject } from 'cloudflare:workers';
import { type TypeNode } from '../gremlin/types.ts';
import { GraphStore } from '../storage.ts';
import { graphInfo } from '../manager.ts';
import type { GraphInfo, Executor, ForeignRow } from '../api.ts';
import { Executor as ExecutorImpl, type Framed } from '../execute.ts';
import { extendedRegistry } from '../services/standard.ts';
import { DurableObjectSqlite } from './DurableObjectSqlite.ts';
import { CloudflareGraphManager } from './cloudflare-graph-manager.ts';

export interface Env {
  GRAPH: DurableObjectNamespace<GraphDatabase>;
  /** Optional graph-path prefix (`/{PATH_PREFIX}/{id}`); defaults to `gremlin`. Set as
   *  a Worker `var` in wrangler config to change it. The bare `/gremlin`
   *  stock-client endpoint is fixed and unaffected. */
  PATH_PREFIX?: string;
}

/** One Durable Object = one isolated graph database. The DO owns a
 *  `ctx.storage.sql`-backed store; the request handler is the same
 *  runtime-agnostic one the Bun server uses. Lifecycle (create/info/destroy)
 *  is exposed as RPC the Worker's `GraphManager` calls — `destroy` uses
 *  `ctx.storage.deleteAll()`, the only way to fully remove a DO's storage
 *  (dropping tables leaves internal metadata behind). */
export class GraphDatabase extends DurableObject<Env> {
  private store: GraphStore;
  // Set by destroy(): this warm instance's storage was wiped. CF doesn't evict
  // the instance synchronously, so if it's reused before eviction we must
  // restore the schema first (see ensureLive). Left false and abandoned, the
  // storage stays empty so the DO is GC-eligible and stops billing.
  private wiped = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema DDL runs synchronously here (GraphStore ctor); no async init, so
    // no blockConcurrencyWhile needed — it completes before any RPC.
    this.store = new GraphStore(new DurableObjectSqlite(ctx.storage.sql));
  }

  /** Restore the schema if this instance was wiped by a prior destroy() and is
   *  now being reused (CF kept it warm rather than evicting it). Recreates an
   *  empty graph on demand — the same semantics as Bun rebuilding a dropped
   *  store, and as a cold instance whose ctor reruns the DDL. */
  private ensureLive(): void {
    if (this.wiped) {
      this.store.initSchema();
      this.wiped = false;
    }
  }

  /** This DO's per-graph Executor: its own store + the extended registry (federation on) + a
   *  federation SOURCE that reaches SIBLING DOs through this DO's own namespace binding
   *  (this.env.GRAPH). So a federated call() running inside this DO projects down to another DO
   *  via the same executor(id) seam — genuine cross-DO pushdown, same shape as Bun in-process. */
  private executor(): Executor {
    this.ensureLive();
    return new ExecutorImpl(this.store, extendedRegistry, new CloudflareGraphManager(this.env.GRAPH));
  }

  /** Data-plane RPC: compile + run + FRAME inside the DO (concern B, client wire path). The edge
   *  Worker parsed the wire and resolved the graph; it wraps the returned framed buffers into the
   *  HTTP response (concern C). Returning the materialized array (bytes only) keeps HTTP out of
   *  the storage tier. */
  async framed(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): Promise<Framed[]> {
    return this.executor().framedAsync(gremlin, params, paramTypes);
  }

  /** Data-plane RPC: the INTERNAL raw-row path — a federated hop FROM a sibling DO lands here.
   *  Returns detached ForeignRow[] (no GraphBinary; the client edge frames only the final
   *  result). `depth` is the federation recursion depth of this hop (guarded in the service). */
  async raw(gremlin: string, params: Record<string, any>, depth: number): Promise<ForeignRow[]> {
    return this.executor().raw(gremlin, params, depth);
  }

  // ---- lifecycle RPC (called by CloudflareGraphManager) ----

  /** No-op beyond materializing the graph: constructing the DO already ran the
   *  schema DDL, so simply addressing it has created it. Present for symmetry. */
  create(): void {
    this.ensureLive();
  }

  info(): GraphInfo {
    this.ensureLive();
    return graphInfo(this.store);
  }

  /** Fully remove this graph's storage. `deleteAll()` is the only way to clear
   *  a DO to zero (and stop billing); a comp date >= 2026-02-24 also drops the
   *  alarm — we set none, so it's moot either way. Mark the instance wiped so a
   *  reuse before eviction restores the schema (ensureLive). */
  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.wiped = true;
  }
}
