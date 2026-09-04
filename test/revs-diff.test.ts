import { test, expect, describe } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { makeRouter } from '../src/router.ts';
import type { ChangesFeed, RevsDiffRequest, RevsDiffResponse } from '../src/api.ts';

// Phase 2 step 2d (docs/archive/2026-09-02-replication-and-http-interop-plan.md §4 primitive 2, §9): the
// `POST /gremlin/{g}/_revs_diff` lookup. A peer offers {gid: [rev,...]}; the target returns which it is
// MISSING, so the source ships only those. A pure gid/rev key lookup, never a body.

const setup = () => {
  const mgr = new BunGraphManager(undefined, standardRegistry);
  const http = makeRouter(mgr);
  const run = (q: string) => mgr.executor('g').framedAsync(q, {});
  const feed = async (since = 0): Promise<ChangesFeed> =>
    (await http(new Request(`http://x/gremlin/g/_changes?since=${since}`))).json() as Promise<ChangesFeed>;
  const diff = async (request: RevsDiffRequest): Promise<{ status: number; body: RevsDiffResponse }> => {
    const res = await http(new Request('http://x/gremlin/g/_revs_diff', {
      method: 'POST', body: JSON.stringify(request), headers: { 'Content-Type': 'application/json' },
    }));
    return { status: res.status, body: (await res.json()) as RevsDiffResponse };
  };
  return { mgr, http, run, feed, diff };
};

const FAKE = 'A'.repeat(32);

describe('_revs_diff — the "what are you missing?" lookup', () => {
  test('a rev the graph HAS is not reported missing; one it lacks is', async () => {
    const { run, feed, diff } = setup();
    await run('g.addV("person").property("name","marko")');
    const [row] = (await feed(0)).results;
    const have = row!.rev!;
    // Offer the exact rev it holds, plus a fabricated one it does not.
    const other = { gen: have.gen + 1, hash: 'f'.repeat(32) };
    const { body } = await diff({ [row!.id]: [have, other] });
    expect(body[row!.id]!.missing).toEqual([other]); // only the one it lacks
  });

  test('a gid the graph has never seen: every offered rev is missing', async () => {
    const { diff } = setup();
    const revs = [{ gen: 1, hash: 'abc' }, { gen: 2, hash: 'def' }];
    const { body } = await diff({ [FAKE]: revs });
    expect(body[FAKE]!.missing).toEqual(revs);
  });

  test('when the graph has everything offered, the response is empty (nothing to ship)', async () => {
    const { run, feed, diff } = setup();
    await run('g.addV("person")');
    const [row] = (await feed(0)).results;
    const { body } = await diff({ [row!.id]: [row!.rev!] });
    expect(body).toEqual({});
  });

  test('a DELETED element counts as HAD at its tombstone rev', async () => {
    const { run, feed, diff } = setup();
    await run('g.addV("person")');
    const gid = (await feed(0)).results[0]!.id;
    const tombRev = (await feed(0)).results[0]!.rev!; // rev survives into the tombstone
    await run('g.V().drop()');
    const { body } = await diff({ [gid]: [tombRev] });
    expect(body).toEqual({}); // already had it (as a tombstone) — do not re-ship
  });

  test('an offered ANCESTOR is not missing — a newer local rev subsumes it (rev-tree, Phase 4a)', async () => {
    const { run, feed, diff } = setup();
    await run('g.addV("person").property("name","v1")'); // gen 1
    const gen1 = (await feed(0)).results[0]!.rev!; // the leaf {gen:1, hash}
    await run('g.V().property("name","v2")'); // gen 2
    await run('g.V().property("name","v3")'); // gen 3 — its tree includes gen1's hash
    const row = (await feed(0)).results[0]!;
    expect(row.rev!.gen).toBe(3);
    // Offering the gen-1 ancestor: subsumed by the local gen-3 tree → nothing to ship.
    expect(await diff({ [row.id]: [gen1] }).then((r) => r.body)).toEqual({});
    // A rev off the tree is still missing.
    expect((await diff({ [row.id]: [{ gen: 4, hash: 'ff'.repeat(16) }] })).body[row.id]!.missing).toHaveLength(1);
  });

  test('gid hex is matched case-insensitively; a GET is 405; a bad body is 400', async () => {
    const { run, feed, diff, http } = setup();
    await run('g.addV("person")');
    const row = (await feed(0)).results[0]!;
    const lower = row.id.toLowerCase();
    const { body } = await diff({ [lower]: [{ gen: 99, hash: 'nope' }] });
    expect(body[lower]!.missing).toHaveLength(1); // resolved despite lowercase gid
    expect((await http(new Request('http://x/gremlin/g/_revs_diff'))).status).toBe(405); // GET not allowed
    const bad = await http(new Request('http://x/gremlin/g/_revs_diff', { method: 'POST', body: 'not json' }));
    expect(bad.status).toBe(400);
  });
});
