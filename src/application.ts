import { LazyMap } from '@bodar/yadic/LazyMap.ts';
import type { Dependency } from '@bodar/yadic/types.ts';
import type { GraphStore } from './storage.js';
import { makeHandler } from './handler.js';

// The runtime-agnostic dependency graph. Platform entry points provide the
// leaves (currently just `store`); everything above is wired here and shared
// across Bun and Cloudflare. As the server grows (auth, digest, management
// endpoints…) new services layer on with `.set()`/`.decorate()`, mirroring
// talebrary's `application()`.
export interface AppDependencies extends Dependency<'store', GraphStore> {}

export function application(deps: AppDependencies) {
  return LazyMap.create(deps)
    .set('handler', ({ store }) => makeHandler(store));
}
