import { LazyMap } from '@bodar/yadic/LazyMap.ts';
import type { Dependency } from '@bodar/yadic/types.ts';
import type { GraphManager } from './manager.ts';
import { makeRouter } from './router.ts';

// The runtime-agnostic dependency graph. Platform entry points provide the one
// leaf that differs — a `GraphManager` abstracting graph lifecycle over Bun's
// in-process registry or Cloudflare's Durable Object namespace — and everything
// above (the shared HTTP router with the identical management API) is wired here
// and used by both. As the server grows (auth, digest…) new services layer on
// with `.set()`/`.decorate()`, mirroring talebrary's `application()`.
export interface AppDependencies extends Dependency<'manager', GraphManager> {}

export function application(deps: AppDependencies) {
  return LazyMap.create(deps)
    .set('router', ({ manager }) => makeRouter(manager));
}
