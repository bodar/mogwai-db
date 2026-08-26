import { createRegistry } from './spi/registry.ts';
import type { AppScope, RegistryProvider } from '../scopes.ts';
import type { Service } from './spi/types.ts';
import { createDirectoryService } from './catalog/directory.ts';
import { degreeCentralityService } from './catalog/degree-centrality.ts';
import { searchService } from './catalog/search.ts';
import { createFederateService } from './catalog/federate.ts';
import { createIoService } from './catalog/io.ts';
import { schemaService } from './catalog/schema.ts';
import { createShortestPathService } from './catalog/olap/shortest-path.ts';
import { createWccService } from './catalog/olap/wcc.ts';
import { createPageRankService } from './catalog/olap/pagerank.ts';
import { createPeerPressureService } from './catalog/olap/peer-pressure.ts';
import { createHitsService } from './catalog/olap/hits.ts';
import { createClosenessService, createHarmonicService } from './catalog/olap/centrality.ts';
import { createTriangleCountService, createLocalClusteringService } from './catalog/olap/triangle.ts';
import { createKCoreService } from './catalog/olap/kcore.ts';
import { createBetweennessService } from './catalog/olap/betweenness.ts';
import { createNodeSimilarityService } from './catalog/olap/node-similarity.ts';
import { createSccService } from './catalog/olap/scc.ts';
import { createArticleRankService } from './catalog/olap/articlerank.ts';

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
//   • extendedRegistry — standard PLUS our own extensions (the `federate` barrier). Production
//     uses this. Because --list enumerates the live registry, `federate` shows up here
//     — correct in production, absent in the reference host (so the official g_call/g_callXlistX
//     scenarios, which assert the exact reference set, stay green there). Our extensions are
//     UN-namespaced (`federate`, not `mogwai.graph.federate`): there is one implementation of this
//     provider — us — so the namespace TinkerPop uses to avoid provider collisions buys nothing and
//     only costs ergonomics. This holds for EVERY extension of ours — `federate`, `schema`, and the
//     internal OLAP desugar targets (`pageRank`/`wcc`/…) are all root-level. Only TinkerPop's own
//     reference names keep a namespace (`tinker.search`, `tinker.degree.centrality`), because those
//     are the surface the conformance corpus asserts verbatim.

/** The reference provider surface — the three canonical TinkerPop services, plus the INTERNAL
 *  services native steps desugar to. `io` is in the REFERENCE registry deliberately: `io()` is
 *  TinkerPop's own step, so a reference-exact context must serve it, and `internal: true` keeps it
 *  out of `--list` so the exact provider surface the official scenarios assert is unchanged. The four
 *  OLAP services (pageRank/wcc/peerPressure/shortestPath) back native steps for the same reason and
 *  are `internal: true` too, so the exact `--list` surface stays unchanged. */
/** The reference core — the three canonical TinkerPop services (`--list`, `tinker.search`,
 *  `tinker.degree.centrality`) plus internal `io()`, shared by both registries. */
const coreServices = (app: AppScope): Service[] =>
  [createDirectoryService(app), degreeCentralityService, searchService, createIoService(app.io, app.store)];

/** The OLAP algorithm services — native steps (shortestPath/wcc/pageRank/peerPressure) plus the
 *  GDS-style extensions — shared by both registries. One list so adding an algorithm is a single edit,
 *  not two, and the reference and extended surfaces cannot drift apart on it. All are `internal: true`,
 *  so this list never changes the exact `--list` provider surface either host asserts. */
const olapServices = (app: AppScope): Service[] =>
  [createShortestPathService(app.store), createWccService(app.store), createPageRankService(app.store), createPeerPressureService(app.store), createHitsService(app.store), createClosenessService(app.store), createHarmonicService(app.store), createTriangleCountService(app.store), createLocalClusteringService(app.store), createKCoreService(app.store), createBetweennessService(app.store), createNodeSimilarityService(app.store), createSccService(app.store), createArticleRankService(app.store)];

export const standardRegistry: RegistryProvider = (app) =>
  createRegistry([...coreServices(app), ...olapServices(app)]);

/** The reference services PLUS our own extensions (federation, schema reflection). Production.
 *  `federate` and `schema` are EXTENSIONS, so they live here and NOT in `standardRegistry`: `--list` enumerates
 *  the live registry, and the reference-exact conformance host asserts the exact TinkerPop provider set,
 *  so a `mogwai.*` service in the reference registry would fail the official `g_call`/`g_V_callXlistX`
 *  scenarios. Production (`extendedRegistry`) is where our surface belongs. */
export const extendedRegistry: RegistryProvider = (app) =>
  createRegistry([...coreServices(app), createFederateService(app.source), schemaService, ...olapServices(app)]);
