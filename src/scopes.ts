// ---------- dependency scopes (DI lifecycles) ----------
//
// The compiler's dependencies are separated from per-compile STATE (threaded explicitly, not a scope)
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
// There is deliberately NO compile-scope tier. What one compile owns and a sibling compile must
// not share — its fresh CTE-accumulator Query, and (for inject() alone) an override of the bound
// param table — is per-compile STATE, threaded explicitly through the lowering rather than held in
// DI. Making it a third scope only duplicated that state into the container.
//
// LazyMaps are cheap: create as many as there are lifecycles.

import { LazyMap, instance } from '@bodar/yadic/LazyMap.ts';
import type { Dependency } from '@bodar/yadic/types.ts';
import { DEFAULT_FAST_PATHS, type FastPathConfig } from './compiler/options/fast-paths.ts';
import type { ServiceRegistry } from './services/spi/types.ts';
import { EMPTY_REGISTRY } from './services/spi/registry.ts';
import type { FederationSource } from './compiler/segment.ts';
import { NO_IO_STORE, type IoStore } from './iostore.ts';
import type { GraphStore } from './storage.ts';

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
  /** Where io() reads and writes whole-graph documents (iostore.ts). Per-graph, like the store.
   *  Never undefined: an unbound one fails closed naming the missing binding. */
  & Dependency<'io', IoStore>
  /** THIS graph's rows. Per-graph by lifetime, and per-graph is what app scope means here.
   *
   *  The plan (§4) preferred the request tier to keep a store out of COMPILE-time reach; that
   *  premise held only while the engine took an `AppScope` directly. It now takes a `RequestScope`
   *  and publishes a hand-picked `Engine` interface, so compile-time code cannot reach ANY scope
   *  object — the tier no longer decides the visibility, the Engine interface does, and an
   *  app-scope store is exactly as unreachable as a request-scope one. Undefined for a compile
   *  with no executor behind it (a bare `compile()`); a service that needs rows fails closed. */
  & Dependency<'store', GraphStore | undefined>;

/** The per-REQUEST dependency contract (an AppScope plus what one traversal fixes). */
export type RequestScope =
  & AppScope
  & Dependency<'params', Record<string, any>>
  & Dependency<'federationDepth', number>
  /** Source-level `g.with(k[,v])` options — a per-TRAVERSAL configuration, and a traversal is
   *  what a request IS, so a nested sub-compile inherits them rather than losing them. */
  & Dependency<'sourceOptions', ReadonlyMap<string, any>>;

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
  io: IoStore;
  store: GraphStore | undefined;
}>): AppScope {
  const app: AppScope = LazyMap.create()
    .set('fastPaths', instance(deps?.fastPaths ?? DEFAULT_FAST_PATHS))
    .set('source', instance(deps?.source))
    .set('io', instance(deps?.io ?? NO_IO_STORE))
    .set('store', instance(deps?.store))
    .set('registry', () => (deps?.registry ?? (() => EMPTY_REGISTRY))(app));
  return app;
}

/** A STORE-FREE app scope for compiling where no store exists — the Worker EDGE, which compiles a
 *  traversal and ships the plan to the DO (edge-compilation Phase 1). It is `createAppScope` with the
 *  execution-only slots left at their defaults: `store`/`source` undefined, `io` the fail-closed
 *  NO_IO_STORE. That is sound because compile reads only settled VALUES (fastPaths, the registry
 *  resolved to named services, the request's params/sourceOptions) and never INVOKES the store/io/
 *  source — those are captured by service constructors and used only in a barrier's `apply`, which is
 *  execution, not compile.
 *
 *  The caller MUST pass the SAME registry + fastPaths the executing tier uses, or the edge would ship
 *  a plan the DO would not have compiled — so both are explicit, not defaulted here. This is the
 *  "multiple app scopes, shared code" split: one factory, the edge omitting what it cannot have. */
export function createCompileScope(registry: RegistryProvider, fastPaths?: FastPathConfig): AppScope {
  return createAppScope({ registry, fastPaths });
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

