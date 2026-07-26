// Bun compatibility shim — NOT a fix for anything in this repo or in TinkerPop.
//
// Bun intercepts the bare `undici` specifier with a BUILT-IN shim (even when the real package
// is installed, as it is here). That shim's `Agent` has only a constructor: no `close()`, no
// `destroy()`. Both are NON-OPTIONAL on undici's own `Dispatcher` interface
// (`undici/types/dispatcher.d.ts` declares `close(): Promise<void>` with no `?`), and the real
// Agent inherits them twice over — `Agent -> DispatcherBase(close) -> Dispatcher(close)`.
//
// The gremlin client builds an undici Agent for connection pooling and calls
// `this._dispatcher?.close()` when a connection is closed. That `?.` correctly guards "is there
// a dispatcher at all" (the browser build returns undefined) — it is NOT a guard against a
// dispatcher that violates the interface. So under Bun every client teardown throws
// `this._dispatcher?.close is not a function`.
//
// Fixing it in the client would be wrong: it would silently skip connection-pool cleanup (a
// socket leak) wherever a dispatcher genuinely lacked close. The defect is Bun's — its shim
// claims to be an undici Agent while omitting a mandatory part of the contract. Until that is
// fixed upstream, teach the shim the two missing methods so teardown behaves.
//
// Import for side effects from any test that opens a real client connection.
import { Agent } from 'undici';

const proto = Agent.prototype as unknown as Record<string, unknown>;

// No-ops, not real pool teardown: Bun's shim keeps no pool to drain (its fetch is native), so
// there is nothing to close — the only defect is the missing method. If Bun ever ships a real
// Agent, these are skipped and the genuine implementations are used.
if (typeof proto.close !== 'function') proto.close = async () => {};
if (typeof proto.destroy !== 'function') proto.destroy = async () => {};
