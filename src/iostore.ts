// ---------- the IoStore seam — where io() reads and writes whole-graph documents ----------
//
// The SECOND storage seam, exactly parallel to `Sql` (src/storage.ts): `Sql` hides how a graph's
// rows are stored, `IoStore` hides where a graph's DOCUMENTS live. Both runtimes implement it —
// Bun from a rooted directory (bun/FileIoStore.ts), a Durable Object from an R2 bucket binding
// (cloudflare/R2IoStore.ts) — and nothing above the seam knows which.
//
// ASYNC, unlike `Sql`, and that is R2's shape rather than a preference: an object store's get/put
// are promises. It costs nothing here because io() is a BARRIER service, and a barrier already
// runs at the executor's one await (see services/catalog/io.ts).
//
// Paths are a flat namespace the SERVER owns: `io("data/modern.json")` names a key, not a client
// filesystem. On Bun that key resolves under one configured root (and cannot escape it); on R2 it
// IS the object key.

/** Where io() reads and writes documents. One per graph, an app-scope dependency. */
export interface IoStore {
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Every key under `prefix`, in the store's own order. */
  list(prefix: string): Promise<string[]>;
}

/** The IoStore for a graph with no binding configured. Every operation fails closed NAMING the
 *  missing binding, because an absent R2 bucket / io directory is a configuration fact, not a
 *  capability gap — a silent no-op would answer a different question (the plan's rule). A null
 *  object rather than `undefined` so the scope entry stays total and no caller writes a guard. */
export const NO_IO_STORE: IoStore = {
  read: (path) => Promise.reject(new Error(noBinding(`read "${path}"`))),
  write: (path) => Promise.reject(new Error(noBinding(`write "${path}"`))),
  list: (prefix) => Promise.reject(new Error(noBinding(`list "${prefix}"`))),
};

function noBinding(what: string): string {
  return `io(): cannot ${what} — no io binding is configured for this graph `
    + '(Bun: start the server with an io directory; Cloudflare: bind an R2 bucket as IO in wrangler.toml)';
}
