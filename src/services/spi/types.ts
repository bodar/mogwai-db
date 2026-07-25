import type { Stream } from '../../compiler/steps/context/stream.ts';
import type { CompileScope, ChildParent } from '../../compiler/steps/tail/child-shape.ts';
import type { Query } from '../../sql/kernel/q.ts';

// ---------- the call() service seam ----------
//
// call() is the extensibility point: a Service registers into a ServiceRegistry and
// contributes to the compile. A PURE service ('stream' Contribution) lowers to SQL
// inline — the only kind Phases 1-5 implement, so the whole compile→lower→materialize
// pipeline stays synchronous. The 'barrier' variant is the async/federated shape
// (Phase 6); it lives in the type NOW so the seam is provably additive, but its executor
// path throws a clear deferral until that phase lands. See
// docs/2026-07-20-call-service-registry-plan.md.

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
 *  (→ InjectionKind) and push it against the correct CompileScope. */
export interface CallSpec {
  readonly serviceName: string;
  readonly params: CallParams;
  readonly injectionTraversal?: any;
}

/** Compile-time context handed to a Service. A superset the resolver reads selectively:
 *  a source service (--list, tinker.search) ignores `parent`/`scope`; a per-parent
 *  service (tinker.degree.centrality) requires them (lowerCall pushes the child scope
 *  BEFORE building, so `parent` is already the pushed seed). */
export interface ServiceCallCtx {
  readonly params: CallParams;
  readonly q: Query;
  readonly compileParams: Record<string, any>;   // the traversal's bound-param table
  readonly registry: ServiceRegistry;            // so --list can enumerate the live registry
  readonly parent?: ChildParent;                 // present only for mid-traversal call()
  readonly scope?: CompileScope;
}

/** ForeignRow lives in the outer API surface (src/api.ts) — it's a leaf data type on the
 *  federated-transfer contract. Re-exported here so service-author code keeps one import. */
export type { ForeignRow } from '../../api.ts';
import type { ForeignRow } from '../../api.ts';
import type { FederationSource } from '../../compiler/segment.ts';

/** How a Service contributes to the plan. 'stream' is a pure, inline-SQL contribution
 *  (Phases 1-5): it lowers to SQL synchronously and the generic engine takes over. 'barrier'
 *  is the Phase-6 async/federated shape: it does NOT lower to a Stream at compile time (its
 *  rows come from an awaited sibling call), so it yields no `build`; instead `apply` runs at
 *  EXECUTION time (the one await in the executor's segment loop), taking the drained input rows
 *  (empty for a source-form call), the resolved params, the FederationSource (how to reach other
 *  graphs), and this hop's federation depth, and returning the foreign rows the executor lands +
 *  resumes from. */
export type Contribution =
  | { readonly kind: 'stream'; build(ctx: ServiceCallCtx): Stream }
  | { readonly kind: 'barrier'; apply(rows: readonly ForeignRow[], params: CallParams, source: FederationSource, depth: number): Promise<ForeignRow[]> };

export interface Service {
  readonly name: string;
  /** TinkerPop Service.Type — 'start' (a source producer), 'streaming' (per-input),
   *  'barrier' (collect-all, async). Load-bearing for the future batching path. */
  readonly type: 'start' | 'streaming' | 'barrier';
  /** The describe blob for `--list --verbose`. A minimal `{}` is fine for now. */
  describeParams(): Record<string, unknown>;
  resolve(ctx: ServiceCallCtx): Contribution;
}

export interface ServiceRegistry {
  get(name: string): Service | undefined;
  /** Enumeration order for --list — EXCLUDES the directory service itself. */
  list(): readonly Service[];
}

/** The directory command name. A service registered under it is resolvable by name but
 *  excluded from its own list() (TinkerPop's rule). Lives here (a dependency-free leaf) so
 *  both registry.ts and directory.ts import it without a cycle. */
export const DIRECTORY_SERVICE_NAME = '--list';
