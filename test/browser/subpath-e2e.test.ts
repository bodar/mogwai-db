import { test, expect, describe, beforeAll } from 'bun:test';
import { join } from 'node:path';
import { browserInstance, browserLaneEnabled } from './support/harness.ts';
import { bundleBrowser } from '../../src/browser/bundle.ts';
import { LANDING_PAGE_HTML } from '../../src/browser/landing-page.ts';

// END-TO-END: the browser build served under a SUB-PATH, exactly as a GitHub Pages project site is
// (https://<owner>.github.io/<repo>/). This is the one test that exercises the WHOLE deployed shape in a
// real Chrome: the shipped landing page boots the service worker, the SW re-roots requests against its
// registration-scope base, and the API + the /docs UI both work under the sub-path. It is the regression
// guard for the base-path routing (src/browser/service-worker.ts) that a root-served test cannot cover.
//
// Bundles the real entries on the fly (no dependency on `dist/`), serves the SAME landing page the packager
// ships (src/browser/landing-page.ts), and asserts the redirect-to-docs handoff plus live graph writes.
const BASE = '/mogwai-db/';
const wasmPath = () => Bun.fileURLToPath(import.meta.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm'));
const bundle = (rel: string) => bundleBrowser(Bun.fileURLToPath(import.meta.resolve(rel)));

describe.skipIf(!browserLaneEnabled())('browser: sub-path deploy (GitHub Pages shape)', () => {
  let out: { onDocs: string; docsHasScalar: boolean; scalarStatus: number; openapi: string; serverUrl: string; putStatus: number; postStatus: number; vertexCount: number };
  let fatal: string | undefined;

  beforeAll(async () => {
    // The Scalar UI standalone — shipped as a plain static asset by the packager; served here the same way.
    const scalarJs = await Bun.file(join(import.meta.dir, '../../node_modules/@scalar/api-reference/dist/browser/standalone.js')).text();
    const files: Record<string, { body: string | ArrayBuffer; type: string }> = {
      'mogwai-db.js': { body: await bundle('../../src/browser/mogwai.ts'), type: 'text/javascript' },
      'service-worker.js': { body: await bundle('../../src/browser/service-worker.ts'), type: 'text/javascript' },
      'worker.js': { body: await bundle('../../src/browser/worker.ts'), type: 'text/javascript' },
      'registry-worker.js': { body: await bundle('../../src/browser/registry-worker.ts'), type: 'text/javascript' },
      'sqlite3.wasm': { body: await Bun.file(wasmPath()).arrayBuffer(), type: 'application/wasm' },
      'scalar.js': { body: scalarJs, type: 'text/javascript' },
      'index.html': { body: LANDING_PAGE_HTML, type: 'text/html; charset=utf-8' },
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
      // Land on the app root under the sub-path; the shipped index.html boots the SW and redirects to ./docs.
      await page.goto(`http://localhost:${server.port}${BASE}`, { waitUntil: 'commit' });
      await page.waitForURL(`**${BASE}docs`, { timeout: 45_000 });
      await page.waitForLoadState('domcontentloaded');
      // The docs UI actually mounts from the vendored Scalar asset (no CDN): #app is populated once
      // createApiReference runs — proof the local ./scalar.js loaded and executed under the sub-path.
      await page.waitForFunction(() => (document.querySelector('#app')?.childElementCount ?? 0) > 0, { timeout: 30_000 });
      // From the (now controlled) docs page — which also hosts the WorkerFactory via ./mogwai-db.js — every
      // path resolves RELATIVE to /mogwai-db/: the docs shell, the openapi spec, the vendored Scalar, and
      // the graph API. Absolute-rooted paths would fall outside the SW scope and never be intercepted.
      out = await page.evaluate(async () => {
        const g = 'e2e-' + Date.now();
        const put = await fetch('gremlin/' + g, { method: 'PUT' });
        const post = await fetch('gremlin/' + g, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gremlin: "g.addV('x')" }) });
        const info = await (await fetch('gremlin/' + g)).json() as any;
        const spec = await (await fetch('./openapi.json')).json() as any;
        return {
          onDocs: location.pathname,
          docsHasScalar: (await (await fetch('./docs')).text()).includes('createApiReference'),
          scalarStatus: (await fetch('./scalar.js')).status,
          openapi: String(spec.openapi),
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

  test('no fatal (redirect + evaluate completed)', () => { expect(fatal ?? null).toBeNull(); });
  test('index redirects to the docs UI under the sub-path', () => { expect(out.onDocs).toBe(BASE + 'docs'); });
  test('the docs shell is served (Scalar reference)', () => { expect(out.docsHasScalar).toBe(true); });
  test('the Scalar UI is vendored (served locally, not a CDN)', () => { expect(out.scalarStatus).toBe(200); });
  test('openapi.json is served under the sub-path', () => { expect(out.openapi).toMatch(/^3\./); });
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
