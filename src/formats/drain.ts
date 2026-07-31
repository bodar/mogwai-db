// The two helpers every whole-graph WRITER needs, and neither of which is format-specific.
//
// A drain has the same shape in every format: walk the elements in keyset pages (`keysetPages`),
// then for each page read its labels / properties / incident edges for that page's OWNER IDS and
// stitch them together in JS. Both halves of that are here because the second writer (CSV) would
// otherwise have re-derived them from the first (GraphSON) — and a re-derived bind-chunked read is
// how a DO-only 100-bind wall comes back.
//
// The stitching is deliberately in JS rather than in SQL: one `IN (…)` per page keeps every
// statement ONE fixed shape (so the prepared statement is reused), where a correlated
// json_group_array per element would make the statement's shape depend on the page.
import { bindChunks, placeholders, type RowWriter } from '../rowbatch.ts';

/**
 * Read rows for a set of owner ids, chunked so no statement's bind list scales with the page size.
 *
 * `sql` receives the placeholder list for ONE chunk, so the caller writes the projection and the
 * `IN (…)` position and never counts binds itself.
 */
export function rowsForOwners<T>(w: RowWriter, sql: (ph: string) => string, ids: readonly number[]): T[] {
  const out: T[] = [];
  for (const chunk of bindChunks(ids)) out.push(...w.query<T>(sql(placeholders(chunk.length)), chunk));
  return out;
}

/** Group rows by their owner id — the per-page join a drain does in JS (see the header). */
export function groupByOwner<T extends { owner: number }>(rows: readonly T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const r of rows) {
    const list = out.get(r.owner);
    if (list) list.push(r); else out.set(r.owner, [r]);
  }
  return out;
}
