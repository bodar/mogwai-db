import { createRegistry } from './spi/registry.ts';
import type { ServiceRegistry } from './spi/types.ts';
import { directoryService } from './catalog/directory.ts';
import { degreeCentralityService } from './catalog/degree-centrality.ts';
import { searchService } from './catalog/search.ts';
import { federateService } from './catalog/federate.ts';

// ---------- the standard + extended registries ----------
//
// Kept SEPARATE from registry.ts (the cycle-free mechanism) because it imports the service
// implementations, which import the compiler's stream/q kernel — importing this from the
// compiler core would cycle. Only the DI composition root (application) and the runtime entry
// points touch this module.
//
// TWO named registries — both plain constants (the federated service gets its FederationSource
// threaded to `apply` at EXECUTION time, so neither registry needs a construction-time env):
//   • standardRegistry — the TinkerPop REFERENCE provider surface: --list + tinker.search +
//     tinker.degree.centrality, exactly what the official corpus asserts, no extensions. The L3
//     conformance host (reference-exact) uses THIS.
//   • extendedRegistry — standard PLUS our mogwai.* extensions (the federated barrier). Production
//     uses this. Because --list enumerates the live registry, mogwai.graph.federate shows up here
//     — correct in production, absent in the reference host (so the official g_call/g_callXlistX
//     scenarios, which assert the exact reference set, stay green there).

/** The reference provider surface — the three canonical TinkerPop services. */
export const standardRegistry: ServiceRegistry = createRegistry([directoryService, degreeCentralityService, searchService]);

/** The reference services PLUS our mogwai.* extensions (federation). Production. */
export const extendedRegistry: ServiceRegistry = createRegistry([directoryService, degreeCentralityService, searchService, federateService]);
