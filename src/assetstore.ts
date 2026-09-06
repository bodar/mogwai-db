// ---------- the AssetStore seam — where the docs' static assets live ----------
//
// The THIRD storage seam, in the exact mould of `Sql` (src/storage.ts, where a graph's ROWS live) and
// `IoStore` (src/iostore.ts, where a graph's whole-graph DOCUMENTS live): `AssetStore` hides where the
// docs' STATIC ASSETS live — the Scalar UI module the API reference loads, and (a planned follow-up) the
// favicon + logo. Each server runtime implements it and nothing above the seam knows which: Bun serves the
// asset from a copy EMBEDDED in the binary (bun/BunAssetStore.ts — a `bun build --compile` binary carries
// it, so a self-hosted server needs no CDN and no sidecar file), a Durable Object Worker from the Workers
// Static Assets binding (cloudflare/CloudflareAssetStore.ts). The router/docs layer depends ONLY on this
// interface — never on `Bun.file` or `env.ASSETS` — so serving the UI locally is a wiring choice, not a
// compiler concern.
//
// WHY a seam and not a CDN: the docs shell defaults `scalarUrl` to a pinned jsdelivr copy (src/docs.ts),
// which is a network dependency a self-hosted or air-gapped deployment cannot rely on. An entry point that
// wires an AssetStore instead passes `scalarUrl: './scalar.js'`, so the UI loads same-origin from the asset
// this seam serves. The BROWSER build needs no AssetStore — it ships `scalar.js` as a static sibling its
// service worker deliberately does NOT intercept (src/browser/service-worker.ts) — so this seam is the
// server-runtime (Bun/CF) half of that same "no CDN" story, giving all three runtimes one self-hosted docs.

/** Where the docs' static assets live. `get` returns a `Response` (the asset bytes + a `Content-Type`) for
 *  a path this store serves, or `null` for a path that is not one of its assets — so the router can fall
 *  through to its remaining routes. A `null` means "not one of my assets", never an error. One per runtime,
 *  an app-scope dependency; optional everywhere (a router with none falls back to the CDN default). */
export interface AssetStore {
  get(path: string): Promise<Response | null>;
}

/** The `Content-Type` for a served asset, by extension. Deliberately tiny — it covers only what the docs
 *  surface actually ships (the Scalar UI module today; the favicon + a logo image are the planned
 *  follow-up). An unknown extension falls back to `application/octet-stream` so a mis-added asset is inert,
 *  never mislabelled. */
export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'js': return 'text/javascript';
    case 'ico': return 'image/x-icon';
    case 'svg': return 'image/svg+xml';
    case 'png': return 'image/png';
    default: return 'application/octet-stream';
  }
}
