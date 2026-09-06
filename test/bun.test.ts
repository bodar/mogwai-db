import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/bun/server.ts';
import { graphContract } from './contract.ts';

let server: ReturnType<typeof startServer> | undefined;

// port 0 → OS-assigned free port; fresh in-memory registry per run.
graphContract('bun', {
  async start() {
    // A temp io root, the Bun half of the IoStore seam (the Worker's is an R2 binding declared in
    // wrangler.jsonc). Without it io() would fail closed naming the missing binding, and the shared
    // contract's io test would be asserting only that.
    server = startServer({ port: 0, ioDir: mkdtempSync(join(tmpdir(), 'mogwai-io-contract-')) });
    return `http://localhost:${server.port}`;
  },
  stop() {
    server?.stop(true);
  },
}, { servesAssets: true }); // the Bun server wires BunAssetStore, so the docs served-asset contract runs

// The Bun AssetStore seam (BunAssetStore): the Bun server SELF-HOSTS the docs' Scalar UI at /scalar.js from
// a copy embedded in the binary — no CDN — and the docs shell references it locally. This is the Bun-only
// half of increment 4a (the CF half is proven by the real-workerd cloudflare.test.ts); the shared
// docsContract only asserts the CDN-independent shell, so the served-asset + local-reference claims live
// here, where BunAssetStore is the runtime under test.
test('bun serves the Scalar UI at /scalar.js (text/javascript), and /docs references it locally', async () => {
  const srv = startServer({ port: 0 });
  try {
    const origin = `http://localhost:${srv.port}`;
    const asset = await fetch(`${origin}/scalar.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect((await asset.text()).length).toBeGreaterThan(1000); // the real UI module, not an empty/404 body
    // The docs shell loads Scalar from the local asset, not the jsdelivr CDN.
    const docs = await (await fetch(`${origin}/docs`)).text();
    expect(docs).toContain('src="./scalar.js"');
    expect(docs).not.toContain('cdn.jsdelivr.net');
  } finally {
    srv.stop(true);
  }
});

// The favicon + logo (increment 4b) are our COMMITTED source assets (public/favicon.ico, public/logo.png)
// that BunAssetStore EMBEDS via `with { type: 'file' }`. The shared docsContract already proves they serve
// as images and are referenced (it runs here with servesAssets:true, and against real workerd for CF); this
// Bun-specific test proves the extra thing only the embed mechanism can get wrong — the served bytes are the
// ACTUAL committed file, byte-for-byte, not a stale or truncated copy (the `with { type: 'file' }` analogue
// of the scalar.js served test above).
test('bun serves the EXACT committed favicon + logo bytes (the embedded copy is the real file)', async () => {
  const srv = startServer({ port: 0 });
  try {
    const origin = `http://localhost:${srv.port}`;
    for (const [path, file] of [['/favicon.ico', 'public/favicon.ico'], ['/logo.png', 'public/logo.png']] as const) {
      const served = new Uint8Array(await (await fetch(`${origin}${path}`)).arrayBuffer());
      const onDisk = new Uint8Array(await Bun.file(join(import.meta.dir, '..', file)).arrayBuffer());
      expect(served.length).toBe(onDisk.length);
      expect(Buffer.from(served).equals(Buffer.from(onDisk))).toBe(true);
    }
  } finally {
    srv.stop(true);
  }
});
