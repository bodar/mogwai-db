import { test, expect, describe } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { makeRouter } from '../src/router.ts';
import {
  runReplication, runReplicationPass, remotePeer, localPeer, replicationId,
  type Checkpoint, type Peer,
} from '../src/replicate.ts';
import type { ChangesFeed, Http } from '../src/api.ts';

// Phase 5a (docs/archive/2026-09-02-replication-and-http-interop-plan.md §7 + Phase 5): the paced/paged
// replication substrate. `runReplication` drains the source in bounded PAGES (a `_changes?limit=N` per
// page), applying at most `batchSize` changes per span and awaiting `pace()` between pages — so a large
// pull never busy-locks the single-threaded store. Each page advances the checkpoint, so a bounded
// (`maxBatches`) run resumes from where it stopped. Everything runs in memory against the router.

const setup = () => {
  let router: Http;
  const mgr = new BunGraphManager(undefined, standardRegistry, undefined, undefined, undefined, (req) => router(req));
  router = makeRouter(mgr);
  const run = (g: string, q: string) => mgr.executor(g).framedAsync(q, {});
  const changes = async (g: string): Promise<ChangesFeed> =>
    (await router(new Request(`http://peer/gremlin/${g}/_changes?since=0`))).json() as Promise<ChangesFeed>;
  const url = (g: string) => `http://peer/gremlin/${g}`;
  return { mgr, run, changes, url, router: router! };
};

const fingerprint = (f: ChangesFeed) =>
  f.results.map((r) => ({ id: r.id, rev: r.rev, kind: r.kind, deleted: r.deleted ?? false }))
    .sort((a, b) => a.id.localeCompare(b.id));

const seedN = async (s: ReturnType<typeof setup>, g: string, n: number) => {
  for (let i = 0; i < n; i++) await s.run(g, `g.addV('p').property('n', ${i})`);
};

/** A checkpoint bound to graph `id` via the manager (where a pull stores its resume cursor). */
const cpFor = (mgr: BunGraphManager, id: string, replId: string): Checkpoint => ({
  read: () => mgr.checkpoint(id, replId),
  write: async (seq) => { await mgr.checkpoint(id, replId, seq); },
});

/** Wrap a target peer so the largest single `bulkDocs` payload it sees is observable — the bound each
 *  page must respect. */
const boundedTarget = (inner: Peer): { peer: Peer; maxPage: () => number } => {
  let maxPage = 0;
  return {
    maxPage: () => maxPage,
    peer: {
      ...inner,
      bulkDocs: async (cs) => {
        maxPage = Math.max(maxPage, (cs.vertices?.length ?? 0) + (cs.edges?.length ?? 0) + (cs.deletes?.length ?? 0));
        return inner.bulkDocs(cs);
      },
    },
  };
};

describe('replication — paged + paced drain (Phase 5a)', () => {
  test('_changes?limit=N pages the feed; last_seq is the resume cursor when truncated', async () => {
    const s = setup();
    await seedN(s, 'remote', 7);
    const res = await s.router(new Request(`${s.url('remote')}/_changes?since=0&limit=3`));
    const page = (await res.json()) as ChangesFeed;
    expect(page.results.length).toBe(3); // truncated to the limit
    // A truncated page resumes strictly after its last row.
    expect(page.last_seq).toBe(page.results[2]!.seq);
    // The next page reads from there.
    const res2 = await s.router(new Request(`${s.url('remote')}/_changes?since=${page.last_seq}&limit=3`));
    const page2 = (await res2.json()) as ChangesFeed;
    expect(page2.results.length).toBe(3);
    expect(page2.results.every((r) => r.seq > page.last_seq)).toBe(true);
    // The final (short) page is not truncated → last_seq is the graph's update_seq (fully caught up).
    const res3 = await s.router(new Request(`${s.url('remote')}/_changes?since=${page2.last_seq}&limit=3`));
    const page3 = (await res3.json()) as ChangesFeed;
    expect(page3.results.length).toBe(1);
    const caughtUp = await s.router(new Request(`${s.url('remote')}/_changes?since=${page3.last_seq}&limit=3`));
    expect(((await caughtUp.json()) as ChangesFeed).results.length).toBe(0); // nothing after last_seq
  });

  test('a large pull drains in bounded PAGES, pacing between them, and converges', async () => {
    const s = setup();
    await seedN(s, 'remote', 12);
    const replId = replicationId('pull', s.url('remote'), 'local');
    const { peer: target, maxPage } = boundedTarget(localPeer(s.mgr, 'local'));
    let paces = 0;
    const stats = await runReplication(
      remotePeer(s.router, s.url('remote')), target, cpFor(s.mgr, 'local', replId),
      { batchSize: 5, pace: () => { paces++; } },
    );
    expect(stats.batches).toBe(3); // 5 + 5 + 2
    expect(stats.more).toBe(false); // drained fully
    expect(stats.written).toBe(12);
    expect(paces).toBe(stats.batches - 1); // a breakpoint BETWEEN pages, not after the last
    expect(maxPage()).toBeLessThanOrEqual(5); // no page applied more than batchSize at once
    expect((await s.mgr.info('local')).vertexCount).toBe(12);
    expect(fingerprint(await s.changes('local'))).toEqual(fingerprint(await s.changes('remote')));
  });

  test('a bounded run (maxBatches) applies one page and RESUMES from the checkpoint', async () => {
    const s = setup();
    await seedN(s, 'remote', 12);
    const replId = replicationId('pull', s.url('remote'), 'local');
    const cp = cpFor(s.mgr, 'local', replId);
    // One page only — the per-wake bound a scheduler re-arms on.
    const first = await runReplication(remotePeer(s.router, s.url('remote')), localPeer(s.mgr, 'local'), cp,
      { batchSize: 5, maxBatches: 1 });
    expect(first.batches).toBe(1);
    expect(first.more).toBe(true); // work still pending
    expect((await s.mgr.info('local')).vertexCount).toBe(5);
    // Resume: a fresh run picks up where the checkpoint left off and finishes.
    const rest = await runReplication(remotePeer(s.router, s.url('remote')), localPeer(s.mgr, 'local'), cp,
      { batchSize: 5 });
    expect(rest.more).toBe(false);
    expect((await s.mgr.info('local')).vertexCount).toBe(12);
    expect(fingerprint(await s.changes('local'))).toEqual(fingerprint(await s.changes('remote')));
  });

  test('a single pass is bounded and reports `more` correctly', async () => {
    const s = setup();
    await seedN(s, 'remote', 6);
    const replId = replicationId('pull', s.url('remote'), 'local');
    const cp = cpFor(s.mgr, 'local', replId);
    const p1 = await runReplicationPass(remotePeer(s.router, s.url('remote')), localPeer(s.mgr, 'local'), cp, 4);
    expect(p1.read).toBe(4);
    expect(p1.more).toBe(true);
    const p2 = await runReplicationPass(remotePeer(s.router, s.url('remote')), localPeer(s.mgr, 'local'), cp, 4);
    expect(p2.read).toBe(2);
    expect(p2.more).toBe(false); // short page → drained
  });

  test('the default one-shot replicate still drains fully (unchanged behaviour, now internally paged)', async () => {
    const s = setup();
    await seedN(s, 'remote', 3);
    const stats = await s.mgr.replicate('local', { source: s.url('remote') });
    expect(stats).toMatchObject({ read: 3, written: 3, deleted: 0 });
    expect(fingerprint(await s.changes('local'))).toEqual(fingerprint(await s.changes('remote')));
  });
});
