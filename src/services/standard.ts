import { createRegistry } from './spi/registry.ts';
import type { RegistryProvider } from '../scopes.ts';
import { createDirectoryService } from './catalog/directory.ts';
import { degreeCentralityService } from './catalog/degree-centrality.ts';
import { searchService } from './catalog/search.ts';
import { createFederateService } from './catalog/federate.ts';
import { createIoService } from './catalog/io.ts';
import { schemaService } from './catalog/schema.ts';
import { graphAlgorithmServices } from './catalog/graph-algorithms.ts';

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

/** The reference provider surface — the three canonical TinkerPop services, plus the INTERNAL
 *  services native steps desugar to. `mogwai.io` is in the REFERENCE registry deliberately: `io()` is
 *  TinkerPop's own step, so a reference-exact context must serve it, and `internal: true` keeps it
 *  out of `--list` so the exact provider surface the official scenarios assert is unchanged. The four
 *  OLAP services (pageRank/wcc/peerPressure/shortestPath) back native steps for the same reason and
 *  are `internal: true` too, so the exact `--list` surface stays unchanged. */
export const standardRegistry: RegistryProvider = (app) =>
  createRegistry([createDirectoryService(app), degreeCentralityService, searchService, createIoService(app.io, app.store),
    ...graphAlgorithmServices]);

/** The reference services PLUS our mogwai.* extensions (federation, schema reflection). Production.
 *  `mogwai.schema` is an EXTENSION, so it lives here and NOT in `standardRegistry`: `--list` enumerates
 *  the live registry, and the reference-exact conformance host asserts the exact TinkerPop provider set,
 *  so a `mogwai.*` service in the reference registry would fail the official `g_call`/`g_V_callXlistX`
 *  scenarios. Production (`extendedRegistry`) is where our surface belongs. */
export const extendedRegistry: RegistryProvider = (app) =>
  createRegistry([createDirectoryService(app), degreeCentralityService, searchService, createIoService(app.io, app.store),
    createFederateService(app.source), schemaService, ...graphAlgorithmServices]);
