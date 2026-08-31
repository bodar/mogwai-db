// The Playwright browser lane's shared driver — the twin of test/cloudflare.test.ts's spawn-and-drive,
// but for a real Chrome instead of wrangler dev. The lane runs as part of a normal `bun test` / `mise run
// ci` (its own `browser` CI bracket, like L1–L5), and each `describe` is `skipIf(!chromeAvailable())` so a
// machine with no system Chrome (or an explicit `$MOGWAI_SKIP_BROWSER`) SKIPS them cleanly rather than
// failing — CI has Chrome, so the gate still covers them there.
//
// Playwright is used as a DRIVER LIBRARY (`chromium.launch()`), not `@playwright/test` — no second test
// runner; `bun test` stays the one runner. It drives the SYSTEM Chrome (present on GitHub's
// ubuntu-latest images and here at /usr/bin/google-chrome-stable) via `executablePath`, so no Playwright
// browser download is needed — only the driver package. localhost is a secure context, so OPFS + Web
// Locks + Service Workers all work over plain HTTP with no certs and no COOP/COEP.
import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { bundleBrowser } from '../../../src/browser/bundle.ts';

/** The Chrome binary Playwright drives. System Chrome by default (no download); override with
 *  `$MOGWAI_CHROME` if a machine keeps it elsewhere. */
export const CHROME_PATH = process.env.MOGWAI_CHROME ?? '/usr/bin/google-chrome-stable';

/** The skip gate for every browser `describe`. The lane runs only when ALL hold:
 *   - `$MOGWAI_RUN_BROWSER` is set — because the lane's on-the-fly `Bun.build` (which reads the whole
 *     vendored gremlin client) is unreliable under the FULL suite's file-descriptor load in ONE bun
 *     process (measured: `EBADF`/`EINVAL` reading the client), but rock-solid in its OWN process. So it
 *     runs isolated: the `browser` CI bracket and the `mise run test:browser` step set this flag, while a
 *     bare `bun test` / the mixed core run leaves it unset and SKIPS the lane. Use `mise run test`.
 *   - a system Chrome binary is present (the lane drives it, no Playwright download) — so a machine
 *     without Chrome skips cleanly even with the flag; CI has Chrome, so the gate still covers it there.
 *   - `$MOGWAI_SKIP_BROWSER` is unset — the escape hatch for a present-but-unlaunchable Chrome. */
export function browserLaneEnabled(): boolean {
  if (process.env.MOGWAI_SKIP_BROWSER) return false;
  if (!process.env.MOGWAI_RUN_BROWSER) return false;
  try {
    return existsSync(CHROME_PATH);
  } catch {
    return false;
  }
}

// ONE shared Chrome for the whole browser lane. Launching a fresh Chrome PER test file hung on CI: the
// stage timing showed the 4th/5th `chromium.launch()` never resolving under the runner's resource limits,
// while a single launch reused across files is stable. Each test still gets an ISOLATED BrowserContext
// (own storage partition → own OPFS), so graphs never collide across tests. The browser is closed on
// process exit (bun test ending kills it regardless); a leaked context would matter, a leaked browser
// does not. `bun test test/browser` runs all files in one process, so this singleton is shared.
let sharedBrowser: Promise<Browser> | undefined;
function browserInstance(): Promise<Browser> {
  if (!sharedBrowser) {
    sharedBrowser = chromium.launch({
      headless: true,
      executablePath: CHROME_PATH,
      args: [
        // CI essentials. --no-sandbox is required in the runner's unprivileged container;
        // --disable-dev-shm-usage moves Chrome's shared memory off the runner's tiny (~64 MB) /dev/shm.
        '--no-sandbox',
        '--disable-dev-shm-usage',
        // Headless has no visible tab, so Chrome backgrounds the page and throttles timers/rAF to ~1/min,
        // stalling anything that chains many async turns under CI load. These three lift that.
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });
    void sharedBrowser.then((b) => process.once('exit', () => { void b.close(); }));
  }
  return sharedBrowser;
}

/** Resolve the sqlite-wasm binary the package publishes as `./sqlite3.wasm`, served alongside a bundled
 *  worker so `@sqlite.org/sqlite-wasm` finds it by default (it fetches `sqlite3.wasm` relative to the
 *  worker URL). Resolved through the package export so it survives a version bump. */
function wasmPath(): string {
  return Bun.fileURLToPath(import.meta.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm'));
}

const PAGE = (workerType: 'module' | 'classic') => `<!doctype html><meta charset="utf-8"><title>loading</title>
<script type="module">
  const w = new Worker('/worker.js'${workerType === 'module' ? ", { type: 'module' }" : ''});
  w.onmessage = (e) => { window.__result = e.data; window.__done = true; };
  w.onerror = (e) => { window.__result = { workerError: String(e.message || e), filename: e.filename }; window.__done = true; };
  w.postMessage('go');
</script>`;

export interface BrowserWorkerRun {
  /** Absolute path to the dedicated-worker entry module (bundled fresh for the browser here). */
  entry: string;
  /** Extra worker bundles to serve, keyed by the URL path the driver worker spawns them from (e.g.
   *  `{ '/graph-worker.js': '/abs/path/worker.ts' }`). A dedicated Worker may create nested
   *  Workers, so the driver worker at `entry` can `new Worker('/graph-worker.js')`. */
  extraWorkers?: Record<string, string>;
  /** Milliseconds to wait for the worker to post its result. */
  timeoutMs?: number;
}

/**
 * Bundle a dedicated-worker entry for the browser, serve it (plus `sqlite3.wasm`) over http://localhost,
 * spawn it in a real Chrome, and return whatever the worker `postMessage`s back. The worker does the
 * exercising against the real browser APIs; the caller (a `bun test`) asserts on the returned value —
 * mirroring how cloudflare.test.ts drives the contract against a real workerd and asserts here.
 */
export async function runBrowserWorker({ entry, extraWorkers = {}, timeoutMs = 60_000 }: BrowserWorkerRun): Promise<any> {
  const workerJs = await bundleBrowser(entry);
  const extras: Record<string, string> = {};
  for (const [path, file] of Object.entries(extraWorkers)) extras[path] = await bundleBrowser(file);
  const wasm = await Bun.file(wasmPath()).arrayBuffer();

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === '/worker.js') return new Response(workerJs, { headers: { 'Content-Type': 'text/javascript' } });
      if (p === '/sqlite3.wasm') return new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } });
      if (p in extras) return new Response(extras[p], { headers: { 'Content-Type': 'text/javascript' } });
      return new Response(PAGE('module'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    },
  });

  const context = await (await browserInstance()).newContext();
  const consoleLines: string[] = [];
  try {
    const page = await context.newPage();
    page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
    await page.goto(`http://localhost:${server.port}/`);
    await page.waitForFunction('window.__done === true', { timeout: timeoutMs });
    const result = await page.evaluate('window.__result');
    if (result && typeof result === 'object' && 'workerError' in result)
      throw new Error(`worker threw before posting a result: ${(result as any).workerError}\n${consoleLines.join('\n')}`);
    return result;
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- browser console ---\n${consoleLines.join('\n')}`);
  } finally {
    await context.close();
    server.stop(true);
  }
}

export interface BrowserPageRun {
  /** The page's ESM entry (bundled + served as `/page.js`, loaded by the page). It sets `window.__done`
   *  and `window.__result` when finished. */
  pageEntry: string;
  /** The Service Worker entry (bundled + served as `/service-worker.js`, scope `/`). */
  serviceWorker: string;
  /** Extra worker bundles the page spawns (e.g. `{ '/graph-worker.js': '…/worker.ts' }`). */
  extraWorkers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Drive a real PAGE (not a spawned worker) in Chrome — for the Service Worker edge, where the client's
 * `fetch` runs in the page and the Service Worker intercepts it. Serves the page, its Service Worker, and any graph-worker
 * bundles over http://localhost (a secure context, so Service Worker + OPFS work with no certs), then returns
 * whatever `window.__result` the page sets when `window.__done` is true.
 */
export async function runBrowserPage({ pageEntry, serviceWorker, extraWorkers = {}, timeoutMs = 60_000 }: BrowserPageRun): Promise<any> {
  const pageJs = await bundleBrowser(pageEntry);
  const serviceWorkerJs = await bundleBrowser(serviceWorker);
  const extras: Record<string, string> = {};
  for (const [path, file] of Object.entries(extraWorkers)) extras[path] = await bundleBrowser(file);
  const wasm = await Bun.file(wasmPath()).arrayBuffer();
  const HTML = `<!doctype html><meta charset="utf-8"><title>loading</title><script type="module" src="/page.js"></script>`;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      // The Service Worker is served with a root scope so it can intercept /gremlin/* regardless of the page path.
      if (p === '/service-worker.js') return new Response(serviceWorkerJs, { headers: { 'Content-Type': 'text/javascript', 'Service-Worker-Allowed': '/' } });
      if (p === '/page.js') return new Response(pageJs, { headers: { 'Content-Type': 'text/javascript' } });
      if (p === '/sqlite3.wasm') return new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } });
      if (p in extras) return new Response(extras[p], { headers: { 'Content-Type': 'text/javascript' } });
      return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    },
  });

  const context = await (await browserInstance()).newContext();
  const consoleLines: string[] = [];
  const page = await context.newPage();
  try {
    page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
    await page.goto(`http://localhost:${server.port}/`);
    await page.waitForFunction('window.__done === true', { timeout: timeoutMs });
    return await page.evaluate('window.__result');
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- browser console ---\n${consoleLines.join('\n')}`);
  } finally {
    await context.close();
    server.stop(true);
  }
}

export interface BrowserContextRun {
  /** The page's ESM entry (bundled + served as `/page.js`). For a multi-page scenario it should expose an
   *  API on `window` (e.g. `window.mogwai`) that the driver calls step by step via `page.evaluate`. */
  pageEntry: string;
  /** The Service Worker entry (bundled + served as `/service-worker.js`, scope `/`). */
  serviceWorker: string;
  /** Extra worker bundles the pages spawn (e.g. `{ '/graph-worker.js': '…/worker.ts' }`). */
  extraWorkers?: Record<string, string>;
}

/**
 * Drive a scenario across MULTIPLE pages in ONE shared BrowserContext — for cross-tab tests (leader
 * election + failover), where several tabs share one origin's OPFS, Web Locks, and the single Service
 * Worker. Serves the page/SW/graph-worker bundles over http://localhost, then hands `fn` the shared
 * `context` and `origin` so it can open pages, drive them via `evaluate`, and hard-kill one (`page.close`).
 * The pages are NOT auto-navigated — `fn` opens exactly the tabs the scenario needs.
 */
export async function withBrowserContext<T>({ pageEntry, serviceWorker, extraWorkers = {} }: BrowserContextRun, fn: (ctx: { context: BrowserContext; origin: string; console: string[] }) => Promise<T>): Promise<T> {
  const pageJs = await bundleBrowser(pageEntry);
  const serviceWorkerJs = await bundleBrowser(serviceWorker);
  const extras: Record<string, string> = {};
  for (const [path, file] of Object.entries(extraWorkers)) extras[path] = await bundleBrowser(file);
  const wasm = await Bun.file(wasmPath()).arrayBuffer();
  const HTML = `<!doctype html><meta charset="utf-8"><title>loading</title><script type="module" src="/page.js"></script>`;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === '/service-worker.js') return new Response(serviceWorkerJs, { headers: { 'Content-Type': 'text/javascript', 'Service-Worker-Allowed': '/' } });
      if (p === '/page.js') return new Response(pageJs, { headers: { 'Content-Type': 'text/javascript' } });
      if (p === '/sqlite3.wasm') return new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } });
      if (p in extras) return new Response(extras[p], { headers: { 'Content-Type': 'text/javascript' } });
      return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    },
  });

  const context = await (await browserInstance()).newContext();
  const consoleLines: string[] = [];
  // Attach per-page (robust across Playwright versions — context-level 'console' is newer). Every page the
  // scenario opens gets its console + page errors funneled into one buffer surfaced on failure.
  context.on('page', (p) => {
    p.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
    p.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
  });
  try {
    return await fn({ context, origin: `http://localhost:${server.port}`, console: consoleLines });
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- browser console ---\n${consoleLines.join('\n')}`);
  } finally {
    await context.close();
    server.stop(true);
  }
}
