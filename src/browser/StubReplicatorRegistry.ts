// The Service Worker's ReplicatorRegistry — a direct capnweb stub to the singleton registry Worker, wrapped
// as the async `ReplicatorRegistry` seam the router + scheduler call. The twin of `BrowserGraphManager` for
// the control plane: ONE wrapper over a `RegistryStubSource` that owns HOW the stub is obtained and kept
// current across cross-tab failover, with the same retry-once-on-a-changed-stub logic (a hard-killed leader
// tab leaves an in-flight call hung until the new leader pushes a fresh port and the source disposes the
// dead stub → the call rejects → we retry against the new stub).
import type { RpcStub } from 'capnweb';
import type { ReplicatorRegistry, ReplicationConfig, ReplicationJob, JobResult } from '../replicator-registry.ts';
import type { ReplicatorRegistryHost } from './ReplicatorRegistryHost.ts';

// capnweb `Stubify`s a stub method's return; we await immediately and the real value crosses as plain clone,
// so pin the awaited type back at the one seam (mirrors BrowserGraphManager's `Awaited$`).
type Call$<T> = (stub: RpcStub<ReplicatorRegistryHost>) => Promise<T>;

/** How the SW OBTAINS and KEEPS the registry stub. `openRegistry()` returns the current stub (cheap once
 *  live); called again after a failure to pick up a post-failover stub. */
export interface RegistryStubSource {
  openRegistry(): Promise<RpcStub<ReplicatorRegistryHost>>;
}

export class StubReplicatorRegistry implements ReplicatorRegistry {
  constructor(private readonly source: RegistryStubSource) {}

  /** Run `fn` against the current registry stub, retrying ONCE if the stub CHANGED across the failure
   *  (failover elected a new leader). A rejection with the same stub still current is a genuine error. */
  private async call<T>(fn: Call$<T>): Promise<T> {
    const stub = await this.source.openRegistry();
    try {
      return await fn(stub);
    } catch (e) {
      const fresh = await this.source.openRegistry();
      if (fresh !== stub) return await fn(fresh);
      throw e;
    }
  }

  putConfig(config: ReplicationConfig): Promise<void> { return this.call(((s) => s.putConfig(config)) as Call$<void>); }
  getConfig(id: string): Promise<ReplicationConfig | null> { return this.call(((s) => s.getConfig(id)) as Call$<ReplicationConfig | null>); }
  listConfigs(): Promise<readonly ReplicationConfig[]> { return this.call(((s) => s.listConfigs()) as Call$<readonly ReplicationConfig[]>); }
  deleteConfig(id: string): Promise<boolean> { return this.call(((s) => s.deleteConfig(id)) as Call$<boolean>); }
  claimDue(now: number, leaseMs: number, max: number): Promise<readonly ReplicationConfig[]> {
    return this.call(((s) => s.claimDue(now, leaseMs, max)) as Call$<readonly ReplicationConfig[]>);
  }
  recordResult(configId: string, result: JobResult): Promise<void> { return this.call(((s) => s.recordResult(configId, result)) as Call$<void>); }
  recordFailure(configId: string, message: string, now: number, backoffBaseMs: number, maxBackoffMs: number): Promise<void> {
    return this.call(((s) => s.recordFailure(configId, message, now, backoffBaseMs, maxBackoffMs)) as Call$<void>);
  }
  listJobs(): Promise<readonly ReplicationJob[]> { return this.call(((s) => s.listJobs()) as Call$<readonly ReplicationJob[]>); }
  getJob(configId: string): Promise<ReplicationJob | null> { return this.call(((s) => s.getJob(configId)) as Call$<ReplicationJob | null>); }
  getCheckpoint(replicationId: string): Promise<number> { return this.call(((s) => s.getCheckpoint(replicationId)) as Call$<number>); }
  setCheckpoint(replicationId: string, seq: number): Promise<void> { return this.call(((s) => s.setCheckpoint(replicationId, seq)) as Call$<void>); }
}
