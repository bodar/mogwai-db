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
import type { ForeignResult } from '../api.ts';
import type { BarrierInput } from '../services/spi/types.ts';

/** The data-plane payloads that may cross a DO RPC. `Framed[]` (framed()/runFramed()), `ForeignResult`
 *  (runForeign(), a federated hop — a shape-tagged result, elements or a reduced scalar), and `BarrierInput[]`
 *  (readHead(), Worker-driven federation §4·2). A new RPC that returns something else must add its
 *  payload here — the bound is deliberately closed. */
type RpcPayload = Framed[] | ForeignResult | BarrierInput[];

/** A failure crossing a DO RPC boundary as data. The brand key (`__rpcError`) is what `rpcUnwrap`
 *  discriminates on — a success payload never carries it (an array cannot, and `ForeignResult`'s
 *  `kind` tag is `'elements'`/`'scalar'`, never `__rpcError`). */
export interface RpcFailure {
  readonly __rpcError: string;
  readonly stack?: string;
}

/** `T` or a failure — the return type of every data-plane RPC on {@link GraphDatabase}. Restricted
 *  to the payloads in {@link RpcPayload} rather than generic over anything, so a new RPC has to say so.
 *  `runFramed` (Phase 1/2a) reuses the `Framed[]` arm; `readHead` (Phase 2b) adds the `BarrierInput[]`
 *  arm — its INPUT is a compiled head, its result the drained barrier-input rows. */
export type RpcResult<T extends RpcPayload> = T | RpcFailure;

/** Run a data-plane body, returning its failure rather than throwing it across the boundary. */
export async function rpcTry<T extends RpcPayload>(body: () => Promise<T>): Promise<RpcResult<T>> {
  try {
    return await body();
  } catch (e: any) {
    return { __rpcError: String(e?.message ?? e), stack: e?.stack };
  }
}

/** The caller half: rethrow what {@link rpcTry} captured, DO-side stack and all. Discriminate on the
 *  failure BRAND, not on shape — a success payload may now be a non-array object (`ForeignResult`), so
 *  "is it an array?" no longer separates success from failure; only `__rpcError` does. */
export function rpcUnwrap<T extends RpcPayload>(r: RpcResult<T>): T {
  if (!(r != null && typeof r === 'object' && '__rpcError' in r)) return r as T;
  const e = new Error(r.__rpcError);
  if (r.stack) e.stack = r.stack;
  throw e;
}
