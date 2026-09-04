import { test, expect, describe } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { makeRouter } from '../src/router.ts';
import type { ChangesFeed } from '../src/api.ts';

// Phase 2 step 2c (docs/archive/2026-09-02-replication-and-http-interop-plan.md §5·2, §9): the peer-facing
// `GET /gremlin/{g}/_changes?since=N` feed. A UNION of live nodes/edges and tombstones WHERE seq > N,
// ordered by seq — one entry per element at its latest state, keyed by gid. since=0 is the full current
// state; the feed is current-state-sized (moved, not appended); a delete rides as deleted:true.

const setup = () => {
  const mgr = new BunGraphManager(undefined, standardRegistry);
  const http = makeRouter(mgr);
  const feed = async (since = 0): Promise<ChangesFeed> => {
    const res = await http(new Request(`http://x/gremlin/g/_changes?since=${since}`));
    expect(res.status).toBe(200);
    return res.json() as Promise<ChangesFeed>;
  };
  const run = (q: string) => mgr.executor('g').framedAsync(q, {});
  return { mgr, http, feed, run };
};

describe('_changes — the by-sequence feed endpoint', () => {
  test('since=0 enumerates the full current state, keyed by gid, ordered by seq', async () => {
    const { feed, run } = setup();
    await run('g.addV("person").as("a").addV("person").as("b").addE("knows").from("a").to("b")');
    const f = await feed(0);
    expect(f.results).toHaveLength(3); // 2 vertices + 1 edge
    expect(f.results.map((r) => r.kind)).toEqual(['vertex', 'vertex', 'edge']); // seq order = §6·2 order
    for (const r of f.results) {
      expect(r.id).toMatch(/^[0-9A-F]{32}$/i); // hex gid, not a rowid
      expect(r.rev!.gen).toBe(1);
      expect(r.deleted).toBeUndefined();
    }
    expect(f.last_seq).toBeGreaterThanOrEqual(Math.max(...f.results.map((r) => r.seq)));
    // The seqs are strictly ascending.
    expect(f.results.map((r) => r.seq)).toEqual([...f.results.map((r) => r.seq)].sort((a, b) => a - b));
  });

  test('since=last_seq returns only what changed after the checkpoint', async () => {
    const { feed, run } = setup();
    await run('g.addV("person").property("name","marko")');
    const first = await feed(0);
    const checkpoint = first.last_seq;
    await run('g.V().property("age",29)'); // mutate the one vertex
    const delta = await feed(checkpoint);
    expect(delta.results).toHaveLength(1); // only the moved element
    expect(delta.results[0]!.rev!.gen).toBe(2); // chained
    // Re-requesting at the newest checkpoint is empty (caught up).
    expect((await feed(delta.last_seq)).results).toHaveLength(0);
  });

  test('a delete rides the feed as deleted:true, keyed by the same gid', async () => {
    const { feed, run } = setup();
    await run('g.addV("person")');
    const gid = (await feed(0)).results[0]!.id;
    await run('g.V().drop()');
    const f = await feed(0);
    expect(f.results).toHaveLength(1); // the tombstone replaces the live entry — still one-per-element
    expect(f.results[0]!.id).toBe(gid); // same identity
    expect(f.results[0]!.deleted).toBe(true);
    expect(f.results[0]!.kind).toBe('vertex');
  });

  test('the feed stays current-state-sized under repeated updates (moved, not appended)', async () => {
    const { feed, run } = setup();
    await run('g.addV("person")');
    for (let i = 0; i < 5; i++) await run('g.V().property("n",' + i + ')');
    const f = await feed(0);
    expect(f.results).toHaveLength(1); // one element → one entry, however many writes
    expect(f.results[0]!.rev!.gen).toBe(6); // create + 5 mutations
  });

  test('GET and POST are allowed (POST carries a filter); another verb is 405; an unknown endpoint is 404', async () => {
    const { http, run } = setup();
    await run('g.addV("person")');
    // POST with a body is the filtered form (F1) — a bodiless-but-valid `{}` is an unfiltered feed.
    const post = await http(new Request('http://x/gremlin/g/_changes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ since: 0 }),
    }));
    expect(post.status).toBe(200);
    expect((await http(new Request('http://x/gremlin/g/_changes', { method: 'PUT' }))).status).toBe(405);
    expect((await http(new Request('http://x/gremlin/g/_bogus'))).status).toBe(404);
  });
});
