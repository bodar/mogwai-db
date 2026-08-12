import type { ForeignRow } from '../../api.ts';
import type { Minter } from '../../compiler/rel/build.ts';
import type { FramedRel } from '../../compiler/rel/framing.ts';
import type { ChildHost, ChildSeam, ChildValue } from '../../compiler/rel/child.ts';

// ---------- the call() service seam ----------
//
// call() is the extensibility point: a Service registers into a ServiceRegistry and
// contributes to the compile. A PURE service ('stream' Contribution) lowers to SQL
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
 *  the service runs once, the degenerate collapse). Kept un-lowered so lowerCall can classify it
 *  (→ InjectionKind) and push it against the correct ChildFrameStack. */
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
 *  tinker.search) ignores `parent`/`scope`; a per-parent service (tinker.degree.centrality) requires
 *  them (lowerCall pushes the child scope BEFORE building, so `parent` is already the pushed seed).
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
}

/**
 * **`CallSite` IS THE WHOLE CONTRACT `resolve` NEEDS, and the spine-specific half is BUILD's.**
 *
 * It used to carry `q: Query` outright, which made it legacy-shaped: a `Query` is the q-kernel's CTE
 * accumulator, so a RelIR service could not be handed one — it composes an algebra that RelIR names
 * and renders once, and holding a `Query` would mean building SQL beside the plan rather than inside
 * it (the second bind-ordering authority §5 exists to prevent).
 *
 * Measured against the services: `resolve` reads only params and the hop depth — every catalog
 * service either ignores its site entirely or reads `params`/`federationDepth`. `RelCallSite` below
 * is the one remaining extension, for a contribution that BUILDS. `StreamCallSite` was the other and
 * is gone with the `stream` arm: it typed the SPI on legacy's `Stream`/`ChildParent`/`ChildFrameStack`
 * and was the last direct import of `src/compiler/steps/` from outside it (§10 Phase 0).
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
 *  **A THIRD arm, `stream`, is DELETED.** It was the legacy spine's inline contribution, and the
 *  transitional pair existed so services could migrate ONE AT A TIME — a `rel` service made legacy's
 *  call route decline, a `stream` service made RelIR's decline. All three pure services are `rel`
 *  now, so the arm and legacy's stream call route go together, exactly as §6·1 demands of a harness.
 *
 *  `apply` takes ONLY the drained input rows (empty for a source-form call) — the one value that
 *  is genuinely per-execution. Everything it used to take positionally now arrives where it
 *  belongs: the FederationSource at construction (an app-scope dependency), the params and this
 *  hop's federation depth off the `CallSite` that `resolve` already receives. */
export type Contribution =
  | { readonly kind: 'rel'; buildRel(site: RelCallSite): RelContribution | null }
  | { readonly kind: 'barrier'; apply(rows: readonly BarrierInput[]): Promise<ForeignRow[]> };

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

// ---------- the `rel` arm: the same contribution, lowered into the RelIR fold ----------
//
// `stream` and `rel` are the SAME contribution expressed for the two spines, and a service implements
// exactly ONE of them — never both, which would be the duplicated lowering `steps/CLAUDE.md` forbids
// outright. The discriminant is what routes: a `rel` service makes LEGACY's call route decline, a
// `stream` service makes RELIR's call step decline (the ordinary "not learned yet" `null`, needing no
// special case on either side). So services migrate one at a time, each its own green commit, and the
// `stream` arm is deleted with legacy's call route when none is left.
//
// `barrier` is untouched by either: it contributes no lowering at all — its rows arrive from an
// awaited sibling and `apply` runs at EXECUTION time, in the executor's segment loop. Federation and
// io are spine-independent already, and the planned iterative graph algorithms
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
 *  `q` is absent and its absence is the point: a `Query` is legacy's CTE accumulator, and a `rel`
 *  service composes an algebra that RelIR names and renders once. A service holding a `Query` would
 *  be building SQL beside the plan rather than inside it — the second bind-ordering authority §5
 *  exists to prevent. */
export interface RelCallSite extends CallSite {
  readonly fresh: Minter;
  /**
   * The enclosing traverser and the child seam — present ONLY for a mid-traversal `call()`, which is
   * the `StreamCallSite.parent`/`scope` pair expressed for this spine.
   *
   * A `streaming` service needs both and a `start` service ignores both, which is the same asymmetry
   * `StreamCallSite` has. What is different is what they ARE: legacy hands over a `ChildParent` plus
   * a `ChildFrameStack` — its own per-traverser scope machinery — where this is the host row and the
   * ONE child seam (§6·6), so a service asks the identical question every `by()` body asks and gets
   * the identical answer.
   */
  readonly host?: ChildHost;
  readonly child?: ChildSeam;
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
