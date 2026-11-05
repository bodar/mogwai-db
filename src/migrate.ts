// THE SCHEMA VERSION + ONE ORDERED MIGRATION RUNNER, shared by every store that owns a schema over the
// `Sql` seam (`GraphStore`, `ReplicatorStore`). `CREATE … IF NOT EXISTS` adds a table or an index to an
// existing store but never changes one, so anything that must CHANGE persisted data or a table's shape
// is a numbered migration here, applied once per store, in order.
//
// Deliberately small, and deliberately NOT a framework: no down-migrations, no checksums, no history log.
// A store's version is one integer — the count of migrations applied — in a ONE-ROW TABLE, never
// `PRAGMA user_version`: a Durable Object's SQLite refuses that pragma (SQLITE_AUTH), and the version must
// mean the same thing on all three hosts (bun:sqlite, a DO's `ctx.storage.sql`, the browser's WASM
// SQLite). Only a plain table and `sqlite_master` are read; nothing writes a pragma.
//
// Every migration is a SET-BASED statement program — no row loop in JS and no bind sized by the data
// (CLAUDE.md's bind rule). A plain migration runs as ONE atomic unit together with its version bump, so a
// throw leaves both the data and the version as they were. A graph can be as large as a DO's 10 GB
// ceiling, though, and one transaction rewriting every row of that can exceed the request's budget and
// roll back on every open — a store that cannot be opened at production size, i.e. a decline on data
// size. So a migration that rewrites rows may instead be RESUMABLE: an idempotent statement applied in
// keyset chunks by rowid, each chunk committed with its own cursor, and the version stamped only after
// the last chunk. Interrupted anywhere, the next open resumes after the last committed chunk.
import type { Sql } from './api.ts';

/** One schema change, applied once, in list order: the migration at index `i` takes a store from
 *  version `i` to `i + 1`. Exactly one of `run` / `resumable`. */
export interface Migration {
  /** A short stable name, for messages and tests — the VERSION is the position, not this. */
  readonly id: string;
  /** What a user would see go wrong on a store that skipped it. */
  readonly why: string;
  /** A set-based statement program, run as one atomic unit with the version bump. */
  run?(sql: Sql): void;
  /** A row rewrite too large for one unit at production size: `chunk` applies an IDEMPOTENT set-based
   *  statement to at most `limit` rows with rowid after `afterRowid` (`null`: from the first row — a
   *  rowid may be negative), and returns the last rowid it covered, or `null` once no row is left. Each
   *  call commits together with the cursor it returns. {@link rowidChunk} is the usual body. */
  resumable?: {
    chunk(sql: Sql, afterRowid: number | null, limit: number): number | null;
    /** Rows per chunk (default {@link DEFAULT_CHUNK}). */
    readonly limit?: number;
  };
}

/** Rows per resumable chunk unless a migration says otherwise — big enough that the per-chunk overhead
 *  (one cursor write) is noise, small enough that one chunk is far inside any request budget. */
const DEFAULT_CHUNK = 10_000;

/**
 * The keyset chunk every row-rewriting resumable migration needs: find the rowid range of the next
 * `limit` rows of `table` (a seek plus an in-order walk of the rowid b-tree), and hand it to `apply` as
 * `rowid > lo AND rowid <= hi`, which rewrites that range with ONE set-based statement. Returns `hi`, or
 * `null` when no row is left — so each chunk costs O(limit) and the whole migration O(rows). `table` is a
 * constant from the migration's own text, never data.
 */
export const rowidChunk = (table: string, apply: (sql: Sql, lo: number, hi: number) => void) =>
  (sql: Sql, afterRowid: number | null, limit: number): number | null => {
    const next = afterRowid === null ? '' : 'WHERE rowid > ?';
    const range = sql.query<{ lo: number | null; hi: number | null }>(
      `SELECT min(rowid) - 1 AS lo, max(rowid) AS hi FROM (SELECT rowid FROM ${table} ${next} ORDER BY rowid LIMIT ?)`,
      afterRowid === null ? [limit] : [afterRowid, limit])[0];
    if (range?.hi == null || range.lo == null) return null;
    apply(sql, afterRowid ?? range.lo, range.hi);
    return range.hi;
  };

/** What one store's schema is. */
export interface SchemaPlan {
  /** The one-row version table — each store's own name, so two schemas could share a database. */
  readonly versionTable: string;
  /** Tables whose presence means the store already holds data written before the version table
   *  existed (a LEGACY store, version 0). None present ⇒ a FRESH store: the DDL alone makes it current,
   *  so it is stamped at the latest version without running any migration. */
  readonly probeTables: readonly string[];
  /** The idempotent DDL (`IF NOT EXISTS`), one statement per entry — a DO's `exec` runs one. Run on
   *  every open, before the pending migrations, so a table or index added to it reaches an old store. */
  readonly schema: readonly string[];
  readonly migrations: readonly Migration[];
}

/** A store written by NEWER code than this — refused rather than read, since this code cannot know what
 *  a later migration changed. A named store error, so a host can hold it and raise it per request (a DO
 *  must not throw from its constructor — workerd counts that as an uncaught exception). */
export class SchemaTooNew extends Error {
  constructor(readonly stored: number, readonly supported: number, what: string) {
    super(`this ${what} was written by a newer mogwai-db: its schema is version ${stored}, and this server `
      + `understands versions up to ${supported} — open it with a server at least as new as the one that wrote it`);
    this.name = 'SchemaTooNew';
  }
}

/** What an open did — for tests and logs; callers otherwise ignore it. */
export interface MigrationOutcome {
  readonly from: number | 'fresh';
  readonly to: number;
  readonly applied: readonly string[];
}

type Atomically = <T>(fn: () => T) => T;

const quoteName = (name: string): string => `'${name.replace(/'/g, "''")}'`;

/**
 * Bring the store behind `sql` to the plan's latest version — the one entry point every open goes
 * through. Costs one `sqlite_master` probe plus one one-row read (and the idempotent DDL) on a store
 * that is already current. `what` names the store in a refusal ("graph", "replication registry").
 */
export function migrate(sql: Sql, atomically: Atomically, plan: SchemaPlan, what: string): MigrationOutcome {
  const latest = plan.migrations.length;
  const table = plan.versionTable;
  const names = [table, ...plan.probeTables].map(quoteName).join(', ');
  const present = new Set(sql.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name IN (${names})`).map((r) => r.name));

  if (!present.has(table)) {
    const fresh = !plan.probeTables.some((t) => present.has(t));
    atomically(() => {
      for (const statement of plan.schema) sql.exec(statement);
      sql.exec(`CREATE TABLE IF NOT EXISTS ${table}(
        id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, resume_after INTEGER)`);
      sql.query(`INSERT INTO ${table}(id, version) VALUES (1, ${fresh ? latest : 0})`);
    });
    if (fresh) return { from: 'fresh', to: latest, applied: [] };
    return { from: 0, to: latest, applied: applyPending(sql, atomically, plan, 0, null) };
  }

  const row = sql.query<{ version: number; resume_after: number | null }>(
    `SELECT version, resume_after FROM ${table} WHERE id = 1`)[0];
  const version = row?.version ?? 0;
  if (version > latest) throw new SchemaTooNew(version, latest, what);
  for (const statement of plan.schema) sql.exec(statement);
  if (!row) sql.query(`INSERT INTO ${table}(id, version) VALUES (1, 0)`);
  if (version === latest) return { from: version, to: latest, applied: [] };
  return { from: version, to: latest, applied: applyPending(sql, atomically, plan, version, row?.resume_after ?? null) };
}

/** Apply every migration after `version`, each with its own version bump. `resumeAfter` is the stored
 *  cursor of an interrupted resumable migration (the one at index `version`). */
function applyPending(sql: Sql, atomically: Atomically, plan: SchemaPlan, version: number, resumeAfter: number | null): string[] {
  const table = plan.versionTable;
  const applied: string[] = [];
  for (let i = version; i < plan.migrations.length; i++) {
    const migration = plan.migrations[i];
    const done = `UPDATE ${table} SET version = ${i + 1}, resume_after = NULL WHERE id = 1`;
    if (migration.resumable) {
      const { chunk, limit = DEFAULT_CHUNK } = migration.resumable;
      let after = i === version ? resumeAfter : null;
      for (;;) {
        const last = atomically(() => {
          const reached = chunk(sql, after, limit);
          // A cursor that does not advance would loop forever — a broken migration, not a big store.
          if (reached !== null && after !== null && !(reached > after))
            throw new Error(`migration ${migration.id}: the chunk after rowid ${after} returned ${reached}`);
          sql.query(reached === null ? done : `UPDATE ${table} SET resume_after = ${reached} WHERE id = 1`);
          return reached;
        });
        if (last === null) break;
        after = last;
      }
    } else {
      const run = migration.run;
      if (!run) throw new Error(`migration ${migration.id} has neither run nor resumable`);
      atomically(() => {
        run(sql);
        sql.query(done);
      });
    }
    applied.push(migration.id);
  }
  return applied;
}
