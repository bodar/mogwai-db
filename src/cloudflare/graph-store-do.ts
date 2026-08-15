import { DurableObject } from 'cloudflare:workers';
import { type TypeNode } from '../gremlin/types.ts';
import { GraphStore } from '../storage.ts';
import { graphInfo } from '../manager.ts';
import type { GraphInfo, Executor, ForeignRow } from '../api.ts';
import { Executor as ExecutorImpl, frameResolved, type Framed } from '../execute.ts';
import type { Executable } from '../compiler/compiler.ts';
import { extendedRegistry } from '../services/standard.ts';
import { DurableObjectSqlite } from './DurableObjectSqlite.ts';
import { CloudflareGraphManager } from './cloudflare-graph-manager.ts';
import { R2IoStore } from './R2IoStore.ts';
import { rpcTry, type RpcResult } from './rpc.ts';

export interface Env {
  GRAPH: DurableObjectNamespace<GraphDatabase>;
  /** Optional graph-path prefix (`/{PATH_PREFIX}/{id}`); defaults to `gremlin`. Set as
   *  a Worker `var` in wrangler config to change it. The bare `/gremlin`
   *  stock-client endpoint is fixed and unaffected. */
  PATH_PREFIX?: string;
  /** Optional R2 bucket backing io() — where `io("data/x.json")` resolves. A binding, so an
   *  operator opts in per deployment; absent, io() fails closed naming it (NO_IO_STORE). */
  IO?: R2Bucket;
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
    // The R2 binding is read INSIDE the DO (bindings are a property of a DO's env exactly as they
    // are a Worker's), so a whole-graph read/write happens where the graph lives.
    const io = this.env.IO ? new R2IoStore(this.env.IO) : undefined;
    return new ExecutorImpl(this.store, extendedRegistry, new CloudflareGraphManager(this.env.GRAPH), undefined, io);
  }

  /** Data-plane RPC: compile + run + FRAME inside the DO (concern B, client wire path). The edge
   *  Worker parsed the wire and resolved the graph; it wraps the returned framed buffers into the
   *  HTTP response (concern C). Returning the materialized array (bytes only) keeps HTTP out of
   *  the storage tier. */
  async framed(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): Promise<RpcResult<Framed[]>> {
    return rpcTry(() => this.executor().framedAsync(gremlin, params, paramTypes));
  }

  /** Data-plane RPC: run + FRAME an ALREADY-COMPILED plan — a `read` Compiled or a `program` write,
   *  both plain rendered DATA (edge-compilation Phase 1 + 2a). The edge Worker compiled AND rendered it
   *  — compile is pure and touches no store — so the DO does only what needs the store: execute + frame,
   *  through the SAME `frameResolved` the string path uses, so the wire result is byte-identical. No
   *  parse, no compile, no emit, no registry, no executor. The edge ships any NON-segment plan here; a
   *  segment (federation) still takes `framed(gremlin)` until Phase 2b.
   *
   *  SECURITY (edge-compilation §5): unlike `framed(gremlin)`, which runs only what the compiler
   *  produces from a Gremlin string, this runs raw SQL + binds the CALLER supplies — a wider surface,
   *  and for a write it is a caller-supplied MUTATION. Same trust domain today (only the paired Worker
   *  holds this DO binding); it would be a real widening the moment anything else can reach this stub. */
  async runFramed(plan: Executable): Promise<RpcResult<Framed[]>> {
    return rpcTry(async () => {
      this.ensureLive();
      return [...frameResolved(this.store, plan)];
    });
  }

  /** Data-plane RPC: the INTERNAL raw-row path — a federated hop FROM a sibling DO lands here.
   *  Returns detached ForeignRow[] (no GraphBinary; the client edge frames only the final
   *  result). `depth` is the federation recursion depth of this hop (guarded in the service). */
  async raw(gremlin: string, params: Record<string, any>, depth: number): Promise<RpcResult<ForeignRow[]>> {
    return rpcTry(() => this.executor().raw(gremlin, params, depth));
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
