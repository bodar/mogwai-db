import { DurableObject } from 'cloudflare:workers';
import { type TypeNode } from '../gremlin/types.ts';
import { GraphStore } from '../storage.ts';
import { graphInfo, changesFeed, revsDiff } from '../manager.ts';
import { bulkGet, applyWire, checkpoint as storeCheckpoint, conflictsFeed } from '../replicate.ts';
import type { GraphInfo, ChangesFeed, RevsDiffRequest, RevsDiffResponse, BulkGetRef, WireChangeSet, ConflictEntry, Executor, ForeignResult, ForeignTerminal } from '../api.ts';
import { Executor as ExecutorImpl, frameResolved, readSegmentHead, type Framed } from '../execute.ts';
import type { Compiled, Executable } from '../compiler/compiler.ts';
import type { BarrierInput } from '../services/spi/types.ts';
import { extendedRegistry } from '../services/standard.ts';
import { DurableObjectSqlite } from './DurableObjectSqlite.ts';
import { CloudflareGraphManager } from './cloudflare-graph-manager.ts';
import { R2IoStore } from './R2IoStore.ts';
import { NO_IO_STORE } from '../iostore.ts';
import { allowlistedHttp } from '../http-allowlist.ts';
import { configFromWorkerEnv, type WorkerConfigEnv } from '../config.ts';
import { httpAwareIoStore } from '../http-io.ts';
import { rpcTry, type RpcFailure, type RpcResult } from '../rpc.ts';
import type { ReplicatorRegistryDO } from './replicator-registry-do.ts';

// Env extends WorkerConfigEnv, which carries the shared config source: `PATH_PREFIX`, the outbound-HTTP
// `HTTP_ALLOWLIST`, and the structured `CONFIG` object var (Wrangler `vars` can hold a JSON object, so
// io()/federate config rides in `env` as an adjacent object — see src/config.ts).
export interface Env extends WorkerConfigEnv {
  GRAPH: DurableObjectNamespace<GraphDatabase>;
  /** The singleton control-plane registry DO (§9·2) — holds ongoing-replication config/job state, read by
   *  the worker-residency scheduler; serves the top-level `/_replicator` CRUD. Bound in wrangler.jsonc. */
  REPLICATOR: DurableObjectNamespace<ReplicatorRegistryDO>;
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
    // io() and any http(s) federate target go through the ALLOWLISTED transport (SSRF guard,
    // src/http-allowlist.ts): the URL comes from a client's Gremlin query, so it is confined to the
    // operator's host allowlist (empty ⇒ deny all). Both the io store AND the sibling-federate manager
    // get the same guarded `http`; any non-URL io path still resolves against the R2 binding.
    const http = allowlistedHttp(configFromWorkerEnv(this.env).httpAllowlist);
    const io = httpAwareIoStore(this.env.IO ? new R2IoStore(this.env.IO) : NO_IO_STORE, http);
    return new ExecutorImpl(this.store, extendedRegistry, new CloudflareGraphManager(this.env.GRAPH, http), undefined, io);
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

  /** Data-plane RPC: run a barrier segment's HEAD and return the drained barrier-input rows
   *  (edge-compilation Phase 2b, Worker-driven federation §4·2). The Worker holds the segment loop and
   *  its `apply` (fanning out to siblings); the DO runs only this brief head read against its store and
   *  its request closes, instead of being held open across every sibling hop. The head is a `Compiled`
   *  the Worker compiled — plain data — and the result is plain `BarrierInput`-shaped rows. */
  async readHead(head: Compiled): Promise<RpcResult<BarrierInput[]>> {
    return rpcTry(async () => {
      this.ensureLive();
      return readSegmentHead(this.store, head);
    });
  }

  /** Data-plane RPC: the INTERNAL runForeign-result path — a federated hop FROM a sibling DO lands here.
   *  Returns a detached `ForeignResult` (no GraphBinary; the client edge frames only the final result) —
   *  elements, a pushed-down reduced scalar, or a pushed-down value stream. `depth` is the federation
   *  recursion depth of this hop; `terminal` is the reducer-vs-values-stream hint (`ForeignTerminal`),
   *  threaded from the calling Worker so the sibling frames the pushed terminal correctly. */
  async runForeign(gremlin: string, params: Record<string, any>, depth: number, terminal?: ForeignTerminal): Promise<ForeignResult | RpcFailure> {
    return rpcTry(() => this.executor().runForeign(gremlin, params, depth, {}, terminal));
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

  changes(since: number, limit?: number, filter?: string): ChangesFeed {
    this.ensureLive();
    // A `filter` (filtered-replication-plan F1) runs against THIS DO's own store + executor, closing the
    // 1-hop subgraph around the matched vertices. A non-vertex filter throws (crossing the RPC boundary
    // as a value via the caller's rpcTry, like any query failure).
    const match = filter ? this.executor().filterVertexIds(filter) : undefined;
    return changesFeed(this.store, since, limit, match);
  }

  revsDiff(request: RevsDiffRequest): RevsDiffResponse {
    this.ensureLive();
    return revsDiff(this.store, request);
  }

  bulkGet(refs: readonly BulkGetRef[]): WireChangeSet {
    this.ensureLive();
    return bulkGet(this.store, refs);
  }

  bulkDocs(changes: WireChangeSet): void {
    this.ensureLive();
    applyWire(this.store, changes);
  }

  checkpoint(replicationId: string, seq?: number): number {
    this.ensureLive();
    return storeCheckpoint(this.store, replicationId, seq);
  }

  conflicts(): readonly ConflictEntry[] {
    this.ensureLive();
    return conflictsFeed(this.store);
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
