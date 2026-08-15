import type { GraphManager, GraphInfo, RemoteExecutor, ForeignRow } from '../api.ts';
import { type Framed } from '../execute.ts';
import type { TypeNode } from '../gremlin/types.ts';
import { compilePlan, type Executable } from '../compiler/compiler.ts';
import { createCompileScope, type AppScope } from '../scopes.ts';
import { extendedRegistry } from '../services/standard.ts';
import type { GraphDatabase } from './graph-store-do.ts';
import { rpcUnwrap, type RpcResult } from './rpc.ts';

/** The edge-side executor for one DO: compile (and render) at the Worker (edge-compilation Phase 1/2a),
 *  then either ship the compiled plan to the DO's `runFramed`, or fall back to shipping the Gremlin
 *  string to `framed`. Across a DO RPC boundary everything is async, so it offers only the
 *  RemoteExecutor surface (framedAsync/raw); the sync framed()/buffers() need a local store and live on
 *  the DO's OWN in-process executor. `rpcUnwrap` turns a query failure back into a throw on THIS side of
 *  the boundary — the DO returns it as a value so workerd does not report a user's unsupported traversal
 *  as an uncaught DO exception (src/cloudflare/rpc.ts). */
class EdgeExecutor implements RemoteExecutor {
  constructor(
    private readonly stub: DurableObjectStub<GraphDatabase>,
    private readonly compileScope: AppScope,
  ) {}

  async framedAsync(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): Promise<Framed[]> {
    const plan = this.tryCompile(gremlin, params, paramTypes);
    // Non-load-bearing: any single-statement-or-program plan (a read OR a write — both are rendered,
    // transport-safe DATA since the Program refactor) ships to runFramed, so the DO does not recompile;
    // a segment (federation) or ANY compile throw falls back to shipping the string, so the DO stays the
    // single authority for the plan AND for error reporting. (Worker-driving the segment loop is 2b.)
    if (plan) return rpcUnwrap(await this.stub.runFramed(plan) as RpcResult<Framed[]>);
    return rpcUnwrap(await this.stub.framed(gremlin, params, paramTypes) as RpcResult<Framed[]>);
  }

  async raw(gremlin: string, params: Record<string, any>, depth: number): Promise<ForeignRow[]> {
    // Unchanged: the federated hop still ships the string; the segment loop moving Worker-side is Phase 2b.
    return rpcUnwrap(await this.stub.raw(gremlin, params, depth) as RpcResult<ForeignRow[]>);
  }

  /** Compile at the edge, claiming any NON-SEGMENT plan (a `read` Compiled or a `program` write — both
   *  cross the RPC as rendered data). A segment (federation) or ANY throw → null → string fallback. The
   *  throw is CAUGHT: a user's malformed traversal must surface via the DO's rpc trailer exactly as
   *  today, not as an edge exception, so an error yields null and the DO recompiles + reports it. */
  private tryCompile(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode>): Executable | null {
    try {
      const plan = compilePlan(gremlin, params, { app: this.compileScope, federationDepth: 0 }, paramTypes);
      return plan.kind === 'sql' ? plan.compiled : null;
    } catch {
      return null;
    }
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
   *  imported by both, so the config cannot drift. */
  private readonly compileScope = createCompileScope(extendedRegistry);
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
