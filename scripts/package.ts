#!/usr/bin/env bun
/**
 * RELEASE PACKAGING — build the distributable artifacts under `dist/` (gitignored):
 *
 *   bun scripts/package.ts --browser                 # dist/browser/ + dist/mogwai-browser-<ver>.zip
 *   bun scripts/package.ts --binaries                # dist/bin/mogwai-<ver>-<os>-<arch>[.exe], all targets
 *   bun scripts/package.ts --binaries=linux-x64      # …just the listed targets (comma-separated)
 *   bun scripts/package.ts                            # both
 *   bun scripts/package.ts --version 1.2.3            # override the version (default: package.json)
 *
 * TWO deliverables, mirroring the two runtimes a consumer can self-host:
 *   - the BROWSER zip: the three entry bundles (mogwai.js / service-worker.js / worker.js) + the
 *     `sqlite3.wasm` they load at runtime + a usage index.html + a deploy README. Drop it at any path;
 *     `mogwai.js` resolves its siblings via `import.meta.url` (see src/browser/mogwai.ts).
 *   - the BUN binaries: `src/bun/server.ts` compiled to a standalone executable per platform via
 *     `bun build --compile --target=…`. Cross-targets download that platform's Bun runtime, so the full
 *     matrix runs in CI; a single native target builds anywhere.
 *
 * (The Cloudflare Worker packages via `wrangler` — `mise run build` — and is not part of this script.)
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { version } from './version.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');

const args = Bun.argv.slice(2);
const versionFlag = args.indexOf('--version');
// Default: DERIVE from the repo (major.commitcount.build — see version.ts); `--version` overrides.
const VERSION = versionFlag >= 0 ? args[versionFlag + 1]! : await version();

const wantBrowser = args.includes('--browser') || !args.some((a) => a.startsWith('--browser') || a.startsWith('--binaries'));
const binariesArg = args.find((a) => a === '--binaries' || a.startsWith('--binaries='));
const wantBinaries = binariesArg !== undefined || !args.some((a) => a.startsWith('--browser') || a.startsWith('--binaries'));

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

async function packageBrowser(): Promise<void> {
  const { bundleBrowser } = await import('../src/browser/bundle.ts');
  const out = join(DIST, 'browser');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  // The three entry bundles, minified for the release.
  const entries: Record<string, string> = {
    'mogwai.js': 'src/browser/mogwai.ts',
    'service-worker.js': 'src/browser/service-worker.ts',
    'worker.js': 'src/browser/worker.ts',
  };
  for (const [name, entry] of Object.entries(entries)) {
    const js = await bundleBrowser(join(ROOT, entry), { minify: true });
    await Bun.write(join(out, name), js);
    console.log(`  browser/${name.padEnd(18)} ${(js.length / 1024).toFixed(0)} KB`);
  }

  // The WASM binary worker.js loads at runtime (resolved via the package export so it survives a bump).
  const wasm = Bun.fileURLToPath(import.meta.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm'));
  await Bun.write(join(out, 'sqlite3.wasm'), Bun.file(wasm));
  console.log(`  browser/sqlite3.wasm       ${(Bun.file(wasm).size / 1024 / 1024).toFixed(1)} MB`);

  await Bun.write(join(out, 'index.html'), INDEX_HTML);
  await Bun.write(join(out, 'README.md'), browserReadme(VERSION));

  // Zip the directory's CONTENTS (not the dir), so a consumer unzips the files at their chosen path.
  const zipPath = join(DIST, `mogwai-browser-${VERSION}.zip`);
  await rm(zipPath, { force: true });
  await run(['zip', '-r', '-q', zipPath, '.'], out);
  console.log(`→ ${zipPath}`);
}

async function packageBinaries(): Promise<void> {
  const only = binariesArg?.includes('=') ? binariesArg.split('=')[1]!.split(',') : undefined;
  const targets = only ? TARGETS.filter((t) => only.includes(t.name)) : TARGETS;
  if (targets.length === 0) throw new Error(`no matching targets in ${only?.join(',')} — known: ${TARGETS.map((t) => t.name).join(', ')}`);
  const out = join(DIST, 'bin');
  await mkdir(out, { recursive: true });

  for (const t of targets) {
    const file = join(out, `mogwai-${VERSION}-${t.name}${t.ext ?? ''}`);
    await run(['bun', 'build', '--compile', `--target=${t.bunTarget}`, join(ROOT, 'src/bun/server.ts'), '--outfile', file]);
    console.log(`→ ${file}  (${(Bun.file(file).size / 1024 / 1024).toFixed(0)} MB)`);
  }
}

const INDEX_HTML = `<!doctype html>
<meta charset="utf-8">
<title>mogwai-db</title>
<!-- Include this ONE script; it registers the service worker and installs the per-tab worker factory.
     mogwai.js resolves ./service-worker.js and ./worker.js relative to itself, so keep the four files
     (mogwai.js, service-worker.js, worker.js, sqlite3.wasm) together at any path. -->
<script type="module" src="./mogwai.js"></script>
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

function browserReadme(version: string): string {
  return `# mogwai-db — browser build ${version}

Run a TinkerPop 4 Gremlin graph (compiled to SQLite/WASM) entirely in the browser. Any TinkerPop-4 GLV,
or a plain \`fetch\`, talks to it over HTTP with no changes — a Service Worker is the local edge.

## Files

- \`mogwai.js\` — the ONE script your page includes. Registers the service worker + installs the per-tab
  worker factory. Resolves the two sibling scripts relative to itself (\`import.meta.url\`).
- \`service-worker.js\` — the HTTP edge; intercepts \`fetch('/gremlin/*')\` and \`/graphql/*\`.
- \`worker.js\` — one dedicated Worker per graph (SQLite on the \`opfs-sahpool\` VFS).
- \`sqlite3.wasm\` — the SQLite WASM binary \`worker.js\` loads at runtime (must sit beside it).

## Use

Serve the four files together (any path — they find each other) and include one script:

\`\`\`html
<script type="module" src="/path/to/mogwai.js"></script>
\`\`\`

Then any client can query \`POST /gremlin/{graphId}\` with \`{"gremlin":"g.V().count()"}\`. See index.html.

## Serving requirements

- **Secure context** — HTTPS, or \`http://localhost\` for development (Service Workers + OPFS require it).
- **\`sqlite3.wasm\` served as \`application/wasm\`.**
- **Service Worker scope** — by default the worker only controls its own directory and below. To serve
  graphs at a path ABOVE where \`service-worker.js\` lives, register it with a wider scope and send the
  \`Service-Worker-Allowed\` header (call \`installMogwai({ scope, serviceWorker, worker })\` from
  \`worker-factory.ts\` instead of the default \`mogwai.js\` bootstrap).
`;
}

if (wantBrowser) await packageBrowser();
if (wantBinaries) await packageBinaries();
