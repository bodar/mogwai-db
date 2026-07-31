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
import { ZOO_SEED } from '../fixtures/seed-zoo.ts';
import { LabelCardinality } from '../../src/api.ts';
import { UID_SEED } from '../fixtures/seed-uid.ts';
import { loadGraphson } from '../../src/formats/graphson.ts';
import { readFileSync } from 'node:fs';

// Reference graphs load from their canonical GraphSON v3 files in the pinned submodule, through the
// TYPED reader + bulk loader (src/formats/graphson.ts) rather than as write traversals. Two things
// that buys, both measured: ggrateful's seed goes from 4.4s / 98,198 statements to ~0.14s / 1,482
// (the whole `beforeAll` timing cliff this file used to document), and the file's TYPES survive — the
// old string-building seed unwrapped every `@type` and re-emitted a bare literal, so a `g:Double` of
// 1.0 re-entered as an int.
//
// The HAND-AUTHORED seeds below stay write traversals on purpose (plan doc §6): they go through the
// same parse→compile→execute path a client uses, so a broken write path cannot produce a correct
// fixture, and they are the reference the loader's equivalence test compares against (test/bulk.test.ts).
// A bulk load is only trustworthy while that comparison exists.
const GRAPHSON = 'vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/structure/io/graphson';
const relToRepo = (p: string) => new URL(`../../${p}`, import.meta.url).pathname;

/** A reference graph's seed: hand-authored write traversals, or a GraphSON adjacency file. */
type Seed = readonly string[] | { readonly graphson: string };

const SEEDS: Record<string, Seed> = {
  gmodern: MODERN_SEED,
  // gcrew: the multi/meta-property showcase (list-cardinality location + startTime/endTime meta).
  gcrew: CREW_SEED,
  // guid: a UserSuppliedIds graph (not part of the official suite) — used by the
  // in-repo conformance test to prove external-id framing on the read path.
  guid: UID_SEED,
  // gsink: the self-loop reference graph (loops/message vertices). Safe to seed — small
  // and acyclic-enough that no scenario explodes.
  gsink: { graphson: relToRepo(`${GRAPHSON}/tinkerpop-sink-v3.json`) },
  // ggrateful (808 v / 8049 e): now seeded. Its blocker was the whole-graph
  // `repeat(out()).times(N).count()` scenarios whose answers are astronomically large
  // (times(8) → 2.5e15); mogwai used to materialize each traverser as a UNION-ALL row
  // and would hang building quadrillions of rows. TRAVERSER BULKING (src/compiler/steps/tail/bulk.ts,
  // docs/archive/2026-07-14-traverser-bulking.md) compiles those to unrolled GROUP-BY-SUM(bulk)
  // CTEs — times(8).count() now returns 2505037961767380 in ~10ms. Every other grateful
  // scenario either works, or fails closed at compile with a clear "not yet supported"
  // (match/union-in-repeat/order-in-repeat), so none execute a runaway materialization
  // (verified by running all 39 grateful queries in isolation: zero hangs).
  ggrateful: { graphson: relToRepo(`${GRAPHSON}/grateful-dead-v3.json`) },
  // gzoo: the TinkerPop 4 multi-label showcase. Hand-transcribed rather than loaded, because the
  // shipped .kryo cannot carry multi-label vertices — see test/fixtures/seed-zoo.ts.
  gzoo: ZOO_SEED,
  // gmultilabel: EMPTY, like ggraph — @MultiLabel scenarios build it with their own graph
  // initializer and the runner cleans it with g.V().drop() between scenarios. It needs no seed,
  // only its declared cardinality (above), which provisioning applies on first access.
  gmultilabel: [],
};

/**
 * Start the host, seeding `graphs` (default: ALL of SEEDS — what the official cucumber runner
 * needs, since a scenario may select any reference graph).
 *
 * Seeding used to be the whole startup cost, dominated by ONE graph: ggrateful was 8,857 write
 * traversals ≈ 4.4s of a ≈5.0s total, because a seed ran one parse→compile→execute per vertex/edge.
 * It now lands through the bulk loader (≈0.14s), so the `beforeAll` timing cliff that put this within
 * ~20ms of bun's DEFAULT 5000ms hook timeout — and flaked about half the time — is gone.
 *
 * Naming the graphs you need is still worth doing: it is the honest statement of the fixture a test
 * depends on. It is no longer load-bearing for the timeout.
 */
export async function startConformanceServer(port = 45940, graphs: readonly string[] = Object.keys(SEEDS)) {
  // The conformance host emulates the REFERENCE provider exactly: only the tinker.* / --list
  // services, NOT our mogwai.* extensions. The official g_call / g_callXlistX scenarios assert
  // --list returns exactly the reference set, so registering our federated service (which --list
  // enumerates live) would break them. Passing a federation-free `standardRegistry()` (no env)
  // omits mogwai.graph.federate here; production Bun/CF keeps it. See docs feature matrix.
  // gmultilabel and gzoo are the MULTI-LABEL sources the official runner expects beside the
  // single-label reference graphs: feature-steps.js routes an @MultiLabel scenario's empty graph
  // to `gmultilabel`, and the zoo graph "requires a graph configured with
  // LabelCardinality.ZERO_OR_MORE" (LoadGraphWith.GraphData.ZOO). Everything else stays ONE, so
  // the untagged *_single_label_graph scenarios still get their refusal.
  const manager = new BunGraphManager(undefined, standardRegistry, (id) =>
    id === 'gmultilabel' || id === 'gzoo' ? LabelCardinality.ZERO_OR_MORE : LabelCardinality.ONE);
  // Seed before serving so the first scenario sees a populated graph. Each write
  // traversal goes through the manager seam exactly as a client request would.
  for (const g of graphs) {
    const seed = SEEDS[g] ?? (() => { throw new Error(`unknown reference graph "${g}" (have: ${Object.keys(SEEDS).join(', ')})`); })();
    // A GraphSON graph lands through the bulk loader against the graph's own store; a hand-authored
    // one runs its write traversals through the manager seam exactly as a client request would.
    if ('graphson' in seed) loadGraphson(manager.storeOf(g), readFileSync(seed.graphson, 'utf8'));
    else for (const q of seed) manager.executor(g).framed(q, {}); // sync — non-federated writes
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
