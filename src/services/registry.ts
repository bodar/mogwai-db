import type { Service, ServiceRegistry } from './types.ts';

// ---------- the ServiceRegistry ----------
//
// A per-runtime DI seam, sibling to GraphManager. Holds the registered services;
// `--list` (DirectoryService) enumerates it live, so a service added here shows up in
// --list with no extra work. `defaultRegistry` is pre-seeded with the standard services
// and baked into the store tier at compile time — every Phase-1-5 service is pure SQL
// (no runtime env), so construction takes no runtime parameter yet. Phase 6's federated
// service is where a per-runtime env (sibling-DO stub vs Bun GraphManager entry) gets
// injected at construction; createRegistry gains that parameter then, additively.

/** A service whose `name` is the directory command ("--list") is registered like any
 *  other but EXCLUDED from its own enumeration (TinkerPop's rule). */
export const DIRECTORY_SERVICE_NAME = '--list';

class MapRegistry implements ServiceRegistry {
  private readonly byName: Map<string, Service>;
  constructor(services: readonly Service[]) {
    this.byName = new Map(services.map((s) => [s.name, s]));
  }
  get(name: string): Service | undefined {
    return this.byName.get(name);
  }
  list(): readonly Service[] {
    return [...this.byName.values()].filter((s) => s.name !== DIRECTORY_SERVICE_NAME);
  }
}

export function createRegistry(services: readonly Service[]): ServiceRegistry {
  return new MapRegistry(services);
}

/** The shared, pre-seeded registry. Populated with the standard services as each phase
 *  lands; empty for now (Step 1 — pure plumbing). */
export const defaultRegistry: ServiceRegistry = createRegistry([]);
