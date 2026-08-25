// ---------- the IoStore seam — where io() reads and writes whole-graph documents ----------
//
// The SECOND storage seam, exactly parallel to `Sql` (src/storage.ts): `Sql` hides how a graph's
// rows are stored, `IoStore` hides where a graph's DOCUMENTS live. Both runtimes implement it —
// Bun from a rooted directory (bun/FileIoStore.ts), a Durable Object from an R2 bucket binding
// (cloudflare/R2IoStore.ts) — and nothing above the seam knows which.
//
// STREAMING, and that is the whole point of this seam rather than a `Uint8Array` in/out: a graph
// may be up to a Durable Object's 10 GB storage ceiling, and a DO isolate has ~128 MB of memory, so
// a whole-graph read or write that MATERIALIZES the document is a production OOM no dev test can see
// (the reference graphs are kilobytes). So a read yields a byte STREAM the loader drains one page at
// a time, and a write is a SINK the drain pushes pages into — peak memory is one page, never the
// document. `io()` is a BARRIER service run at the executor's one await (services/catalog/io.ts), so
// the async shape below costs nothing: an object store's get/put are promises regardless.
//
// The WRITE sink is deliberately not "give me a whole ReadableStream": `fetch`/`Request` never got
// streaming request bodies on Workers, so the way to push >100 MB into R2 without buffering it all is
// R2's MULTIPART upload — many bounded parts, committed on close (cloudflare/R2IoStore.ts). A sink
// hides that: the format writers (formats/*.ts) push byte chunks and never learn whether the far end
// is a multipart upload, a file writer, or an in-memory buffer.
//
// Paths are a flat namespace the SERVER owns: `io("data/modern.json")` names a key, not a client
// filesystem. On Bun that key resolves under one configured root (and cannot escape it); on R2 it
// IS the object key.

/** A byte sink a whole-graph WRITE drains into — one per `write()` call. `write` appends a chunk
 *  (which the implementation may buffer and only physically flush at a part boundary); `close`
 *  commits the object; `abort` discards a partially-written object so a failed drain leaves no
 *  half-graph behind. Exactly one of `close`/`abort` is called, and no `write` follows either. */
export interface IoSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

/** Where io() reads and writes documents. One per graph, an app-scope dependency. */
export interface IoStore {
  /** Open `path` for streaming read. Fails closed (rejects) if the object is absent — an absent
   *  document is a fact about the request, not an empty graph. Re-openable: a caller that needs two
   *  passes over the bytes (the GraphSON loader does) calls this twice and gets a fresh stream each
   *  time. */
  readStream(path: string): Promise<ReadableStream<Uint8Array>>;
  /** Open `path` for streaming write, returning the sink to drain into. */
  writeStream(path: string): Promise<IoSink>;
  /** Every key under `prefix`, in the store's own order. */
  list(prefix: string): Promise<string[]>;
}

// No buffered `readAll`/`writeAll` convenience lives HERE, and that is deliberate: a whole-`Uint8Array`
// read or write is exactly the materialization this seam exists to prevent, and a helper on the
// production surface is a helper someone reaches for by mistake on a 10 GB graph. A test that wants to
// drain a stream to bytes writes its own local helper (test/support), where the object is known small.

/** The IoStore for a graph with no binding configured. Every operation fails closed NAMING the
 *  missing binding, because an absent R2 bucket / io directory is a configuration fact, not a
 *  capability gap — a silent no-op would answer a different question (the plan's rule). A null
 *  object rather than `undefined` so the scope entry stays total and no caller writes a guard. */
export const NO_IO_STORE: IoStore = {
  readStream: (path) => Promise.reject(new Error(noBinding(`read "${path}"`))),
  writeStream: (path) => Promise.reject(new Error(noBinding(`write "${path}"`))),
  list: (prefix) => Promise.reject(new Error(noBinding(`list "${prefix}"`))),
};

function noBinding(what: string): string {
  return `io(): cannot ${what} — no io binding is configured for this graph `
    + '(Bun: start the server with an io directory; Cloudflare: bind an R2 bucket as IO in wrangler.toml)';
}
