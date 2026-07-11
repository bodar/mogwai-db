// The storage seam. `Sql` is the minimal synchronous SQLite driver that both
// runtimes implement: `bun:sqlite` for dev/Bun and Durable Object
// `ctx.storage.sql` in production. Both are synchronous SQLite and differ only
// in cursor mechanics, so the interface sits at the SQL transport — everything
// above it (schema, label interning, the whole compiler) is runtime-agnostic.
// (Deliberately synchronous, unlike an async D1-style adapter: DO SQL is sync.)
export interface Sql {
  /** Execute a single DDL statement (no bindings, no result). */
  exec(sql: string): void;
  /** Run a query with positional `?` bindings and return all rows. Writes use
   *  `RETURNING` to read back generated ids, so this covers reads and writes. */
  query<T = any>(sql: string, binds?: readonly unknown[]): T[];
}

// One statement per entry: DO `ctx.storage.sql.exec` runs a single statement,
// so we never rely on multi-statement exec.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS labels(
     id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS nodes(
     id INTEGER PRIMARY KEY, label INTEGER NOT NULL REFERENCES labels(id),
     props TEXT NOT NULL DEFAULT '{}')`,
  `CREATE TABLE IF NOT EXISTS edges(
     id INTEGER PRIMARY KEY, src INTEGER NOT NULL, label INTEGER NOT NULL,
     tgt INTEGER NOT NULL, props TEXT NOT NULL DEFAULT '{}')`,
  `CREATE INDEX IF NOT EXISTS n_label ON nodes(label)`,
  `CREATE INDEX IF NOT EXISTS e_out ON edges(src, label, tgt)`,
  `CREATE INDEX IF NOT EXISTS e_in  ON edges(tgt, label, src)`,
];

export class GraphStore {
  constructor(private sql: Sql) {
    for (const statement of SCHEMA) this.sql.exec(statement);
  }

  query<T = any>(sql: string, binds: readonly unknown[] = []): T[] {
    return this.sql.query<T>(sql, binds);
  }

  labelId(name: string): number {
    return this.query<{ id: number }>(
      'INSERT INTO labels(name) VALUES(?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id',
      [name],
    )[0].id;
  }

  labelName(id: number): string {
    return this.query<{ name: string }>('SELECT name FROM labels WHERE id=?', [id])[0].name;
  }
}
