// ---------- the example datasets — the standard TinkerPop reference graphs, served at /examples/ ----------
//
// The four canonical TinkerPop reference graphs, shipped as ready-to-load example datasets so the docs
// demo is SELF-SEEDING: the OpenAPI "Load example" entries (src/docs.ts) send a
// `g.io("<origin>/examples/<name>.json").read()`, and increment 6a's io()-from-URL streams the graph into
// a fresh local graph — no custom UI, no external host. The bytes are the vendored TinkerPop GraphSON v3
// corpus (our loader reads it; the L3 conformance server proves it), copied to friendly names.
//
// This module is the ONE source of truth for the name↔file mapping and the served-path set. It is
// deliberately CONSTANTS ONLY (no runtime imports), because it is consumed on every layer that must agree:
//   - the router (src/router.ts) — which /examples/ paths to offer the AssetStore;
//   - the docs (src/docs.ts)     — one OpenAPI example per dataset;
//   - the Bun AssetStore (src/bun/BunAssetStore.ts) — the binary-embedded copies;
//   - the staging + release scripts (scripts/copy-examples.ts, scripts/package.ts) — the file copies.
// Adding a dataset is a one-line edit here; every consumer follows.

/** One example dataset: its friendly `/examples/<name>.json` name, the vendored GraphSON file it is
 *  copied from, and a one-line summary (the OpenAPI example's `summary`). */
export interface ExampleDataset {
  readonly name: string;
  readonly vendorFile: string;
  readonly summary: string;
}

/** The vendored TinkerPop GraphSON v3 corpus, cited at the pinned gitlink so the claim is checkable by CI
 *  (repo-relative, like every other `vendor/...` citation — see CLAUDE.md "Environment notes"). */
export const EXAMPLE_GRAPHSON_DIR =
  'vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/structure/io/graphson';

/** The four datasets, friendly-name → vendored source. The GraphSON files are newline-delimited adjacency
 *  (one vertex per line), the exact shape the two-pass streaming loader (src/bulk.ts) reads. */
export const EXAMPLE_DATASETS: readonly ExampleDataset[] = [
  { name: 'modern', vendorFile: 'tinkerpop-modern-v3.json', summary: 'the canonical 6-vertex / 6-edge "modern" demo graph' },
  { name: 'crew', vendorFile: 'tinkerpop-crew-v3.json', summary: 'the "crew" graph (multi- and meta-properties)' },
  { name: 'sink', vendorFile: 'tinkerpop-sink-v3.json', summary: 'the "sink" graph (self-loops)' },
  { name: 'grateful-dead', vendorFile: 'grateful-dead-v3.json', summary: 'the Grateful Dead graph (808 vertices / 8049 edges)' },
];

/** The friendly names in declaration order (`['modern', 'crew', 'sink', 'grateful-dead']`). */
export const EXAMPLE_NAMES: readonly string[] = EXAMPLE_DATASETS.map((d) => d.name);

/** The served asset paths, `/examples/<name>.json`. */
const EXAMPLE_PATHS: ReadonlySet<string> = new Set(EXAMPLE_DATASETS.map((d) => `/examples/${d.name}.json`));

/** Is `pathname` one of the served example datasets? Used by the router to decide whether to offer a GET
 *  to the AssetStore (an unknown `/examples/…` path is NOT offered, so it 404s like any other route). */
export function isExamplePath(pathname: string): boolean {
  return EXAMPLE_PATHS.has(pathname);
}
