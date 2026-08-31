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
import { assertCfLimits } from '../cf-limits.ts';

/** `Sql` over an `@sqlite.org/sqlite-wasm` OO1 database handle. Synchronous — the OO1 API is, on every
 *  VFS. Construct with a handle from {@link memoryWasmSqlFactory} (in-memory) or
 *  {@link opfsSahpoolWasmSqlFactory} (`opfs-sahpool`, browser Worker). */
export class WasmSqlite implements Sql {
  /** `cfLimits` mirrors BunSqlite's `MOGWAI_CF_LIMITS` switch: assert Durable-Object statement legality
   *  (≤100 binds, ≤100 KB text) on every query. Off by default; the WASM runtime accepts far more, so a
   *  row-count-sized bind list would pass here and fail only on a real DO — exactly the trap cf-limits.ts
   *  exists to surface. */
  constructor(private readonly db: Database, private readonly cfLimits = false) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  query<T = any>(sql: string, binds: readonly unknown[] = []): T[] {
    if (this.cfLimits) assertCfLimits(sql, binds);
    // `resultRows` collects every row as an object ({column: value}); we read the array we passed, so
    // the call's `returnValue` is immaterial. One statement per exec (the whole codebase's contract),
    // so first-statement binding is the only binding.
    const rows: Record<string, SqlValue>[] = [];
    this.db.exec(sql, { bind: binds as SqlValue[], rowMode: 'object', resultRows: rows });
    return rows as T[];
  }

  close(): void {
    this.db.close();
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
export async function memoryWasmSqlFactory(cfLimits = false): Promise<(source: string) => WasmSqlite> {
  const sqlite3 = await wasmSqliteModule();
  return () => new WasmSqlite(new sqlite3.oo1.DB(':memory:', 'c'), cfLimits);
}

/** One graph's `opfs-sahpool` store, for a browser dedicated Worker. Installs the pool VFS (idempotent
 *  per `directory`), then opens `dbName` inside it. One dedicated Worker per graph = one DO, so each
 *  graph gets its own pool in its own OPFS `directory` (`.mogwai/{graphId}`), matching
 *  `idFromName(graphId) → distinct DO`. `createSyncAccessHandle` is spec-restricted to a dedicated
 *  Worker, so this MUST run inside one — never on the main thread or a SharedWorker. */
export async function opfsSahpoolWasmSql(
  directory: string,
  dbName = 'graph.sqlite3',
  cfLimits = false,
): Promise<WasmSqlite> {
  const sqlite3 = await wasmSqliteModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: `mogwai-${directory}`, directory });
  return new WasmSqlite(new pool.OpfsSAHPoolDb(`/${dbName}`), cfLimits);
}
