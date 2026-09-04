import { test, expect, describe } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { makeRouter } from '../src/router.ts';
import { ReplicatorStore, storeRegistry, type ReplicationConfig } from '../src/replicator-registry.ts';
import { runDueReplications, type SchedulerDeps } from '../src/scheduler.ts';
import type { ChangesFeed, Http } from '../src/api.ts';

// Phase 5c-core (docs/2026-09-02-replication-and-http-interop-plan.md §9): the worker-residency scheduler.
// `runDueReplications` claims due jobs from the registry (leased, so overlapping ticks never double-run one),
// runs each as a bounded PACED pull at worker residency (the graph is a pure data-plane client), records the
// result + reschedules. Driven here by manual ticks (the deterministic test of the shared runner the CF
// cron / Bun interval / browser SW timer all call).

const setup = (http?: Http) => {
  let router: Http;
  // ONE http seam for both the manager and the scheduler's remote peers — so an injected throwing seam
  // (the failure test) reaches the peer path, not just the manager's federation http.
  const httpSeam: Http = http ?? ((req) => router!(req));
  const mgr = new BunGraphManager(undefined, standardRegistry, undefined, undefined, undefined, httpSeam);
  const registry = storeRegistry(new ReplicatorStore(new BunSqlite(':memory:')));
  router = makeRouter(mgr, undefined, undefined, registry);
  const run = (g: string, q: string) => mgr.executor(g).framedAsync(q, {});
  const url = (g: string) => `http://peer/gremlin/${g}`;
  const changes = async (g: string): Promise<ChangesFeed> =>
    (await router!(new Request(`http://peer/gremlin/${g}/_changes?since=0`))).json() as Promise<ChangesFeed>;
  const deps: SchedulerDeps = { registry, manager: mgr, http: httpSeam };
  return { mgr, registry, deps, run, url, changes, router: router! };
};

const fp = (f: ChangesFeed) => f.results.map((r) => ({ id: r.id, rev: r.rev, deleted: r.deleted ?? false })).sort((a, b) => a.id.localeCompare(b.id));
const seedN = async (s: ReturnType<typeof setup>, g: string, n: number) => { for (let i = 0; i < n; i++) await s.run(g, `g.addV('p').property('n', ${i})`); };

describe('replication scheduler (Phase 5c-core)', () => {
  test('a continuous job syncs a remote into a local graph on a tick, and picks up deltas', async () => {
    const s = setup();
    await seedN(s, 'remote', 3);
    await s.registry.putConfig({ id: 'j1', source: s.url('remote'), target: 'local', continuous: true, checkpointInterval: 1000 });

    const t0 = 10_000;
    const r1 = await runDueReplications(s.deps, { now: t0 });
    expect(r1.ran).toBe(1);
    expect(r1.outcomes[0]).toMatchObject({ configId: 'j1', ok: true, written: 3 });
    expect(fp(await s.changes('local'))).toEqual(fp(await s.changes('remote')));

    // Job is scheduled for its poll interval; a tick before then is a no-op (nothing due).
    const job = await s.registry.getJob('j1');
    expect(job).toMatchObject({ state: 'pending' });
    expect(job!.nextRun).toBe(t0 + 1000);
    expect((await runDueReplications(s.deps, { now: t0 + 500 })).ran).toBe(0); // not due yet

    // A remote delta is pulled on the next due tick.
    await s.run('remote', 'g.V().property("age", 29)');
    const r2 = await runDueReplications(s.deps, { now: t0 + 1000 });
    expect(r2.ran).toBe(1);
    expect(fp(await s.changes('local'))).toEqual(fp(await s.changes('remote')));
  });

  test('a large job is PACED across ticks (bounded per wake, re-scheduled promptly while more remains)', async () => {
    const s = setup();
    await seedN(s, 'remote', 12);
    await s.registry.putConfig({ id: 'big', source: s.url('remote'), target: 'local', continuous: true });

    const now = 1000;
    const opts = { now, batchSize: 5, maxBatchesPerWake: 1 };
    const a = await runDueReplications(s.deps, opts);
    expect(a.outcomes[0]).toMatchObject({ written: 5, more: true });
    expect((await s.registry.getJob('big'))!.nextRun).toBe(now); // more ⇒ due again immediately
    const b = await runDueReplications(s.deps, opts);
    expect(b.outcomes[0]).toMatchObject({ written: 5, more: true });
    const c = await runDueReplications(s.deps, opts);
    expect(c.outcomes[0]).toMatchObject({ written: 2, more: false }); // drained
    expect((await s.mgr.info('local')).vertexCount).toBe(12);
    expect(fp(await s.changes('local'))).toEqual(fp(await s.changes('remote')));
  });

  test('a one-shot job runs once then completes and is never re-run', async () => {
    const s = setup();
    await seedN(s, 'remote', 2);
    await s.registry.putConfig({ id: 'once', source: s.url('remote'), target: 'local', continuous: false });
    const r1 = await runDueReplications(s.deps, { now: 100 });
    expect(r1.ran).toBe(1);
    expect((await s.registry.getJob('once'))).toMatchObject({ state: 'completed' });
    // Later ticks never re-claim a completed one-shot.
    expect((await runDueReplications(s.deps, { now: 1_000_000 })).ran).toBe(0);
  });

  test('the lease prevents overlapping ticks from double-running a job', async () => {
    const s = setup();
    await seedN(s, 'remote', 2);
    await s.registry.putConfig({ id: 'lease', source: s.url('remote'), target: 'local', continuous: true });
    // Two ticks racing at the same instant: the first claims + leases; the second sees the lease and skips.
    const [a, b] = await Promise.all([runDueReplications(s.deps, { now: 5 }), runDueReplications(s.deps, { now: 5 })]);
    expect([a.ran, b.ran].sort()).toEqual([0, 1]);
  });

  test('a failing job goes to crashing with an exponential-backoff next_run', async () => {
    // An http seam that always throws → every peer op fails.
    const s = setup(() => Promise.reject(new Error('network down')));
    await s.registry.putConfig({ id: 'bad', source: 'http://peer/gremlin/remote', target: 'local', continuous: true });
    const r1 = await runDueReplications(s.deps, { now: 0, backoffBaseMs: 1000, backoffMaxMs: 60_000 });
    expect(r1.outcomes[0]).toMatchObject({ ok: false });
    const job1 = await s.registry.getJob('bad');
    expect(job1).toMatchObject({ state: 'crashing', errorCount: 1 });
    expect(job1!.nextRun).toBe(1000); // now(0) + base * 2^0
    // A tick before the backoff elapses is a no-op; the error count then grows the delay.
    expect((await runDueReplications(s.deps, { now: 500 })).ran).toBe(0);
    await runDueReplications(s.deps, { now: 1000, backoffBaseMs: 1000, backoffMaxMs: 60_000 });
    const job2 = await s.registry.getJob('bad');
    expect(job2!.errorCount).toBe(2);
    expect(job2!.nextRun).toBe(1000 + 2000); // now(1000) + base * 2^1
  });

  test('_scheduler/jobs and _scheduler/docs expose scheduler state', async () => {
    const s = setup();
    await seedN(s, 'remote', 1);
    await s.registry.putConfig({ id: 'introspect', source: s.url('remote'), target: 'local', continuous: true });
    await runDueReplications(s.deps, { now: 42 });

    const jobs = (await (await s.router(new Request('http://h/_scheduler/jobs'))).json()) as { jobs: any[] };
    expect(jobs.jobs.some((j) => j.configId === 'introspect' && j.state === 'pending')).toBe(true);

    const docs = (await (await s.router(new Request('http://h/_scheduler/docs'))).json()) as { docs: any[] };
    const doc = docs.docs.find((d: ReplicationConfig & { job: any }) => d.id === 'introspect');
    expect(doc).toMatchObject({ id: 'introspect', continuous: true });
    expect(doc.job).toMatchObject({ state: 'pending' });
  });

  test('deleting a config drops its scheduler job too', async () => {
    const s = setup();
    await s.registry.putConfig({ id: 'temp', source: s.url('remote'), target: 'local', continuous: true });
    await runDueReplications(s.deps, { now: 1 });
    expect(await s.registry.getJob('temp')).not.toBeNull();
    await s.registry.deleteConfig('temp');
    expect(await s.registry.getJob('temp')).toBeNull();
    expect((await runDueReplications(s.deps, { now: 1_000_000 })).ran).toBe(0);
  });
});
