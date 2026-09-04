// ---------- the replicator registry — the control-plane store for ongoing replication ----------
//
// docs/archive/2026-09-02-replication-and-http-interop-plan.md §9/§9·2. Ongoing replication is a persistent,
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
  /** The optional target-side placement traversal (filtered-replication-plan §3/F2): a full Gremlin
   *  traversal grafting the current match set into pre-existing target structure, referencing the matched
   *  vertices by a `matchedIds` bind, e.g. `g.V(matchedIds).mergeE([label:'inbox_holds', from: V('inbox')])`.
   *  Run each pass over the current match set, idempotently. Absent → the subgraph just lands, unattached. */
  placement?: string | null;
  checkpointInterval?: number | null;
  useCheckpoints?: boolean;
}

/** One past replication session (CouchDB's `history` entry, §9·2): when it ran and its stats or error. */
export interface SessionRecord {
  time: number;
  info: unknown;
}

/** Scheduler state for a job (CouchDB `_scheduler/docs`+`jobs`, §9·2). `state` is CouchDB's vocabulary
 *  (`initializing`/`running`/`pending`/`crashing`/`completed`/`failed`); `nextRun` is when it is next due
 *  (ms); `info` the last run's stats or error; `history` the recent sessions (newest first, bounded). The
 *  claim lease is internal (not surfaced here). */
export interface ReplicationJob {
  configId: string;
  replicationId: string | null;
  state: string;
  errorCount: number;
  info: unknown;
  lastUpdated: number | null;
  startTime: number | null;
  nextRun: number | null;
  history: SessionRecord[];
}

/** How many past sessions a job keeps (CouchDB bounds its `history` too). */
const HISTORY_CAP = 20;

/** How a run finished, written back by the scheduler (releasing the lease). `nextRun` null ⇒ terminal
 *  (a completed one-shot); a number ⇒ when to run again (continuous poll, or promptly to drain more). */
export interface JobResult {
  state: string;
  nextRun: number | null;
  info: unknown;
  lastUpdated: number;
}

// One statement per entry (DO `exec` runs a single statement). Columns are CouchDB-named, SQL-formatted
// (snake_case), per §9·2.
const REGISTRY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS replication_config(
     id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL,
     continuous INTEGER NOT NULL DEFAULT 0, create_target INTEGER NOT NULL DEFAULT 0,
     filter TEXT, placement TEXT, checkpoint_interval INTEGER, use_checkpoints INTEGER NOT NULL DEFAULT 1)`,
  // Scheduler state, one row per config (CouchDB `_scheduler/docs`+`jobs`, §9·2). `state` uses CouchDB's
  // vocabulary. `next_run` is when the worker-residency scheduler should next run this job (ms); `lease_until`
  // is the CLAIM lease (ms) — a runner claims a due job by setting it, and another overlapping runner skips a
  // job whose lease is still in the future, so a job is never double-run (CouchDB's "one job at a time"); a
  // stale lease (past `now`) is reclaimable (crash recovery). `info` is a JSON blob of the last run's stats
  // or error. The registry is a DATA STORE — it never runs a job; the worker does.
  `CREATE TABLE IF NOT EXISTS replication_job(
     config_id TEXT PRIMARY KEY, replication_id TEXT, state TEXT NOT NULL, error_count INTEGER NOT NULL DEFAULT 0,
     info TEXT, last_updated INTEGER, start_time INTEGER, next_run INTEGER, lease_until INTEGER, history TEXT)`,
  // A scheduled job's resume cursor (§9·2) — kept HERE (the scheduler's durable state), keyed by the job's
  // replication id, distinct from the per-graph `replication_checkpoint` the one-shot `_replicate` uses.
  `CREATE TABLE IF NOT EXISTS replication_checkpoint(
     replication_id TEXT PRIMARY KEY, source_last_seq INTEGER NOT NULL)`,
];

interface ConfigRow {
  id: string; source: string; target: string; continuous: number; create_target: number;
  filter: string | null; placement: string | null; checkpoint_interval: number | null; use_checkpoints: number;
}

const rowToConfig = (r: ConfigRow): ReplicationConfig => ({
  id: r.id, source: r.source, target: r.target,
  continuous: !!r.continuous, createTarget: !!r.create_target,
  filter: r.filter, placement: r.placement, checkpointInterval: r.checkpoint_interval, useCheckpoints: !!r.use_checkpoints,
});

const COLS = 'id, source, target, continuous, create_target, filter, placement, checkpoint_interval, use_checkpoints';

/** The synchronous store-tier for the registry — the same logic the CF DO runs internally and Bun runs
 *  in-process. Owns its own schema over the `Sql` transport (a dedicated control-plane sqlite, never a
 *  graph). Only 0/1 numbers, strings, and null are bound, so no runtime-divergent bind coercion is needed. */
export class ReplicatorStore {
  constructor(private sql: Sql) {
    for (const statement of REGISTRY_SCHEMA) this.sql.exec(statement);
    // Column migrations for an EXISTING registry. Unlike a graph DO (a fresh id per graph, so its schema is
    // always current), the registry is a SINGLETON that persists across schema changes — and `CREATE TABLE
    // IF NOT EXISTS` never adds a column to a table that already exists. So each column added after the first
    // release is applied idempotently here: an add is skipped when the column is already present. Append new
    // columns to this list, never edit the CREATE above for them.
    this.ensureColumn('replication_job', 'history', 'history TEXT');
    this.ensureColumn('replication_config', 'placement', 'placement TEXT'); // filtered-replication-plan §8/F2
  }

  /** Add `column` (`decl` = its full DDL, e.g. `"history TEXT"`) to `table` if it is not already present —
   *  an idempotent `ALTER TABLE … ADD COLUMN` (SQLite has no `IF NOT EXISTS` for it). */
  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.sql.query<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!cols.some((c) => c.name === column)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
  }

  /** Upsert a job by id (create or replace) — idempotent, so a PUT of the same doc is a no-op change. */
  putConfig(c: ReplicationConfig): void {
    this.sql.query(
      `INSERT INTO replication_config(${COLS}) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET source = excluded.source, target = excluded.target,
         continuous = excluded.continuous, create_target = excluded.create_target, filter = excluded.filter,
         placement = excluded.placement,
         checkpoint_interval = excluded.checkpoint_interval, use_checkpoints = excluded.use_checkpoints`,
      [c.id, c.source, c.target, c.continuous ? 1 : 0, c.createTarget ? 1 : 0,
        c.filter ?? null, c.placement ?? null, c.checkpointInterval ?? null, c.useCheckpoints === false ? 0 : 1]);
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
    // Deleting a config also drops its scheduler state — the job never runs again.
    this.sql.query('DELETE FROM replication_job WHERE config_id = ?', [id]);
    return this.sql.query('DELETE FROM replication_config WHERE id = ? RETURNING id', [id]).length > 0;
  }

  // ---- scheduler state (Phase 5c) ----

  /** Atomically CLAIM the due jobs (§9 scheduler): configs with no job row yet, or whose job is due
   *  (`next_run <= now`), not currently leased, and not terminal — oldest-due first (round-robin fairness),
   *  capped at `max` (CouchDB's `max_jobs`). Each claimed job's lease is set to `now + leaseMs` and its state
   *  to `running`, so an overlapping runner skips it. This runs as ONE synchronous span (the DO/process
   *  serializes calls), so the select-then-claim is atomic against another tick. */
  claimDue(now: number, leaseMs: number, max: number): ReplicationConfig[] {
    const rows = this.sql.query<ConfigRow>(
      `SELECT ${COLS.split(', ').map((c) => 'c.' + c).join(', ')}
       FROM replication_config c LEFT JOIN replication_job j ON j.config_id = c.id
       WHERE j.config_id IS NULL OR (
         COALESCE(j.next_run, 0) <= ? AND (j.lease_until IS NULL OR j.lease_until <= ?)
         AND j.state NOT IN ('completed', 'failed'))
       ORDER BY COALESCE(j.next_run, 0) LIMIT ?`,
      [now, now, max]);
    const claimed = rows.map(rowToConfig);
    for (const c of claimed) {
      this.sql.query(
        `INSERT INTO replication_job(config_id, replication_id, state, lease_until, start_time, last_updated, error_count, next_run)
         VALUES(?, ?, 'running', ?, ?, ?, 0, ?)
         ON CONFLICT(config_id) DO UPDATE SET state = 'running', lease_until = excluded.lease_until,
           replication_id = excluded.replication_id,
           start_time = COALESCE(replication_job.start_time, excluded.start_time), last_updated = excluded.last_updated`,
        [c.id, replicationIdFor(c.id), now + leaseMs, now, now, now]);
    }
    return claimed;
  }

  /** Read a job's session history (newest first), or []. */
  private historyOf(configId: string): SessionRecord[] {
    const r = this.sql.query<{ history: string | null }>('SELECT history FROM replication_job WHERE config_id = ?', [configId])[0];
    return r?.history ? (JSON.parse(r.history) as SessionRecord[]) : [];
  }

  /** Prepend a session record, capped at {@link HISTORY_CAP} (CouchDB bounds `history` too). */
  private withSession(configId: string, record: SessionRecord): string {
    return JSON.stringify([record, ...this.historyOf(configId)].slice(0, HISTORY_CAP));
  }

  /** Record a finished run and RELEASE the lease (§9). `nextRun` null ⇒ terminal (a completed one-shot).
   *  Appends the run to the session history (CouchDB's `history`, §9·2). */
  recordResult(configId: string, r: JobResult): void {
    const history = this.withSession(configId, { time: r.lastUpdated, info: r.info ?? null });
    this.sql.query(
      `UPDATE replication_job SET state = ?, next_run = ?, info = ?, last_updated = ?, lease_until = NULL, error_count = 0, history = ?
       WHERE config_id = ?`,
      [r.state, r.nextRun, JSON.stringify(r.info ?? null), r.lastUpdated, history, configId]);
  }

  /** Record a failed run: bump `error_count`, set `crashing`, release the lease, schedule an EXPONENTIAL
   *  backoff retry (CouchDB's penalise-repeated-failures) capped at `maxBackoffMs`, and log the session. */
  recordFailure(configId: string, message: string, now: number, backoffBaseMs: number, maxBackoffMs: number): void {
    const cur = this.sql.query<{ error_count: number }>('SELECT error_count FROM replication_job WHERE config_id = ?', [configId])[0];
    const errorCount = (cur?.error_count ?? 0) + 1;
    const delay = Math.min(maxBackoffMs, backoffBaseMs * 2 ** (errorCount - 1));
    const info = { error: message };
    const history = this.withSession(configId, { time: now, info });
    this.sql.query(
      `UPDATE replication_job SET state = 'crashing', error_count = ?, info = ?, last_updated = ?, lease_until = NULL, next_run = ?, history = ?
       WHERE config_id = ?`,
      [errorCount, JSON.stringify(info), now, now + delay, history, configId]);
  }

  listJobs(): ReplicationJob[] {
    return this.sql.query<JobRow>(
      `SELECT config_id, replication_id, state, error_count, info, last_updated, start_time, next_run, history
       FROM replication_job ORDER BY config_id`).map(rowToJob);
  }

  getJob(configId: string): ReplicationJob | null {
    const r = this.sql.query<JobRow>(
      `SELECT config_id, replication_id, state, error_count, info, last_updated, start_time, next_run, history
       FROM replication_job WHERE config_id = ?`, [configId])[0];
    return r ? rowToJob(r) : null;
  }

  // ---- scheduled-job checkpoints (§9·2) — the registry's own resume cursors ----
  getCheckpoint(replicationId: string): number {
    return this.sql.query<{ s: number }>('SELECT source_last_seq AS s FROM replication_checkpoint WHERE replication_id = ?', [replicationId])[0]?.s ?? 0;
  }
  setCheckpoint(replicationId: string, seq: number): void {
    this.sql.query('INSERT OR REPLACE INTO replication_checkpoint(replication_id, source_last_seq) VALUES(?, ?)', [replicationId, seq]);
  }
}

/** A scheduled job's deterministic replication id — stable per config, so a re-run resumes from its
 *  checkpoint (distinct from the one-shot `_replicate` id, which is keyed by direction+peer). */
export const replicationIdFor = (configId: string): string => `config:${configId}`;

interface JobRow {
  config_id: string; replication_id: string | null; state: string; error_count: number;
  info: string | null; last_updated: number | null; start_time: number | null; next_run: number | null;
  history: string | null;
}
const rowToJob = (r: JobRow): ReplicationJob => ({
  configId: r.config_id, replicationId: r.replication_id, state: r.state, errorCount: r.error_count,
  info: r.info ? JSON.parse(r.info) : null, lastUpdated: r.last_updated, startTime: r.start_time, nextRun: r.next_run,
  history: r.history ? (JSON.parse(r.history) as SessionRecord[]) : [],
});

/** The async seam the router + scheduler call. The CF backend forwards to the singleton registry DO (async
 *  RPC); Bun/browser use {@link storeRegistry} over a local {@link ReplicatorStore}. Kept minimal for Phase
 *  5b (config CRUD); Phase 5c adds the scheduler's job-state + claim methods. */
export interface ReplicatorRegistry {
  putConfig(config: ReplicationConfig): Promise<void>;
  getConfig(id: string): Promise<ReplicationConfig | null>;
  listConfigs(): Promise<readonly ReplicationConfig[]>;
  deleteConfig(id: string): Promise<boolean>;
  // ---- scheduler (Phase 5c) ----
  /** Atomically claim up to `max` due jobs, leasing them for `leaseMs` (§9 scheduler). */
  claimDue(now: number, leaseMs: number, max: number): Promise<readonly ReplicationConfig[]>;
  /** Record a finished run + release the lease. */
  recordResult(configId: string, result: JobResult): Promise<void>;
  /** Record a failed run: bump error_count, `crashing`, exponential-backoff retry, release the lease. */
  recordFailure(configId: string, message: string, now: number, backoffBaseMs: number, maxBackoffMs: number): Promise<void>;
  /** All scheduler job rows (`_scheduler/jobs`). */
  listJobs(): Promise<readonly ReplicationJob[]>;
  /** One job's scheduler state, or null. */
  getJob(configId: string): Promise<ReplicationJob | null>;
  /** Read a scheduled job's resume cursor (0 if none). */
  getCheckpoint(replicationId: string): Promise<number>;
  /** Write a scheduled job's resume cursor. */
  setCheckpoint(replicationId: string, seq: number): Promise<void>;
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
    claimDue: async (now, leaseMs, max) => store.claimDue(now, leaseMs, max),
    recordResult: async (configId, result) => store.recordResult(configId, result),
    recordFailure: async (configId, message, now, backoffBaseMs, maxBackoffMs) =>
      store.recordFailure(configId, message, now, backoffBaseMs, maxBackoffMs),
    listJobs: async () => store.listJobs(),
    getJob: async (configId) => store.getJob(configId),
    getCheckpoint: async (replicationId) => store.getCheckpoint(replicationId),
    setCheckpoint: async (replicationId, seq) => store.setCheckpoint(replicationId, seq),
  };
}

/** A fresh job id when a client POSTs a config without one (CouchDB allows a user-defined `_id` or a
 *  generated one). `crypto.randomUUID` is present on all three runtimes. */
export const newConfigId = (): string => crypto.randomUUID();
