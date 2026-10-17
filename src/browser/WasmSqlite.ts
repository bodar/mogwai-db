// The BROWSER half of the `Sql` storage seam (src/storage.ts) — the third leaf under an interface
// bun:sqlite and the Durable Object already implement. `Sql` sits at the SYNCHRONOUS SQLite transport
// because that alignment is the whole reason a Durable Object database ports to the browser at all:
// inside a dedicated Worker, `@sqlite.org/sqlite-wasm` on the `opfs-sahpool` VFS is SYNCHRONOUS
// (a `SyncAccessHandle` read/write, no JSPI, no SharedArrayBuffer), so everything above this leaf —
// GraphStore, the whole compiler, execute.ts — runs unchanged, and the async the browser imposes sits
// ABOVE the Worker, at seams (`executor().framedAsync`, `IoStore`) that are already async in the core.
//
// The class wraps an OO1 `Database` handle and is VFS-agnostic: the same wrapper serves an in-memory
// database (dev/tests — a real WASM SQLite in the Bun test process, which is how the browser leaf gets
// DEEP conformance coverage without a browser) and an `opfs-sahpool` database (production, one per
// graph). Two factories mint the handle; the wrapper is identical over both.
//
// PER-TARGET BUNDLING keeps this dependency out of the Bun and Cloudflare bundles: only the browser
// entry (and this file's tests) import `src/browser/*`, so the CF worker / Bun server never pull
// `@sqlite.org/sqlite-wasm` in. The bare `import` below resolves to the package's `node` export under
// Bun and its `browser` export under the browser bundler — same statement, target-selected build.
import sqlite3InitModule, { type Database, type Sqlite3Static, type SqlValue } from '@sqlite.org/sqlite-wasm';
import type { Sql } from '../storage.ts';
import { retryWhileHandleHeld } from './opfs-release.ts';

/** `Sql` over an `@sqlite.org/sqlite-wasm` OO1 database handle. Synchronous — the OO1 API is, on every
 *  VFS. Construct with a handle from {@link memoryWasmSqlFactory} (in-memory) or
 *  {@link opfsSahpoolWasmSql} (`opfs-sahpool`, browser Worker). */
export class WasmSqlite implements Sql {
  /** `release` frees whatever the VFS holds beyond the database handle itself — for `opfs-sahpool`, the
   *  pool's OPFS `SyncAccessHandle`s (see {@link opfsSahpoolWasmSql}). */
  constructor(private readonly db: Database, private readonly release?: () => void) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  query<T = any>(sql: string, binds: readonly unknown[] = []): T[] {
    // `resultRows` collects every row as an object ({column: value}); we read the array we passed, so
    // the call's `returnValue` is immaterial. One statement per exec (the whole codebase's contract),
    // so first-statement binding is the only binding.
    const rows: Record<string, SqlValue>[] = [];
    this.db.exec(sql, { bind: binds as SqlValue[], rowMode: 'object', resultRows: rows });
    return rows as T[];
  }

  /** Close the database AND release the VFS's resources, synchronously: when this returns, nothing of
   *  this store holds an OPFS lock. Idempotent (OO1 `close()` and the pool's `pauseVfs()` both are). */
  close(): void {
    try {
      this.db.close();
    } finally {
      this.release?.();
    }
  }
}

/** The WASM module, initialized once per process/worker (init is async; the OO1 API it yields is sync).
 *  Memoized so many graphs share one module — each graph still gets its own isolated `Database`. */
let modulePromise: Promise<Sqlite3Static> | undefined;
export function wasmSqliteModule(): Promise<Sqlite3Static> {
  return (modulePromise ??= sqlite3InitModule());
}

/** A SYNCHRONOUS store factory `(source) => WasmSqlite` over in-memory WASM SQLite, for tests and for
 *  any in-process manager (BunGraphManager's `makeSql` seam). Async only to initialize the module ONCE
 *  up front; the returned factory is sync so it drops straight into a sync `resolve(id)`. Each call
 *  mints a fresh, isolated `:memory:` database — one per graph, mirroring one DB per graph on OPFS. */
export async function memoryWasmSqlFactory(): Promise<(source: string) => WasmSqlite> {
  const sqlite3 = await wasmSqliteModule();
  return () => new WasmSqlite(new sqlite3.oo1.DB(':memory:', 'c'));
}

/** One graph's `opfs-sahpool` store, for a browser dedicated Worker. Installs the pool VFS (idempotent
 *  per `directory`), then opens `dbName` inside it. One dedicated Worker per graph = one DO, so each
 *  graph gets its own pool in its own OPFS `directory` (`.mogwai/{graphId}`), matching
 *  `idFromName(graphId) → distinct DO`. `createSyncAccessHandle` is spec-restricted to a dedicated
 *  Worker, so this MUST run inside one — never on the main thread or a SharedWorker. */
export async function opfsSahpoolWasmSql(directory: string, dbName = 'graph.sqlite3'): Promise<WasmSqlite> {
  const sqlite3 = await wasmSqliteModule();
  // The VFS registration name must be a plain identifier (no path separators), so sanitize the
  // directory into one; the `directory` itself may carry `/` path elements (created automatically).
  const name = `mogwai-${directory.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
  // A previous owner that died WITHOUT closing (its tab closed → failover; a Worker terminated mid-query)
  // may still hold the files' access handles, released whenever its thread is torn down with no event to
  // await — so the install (which takes a handle on every file) is retried while refused, bounded
  // (`retryWhileHandleHeld`, opfs-release.ts). `forceReinitIfPreviouslyFailed` is what makes a retry a real
  // retry: sqlite-wasm otherwise caches the failed init per VFS name and replays its rejection forever
  // (`installOpfsSAHPoolVfs` in @sqlite.org/sqlite-wasm's dist/index.mjs; its .d.ts omits the option, so
  // the options are built as a variable rather than a literal the excess-property check would reject).
  const options = { name, directory, forceReinitIfPreviouslyFailed: true };
  const pool = await retryWhileHandleHeld(() => sqlite3.installOpfsSAHPoolVfs(options));
  // The pool holds an exclusive `SyncAccessHandle` on EVERY file in `directory` for as long as it is
  // installed — not only while the database is open — and OPFS refuses to remove a directory while any
  // handle inside it is open (`NoModificationAllowedError`). So `close()` also `pauseVfs()`es, which
  // closes them all SYNCHRONOUSLY (`FileSystemSyncAccessHandle.close()` is sync): a caller that has
  // awaited the close knows the directory is removable. `Worker.terminate()` gives no such guarantee —
  // a terminated worker's handles are released whenever its thread is finally torn down, with no event
  // to await — which is the destroy race this closes.
  return new WasmSqlite(new pool.OpfsSAHPoolDb(`/${dbName}`), () => pool.pauseVfs());
}
