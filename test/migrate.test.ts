// The schema-version + migration runner (`src/migrate.ts`) — the one path every store open takes, on all
// three SQLite hosts. Each case runs on bun:sqlite AND under `CfLimitedSql` (the DO's statement walls),
// and the runner may touch nothing a DO's SQLite refuses: the version is a one-row table, never
// `PRAGMA user_version` (SQLITE_AUTH on a DO), which the `noUserVersion` driver below enforces.
import { describe, expect, mock, test } from 'bun:test';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { CfLimitedSql } from '../src/cf-limits.ts';
import { GraphStore, type Sql } from '../src/storage.ts';
import { ReplicatorStore } from '../src/replicator-registry.ts';
import { migrate, rowidChunk, SchemaTooNew, type Migration, type SchemaPlan } from '../src/migrate.ts';
import { rpcUnwrap } from '../src/rpc.ts';

/** A driver that records every statement and refuses what a Durable Object's SQLite refuses here. */
class Recording implements Sql {
  readonly statements: string[] = [];
  constructor(private inner: Sql) {}
  private see(sql: string): void {
    if (/user_version/i.test(sql)) throw new Error('not authorized: SQLITE_AUTH');
    this.statements.push(sql);
  }
  exec(sql: string): void { this.see(sql); this.inner.exec(sql); }
  query<T = any>(sql: string, binds: readonly unknown[] = []): T[] { this.see(sql); return this.inner.query<T>(sql, binds); }
  atomically<T>(fn: () => T): T { return this.inner.atomically ? this.inner.atomically(fn) : fn(); }
  close(): void { this.inner.close?.(); }
}

const DRIVERS: [string, (bun: BunSqlite) => Sql][] = [
  ['bun:sqlite', (bun) => bun],
  ['CfLimitedSql', (bun) => new CfLimitedSql(bun)],
];

const version = (sql: Sql, table = 'schema_version') =>
  sql.query<{ version: number; resume_after: number | null }>(`SELECT version, resume_after FROM ${table}`);

/** The `property_fts` shape every graph had before the signed-rowid key (migration 1's input). */
const legacyGraph = (sql: Sql): void => {
  sql.exec('CREATE TABLE nodes(id INTEGER PRIMARY KEY, uid TEXT UNIQUE, gid BLOB, rev BLOB, seq INTEGER, dirty INTEGER NOT NULL DEFAULT 1)');
  sql.exec(`CREATE VIRTUAL TABLE property_fts USING fts5(
    owner_elem UNINDEXED, pid UNINDEXED, owner UNINDEXED, pk UNINDEXED, kind UNINDEXED,
    text, tokenize="trigram case_sensitive 0")`);
  sql.exec(`INSERT INTO property_fts(owner_elem, pid, owner, pk, kind, text) VALUES
    ('node', 7, 1, 'name', 'value', 'marko'), ('edge', 9, 3, 'note', 'value', 'pals'), ('node', 7, 1, 'name', 'jsonleaf', 'x')`);
};

/** Wipe every table, as a DO's `ctx.storage.deleteAll()` does under a live instance. */
const deleteAll = (sql: Sql): void => {
  for (const { name } of sql.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'property_fts_%'"))
    sql.exec(`DROP TABLE IF EXISTS "${name}"`);
};

for (const [driver, wrap] of DRIVERS) describe(`GraphStore schema version (${driver})`, () => {
  test('a fresh store is stamped at the latest version and runs no migration', () => {
    const sql = new Recording(wrap(new BunSqlite(':memory:')));
    new GraphStore(sql);
    expect(version(sql)).toEqual([{ version: 1, resume_after: null }]);
    expect(sql.statements.filter((s) => /pragma_table_info|RENAME|property_fts_v1/.test(s))).toEqual([]);
  });

  test('a legacy store migrates: the FTS index is rebuilt by signed rowid and the store stamped', () => {
    const sql = new Recording(wrap(new BunSqlite(':memory:')));
    legacyGraph(sql);
    const store = new GraphStore(sql);
    expect(version(sql)).toEqual([{ version: 1, resume_after: null }]);
    expect(store.query('SELECT rowid, owner_elem, pid, text FROM property_fts ORDER BY rowid')).toEqual([
      { rowid: -9, owner_elem: 'edge', pid: 9, text: 'pals' }, { rowid: 7, owner_elem: 'node', pid: 7, text: 'marko' },
    ]);
  });

  test('a second open of a current store runs no migration', () => {
    const bun = new BunSqlite(':memory:');
    legacyGraph(bun);
    new GraphStore(wrap(bun));
    const again = new Recording(wrap(bun));
    new GraphStore(again);
    expect(version(again)).toEqual([{ version: 1, resume_after: null }]);
    expect(again.statements.filter((s) => /pragma_table_info|RENAME|property_fts_v1|UPDATE schema_version/.test(s))).toEqual([]);
  });

  test('a store a newer server wrote is refused, naming both versions', () => {
    const bun = new BunSqlite(':memory:');
    new GraphStore(wrap(bun));
    bun.query('UPDATE schema_version SET version = 999');
    expect(() => new GraphStore(wrap(bun))).toThrow(SchemaTooNew);
    expect(() => new GraphStore(wrap(bun))).toThrow(/schema is version 999, and this server understands versions up to 1/);
  });

  test('after deleteAll, initSchema reopens the store as fresh and re-stamps it', () => {
    const sql = wrap(new BunSqlite(':memory:'));
    const store = new GraphStore(sql);
    store.query("INSERT INTO nodes(uid) VALUES ('x')");
    deleteAll(sql);
    store.initSchema();
    expect(version(sql)).toEqual([{ version: 1, resume_after: null }]);
    expect(store.query('SELECT count(*) AS n FROM nodes')).toEqual([{ n: 0 }]);
  });
});

// The runner itself, over a plan of its own — what no shipped migration exercises yet.
const toyPlan = (migrations: Migration[]): SchemaPlan => ({
  versionTable: 'toy_version', probeTables: ['items'],
  schema: ['CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, v TEXT NOT NULL)'], migrations,
});
const atomic = (sql: Sql) => <T>(fn: () => T): T => (sql.atomically ? sql.atomically(fn) : fn());
const seedItems = (sql: Sql, ids: number[]): void => {
  sql.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  sql.query(`INSERT INTO items(id, v) SELECT value, 'a' FROM json_each(?)`, [JSON.stringify(ids)]);
};
/** An idempotent row rewrite — `a` → `a!` once, by its own filter — applied as keyset chunks. */
const bang = (calls: number[], failOnCall = -1): Migration => ({
  id: 'bang', why: 'test',
  resumable: {
    limit: 2,
    chunk: rowidChunk('items', (sql, lo, hi) => {
      calls.push(lo);
      if (calls.length === failOnCall) throw new Error('isolate died');
      sql.query("UPDATE items SET v = v || '!' WHERE rowid > ? AND rowid <= ? AND v NOT LIKE '%!'", [lo, hi]);
    }),
  },
});

for (const [driver, wrap] of DRIVERS) describe(`the migration runner (${driver})`, () => {
  test('a throw mid-migration leaves the data and the version unchanged', () => {
    const sql = wrap(new BunSqlite(':memory:'));
    seedItems(sql, [1, 2]);
    const ok: Migration = { id: 'one', why: 'test', run: (s) => s.query("UPDATE items SET v = 'one'") };
    const boom: Migration = { id: 'two', why: 'test', run: (s) => { s.query("UPDATE items SET v = 'two'"); throw new Error('boom'); } };
    expect(() => migrate(sql, atomic(sql), toyPlan([ok, boom]), 'toy')).toThrow('boom');
    expect(version(sql, 'toy_version')).toEqual([{ version: 1, resume_after: null }]);
    expect(sql.query('SELECT DISTINCT v FROM items')).toEqual([{ v: 'one' }]);
    // Fixed, the next open applies only what is still pending.
    const fixed: Migration = { id: 'two', why: 'test', run: (s) => s.query("UPDATE items SET v = v || '+two'") };
    expect(migrate(sql, atomic(sql), toyPlan([ok, fixed]), 'toy')).toEqual({ from: 1, to: 2, applied: ['two'] });
    expect(sql.query('SELECT DISTINCT v FROM items')).toEqual([{ v: 'one+two' }]);
  });

  test('a resumable migration interrupted after a chunk resumes after it and stamps once finished', () => {
    const sql = wrap(new BunSqlite(':memory:'));
    seedItems(sql, [-3, 1, 2, 5, 8, 9, 12]);
    const first: number[] = [];
    expect(() => migrate(sql, atomic(sql), toyPlan([bang(first, 3)]), 'toy')).toThrow('isolate died');
    // Two chunks committed (four rows, the negative rowid included), with their cursor; no version yet.
    expect(version(sql, 'toy_version')).toEqual([{ version: 0, resume_after: 5 }]);
    expect(sql.query("SELECT id FROM items WHERE v = 'a!' ORDER BY id").map((r: any) => r.id)).toEqual([-3, 1, 2, 5]);
    const second: number[] = [];
    expect(migrate(sql, atomic(sql), toyPlan([bang(second)]), 'toy')).toEqual({ from: 0, to: 1, applied: ['bang'] });
    expect(second).toEqual([5, 9]); // resumed after the last committed chunk, not from the start
    expect(version(sql, 'toy_version')).toEqual([{ version: 1, resume_after: null }]);
    expect(sql.query('SELECT DISTINCT v FROM items')).toEqual([{ v: 'a!' }]);
    // Current now: a third open runs nothing.
    const third: number[] = [];
    expect(migrate(sql, atomic(sql), toyPlan([bang(third)]), 'toy').applied).toEqual([]);
    expect(third).toEqual([]);
  });

  test('a fresh toy store skips its migrations; an empty legacy table migrates in zero chunks', () => {
    const fresh = wrap(new BunSqlite(':memory:'));
    expect(migrate(fresh, atomic(fresh), toyPlan([bang([])]), 'toy')).toEqual({ from: 'fresh', to: 1, applied: [] });
    const empty = wrap(new BunSqlite(':memory:'));
    seedItems(empty, []);
    const calls: number[] = [];
    expect(migrate(empty, atomic(empty), toyPlan([bang(calls)]), 'toy')).toEqual({ from: 0, to: 1, applied: ['bang'] });
    expect(calls).toEqual([]);
  });
});

for (const [driver, wrap] of DRIVERS) describe(`ReplicatorStore through the same runner (${driver})`, () => {
  test('a legacy registry without `history`/`placement` is migrated and stamped', () => {
    const sql = new Recording(wrap(new BunSqlite(':memory:')));
    sql.exec(`CREATE TABLE replication_config(id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL,
      continuous INTEGER NOT NULL DEFAULT 0, create_target INTEGER NOT NULL DEFAULT 0, filter TEXT,
      checkpoint_interval INTEGER, use_checkpoints INTEGER NOT NULL DEFAULT 1)`);
    sql.exec(`CREATE TABLE replication_job(config_id TEXT PRIMARY KEY, replication_id TEXT, state TEXT NOT NULL,
      error_count INTEGER NOT NULL DEFAULT 0, info TEXT, last_updated INTEGER, start_time INTEGER, next_run INTEGER, lease_until INTEGER)`);
    const store = new ReplicatorStore(sql);
    expect(version(sql, 'registry_schema_version')).toEqual([{ version: 2, resume_after: null }]);
    store.putConfig({ id: 'j', source: 'a', target: 'b', placement: 'g.V()' });
    expect(store.getConfig('j')?.placement).toBe('g.V()');
    const reopened = new Recording(sql);
    new ReplicatorStore(reopened);
    expect(reopened.statements.filter((s) => /ALTER|table_info/.test(s))).toEqual([]);
  });

  test('a fresh registry is stamped with no migration; a too-new one is refused', () => {
    const bun = new BunSqlite(':memory:');
    const sql = new Recording(wrap(bun));
    new ReplicatorStore(sql);
    expect(version(sql, 'registry_schema_version')).toEqual([{ version: 2, resume_after: null }]);
    expect(sql.statements.filter((s) => /ALTER|table_info/.test(s))).toEqual([]);
    bun.query('UPDATE registry_schema_version SET version = 7');
    expect(() => new ReplicatorStore(wrap(bun))).toThrow(/replication registry .*version 7.* up to 2/);
  });
});

// The Durable Object path: a too-new graph must not throw from the DO constructor (workerd counts that as
// an uncaught exception); the refusal reaches the caller as an RPC VALUE, and `destroy()` is the way out.
describe('GraphDatabase (Durable Object) with a too-new store', () => {
  mock.module('cloudflare:workers', () => ({
    DurableObject: class { constructor(readonly ctx: unknown, readonly env: unknown) {} },
  }));

  const fakeCtx = (bun: BunSqlite) => ({
    storage: {
      sql: { exec: (sql: string, ...binds: unknown[]) => { const rows = bun.query(sql, binds); return { toArray: () => rows }; } },
      transactionSync: <T>(fn: () => T): T => bun.atomically(fn),
      deleteAll: async () => deleteAll(bun),
    },
  });

  test('the refusal crosses the RPC boundary as a value, and destroy() reopens a fresh graph', async () => {
    const { GraphDatabase } = await import('../src/cloudflare/graph-store-do.ts');
    const bun = new BunSqlite(':memory:');
    new GraphStore(bun);
    bun.query('UPDATE schema_version SET version = 999');
    const db = new (GraphDatabase as any)(fakeCtx(bun), {}); // must not throw
    const refused = await db.framed('g.V().count()', {});
    expect(refused.__rpcError).toMatch(/version 999.*up to 1/);
    expect(() => rpcUnwrap(refused)).toThrow(/version 999/);
    await db.destroy();
    const after = await db.framed('g.V().count()', {});
    expect(after).not.toHaveProperty('__rpcError');
    expect(version(bun)).toEqual([{ version: 1, resume_after: null }]);
  });
});
