import { test, expect, describe } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { makeRouter } from '../src/router.ts';
import type { ChangesFeed, WireChangeSet, BulkGetRef } from '../src/api.ts';

// Phase 3 step 3b (docs/archive/2026-09-02-replication-and-http-interop-plan.md §4·5, §9): the transfer payload
// endpoints. `_bulk_get` returns element BODIES (labels + typed properties + endpoint gids) for the gids
// a peer is missing; `_bulk_docs` applies them. Here the whole hop runs in memory over the router — the
// half the replicator (3c) drives — proving a graph transfers faithfully: structure, typed values, and
// deletes.

const http = () => {
  const mgr = new BunGraphManager(undefined, standardRegistry);
  const handler = makeRouter(mgr);
  const run = (g: string, q: string) => mgr.executor(g).framedAsync(q, {});
  const changes = async (g: string, since = 0): Promise<ChangesFeed> =>
    (await handler(new Request(`http://x/gremlin/${g}/_changes?since=${since}`))).json() as Promise<ChangesFeed>;
  const post = async (g: string, ep: string, body: unknown) =>
    handler(new Request(`http://x/gremlin/${g}/${ep}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));
  return { mgr, run, changes, post };
};

/** Pull the whole of `src` into `dst` in one shot: feed → refs → _bulk_get → _bulk_docs. */
async function transfer(h: ReturnType<typeof http>, src: string, dst: string): Promise<void> {
  const feed = await h.changes(src, 0);
  const live = feed.results.filter((r) => !r.deleted);
  const deletes = feed.results.filter((r) => r.deleted).map((r) => ({ gid: r.id, rev: r.rev ? `${r.rev.gen}-${r.rev.hash}` : null, kind: r.kind }));
  const refs: BulkGetRef[] = live.map((r) => ({ gid: r.id, kind: r.kind }));
  const bodies = (await (await h.post(src, '_bulk_get', refs)).json()) as WireChangeSet;
  const res = await h.post(dst, '_bulk_docs', { ...bodies, deletes: deletes.map((d) => ({ ...d, rev: null })) });
  expect(res.status).toBe(200);
}

/** {id, rev, kind, deleted} for every feed entry — the fingerprint two synced graphs must share. */
const fingerprint = (f: ChangesFeed) =>
  f.results.map((r) => ({ id: r.id, rev: r.rev, kind: r.kind, deleted: r.deleted ?? false }))
    .sort((a, b) => a.id.localeCompare(b.id));

describe('_bulk_get / _bulk_docs — the transfer payload', () => {
  test('a full graph transfers faithfully: same gids and revs, edges reconnected by gid', async () => {
    const h = http();
    await h.run('src', 'g.addV("person").property("name","marko").property("age",29).as("a")'
      + '.addV("software").property("name","lop").property("lang","java").as("b")'
      + '.addE("created").from("a").to("b").property("weight",0.4)');
    await transfer(h, 'src', 'dst');
    // The two graphs' change fingerprints match on gid+rev (seq is local, so excluded).
    expect(fingerprint(await h.changes('dst'))).toEqual(fingerprint(await h.changes('src')));
    expect((await h.mgr.info('dst'))).toEqual({ vertexCount: 2, edgeCount: 1 });
  });

  test('typed + collection property values survive the transfer', async () => {
    const h = http();
    await h.run('src', 'g.addV("data").property("n", 42L).property("nums", ["a","b","c"])');
    await transfer(h, 'src', 'dst');
    const s = h.mgr.storeOf('dst');
    // The long stayed a long (vtype long), the list stayed a list.
    const rows = s.query<{ key: string; vtype: string; value: string }>(
      "SELECT key, vtype, CASE WHEN vtype IN ('list','set','map') THEN json(value) ELSE value END AS value FROM vertex_properties ORDER BY key");
    expect(rows.find((r) => r.key === 'n')).toMatchObject({ vtype: 'long', value: 42 });
    expect(rows.find((r) => r.key === 'nums')!.vtype).toBe('list');
  });

  test('idempotent: transferring twice leaves dst unchanged (revs preserved)', async () => {
    const h = http();
    await h.run('src', 'g.addV("person").property("name","marko")');
    await transfer(h, 'src', 'dst');
    const once = fingerprint(await h.changes('dst'));
    await transfer(h, 'src', 'dst');
    expect(fingerprint(await h.changes('dst'))).toEqual(once); // no duplicate, no rev bump
    expect((await h.mgr.info('dst')).vertexCount).toBe(1);
  });

  test('a delete propagates: dst removes the element and tombstones it', async () => {
    const h = http();
    await h.run('src', 'g.addV("person").as("a").addV("person").as("b")');
    await transfer(h, 'src', 'dst');
    expect((await h.mgr.info('dst')).vertexCount).toBe(2);
    // Drop one on the source, then transfer the delta (feed now carries a tombstone).
    await h.run('src', 'g.V().limit(1).drop()');
    const feed = await h.changes('src');
    const del = feed.results.filter((r) => r.deleted).map((r) => ({ gid: r.id, rev: null, kind: r.kind }));
    await h.post('dst', '_bulk_docs', { deletes: del });
    expect((await h.mgr.info('dst')).vertexCount).toBe(1); // removed
    expect(h.mgr.storeOf('dst').query<{ n: number }>('SELECT count(*) AS n FROM tombstones')[0]!.n).toBe(1);
  });
});
