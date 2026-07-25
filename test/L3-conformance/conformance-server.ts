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
import { standardRegistry } from '../../src/services/standard.ts';
import { application } from '../../src/application.ts';
import { LoggingGraphManager, telemetryPath, clearTelemetry, expectedErrorSubstrings, progressMark } from './telemetry.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { CREW_SEED } from '../fixtures/seed-crew.ts';
import { UID_SEED } from '../fixtures/seed-uid.ts';
import { graphsonSeed } from '../fixtures/seed-graphson.ts';

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
  // ggrateful (808 v / 8049 e): now seeded. Its blocker was the whole-graph
  // `repeat(out()).times(N).count()` scenarios whose answers are astronomically large
  // (times(8) → 2.5e15); mogwai used to materialize each traverser as a UNION-ALL row
  // and would hang building quadrillions of rows. TRAVERSER BULKING (src/compiler/steps/tail/bulk.ts,
  // docs/2026-07-14-traverser-bulking.md) compiles those to unrolled GROUP-BY-SUM(bulk)
  // CTEs — times(8).count() now returns 2505037961767380 in ~10ms. Every other grateful
  // scenario either works, or fails closed at compile with a clear "not yet supported"
  // (match/union-in-repeat/order-in-repeat), so none execute a runaway materialization
  // (verified by running all 39 grateful queries in isolation: zero hangs).
  ggrateful: graphsonSeed(relToRepo(`${GRAPHSON}/grateful-dead-v3.json`)),
};

export async function startConformanceServer(port = 45940) {
  // The conformance host emulates the REFERENCE provider exactly: only the tinker.* / --list
  // services, NOT our mogwai.* extensions. The official g_call / g_callXlistX scenarios assert
  // --list returns exactly the reference set, so registering our federated service (which --list
  // enumerates live) would break them. Passing a federation-free `standardRegistry()` (no env)
  // omits mogwai.graph.federate here; production Bun/CF keeps it. See docs feature matrix.
  const manager = new BunGraphManager(undefined, standardRegistry);
  // Seed before serving so the first scenario sees a populated graph. Each write
  // traversal goes through the manager seam exactly as a client request would.
  for (const [g, queries] of Object.entries(SEEDS)) {
    for (const q of queries) manager.executor(g).framed(q, {}); // sync — seeds are non-federated writes
  }
  // L3 telemetry (always on): wrap the SERVED manager only — seed writes above go
  // through the raw manager, so they never pollute the capture. The decorator
  // re-throws unchanged, so the ratchet count is byte-identical.
  const tpath = telemetryPath();
  clearTelemetry(tpath);
  const served = new LoggingGraphManager(manager, tpath);
  // A compact live progress line — `.` a query that ran, `·` an EXPECTED throw (its message
  // satisfies a negative scenario's assertion, so the scenario passes), `E` a real compile/exec
  // gap. A wrong-answer still shows `.`, matching the NDJSON's ok:true. Keying `·` off the
  // corpus's own expected-error strings (not our message shape) keeps a real bug that throws a
  // canonical-looking error as `E`. The test terminates the line before the aggregate report.
  const expected = expectedErrorSubstrings(
    new URL('../../vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/test/features/', import.meta.url).pathname,
  );
  const log = (e: { ok: boolean; error?: string }) => process.stdout.write(progressMark(e, expected));
  const app = application({ manager: served, log });
  return Bun.serve({ port, fetch: app.router });
}

if (import.meta.main) {
  const server = await startConformanceServer();
  console.log(`mogwai-db conformance host on :${server.port}/gremlin (gmodern/gcrew/guid seeded)`);
}
