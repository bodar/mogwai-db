// ---------- dependency scopes (DI lifecycles) ----------
//
// The compiler's dependencies are separated from per-query STATE (Carry, steps/context.ts)
// and grouped by LIFECYCLE into named scopes. Downstream code depends ONLY on the scope
// INTERFACES below (`Dependency<K,V>` contracts) — never on the LazyMap backing them, so the
// DI mechanism stays hidden and swappable (a test can build a scope and override one entry).
//
//   • AppScope      — one per process/runtime. The ambient capabilities fixed for the whole
//                     server: which services exist (registry), which optimizations are on
//                     (fastPaths), how to reach other graphs (source). Held by the store tier.
//   • CompilerScope — one per compile() call, a CHILD of an AppScope (inherits its entries).
//                     The per-compilation collaborators: a fresh CTE-accumulator Query, the
//                     bound params, this compile's federation depth. The lowering OBJECTS
//                     (the Lowerer + family compilers) are built here, closing over both
//                     scopes — see compiler/engine (Movement 1.2+).
//
// LazyMaps are cheap: create as many as there are lifecycles. `createCompilerScope(app, …)`
// mints a fresh compiler scope from an app scope for each traversal (root or nested sub-
// compile) — the app scope is shared, the compiler scope is not.

import { LazyMap, instance } from '@bodar/yadic/LazyMap.ts';
import type { Dependency } from '@bodar/yadic/types.ts';
import { Query } from './sql/kernel/q.ts';
import { DEFAULT_FAST_PATHS, type FastPathConfig } from './compiler/options/fast-paths.ts';
import type { ServiceRegistry } from './services/spi/types.ts';
import { EMPTY_REGISTRY } from './services/spi/registry.ts';
import type { FederationSource } from './compiler/segment.ts';

/** The process/runtime-scoped dependency contract. */
export type AppScope =
  & Dependency<'registry', ServiceRegistry>
  & Dependency<'fastPaths', FastPathConfig>
  & Dependency<'source', FederationSource | undefined>;

/** The per-compilation dependency contract (an AppScope plus the per-compile collaborators). */
export type CompilerScope =
  & AppScope
  & Dependency<'q', Query>
  & Dependency<'params', Record<string, any>>
  & Dependency<'federationDepth', number>;

/** Build an app scope. Every field is optional at the call site; unset falls back to the
 *  reference-safe defaults (empty registry, all fast paths on, no federation source). */
export function createAppScope(deps?: Partial<{
  registry: ServiceRegistry;
  fastPaths: FastPathConfig;
  source: FederationSource | undefined;
}>): AppScope {
  return LazyMap.create()
    .set('registry', instance(deps?.registry ?? EMPTY_REGISTRY))
    .set('fastPaths', instance(deps?.fastPaths ?? DEFAULT_FAST_PATHS))
    .set('source', instance(deps?.source));
}

/** Mint a fresh compiler scope from an app scope for ONE traversal compile. `q` defaults to a
 *  new empty Query (the CTE namespace this compile mints into); a nested sub-compile that must
 *  stay independent simply calls this again for its own fresh Query. */
export function createCompilerScope(app: AppScope, deps: {
  params?: Record<string, any>;
  federationDepth?: number;
  q?: Query;
}): CompilerScope {
  return LazyMap.create(app)
    .set('q', instance(deps.q ?? new Query()))
    .set('params', instance(deps.params ?? {}))
    .set('federationDepth', instance(deps.federationDepth ?? 0));
}
