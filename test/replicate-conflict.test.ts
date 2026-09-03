import { test, expect, describe } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { makeRouter } from '../src/router.ts';
import { bulkGet, applyWire, conflictsFor } from '../src/replicate.ts';
import type { ChangesFeed, Http, WireChangeSet } from '../src/api.ts';

// Phase 4 step 4b (docs/2026-09-02-replication-and-http-interop-plan.md §6·3): conflict preservation.
// Two DIVERGENT edits of one element (same gid, sibling gen-2 leaves off a shared gen-1) reconcile to a
// deterministic winner (live) + loser (shadow store) — never lost, order-independent at the apply layer.
// (Order-independent convergence through the FEED — losers propagating so both peers surface the same
// conflict regardless of pull order — is 4b-2.)

const setup = () => {
  let router: Http;
  const mgr = new BunGraphManager(undefined, standardRegistry, undefined, undefined, undefined, (req) => router(req));
  router = makeRouter(mgr);
  const run = (g: string, q: string) => mgr.executor(g).framedAsync(q, {});
  const feed = async (g: string): Promise<ChangesFeed> =>
    (await router(new Request(`http://peer/gremlin/${g}/_changes?since=0`))).json() as Promise<ChangesFeed>;
  const url = (g: string) => `http://peer/gremlin/${g}`;
  return { mgr, run, feed, url };
};

describe('replication conflicts — preserve, deterministic winner, surface', () => {
  test('two divergent edits reconcile order-independently: same winner live, same loser shadowed, nothing lost', async () => {
    const s = setup();
    await s.run('seed', 'g.addV("person").property("name","marko")'); // G at gen 1
    for (const g of ['a', 'b', 'x', 'y']) await s.mgr.replicate(g, { source: s.url('seed') }); // all get G@gen1
    await s.run('a', 'g.V().property("age",1)'); // a: G@gen2-hA
    await s.run('b', 'g.V().property("age",2)'); // b: G@gen2-hB  (a sibling of hA off gen1)

    const gid = (await s.feed('a')).results[0]!.id;
    const wireA = bulkGet(s.mgr.storeOf('a'), [{ gid, kind: 'vertex' }]);
    const wireB = bulkGet(s.mgr.storeOf('b'), [{ gid, kind: 'vertex' }]);
    const hA = revHash(wireA), hB = revHash(wireB);
    expect(hA).not.toBe(hB); // genuinely divergent

    // Apply BOTH leaves to two graphs in OPPOSITE orders.
    const sx = s.mgr.storeOf('x'), sy = s.mgr.storeOf('y');
    applyWire(sx, wireA); applyWire(sx, wireB);
    applyWire(sy, wireB); applyWire(sy, wireA);

    // Convergence: identical live winner and identical shadowed loser, whichever order they arrived.
    const liveX = (await s.feed('x')).results.find((r) => r.id === gid)!.rev!;
    const liveY = (await s.feed('y')).results.find((r) => r.id === gid)!.rev!;
    expect(liveX).toEqual(liveY); // deterministic winner, order-independent
    const shX = conflictsFor(sx, gid), shY = conflictsFor(sy, gid);
    expect(shX).toHaveLength(1);
    expect(shY).toHaveLength(1);
    expect(shX[0]!.rev_hash).toBe(shY[0]!.rev_hash); // same loser

    // Nothing lost: the live winner and the shadowed loser ARE the two divergent versions.
    expect(new Set([liveX.hash, shX[0]!.rev_hash])).toEqual(new Set([hA, hB]));
    // The higher hash wins (both gen 2, not deleted) — §6·3.
    expect(liveX.hash).toBe(hA > hB ? hA : hB);
  });

  test('a fast-forward is NOT a conflict — no shadow, just an advance', async () => {
    const s = setup();
    await s.run('seed', 'g.addV("person").property("name","marko")');
    await s.mgr.replicate('x', { source: s.url('seed') }); // x: G@gen1
    await s.run('seed', 'g.V().property("age",1)'); // seed: G@gen2 (descends gen1)
    const gid = (await s.feed('seed')).results[0]!.id;
    applyWire(s.mgr.storeOf('x'), bulkGet(s.mgr.storeOf('seed'), [{ gid, kind: 'vertex' }]));
    expect(conflictsFor(s.mgr.storeOf('x'), gid)).toHaveLength(0); // fast-forward, no conflict
    expect((await s.feed('x')).results.find((r) => r.id === gid)!.rev!.gen).toBe(2); // advanced
  });
});

const revHash = (ws: WireChangeSet): string => JSON.parse(ws.vertices![0]!.rev).hash;
