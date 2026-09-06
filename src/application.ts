import { LazyMap } from '@bodar/yadic/LazyMap.ts';
import type { Dependency } from '@bodar/yadic/types.ts';
import type { GraphManager } from './manager.ts';
import { makeRouter, type QueryLogger, type FilterValidator } from './router.ts';
import type { ReplicatorRegistry } from './replicator-registry.ts';

// The runtime-agnostic dependency graph. Platform entry points provide the one
// leaf that differs — a `GraphManager` abstracting graph lifecycle over Bun's
// in-process registry or Cloudflare's Durable Object namespace — and everything
// above (the shared HTTP router with the identical management API) is wired here
// and used by both. As the server grows (auth, digest…) new services layer on
// with `.set()`/`.decorate()`, mirroring the client's `application()`.
export interface AppDependencies extends Dependency<'manager', GraphManager> {
  /** Graph-path prefix (`/{pathPrefix}/{id}`). Defaults to `gremlin` in makeRouter.
   *  The bare `/gremlin` stock-client endpoint is fixed and unaffected. */
  pathPrefix?: string;
  /** Per-query stdout reporter. Defaults to the verbose one-line log; the L3 conformance
   *  host injects a compact `.`/`E` progress reporter. */
  log?: QueryLogger;
  /** The control-plane store for ongoing replication (§9), serving the top-level `/_replicator` CRUD.
   *  Optional — absent, those routes return 501 (a runtime without a scheduler yet). */
  registry?: ReplicatorRegistry;
  /** Fire one scheduler tick (`POST /_scheduler/run`) — the worker-residency runner. Optional. */
  runTick?: () => Promise<unknown>;
  /** Trial-run a config's `filter` against its source at save (filtered-replication-plan §2). Built at the
   *  entry point from its `manager` + allowlisted `http` (`validateReplicationFilter` over `peerForRef`).
   *  Optional — absent, a filter is stored unvalidated. */
  validateFilter?: FilterValidator;
  /** The version stamped into the OpenAPI `info.version` — the entry points pass `VERSION` from
   *  `src/version.ts` (the real build-stamped value; `'dev'` from source). Optional — absent, makeRouter
   *  defaults it to `'dev'`. */
  version?: string;
}

export function application(deps: AppDependencies) {
  return LazyMap.create(deps)
    // makeRouter's `scalarUrl`/`bootScript` (positions 7-8) are browser-only and left at their defaults
    // here; `version` follows. The browser edge calls makeRouter directly, so it (not application) is where
    // those docs args are set — see src/browser/service-worker.ts.
    .set('router', ({ manager }) => makeRouter(manager, deps.pathPrefix, deps.log, deps.registry, deps.runTick, deps.validateFilter, undefined, undefined, deps.version));
}
