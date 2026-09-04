// ---------- the replication scheduler — worker-residency, runtime-agnostic ----------
//
// docs/archive/2026-09-02-replication-and-http-interop-plan.md §9 (revised 2026-09-04). Ongoing replication is run
// by a scheduler that lives at WORKER residency — NOT a DO alarm: an alarm runs inside a graph DO and would
// busy-lock its single-threaded SQL instance, and CouchDB's replicator is a separate CLIENT of both source
// and target, never the DB itself. So this is ONE shared runner, `runDueReplications`, driven by three thin
// per-runtime tickers (Phase 5c-drivers): a CF Worker Cron Trigger's `scheduled()`, a Bun `setInterval`, a
// browser Service-Worker timer. Each just calls this on a schedule; the graph DOs stay pure data-plane
// clients answering `_changes`/`_revs_diff`/`_bulk_docs`.
//
// The runner: claim due jobs from the registry (a lease, so overlapping ticks never double-run one — the
// registry serializes claims), run each as a BOUNDED, PACED replication pass (`runReplication` with
// `maxBatches` per wake, §5a), record the result + reschedule (a continuous job polls again after its
// interval; a large one drains across several ticks; a one-shot completes), and release the lease. Failures
// get an exponential backoff (CouchDB's penalise-repeated-failures). Multiple jobs run CONCURRENTLY at
// worker residency — the whole point of not being on a DO.

import type { GraphManager, Http } from './api.ts';
import { type Peer, type Checkpoint, localPeer, remotePeer, runReplication, isUrl, DEFAULT_REPLICATION_BATCH } from './replicate.ts';
import { type ReplicatorRegistry, type ReplicationConfig, replicationIdFor } from './replicator-registry.ts';

/** What the runner needs — the registry (job/config/checkpoint store), the local `GraphManager` (to reach a
 *  LOCAL graph ref as a peer), and the ALLOWLISTED `http` (to reach a remote graph URL — the SSRF guard is on
 *  this seam, exactly as for `federate`/`io`, so a config's URL is confined to the operator's allowlist). */
export interface SchedulerDeps {
  registry: ReplicatorRegistry;
  manager: GraphManager;
  http: Http;
}

/** Pacing + fairness knobs (all default to sensible values; a driver may override). */
export interface RunDueOptions {
  /** Wall-clock now (ms). Injectable so a test drives the scheduler deterministically. Default `Date.now()`. */
  now?: number;
  /** Claim lease (ms) — how long a claimed job is off-limits to another runner. Default 60_000. */
  leaseMs?: number;
  /** Max jobs claimed per tick (CouchDB's `max_jobs`, fairness bound). Default 10. */
  maxJobs?: number;
  /** Change entries per page — bounds each apply span (§5a). Default {@link DEFAULT_REPLICATION_BATCH}. */
  batchSize?: number;
  /** Pages per job per wake — bounds DO occupancy; a job with more left is re-scheduled promptly. Default 4. */
  maxBatchesPerWake?: number;
  /** Continuous poll period when a config sets no `checkpointInterval` (ms). Default 60_000. */
  defaultIntervalMs?: number;
  /** Backoff base + cap for a failing job (ms). Defaults 5_000 / 3_600_000. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

/** One job's outcome, returned so a driver/test can inspect a tick. */
export interface JobOutcome {
  configId: string;
  ok: boolean;
  read?: number;
  written?: number;
  deleted?: number;
  more?: boolean;
  error?: string;
}

/** Build a {@link Peer} for a config's `source`/`target` ref: a remote `http(s)` URL → an HTTP peer over the
 *  allowlisted transport; a local id → the manager's own graph (which on CF is a DO reached over RPC — so the
 *  runner orchestrates at worker residency and the DO merely answers). */
function peerFor(deps: SchedulerDeps, ref: string): Peer {
  return isUrl(ref) ? remotePeer(deps.http, ref) : localPeer(deps.manager, ref);
}

/** Run ONE claimed job: a bounded, paced replication pass, then record the result + reschedule. */
async function runJob(deps: SchedulerDeps, config: ReplicationConfig, opts: Required<RunDueOptions>): Promise<JobOutcome> {
  const replId = replicationIdFor(config.id);
  // `useCheckpoints:false` ⇒ always resync from scratch (no persisted cursor), CouchDB's `use_checkpoints`.
  const cp: Checkpoint = config.useCheckpoints === false
    ? { read: async () => 0, write: async () => {} }
    : { read: () => deps.registry.getCheckpoint(replId), write: (seq) => deps.registry.setCheckpoint(replId, seq) };
  try {
    const stats = await runReplication(peerFor(deps, config.source), peerFor(deps, config.target), cp, {
      batchSize: opts.batchSize, maxBatches: opts.maxBatchesPerWake,
    });
    const interval = config.checkpointInterval ?? opts.defaultIntervalMs;
    // `stats.more` ⇒ the wake bound stopped a still-draining job → run again PROMPTLY (drain across ticks).
    // Otherwise: a continuous job polls again after `interval`; a one-shot is done.
    await deps.registry.recordResult(config.id, stats.more
      ? { state: 'pending', nextRun: opts.now, info: stats, lastUpdated: opts.now }
      : config.continuous
        ? { state: 'pending', nextRun: opts.now + interval, info: stats, lastUpdated: opts.now }
        : { state: 'completed', nextRun: null, info: stats, lastUpdated: opts.now });
    return { configId: config.id, ok: true, read: stats.read, written: stats.written, deleted: stats.deleted, more: stats.more };
  } catch (e: any) {
    await deps.registry.recordFailure(config.id, e?.message ?? String(e), opts.now, opts.backoffBaseMs, opts.backoffMaxMs);
    return { configId: config.id, ok: false, error: e?.message ?? String(e) };
  }
}

/** ONE scheduler tick (§9): claim the due jobs and run them CONCURRENTLY at worker residency. Idempotent and
 *  safe to call from any driver (a cron `scheduled()`, a `setInterval`, or a test's manual tick). Returns the
 *  per-job outcomes; `ran` is how many jobs this tick claimed. */
export async function runDueReplications(deps: SchedulerDeps, options: RunDueOptions = {}): Promise<{ ran: number; outcomes: JobOutcome[] }> {
  const opts: Required<RunDueOptions> = {
    now: options.now ?? Date.now(),
    leaseMs: options.leaseMs ?? 60_000,
    maxJobs: options.maxJobs ?? 10,
    batchSize: options.batchSize ?? DEFAULT_REPLICATION_BATCH,
    maxBatchesPerWake: options.maxBatchesPerWake ?? 4,
    defaultIntervalMs: options.defaultIntervalMs ?? 60_000,
    backoffBaseMs: options.backoffBaseMs ?? 5_000,
    backoffMaxMs: options.backoffMaxMs ?? 3_600_000,
  };
  const claimed = await deps.registry.claimDue(opts.now, opts.leaseMs, opts.maxJobs);
  const outcomes = await Promise.all(claimed.map((c) => runJob(deps, c, opts)));
  return { ran: claimed.length, outcomes };
}

/** A polling driver for runtimes with a real timer (Bun, the browser SW): tick `runDueReplications` every
 *  `intervalMs`. Returns a stop function (clears the timer). Non-reentrant — a slow tick is awaited before the
 *  next fires — and a thrown tick is swallowed (logged) so the loop survives. CF does NOT use this: its Cron
 *  Trigger fires `scheduled()`, which calls `runDueReplications` directly. */
export function startPollingScheduler(
  deps: SchedulerDeps, intervalMs: number, options: RunDueOptions = {},
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      await runDueReplications(deps, options);
    } catch (e) {
      console.error('replication scheduler tick failed:', e);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
