// The storage seam. `Sql` is the minimal synchronous SQLite driver that both
// runtimes implement: `bun:sqlite` for dev/Bun and Durable Object
// `ctx.storage.sql` in production. Both are synchronous SQLite and differ only
// in cursor mechanics, so the interface sits at the SQL transport — everything
// above it (schema, label interning, the whole compiler) is runtime-agnostic.
// (Deliberately synchronous, unlike an async D1-style adapter: DO SQL is sync.)
import { coerceBindValue } from './gremlin/types.ts';
import { type Sql } from './api.ts';
// The `Sql` seam now lives in the API surface (src/api.ts). Re-exported here so the many
// existing `import { Sql } from './storage.ts'` sites keep working.
export type { Sql } from './api.ts';

// One statement per entry: DO `ctx.storage.sql.exec` runs a single statement,
// so we never rely on multi-statement exec.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS labels(
     id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)`,
  // `id` stays the SQLite rowid (integer PK) — the whole covering-index /
  // index-only-scan perf story rides on integer src/tgt joins. `uid` is the
  // optional TinkerPop user-supplied id (string/custom); UNIQUE auto-indexes it
  // for the V(uid) lookup. Elements report COALESCE(uid, id) as their id.
  // `gid` (global identity, §6·1) and `rev` (generation + content hash, §5·1) are the replication
  // deltas (docs/2026-09-02-replication-and-http-interop-plan.md). `gid` is a 16-byte uuid_v7 BLOB,
  // minted once at creation and IMMUTABLE — cross-peer identity, separate from the local rowid, which
  // stays the fast join key. `rev` is a JSONB `{gen, hash}` recomputed on every mutation (the
  // touch-rev-on-write barrier). Both are dedicated columns, not properties: a property row would
  // store the key string on EVERY element plus a second index (double-digit GB at 10^8), and it is
  // more CouchDB-faithful. Nullable so a graph created before this column, and an element not yet
  // touched by the rev barrier, are representable.
  `CREATE TABLE IF NOT EXISTS nodes(
     id INTEGER PRIMARY KEY, uid TEXT UNIQUE, gid BLOB, rev BLOB)`,
  // A vertex's labels are a SET (TinkerPop 4 multi-label), so they normalize out of `nodes`
  // exactly as properties did — the rule being "normalize where cardinality is 0..N, keep
  // inline where it is exactly 1", which is also why an EDGE label stays on `edges` (upstream
  // fixes edge label cardinality at ONE by spec). Two things fall out of the schema rather
  // than out of step logic: PRIMARY KEY(node,label) makes it a set, so re-adding a label a
  // vertex already carries is an INSERT OR IGNORE no-op; and a ZERO-label vertex is simply
  // zero rows, which a NOT NULL column could not represent and a label SET
  // requires. The declared capability is still ONE — see labelCardinality in api.ts — so
  // today every vertex has exactly one row here.
  `CREATE TABLE IF NOT EXISTS vertex_labels(
     node INTEGER NOT NULL REFERENCES nodes(id), label INTEGER NOT NULL REFERENCES labels(id),
     PRIMARY KEY (node, label))`,
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
  // `gid`/`rev` mirror `nodes` (see that comment). An edge's `rev` content hash references its
  // endpoints by `gid` (§6·5), so a replicated edge converges across peers that preserved those gids.
  `CREATE TABLE IF NOT EXISTS edges(
     id INTEGER PRIMARY KEY, uid TEXT UNIQUE, src INTEGER NOT NULL, label INTEGER NOT NULL,
     tgt INTEGER NOT NULL, gid BLOB, rev BLOB)`,
  // Edge properties are ALSO normalized rows (the typed-property-values rework retired
  // the flat JSONB blob): TinkerPop's edge Property has no id/meta/multi, so ONE row per
  // (edge,key) — the UNIQUE constraint enforces that single cardinality and doubles as
  // the (edge,key) lookup index. `value`/`vtype` mirror vertex_properties (untyped value
  // column keeps the storage class, so edge-prop numeric order/range now works too).
  `CREATE TABLE IF NOT EXISTS edge_properties(
     id INTEGER PRIMARY KEY, edge INTEGER NOT NULL REFERENCES edges(id),
     key TEXT NOT NULL, value, vtype TEXT, UNIQUE(edge, key))`,
  // What cardinality a vertex-property key takes when a `property()` DECLARES none. TinkerPop asks
  // the graph this (`Graph.Features.VertexFeatures.getCardinality(key)`) and its javadoc splits
  // providers in two — "implementations that employ a schema can consult it", the rest "return their
  // default Cardinality for every key". The official corpus needs the FIRST kind and cannot be
  // satisfied by the second: `g_addVXanimalX_propertyXname_mateoX...` (@MultiProperties) requires an
  // undeclared repeat write to APPEND, while `g_V_hasXperson_name_aliceX_propertyXsingle_age_...`
  // requires one to REPLACE on a key whose initializer wrote `property(single, "age", 50)`. No single
  // constant answers both.
  //
  // Scoped to (node, key) rather than to the key alone, which is the one deliberate divergence from
  // TinkerPop's signature. Graph-scoped was built first and MEASURED wrong: the conformance runner
  // empties the shared graph with `g.V().drop()`, which clears data and not schema, so one scenario's
  // `property(single, k, ...)` silently changed how a later scenario's undeclared write behaved and
  // the @MultiProperties gain never materialized. Element scope makes the declaration live and die
  // with the element that carries it, and no corpus scenario distinguishes the two.
  //
  // Only an EXPLICIT `property(Cardinality.x, ...)` writes a row here, so the table stays empty for a
  // graph that never names one; an absent row is the graph default (DEFAULT_VERTEX_CARDINALITY,
  // api.ts). Edge properties are absent by construction — TinkerPop's edge `Property` is single by
  // spec, which UNIQUE(edge,key) above already enforces.
  `CREATE TABLE IF NOT EXISTS vertex_property_cardinality(
     node INTEGER NOT NULL REFERENCES nodes(id), key TEXT NOT NULL, cardinality TEXT NOT NULL,
     PRIMARY KEY (node, key))`,
  // Replaces n_label: (label, node) is the seek order hasLabel wants — find the label id,
  // read the node ids off the index without touching `nodes` at all.
  // Global identity is UNIQUE per graph and indexed for the gid→rowid resolution replication/merge
  // does (§6·1). A UNIQUE index over a NULLABLE column admits many NULLs in SQLite, so elements not
  // yet carrying a gid (a pre-column graph, an untouched element) coexist until minted.
  `CREATE UNIQUE INDEX IF NOT EXISTS nodes_gid ON nodes(gid)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS edges_gid ON edges(gid)`,
  `CREATE INDEX IF NOT EXISTS vl_label ON vertex_labels(label, node)`,
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
  // A single FTS5 trigram index over property TEXT, maintained in the write path (see
  // services/fts-index.ts) — the shared substrate for tinker.search and the TextP substring
  // predicates. `text` is the ONLY tokenized column; the rest are UNINDEXED (stored +
  // filterable so search can scope by owner/kind and delete-by-column works). trigram +
  // case_sensitive 0 (the default) makes `text LIKE '%sub%'` index-served AND matches
  // TinkerPop's single-case reference graphs; the tokenizer options live INSIDE the tokenize
  // string (a separate `case_sensitive 0` column option errors — see fts5-trigram-runtime).
  // `pid` is a plain data column, NOT the rowid: a collection property emits one 'value' row
  // plus N 'jsonkey'/'jsonleaf' rows sharing one pid, which would collide on rowid.
  `CREATE VIRTUAL TABLE IF NOT EXISTS property_fts USING fts5(
     owner_elem UNINDEXED, pid UNINDEXED, owner UNINDEXED, pk UNINDEXED, kind UNINDEXED,
     text, tokenize="trigram case_sensitive 0")`,
  // OLAP barrier scratch — the SQL-resident per-node iteration state for the graph-algorithm barriers
  // (pageRank/wcc/peerPressure, and the Tier-2 families landing on the reshape). The vector lives HERE,
  // in SQL, never in JS — each round is one INSERT..SELECT that reads the prior round and writes the
  // next, so only O(1) scalars (teleport, convergence delta) ever cross to the host. Keyed by a
  // per-query `run` token so concurrent queries in ONE Durable Object never collide across the
  // apply→resume await gap; `round` (0/1) holds the alternating cur/next slots. Rows are deleted after
  // the query's decorate tail is framed (precise post-frame GC — `frameResolved`).
  //   `scope`   — the pair/anchor key dimension (GDS: none; ours unifies Brandes source, similarity
  //               pair anchor AND a nested barrier's enclosing-parent id). 0 for a node-keyed algorithm.
  //   `channel` — the named per-node property (GDS Pregel's PregelSchema element): a single-scalar
  //               fixpoint uses channel 0; a multi-channel algorithm (shortest-path dist + predecessor)
  //               declares several. This is GDS's CompositeNodeValue; the single-channel case is its
  //               SingleNodeValue. See docs/archive/2026-08-23-barrier-substrate-reshape-plan.md.
  //   `cval`    — untyped (BLOB affinity), preserving the value's storage class (a REAL score, a TEXT
  //               component id, a JSON array for a set-valued channel), exactly as vertex_properties.value.
  `CREATE TABLE IF NOT EXISTS barrier_run_seq(id INTEGER PRIMARY KEY AUTOINCREMENT)`,
  `CREATE TABLE IF NOT EXISTS barrier_state(
     run INTEGER NOT NULL, round INTEGER NOT NULL, scope INTEGER NOT NULL,
     id INTEGER NOT NULL, channel INTEGER NOT NULL, cval,
     PRIMARY KEY (run, round, scope, id, channel)) WITHOUT ROWID`,
];

export class GraphStore {
  constructor(private sql: Sql) {
    this.initSchema();
    // ORPHANED-RUN SWEEP (the hard-crash belt). `barrier_state` is a RESIDENT scratch table that
    // survives isolate restarts, but a barrier `run` is entirely intra-request and synchronous — so at
    // construction, before this store serves anything, NO run is live and every surviving row is an
    // orphan left by a prior isolate that died mid-request (a hard kill runs no JS `finally`, so neither
    // the drive's drop-on-throw nor the framer's cleanup fired). Clearing it here reclaims them. The
    // in-isolate leak (a chain that throws) is closed precisely by the drive's `dropRuns`.
    this.sql.exec('DELETE FROM barrier_state');
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

  /** Allocate a fresh OLAP-barrier run token (see the `barrier_state` schema note). Atomic per
   *  allocation, and safe under the DO's run-to-completion `apply` because the whole compute — alloc,
   *  seed, every round — is one synchronous span that nothing interleaves. */
  allocBarrierRun(): number {
    return this.query<{ id: number }>('INSERT INTO barrier_run_seq DEFAULT VALUES RETURNING id')[0].id;
  }

  /** Drop a finished barrier run's scratch rows — precise post-frame GC, fired once the decorate tail
   *  has been framed (`frameResolved`). Idempotent: a run with no rows is a no-op. */
  dropBarrierRun(run: number): void {
    this.query('DELETE FROM barrier_state WHERE run = ?', [run]);
  }

  labelId(name: string): number {
    return this.query<{ id: number }>(
      'INSERT INTO labels(name) VALUES(?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id',
      [name],
    )[0].id;
  }

  /** Bind labels to a vertex. `INSERT OR IGNORE` because (node,label) is the primary key,
   *  so re-adding a label the vertex already carries is a no-op — which is exactly
   *  `addLabel()`'s SET semantics, enforced by the schema rather than by the step. */
  addVertexLabels(node: number, names: readonly string[]): void {
    for (const name of names)
      this.query('INSERT OR IGNORE INTO vertex_labels(node, label) VALUES(?, ?)', [node, this.labelId(name)]);
  }

  /** Remove labels from a vertex — `names` for `dropLabel(…)`, or NULL for `dropLabels()`,
   *  which removes them all. A name the vertex does not carry is a no-op, matching
   *  `dropLabel(nonExistent)`; the CARDINALITY floor is the caller's check, not this one's,
   *  because only the caller knows which step to name in the error. */
  dropVertexLabels(node: number, names: readonly string[] | null): void {
    if (names === null) { this.query('DELETE FROM vertex_labels WHERE node=?', [node]); return; }
    for (const name of names)
      this.query('DELETE FROM vertex_labels WHERE node=? AND label=(SELECT id FROM labels WHERE name=?)', [node, name]);
  }

  /** A vertex's labels, in the same deterministic order the SQL reader picks from
   *  (`ORDER BY label`), so the write path's framing agrees with the read path's. */
  vertexLabels(node: number): string[] {
    return this.query<{ name: string }>(
      'SELECT l.name AS name FROM vertex_labels vl JOIN labels l ON l.id=vl.label WHERE vl.node=? ORDER BY vl.label',
      [node],
    ).map((r) => r.name);
  }

  labelName(id: number): string {
    return this.query<{ name: string }>('SELECT name FROM labels WHERE id=?', [id])[0].name;
  }
}

