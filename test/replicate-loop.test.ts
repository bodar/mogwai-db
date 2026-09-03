import { test, expect, describe } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { makeRouter } from '../src/router.ts';
import type { ChangesFeed, Http, ReplicationStats } from '../src/api.ts';

// Phase 3 step 3c (docs/2026-09-02-replication-and-http-interop-plan.md §9, §5): the pull/push loop +
// checkpoint + `_replicate`. A peer is reached over the SAME Http seam federation/io() use, so the whole
// hop runs in memory against the manager's own router (late-bound). Gate: pull a remote graph to a fresh
// local one; re-pull is a resumable no-op; push is the same with roles swapped.

const setup = () => {
  let router: Http;
  const mgr = new BunGraphManager(undefined, standardRegistry, undefined, undefined, undefined, (req) => router(req));
  router = makeRouter(mgr);
  const run = (g: string, q: string) => mgr.executor(g).framedAsync(q, {});
  const changes = async (g: string): Promise<ChangesFeed> =>
    (await router(new Request(`http://peer/gremlin/${g}/_changes?since=0`))).json() as Promise<ChangesFeed>;
  const url = (g: string) => `http://peer/gremlin/${g}`;
  return { mgr, run, changes, url, router };
};

const fingerprint = (f: ChangesFeed) =>
  f.results.map((r) => ({ id: r.id, rev: r.rev, kind: r.kind, deleted: r.deleted ?? false }))
    .sort((a, b) => a.id.localeCompare(b.id));

describe('replication — the pull/push loop', () => {
  test('PULL reconstructs a remote graph in a fresh local one', async () => {
    const s = setup();
    await s.run('remote', 'g.addV("person").property("name","marko").as("a")'
      + '.addV("software").property("name","lop").as("b").addE("created").from("a").to("b").property("weight",0.4)');
    const stats = await s.mgr.replicate('local', { source: s.url('remote') });
    expect(stats).toMatchObject({ read: 3, written: 3, deleted: 0 });
    expect(fingerprint(await s.changes('local'))).toEqual(fingerprint(await s.changes('remote')));
  });

  test('re-pull is a RESUMABLE no-op (checkpoint), and picks up a later delta', async () => {
    const s = setup();
    await s.run('remote', 'g.addV("person").property("name","marko")');
    await s.mgr.replicate('local', { source: s.url('remote') });
    const again = await s.mgr.replicate('local', { source: s.url('remote') });
    expect(again).toMatchObject({ read: 0, written: 0 }); // caught up — nothing re-read
    // The source changes; the next pull transfers only the delta.
    await s.run('remote', 'g.V().property("age",29)');
    const delta = await s.mgr.replicate('local', { source: s.url('remote') });
    expect(delta).toMatchObject({ read: 1, written: 1 });
    expect(fingerprint(await s.changes('local'))).toEqual(fingerprint(await s.changes('remote')));
  });

  test('PUSH is the same with roles swapped', async () => {
    const s = setup();
    await s.run('mine', 'g.addV("person").property("name","marko").addV("person").property("name","vadas")');
    const stats = await s.mgr.replicate('mine', { target: s.url('theirs') });
    expect(stats).toMatchObject({ read: 2, written: 2 });
    expect(fingerprint(await s.changes('theirs'))).toEqual(fingerprint(await s.changes('mine')));
  });

  test('a delete PROPAGATES through a pull', async () => {
    const s = setup();
    await s.run('remote', 'g.addV("person").as("a").addV("person").as("b")');
    await s.mgr.replicate('local', { source: s.url('remote') });
    expect((await s.mgr.info('local')).vertexCount).toBe(2);
    await s.run('remote', 'g.V().limit(1).drop()');
    const delta = await s.mgr.replicate('local', { source: s.url('remote') });
    expect(delta).toMatchObject({ deleted: 1 });
    expect((await s.mgr.info('local')).vertexCount).toBe(1);
    expect(fingerprint(await s.changes('local'))).toEqual(fingerprint(await s.changes('remote')));
  });

  test('the POST /_replicate endpoint drives a pull; a body naming no remote is 400', async () => {
    const s = setup();
    await s.run('remote', 'g.addV("person")');
    const res = await s.router(new Request('http://peer/gremlin/local/_replicate', {
      method: 'POST', body: JSON.stringify({ source: s.url('remote') }), headers: { 'Content-Type': 'application/json' },
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as ReplicationStats).written).toBe(1);
    expect((await s.mgr.info('local')).vertexCount).toBe(1);
    const bad = await s.router(new Request('http://peer/gremlin/local/_replicate', {
      method: 'POST', body: JSON.stringify({ source: 'sibling' }), headers: { 'Content-Type': 'application/json' },
    }));
    expect(bad.status).toBe(400); // no remote http(s) end
  });
});
