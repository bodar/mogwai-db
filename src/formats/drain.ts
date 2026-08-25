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

import type { IoSink } from '../iostore.ts';

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

/**
 * Decode a byte stream into text LINES, streaming — the reframer a line-oriented reader (GraphSON
 * adjacency) drains through. Never holds more than one chunk's worth of text: complete lines are
 * yielded and only the trailing partial line is carried into the next chunk.
 *
 * UTF-8 aware across chunk boundaries: `TextDecoder({stream:true})` buffers a split multibyte
 * sequence rather than emitting a replacement char, and the final `decode()` flushes any tail. A
 * trailing `\r` (a CRLF file) is left on the line — `JSON.parse` treats it as whitespace, exactly as
 * the whole-string `split('\n')` path always has.
 */
export async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    const parts = carry.split('\n');
    carry = parts.pop() ?? '';          // the last piece is the (possibly empty) incomplete line
    for (const line of parts) yield line;
  }
  carry += decoder.decode();            // flush a dangling multibyte sequence
  if (carry.length) yield carry;
}

/**
 * Pump a line generator into a byte SINK, bounded memory — the streaming WRITE half every format
 * shares (GraphSON and CSV both drain the store as a `Generator<string>` of lines). Lines join with
 * `\n` and carry NO trailing newline, byte-identical to the whole-document `[...lines].join('\n')`
 * form, so either writer round-trips through either reader. Encoded text is buffered only up to
 * `flushBytes` before a `sink.write`, so peak memory is one flush buffer plus one store page —
 * never the document.
 */
export async function pumpLinesToSink(lines: Iterable<string>, sink: IoSink, flushBytes = 256 * 1024): Promise<void> {
  const encoder = new TextEncoder();
  let buf = '';
  let first = true;
  for (const line of lines) {
    buf += first ? line : `\n${line}`;
    first = false;
    if (buf.length >= flushBytes) { await sink.write(encoder.encode(buf)); buf = ''; }
  }
  if (buf.length) await sink.write(encoder.encode(buf));
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

// ---------- the standard owner-scoped reads every drain shares ----------
//
// A whole-graph writer reads the same three relations per page — a vertex's labels, a vertex's
// properties, an edge's properties — keyed by that page's owner ids. Both writers (GraphSON, CSV) had
// re-derived these membership reads and the `PropRow` shape from each other, which is exactly the
// re-derivation this module's header warns is how a DO-only bind wall comes back. They live here once;
// the one real difference between the two callers is whether a collection value arrives as `json()` TEXT.

/** One property row a drain reads — a `(key, value)` under an owner, with its stored type and (for a
 *  vertex property) its meta bag as `json()` TEXT. Shared by every writer's property stitching. */
export interface PropRow { id: number; owner: number; key: string; value: unknown; vtype: string | null; meta: string | null }

/** The `value` projection for a property read. A COLLECTION is stored as a JSONB blob, so a drain that
 *  JSON-parses the value (GraphSON's `valueNodeFromStored`) must ask for its `json()` TEXT — a raw blob
 *  would arrive as a byte Map; a drain that re-emits the value as a cell (CSV) leaves it raw. This is the
 *  same wrap the write-path readers use (`write.ts` readVertexProps). */
const valueExpr = (asText: boolean): string =>
  asText ? "CASE WHEN vtype IN ('list','map','set') THEN json(value) ELSE value END AS value" : 'value';

/** A page of vertex owners' label names, grouped by owner (a vertex's labels in insertion order). */
export const labelsForOwners = (w: RowWriter, ids: readonly number[]): Map<number, { owner: number; name: string }[]> =>
  groupByOwner(rowsForOwners<{ owner: number; name: string }>(w,
    (ph) => `SELECT vl.node AS owner, l.name AS name FROM vertex_labels vl JOIN labels l ON l.id = vl.label
             WHERE vl.node IN (${ph}) ORDER BY vl.node, vl.label`, ids));

/** A page of vertex owners' properties, grouped by owner. `asText` wraps a collection value as `json()`
 *  TEXT for a caller that JSON-parses it. Carries the meta bag as `json()` TEXT (vertices only). */
export const vertexPropsForOwners = (w: RowWriter, ids: readonly number[], asText: boolean): Map<number, PropRow[]> =>
  groupByOwner(rowsForOwners<PropRow>(w,
    (ph) => `SELECT id, node AS owner, key, ${valueExpr(asText)}, vtype,
                    CASE WHEN meta IS NULL THEN NULL ELSE json(meta) END AS meta
             FROM vertex_properties WHERE node IN (${ph}) ORDER BY node, id`, ids));

/** A page of edge owners' properties, grouped by owner. Edges carry no meta (always NULL). `asText` as
 *  for `vertexPropsForOwners`. */
export const edgePropsForOwners = (w: RowWriter, ids: readonly number[], asText: boolean): Map<number, PropRow[]> =>
  groupByOwner(rowsForOwners<PropRow>(w,
    (ph) => `SELECT id, edge AS owner, key, ${valueExpr(asText)}, vtype, NULL AS meta FROM edge_properties
             WHERE edge IN (${ph}) ORDER BY edge, id`, ids));
