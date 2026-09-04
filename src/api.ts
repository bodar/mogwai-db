// ---------- the system's API surface (the outer contract) ----------
//
// The seams that define how mogwai-db's pieces COMPOSE, gathered in one place so the contract
// can be read whole rather than discovered one function signature at a time. This is the OUTER
// API: storage transport, graph lifecycle + execution, the federated-transfer row. It is
// deliberately cycle-free — it imports only leaf value-types (render/gremlin-types), never the
// compiler engine, the step modules, or the service implementations, so every layer can depend
// on it without a cycle.
//
// NOT here (on purpose): the service-AUTHOR SPI — Service / Contribution / CallSite /
// CallSpec / CallParams — which is entangled with the compiler's Stream / Query / ChildFrameStack
// and therefore lives next to the compiler in services/types.ts. The distinction is real: this
// file is "how you WIRE and DRIVE the system"; the SPI is "how you AUTHOR a service."

import type { Framed } from './execute.ts';
import type { FrameNode, TypeNode, ValueNode } from './gremlin/types.ts';

// ---- HTTP transport ----

/** The whole HTTP seam, one uniform interface on BOTH sides of the wire: a function from a `Request`
 *  to a `Promise<Response>`. It is exactly the shape a server handler already has — `makeRouter`
 *  returns one, a Worker's `fetch` export is one, the browser service-worker's handler is one — and
 *  the shape the global `fetch` satisfies. Modelling the outbound client's transport as this same type
 *  is what lets a test wire the client straight to a server handler IN MEMORY (no socket), and what
 *  keeps client and server symmetric. Every dependency other than the request (a target URL, config)
 *  is baked into the `Request` or injected when the caller is constructed — never a second argument
 *  here, so the interface stays this one clean shape. */
export type Http = (request: Request) => Promise<Response>;

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

// ---- graph capabilities ----

/**
 * **VERTICES CARRY A SET OF LABELS — ALWAYS. Single-label is a declared WALL, not a setting.**
 *
 * TinkerPop 4 added `LabelCardinality` so a provider could declare `ONE` / `ONE_OR_MORE` /
 * `ZERO_OR_MORE`; mogwai-db declares the third and does not carry the others. That is the property
 * graph everyone else already means — a Neo4j node holds a SET of labels (a relationship holds
 * exactly one type, which is why `EdgeFeatures.getLabelCardinality()` is "always ONE" and why our
 * edge label stays a column). Exactly-one-vertex-label is the TinkerPop 3 constraint that v4 exists
 * to lift; carrying it as a runtime knob would make every write path branch on a regime nobody asks
 * for, and make a user's first surprise a refusal.
 *
 * **What it costs, stated rather than discovered:** the seven `*_single_label_graph` conformance
 * scenarios assert that refusal and therefore cannot pass. They are excluded BY NAME
 * (`test/L3-conformance/tags.ts`), on the same footing as any other declared wall — a scenario that
 * tests a capability we do not claim is out of scope, not a regression.
 *
 * The consequences that follow, none of them optional:
 * - a bare `g.addV()` creates a vertex with NO labels (`Labels.feature` `g_addV_labels` asserts
 *   exactly this: `count of 0`), so `DEFAULT_VERTEX_LABEL` is what a LABEL-LESS vertex REPORTS, never
 *   what a creation silently supplies;
 * - `addLabel`/`dropLabel`/`dropLabels` are always legal on a vertex and never need a cardinality
 *   guard — there is no floor to fall below and no ceiling to overstep;
 * - an EDGE still refuses them, and that is the spec rather than this decision.
 */

/**
 * How `elementMap()` / `valueMap(true)` render an element's `T.label`.
 *
 * `set` emits every label (`s[animal,bird,aquatic,endangered]`); `single` emits one. A traversal
 * selects it explicitly with `g.with("multilabel")` / `g.with("singlelabel")`.
 *
 * **RENDERING IS A SEPARATE CONCERN FROM STORAGE, and keeping the two apart is what makes the
 * multi-label decision cheap.** How many labels a vertex may HOLD is a storage capability and is now
 * settled (it holds a set); how many `elementMap()` SHOWS is a presentation choice the traversal
 * makes. This used to fall back to the graph's declared cardinality, which coupled them — so
 * declaring multi-label storage would have silently changed every user's `elementMap()` label from
 * `person` to `s[person]`.
 *
 * The default is `single`, which is also the REFERENCE's: `TraversalHelper.isMultilabelEnabled`
 * reads the `with()` option and nothing else (`.orElse(false)`). The old fallback was documented
 * here as a deliberate divergence; removing it makes us agree with upstream rather than diverge, and
 * `@MultiLabelDefault` — which all three GLVs skip — describes a provider we no longer claim to be.
 */
export type LabelRegime = 'set' | 'single';
export const MULTILABEL_OPTION = 'multilabel';
export const SINGLELABEL_OPTION = 'singlelabel';

/** The regime for a compile: an explicit `with()` wins, else `single` — the reference's own default.
 *
 *  The two options are MUTUALLY EXCLUSIVE — `WithOptions.MULTILABEL_KEY`'s javadoc says
 *  "configuring both on the same traversal source is rejected during traversal strategy
 *  verification" — so setting both throws rather than letting one quietly win.
 *
 *  **Our fallback is a deliberate DIVERGENCE from the reference implementation, and it is the
 *  behaviour upstream's own scenarios describe.** TinkerPop's `TraversalHelper.isMultilabelEnabled`
 *  reads the `with()` option and nothing else — `.orElse(false)` — so the reference default is
 *  always single-label whatever a graph's cardinality is, and there is no knob to change it. That
 *  is precisely why every GLV skips `@MultiLabelDefault`: those scenarios describe a provider the
 *  reference cannot configure into existence. We are that provider. See item 19b. */
export function labelRegime(sourceOptions: ReadonlyMap<string, any>): LabelRegime {
  const multi = sourceOptions.has(MULTILABEL_OPTION), single = sourceOptions.has(SINGLELABEL_OPTION);
  if (multi && single)
    throw new Error(`with("${MULTILABEL_OPTION}") and with("${SINGLELABEL_OPTION}") are mutually exclusive`);
  if (multi) return 'set';
  if (single) return 'single';
  return 'single';
}

/** The message TinkerPop's conformance suite matches on when a graph refuses label mutation. */
export const LABEL_MUTATION_UNSUPPORTED = 'Label mutation is not supported';

/** TinkerPop's `Vertex.DEFAULT_LABEL` — and here it is ONLY what a LABEL-LESS vertex REPORTS for
 *  `label()`, never a label a creation supplies. A bare `g.addV()` stores no label at all
 *  (`Labels.feature` `g_addV_labels`: `count of 0`), so writing this into `vertex_labels` would make
 *  that scenario answer 1. */
export const DEFAULT_VERTEX_LABEL = 'vertex';

/** How many values one vertex-property KEY may hold. An edge property has no cardinality at all
 *  (TinkerPop `Property` is single by construction), which is why this is named for the vertex. */
export type VertexCardinality = 'single' | 'list' | 'set';

/**
 * The cardinality a vertex property takes when the traversal declares none — TinkerPop's
 * `Graph.Features.VertexFeatures.getCardinality(key)`, whose default is **`list`**
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/Graph.java:671`).
 * A graph that supports multi-properties therefore APPENDS on a repeated `property(k, v)` rather
 * than replacing, and `g.addV("animal").property("name","mateo").property("name","gateo")` keeps
 * both — which is what `@MultiProperties` scenarios assert and what we answered wrongly while this
 * defaulted to `single`.
 *
 * It is a constant rather than a per-key function because we have no per-key schema to consult;
 * TinkerPop's signature takes the key so a provider CAN vary it, and that is the hook, not a
 * requirement. It is a graph capability and lives here for the same
 * reason: only the storage waist may apply it, since only there is "the step declared none"
 * (`null`) still distinguishable from an explicit `Cardinality.single`.
 */
export const DEFAULT_VERTEX_CARDINALITY: VertexCardinality = 'list';

// ---- the federated-transfer row ----

/** One row of a sibling graph's result, decoded to plain JS values (NOT GraphBinary — a
 *  federated hop is an internal DO↔DO / in-process call, so it carries raw rows and frames to
 *  GraphBinary only at the client edge; see the 2026-07-21 federation addendum). Enough to build
 *  a TinkerPop DETACHED reference: id + label + a property snapshot. `props` is the SAME per-key
 *  {t,v}-node JSON the local element framer consumes, so landing needs no re-typing.
 *
 *  A vertex carries BOTH label forms and they answer different questions: `label` is the scalar
 *  pick `Element.label()` promises ("an arbitrary label when multiple exist") and the value the
 *  mid-traversal rejoin matches on; `labels` is the full set the wire element frames. An edge's
 *  label cardinality is ONE by spec, so it has only the scalar.
 *
 *  Mid-traversal inputs may carry an `ordinal` and an `injectedValue`: the latter is set on a HEAD
 *  row for a barrier service to batch. Both are absent for a source-form `g.call(...)`. */
export type ForeignRow =
  | { readonly kind: 'vertex'; readonly id: string | number; readonly label: string; readonly labels: readonly string[]; readonly props: Record<string, unknown>; readonly ordinal?: number; readonly injectedValue?: unknown }
  | { readonly kind: 'edge'; readonly id: string | number; readonly label: string; readonly src: string | number; readonly tgt: string | number; readonly props: Record<string, unknown>; readonly ordinal?: number; readonly injectedValue?: unknown };

/** THE SIBLING'S RESULT, transferred back over a federated hop — ONE operation ("run remotely, return
 *  the result"), tagged by the SHAPE the sibling produced. `runForeign()` used to return `ForeignRow[]` bare,
 *  which was only ever the ELEMENT shape; a pushed-down reducer (`federate(…).count()`) produces a
 *  SCALAR, so the result shape belongs IN the transferred value, not in the method name. It grows one arm
 *  per shape the federation learns to push (a list, a map, a record next), switched TOTALLY — the same
 *  fail-closed tagged-union discipline as `BarrierOutput`/`Shape` (`docs/2026-08-26-federate-pushdown-design.md`).
 *
 *  A scalar crosses as a `{t,v}` `ValueNode` (`gremlin/types.ts`) — the SAME typed envelope element props
 *  already use — so its Gremlin type (Long vs Integer, a stored vtype) survives the JSON transfer and
 *  re-frames EXACTLY via `frameTypedNode`. A bare JSON number would silently erase Long-vs-Integer.
 *
 *  `scalar` is ONE value (a pushed reducer's terminal — `count`/`sum`/…, one row over the whole stream);
 *  `values` is a STREAM of N (a pushed `values(k)`/`unfold()`, a pushed `fold()`/`cap()`, or a `fold()`
 *  OF ELEMENTS). Both ride the SAME self-describing node the local framer consumes — `scalar` a stored
 *  `ValueNode`, `values` the wider `FrameNode` (which adds the DETACHED element arm, so a pushed
 *  `fold()` of vertices crosses each as `{t:'vertex', v: payload}`). `values` differs from `scalar` only
 *  in re-emitting each member as its own traverser (`lowerTypedNodeStream`) rather than framing one value.
 *  This is the same wall the scalar reducer hit, one shape further — no new transport substrate, just the
 *  total-tag arm the resume unfolds. */
export type ForeignResult =
  | { readonly kind: 'elements'; readonly rows: readonly ForeignRow[] }
  | { readonly kind: 'scalar'; readonly value: ValueNode }
  /** A keyed typed map, used by federate's standard mapValues injection transport. */
  | { readonly kind: 'map'; readonly value: Extract<ValueNode, { readonly t: 'map' }> }
  | { readonly kind: 'values'; readonly values: readonly FrameNode[] };

/** WHICH pushed terminal a federated sub-traversal ends in, when the sibling's `plan.shape` alone is
 *  AMBIGUOUS. Only `'reduce'` is load-bearing: a collapsing reducer (`count`/`sum`/…) and a `values(k)`
 *  STREAM both compile to `value`/`scalar` shapes but carry different empty/cardinality semantics
 *  (count over empty → 0; values over empty → []), which the shape cannot express. The terminal step is
 *  the one fact that disambiguates them (`pushableTailPrefix.reduces`), so it is passed as an intent hint
 *  rather than re-derived from the shape. Absent → the shape is authoritative (elements vs a value stream). */
export type ForeignTerminal = 'reduce';

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
   *  federation depth, so a federated call can never forget to thread it. `terminal` disambiguates a
   *  reducer from a value stream (see `ForeignTerminal`); absent → the sibling shape is authoritative. */
  runForeign(gremlin: string, params: Record<string, any>, depth: number, paramTypes?: Record<string, TypeNode>, terminal?: ForeignTerminal): Promise<ForeignResult>;
}

/** A LOCAL-store executor: the async surface PLUS the sync fast path. The sync methods pay no
 *  async tax (a non-federated traversal never suspends) and THROW if the traversal contains a
 *  federated call() (use framedAsync) — fail-closed, never a silent wrong answer. `buffers` is
 *  `framed` bulk-expanded to a flat Buffer[]. Requires a local store, so only the in-process
 *  implementation offers these (not a cross-DO RPC adapter). */
export interface Executor extends RemoteExecutor {
  framed(gremlin: string, params: Record<string, any>, paramTypes?: Record<string, TypeNode>): Framed[];
  buffers(gremlin: string, params: Record<string, any>, paramTypes?: Record<string, TypeNode>): Buffer[];
  /** Run a captured replication FILTER (a vertex-selector traversal) and return the matched vertices'
   *  external ids — the source-side selector for filtered replication (filtered-replication-plan §2/F1).
   *  Throws unless the traversal is a READ yielding a VERTEX stream (fail-closed; also the save-time
   *  validation). Sync — a filter is an ordinary local read, so only a LOCAL-store executor offers it. */
  filterVertexIds(gremlin: string, params?: Record<string, any>): (string | number)[];
}

// ---- graph lifecycle + the executor factory ----

export interface GraphInfo {
  vertexCount: number;
  edgeCount: number;
}

/** One entry in the `_changes` feed (§5·2) — an element's LATEST state at its `seq`. Keyed by `gid`
 *  (cross-peer identity, never the local rowid); `rev` is its `{gen, hash}`; `kind` is vertex/edge;
 *  `deleted` marks a tombstone (CouchDB's `_deleted`). One entry per element (moved, not appended). */
export interface ChangeRow {
  readonly seq: number;
  readonly id: string; // hex gid
  readonly kind: 'vertex' | 'edge';
  readonly rev: WireRev | null;
  readonly deleted?: true;
  /** The element's shadowed conflict-LOSER leaf revs (§6·3), when it has any — CouchDB's
   *  `?style=all_docs`. A replicator fetches these too, so a peer that already holds the winner still
   *  learns the loser and CONVERGES (4b-2). Absent when the element is unconflicted (the common case). */
  readonly conflicts?: readonly WireRev[];
}

/** The `_changes?since=N` response (§5·2), CouchDB-shaped: the ordered deltas plus `last_seq`, the
 *  graph's `update_seq` at response time — a client checkpoints it and resumes with `since=last_seq`. */
export interface ChangesFeed {
  readonly results: readonly ChangeRow[];
  readonly last_seq: number;
}

/** A rev on the wire (`{gen, hash}`), as the feed and diff carry it. `ids` (the stemmed ancestry) is
 *  carried ONLY on a DELETE (a tombstone has no body, so the feed is the only carrier of its lineage —
 *  what lets apply tell a normal delete-after-edit from a concurrent one, §6·3); a live rev omits it (its
 *  ancestry stays in the store, read by `_revs_diff`). */
export interface WireRev { readonly gen: number; readonly hash: string; readonly ids?: readonly string[] }

/** `_revs_diff` request (§4 primitive 2): a peer offers, per element gid (hex), the revs it holds. */
export type RevsDiffRequest = Readonly<Record<string, readonly WireRev[]>>;

/** `_revs_diff` response: per gid, the offered revs THIS graph does not have — so the source ships only
 *  those. A pure key lookup over gid/rev (live rows + tombstones), never a body. Gids with nothing
 *  missing are omitted. */
export type RevsDiffResponse = Readonly<Record<string, { readonly missing: readonly WireRev[] }>>;

// ---- the replication transfer payload (`_bulk_get` reply / `_bulk_docs` request), §4·5 ----
// Element BODIES keyed by GID; properties in GraphSON typed-value form (wire-safe, full-fidelity — a
// collection `Map`/`Set` cannot ride a bare value). `src/replicate.ts` produces and applies these.

/** A reference `_bulk_get` fetches the body of. `rev` (a leaf hash) requests a SPECIFIC version — the
 *  live one if it matches, else a shadowed conflict loser (4b-2); omitted → the live winner. */
export interface BulkGetRef { readonly gid: string; readonly kind: 'vertex' | 'edge'; readonly rev?: string; }

/** A vertex on the wire — GraphSON `{key: [{id, value, properties?}, …]}` properties, keyed by gid.
 *  `uid` is the user-supplied per-graph id (§6·1), carried so it replicates; a cross-peer collision
 *  (two gids claiming one uid) reconciles by not-deleted > lower-gid, the loser's uid shadowed. */
export interface WireVertex {
  readonly gid: string;
  readonly rev: string;
  readonly uid?: string | null;
  readonly labels: readonly string[];
  readonly properties: Record<string, unknown[]>;
}

/** An edge on the wire — GraphSON `{key: value}` properties, endpoints by gid. */
export interface WireEdge {
  readonly gid: string;
  readonly rev: string;
  readonly uid?: string | null;
  readonly label: string;
  readonly srcGid: string;
  readonly tgtGid: string;
  readonly properties: Record<string, unknown>;
}

/** A delete on the wire (a `_changes` `deleted` entry): the element's gid, tombstone rev, and kind. */
export interface WireDelete { readonly gid: string; readonly rev: string | null; readonly kind: 'vertex' | 'edge'; }

/** The `_bulk_get` reply / `_bulk_docs` request — the wire form of a change set. */
export interface WireChangeSet {
  readonly vertices?: readonly WireVertex[];
  readonly edges?: readonly WireEdge[];
  readonly deletes?: readonly WireDelete[];
}

/** A one-shot `_replicate` request (§9): exactly one of `source`/`target` is a remote `http(s)` graph
 *  URL, the other is (or defaults to) this graph — so `{source: url}` PULLS and `{target: url}` PUSHES. */
export interface ReplicateOptions {
  readonly source?: string;
  readonly target?: string;
  /** A captured vertex-selector traversal (filtered-replication-plan F1), evaluated on the SOURCE: only
   *  the matched subgraph (+ its 1-hop edge-closure) is pulled/pushed. Absent → the whole graph. */
  readonly filter?: string;
}

/** What one replication pass moved: entries read from the source feed, element bodies written, deletes
 *  applied, and the source cursor reached (the new checkpoint). */
export interface ReplicationStats {
  readonly read: number;
  readonly written: number;
  readonly deleted: number;
  readonly last_seq: number;
}

/** A surfaced conflict (§6·3): an element whose live row is the deterministic WINNER, with its shadowed
 *  losing versions — the `?conflicts=true` analog. Invisible to ordinary reads; only this endpoint shows
 *  it. Resolution (delete a loser, or merge) is the app's. */
export interface ConflictEntry {
  readonly gid: string;
  readonly kind: 'vertex' | 'edge';
  /** The live winner's rev, or null if the winner is gone (a tombstone). */
  readonly winner: WireRev | null;
  /** The shadowed losing versions — each its rev + full wire document. */
  readonly losers: readonly { readonly rev: WireRev; readonly doc: unknown }[];
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
  /** The by-sequence change feed for graph `id` since cursor `since` (§5·2) — store-tier read work,
   *  the peer-facing replication source. Creating the graph on demand, like `info`. An optional `limit`
   *  PAGES the feed (CouchDB `_changes?limit=N`): the replicator drains a large graph in bounded batches
   *  so no single apply span busy-locks the store (the pacing substrate). When a page is truncated,
   *  `last_seq` is the resume cursor; otherwise it is the graph's `update_seq` (fully caught up). */
  /** `filter` (filtered-replication-plan F1) is a captured vertex-selector traversal evaluated on the
   *  SOURCE: the feed is restricted to the matched vertices + their 1-hop edge-closure. A non-vertex
   *  filter throws (fail-closed), surfaced to the caller. Absent → the whole graph. */
  changes(id: string, since: number, limit?: number, filter?: string): Promise<ChangesFeed>;
  /** Given the revs a peer holds per gid, return which ones graph `id` is MISSING (§4 primitive 2) —
   *  the cheap "what should I send you?" diff. A pure gid/rev key lookup, store-tier. */
  revsDiff(id: string, request: RevsDiffRequest): Promise<RevsDiffResponse>;
  /** Read the BODIES of the referenced elements from graph `id` (`_bulk_get`) — the transfer payload. */
  bulkGet(id: string, refs: readonly BulkGetRef[]): Promise<WireChangeSet>;
  /** Apply a change set to graph `id` (`_bulk_docs {new_edits:false}`) — land a peer's changes at their
   *  stated rev, idempotently and keyed by gid (§4·5). Store-tier write. */
  bulkDocs(id: string, changes: WireChangeSet): Promise<void>;
  /** Read (`seq` omitted) or write (`seq` given) graph `id`'s replication checkpoint for `replicationId`
   *  (§9·2) — where a replicator is caught up to on a peer. Returns the stored/written seq (0 if none). */
  checkpoint(id: string, replicationId: string, seq?: number): Promise<number>;
  /** Run ONE replication pass for graph `id` against the remote peer named in `opts` (§9): pull or push,
   *  `_changes` → `_revs_diff` → `_bulk_get` → apply → checkpoint. Resumable — a re-run from the stored
   *  checkpoint is a no-op when nothing changed. */
  replicate(id: string, opts: ReplicateOptions): Promise<ReplicationStats>;
  /** The surfaced conflicts in graph `id` (§6·3) — the winner + shadowed losers per conflicted element.
   *  Store-tier read; empty when there are none (the common case). */
  conflicts(id: string): Promise<readonly ConflictEntry[]>;
  /** Destroy graph `id` and all its storage. Idempotent. */
  destroy(id: string): Promise<void>;
}
