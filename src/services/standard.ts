import { createRegistry } from './spi/registry.ts';
import type { RegistryProvider } from '../scopes.ts';
import { createDirectoryService } from './catalog/directory.ts';
import { degreeCentralityService } from './catalog/degree-centrality.ts';
import { searchService } from './catalog/search.ts';
import { createFederateService } from './catalog/federate.ts';

// ---------- the standard + extended registries ----------
//
// Kept SEPARATE from registry.ts (the cycle-free mechanism) because it imports the service
// implementations, which import the compiler's stream/q kernel — importing this from the
// compiler core would cycle. Only the DI composition root (application) and the runtime entry
// points touch this module.
//
// Both are `RegistryProvider`s — FUNCTIONS OF THE APP SCOPE, not constants — because a service
// takes its dependencies at CONSTRUCTION: the directory reads the live registry (this one), the
// federated service reads the FederationSource. That is what keeps `Contribution` down to what a
// CALL genuinely carries; before this, a dependency with nowhere to live became another positional
// argument on `apply`. The scope's laziness is what makes the registry↔scope reference safe (see
// RegistryProvider in scopes.ts).
//
//   • standardRegistry — the TinkerPop REFERENCE provider surface: --list + tinker.search +
//     tinker.degree.centrality, exactly what the official corpus asserts, no extensions. The L3
//     conformance host (reference-exact) uses THIS.
//   • extendedRegistry — standard PLUS our mogwai.* extensions (the federated barrier). Production
//     uses this. Because --list enumerates the live registry, mogwai.graph.federate shows up here
//     — correct in production, absent in the reference host (so the official g_call/g_callXlistX
//     scenarios, which assert the exact reference set, stay green there).

/** The reference provider surface — the three canonical TinkerPop services. */
export const standardRegistry: RegistryProvider = (app) =>
  createRegistry([createDirectoryService(app), degreeCentralityService, searchService]);

/** The reference services PLUS our mogwai.* extensions (federation). Production. */
export const extendedRegistry: RegistryProvider = (app) =>
  createRegistry([createDirectoryService(app), degreeCentralityService, searchService, createFederateService(app.source)]);
