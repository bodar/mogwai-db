// SET-BASED WRITES — N literal rows into one table as ONE relational `Insert`, rendered by the
// RelIR emitter and run by the binding executor. This is the whole runtime write driver: the chunked,
// hand-rolled multi-row DML it replaced is gone, so there is no second write renderer and no bind
// list that scales with row count anywhere.
//
// The rows cross as ONE JSON bind exploded by `json_each` (§6·2 of the RelIR build plan), the same
// transport `compiler/rel/foreign.ts` uses to land a barrier's awaited rows and `build.ts`'s
// `jsonEachSet` uses for every bound collection. A data-sized set is a single value, never N
// parameters — which is what makes a load of 10,000 rows O(1) binds instead of a Durable Object wall
// no Bun test can see (src/cf-limits.ts). JSON transport also AGREES across runtimes where native
// binds diverge: an integer read from a JSON array binds INTEGER on both, where a native number bind
// is INTEGER on Bun and REAL on DO. The empty case needs no branch here — a caller with no rows makes
// no statement at all.
//
// This is a runtime driver over the SAME algebra a compiled `addV` lowers to: it builds an `Insert`
// whose source is the exploded literal, wraps it in a one-binding `Plan`, and hands it to
// `runProgram`. It is deliberately NOT the `q` kernel and NOT a private INSERT string — a second
// renderer is exactly the drift the RelIR spine exists to keep singular.
import { col, compilerText, type Expr } from './rel/expr.ts';
import * as make from './rel/factory.ts';
import { plan } from './rel/plan.ts';
import { insert } from './rel/stmt-factory.ts';
import type { ColMeta, SqlType } from './rel/types.ts';
import { jsonEachSet, meta, minter, typeOf } from './compiler/rel/build.ts';
import { runProgram, type RowSource } from './program.ts';

/** One column of a set-insert target. `jsonb` wraps the cell in `jsonb(<text>)` — the collection /
 *  meta shape, whose JSON TEXT crosses and lets SQLite build the blob (a raw blob bind would diverge
 *  across runtimes; storage.ts). `type` is the column's declared storage class, for the target's
 *  `Scan` schema; the cell's ACTUAL storage class comes from the JSON value either way. */
export interface SetColumn {
  readonly name: string;
  readonly type: SqlType;
  readonly jsonb?: boolean;
  /** A BLOB column whose value crosses the JSON wire as HEX text and is materialized with `unhex()`
   *  (a raw blob bind diverges across runtimes and cannot ride JSON — storage.ts / program.ts). The
   *  gid column (a 16-byte uuid_v7) is the one user. */
  readonly blob?: boolean;
}

/** `json_extract(<row>, '$[i]')` — a landed row's cell by position, the path a compiler constant so the
 *  statement text stays fixed however many rows landed. A `jsonb` column re-wraps the extracted TEXT; a
 *  `blob` column `unhex()`es the extracted hex text into the raw bytes. */
const cellAt = (row: Expr, at: number, col: SetColumn): Expr => {
  const extract: Expr = { kind: 'call', fn: 'json_extract', args: [row, compilerText(`$[${at}]`)] };
  if (col.jsonb) return { kind: 'call', fn: 'jsonb', args: [extract] };
  if (col.blob) return { kind: 'call', fn: 'unhex', args: [extract] };
  return extract;
};

/**
 * Insert `rows` into `table`, one relational statement, one JSON bind. Returns the number of
 * statements issued — 0 for an empty batch, 1 otherwise — so a caller can report whether it batched.
 *
 * Every row must carry one value per column in `columns` order; a ragged row is the caller's bug and
 * would shift the whole tuple silently, so it throws. `columns` names the target's columns positionally
 * — the `Insert` source projects each cell out of the exploded array by index, so the JSON row arrays
 * and `columns` must agree in order and arity.
 */
export function insertSet(
  store: RowSource, table: string, columns: readonly SetColumn[], rows: readonly (readonly unknown[])[],
): number {
  if (!rows.length) return 0;
  for (const row of rows)
    if (row.length !== columns.length)
      throw new Error(`insertSet(${table}): row has ${row.length} values for ${columns.length} columns`);

  const fresh = minter();
  const cols: readonly ColMeta[] = columns.map((c) => meta(c.name, c.type, true));
  // The rows land as ONE json_each relation, its members the row-tuples; the project reads each
  // tuple's cells by position into the target's columns.
  const exploded = jsonEachSet('rows', rows as readonly unknown[], fresh);
  const source = make.project({
    id: fresh('sp'), input: exploded, channels: [], type: typeOf(...cols),
    exprs: columns.map((c, at) => [c.name, cellAt(col(exploded.id, 'sv'), at, c)] as const),
  });
  const target = make.scan({ id: fresh('t'), table: table as never, alias: fresh('wt'), channels: [], type: typeOf(...cols) });
  const stmt = insert({
    target, cols: columns.map((c) => c.name), source, channels: [], type: typeOf(), returning: [],
  });
  const name = 'ins';
  runProgram(store, plan({
    bindings: [{ name, node: stmt }],
    result: make.ref({ id: fresh('r'), name, channels: [], type: stmt.type }),
  }));
  return 1;
}

/**
 * SET-BASED DELETE — remove every row of `table` whose `column` is in `ids`, as ONE statement with
 * ONE JSON bind (`… IN (SELECT value FROM json_each(?))`). Returns statements issued (0 for an empty
 * id set, 1 otherwise).
 *
 * The Delete half of the set-based write substrate, and deliberately a DIRECT fixed-shape statement
 * rather than a RelIR `Delete` program. The RelIR cascade delete (`compiler/rel/write.ts`) takes a
 * membership against a RELATION — a snapshot the plan joins to, which is what preserves a drop's
 * pre-mutation view. A membership against LITERAL ids has no relation to render and no projection to
 * build, so a program adds ceremony and no property; this is the same call the loader's collision
 * read already makes (`bulk.ts` `assertFree`). `json_each` routes each member by its own storage
 * class, so a number matches an INTEGER key and a string a TEXT one, exactly as `V($ids)` does.
 */
export function deleteMembers(store: RowSource, table: string, column: string, ids: readonly unknown[]): number {
  if (!ids.length) return 0;
  store.query(`DELETE FROM ${table} WHERE ${column} IN (SELECT value FROM json_each(?))`, [JSON.stringify([...ids])]);
  return 1;
}

/**
 * SET-BASED UPDATE — write `columns` onto every row of `table` named by its key, as ONE
 * `UPDATE … FROM json_each(?)` with ONE JSON bind. Each `rows` tuple is `[keyValue, col0, col1, …]`:
 * `keyValue` matches `table.keyColumn`, the rest fill `columns` positionally. Returns statements
 * issued (0 for an empty batch, 1 otherwise). Used by the post-write gid/rev refresh (§5·1/§6·1) to
 * write a data-sized batch of freshly-minted gids / recomputed revs back in one statement.
 *
 * The Update half of the set-based write substrate, a DIRECT fixed-shape statement for the same reason
 * `deleteMembers` is: the write is a membership against LITERAL rows, so there is no relation to render
 * and a RelIR program would add ceremony and no property. `json_each` explodes the batch; each cell is
 * `json_extract`ed by position (a `blob` column `unhex()`es hex text → bytes; a `jsonb` column wraps
 * the TEXT in `jsonb()`), the same per-column shaping `insertSet` does. UPDATE…FROM (SQLite ≥3.33),
 * `json_each`, and `unhex` (≥3.41) are all present on both runtimes.
 */
export function updateSet(
  store: RowSource, table: string, keyColumn: string, columns: readonly SetColumn[],
  rows: readonly (readonly unknown[])[],
): number {
  if (!rows.length) return 0;
  for (const row of rows)
    if (row.length !== columns.length + 1)
      throw new Error(`updateSet(${table}): row has ${row.length} values for a key + ${columns.length} columns`);
  const cell = (at: number): string => {
    const extract = `json_extract(u.value, '$[${at}]')`;
    const col = columns[at - 1]!;
    return col.blob ? `unhex(${extract})` : col.jsonb ? `jsonb(${extract})` : extract;
  };
  const assignments = columns.map((c, i) => `${c.name} = ${cell(i + 1)}`).join(', ');
  store.query(
    `UPDATE ${table} SET ${assignments} FROM json_each(?) AS u WHERE ${table}.${keyColumn} = json_extract(u.value, '$[0]')`,
    [JSON.stringify(rows)],
  );
  return 1;
}
