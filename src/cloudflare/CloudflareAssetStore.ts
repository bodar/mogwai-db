// The CLOUDFLARE half of the AssetStore seam (src/assetstore.ts) — serve the docs' static assets from the
// Workers Static Assets binding (`env.ASSETS`, a Fetcher). The binding is populated from the `public/`
// directory declared in wrangler.jsonc (`mise run assets` copies the Scalar standalone into it, and the
// Cloudflare release ships it alongside the Worker — scripts/package.ts). A Fetcher is addressed by URL, so
// we hand it a request whose PATHNAME is the asset path — the hostname is ignored by the binding, only the
// pathname is matched — and read a 404 as "not one of our assets" (→ null, so the router falls through to
// its own routes), any other status as the asset itself.
//
// `run_worker_first: true` in wrangler.jsonc is what makes this correct, not incidental: the Worker (our
// router) runs on EVERY request and pulls assets from the binding EXPLICITLY here, so CF never auto-serves a
// static file that would shadow a route (`/` = the docs shell, `/openapi.json` per request, `/gremlin/…`).
// Without it a static `/` would preempt the router before it ever saw the request.
import type { AssetStore } from '../assetstore.ts';

export class CloudflareAssetStore implements AssetStore {
  constructor(private readonly assets: Fetcher) {}
  async get(path: string): Promise<Response | null> {
    const res = await this.assets.fetch(new Request(`https://assets.local${path}`));
    return res.status === 404 ? null : res;
  }
}
