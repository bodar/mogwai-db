// The helpers every whole-graph WRITER needs, and none of which is format-specific.
//
// A drain has the same shape in every format: walk the elements in keyset pages (`keysetPages`),
// then for each page read its labels / properties / incident edges for that page's OWNER IDS and
// stitch them together in JS. All of that is here because the second writer (CSV) would otherwise
// have re-derived it from the first (GraphSON) — and a re-derived membership read is how a DO-only
// 100-bind wall comes back.
//
// The stitching is deliberately in JS rather than in SQL: one membership read per page keeps every
// statement ONE fixed shape (so the prepared statement is reused), where a correlated
// json_group_array per element would make the statement's shape depend on the page.

/** The minimal store seam a drain reads through — `GraphStore.query` satisfies it. Typed
 *  structurally so this module depends on no concrete store. */
export interface RowWriter {
  query<T = any>(sql: string, binds?: readonly unknown[]): T[];
}

/**
 * Read rows for a set of owner ids as ONE statement: the ids cross as a single JSON bind exploded by
 * `json_each`, never an `IN (…)` list sized by the page (§6·2 of the RelIR build plan). A page holds
 * up to `pageSize` owners, which past 100 would breach a Durable Object's bind cap as N placeholders —
 * one JSON value keeps the bind count fixed at 1 however large the page.
 *
 * `sql` receives the membership SUBQUERY the caller drops into its `IN (…)` position, so a call site
 * still writes its projection and `IN (${ph})` exactly as before and never counts binds itself. An
 * empty page reads nothing.
 */
export function rowsForOwners<T>(w: RowWriter, sql: (ph: string) => string, ids: readonly number[]): T[] {
  if (!ids.length) return [];
  return w.query<T>(sql('SELECT value FROM json_each(?)'), [JSON.stringify([...ids])]);
}

/**
 * DRAIN: stream a table's rows in ascending-id pages, bounded memory, two binds per statement.
 *
 * KEYSET pagination (`WHERE id > ?`), not `LIMIT ? OFFSET ?`: an OFFSET scan re-walks and discards
 * every earlier row, so draining a whole table costs O(n²) row visits, and the pages are not even
 * stable under a concurrent insert. Both statements are one fixed shape, so the prepared statement is
 * reused across every page. The two binds are the cursor and the page size — bounded by the QUERY,
 * never by DATA, so this is the one read that legitimately binds rather than exploding a JSON value.
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

/** Group rows by their owner id — the per-page join a drain does in JS (see the header). */
export function groupByOwner<T extends { owner: number }>(rows: readonly T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const r of rows) {
    const list = out.get(r.owner);
    if (list) list.push(r); else out.set(r.owner, [r]);
  }
  return out;
}
