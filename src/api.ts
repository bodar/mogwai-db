// ---------- the system's API surface (the outer contract) ----------
//
// The seams that define how mogwai-db's pieces COMPOSE, gathered in one place so the contract
// can be read whole rather than discovered one function signature at a time. This is the OUTER
// API: storage transport, graph lifecycle + execution, the federated-transfer row. It is
// deliberately cycle-free — it imports only leaf value-types (render/gremlin-types), never the
// compiler engine, the step modules, or the service implementations, so every layer can depend
// on it without a cycle.
//
// NOT here (on purpose): the service-AUTHOR SPI — Service / Contribution / ServiceCallCtx /
// CallSpec / CallParams — which is entangled with the compiler's Stream / Query / CompileScope
// and therefore lives next to the compiler in services/types.ts. The distinction is real: this
// file is "how you WIRE and DRIVE the system"; the SPI is "how you AUTHOR a service."

import type { Framed } from './execute.ts';
import type { TypeNode } from './gremlin/types.ts';

// ---- storage transport ----

/** The minimal synchronous SQLite driver both runtimes implement: `bun:sqlite` (dev) and DO
 *  `ctx.storage.sql` (prod). Sits at the SQL transport; everything above it is runtime-agnostic.
 *  Deliberately synchronous (DO SQL is sync). */
export interface Sql {
  /** Execute a single DDL statement (no bindings, no result). */
  exec(sql: string): void;
  /** Run a query with positional `?` bindings; returns all rows (writes use RETURNING). */
  query<T = any>(sql: string, binds?: readonly unknown[]): T[];
  /** Release the underlying handle, if any (Bun closes bun:sqlite; the DO owns none). Optional. */
  close?(): void;
}

// ---- the federated-transfer row ----

/** One row of a sibling graph's result, decoded to plain JS values (NOT GraphBinary — a
 *  federated hop is an internal DO↔DO / in-process call, so it carries raw rows and frames to
 *  GraphBinary only at the client edge; see the 2026-07-21 federation addendum). Enough to build
 *  a TinkerPop DETACHED reference: id + label + a property snapshot. `props` is the SAME per-key
 *  {t,v}-node JSON the local element framer consumes, so landing needs no re-typing.
 *
 *  Two mid-traversal-only optional fields (both undefined for a source-form g.call(...), exactly
 *  like `ordinal`'s existing convention):
 *  - `ordinal` — a per-parent result can stamp its originating traverser's ordinal. NOTE (Phase
 *    6b): the shipped mid-traversal rejoin is by VALUE (see below), not by ordinal, so this stays
 *    reserved scaffolding for a future ordinal-based rejoin; the value path leaves it unset.
 *  - `injectedValue` — set on a HEAD row (the barrier's INPUT side): the per-parent scalar
 *    (values(key)/id()/label()) `apply` batches on. The federate rejoin then matches a returned
 *    element's own property/id/label against this value in SQL (mid-traversal V().call(federate)). */
export type ForeignRow =
  | { readonly kind: 'vertex'; readonly id: string | number; readonly label: string; readonly props: Record<string, unknown>; readonly ordinal?: number; readonly injectedValue?: unknown }
  | { readonly kind: 'edge'; readonly id: string | number; readonly label: string; readonly src: string | number; readonly tgt: string | number; readonly props: Record<string, unknown>; readonly ordinal?: number; readonly injectedValue?: unknown };

// ---- execution ----

/** A per-GRAPH executor: compile + run a traversal against one graph. All methods share ONE
 *  machinery (compilePlan → run → frame). The surface splits on two axes:
 *
 *   • PROJECTION — GraphBinary result buffers (the client wire) vs detached ForeignRow[] (the
 *     internal federated transfer, no GraphBinary).
 *   • SYNC vs ASYNC — a non-federated traversal compiles to ONE SQL statement and never suspends,
 *     so it can run SYNCHRONOUSLY (no async tax on callers). Only a federated call() (a barrier)
 *     awaits a sibling graph, so the federation-capable methods are async.
 *
 *  RemoteExecutor is the ASYNC-only surface that crosses ANY boundary (a Cloudflare Worker→DO RPC
 *  is inherently async, so that's all a cross-DO adapter can offer). It is what GraphManager hands
 *  out and what FederationSource needs. Executor extends it with the SYNC methods, which require a
 *  LOCAL store (Bun in-process, or a DO executing over its own storage) — so the in-process
 *  implementation provides them, but a cross-RPC adapter does not.
 */
export interface RemoteExecutor {
  /** Async GraphBinary buffers — the client wire path; handles a federated top-level call(). */
  framedAsync(gremlin: string, params: Record<string, any>, paramTypes?: Record<string, TypeNode>): Promise<Framed[]>;
  /** Async detached rows — the internal federated-transfer hop. `depth` (MANDATORY) is this hop's
   *  federation depth, so a federated call can never forget to thread it. */
  raw(gremlin: string, params: Record<string, any>, depth: number, paramTypes?: Record<string, TypeNode>): Promise<ForeignRow[]>;
}

/** A LOCAL-store executor: the async surface PLUS the sync fast path. The sync methods pay no
 *  async tax (a non-federated traversal never suspends) and THROW if the traversal contains a
 *  federated call() (use framedAsync) — fail-closed, never a silent wrong answer. `buffers` is
 *  `framed` bulk-expanded to a flat Buffer[]. Requires a local store, so only the in-process
 *  implementation offers these (not a cross-DO RPC adapter). */
export interface Executor extends RemoteExecutor {
  framed(gremlin: string, params: Record<string, any>, paramTypes?: Record<string, TypeNode>): Framed[];
  buffers(gremlin: string, params: Record<string, any>, paramTypes?: Record<string, TypeNode>): Buffer[];
}

// ---- graph lifecycle + the executor factory ----

export interface GraphInfo {
  vertexCount: number;
  edgeCount: number;
}

/** The graph-lifecycle seam AND the executor factory. `executor(id)` resolves a graph (creating
 *  it on demand) and returns its per-graph Executor — the single home for id→graph resolution,
 *  which is what federation reaches through (a sibling is just another graph THIS manager owns).
 *  Lifecycle (create/info/destroy) is idempotent + create-on-demand, matching Cloudflare's model.
 *  The runtime-specific half hides behind this interface: a Bun in-process registry vs a DO
 *  namespace, mirroring how `Sql` hides the SQLite transport. */
export interface GraphManager {
  /** The per-graph executor for graph `id`, created on demand. Returns the async-only
   *  RemoteExecutor (the router needs only framedAsync; a cross-DO adapter can offer no more).
   *  A local-store manager (Bun) may return a full Executor, which structurally satisfies this. */
  executor(id: string): RemoteExecutor;
  /** Create graph `id` if absent. Idempotent. */
  create(id: string): Promise<void>;
  /** Element counts for graph `id`, creating it on demand (fresh = 0, 0). */
  info(id: string): Promise<GraphInfo>;
  /** Destroy graph `id` and all its storage. Idempotent. */
  destroy(id: string): Promise<void>;
}
