// The browser's control-plane registry, INSIDE its own dedicated Worker — the twin of the Cloudflare
// singleton registry DO and Bun's in-process `storeRegistry`. docs/2026-09-02-…-plan.md §9·2: ongoing
// replication config/job state lives in a SINGLETON store the worker-residency scheduler enumerates, NOT in
// a graph. The Service Worker edge can't hold OPFS or spawn a Worker, so — exactly as each graph lives in a
// dedicated Worker the page's `WorkerFactory` spawns — the registry lives in ONE dedicated Worker over its
// own opfs-sahpool database (`.mogwai/_replicator`), so a replication config survives a tab/SW restart. The
// SW reaches it by a direct capnweb stub (`StubReplicatorRegistry`).
//
// This is the STORE tier (the substance); the postMessage transport that fronts it is `registry-worker.ts`.
// Keeping it transport-free lets the browser lane drive it directly over the real opfs-sahpool VFS.
import { RpcTarget } from 'capnweb';
import { ReplicatorStore, type ReplicationConfig, type ReplicationJob, type JobResult } from '../replicator-registry.ts';
import type { Sql } from '../storage.ts';
import { opfsSahpoolWasmSql } from './WasmSqlite.ts';

/** How the registry's store is opened. Defaults to its own opfs-sahpool database (persistent, one per
 *  origin); a test injects an in-memory factory. Async only for the WASM/pool init. */
export type RegistrySqlFactory = () => Promise<Sql>;

const opfsRegistryFactory: RegistrySqlFactory = () => opfsSahpoolWasmSql('.mogwai/_replicator');

/** Extends capnweb's `RpcTarget` so the SW edge can hold it by reference across the port and invoke each
 *  registry op over RPC — the postMessage protocol IS these signatures (all plain-data args/returns, so they
 *  structured-clone cleanly, like the CF registry DO). Sync over the store; the capnweb boundary makes the
 *  SW-side calls async (the `ReplicatorRegistry` seam). */
export class ReplicatorRegistryHost extends RpcTarget {
  private constructor(private readonly store: ReplicatorStore) {
    super();
  }

  /** Open (or create-on-open) the registry store. Idempotent at the SQL level: `ReplicatorStore`'s ctor
   *  runs the schema DDL + column migrations `IF NOT EXISTS`, so re-opening restores a live registry over
   *  the committed data. */
  static async open(makeSql: RegistrySqlFactory = opfsRegistryFactory): Promise<ReplicatorRegistryHost> {
    return new ReplicatorRegistryHost(new ReplicatorStore(await makeSql()));
  }

  putConfig(config: ReplicationConfig): void { this.store.putConfig(config); }
  getConfig(id: string): ReplicationConfig | null { return this.store.getConfig(id); }
  listConfigs(): ReplicationConfig[] { return this.store.listConfigs(); }
  deleteConfig(id: string): boolean { return this.store.deleteConfig(id); }
  claimDue(now: number, leaseMs: number, max: number): ReplicationConfig[] { return this.store.claimDue(now, leaseMs, max); }
  recordResult(configId: string, result: JobResult): void { this.store.recordResult(configId, result); }
  recordFailure(configId: string, message: string, now: number, backoffBaseMs: number, maxBackoffMs: number): void {
    this.store.recordFailure(configId, message, now, backoffBaseMs, maxBackoffMs);
  }
  listJobs(): ReplicationJob[] { return this.store.listJobs(); }
  getJob(configId: string): ReplicationJob | null { return this.store.getJob(configId); }
  getCheckpoint(replicationId: string): number { return this.store.getCheckpoint(replicationId); }
  setCheckpoint(replicationId: string, seq: number): void { this.store.setCheckpoint(replicationId, seq); }
}
