import { DurableObject } from 'cloudflare:workers';
import { DurableObjectSqlite } from './DurableObjectSqlite.ts';
import { ReplicatorStore, type ReplicationConfig, type ReplicatorRegistry } from '../replicator-registry.ts';
import type { Env } from './graph-store-do.ts';

// The Cloudflare backend of the ReplicatorRegistry seam (docs/2026-09-02-…-plan.md §9·2). Ongoing
// replication config/job state lives in a SINGLETON control-plane store — one instance per deployment,
// addressed by a fixed id — separate from every graph DO. It is a DATA STORE ONLY: the worker-residency
// scheduler (Phase 5c) reads due jobs from it and RUNS them at the edge; the registry DO never runs a
// replication, so its single-threaded occupancy is trivial (a claim + a state write per job per tick).

/** The fixed name of the one registry instance (CouchDB's node-global `_replicator`). */
export const REGISTRY_SINGLETON = '_replicator';

/** The singleton registry Durable Object: a `ReplicatorStore` over its own `ctx.storage.sql`. Schema DDL
 *  runs synchronously in the ctor (before any RPC), exactly like `GraphDatabase`. No `destroy`/`deleteAll`
 *  (a control plane is never torn down), so no `ensureLive` dance is needed. */
export class ReplicatorRegistryDO extends DurableObject<Env> {
  private store: ReplicatorStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new ReplicatorStore(new DurableObjectSqlite(ctx.storage.sql));
  }

  // Plain-data RPC (config objects are JSON-able — strings/booleans/numbers/null — so they structured-clone
  // across the DO boundary with none of the Stmt/closure hazards the graph plane has).
  putConfig(config: ReplicationConfig): void { this.store.putConfig(config); }
  getConfig(id: string): ReplicationConfig | null { return this.store.getConfig(id); }
  listConfigs(): ReplicationConfig[] { return this.store.listConfigs(); }
  deleteConfig(id: string): boolean { return this.store.deleteConfig(id); }
}

/** The manager-side seam: forwards each op to the singleton DO over RPC (async), the CF twin of Bun's
 *  in-process `storeRegistry`. */
export class CloudflareReplicatorRegistry implements ReplicatorRegistry {
  constructor(private ns: DurableObjectNamespace<ReplicatorRegistryDO>) {}
  private stub() { return this.ns.getByName(REGISTRY_SINGLETON); }
  putConfig(config: ReplicationConfig): Promise<void> { return this.stub().putConfig(config); }
  getConfig(id: string): Promise<ReplicationConfig | null> { return this.stub().getConfig(id); }
  listConfigs(): Promise<readonly ReplicationConfig[]> { return this.stub().listConfigs(); }
  deleteConfig(id: string): Promise<boolean> { return this.stub().deleteConfig(id); }
}
