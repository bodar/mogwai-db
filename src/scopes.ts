// ---------- dependency scopes (DI lifecycles) ----------
//
// The compiler's dependencies are separated from per-query STATE (LoweringState, compiler/steps/context.ts)
// and grouped by LIFECYCLE into named scopes. Downstream code depends ONLY on the scope
// INTERFACES below (`Dependency<K,V>` contracts) — never on the LazyMap backing them, so the
// DI mechanism stays hidden and swappable (a test can build a scope and override one entry).
//
//   • AppScope      — one per process/runtime. The ambient capabilities fixed for the whole
//                     server: which services exist (registry), which optimizations are on
//                     (fastPaths), how to reach other graphs (source). Held by the store tier.
//   • RequestScope  — one per client REQUEST, a CHILD of an AppScope. One request = one traversal
//                     (its gremlin text + bound params); a federated hop to a sibling graph IS a
//                     new request, with its own params and its own depth. Everything here is
//                     invariant across the whole compile, nested sub-compiles included — which is
//                     why a nested compile no longer restates any of it.
//   • CompilerScope — one per compile() call, a CHILD of a RequestScope. What a single compile
//                     owns and a sibling compile must NOT share: a fresh CTE-accumulator Query.
//                     (`params` is overridable here, because a sub-compile that seeds its own
//                     source — inject() — deliberately lowers against an empty param table.)
//                     The lowering OBJECTS (the Lowerer + family compilers) are built here,
//                     closing over the request + compiler scopes — see compiler/engine.
//
// LazyMaps are cheap: create as many as there are lifecycles. `createCompilerScope(request, …)`
// mints a fresh compiler scope for each traversal (root or nested sub-compile) — the app and
// request scopes are shared down the whole compile, the compiler scope is not.

import { LazyMap, instance } from '@bodar/yadic/LazyMap.ts';
import type { Dependency } from '@bodar/yadic/types.ts';
import { Query } from './sql/kernel/q.ts';
import { DEFAULT_FAST_PATHS, type FastPathConfig } from './compiler/options/fast-paths.ts';
import type { ServiceRegistry } from './services/spi/types.ts';
import { EMPTY_REGISTRY } from './services/spi/registry.ts';
import type { FederationSource } from './compiler/segment.ts';
import { LabelCardinality } from './api.ts';

/** How the app scope OBTAINS its registry. A registry is not a value the entry point can build
 *  in isolation: a service takes its own dependencies at CONSTRUCTION (federate needs `source`,
 *  the directory needs the live registry), so the registry is a function OF the scope it lives in.
 *
 *  The apparent cycle — `AppScope` holds `registry`, the registry's members need the `AppScope` —
 *  is safe BECAUSE `LazyMap` is lazy: the entry resolves on first use, long after the scope is
 *  fully declared. With eager construction this would be a real cycle. What is NOT prevented is a
 *  service→service cycle: A resolving B resolving A overflows the stack at first call, not at
 *  compile (nothing guards it today). */
export type RegistryProvider = (app: AppScope) => ServiceRegistry;

/** The process/runtime-scoped dependency contract. */
export type AppScope =
  & Dependency<'registry', ServiceRegistry>
  & Dependency<'fastPaths', FastPathConfig>
  & Dependency<'source', FederationSource | undefined>
  // A GRAPH capability, and app scope is per-graph (one Executor, one store, one scope), so this
  // is its lifecycle. Only the VERTEX cardinality is a provider choice — edges are fixed at ONE
  // by spec, so there is nothing to declare for them.
  & Dependency<'labelCardinality', LabelCardinality>;

/** The per-REQUEST dependency contract (an AppScope plus what one traversal fixes). */
export type RequestScope =
  & AppScope
  & Dependency<'params', Record<string, any>>
  & Dependency<'federationDepth', number>
  /** Source-level `g.with(k[,v])` options — a per-TRAVERSAL configuration, and a traversal is
   *  what a request IS, so a nested sub-compile inherits them rather than losing them. */
  & Dependency<'sourceOptions', ReadonlyMap<string, any>>;

/** The per-compilation dependency contract (a RequestScope plus this compile's own Query). */
export type CompilerScope =
  & RequestScope
  & Dependency<'q', Query>;

/** Build an app scope. Every field is optional at the call site; unset falls back to the
 *  reference-safe defaults (empty registry, all fast paths on, no federation source).
 *
 *  `registry` is set LAST and is handed back the scope it lives in — the one entry whose value is
 *  a function of its own container, because its services take their dependencies at construction
 *  (federate ← `source`, the directory ← this very registry). LazyMap makes that safe: the provider
 *  runs on FIRST USE, long after `app` is assigned, so the self-reference is a closure, not a cycle. */
export function createAppScope(deps?: Partial<{
  registry: RegistryProvider;
  fastPaths: FastPathConfig;
  source: FederationSource | undefined;
  labelCardinality: LabelCardinality;
}>): AppScope {
  const app: AppScope = LazyMap.create()
    .set('fastPaths', instance(deps?.fastPaths ?? DEFAULT_FAST_PATHS))
    .set('source', instance(deps?.source))
    .set('labelCardinality', instance(deps?.labelCardinality ?? LabelCardinality.ONE))
    .set('registry', () => (deps?.registry ?? (() => EMPTY_REGISTRY))(app));
  return app;
}

/** Mint a request scope from an app scope for ONE client request (one traversal, or one
 *  federated hop into a sibling graph — which is a request of its own, one level deeper). */
export function createRequestScope(app: AppScope, deps: {
  params?: Record<string, any>;
  federationDepth?: number;
  sourceOptions?: ReadonlyMap<string, any>;
}): RequestScope {
  return LazyMap.create(app)
    .set('params', instance(deps.params ?? {}))
    .set('federationDepth', instance(deps.federationDepth ?? 0))
    .set('sourceOptions', instance(deps.sourceOptions ?? new Map()));
}

/** Mint a fresh compiler scope from a request scope for ONE traversal compile. `q` defaults to a
 *  new empty Query (the CTE namespace this compile mints into); a nested sub-compile that must
 *  stay independent simply calls this again for its own fresh Query, inheriting everything else.
 *  `params` is the ONE request entry a sub-compile may override — inject() seeds its own source
 *  and lowers against an empty param table — and an absent override inherits, rather than
 *  silently resetting to `{}` the way a mandatory argument did. */
export function createCompilerScope(request: RequestScope, deps: {
  q?: Query;
  params?: Record<string, any>;
} = {}): CompilerScope {
  const scope = LazyMap.create(request).set('q', instance(deps.q ?? new Query()));
  return deps.params ? scope.set('params', instance(deps.params)) : scope;
}
