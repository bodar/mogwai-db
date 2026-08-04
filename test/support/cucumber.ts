// Run `.feature` files through the REAL cucumber, in THIS process.
//
// Both Gherkin suites use it: L3 over the official corpus with upstream's own step definitions, L4
// over our addendum with ours. Neither parses Gherkin itself — L4 used to, and a hand-rolled reader
// that `throw`s on any step it has not been taught is a corpus we cannot grow without editing a
// regex.
//
// ── Why the submodule's copy, and not a dependency of ours ────────────────────────────────────────
//
// Cucumber's support-code registry is per-INSTANCE: `Given`/`Then`/`setWorldConstructor` mutate state
// owned by the `@cucumber/cucumber` module that the step file imported. Upstream's steps live inside
// the submodule (`test/cucumber/*.js`) and import the bare specifier, so they resolve the SUBMODULE's
// copy. If `runCucumber` came from a copy of ours, it would read a different registry and every step
// would report `undefined` — the run would look like a total failure with no hint why.
//
// So there is exactly one instance in the process and this module is the only place that names it.
// That also means no new dependency: `@cucumber/cucumber` is already installed inside the submodule
// workspace by `scripts/init-submodule.sh`.
//
// ── Why in-process at all ─────────────────────────────────────────────────────────────────────────
//
// The old L3 spawned `cucumber-js` as a child, which forced the server under test to be reachable by
// URL, which forced a fixed port the GLV chose and we could not change. In-process, the client talks
// to a handler (`test/support/in-memory-transport.ts`) and there is no port to lose.

import { Writable } from 'node:stream';

const HERE = new URL('.', import.meta.url).pathname;

/** The submodule's cucumber — see the header for why it must be this one. */
export const CUCUMBER_ROOT = `${HERE}../../vendor/tinkerpop/gremlin-js/node_modules/@cucumber/cucumber`;
/** The GLV package root. Cucumber resolves `import` globs relative to its `cwd`, and upstream's step
 *  definitions are written expecting to run from there. */
export const GLV = `${HERE}../../vendor/tinkerpop/gremlin-js/gremlin-javascript`;

interface CucumberApi {
  loadConfiguration(options: unknown, environment: unknown): Promise<{ runConfiguration: unknown }>;
  runCucumber(
    configuration: unknown,
    environment: unknown,
    onMessage?: (envelope: unknown) => void,
  ): Promise<{ success: boolean }>;
}

/** Resolve the api module. Deliberately not top-level: a bare `bun test` of an unrelated file must
 *  not fail merely because the submodule is unprovisioned. */
export async function cucumberApi(): Promise<CucumberApi> {
  return await import(`${CUCUMBER_ROOT}/lib/api/index.js`) as CucumberApi;
}

export interface RunFeaturesOptions {
  /** Absolute feature paths or globs. A bare DIRECTORY matches nothing in cucumber 13 — pass a glob. */
  readonly paths: readonly string[];
  /** Support code to load. Relative entries resolve against `cwd`; globs are required for
   *  directories, for the same reason as `paths`. */
  readonly imports: readonly string[];
  /** Cucumber tag expression, or undefined for every scenario. */
  readonly tags?: string;
  /** Formatters, e.g. `json:/tmp/report.json`. `summary` is always appended. */
  readonly formats?: readonly string[];
  /** Working directory cucumber resolves relative paths against. Defaults to the GLV. */
  readonly cwd?: string;
}

export interface RunFeaturesResult {
  readonly success: boolean;
  /** Everything cucumber wrote to its stdout — the summary, for cross-checking a parsed count. */
  readonly stdout: string;
}

/**
 * Run cucumber and return its verdict plus captured stdout.
 *
 * stdout is CAPTURED rather than inherited so a formatter's output is available to assert on, and so
 * the conformance host's own compact progress line (written straight to `process.stdout`) is not
 * interleaved with it.
 */
export async function runFeatures(options: RunFeaturesOptions): Promise<RunFeaturesResult> {
  const api = await cucumberApi();
  const cwd = options.cwd ?? GLV;

  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); },
  });

  const environment = { cwd, stdout, stderr: process.stderr, env: process.env };
  const { runConfiguration } = await api.loadConfiguration({
    provided: {
      paths: [...options.paths],
      import: [...options.imports],
      format: [...(options.formats ?? []), 'summary'],
      ...(options.tags ? { tags: options.tags } : {}),
    },
  }, environment);

  const { success } = await api.runCucumber({ ...(runConfiguration as object) }, environment);
  return { success, stdout: chunks.join('') };
}
