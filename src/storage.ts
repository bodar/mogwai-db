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
  // `id` stays the SQLite rowid (integer PK) — the whole covering-index /
  // index-only-scan perf story rides on integer src/tgt joins. `uid` is the
  // optional TinkerPop user-supplied id (string/custom); UNIQUE auto-indexes it
  // for the V(uid) lookup. Elements report COALESCE(uid, id) as their id.
  `CREATE TABLE IF NOT EXISTS nodes(
     id INTEGER PRIMARY KEY, uid TEXT UNIQUE, label INTEGER NOT NULL REFERENCES labels(id),
     props TEXT NOT NULL DEFAULT '{}')`,
  `CREATE TABLE IF NOT EXISTS edges(
     id INTEGER PRIMARY KEY, uid TEXT UNIQUE, src INTEGER NOT NULL, label INTEGER NOT NULL,
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
    // Normalize bind types at the one seam both runtimes cross. bun:sqlite
    // accepts boolean/bigint binds; DO ctx.storage.sql (SqlStorageValue =
    // ArrayBuffer|string|number|null) throws on them. Coerce here so a
    // traversal like has('sold', true) behaves identically on both — and
    // matches bun:sqlite's own boolean→1/0 coercion, so results are unchanged.
    return this.sql.query<T>(sql, binds.map(coerceBind));
  }

  // Property keys that already have (or don't need) an expression index this
  // isolate's lifetime — avoids re-issuing CREATE INDEX IF NOT EXISTS per query.
  private indexed = new Set<string>();

  /**
   * Ensure an on-demand expression index exists for a hot property key, so
   * `has(key,…)`/`order().by(key)` become index seeks instead of full scans.
   * The key is an identifier the compiler already validated as index-safe (it
   * only asks for keys it spliced literally); guard again defensively since we
   * build the index name and JSON path from it. First call on a cold key pays
   * the one-time build; later calls (and warm isolates) short-circuit.
   */
  ensureNodePropIndex(key: string): void {
    if (this.indexed.has(key)) return;
    if (!SAFE_KEY.test(key)) return; // never splice a non-identifier
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS "n_prop_${key}" ON nodes(json_extract(props, '$.${key}'))`,
    );
    this.indexed.add(key);
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

// Identifier keys only — must match the compiler's SAFE_KEY so we index exactly
// the keys it splices as literal JSON paths.
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function coerceBind(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  return value;
}
