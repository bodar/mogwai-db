// A FAILED QUERY IS NOT A CRASHED DURABLE OBJECT.
//
// `GraphDatabase.framed`/`raw` are RPC methods, and a throw that crosses a DO RPC boundary is an
// UNCAUGHT EXCEPTION as far as workerd is concerned: it logs the error plus a full stack (that is
// the `✘ [ERROR] Uncaught Error: …` block, which under `wrangler dev` also fires for every
// deliberately-negative test) and counts it in the DO's error rate. But the overwhelmingly common
// throw here is a USER error — an unsupported traversal, a bad predicate — which the router already
// catches and returns to the client on the GraphBinary trailer. Reporting that as a DO crash is
// wrong twice: it pollutes production observability with user typos, and it makes the suite's real
// failures unreadable.
//
// So a query failure crosses the boundary as a VALUE, and the caller side (CloudflareGraphManager)
// turns it straight back into a throw. Observable behaviour is unchanged — the client still sees
// the same message on the same trailer — and the DO's stack travels with it, so nothing that was
// diagnosable before stops being diagnosable. Genuine platform faults (a storage error, an OOM)
// still throw for real, because they are not raised through this path.
import type { Framed } from '../execute.ts';
import type { ForeignRow } from '../api.ts';

/** A failure crossing a DO RPC boundary as data. The brand key is deliberately obscure: the
 *  success arms are arrays, so no legitimate payload can be mistaken for one. */
export interface RpcFailure {
  readonly __rpcError: string;
  readonly stack?: string;
}

/** `T` or a failure — the return type of every data-plane RPC on {@link GraphDatabase}. Restricted
 *  to the two payloads that exist rather than generic over anything, so a new RPC has to say so.
 *  `runFramed` (edge-compilation Phase 1) reuses the `Framed[]` arm — its INPUT is a compiled plan,
 *  but its result is still framed buffers — so this type is unchanged; only the arm count of RPCs
 *  sharing it grew. */
export type RpcResult<T extends Framed[] | ForeignRow[]> = T | RpcFailure;

/** Run a data-plane body, returning its failure rather than throwing it across the boundary. */
export async function rpcTry<T extends Framed[] | ForeignRow[]>(body: () => Promise<T>): Promise<RpcResult<T>> {
  try {
    return await body();
  } catch (e: any) {
    return { __rpcError: String(e?.message ?? e), stack: e?.stack };
  }
}

/** The caller half: rethrow what {@link rpcTry} captured, DO-side stack and all. */
export function rpcUnwrap<T extends Framed[] | ForeignRow[]>(r: RpcResult<T>): T {
  if (Array.isArray(r)) return r;
  const e = new Error(r.__rpcError);
  if (r.stack) e.stack = r.stack;
  throw e;
}
