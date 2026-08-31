import type { IoSink, IoStore } from '../iostore.ts';

// The BROWSER half of the `IoStore` seam (src/iostore.ts) — the third leaf under an interface Bun
// (FileIoStore) and Cloudflare (R2IoStore) already implement, hiding where a graph's whole-graph
// DOCUMENTS live. Here they live in OPFS (the Origin Private File System), reached from inside a
// graph's dedicated Worker exactly as R2IoStore reaches its bucket from inside a Durable Object —
// so a whole-graph read or write happens where the graph lives and only bytes cross the seam.
//
// STREAMING both ways, which is the seam's whole point (a graph may be up to a DO's 10 GB ceiling
// while the isolate has ~128 MB): a READ is `(await handle.getFile()).stream()`, a WRITE drains into
// a `FileSystemWritableFileStream` from `createWritable()` — each an incremental pipe, so peak memory
// is one page, never the document. Unlike R2 (no streaming request body → multipart), OPFS gives a
// real writable stream directly, so the sink is a thin wrapper with no part-buffering.
//
// OPFS is per-ORIGIN, shared across every Worker and tab of the page's origin — so the io namespace is
// per-DEPLOYMENT (one shared tree), matching FileIoStore's one root and R2's one bucket, and a document
// one graph's Worker writes is readable by another graph's Worker. Keys resolve under a configured base
// directory so io documents never collide with the per-graph sahpool databases (which live under their
// own `.mogwai/{graphId}` directories — see WasmSqlite.ts). No rooting guard is needed (R2's reasoning):
// OPFS has no `..` traversal, so a key is a key; a leading slash names a key under the base, not a host
// root — empty path segments are simply dropped.
export class OpfsIoStore implements IoStore {
  /** `baseSegments` names the directory under the OPFS root that this store's keys resolve within,
   *  e.g. `['io']`. Kept as segments (not a joined path) so navigation never re-parses a separator. */
  constructor(private readonly baseSegments: readonly string[] = ['io']) {}

  /** The base directory handle, created (`create:true`) only for a write. A read passes `create:false`
   *  so a missing base surfaces as the standard fail-closed "no such document", not an empty tree. */
  private async baseDir(create: boolean): Promise<FileSystemDirectoryHandle> {
    let dir = await navigator.storage.getDirectory();
    for (const seg of this.baseSegments) dir = await dir.getDirectoryHandle(seg, { create });
    return dir;
  }

  /** Resolve `path` to its parent directory handle + final name, walking (and optionally creating) the
   *  intermediate directories. Empty segments (leading/trailing/double slash) are dropped. Throws if
   *  `path` names no file (all-empty). */
  private async resolve(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const segs = path.split('/').filter((s) => s.length > 0);
    const name = segs.pop();
    if (name === undefined) throw new Error(`io("${path}"): empty document path`);
    let dir = await this.baseDir(create);
    for (const seg of segs) dir = await dir.getDirectoryHandle(seg, { create });
    return { dir, name };
  }

  async readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    let file: File;
    try {
      const { dir, name } = await this.resolve(path, false);
      file = await (await dir.getFileHandle(name, { create: false })).getFile();
    } catch (e) {
      // A NotFoundError anywhere along the walk is an absent document — fail closed NAMING the key
      // (as FileIoStore and R2IoStore do), surfaced HERE rather than on the first chunk read. Any
      // other error (a real OPFS fault) propagates unchanged.
      if (e instanceof DOMException && e.name === 'NotFoundError')
        throw new Error(`io("${path}"): no such document in OPFS`);
      throw e;
    }
    return file.stream();
  }

  async writeStream(path: string): Promise<IoSink> {
    const { dir, name } = await this.resolve(path, true);
    const handle = await dir.getFileHandle(name, { create: true });
    // `createWritable` (default keepExistingData:false) truncates, so a rewrite never leaves stale tail
    // bytes. The writable buffers to a swap file and only commits on `close()`.
    const writable = await handle.createWritable();
    return {
      // The cast bridges `Uint8Array<ArrayBufferLike>` (the IoSink contract's chunk) to the DOM
      // `BufferSource` (`ArrayBufferView<ArrayBuffer>`); the bytes are always real-ArrayBuffer-backed.
      write: (chunk) => writable.write(chunk as ArrayBufferView<ArrayBuffer>),
      close: () => writable.close(),
      // A failed drain must leave no half-graph: `abort()` discards the swap without committing, then
      // remove the (possibly zero-length) entry `create:true` just made. `removeEntry` on an
      // already-gone name would throw, so swallow NotFound.
      abort: async () => {
        await writable.abort();
        await dir.removeEntry(name).catch((e) => {
          if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
        });
      },
    };
  }

  async list(prefix: string): Promise<string[]> {
    // Recursively walk the base tree, collecting root-relative `/`-joined keys, then filter by prefix
    // and sort — the same shape FileIoStore's glob and R2's paginated list return. A missing base
    // directory is an empty listing (nothing has been written), not an error.
    let base: FileSystemDirectoryHandle;
    try {
      base = await this.baseDir(false);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotFoundError') return [];
      throw e;
    }
    const keys: string[] = [];
    await this.walk(base, '', keys);
    return keys.filter((k) => k.startsWith(prefix)).sort();
  }

  private async walk(dir: FileSystemDirectoryHandle, prefix: string, out: string[]): Promise<void> {
    // `FileSystemDirectoryHandle` is an async-iterable of [name, handle] entries.
    for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      const key = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') await this.walk(handle as FileSystemDirectoryHandle, key, out);
      else out.push(key);
    }
  }
}
