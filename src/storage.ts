// The storage seam. `Sql` is the minimal synchronous SQLite driver that both
// runtimes implement: `bun:sqlite` for dev/Bun and Durable Object
// `ctx.storage.sql` in production. Both are synchronous SQLite and differ only
// in cursor mechanics, so the interface sits at the SQL transport — everything
// above it (schema, label interning, the whole compiler) is runtime-agnostic.
// (Deliberately synchronous, unlike an async D1-style adapter: DO SQL is sync.)
import { coerceBindValue } from './gremlin-types.ts';

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
  // order/range (has('age',gt(30)), order().by('age')) stay correct. `vtype` is the
  // canonical Gremlin type the write channel carried (wire DataType / parsed literal
  // subtype), nullable (NULL = infer from storage class, the legacy/raw-insert path) —
  // it is what lets typeOf and per-row framing recover byte-vs-long, datetime-vs-long,
  // uuid-vs-string, and collection values (see gremlin-types.ts). A collection value
  // (list/map/set) is stored as JSONB here — a self-describing typed tree (`ValueNode`):
  // vtype names the OUTER shape, and every NESTED element/key/value carries its own {t,v}
  // type tag, so list/set/map ELEMENTS + typed/non-string KEYS + arbitrary nesting round-trip
  // with each leaf's exact gremlin type (gremlin-types.ts valueNodeOf; framed via
  // execute.ts frameTypedNode). `meta` is a JSONB {metaKey: scalar} blob, nullable.
  `CREATE TABLE IF NOT EXISTS vertex_properties(
     id INTEGER PRIMARY KEY, node INTEGER NOT NULL REFERENCES nodes(id),
     key TEXT NOT NULL, value, vtype TEXT, meta BLOB)`,
  `CREATE TABLE IF NOT EXISTS edges(
     id INTEGER PRIMARY KEY, uid TEXT UNIQUE, src INTEGER NOT NULL, label INTEGER NOT NULL,
     tgt INTEGER NOT NULL)`,
  // Edge properties are ALSO normalized rows (the typed-property-values rework retired
  // the flat JSONB blob): TinkerPop's edge Property has no id/meta/multi, so ONE row per
  // (edge,key) — the UNIQUE constraint enforces that single cardinality and doubles as
  // the (edge,key) lookup index. `value`/`vtype` mirror vertex_properties (untyped value
  // column keeps the storage class, so edge-prop numeric order/range now works too).
  `CREATE TABLE IF NOT EXISTS edge_properties(
     id INTEGER PRIMARY KEY, edge INTEGER NOT NULL REFERENCES edges(id),
     key TEXT NOT NULL, value, vtype TEXT, UNIQUE(edge, key))`,
  `CREATE INDEX IF NOT EXISTS n_label ON nodes(label)`,
  `CREATE INDEX IF NOT EXISTS e_out ON edges(src, label, tgt)`,
  `CREATE INDEX IF NOT EXISTS e_in  ON edges(tgt, label, src)`,
  // Static covering indexes replace the old self-tuning per-key expression index on
  // nodes.props: (key,value) serves a leading has(key,val); (node,key) serves the
  // given-a-node prop lookups (values()/has()/order/group + leaf materialization). The
  // edge (edge,key) lookup rides the UNIQUE(edge,key) constraint's implicit index;
  // ep_key_value mirrors vp_key_value for a leading has(edgeKey,val) seek.
  `CREATE INDEX IF NOT EXISTS vp_key_value ON vertex_properties(key, value)`,
  `CREATE INDEX IF NOT EXISTS vp_node_key  ON vertex_properties(node, key)`,
  `CREATE INDEX IF NOT EXISTS ep_key_value ON edge_properties(key, value)`,
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
    // Normalize bind types at the one seam both runtimes cross (coerceBindValue,
    // gremlin-types). bun:sqlite accepts boolean/bigint; DO ctx.storage.sql
    // (SqlStorageValue = ArrayBuffer|string|number|null) throws on them AND loses
    // precision past 2^53. coerceBindValue makes every bind lossless: boolean→1/0,
    // in-range bigint→number, big bigint / BigDecimal / Duration → canonical decimal
    // text. So has('sold', true) and an exact 64-bit id behave identically on both.
    return this.sql.query<T>(sql, binds.map(coerceBindValue));
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

