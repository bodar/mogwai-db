import type { Stream } from '../steps/stream.ts';
import type { CompileScope, ChildParent } from '../steps/child.ts';
import type { Query } from '../q.ts';

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

/** What a call() site parsed to before registry lookup — the service name plus its
 *  resolved constant params. Shared by the source form (g.call(...)) and the
 *  mid-traversal form (V().call(...)). */
export interface CallSpec {
  readonly serviceName: string;
  readonly params: CallParams;
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

/** How a Service contributes to the plan. 'stream' is a pure, inline-SQL contribution
 *  (Phases 1-5). 'barrier' is the Phase-6 async/federated shape; unreachable today. */
export type Contribution =
  | { readonly kind: 'stream'; build(ctx: ServiceCallCtx): Stream }
  | { readonly kind: 'barrier'; apply(rows: unknown[], params: CallParams, env: unknown): Promise<unknown[]> | unknown[] };

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
