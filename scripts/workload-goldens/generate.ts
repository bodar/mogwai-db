// ONE-OFF: generate the L6 workload goldens (test/L6-workload/goldens.json) against TinkerGraph.
//
//   bun scripts/workload-goldens/generate.ts                 # all graphs, via docker
//   bun scripts/workload-goldens/generate.ts --graph modern  # one graph
//   bun scripts/workload-goldens/generate.ts --dry           # run + report, write nothing
//
// NEVER run in CI and NOT a mise task: it needs docker and the network, and the build gains no
// dependency from it (nothing here is in package.json). Owner decision 2026-11-16
// (docs/2026-11-15-compositional-coverage-plan.md §3 cc0-workload): the goldens are generated ONCE,
// offline, against the reference, and committed with this script; re-run it only when the corpus grows
// or the TinkerPop pin moves.
//
// WHAT IT DOES, per graph (modern, crew, air-routes):
//   1. starts `tinkerpop/gremlin-server:<tag>` (default 4.0.0-beta.3 — the version vendor/tinkerpop
//      pins, see its pom.xml) with a generated config: an EMPTY TinkerGraph with INTEGER vertex/edge id
//      managers, filled at startup by Gremlin Server's own `TinkerFactoryDataLoader` (datasets `modern`,
//      `crew`, `airroutes` — the very graphs `test/fixtures/` reproduces). INTEGER, because mogwai frames
//      a small rowid as an Int: with TinkerGraph's default LONG manager every `id()` would differ in
//      number class for a reason that is configuration, not semantics;
//   2. PARITY CHECK — `g.V().valueMap().with(WithOptions.tokens)` and `g.E().elementMap()` on the server against the same two
//      queries on mogwai's in-process fixture, compared as canonical typed multisets
//      (test/L6-workload/canon.ts). Ids, labels, property keys, values AND number classes must agree, or
//      it aborts: a golden computed over a different graph is worse than none;
//   3. submits every corpus query for that graph over HTTP (`Accept: application/vnd.graphbinary-v4.0`),
//      canonicalizes the RAW response bytes with the same `canon.ts` the test uses (so `3` vs `3.0` is
//      kept — the JS client would erase it), and records the values, or the server's error;
//   4. reports every query whose new golden disagrees with an existing HAND golden (the interim oracle):
//      the reference wins, and the disagreement is printed for a human.
// The header records the image tag and its digest (`docker image inspect … RepoDigests`).
//
// `--url <base> --alias <g>` points it at an already-running server instead of starting one (e.g. a
// local Gremlin Server from the Apache binary zip). `--seed` additionally POSTs the fixture's seed writes
// first — only meaningful for a fresh MOGWAI server, which is how this script's own HTTP + parsing path
// is smoke-tested without docker (`bun src/bun/server.ts --port 18182` then
// `--url http://localhost:18182 --alias wl-modern --seed --graph modern --dry`).
import { parseArgs } from 'node:util';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORPUS, type GraphName, type WorkloadQuery } from '../../test/L6-workload/corpus.ts';
import { canonResponse } from '../../test/L6-workload/canon.ts';
import { answer, GOLDENS_PATH, MINT, normalizeGolden, readGoldens, type Golden, type GoldenFile } from '../../test/L6-workload/workload.ts';
import { MODERN_SEED } from '../../test/fixtures/seed-modern.ts';
import { CREW_SEED } from '../../test/fixtures/seed-crew.ts';

const { values: args } = parseArgs({
  options: {
    image: { type: 'string', default: 'tinkerpop/gremlin-server:4.0.0-beta.3' },
    graph: { type: 'string' },
    url: { type: 'string' },
    alias: { type: 'string', default: 'g' },
    seed: { type: 'boolean', default: false },
    dry: { type: 'boolean', default: false },
    'skip-parity': { type: 'boolean', default: false },
  },
});

const DATASET: Record<GraphName, string> = { 'modern': 'modern', 'crew': 'crew', 'air-routes': 'airroutes' };
const SEEDS: Partial<Record<GraphName, readonly string[]>> = { modern: MODERN_SEED, crew: CREW_SEED };
const graphs = (args.graph ? args.graph.split(',') : ['modern', 'crew', 'air-routes']) as GraphName[];

const sh = (cmd: string[]): string => {
  const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** Submit one query; the canonical values (lists in their emitted order) or the server's error. */
async function submit(base: string, alias: string, gremlin: string): Promise<{ values?: string[]; error?: string }> {
  const res = await fetch(`${base}/gremlin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/vnd.graphbinary-v4.0' },
    body: JSON.stringify({ gremlin, g: alias, language: 'gremlin-lang' }),
  });
  const body = new Uint8Array(await res.arrayBuffer());
  if (!(res.headers.get('content-type') ?? '').includes('graphbinary'))
    return { error: `HTTP ${res.status}: ${new TextDecoder().decode(body).slice(0, 300)}` };
  const r = canonResponse(body, { orderedLists: true });
  if (r.status !== 200 && r.status !== 204 && r.status !== 206) return { error: `${r.status}: ${r.message ?? r.exception ?? ''}` };
  return { values: r.values };
}

/** Start a Gremlin Server for one dataset; returns its base URL and a stop function. */
async function startServer(graph: GraphName): Promise<{ base: string; stop: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'mogwai-wl-'));
  // The image's entrypoint edits the yaml IN PLACE (`sed -i` on `host:`), as the container's `gremlin`
  // user, so the mounted dir must be writable by that user, and it cannot be mounted read-only.
  chmodSync(dir, 0o777);
  writeFileSync(join(dir, 'tinkergraph-int.properties'), [
    'gremlin.graph=org.apache.tinkerpop.gremlin.tinkergraph.structure.TinkerGraph',
    'gremlin.tinkergraph.vertexIdManager=INTEGER',
    'gremlin.tinkergraph.edgeIdManager=INTEGER',
    'gremlin.tinkergraph.vertexPropertyIdManager=LONG',
    '',
  ].join('\n'));
  // The stock conf/gremlin-server-modern.yaml of the 4.0.0-beta.3 distribution, with the dataset, the id
  // managers and a 0.0.0.0 bind (a container's localhost is not reachable through -p).
  writeFileSync(join(dir, 'workload.yaml'), [
    'host: 0.0.0.0',
    'port: 8182',
    'timeoutMillis: 120000',
    'channelizer: org.apache.tinkerpop.gremlin.server.channel.HttpChannelizer',
    'graphs: {',
    '  graph: conf/workload/tinkergraph-int.properties}',
    'lifecycleHooks:',
    `  - { className: org.apache.tinkerpop.gremlin.server.util.TinkerFactoryDataLoader, config: {graph: graph, dataset: ${DATASET[graph]}}}`,
    'serializers:',
    '  - { className: org.apache.tinkerpop.gremlin.util.ser.GraphBinaryMessageSerializerV4 }',
    'maxRequestContentLength: 10485760',
    'resultIterationBatchSize: 64',
    '',
  ].join('\n'));
  // NOT `--rm`: a container that dies at start-up must keep its logs until we have printed them.
  const id = sh(['docker', 'run', '-d', '-p', '127.0.0.1::8182', '-v', `${dir}:/opt/gremlin-server/conf/workload`,
    args.image!, 'conf/workload/workload.yaml']);
  const stop = () => { try { sh(['docker', 'rm', '-f', id]); } catch { /* already gone */ } };
  const logs = () => { try { return sh(['docker', 'logs', id]).slice(-4000); } catch (e) { return String(e); } };
  const died = (why: string) => new Error(`gremlin-server for ${graph} ${why}. Container logs:\n${logs()}`);
  try {
    // The port mapping appears only once the container is RUNNING. A container that exits on a bad
    // config never publishes it, so check that it is still alive before each lookup.
    let port: string | undefined;
    for (let i = 0; i < 30 && port === undefined; i++) {
      const running = Bun.spawnSync(['docker', 'inspect', '-f', '{{.State.Running}}', id], { stdout: 'pipe' }).stdout.toString().trim();
      if (running !== 'true') throw died('exited at start-up');
      const r = Bun.spawnSync(['docker', 'port', id, '8182/tcp'], { stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode === 0) port = r.stdout.toString().split('\n')[0]!.split(':').pop();
      else await Bun.sleep(500);
    }
    if (port === undefined) throw died('never published port 8182');
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 180; i++) {
      try { const r = await submit(base, 'g', 'g.inject(1)'); if (r.values) return { base, stop }; } catch { /* not up yet */ }
      await Bun.sleep(1000);
    }
    throw new Error(`gremlin-server for ${graph} did not answer within 180s:\n${sh(['docker', 'logs', id]).slice(-3000)}`);
  } catch (e) { stop(); throw e; }
}

/** Compare the server's graph with mogwai's fixture, element by element. */
async function parity(base: string, alias: string, graph: GraphName): Promise<void> {
  const store = MINT[graph]();
  // valueMap for vertices: it carries EVERY value of a multi-property (crew's `location`), compared as a multiset.
  for (const query of ['g.V().valueMap().with(WithOptions.tokens)', 'g.E().elementMap()']) {
    const entry: WorkloadQuery = { id: 'parity', graph, source: 'app', query };
    const ours = answer(store, entry).sort();
    const theirs = await submit(base, alias, query);
    if (!theirs.values) throw new Error(`parity: ${query} failed on the reference: ${theirs.error}`);
    const ref = normalizeGolden(theirs.values, entry).sort();
    const missing = ref.filter((x) => !ours.includes(x));
    const extra = ours.filter((x) => !ref.includes(x));
    if (ours.length !== ref.length || missing.length || extra.length) {
      const msg = `PARITY FAILED for ${graph} (${query}): reference ${ref.length} elements, mogwai ${ours.length}\n` +
        `  only in reference: ${missing.slice(0, 5).join('\n                     ')}\n` +
        `  only in mogwai:    ${extra.slice(0, 5).join('\n                     ')}`;
      if (!args['skip-parity']) throw new Error(msg);
      console.warn(msg);
    }
  }
  console.log(`  parity ok: ${graph}`);
}

const file: GoldenFile = readGoldens();
const goldens: Record<string, Golden> = { ...file.goldens };
let digest = '(external server — not recorded)';
const disagreements: string[] = [];

for (const graph of graphs) {
  console.log(`── ${graph}`);
  const server = args.url ? { base: args.url, stop: () => {} } : await startServer(graph);
  try {
    if (!args.url) digest = sh(['docker', 'image', 'inspect', '--format', '{{index .RepoDigests 0}}', args.image!]);
    if (args.seed) for (const w of SEEDS[graph] ?? []) await submit(server.base, args.alias!, w);
    await parity(server.base, args.alias!, graph);
    for (const entry of CORPUS.filter((e) => e.graph === graph)) {
      const r = await submit(server.base, args.alias!, entry.query);
      const golden: Golden = r.values
        ? { query: entry.query, source: 'tinkergraph', results: r.values }
        : { query: entry.query, source: 'tinkergraph', error: r.error };
      const prior = file.goldens[entry.id];
      if (prior?.source === 'hand' && prior.query === entry.query) {
        const a = JSON.stringify(prior.results ? normalizeGolden(prior.results, entry).sort() : prior.error);
        const b = JSON.stringify(golden.results ? normalizeGolden(golden.results, entry).sort() : golden.error);
        if (a !== b) disagreements.push(`${entry.id}: hand ${a}\n    reference ${b}`);
      }
      goldens[entry.id] = golden;
      console.log(`  ${entry.id}: ${r.values ? `${r.values.length} value(s)` : `ERROR ${r.error}`}`);
    }
  } finally { server.stop(); }
}

if (disagreements.length)
  console.log(`\n⚠ ${disagreements.length} HAND golden(s) DISAGREE with the reference (the reference is written):\n  ${disagreements.join('\n  ')}`);

const out: GoldenFile = {
  header: {
    ...file.header,
    generatedBy: 'scripts/workload-goldens/generate.ts',
    generatedAt: new Date().toISOString(),
    reference: args.url ? `external server ${args.url}` : args.image,
    imageDigest: digest,
    tinkerpop: (readFileSync(new URL('../../vendor/tinkerpop/pom.xml', import.meta.url), 'utf8').match(/<artifactId>tinkerpop<\/artifactId>\s*<version>([^<]+)</) ?? [])[1] ?? 'unknown',
    graphs: graphs.join(','),
  },
  goldens: Object.fromEntries(Object.entries(goldens).sort(([a], [b]) => a.localeCompare(b))),
};
if (args.dry) console.log('\n--dry: nothing written.');
else { writeFileSync(GOLDENS_PATH, JSON.stringify(out, null, 1) + '\n'); console.log(`\nwrote ${GOLDENS_PATH.pathname}`); }
