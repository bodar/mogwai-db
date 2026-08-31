// A FAILED QUERY IS NOT A CRASHED BOUNDARY — the runtime-neutral failure-as-value contract for every
// STRUCTURED-CLONE RPC seam the data plane crosses. Two implement it, for the same reason:
//
//   - the Durable Object RPC boundary (`GraphDatabase.framed`/`raw`): a throw that crosses it is an
//     UNCAUGHT EXCEPTION to workerd — it logs a full stack (the `✘ [ERROR] Uncaught Error: …` block,
//     which under `wrangler dev` fires for every deliberately-negative test) and counts it in the DO's
//     error rate;
//   - the browser dedicated-Worker `postMessage` boundary (the graph-worker transport, src/browser/*):
//     a throw out of an `onmessage` handler is an uncaught error on the Worker, surfaced on the page's
//     `worker.onerror` with no reply — the RPC would simply hang.
//
// In both, the overwhelmingly common throw is a USER error — an unsupported traversal, a bad predicate —
// which the router already returns to the client on the GraphBinary trailer. So a query failure crosses
// the boundary as a VALUE, and the caller side turns it straight back into a throw. Observable behaviour
// is unchanged (same message, same trailer) and the far-side STACK travels with it, so nothing
// diagnosable stops being so. Genuine platform faults (a storage error, an OOM) still throw for real —
// they are not raised through this path.
import type { Framed } from './execute.ts';
import type { ForeignResult } from './api.ts';
import type { BarrierInput } from './services/spi/types.ts';

/** The data-plane payloads that may cross a data-plane RPC boundary (a DO RPC or a browser Worker
 *  postMessage). `Framed[]` (framed()/runFramed()), `ForeignResult`
 *  (runForeign(), a federated hop — a shape-tagged result, elements or a reduced scalar), and `BarrierInput[]`
 *  (readHead(), Worker-driven federation §4·2). A new RPC that returns something else must add its
 *  payload here — the bound is deliberately closed. */
type RpcPayload = Framed[] | ForeignResult | BarrierInput[];

/** A failure crossing a data-plane RPC boundary as data. The brand key (`__rpcError`) is what `rpcUnwrap`
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
