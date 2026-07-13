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
  /** Release the underlying handle, if any. Bun closes its `bun:sqlite`
   *  Database (so a file-backed graph can then be unlinked); the Durable Object
   *  adapter owns no releasable handle (teardown there is `ctx.storage.deleteAll`),
   *  so it omits this. Optional at the seam because only Bun's registry needs it. */
  close?(): void;
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
     id INTEGER PRIMARY KEY, uid TEXT UNIQUE, label INTEGER NOT NULL REFERENCES labels(id))`,
  // Vertex properties are normalized (W4): one row per VertexProperty instance, so a
  // key may repeat (multi-property, Cardinality.list/set). `id` (rowid) IS the
  // VertexProperty id. `value` has NO declared type → BLOB affinity keeps whatever
  // SQLite storage class the bound value already has (INTEGER/REAL/TEXT), so numeric
  // order/range (has('age',gt(30)), order().by('age')) stay correct. `meta` is a JSONB
  // {metaKey: scalar} blob (meta-properties), nullable. Edges keep a FLAT JSONB props
  // column — TinkerPop's edge Property has no id/meta/multi, so no table is warranted.
  `CREATE TABLE IF NOT EXISTS vertex_properties(
     id INTEGER PRIMARY KEY, node INTEGER NOT NULL REFERENCES nodes(id),
     key TEXT NOT NULL, value, meta BLOB)`,
  `CREATE TABLE IF NOT EXISTS edges(
     id INTEGER PRIMARY KEY, uid TEXT UNIQUE, src INTEGER NOT NULL, label INTEGER NOT NULL,
     tgt INTEGER NOT NULL, props BLOB NOT NULL DEFAULT (jsonb('{}')))`,
  `CREATE INDEX IF NOT EXISTS n_label ON nodes(label)`,
  `CREATE INDEX IF NOT EXISTS e_out ON edges(src, label, tgt)`,
  `CREATE INDEX IF NOT EXISTS e_in  ON edges(tgt, label, src)`,
  // Static covering indexes replace the old self-tuning per-key expression index on
  // nodes.props: (key,value) serves a leading has(key,val); (node,key) serves the
  // given-a-node prop lookups (values()/has()/order/group + leaf materialization).
  `CREATE INDEX IF NOT EXISTS vp_key_value ON vertex_properties(key, value)`,
  `CREATE INDEX IF NOT EXISTS vp_node_key  ON vertex_properties(node, key)`,
];

export class GraphStore {
  constructor(private sql: Sql) {
    this.initSchema();
  }

  /** Run the schema DDL (idempotent — every statement is `IF NOT EXISTS`). Called
   *  once from the ctor, and again by a Durable Object after `ctx.storage.deleteAll()`
   *  wipes the tables out from under a still-live instance, to restore it to a fresh
   *  empty graph. */
  initSchema(): void {
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

function coerceBind(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  return value;
}
