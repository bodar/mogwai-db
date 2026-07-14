// L3 conformance host: the SAME shared stack the production Bun server runs
// (`application` over a `BunGraphManager`), just with the reference toy graphs
// pre-seeded. The official cucumber suite connects to one URL
// (http://localhost:45940/gremlin) and selects a graph by the traversal-source
// name in the request `g` field:
//
//   modern -> gmodern   crew -> gcrew   (empty/other -> auto-created empty)
//
// The router's bare `/gremlin` endpoint resolves that `g` field to the graph id —
// no dev-only handler fork, no StoreSource resolver. Seeding runs the canonical
// graphs' write traversals through the normal query path (see seed-modern.ts), so
// it is identical on Bun and Cloudflare — a graph is seeded by talking to it.
import { BunGraphManager } from '../../src/bun/BunGraphManager.ts';
import { application } from '../../src/application.ts';
import { MODERN_SEED } from './seed-modern.ts';
import { CREW_SEED } from './seed-crew.ts';
import { UID_SEED } from './seed-uid.ts';
import { graphsonSeed } from './seed-graphson.ts';

// Reference graphs load from their canonical GraphSON v3 files in the pinned submodule
// (sink 3 vertices) — turned into write traversals so the integer ids land exactly
// (V(2000)/V(1000) scenarios).
const GRAPHSON = 'vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/structure/io/graphson';
const relToRepo = (p: string) => new URL(`../../${p}`, import.meta.url).pathname;

const SEEDS: Record<string, string[]> = {
  gmodern: MODERN_SEED,
  // gcrew: the multi/meta-property showcase (list-cardinality location + startTime/endTime meta).
  gcrew: CREW_SEED,
  // guid: a UserSuppliedIds graph (not part of the official suite) — used by the
  // in-repo conformance test to prove external-id framing on the read path.
  guid: UID_SEED,
  // gsink: the self-loop reference graph (loops/message vertices). Safe to seed — small
  // and acyclic-enough that no scenario explodes.
  gsink: graphsonSeed(relToRepo(`${GRAPHSON}/tinkerpop-sink-v3.json`)),
  // ggrateful (808 v / 8049 e) is DELIBERATELY NOT seeded: its scenarios include
  // whole-graph unbounded `repeat(out()).times(N).count()` whose TinkerPop answers are
  // astronomically large (times(8) → 2.5e15). TinkerPop reaches those by BULKING
  // traversers (one (value,count) pair, not one row each); mogwai materializes each
  // traverser as a UNION-ALL row, so an unbounded repeat-count would try to build
  // quadrillions of rows and hang the (CPU-limitless) Bun host — which would hang the
  // L3 test / CI. graphsonSeed() can load it once traverser bulking exists (a separate
  // engine sub-project that also makes count() over big recursions tractable).
};

export async function startConformanceServer(port = 45940) {
  const manager = new BunGraphManager();
  // Seed before serving so the first scenario sees a populated graph. Each write
  // traversal goes through the manager seam exactly as a client request would.
  for (const [g, queries] of Object.entries(SEEDS)) {
    for (const q of queries) await manager.query(g, q, {});
  }
  const app = application({ manager });
  return Bun.serve({ port, fetch: app.router });
}

if (import.meta.main) {
  const server = await startConformanceServer();
  console.log(`mogwai-db conformance host on :${server.port}/gremlin (gmodern/gcrew/guid seeded)`);
}
