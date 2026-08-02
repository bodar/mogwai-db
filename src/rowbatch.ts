// RowBatch — the bind-bounded way to move N rows across the `Sql` seam.
//
// Design: docs/archive/2026-07-31-bulk-transfer-and-io-substrate-plan.md §2. The one rule everything here
// exists to keep: **no statement's bind list is a function of row count.** A Durable Object rejects
// a statement past 100 bound parameters, so `ids.map(() => '?')` is a production wall that no Bun
// test can see (src/cf-limits.ts is the instrument that makes it visible; this module is the
// answer). Chunk at `floor(100 / binds-per-row)` with a FIXED-shape statement and one ragged tail.
//
// Chunking beats INLINING LITERALS on both runtimes — measured 4.6× (38 ms vs 176 ms for 20,000
// rows), because a fixed-shape statement hits the prepared-statement cache (`bun:sqlite` caches by
// SQL text, and so does DO) while a big inlined statement is a fresh parse that evicts it.
//
// **It does NOT beat one JSON bind, and the header used to imply it did.** Measured 2026-08-02 on
// both runtimes (docs/2026-08-01-relir-build-plan.md §10·5): chunking is ~1.7× faster than a single
// `json_each(?)` statement on `bun:sqlite` and ~2× SLOWER on DO, because 607 `sql.exec` calls cross
// the host boundary where one does not. **DO is the runtime we ship to, so one JSON bind is the rule
// for new code** — read or write. This module stays because it is what the LEGACY write path uses
// and it is correct; it is not the pattern to copy, and it shrinks to whatever JSON cannot carry.
//
// Deliberately NOT built on the `q` kernel: these are constant-shape DML statements over the fixed
// schema, with no predicates to compose and no relations to name. The kernel's job is compiling
// traversals to SELECTs.
import { CF_MAX_BINDS } from './cf-limits.ts';

/** The per-statement bind budget every batch here is cut to fit. */
export const BIND_BUDGET = CF_MAX_BINDS;

/** The minimal seam a batch writes through — `GraphStore.query` satisfies it (and brings the
 *  bind-type coercion both runtimes need), as does a bare `Sql`. Typed structurally so this module
 *  imports neither. */
export interface RowWriter {
  query<T = any>(sql: string, binds?: readonly unknown[]): T[];
}

/** `?,?,?` — one placeholder per item of a chunk. */
export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',');

export interface ChunkOptions {
  /** How many binds each item contributes to the statement. An id spliced into TWO `IN (…)`
   *  lists (`src IN (…) OR tgt IN (…)`) costs 2; a 5-column row costs 5. Default 1. */
  bindsPerItem?: number;
  /** Binds the statement carries regardless of chunk size (a leading `owner_elem=?`). Default 0. */
  fixedBinds?: number;
}

/** Rows per statement, given the per-row and fixed bind costs. At least 1 — a single row that
 *  cannot fit is the caller's problem to fail on, not something to silently drop. */
export function rowsPerStatement({ bindsPerItem = 1, fixedBinds = 0 }: ChunkOptions = {}): number {
  return Math.max(1, Math.floor((BIND_BUDGET - fixedBinds) / bindsPerItem));
}

/** Cut `items` into DO-legal chunks: N full chunks of `rowsPerStatement(opts)` then one ragged
 *  tail. A generator, so a reader can stream rows it has not materialized. */
export function* bindChunks<T>(items: Iterable<T>, opts: ChunkOptions = {}): Generator<T[]> {
  const size = rowsPerStatement(opts);
  let chunk: T[] = [];
  for (const item of items) {
    chunk.push(item);
    if (chunk.length === size) { yield chunk; chunk = []; }
  }
  if (chunk.length) yield chunk;
}

/** `INSERT INTO <table>(<columns>) VALUES (…),(…),…` — chunked, fixed shape.
 *
 *  `cell` renders one column's placeholder, for the columns that are not a plain `?`: a JSONB
 *  column binds its JSON *text* wrapped in `jsonb(?)` (both runtimes accept a string bind; a raw
 *  blob bind would diverge — storage.ts). `conflict` appends an `ON CONFLICT …` tail.
 *
 *  Every row must have one value per column: a ragged row would shift the whole VALUES list
 *  silently, so it throws. Returns the number of statements issued — the figure a bulk path reports,
 *  and the only one that says whether it is actually batching. */
export function insertRows(
  w: RowWriter,
  table: string,
  columns: readonly string[],
  rows: Iterable<readonly unknown[]>,
  { cell = () => '?', conflict = '' }: { cell?: (column: string) => string; conflict?: string } = {},
): number {
  const tuple = `(${columns.map(cell).join(', ')})`;
  const tail = conflict ? ` ${conflict}` : '';
  let statements = 0;
  for (const chunk of bindChunks(rows, { bindsPerItem: columns.length })) {
    const binds: unknown[] = [];
    for (const row of chunk) {
      if (row.length !== columns.length)
        throw new Error(`insertRows(${table}): row has ${row.length} values for ${columns.length} columns`);
      binds.push(...row);
    }
    w.query(
      `INSERT INTO ${table}(${columns.join(', ')}) VALUES ${chunk.map(() => tuple).join(', ')}${tail}`,
      binds,
    );
    statements++;
  }
  return statements;
}

/**
 * DRAIN: stream a table's rows in ascending-id pages, bounded memory, two binds per statement.
 *
 * KEYSET pagination (`WHERE id > ?`), not `LIMIT ? OFFSET ?`: an OFFSET scan re-walks and discards
 * every earlier row, so draining a whole table costs O(n²) row visits, and the pages are not even
 * stable under a concurrent insert. Both statements are one fixed shape, so the prepared statement is
 * reused across every page.
 *
 * `columns` must include `id` — it is the cursor. The rows come back exactly as `query` gives them, so
 * a caller reads its own column names.
 */
export function* keysetPages<T extends { id: number }>(
  w: RowWriter, table: string, columns: readonly string[], pageSize = 500,
): Generator<T[]> {
  const sql = `SELECT ${columns.join(', ')} FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`;
  let after = -1;
  for (;;) {
    const rows = w.query<T>(sql, [after, pageSize]);
    if (!rows.length) return;
    yield rows;
    if (rows.length < pageSize) return;
    after = rows[rows.length - 1].id;
  }
}

/** `DELETE FROM <table> WHERE <column> IN (…)` — chunked. The delete-by-id-set half of every
 *  cascade (drop()'s six statements, the FTS owner sweep). */
export function deleteWhereIn(w: RowWriter, table: string, column: string, ids: readonly unknown[]): void {
  for (const chunk of bindChunks(ids))
    w.query(`DELETE FROM ${table} WHERE ${column} IN (${placeholders(chunk.length)})`, chunk);
}
