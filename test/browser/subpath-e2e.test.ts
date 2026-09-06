import { test, expect, describe, beforeAll } from 'bun:test';
import { join } from 'node:path';
import { browserInstance, browserLaneEnabled } from './support/harness.ts';
import { bundleBrowser } from '../../src/browser/bundle.ts';
import { BROWSER_INDEX_HTML } from '../../src/browser/docs-page.ts';

// END-TO-END: the browser build served under a SUB-PATH, exactly as a GitHub Pages project site is
// (https://<owner>.github.io/<repo>/). This is the one test that exercises the WHOLE deployed shape in a
// real Chrome: the site root IS the API docs (the Scalar shell), which boots the service worker in place;
// the SW re-roots requests against its registration-scope base, and the API + the docs UI both work under
// the sub-path. It is the regression guard for the base-path routing (src/browser/service-worker.ts) that a
// root-served test cannot cover.
//
// Bundles the real entries on the fly (no dependency on `dist/`), serves the SAME index.html the packager
// ships (src/browser/docs-page.ts — the docs shell), and asserts SW-readiness plus live graph writes. There
// is no redirect hop and no reload: index.html IS the docs, and the shell defers mounting Scalar until the
// SW controls the page (skipWaiting + clients.claim), so the whole surface is served by the local edge.
const BASE = '/mogwai-db/';
// A stamped version, injected via the SAME `define` the packager uses (scripts/package.ts), so this proves
// the version REACHES the browser at runtime — the regression guard for the `typeof process` bug that hid
// the stamp and made the deployed site read 'dev' (see src/version.ts).
const TEST_VERSION = '9.9.9-e2e';
const wasmPath = () => Bun.fileURLToPath(import.meta.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm'));
const bundle = (rel: string) => bundleBrowser(Bun.fileURLToPath(import.meta.resolve(rel)), { define: { MOGWAI_VERSION: JSON.stringify(TEST_VERSION) } });

describe.skipIf(!browserLaneEnabled())('browser: sub-path deploy (GitHub Pages shape)', () => {
  let out: { rootPath: string; rootHasScalar: boolean; docsHasScalar: boolean; scalarStatus: number; faviconStatus: number; logoStatus: number; specLogo: string; openapi: string; version: string; serverUrl: string; putStatus: number; postStatus: number; vertexCount: number };
  let fatal: string | undefined;

  beforeAll(async () => {
    // The Scalar UI standalone — shipped as a plain static asset by the packager; served here the same way.
    const scalarJs = await Bun.file(join(import.meta.dir, '../../node_modules/@scalar/api-reference/dist/browser/standalone.js')).text();
    // The favicon + logo, our committed source assets the packager ships beside index.html (increment 4b) —
    // served here the same way so this e2e stays faithful to the deployed browser build (the shell links
    // `./favicon.ico`, the spec's `x-logo` points at `./logo.png`, both under the sub-path).
    const favicon = await Bun.file(join(import.meta.dir, '../../public/favicon.ico')).arrayBuffer();
    const logo = await Bun.file(join(import.meta.dir, '../../public/logo.png')).arrayBuffer();
    const files: Record<string, { body: string | ArrayBuffer; type: string }> = {
      'mogwai-db.js': { body: await bundle('../../src/browser/mogwai.ts'), type: 'text/javascript' },
      'service-worker.js': { body: await bundle('../../src/browser/service-worker.ts'), type: 'text/javascript' },
      'worker.js': { body: await bundle('../../src/browser/worker.ts'), type: 'text/javascript' },
      'registry-worker.js': { body: await bundle('../../src/browser/registry-worker.ts'), type: 'text/javascript' },
      'sqlite3.wasm': { body: await Bun.file(wasmPath()).arrayBuffer(), type: 'application/wasm' },
      'scalar.js': { body: scalarJs, type: 'text/javascript' },
      'favicon.ico': { body: favicon, type: 'image/x-icon' },
      'logo.png': { body: logo, type: 'image/png' },
      'index.html': { body: BROWSER_INDEX_HTML, type: 'text/html; charset=utf-8' },
    };
    const server = Bun.serve({ port: 0, async fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === BASE || p === BASE + 'index.html') return new Response(files['index.html']!.body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Service-Worker-Allowed': BASE } });
      if (p.startsWith(BASE)) {
        const f = files[p.slice(BASE.length)];
        if (f) return new Response(f.body, { headers: { 'Content-Type': f.type, ...(p.endsWith('service-worker.js') ? { 'Service-Worker-Allowed': BASE } : {}) } });
      }
      return new Response('STATIC-404', { status: 404, headers: { 'Content-Type': 'text/plain' } }); // an un-intercepted graph path lands here
    } });
    const ctx = await (await browserInstance()).newContext();
    const logs: string[] = [];
    try {
      const page = await ctx.newPage();
      page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
      page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
      page.on('response', (r) => { if (r.status() >= 400) logs.push(`[${r.status()}] ${r.url()}`); });
      // No network stubs: the browser build serves Scalar from its own `./scalar.js` (the vendored asset),
      // so the whole flow — landing page, SW, docs UI, and the graph API — is fully self-contained.
      // Land on the app root under the sub-path. The shipped index.html IS the docs (no redirect). On this
      // FRESH visit the SW is not controlling yet; the docs shell DEFERS mounting Scalar until the SW takes
      // control (skipWaiting + clients.claim → the page becomes controlled with NO reload, NO navigation).
      await page.goto(`http://localhost:${server.port}${BASE}`, { waitUntil: 'commit' });
      // Ready = the SW controls this page AND Scalar's #app has mounted from the vendored ./scalar.js. The
      // shell mounts ONLY once controlled, so a populated #app proves control drove the mount. Nothing
      // navigates, so the evaluate below runs in a document that will not be torn down under it.
      await page.waitForFunction(() =>
        !!navigator.serviceWorker.controller
        && (document.querySelector('#app')?.childElementCount ?? 0) > 0,
      { timeout: 60_000 });
      // From the (now controlled) docs page — which also hosts the WorkerFactory via ./mogwai-db.js — every
      // path resolves RELATIVE to /mogwai-db/: the site root (the docs shell itself), the openapi spec, the
      // vendored Scalar, and the graph API. Absolute-rooted paths would fall outside the SW scope.
      out = await page.evaluate(async () => {
        const g = 'e2e-' + Date.now();
        const put = await fetch('gremlin/' + g, { method: 'PUT' });
        const post = await fetch('gremlin/' + g, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gremlin: "g.addV('x')" }) });
        const info = await (await fetch('gremlin/' + g, { method: 'OPTIONS' })).json() as any;
        const spec = await (await fetch('./openapi.json')).json() as any;
        return {
          rootPath: location.pathname,
          // The site ROOT itself serves the docs shell (no redirect): fetch('.') resolves to /mogwai-db/,
          // which the SW leaves to the static host — proof the root IS the docs.
          rootHasScalar: (await (await fetch('.')).text()).includes('createApiReference'),
          docsHasScalar: (await (await fetch('./docs')).text()).includes('createApiReference'),
          scalarStatus: (await fetch('./scalar.js')).status,
          // The favicon + logo resolve RELATIVE to /mogwai-db/ too — served by the static host, self-contained.
          faviconStatus: (await fetch('./favicon.ico')).status,
          logoStatus: (await fetch('./logo.png')).status,
          specLogo: String(spec.info?.['x-logo']?.url),
          openapi: String(spec.openapi),
          version: String(spec.info?.version),
          serverUrl: String(spec.servers?.[0]?.url),
          putStatus: put.status,
          postStatus: post.status,
          vertexCount: info.vertexCount,
        };
      });
    } catch (e: any) {
      fatal = `${e?.message ?? e}\n--- browser console ---\n${logs.join('\n')}`;
    } finally {
      await ctx.close();
      server.stop(true);
    }
  }, 90_000);

  test('no fatal (readiness + evaluate completed)', () => { expect(fatal ?? null).toBeNull(); });
  test('the app root IS the docs UI under the sub-path (no redirect hop)', () => { expect(out.rootPath).toBe(BASE); });
  test('the site root serves the docs shell directly', () => { expect(out.rootHasScalar).toBe(true); });
  test('the /docs alias still serves the same Scalar reference', () => { expect(out.docsHasScalar).toBe(true); });
  test('the Scalar UI is vendored (served locally, not a CDN)', () => { expect(out.scalarStatus).toBe(200); });
  test('the favicon + logo serve from the static host under the sub-path, and the spec points at ./logo.png', () => {
    expect(out.faviconStatus).toBe(200);
    expect(out.logoStatus).toBe(200);
    expect(out.specLogo).toBe('./logo.png');
  });
  test('openapi.json is served under the sub-path', () => { expect(out.openapi).toMatch(/^3\./); });
  test('the stamped version reaches the browser (info.version is the defined value, not "dev")', () => {
    // The SW bundle was built with `define: { MOGWAI_VERSION }` above, exactly as the packager stamps a
    // release. If info.version is 'dev' here, the stamp is not reaching runtime — the bug src/version.ts fixes.
    expect(out.version).toBe(TEST_VERSION);
  });
  test('the spec servers[0].url is the absolute sub-path base (so the Scalar "try it" composes)', () => {
    // Request-derived + SW-supplied: the SW strips /mogwai-db/ before routing, so the base is threaded via
    // docsBaseUrl. It must end with the sub-path (no trailing slash) so `/gremlin/{graphId}` composes right.
    expect(out.serverUrl).toMatch(/\/mogwai-db$/);
    expect(out.serverUrl).toMatch(/^https?:\/\//);
  });
  test('the graph API works under the sub-path', () => {
    expect(out.putStatus).toBe(201);
    expect(out.postStatus).toBe(200);
    expect(out.vertexCount).toBe(1);
  });
});
