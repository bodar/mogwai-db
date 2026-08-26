import type { ForeignRow } from '../../api.ts';
import type { Minter } from '../../compiler/rel/build.ts';
import type { FramedRel } from '../../compiler/rel/framing.ts';
import type { ChildHost, ChildSeam, ChildValue } from '../../compiler/rel/child.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Elem } from '../../compiler/elem.ts';
import type { GraphSource } from '../../compiler/rel/source.ts';
import type { ReconstructConfig } from '../../compiler/rel/shortestpath.ts';
import type { ContentDemand } from '../../compiler/ir/content-demand.ts';
import type { ValueNode } from '../../gremlin/types.ts';

// ---------- the call() service seam ----------
//
// call() is the extensibility point: a Service registers into a ServiceRegistry and
// contributes to the compile. A PURE service ('rel' Contribution) lowers to SQL
// inline — the only kind Phases 1-5 implement, so the whole compile→lower→materialize
// pipeline stays synchronous. The 'barrier' variant is the async/federated shape
// (Phase 6); it lives in the type NOW so the seam is provably additive, but its executor
// path throws a clear deferral until that phase lands. See
// docs/archive/2026-07-20-call-service-registry-plan.md.

/** A call() parameter map, AFTER the front-end has unified every param-source form
 *  (map literal / bound-param map / __.project().by(__.constant()) traversal / .with(k,v))
 *  into one representation. A service reads it oblivious to how the value arrived. */
export type CallParams = Record<string, unknown>;

/** How a mid-traversal call()'s per-parent SCALAR value is projected — the classification of the
 *  injection traversal (the THIRD positional arg of `V().call(name, params, __.values('k'))`).
 *  Restricted to a DIRECT value read (Phase 6b): a property value, the element id, or its label —
 *  each of which also lands on the returned foreign row (fprops/fid/flabel), so the federate
 *  rejoin can match a result against the injected value in SQL. A computed injection
 *  (math/format/transforms) is out of scope and fails closed with a clear deferral. */
export type InjectionKind =
  | { readonly kind: 'values'; readonly key: string }
  | { readonly kind: 'id' }
  | { readonly kind: 'label' };

/** What a call() site parsed to before registry lookup — the service name plus its
 *  resolved constant params. Shared by the source form (g.call(...)) and the
 *  mid-traversal form (V().call(...)). `injectionTraversal` is the raw (un-lowered) nested-
 *  traversal AST of a mid-traversal call's per-parent injection arg (the third positional arg);
 *  undefined for a source-form call or a mid call with no injection (a constant sub-traversal —
 *  the service runs once, the degenerate collapse). Kept un-lowered so `midSegment` can classify it
 *  (→ InjectionKind via `injectionKindOf`) and take the read VERBATIM as the head's last step. */
export interface CallSpec {
  readonly serviceName: string;
  readonly params: CallParams;
  readonly injectionTraversal?: any;
}

/** ONE call() occurrence, with everything a service needs to lower into it: this call's resolved
 *  arguments, where to build SQL (`q` + the traversal's `boundParams`), the request's hop depth,
 *  and — for a mid-traversal call — the enclosing traverser position. Never what a service DEPENDS
 *  on: a dependency arrives at construction, off the app scope (see standard.ts).
 *
 *  Distinct from `CallSpec` above, and the pair is the parse/lower split: a `CallSpec` is what the
 *  step TEXT parsed to, before registry lookup; a `CallSite` is what the resolved service is handed
 *  to contribute. A superset the resolver reads selectively — a source service (--list,
 *  tinker.search) ignores `host`/`child`; a per-parent service (tinker.degree.centrality) requires
 *  them and THROWS without them, since a `streaming` service at a source position is invalid Gremlin
 *  rather than a shape some other route answers (§6·5).
 *
 *  It was `ServiceCallCtx`, which borrowed TinkerPop's `ServiceCallContext` — a different thing
 *  ({traversal, step} + generateTraverser/split, for barrier services building their own
 *  path-preserving Traversers, which we do not do because path rides in columns). */
export interface CallSite {
  /** THIS call's resolved params — `g.call(name, {k: v})` / `.with(k, v)`. Not to be confused with
   *  `boundParams`: these are the call's arguments, those are the traversal's wire bindings. */
  readonly params: CallParams;
  readonly boundParams: Record<string, any>;   // the traversal's bound-param table (wire bindings)
  /** This compile's federation hop depth — request-scoped, so a barrier's `apply` closure can
   *  capture it at resolve time and recurse at depth+1 without an `apply` parameter. */
  readonly federationDepth: number;
  /** What the LOCAL TAIL after this barrier consumes from the result — a fact ABOUT this call site,
   *  known once at plan time (the tail is right there in the chain), the same category as
   *  `federationDepth`. A barrier that shapes its fetch by the downstream demand (federate skipping the
   *  endpoint hop when nothing walks to an endpoint — `docs/2026-08-26-federate-pushdown-design.md`,
   *  phase 3) reads it; one that does not ignores it. It is a call-site property so the fetch decision
   *  arrives as a typed dependency of `resolve`, not smuggled through `params` or captured incidentally.
   *  Optional so a caller that plans a barrier WITHOUT a segment tail (a test, a future non-segment path)
   *  need not synthesize one — absent = "assume the tail needs everything", the safe over-fetch. */
  readonly tailDemand?: ContentDemand;
  /** PUSHDOWN — present only for the ARG-LESS federate form (`call(federate,{graph}).V()…`, win 2a),
   *  where the compiler INFERS what runs on the sibling instead of the user supplying a `traversal` arg.
   *  A fact about this call site (the tail is right there in the chain): the sibling Gremlin SYNTHESIZED
   *  from the pushable prefix of the local tail (`pushableTailPrefix` + the steps' own source text), and
   *  where the LOCAL suffix resumes. `apply` runs `siblingGremlin`; the resume lowers from `suffixFrom`.
   *  Absent when the user gave an explicit `traversal` (they drew the boundary — no push) or when nothing
   *  pushes. `reduces` = the pushed prefix ends in a reducer, so the sibling returns a SCALAR. */
  readonly pushdown?: {
    readonly siblingGremlin: string;
    readonly suffixFrom: number;
    readonly reduces: boolean;
  };
}

/**
 * **`CallSite` IS THE WHOLE CONTRACT `resolve` NEEDS, and the build-specific half is `RelCallSite`'s.**
 *
 * It used to carry `q: Query` outright — a `Query` is the q-kernel's CTE accumulator, so a service
 * that composes an algebra RelIR names and renders once cannot be handed one; holding a `Query` would
 * mean building SQL beside the plan rather than inside it (the second bind-ordering authority §5
 * exists to prevent).
 *
 * Measured against the services: `resolve` reads only params and the hop depth — every catalog
 * service either ignores its site entirely or reads `params`/`federationDepth`. `RelCallSite` below
 * is the one extension, for a contribution that BUILDS.
 */

/** ForeignRow lives in the outer API surface (src/api.ts) — it's a leaf data type on the
 *  federated-transfer contract. Re-exported here so service-author code keeps one import. */
export type { ForeignRow } from '../../api.ts';

/** How a Service contributes to the plan. 'rel' is a pure, inline contribution: it lowers into the
 *  RelIR plan synchronously and the fold takes over. 'barrier' is the async/federated shape: it does
 *  NOT lower at compile time (its rows come from an awaited sibling call), so it yields no builder;
 *  instead `apply` runs at EXECUTION time (the one await in the executor's segment loop) and returns
 *  the foreign rows the executor lands + resumes from.
 *
 *  **A former third arm, `stream`, is DELETED.** It was the retired lowering's inline contribution,
 *  kept transiently only so services could migrate to `rel` one at a time. All three pure services
 *  are `rel` now.
 *
 *  `apply` takes ONLY the drained input rows (empty for a source-form call) — the one value that
 *  is genuinely per-execution. Everything it used to take positionally now arrives where it
 *  belongs: the FederationSource at construction (an app-scope dependency), the params and this
 *  hop's federation depth off the `CallSite` that `resolve` already receives. */
/** WHERE a barrier's `apply` runs — a deployment fact, orthogonal to `kind` (which names the
 *  ESSENCE: what the contribution is to the plan). Explicit and binary, never derived from a
 *  capability checklist. See `docs/archive/2026-08-07-edge-compilation-plan.md` §4·3.
 *
 *  - `'do'` — runs in the Durable Object, beside the store. The default and overwhelming case: a
 *    barrier with no remote wait has nothing to free the DO across (pure CPU over a batch already in
 *    the DO, or a store-bound iteration that must be AT the store), so it stays here however much CPU
 *    it burns. `io()` is `'do'` too — a rare root-level admin op whose R2 half is not worth hoisting.
 *  - `'worker'` — the Worker drives it, off the DO, so the DO's request closes and the graph's other
 *    callers are served meanwhile. Earned ONLY by a REMOTE WAIT (§1's worst occupancy: the DO idle
 *    but holding while another object works). Today exactly one barrier qualifies: `federate`.
 *
 *  **Fail-closed invariant: a `'worker'` barrier's `apply` is store-free** — handed no store and
 *  closing over no store binding (federate closes over the FederationSource; io closes over the store,
 *  which is why io is `'do'`). So the value cannot contradict the code.
 *
 *  Nothing READS this yet — the Worker-driven drive loop is edge-compilation Phase 2. It is declared
 *  now so a barrier STATES its residency rather than the loop hardcoding which ones leave. */
export type BarrierResidency = 'do' | 'worker';

/**
 * A barrier's SECOND output shape (`docs/2026-08-21-barrier-substrate-design.md` Axis 2): a
 * data-sized `(id → value)` RELATION rather than a set of detached elements. An iterative graph
 * algorithm's product is a NUMERIC/label relation keyed by element id, not a stream of elements — so
 * `federate`/`io`'s `ForeignRow[]` is the wrong shape for it.
 *
 * **The relation lives in SQL, never in JS.** `apply` computes it into `barrier_state` (a scratch
 * table keyed by a per-query `run` token — `src/storage.ts`) and returns only the HANDLE: the run
 * token plus the `round` slot that holds the final vector. The DECORATE resume then reads it straight
 * off that table, correlated on the LIVE element stream's id, keeping the stream element-preserving —
 * so a graph of millions of vertices never materializes its O(V) vector in the host, not per
 * iteration and not at the segment handoff. `run` is reclaimed once the tail is framed
 * (`frameResolved`, precise post-frame GC). This REPLACES the former `relation-tuples` shape, which
 * crossed the whole vector as a `json_each` bind twice over.
 */
export interface BarrierRelation {
  readonly kind: 'relation-ref';
  /** The run token whose rows in `barrier_state` hold this `(id → value)` result. */
  readonly run: number;
  /** The `round` slot (0/1) holding the FINAL vector for this run. */
  readonly round: number;
}

/** A pushed-down REDUCED SCALAR — a bare reducer (`count`/`sum`/…) evaluated on the far side of a
 *  federate barrier, crossing as a typed `{t,v}` `ValueNode` so its Gremlin type survives (a Long stays
 *  a Long). The resume frames it as a one-row `RelFraming.scalar`. A separate `BarrierOutput` arm from
 *  the element/relation ones because it is neither detached elements nor a keyed relation — it is the
 *  whole stream collapsed to one typed value (`docs/2026-08-26-federate-pushdown-design.md`, phase 2). */
export interface BarrierScalar {
  readonly kind: 'barrier-scalar';
  readonly value: ValueNode;
}

/** What a barrier's `apply` may return: detached elements (`federate`/`io`), a keyed relation (an OLAP
 *  algorithm), or a pushed-down reduced scalar (a federate reducer). The resume that consumes it is
 *  chosen at PLAN time (contribution flags for the relation; the returned tag for a scalar), so the two
 *  never mismatch. */
export type BarrierOutput = readonly ForeignRow[] | BarrierRelation | BarrierScalar;

/** A DECORATE barrier's element-preserving descriptor. When present on a barrier contribution, the
 *  segment builds a DECORATE resume: it re-lowers the LIVE element prefix and reads the barrier's
 *  `(id → value)` relation as a synthetic property under `key`, so `has(key)`/`by(key)`/`order().by(key)`
 *  compose over the passed-through elements. This is the native OLAP steps' contract (pageRank/wcc/
 *  peerPressure decorate each incoming vertex with its score under a canonical property key). */
export interface DecorateSpec {
  /** The decorated properties, one per `barrier_state` CHANNEL the algorithm writes (GDS's
   *  `CompositeNodeValue` — a multi-property algorithm like HITS declares hub=channel 0, auth=channel 1;
   *  a single-scalar one (pageRank/wcc/peerPressure) declares one channel 0). The decorate resume STACKS
   *  a `decorateGraph` layer per channel, so `values(hub)`, `order().by(auth)`, `project().by(hub).by(auth)`
   *  all compose over the one passed-through element stream. */
  readonly channels: readonly DecorateChannel[];
  /** THE BARRIER WANTS TO SEE ITS INPUT STREAM. When set, and the prefix is not a bare `V()`/`E()`
   *  source, the decorate segment gives `apply` a head that projects the incoming per-traverser element
   *  id (one row per traverser, uncollapsed) — so the barrier learns the per-element MULTIPLICITY that
   *  flowed in. pageRank uses it as its initial rank (TinkerPop's `HaltedTraversersCount`, seeded only
   *  when a preceding traversal-vertex-program exists — i.e. a non-bare prefix); a bare source has none
   *  and `apply` gets no rows. Generic: any algorithm whose result depends on incoming multiplicity
   *  declares this and reads the counts off `apply`'s rows. */
  readonly seedFromInput?: boolean;
}

/** ONE decorated property = one `barrier_state` channel read back under a Gremlin property key. */
export interface DecorateChannel {
  readonly key: string;
  /** The `barrier_state.channel` this property's value lives in (the algorithm's `apply` wrote it there).
   *  A single-scalar algorithm uses `0`; HITS uses `0` (hub) and `1` (auth). */
  readonly channel: number;
  /** The canonical Gremlin type of the decorated value (`src/gremlin/types.ts` vocabulary — e.g.
   *  `'double'` for a pageRank/HITS score, `'string'` for a connectedComponent id). It is what
   *  `values(key)`/`valueMap(key)` need to FRAME the value on the wire (a REAL score as a Double, not a
   *  Long); `order().by(key)`/`has(key)` read it raw and do not consult it. */
  readonly vtype: string;
}

/** A PATH barrier's reconstruction descriptor — weighted shortestPath. When present on a barrier
 *  contribution, the segment builds a PATH resume (`pathSegment` → `lowerPathResume`): `apply` relaxed
 *  the weighted shortest distance into `barrier_state` (scope = source, channel 0) and returns the
 *  `(run, round)` handle; the resume rebuilds the shortest PATHS from that relation and continues the
 *  tail over the path-framed stream, REPLACING the element stream (unlike the element-preserving
 *  `decorate`). The spec is the reconstruction's static half (scope, weight key, includeEdges, target,
 *  maxWeight); `apply` supplies the runtime `(run, round)`. */
export type PathSpec = ReconstructConfig;

/** A PAIR barrier's output descriptor — node-similarity. When present on a barrier contribution, the
 *  segment builds a PAIR resume (`pairSegment` → `lowerPairResume`): `apply` computed a set of scored
 *  vertex PAIRS into `barrier_state` (scope = node1, id = node2, channel 0 = the score) and returns the
 *  `(run, round)` handle; the resume frames each pair as a MAP `{key1: node1, key2: node2, valueKey:
 *  score}` — a NEW output shape (a stream of maps), unlike the element-preserving `decorate`, the
 *  path-replacing `path`, or the detached `federate`/`io`. node1/node2 frame as their external ids. */
export interface PairSpec {
  readonly key1: string;
  readonly key2: string;
  readonly valueKey: string;
  /** The canonical Gremlin type of the score (e.g. `'double'` for a Jaccard similarity). */
  readonly valueVtype: string;
}

export type Contribution =
  | { readonly kind: 'rel'; buildRel(site: RelCallSite): RelContribution | null }
  | {
      readonly kind: 'barrier';
      readonly residency: BarrierResidency;
      readonly decorate?: DecorateSpec;
      readonly path?: PathSpec;
      readonly pairs?: PairSpec;
      /** The PRODUCTION transform — async, so a long compute (an OLAP relaxation over a large graph)
       *  can YIELD between segments/rounds rather than busy-locking the single-threaded Durable Object
       *  while other requests wait. Every barrier has one; it is what the async drive awaits. */
      apply(rows: readonly BarrierInput[]): Promise<BarrierOutput>;
      /** The SYNCHRONOUS CORE, present iff the compute has no real I/O await (the OLAP barriers —
       *  `relaxShortestPath` / wcc / pageRank / peerPressure are pure in-SQL loops; `apply` merely wraps
       *  this). It lets the SYNC drive (`driveSegmentsSync`, the `framed()`/census path) run the barrier
       *  with no await, where busy-locking is fine — a TEST/in-process property, never the production
       *  path, which stays `apply` so it can yield. `federate`/`io` omit it (genuine remote/object I/O),
       *  so they still refuse the sync path. */
      applySync?(rows: readonly BarrierInput[]): BarrierOutput;
    };

/**
 * WHAT A MID-TRAVERSAL BARRIER'S HEAD HANDS ITS `apply` — one row per parent traverser, carrying the
 * value this call injects into the sub-traversal it runs elsewhere.
 *
 * It is NOT a `ForeignRow`, and the distinction was worth naming: a foreign row is a DETACHED element
 * that came back from somewhere else, while these are THIS graph's parents on the way out. Typing the
 * input as a foreign row made the head compile a whole element payload — id, label set, property bag —
 * of which every barrier service reads exactly one field. A source-form call has no parents at all and
 * passes none.
 */
export interface BarrierInput {
  /** The per-parent scalar the call injects: `values(k)`, `id()` or `label()` over the parent, as
   *  `injectionKindOf` classified it. Absent when the call names no injection (the sub-traversal is a
   *  constant), which is the case the rejoin answers with a cross join. */
  readonly injectedValue?: unknown;
}

// ---------- the `rel` arm: a contribution lowered into the RelIR fold ----------
//
// A pure service contributes a `rel` contribution: it lowers into the RelIR plan and the fold takes
// over. A service implements exactly ONE arm — never both, which would be a duplicated lowering. An
// unlearned contribution declines with the ordinary "not learned yet" `null`.
//
// `barrier` is different: it contributes no lowering at all — its rows arrive from an awaited sibling
// and `apply` runs at EXECUTION time, in the executor's segment loop. Federation and io contribute no
// lowering either, and the planned iterative graph algorithms
// (`docs/2026-07-24-graph-algorithms-plan.md`) are barrier contributions for the same reason.

/**
 * A `rel` contribution's product. `null` declines, the one decline convention this route has.
 *
 * **THE UNION FOLLOWS `Service.Type`, and that split is not ours to invent.** TinkerPop already
 * distinguishes a `start` service (a SOURCE — it produces rows from nothing) from a `streaming` one
 * (per input traverser — it produces ONE VALUE for each), and the two contribute genuinely different
 * things to a relational plan: a source is a RELATION spliced in at the head of the chain, while a
 * per-parent service is a correlated VALUE the retype projects beside its host row. Making the
 * product follow the declared type is what stops the mid-traversal form growing a second
 * call-lowering that assembles a relation and then joins it back to the parent it came from.
 *
 * The `value` arm reuses `ChildValue` rather than restating it: a per-parent service IS a correlated
 * child body — `tinker.degree.centrality` literally hands the seam `[<direction>, count]` — so the
 * expression, its framing and its per-row type are the same three facts the seam already carries.
 */
export type RelContribution =
  | ({ readonly kind: 'relation' } & FramedRel)
  | { readonly kind: 'value'; readonly value: ChildValue };

/** What a `rel` contribution is handed. The `CallSite` fields that survive are the ones that are
 *  genuinely about THIS call — its resolved params and the traversal's wire bindings — plus the id
 *  minter, which is the only thing a producer cannot reach on its own (`make` is an ordinary module
 *  import, so there is nothing to inject but `fresh`; `injectSource(steps, fresh)` is the same shape).
 *
 *  `q` is absent and its absence is the point: a `Query` is the q-kernel's CTE accumulator, and a `rel`
 *  service composes an algebra that RelIR names and renders once. A service holding a `Query` would
 *  be building SQL beside the plan rather than inside it — the second bind-ordering authority §5
 *  exists to prevent. */
export interface RelCallSite extends CallSite {
  readonly fresh: Minter;
  /**
   * The enclosing traverser and the child seam — present ONLY for a mid-traversal `call()`.
   *
   * A `streaming` service needs both and a `start` service ignores both. What they ARE is the point:
   * the host ROW plus the ONE child seam (§6·6) — not per-traverser scope machinery of the service's
   * own — so a service asks the identical question every `by()` body asks and gets the identical
   * answer. That is why `tinker.degree.centrality` is a body of two IR steps and no substrate.
   */
  readonly host?: ChildHost;
  readonly child?: ChildSeam;
  /**
   * THE MID-STREAM CONTEXT — the whole incoming element RELATION, present only for a mid-traversal
   * `call()` over an element stream. A per-parent value service (`tinker.degree.centrality`) ignores
   * it and reads `host`/`child`; a service that RESHAPES the whole stream reads it instead —
   * `shortestPath` seeds a recursive walk from every incoming source vertex at once, which a
   * per-parent child body cannot express. `source` is the `GraphSource` the walk joins against
   * (base or bound graph).
   */
  readonly stream?: { readonly input: Rel; readonly elem: Elem; readonly source: GraphSource };
}

export interface Service {
  readonly name: string;
  /** TinkerPop Service.Type — 'start' (a source producer), 'streaming' (per-input),
   *  'barrier' (collect-all, async). Load-bearing for the future batching path. */
  readonly type: 'start' | 'streaming' | 'barrier';
  /** Resolvable by name, but EXCLUDED from `--list` enumeration. The directory service is
   *  internal by TinkerPop's own rule (it never lists itself); a service that exists only to
   *  back a SUGAR STEP — `io()` desugaring to a `call()` — is internal for the same reason the
   *  reference corpus can assert an exact provider surface: it is not part of that surface.
   *  A flag, not a name list, so the decision sits on the service that owns it. */
  readonly internal?: boolean;
  /** The describe blob for `--list --verbose`. A minimal `{}` is fine for now. */
  describeParams(): Record<string, unknown>;
  resolve(site: CallSite): Contribution;
}

export interface ServiceRegistry {
  get(name: string): Service | undefined;
  /** Enumeration order for --list — EXCLUDES every `internal` service (the directory itself,
   *  and any sugar-backing service). */
  list(): readonly Service[];
}

/** The service name `io()` desugars to (services/catalog/io.ts). Lives here for the same reason
 *  DIRECTORY_SERVICE_NAME does — a dependency-free leaf both the desugaring Pass (compiler core)
 *  and the service impl can import, without the compiler core importing a service module. */
export const IO_SERVICE_NAME = 'mogwai.io';

/** The directory command name. A service registered under it is resolvable by name but
 *  excluded from its own list() (TinkerPop's rule — expressed as `internal: true`). Lives here
 *  (a dependency-free leaf) so both call-params.ts and directory.ts import it without a cycle. */
export const DIRECTORY_SERVICE_NAME = '--list';

/** The canonical service names the four native OLAP steps desugar to (ir/strategies.ts
 *  `desugarGraphAlgos`). Live here (the dependency-free leaf) for the same reason IO_SERVICE_NAME
 *  does: the desugaring Pass is compiler core, and must reach the name without importing a service
 *  module. `wcc` (weakly-connected components) is `connectedComponent`'s canonical algorithm name —
 *  the STEP keeps TinkerPop's word, the SERVICE takes the algorithm's (root CLAUDE.md, Naming).
 *  All four are `internal: true` services: they back native TinkerPop steps rather than extending the
 *  reference provider surface, so they are served by both registries yet absent from `--list`, exactly
 *  as `mogwai.io` is. See `docs/2026-07-24-graph-algorithms-plan.md`. */
export const PAGERANK_SERVICE_NAME = 'mogwai.pageRank';
export const WCC_SERVICE_NAME = 'mogwai.wcc';
export const PEER_PRESSURE_SERVICE_NAME = 'mogwai.peerPressure';
export const SHORTEST_PATH_SERVICE_NAME = 'mogwai.shortestPath';
/** HITS (Kleinberg hubs & authorities) — a GDS-style algorithm with NO native TinkerPop step, so it is
 *  call-only (`g.call("mogwai.hits", …)`) and the FIRST multi-channel decorate consumer (hub + auth).
 *  `internal: true` like the others: served by both registries, absent from `--list`, so it cannot shift
 *  the reference provider surface the conformance `--list`/g_call scenarios assert. */
export const HITS_SERVICE_NAME = 'mogwai.hits';
/** Closeness centrality — a GDS-style call-only algorithm, `internal: true` like the rest. Reuses the
 *  scope-keyed `barrier_state` (`relaxShortestPath`, scope = source) that weighted shortestPath already
 *  writes: the first pair-keyed-state consumer beyond shortestPath (reshape plan item 5). */
export const CLOSENESS_SERVICE_NAME = 'mogwai.closeness';
/** Harmonic centrality — closeness's sibling (Σ 1/dist over reaching nodes, / (N−1)); shares the same
 *  scope-keyed distance relaxation. Call-only, `internal: true`. */
export const HARMONIC_SERVICE_NAME = 'mogwai.harmonic';
/** Triangle count + local clustering coefficient — ONE-SHOT decorate barriers (no BSP iteration, a single
 *  undirected self-join), call-only, `internal: true`. */
export const TRIANGLE_COUNT_SERVICE_NAME = 'mogwai.triangleCount';
export const LCC_SERVICE_NAME = 'mogwai.localClusteringCoefficient';
/** k-core decomposition — each vertex's coreness, a BSP fixpoint (the Montresor h-index update).
 *  Call-only, `internal: true`. */
export const KCORE_SERVICE_NAME = 'mogwai.kcore';
/** Betweenness centrality (Brandes) — the first KEEP-ALL-round, multi-source (scope-keyed) consumer:
 *  a per-level forward BFS accumulating shortest-path counts, then a reverse-level dependency pass.
 *  Call-only, `internal: true`. */
export const BETWEENNESS_SERVICE_NAME = 'mogwai.betweenness';
/** Node similarity (Jaccard over neighbour sets) — the first PAIR-OUTPUT barrier: a stream of
 *  `{node1, node2, similarity}` maps rather than a per-vertex decoration. Call-only, `internal: true`. */
export const NODE_SIMILARITY_SERVICE_NAME = 'mogwai.nodeSimilarity';
/** Strongly connected components — a ONE-SHOT decorate barrier over the DIRECTED graph: two vertices
 *  share a component iff they are mutually reachable, computed as a directed transitive-closure CTE.
 *  Call-only, `internal: true` (no native TinkerPop step; connectedComponent() is the UNDIRECTED wcc). */
export const SCC_SERVICE_NAME = 'mogwai.scc';
/** ArticleRank — a PageRank variant that damps a node's influence by (out-degree + average degree),
 *  so a high-degree node spreads less rank per neighbour. A MULTI-CHANNEL BSP decorate barrier (rank =
 *  channel 0, the per-round delta = channel 1, GDS's delta-accumulation formulation). Call-only,
 *  `internal: true` (no native TinkerPop step). */
export const ARTICLE_RANK_SERVICE_NAME = 'mogwai.articleRank';
