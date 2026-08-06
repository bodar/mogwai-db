import type { GraphManager, GraphInfo, RemoteExecutor, ForeignRow } from '../api.ts';
import { type Framed } from '../execute.ts';
import type { GraphDatabase } from './graph-store-do.ts';
import { rpcUnwrap, type RpcResult } from './rpc.ts';

/** The Cloudflare half of the graph-lifecycle seam AND the executor factory / federation source.
 *  The DO namespace maps a graph id to its DO (`getByName`); `executor(id)` returns an adapter
 *  whose framed/raw forward into that DO's RPCs (which run the in-DO Executor). Lifecycle verbs
 *  are DO RPC. Being the executor factory makes it the FederationSource: a federated call inside
 *  one DO reaches a sibling DO through exactly this executor(id). */
export class CloudflareGraphManager implements GraphManager {
  constructor(private ns: DurableObjectNamespace<GraphDatabase>) {}

  executor(id: string): RemoteExecutor {
    const stub = this.ns.getByName(id);
    // Across a DO RPC boundary everything is async, so this adapter offers only the RemoteExecutor
    // surface (framedAsync/raw). The sync framed()/buffers() need a local store and live on the
    // DO's OWN in-process executor, not here.
    // `rpcUnwrap` turns a query failure back into a throw on THIS side of the boundary — the DO
    // returns it as a value so workerd does not report a user's unsupported traversal as an
    // uncaught DO exception (src/cloudflare/rpc.ts).
    return {
      framedAsync: async (gremlin, params, paramTypes = {}) =>
        rpcUnwrap(await stub.framed(gremlin, params, paramTypes) as RpcResult<Framed[]>),
      raw: async (gremlin, params, depth) =>
        rpcUnwrap(await stub.raw(gremlin, params, depth) as RpcResult<ForeignRow[]>),
    };
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
