import { LazyMap } from '@bodar/yadic/LazyMap.ts';
import type { Dependency } from '@bodar/yadic/types.ts';
import type { GraphManager } from './manager.ts';
import { makeRouter, type QueryLogger, type FilterValidator } from './router.ts';
import type { ReplicatorRegistry } from './replicator-registry.ts';
import type { AssetStore } from './assetstore.ts';

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
  /** Where the docs' static assets live — the Bun binary-embedded copy or the CF Workers Static Assets
   *  binding, behind the runtime-agnostic {@link AssetStore} seam. Optional; an entry that wires it also
   *  sets `scalarUrl: './scalar.js'` so the docs load the Scalar UI same-origin instead of the CDN. */
  assets?: AssetStore;
  /** Where the docs shell loads the Scalar UI module from. Absent ⇒ makeRouter's pinned-CDN default; an
   *  entry wiring `assets` passes `'./scalar.js'` so the UI is served locally by that AssetStore. */
  scalarUrl?: string;
}

export function application(deps: AppDependencies) {
  return LazyMap.create(deps)
    // `bootScript` (position 8) + `docsBaseUrl` (position 10) are browser-only and left at their defaults
    // here — the browser edge calls makeRouter directly (src/browser/service-worker.ts). `scalarUrl` (7) and
    // `assets` (11), by contrast, ARE set here: a server entry (Bun/CF) that wires an AssetStore also passes
    // `scalarUrl: './scalar.js'` so the self-hosted UI loads same-origin. Absent both, makeRouter uses the CDN.
    .set('router', ({ manager }) => makeRouter(manager, deps.pathPrefix, deps.log, deps.registry, deps.runTick, deps.validateFilter, deps.scalarUrl, undefined, deps.version, undefined, deps.assets));
}
