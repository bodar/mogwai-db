import type { Service, ServiceRegistry } from './types.ts';

// ---------- the ServiceRegistry mechanism ----------
//
// This module is the cycle-free CORE: it imports only ./types.ts (a dependency-free leaf),
// NOT any service module. So the compiler can import createRegistry/EMPTY_REGISTRY for its
// default without pulling the service implementations (which import the compiler's stream/q
// kernel) back in. The pre-seeded `standardRegistry` — which DOES import the services —
// lives in ./standard.ts, reached only by the DI layer (application/entry points), never by
// the compiler core.
//
// The registry is a DI seam sibling to GraphManager, injected through application(deps) and
// lazily constructed by yadic. `--list` (DirectoryService) enumerates it live — minus every
// service that declares itself `internal`, which is how the directory excludes itself and how a
// sugar-backing service stays out of the reference provider surface the official corpus asserts.

class MapRegistry implements ServiceRegistry {
  private readonly byName: Map<string, Service>;
  constructor(services: readonly Service[]) {
    this.byName = new Map(services.map((s) => [s.name, s]));
  }
  get(name: string): Service | undefined {
    return this.byName.get(name);
  }
  list(): readonly Service[] {
    return [...this.byName.values()].filter((s) => !s.internal);
  }
}

export function createRegistry(services: readonly Service[]): ServiceRegistry {
  return new MapRegistry(services);
}

/** The empty registry — the compiler's default when none is injected. A call() against it
 *  throws "unknown service" (correct: no service is available). Non-call traversals never
 *  touch it. Imports no service modules, so it is cycle-free. */
export const EMPTY_REGISTRY: ServiceRegistry = createRegistry([]);
