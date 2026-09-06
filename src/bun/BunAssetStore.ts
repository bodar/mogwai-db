// The BUN half of the AssetStore seam (src/assetstore.ts) — serve the docs' static assets from a copy
// EMBEDDED in the binary. The `with { type: 'file' }` import is the load-bearing part: `bun build --compile`
// copies the imported file INTO the standalone binary (it resolves to a `/$bunfs/root/…` path at runtime),
// so `mogwai-db` serves the Scalar UI with no node_modules, no sidecar file and no CDN — and the SAME import
// resolves to the real node_modules path under `bun src/bun/server.ts` in dev. Measured both ways: dev reads
// `node_modules/@scalar/…/standalone.js`; the compiled binary serves the embedded copy (identical bytes)
// from an unrelated cwd with node_modules absent.
//
// The specifier is a RELATIVE path into node_modules, deliberately NOT the package specifier
// `@scalar/api-reference/dist/browser/standalone.js`: that package's `exports` map does not expose the
// `dist/browser/*` subpath, so both `bun run` and `bun build` refuse it ("Could not resolve"). A relative
// path bypasses the exports map and resolves the file directly, which is what both embedding and dev need.
// Kept in sync with `SCALAR_VERSION` (src/docs.ts) — the same package the pinned-CDN fallback names — and
// with scripts/package.ts, which copies the same file for the browser + Cloudflare releases.
import scalarStandalone from '../../node_modules/@scalar/api-reference/dist/browser/standalone.js' with { type: 'file' };
import { type AssetStore, contentTypeFor } from '../assetstore.ts';

export class BunAssetStore implements AssetStore {
  async get(path: string): Promise<Response | null> {
    if (path === '/scalar.js')
      return new Response(Bun.file(scalarStandalone), { headers: { 'Content-Type': contentTypeFor(path) } });
    return null; // not one of our assets — the router falls through to its own routes
  }
}
