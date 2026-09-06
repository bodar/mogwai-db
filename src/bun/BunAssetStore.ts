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
// The favicon + logo come from the COMMITTED `public/` (our own source assets), not node_modules — unlike
// scalar.js above (a build artifact `mise run assets` copies in). All three embed the same way: `with { type:
// 'file' }` makes `bun build --compile` copy the file into the standalone binary, so a self-hosted server
// serves them with no sidecar files and no CDN, and the same imports resolve to the real on-disk paths in dev.
import favicon from '../../public/favicon.ico' with { type: 'file' };
import logo from '../../public/logo.png' with { type: 'file' };
// The `/examples/` reference-graph datasets (src/examples.ts), embedded the same way as scalar.js/favicon:
// `with { type: 'file' }` makes `bun build --compile` copy each into the standalone binary, so a self-hosted
// server (and the compiled `mogwai-db` binary) serves the example graphs with no sidecar files. The staged
// sources are `.graphson` (NOT `.json`) so tsc types them as file-path strings via the `*.graphson` ambient
// (asset-imports.d.ts); they are populated from the vendored corpus by `mise run examples`
// (scripts/copy-examples.ts) and served at the friendly `/examples/<name>.json` path below.
import exampleModern from './examples/modern.graphson' with { type: 'file' };
import exampleCrew from './examples/crew.graphson' with { type: 'file' };
import exampleSink from './examples/sink.graphson' with { type: 'file' };
import exampleGratefulDead from './examples/grateful-dead.graphson' with { type: 'file' };
import { type AssetStore, contentTypeFor } from '../assetstore.ts';

// Served path → the embedded file's on-disk (or `/$bunfs/root/…`) path. Keyed by the friendly `.json` name
// the docs' "Load example" entries fetch; the values are the `.graphson` embed copies. Kept in step with
// src/examples.ts (the mapping's single source of truth) — a new dataset adds a line here and there.
const EXAMPLE_FILES: Record<string, string> = {
  '/examples/modern.json': exampleModern,
  '/examples/crew.json': exampleCrew,
  '/examples/sink.json': exampleSink,
  '/examples/grateful-dead.json': exampleGratefulDead,
};

export class BunAssetStore implements AssetStore {
  async get(path: string): Promise<Response | null> {
    const file = path === '/scalar.js' ? scalarStandalone
      : path === '/favicon.ico' ? favicon
      : path === '/logo.png' ? logo
      : EXAMPLE_FILES[path] ?? null;
    if (file === null) return null; // not one of our assets — the router falls through to its own routes
    return new Response(Bun.file(file), { headers: { 'Content-Type': contentTypeFor(path) } });
  }
}
