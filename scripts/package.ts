#!/usr/bin/env bun
/**
 * RELEASE PACKAGING — build the distributable artifacts under `dist/` (gitignored). Everything is named
 * `mogwai-db-…` (the product; a sibling like `mogwai-mem` would be `mogwai-mem-…`):
 *
 *   bun scripts/package.ts --browser                 # dist/mogwai-db-<ver>-browser.zip
 *   bun scripts/package.ts --binaries[=linux-x64,…]  # dist/bin/mogwai-db-<ver>-<os>-<arch>[.exe]
 *   bun scripts/package.ts --cloudflare              # dist/mogwai-db-<ver>-cloudflare.zip
 *   bun scripts/package.ts                            # all three
 *   bun scripts/package.ts --version 1.2.3            # override the version (default: scripts/version.ts)
 *
 * THREE deliverables, one per runtime a consumer can self-host:
 *   - BROWSER zip: the entry bundles (mogwai-db.js / service-worker.js / worker.js, minified) + the
 *     `sqlite3.wasm` they load + a usage index.html + a deploy README. `mogwai-db.js` resolves its
 *     siblings via `import.meta.url` (src/browser/mogwai.ts), so drop it at any path.
 *   - BUN binaries: `src/bun/server.ts` compiled per platform via `bun build --compile --target=…`.
 *   - CLOUDFLARE zip: the prebuilt Worker (`wrangler deploy --dry-run --outdir`) + a template
 *     `wrangler.jsonc` (main → the bundle, `no_bundle`, the DO migration + R2 binding) + a deploy README.
 *     A consumer sets two env vars and `wrangler deploy`s — no build on their side.
 */
import { mkdir, rm, chmod } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { version } from './version.ts';
import { BROWSER_INDEX_HTML } from '../src/browser/docs-page.ts';
import { SCALAR_VERSION } from '../src/docs.ts';
import { EXAMPLE_DATASETS } from '../src/examples.ts';
import { copyExamplesTo } from './copy-examples.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');

const args = Bun.argv.slice(2);
const versionFlag = args.indexOf('--version');
// Default: DERIVE from the repo (major.commitcount.build — see version.ts); `--version` overrides.
const VERSION = versionFlag >= 0 ? args[versionFlag + 1]! : await version();

const VARIANTS = ['--browser', '--binaries', '--cloudflare'];
const anyVariant = args.some((a) => VARIANTS.some((f) => a === f || a.startsWith(`${f}=`)));
const wantBrowser = !anyVariant || args.includes('--browser');
const binariesArg = args.find((a) => a === '--binaries' || a.startsWith('--binaries='));
const wantBinaries = !anyVariant || binariesArg !== undefined;
const wantCloudflare = !anyVariant || args.includes('--cloudflare');

/** The Bun cross-compile targets we ship. `ext` is appended to the output name (Windows → `.exe`). */
const TARGETS: { name: string; bunTarget: string; ext?: string }[] = [
  { name: 'linux-x64', bunTarget: 'bun-linux-x64' },
  { name: 'linux-arm64', bunTarget: 'bun-linux-arm64' },
  { name: 'darwin-x64', bunTarget: 'bun-darwin-x64' },
  { name: 'darwin-arm64', bunTarget: 'bun-darwin-arm64' },
  { name: 'windows-x64', bunTarget: 'bun-windows-x64', ext: '.exe' },
];

async function run(cmd: string[], cwd = ROOT): Promise<void> {
  const p = Bun.spawn(cmd, { cwd, stdio: ['inherit', 'inherit', 'inherit'] });
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}`);
}

/** Read a JSONC file (wrangler.jsonc) — strip block + line comments, then parse. Kept simple: the config
 *  has no `//` inside string values, so a guarded line-comment strip is safe. */
function readJsonc(path: string): any {
  const text = readFileSync(path, 'utf8');
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1');
  return JSON.parse(stripped);
}

async function packageBrowser(): Promise<void> {
  const { bundleBrowser } = await import('../src/browser/bundle.ts');
  const out = join(DIST, 'browser');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  // The three entry bundles, minified for the release. mogwai.ts ships as mogwai-db.js (the product name);
  // its siblings keep their conventional names — mogwai-db.js resolves them relative to itself.
  const entries: Record<string, string> = {
    'mogwai-db.js': 'src/browser/mogwai.ts',
    'service-worker.js': 'src/browser/service-worker.ts',
    'worker.js': 'src/browser/worker.ts',
  };
  for (const [name, entry] of Object.entries(entries)) {
    // Stamp the version into the bundle so `src/version.ts` reads the real build number (else it folds to
    // `'dev'`). The define replaces the bare `MOGWAI_VERSION` identifier in place — a bare identifier, not
    // `process.env.…`, precisely because there is no `process` in the browser (see src/version.ts), so this
    // is the only way the browser learns its version.
    const js = await bundleBrowser(join(ROOT, entry), { minify: true, define: { MOGWAI_VERSION: JSON.stringify(VERSION) } });
    await Bun.write(join(out, name), js);
    console.log(`  browser/${name.padEnd(18)} ${(js.length / 1024).toFixed(0)} KB`);
  }

  // The WASM binary worker.js loads at runtime (resolved via the package export so it survives a bump).
  // It fetches `sqlite3.wasm` RELATIVE to itself — no CDN, so shipping it here makes the zip self-contained.
  // Record the exact SQLite version (the package version, e.g. 3.53.0-build1) so the release states it.
  const wasm = Bun.fileURLToPath(import.meta.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm'));
  const sqlitePkg = (JSON.parse(readFileSync(join(dirname(wasm), '..', 'package.json'), 'utf8')).version as string) ?? 'unknown';
  await Bun.write(join(out, 'sqlite3.wasm'), Bun.file(wasm));
  console.log(`  browser/sqlite3.wasm       ${(Bun.file(wasm).size / 1024 / 1024).toFixed(1)} MB (SQLite ${sqlitePkg})`);

  // The Scalar API-reference UI, shipped as a static asset (the ES-module standalone) so /docs is fully
  // self-contained — the service-worker-served docs page loads it from `./scalar.js`, never from a CDN. The
  // SW deliberately does NOT intercept `/scalar.js` (it's plain static hosting), so it never enters any
  // worker bundle and costs nothing until someone opens the docs.
  const scalar = join(ROOT, 'node_modules/@scalar/api-reference/dist/browser/standalone.js');
  await Bun.write(join(out, 'scalar.js'), Bun.file(scalar));
  console.log(`  browser/scalar.js          ${(Bun.file(scalar).size / 1024).toFixed(0)} KB (Scalar ${SCALAR_VERSION})`);

  // The favicon + logo, our COMMITTED source assets (public/, unlike the built scalar.js), shipped beside
  // the docs so the static host serves them for the browser docs (`<link rel=icon>` + the spec's `x-logo`
  // both use relative `./favicon.ico` / `./logo.png`). In the zip because it archives `.` below.
  for (const asset of ['favicon.ico', 'logo.png']) {
    const src = join(ROOT, 'public', asset);
    await Bun.write(join(out, asset), Bun.file(src));
    console.log(`  browser/${asset.padEnd(18)} ${(Bun.file(src).size / 1024).toFixed(0)} KB`);
  }

  // The example datasets (src/examples.ts), copied straight from the vendored GraphSON corpus as static
  // siblings the SW deliberately does NOT intercept (like scalar.js) — so the docs demo self-seeds via
  // `g.io("./examples/<name>.json").read()` (same-origin, auto-allowed). Under `.` below, so they zip in.
  const examples = await copyExamplesTo(join(out, 'examples'), '.json');
  for (const p of examples) console.log(`  browser/examples/${p.slice(p.lastIndexOf('/') + 1).padEnd(20)} ${(Bun.file(p).size / 1024).toFixed(0)} KB`);

  // index.html IS the API docs (the same Scalar shell the SW serves at /docs) — the site root, no redirect.
  await Bun.write(join(out, 'index.html'), BROWSER_INDEX_HTML);
  await Bun.write(join(out, 'README.md'), browserReadme(VERSION, sqlitePkg));

  await zipDir(out, join(DIST, `mogwai-db-${VERSION}-browser.zip`), ['.']);
}

async function packageBinaries(): Promise<void> {
  const only = binariesArg?.includes('=') ? binariesArg.split('=')[1]!.split(',') : undefined;
  const targets = only ? TARGETS.filter((t) => only.includes(t.name)) : TARGETS;
  if (targets.length === 0) throw new Error(`no matching targets in ${only?.join(',')} — known: ${TARGETS.map((t) => t.name).join(', ')}`);
  const out = join(DIST, 'bin');
  await mkdir(out, { recursive: true });

  // Stage the example datasets the binary EMBEDS (src/bun/examples/*.graphson — BunAssetStore's
  // `with { type: 'file' }` imports). Done HERE, not left to the `mise run examples` task, so
  // `bun scripts/package.ts --binaries` is self-sufficient however it is invoked — the CI docker job runs
  // it DIRECTLY (not via `mise run package`), so without this the compile fails "Could not resolve
  // ./examples/modern.graphson". Idempotent (a plain copy), so re-running after the mise task is harmless.
  await copyExamplesTo(join(ROOT, 'src', 'bun', 'examples'), '.graphson');

  for (const t of targets) {
    const file = join(out, `mogwai-db-${VERSION}-${t.name}${t.ext ?? ''}`);
    // `--define` stamps the version into the compiled binary so `mogwai-db --version` prints the real
    // build number (src/version.ts folds the defined bare `MOGWAI_VERSION` to a literal).
    await run(['bun', 'build', '--compile', `--target=${t.bunTarget}`, `--define`, `MOGWAI_VERSION=${JSON.stringify(VERSION)}`, join(ROOT, 'src/bun/server.ts'), '--outfile', file]);
    console.log(`→ ${file}  (${(Bun.file(file).size / 1024 / 1024).toFixed(0)} MB)`);
  }
}

async function packageCloudflare(): Promise<void> {
  const out = join(DIST, 'cloudflare');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  // Bundle the Worker exactly as `wrangler deploy` would, but write it to disk instead of deploying.
  // Produces worker.js (+ .map) — the same bytes a live deploy would upload. `--define` stamps the version
  // into the bundle (wrangler's esbuild folds the bare `MOGWAI_VERSION` to the literal — the worker has
  // no build-time env otherwise); the value is JSON-quoted per wrangler's `KEY:VALUE` define syntax.
  await run(['bunx', 'wrangler', 'deploy', '--dry-run', '--outdir', out, '--define', `MOGWAI_VERSION:${JSON.stringify(VERSION)}`]);
  if (!(await Bun.file(join(out, 'worker.js')).exists())) throw new Error('wrangler did not produce worker.js');

  // The docs' Scalar UI, shipped as a Workers Static Asset so `wrangler deploy` uploads it and the deployed
  // Worker serves /scalar.js from the ASSETS binding — no CDN. It sits in `public/` beside the config (the
  // template's `assets.directory` is './public'), the same node_modules file the browser build ships.
  const scalar = join(ROOT, 'node_modules/@scalar/api-reference/dist/browser/standalone.js');
  await mkdir(join(out, 'public'), { recursive: true });
  await Bun.write(join(out, 'public', 'scalar.js'), Bun.file(scalar));
  console.log(`  cloudflare/public/scalar.js  ${(Bun.file(scalar).size / 1024).toFixed(0)} KB (Scalar ${SCALAR_VERSION})`);

  // The favicon + logo (our committed public/ source assets) ship as Static Assets alongside scalar.js, so the
  // deployed Worker serves /favicon.ico and /logo.png from the ASSETS binding — same self-hosted, no-CDN story.
  for (const asset of ['favicon.ico', 'logo.png']) {
    const src = join(ROOT, 'public', asset);
    await Bun.write(join(out, 'public', asset), Bun.file(src));
    console.log(`  cloudflare/public/${asset.padEnd(11)} ${(Bun.file(src).size / 1024).toFixed(0)} KB`);
  }

  // The example datasets, uploaded as Static Assets alongside scalar.js so the deployed Worker serves
  // /examples/<name>.json from the ASSETS binding — the docs demo self-seeds via io()-from-URL (a
  // self-hosted instance allowlists its own host for the fetch). Copied from the vendored corpus, not
  // from public/, so a `dist/` build never depends on `mise run examples` having populated public/ first.
  const cfExamples = await copyExamplesTo(join(out, 'public', 'examples'), '.json');
  for (const p of cfExamples) console.log(`  cloudflare/public/examples/${p.slice(p.lastIndexOf('/') + 1).padEnd(18)} ${(Bun.file(p).size / 1024).toFixed(0)} KB`);

  // The deploy config + script + README (overwriting wrangler's stub README). The config is DERIVED from
  // the repo's wrangler.jsonc so it cannot drift — same DO migration, R2 binding, compat — with `main`
  // pointed at the prebuilt bundle and `no_bundle` on, and the account left to the env.
  const cfg = readJsonc(join(ROOT, 'wrangler.jsonc'));
  const bucket = cfg.r2_buckets?.[0]?.bucket_name ?? 'mogwai-io';
  await Bun.write(join(out, 'wrangler.jsonc'), cloudflareTemplate());
  // deploy.sh: checks the env is set, creates the R2 bucket if missing, deploys — the README's steps,
  // baked in. Templated from scripts/templates/ with the bucket name; made executable so it survives the zip.
  const deploySh = readFileSync(join(ROOT, 'scripts/templates/cloudflare-deploy.sh'), 'utf8').replaceAll('__MOGWAI_BUCKET__', bucket);
  await Bun.write(join(out, 'deploy.sh'), deploySh);
  await chmod(join(out, 'deploy.sh'), 0o755);
  await Bun.write(join(out, 'README.md'), cloudflareReadme(VERSION, bucket));

  await zipDir(out, join(DIST, `mogwai-db-${VERSION}-cloudflare.zip`), [
    'worker.js', 'worker.js.map', 'wrangler.jsonc', 'deploy.sh', 'README.md',
    'public/scalar.js', 'public/favicon.ico', 'public/logo.png',
    ...EXAMPLE_DATASETS.map((d) => `public/examples/${d.name}.json`),
  ]);
}

/** Zip named entries (relative to `dir`) into `zipPath`, replacing any existing archive. */
async function zipDir(dir: string, zipPath: string, entries: string[]): Promise<void> {
  await rm(zipPath, { force: true });
  await run(['zip', '-r', '-q', zipPath, ...entries], dir);
  console.log(`→ ${zipPath}`);
}

/** The consumer's deploy config, derived from the repo's wrangler.jsonc so it never drifts. */
function cloudflareTemplate(): string {
  const src = readJsonc(join(ROOT, 'wrangler.jsonc'));
  const template = {
    name: src.name,
    main: './worker.js',
    // Deploy the prebuilt bundle as-is — no re-bundle, so the consumer needs no bun/submodule/link.
    no_bundle: true,
    compatibility_date: src.compatibility_date,
    compatibility_flags: src.compatibility_flags,
    // Mapped stack traces in the dashboard (worker.js.map ships alongside).
    upload_source_maps: true,
    durable_objects: src.durable_objects,
    migrations: src.migrations,
    r2_buckets: src.r2_buckets,
    // Workers Static Assets — the docs' Scalar UI (public/scalar.js, shipped in the zip). `run_worker_first`
    // keeps our router the sole router; carried verbatim from the repo config so the release cannot drift.
    assets: src.assets,
  };
  return `// mogwai-db — Cloudflare deploy config (prebuilt). Account + auth come from CLOUDFLARE_ACCOUNT_ID /
// CLOUDFLARE_API_TOKEN in the environment; nothing here needs editing. See README.md.
${JSON.stringify(template, null, 2)}
`;
}



function browserReadme(version: string, sqlitePkg: string): string {
  const sqliteVer = sqlitePkg.replace(/-build\d+$/, '');
  return `# mogwai-db — browser build ${version}

Run a TinkerPop 4 Gremlin graph (compiled to SQLite/WASM) entirely in the browser. Any TinkerPop-4 GLV,
or a plain \`fetch\`, talks to it over HTTP with no changes — a Service Worker is the local edge.

**Self-contained.** Everything it needs is in this zip — including \`sqlite3.wasm\`. Unzip into a static
folder and serve it: there are NO runtime downloads and NO CDN dependencies. Built and tested against
**SQLite ${sqliteVer}** (\`@sqlite.org/sqlite-wasm@${sqlitePkg}\`).

## Files

- \`mogwai-db.js\` — the ONE script your page includes. Registers the service worker + installs the per-tab
  worker factory. Resolves the two sibling scripts relative to itself (\`import.meta.url\`).
- \`service-worker.js\` — the HTTP edge; intercepts \`fetch('/gremlin/*')\` and \`/graphql/*\`.
- \`worker.js\` — one dedicated Worker per graph (SQLite on the \`opfs-sahpool\` VFS).
- \`sqlite3.wasm\` — the SQLite ${sqliteVer} WASM binary \`worker.js\` loads at runtime (fetched relative, so
  it MUST sit beside \`worker.js\`).
- \`index.html\` — the API reference itself (the interactive Scalar docs), served at the site root; it boots
  the service worker in place, so opening it IS a live mogwai-db instance (no separate landing page).
- \`scalar.js\` — the Scalar API-reference UI (loaded by the docs); shipped locally so the docs need no CDN.
- \`favicon.ico\`, \`logo.png\` — the site favicon and the brand logo shown in the API reference (served beside
  index.html; referenced relatively so they work at any deploy path).
- \`examples/*.json\` — the standard TinkerPop reference graphs (modern, crew, sink, grateful-dead). The docs'
  "Load example" entries seed a graph from these via \`g.io("./examples/<name>.json").read()\` (same-origin).

## Use

Serve the four files together (any path — they find each other) and include one script:

\`\`\`html
<script type="module" src="/path/to/mogwai-db.js"></script>
\`\`\`

Then any client can query \`POST /gremlin/{graphId}\` with \`{"gremlin":"g.V().count()"}\`. See index.html.

## Serving requirements

- **Secure context** — HTTPS, or \`http://localhost\` for development (Service Workers + OPFS require it).
- **\`sqlite3.wasm\` served as \`application/wasm\`.**
- **Service Worker scope** — by default the worker only controls its own directory and below. To serve
  graphs at a path ABOVE where \`service-worker.js\` lives, register it with a wider scope and send the
  \`Service-Worker-Allowed\` header (call \`installMogwai({ scope, serviceWorker, worker })\` from
  \`worker-factory.ts\` instead of the default \`mogwai-db.js\` bootstrap).
`;
}

function cloudflareReadme(version: string, bucket: string): string {
  return `# mogwai-db — Cloudflare deploy ${version}

A **prebuilt** mogwai-db Worker + Durable Object. No build on your side — deploy the bundle straight to
your own Cloudflare account. (Graphs are TinkerPop 4 Gremlin over HTTP, each an isolated SQLite Durable
Object.)

## Deploy

Set a Cloudflare API token with **Workers Scripts + Durable Objects + R2** edit permissions, then run the
script — it checks the env, creates the \`${bucket}\` R2 store if missing, and deploys:

\`\`\`sh
export CLOUDFLARE_API_TOKEN=…                 # required
export CLOUDFLARE_ACCOUNT_ID=…               # only if the token can see more than one account
./deploy.sh
\`\`\`

Your Worker goes live at \`mogwai-db.<your-subdomain>.workers.dev\`; query a graph with
\`POST /gremlin/{id}\`, body \`{"gremlin":"g.V().count()"}\`. The Durable Object is created on deploy and
provisioned per graph on first request (there is no create/drop API — addressing a graph provisions it).

(No bash? Run what \`deploy.sh\` does: \`npx wrangler r2 bucket create ${bucket}\` then \`npx wrangler deploy\`.)

## Files

- \`deploy.sh\` — the one command above; checks the env, ensures the R2 bucket, deploys.
- \`worker.js\` — the prebuilt Worker (exports the \`GraphDatabase\` Durable Object).
- \`worker.js.map\` — sourcemap; mapped stack traces in the Cloudflare dashboard.
- \`wrangler.jsonc\` — the deploy config: \`main\` → the bundle, \`no_bundle\`, the DO migration, the R2 binding,
  and the Workers Static Assets block. Nothing needs editing — the account comes from the env vars.
- \`public/scalar.js\` — the docs' Scalar UI, uploaded as a Static Asset and served at \`/scalar.js\` (so the
  interactive API reference at \`/\` is self-hosted, no CDN).
- \`public/favicon.ico\`, \`public/logo.png\` — the site favicon and the brand logo shown in the API reference,
  served the same way (\`/favicon.ico\`, \`/logo.png\`).
- \`public/examples/*.json\` — the standard TinkerPop reference graphs (modern, crew, sink, grateful-dead),
  served at \`/examples/<name>.json\`. The docs' "Load example" entries seed a graph from these via
  \`g.io(...).read()\`; a self-hosted instance must allowlist its own host for the fetch (io() SSRF guard).
`;
}

if (wantBrowser) await packageBrowser();
if (wantBinaries) await packageBinaries();
if (wantCloudflare) await packageCloudflare();
