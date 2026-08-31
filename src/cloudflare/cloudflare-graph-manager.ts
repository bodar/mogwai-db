import type { GraphManager, GraphInfo, RemoteExecutor, ForeignResult, ForeignTerminal } from '../api.ts';
import { type Framed } from '../execute.ts';
import type { TypeNode } from '../gremlin/types.ts';
import { compilePlan } from '../compiler/compiler.ts';
import { driveSegmentsFrom } from '../drive.ts';
import { createCompileScope, type AppScope } from '../scopes.ts';
import { extendedRegistry } from '../services/standard.ts';
import type { Compiled } from '../sql/kernel/render.ts';
import type { BarrierInput } from '../services/spi/types.ts';
import type { GraphDatabase } from './graph-store-do.ts';
import { rpcUnwrap, type RpcFailure, type RpcResult } from '../rpc.ts';

/** The edge-side executor for one DO: compile (and render) at the Worker (edge-compilation), then run
 *  the plan on the DO. A non-segment plan (read or write) ships to `runFramed`; a federation segment is
 *  DRIVEN from the Worker (§4·2) when its barrier is `worker`-resident; anything else falls back to
 *  shipping the Gremlin string to `framed`. Across a DO RPC boundary everything is async, so it offers
 *  only the RemoteExecutor surface (framedAsync/runForeign); the sync framed()/buffers() need a local store and
 *  live on the DO's OWN in-process executor. `rpcUnwrap` turns a query failure back into a throw on THIS
 *  side of the boundary — the DO returns it as a value so workerd does not report a user's unsupported
 *  traversal as an uncaught DO exception (src/cloudflare/rpc.ts). */
class EdgeExecutor implements RemoteExecutor {
  constructor(
    private readonly stub: DurableObjectStub<GraphDatabase>,
    private readonly compileScope: AppScope,
  ) {}

  async framedAsync(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): Promise<Framed[]> {
    let plan;
    // A compile throw (a user's malformed traversal) must surface via the DO's rpc trailer exactly as
    // today, not as an edge exception — so an error falls back and the DO recompiles + reports it.
    try { plan = compilePlan(gremlin, params, { app: this.compileScope, federationDepth: 0 }, paramTypes); }
    catch { return this.runOnDo(gremlin, params, paramTypes); }

    // A single-statement-or-program plan (read OR write — both rendered, transport-safe data) runs on
    // the DO via runFramed; the DO does not recompile.
    if (plan.kind === 'sql') return rpcUnwrap(await this.stub.runFramed(plan.compiled) as RpcResult<Framed[]>);

    // A barrier segment. If it is ASYNC and may LEAVE the DO (`worker` — federate), the WORKER drives the
    // loop: `apply` fans out to siblings from here (via this manager's `runForeign`), and the DO runs only the
    // brief head read and the final framing (its request closes across the sibling waits). Everything else
    // stays DO-driven via the string fallback: an async `do` barrier (io) needs the store the Worker
    // lacks, and a SYNC barrier (regex) is always local and atomic — the DO runs its no-await segment loop.
    if (plan.mode === 'async' && plan.residency === 'worker') {
      const final = await driveSegmentsFrom(
        // A Worker-driven loop reads an async barrier's head by RPC; a sync barrier is never Worker-driven,
        // so its reader throws rather than pretend the Worker holds a store.
        // A Worker-driven loop drives only `federate` (worker residency), which returns detached rows,
        // never a barrier-state relation run — so there is nothing to drop and `dropRuns` is a no-op.
        // A 'do'-residency OLAP barrier (which allocates runs) never reaches this Worker loop.
        { readHead: (head) => this.readHead(head), readHeadSync: () => { throw new Error('a sync barrier cannot be Worker-driven — it runs on the DO'); }, dropRuns: () => {} },
        plan,
      );
      return rpcUnwrap(await this.stub.runFramed(final) as RpcResult<Framed[]>);
    }
    return this.runOnDo(gremlin, params, paramTypes);
  }

  async runForeign(gremlin: string, params: Record<string, any>, depth: number, _paramTypes?: Record<string, TypeNode>, terminal?: ForeignTerminal): Promise<ForeignResult> {
    // A federated hop INTO a sibling: ships the string; the sibling DO runs its own (possibly nested)
    // traversal. Only the TOP loop is Worker-driven — a deeper hop is a self-contained sibling request.
    // `terminal` threads the reducer-vs-values-stream hint across the RPC so the sibling DO frames the
    // pushed terminal correctly (a `count()` scalar vs a `values(k)` stream — see `ForeignTerminal`).
    // The DO stub's RPC-proxy type expands `ForeignResult`'s nested unions past tsc's instantiation
    // depth limit (a Cloudflare-types limitation, not ours), so this ONE call goes through `any` and we
    // re-assert the real result shape — `rpcUnwrap` needs only the failure-brand discriminant.
    const r = await (this.stub as any).runForeign(gremlin, params, depth, terminal) as ForeignResult | RpcFailure;
    return rpcUnwrap<ForeignResult>(r);
  }

  /** Run a barrier segment's head on the DO — the one store touch a Worker-driven loop needs mid-flight. */
  private async readHead(head: Compiled): Promise<BarrierInput[]> {
    return rpcUnwrap(await this.stub.readHead(head) as RpcResult<BarrierInput[]>);
  }

  /** The fallback: hand the whole traversal to the DO's own compile+drive (`framed`), so the DO stays
   *  the single authority for the plan and for errors. */
  private async runOnDo(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode>): Promise<Framed[]> {
    return rpcUnwrap(await this.stub.framed(gremlin, params, paramTypes) as RpcResult<Framed[]>);
  }
}

/** The Cloudflare half of the graph-lifecycle seam AND the executor factory / federation source.
 *  The DO namespace maps a graph id to its DO (`getByName`); `executor(id)` returns an `EdgeExecutor`
 *  that compiles at the edge and forwards to that DO's RPCs. Lifecycle verbs are DO RPC. Being the
 *  executor factory makes it the FederationSource: a federated call inside one DO reaches a sibling
 *  DO through exactly this executor(id). */
export class CloudflareGraphManager implements GraphManager {
  /** The store-free scope the edge compiles with. It MUST mirror the DO's `executor()` compile config
   *  — `extendedRegistry` and fastPaths→DEFAULT (graph-store-do.ts passes `undefined`) — so the edge
   *  ships exactly the plan the DO would have compiled. `extendedRegistry` is the ONE shared symbol,
   *  imported by both, so the config cannot drift. `source: this` lets a Worker-driven federate `apply`
   *  hop siblings through this same manager (it IS a `FederationSource`); inert at compile (§4·3). */
  private readonly compileScope = createCompileScope(extendedRegistry, { source: this });
  constructor(private ns: DurableObjectNamespace<GraphDatabase>) {}

  executor(id: string): RemoteExecutor {
    return new EdgeExecutor(this.ns.getByName(id), this.compileScope);
  }
  create(id: string): Promise<void> {
    return this.ns.getByName(id).create();
  }
  info(id: string): Promise<GraphInfo> {
    return this.ns.getByName(id).info();
  }
  destroy(id: string): Promise<void> {
    return this.ns.getByName(id).destroy();
  }
}
