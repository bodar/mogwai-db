// ---------- the replicator registry — the control-plane store for ongoing replication ----------
//
// docs/2026-09-02-replication-and-http-interop-plan.md §9/§9·2. Ongoing replication is a persistent,
// standalone job — `{source, target, continuous, …}`, both endpoints graph refs (a local id or a remote
// http(s) URL), neither "the current graph" — run by a WORKER-residency scheduler (§9, Phase 5c), NOT by a
// DO alarm. The scheduler enumerates due jobs from HERE, so the registry is a SINGLETON control-plane store,
// separate from any graph: on Cloudflare a singleton DO, on Bun/browser native sqlite, all behind the async
// `ReplicatorRegistry` seam. It is a DATA STORE ONLY — it never runs a replication (that is the worker's
// job) — and it is not dogfooded as a graph (control-plane metadata is tiny/local/churny and must not be
// replicated, exactly as CouchDB excludes `_replicator`/`_local`).
//
// This mirrors the graph seam: a synchronous `ReplicatorStore` over the `Sql` transport holds the store-tier
// logic (reused verbatim by the CF DO and by Bun), and the async `ReplicatorRegistry` is the seam the router
// and scheduler call — the CF backend forwards over DO RPC (async), Bun/browser wrap the sync store in
// no-op promises (`storeRegistry`).

import type { Sql } from './api.ts';

/** A persistent replication job (CouchDB's `_replicator` document — §9·2). `source`/`target` are graph refs
 *  (a local graph id, or a remote `http(s)` graph URL); exactly one direction is remote, as with the one-shot
 *  `_replicate`. Booleans are stored as 0/1 (DO-safe — no boolean bind). `filter` holds a captured selector
 *  for filtered replication (deferred build, §11). `checkpointInterval` is the continuous poll period (ms). */
export interface ReplicationConfig {
  id: string;
  source: string;
  target: string;
  continuous?: boolean;
  createTarget?: boolean;
  filter?: string | null;
  checkpointInterval?: number | null;
  useCheckpoints?: boolean;
}

// One statement per entry (DO `exec` runs a single statement). Columns are CouchDB-named, SQL-formatted
// (snake_case), per §9·2. `replication_job` (scheduler state) is added in Phase 5c.
const REGISTRY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS replication_config(
     id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL,
     continuous INTEGER NOT NULL DEFAULT 0, create_target INTEGER NOT NULL DEFAULT 0,
     filter TEXT, checkpoint_interval INTEGER, use_checkpoints INTEGER NOT NULL DEFAULT 1)`,
];

interface ConfigRow {
  id: string; source: string; target: string; continuous: number; create_target: number;
  filter: string | null; checkpoint_interval: number | null; use_checkpoints: number;
}

const rowToConfig = (r: ConfigRow): ReplicationConfig => ({
  id: r.id, source: r.source, target: r.target,
  continuous: !!r.continuous, createTarget: !!r.create_target,
  filter: r.filter, checkpointInterval: r.checkpoint_interval, useCheckpoints: !!r.use_checkpoints,
});

const COLS = 'id, source, target, continuous, create_target, filter, checkpoint_interval, use_checkpoints';

/** The synchronous store-tier for the registry — the same logic the CF DO runs internally and Bun runs
 *  in-process. Owns its own schema over the `Sql` transport (a dedicated control-plane sqlite, never a
 *  graph). Only 0/1 numbers, strings, and null are bound, so no runtime-divergent bind coercion is needed. */
export class ReplicatorStore {
  constructor(private sql: Sql) {
    for (const statement of REGISTRY_SCHEMA) this.sql.exec(statement);
  }

  /** Upsert a job by id (create or replace) — idempotent, so a PUT of the same doc is a no-op change. */
  putConfig(c: ReplicationConfig): void {
    this.sql.query(
      `INSERT INTO replication_config(${COLS}) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET source = excluded.source, target = excluded.target,
         continuous = excluded.continuous, create_target = excluded.create_target, filter = excluded.filter,
         checkpoint_interval = excluded.checkpoint_interval, use_checkpoints = excluded.use_checkpoints`,
      [c.id, c.source, c.target, c.continuous ? 1 : 0, c.createTarget ? 1 : 0,
        c.filter ?? null, c.checkpointInterval ?? null, c.useCheckpoints === false ? 0 : 1]);
  }

  getConfig(id: string): ReplicationConfig | null {
    const r = this.sql.query<ConfigRow>(`SELECT ${COLS} FROM replication_config WHERE id = ?`, [id])[0];
    return r ? rowToConfig(r) : null;
  }

  listConfigs(): ReplicationConfig[] {
    return this.sql.query<ConfigRow>(`SELECT ${COLS} FROM replication_config ORDER BY id`).map(rowToConfig);
  }

  /** Delete by id; returns whether a job existed (so the router can 404 a delete of nothing if it wants —
   *  though DELETE is idempotent, matching the graph-lifecycle verbs). `RETURNING` gives the affected count
   *  in one statement (both runtimes support it). */
  deleteConfig(id: string): boolean {
    return this.sql.query('DELETE FROM replication_config WHERE id = ? RETURNING id', [id]).length > 0;
  }
}

/** The async seam the router + scheduler call. The CF backend forwards to the singleton registry DO (async
 *  RPC); Bun/browser use {@link storeRegistry} over a local {@link ReplicatorStore}. Kept minimal for Phase
 *  5b (config CRUD); Phase 5c adds the scheduler's job-state + claim methods. */
export interface ReplicatorRegistry {
  putConfig(config: ReplicationConfig): Promise<void>;
  getConfig(id: string): Promise<ReplicationConfig | null>;
  listConfigs(): Promise<readonly ReplicationConfig[]>;
  deleteConfig(id: string): Promise<boolean>;
}

/** Wrap a synchronous {@link ReplicatorStore} as the async {@link ReplicatorRegistry} — the Bun/browser
 *  backend (sync sqlite in no-op promises, exactly like `BunGraphManager` wraps `GraphStore`). The CF
 *  backend does not use this: it forwards to the DO, which itself holds a `ReplicatorStore`. */
export function storeRegistry(store: ReplicatorStore): ReplicatorRegistry {
  return {
    putConfig: async (config) => store.putConfig(config),
    getConfig: async (id) => store.getConfig(id),
    listConfigs: async () => store.listConfigs(),
    deleteConfig: async (id) => store.deleteConfig(id),
  };
}

/** A fresh job id when a client POSTs a config without one (CouchDB allows a user-defined `_id` or a
 *  generated one). `crypto.randomUUID` is present on all three runtimes. */
export const newConfigId = (): string => crypto.randomUUID();
