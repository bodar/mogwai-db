import type { Stream } from '../../compiler/steps/context/stream.ts';
import type { ChildFrameStack, ChildParent } from '../../compiler/steps/tail/child-shape.ts';
import type { Query } from '../../sql/kernel/q.ts';
import type { ForeignRow } from '../../api.ts';

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
  readonly q: Query;
  readonly boundParams: Record<string, any>;   // the traversal's bound-param table (wire bindings)
  /** This compile's federation hop depth — request-scoped, so a barrier's `apply` closure can
   *  capture it at resolve time and recurse at depth+1 without an `apply` parameter. */
  readonly federationDepth: number;
  readonly parent?: ChildParent;                 // present only for mid-traversal call()
  readonly scope?: ChildFrameStack;
}

/** ForeignRow lives in the outer API surface (src/api.ts) — it's a leaf data type on the
 *  federated-transfer contract. Re-exported here so service-author code keeps one import. */
export type { ForeignRow } from '../../api.ts';

/** How a Service contributes to the plan. 'stream' is a pure, inline-SQL contribution
 *  (Phases 1-5): it lowers to SQL synchronously and the generic engine takes over. 'barrier'
 *  is the Phase-6 async/federated shape: it does NOT lower to a Stream at compile time (its
 *  rows come from an awaited sibling call), so it yields no `build`; instead `apply` runs at
 *  EXECUTION time (the one await in the executor's segment loop) and returns the foreign rows
 *  the executor lands + resumes from.
 *
 *  `apply` takes ONLY the drained input rows (empty for a source-form call) — the one value that
 *  is genuinely per-execution. Everything it used to take positionally now arrives where it
 *  belongs: the FederationSource at construction (an app-scope dependency), the params and this
 *  hop's federation depth off the `CallSite` that `resolve` already receives. */
export type Contribution =
  | { readonly kind: 'stream'; build(site: CallSite): Stream }
  | { readonly kind: 'barrier'; apply(rows: readonly ForeignRow[]): Promise<ForeignRow[]> };

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

/** The directory command name. A service registered under it is resolvable by name but
 *  excluded from its own list() (TinkerPop's rule — expressed as `internal: true`). Lives here
 *  (a dependency-free leaf) so both call-params.ts and directory.ts import it without a cycle. */
export const DIRECTORY_SERVICE_NAME = '--list';
