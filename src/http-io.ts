// ---------- io() over HTTP — a document fetched from a URL ----------
//
// docs/2026-09-02-replication-and-http-interop-plan.md §7/§9. `g.io("https://…/modern.json").read()`
// imports another graph over HTTP. This is a SEPARATE concern from federate-over-HTTP: io moves a
// whole DOCUMENT (GraphSON / CSV — the only formats io supports), never a live traversal, so a URL is
// just another document LOCATION. The io service is untouched — it already resolves the format from the
// path and streams through the two-pass loader (`services/catalog/io.ts`); all that changes is the
// injected `IoStore` becoming URL-aware.
//
// `httpAwareIoStore` dispatches by PATH: an `http(s)` path streams over the injected `Http` seam (the
// same one federation uses — every outbound call goes through it, so this is in-memory testable), and
// anything else delegates to the configured base store (a rooted directory on Bun, an R2 bucket in a
// DO). A URL READ works even with NO local binding; a non-URL path with no binding fails closed naming
// the missing binding, exactly as before.

import type { Http } from './api.ts';
import type { IoStore, IoSink } from './iostore.ts';
import { isHttpUrl } from './http-federation.ts';

/** An `IoStore` backed by HTTP over the injected `Http` seam. READ streams a document's body; WRITE
 *  and LIST fail closed — pushing a whole graph into an HTTP endpoint has no streaming request body on
 *  a Worker (the reason the R2 sink is multipart), and there is no list semantics for a single URL. A
 *  write TARGET is the peer protocol's job (§9), not a bulk `io()` dump. */
export function httpIoStore(http: Http): IoStore {
  return {
    async readStream(url: string): Promise<ReadableStream<Uint8Array>> {
      const resp = await http(new Request(url));
      if (!resp.ok || !resp.body)
        throw new Error(`io("${url}"): HTTP GET failed — ${resp.status} ${resp.statusText}`);
      return resp.body;
    },
    writeStream(url: string): Promise<IoSink> {
      return Promise.reject(new Error(
        `io("${url}"): writing a graph to an HTTP URL is not supported — io() writes to a local store `
        + '(a directory on Bun, an R2 bucket in a DO). Replicating TO a peer is the replication API, not io()',
      ));
    },
    list(prefix: string): Promise<string[]> {
      return Promise.reject(new Error(`io("${prefix}"): listing an HTTP URL is not supported`));
    },
  };
}

/** Make an `IoStore` URL-aware: an `http(s)` path routes to {@link httpIoStore} over `http`, everything
 *  else to `base` (the graph's configured local store). The one wrapper both managers apply so an
 *  `io()` URL works uniformly, on Bun and in a DO, through the same `Http` transport federation uses. */
export function httpAwareIoStore(base: IoStore, http: Http): IoStore {
  const over = httpIoStore(http);
  const pick = (path: string): IoStore => (isHttpUrl(path) ? over : base);
  return {
    readStream: (path) => pick(path).readStream(path),
    writeStream: (path) => pick(path).writeStream(path),
    list: (prefix) => pick(prefix).list(prefix),
  };
}
