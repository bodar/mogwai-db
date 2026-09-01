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
    const js = await bundleBrowser(join(ROOT, entry), { minify: true });
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

  await Bun.write(join(out, 'index.html'), INDEX_HTML);
  await Bun.write(join(out, 'README.md'), browserReadme(VERSION, sqlitePkg));

  await zipDir(out, join(DIST, `mogwai-db-${VERSION}-browser.zip`), ['.']);
}

async function packageBinaries(): Promise<void> {
  const only = binariesArg?.includes('=') ? binariesArg.split('=')[1]!.split(',') : undefined;
  const targets = only ? TARGETS.filter((t) => only.includes(t.name)) : TARGETS;
  if (targets.length === 0) throw new Error(`no matching targets in ${only?.join(',')} — known: ${TARGETS.map((t) => t.name).join(', ')}`);
  const out = join(DIST, 'bin');
  await mkdir(out, { recursive: true });

  for (const t of targets) {
    const file = join(out, `mogwai-db-${VERSION}-${t.name}${t.ext ?? ''}`);
    await run(['bun', 'build', '--compile', `--target=${t.bunTarget}`, join(ROOT, 'src/bun/server.ts'), '--outfile', file]);
    console.log(`→ ${file}  (${(Bun.file(file).size / 1024 / 1024).toFixed(0)} MB)`);
  }
}

async function packageCloudflare(): Promise<void> {
  const out = join(DIST, 'cloudflare');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  // Bundle the Worker exactly as `wrangler deploy` would, but write it to disk instead of deploying.
  // Produces worker.js (+ .map) — the same bytes a live deploy would upload.
  await run(['bunx', 'wrangler', 'deploy', '--dry-run', '--outdir', out]);
  if (!(await Bun.file(join(out, 'worker.js')).exists())) throw new Error('wrangler did not produce worker.js');

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

  await zipDir(out, join(DIST, `mogwai-db-${VERSION}-cloudflare.zip`), ['worker.js', 'worker.js.map', 'wrangler.jsonc', 'deploy.sh', 'README.md']);
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
  };
  return `// mogwai-db — Cloudflare deploy config (prebuilt). Account + auth come from CLOUDFLARE_ACCOUNT_ID /
// CLOUDFLARE_API_TOKEN in the environment; nothing here needs editing. See README.md.
${JSON.stringify(template, null, 2)}
`;
}

const INDEX_HTML = `<!doctype html>
<meta charset="utf-8">
<title>mogwai-db</title>
<!-- Include this ONE script; it registers the service worker and installs the per-tab worker factory.
     mogwai-db.js resolves ./service-worker.js and ./worker.js relative to itself, so keep the four files
     (mogwai-db.js, service-worker.js, worker.js, sqlite3.wasm) together at any path. -->
<script type="module" src="./mogwai-db.js"></script>
<script type="module">
  // Any TinkerPop-4 client that speaks HTTP works unmodified; a plain fetch is enough to demo it.
  addEventListener('load', async () => {
    const g = 'demo';
    const post = (gremlin) => fetch(\`/gremlin/\${g}\`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gremlin }),
    });
    // The service worker needs a tick to take control on a first visit.
    await new Promise((r) => setTimeout(r, 300));
    await post("g.addV('person').property('name','marko')");
    const info = await (await fetch(\`/gremlin/\${g}\`)).json();
    document.body.textContent = 'mogwai-db running in your browser — graph "demo" has ' + JSON.stringify(info);
  });
</script>
`;

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
- \`wrangler.jsonc\` — the deploy config: \`main\` → the bundle, \`no_bundle\`, the DO migration, the R2 binding.
  Nothing needs editing — the account comes from the env vars.
`;
}

if (wantBrowser) await packageBrowser();
if (wantBinaries) await packageBinaries();
if (wantCloudflare) await packageCloudflare();
