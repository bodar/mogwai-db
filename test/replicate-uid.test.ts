import { test, expect, describe } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { bulkGet, applyWire, conflictsFor } from '../src/replicate.ts';
import type { GraphStore } from '../src/storage.ts';

// Phase 4 step 4e (docs/2026-09-02-replication-and-http-interop-plan.md §6·1/§6·3): uid replicates, and a
// cross-peer uid COLLISION (two gids claiming one user-supplied id, from a partition) reconciles like any
// conflict — winner (not-deleted > LOWER gid) keeps the uid, the loser's is shadowed + surfaced, both
// elements survive, deterministic ⇒ order-independent. A uid is unique per graph, never global.

const mgr = () => new BunGraphManager(undefined, standardRegistry);
const soleGid = (s: GraphStore) => s.query<{ gid: string }>('SELECT hex(gid) AS gid FROM nodes ORDER BY id')[0]!.gid;
const uidOf = (s: GraphStore, gid: string) => s.query<{ uid: string | null }>('SELECT uid FROM nodes WHERE hex(gid) = ?', [gid])[0]?.uid;
const count = (s: GraphStore) => s.query<{ n: number }>('SELECT count(*) AS n FROM nodes')[0]!.n;

describe('replication — uid (§6·1)', () => {
  test('a uid replicates: the element is addressable by it on the target', async () => {
    const m = mgr();
    await m.executor('a').framedAsync('g.addV("person").property(id,"marko").property("name","m")', {});
    const a = m.storeOf('a');
    const gid = soleGid(a);
    applyWire(m.storeOf('b'), bulkGet(a, [{ gid, kind: 'vertex' }]));
    expect(uidOf(m.storeOf('b'), gid)).toBe('marko'); // preserved
  });

  test('a cross-peer uid COLLISION reconciles: lower gid keeps the uid, loser shadowed, both survive, order-independent', async () => {
    const m = mgr();
    // Two graphs independently mint "marko" — distinct gids (a partition).
    await m.executor('a').framedAsync('g.addV("person").property(id,"marko").property("name","A")', {});
    await m.executor('b').framedAsync('g.addV("person").property(id,"marko").property("name","B")', {});
    const gidA = soleGid(m.storeOf('a')), gidB = soleGid(m.storeOf('b'));
    expect(gidA).not.toBe(gidB);
    const wireA = bulkGet(m.storeOf('a'), [{ gid: gidA, kind: 'vertex' }]);
    const wireB = bulkGet(m.storeOf('b'), [{ gid: gidB, kind: 'vertex' }]);
    const winner = gidA < gidB ? gidA : gidB, loser = gidA < gidB ? gidB : gidA;

    for (const [g, first, second] of [['x', wireA, wireB], ['y', wireB, wireA]] as const) {
      const s = m.storeOf(g);
      applyWire(s, first);
      applyWire(s, second);
      expect(count(s)).toBe(2); // both elements survive — never merged, never dropped
      expect(uidOf(s, winner)).toBe('marko'); // lower gid keeps the uid
      expect(uidOf(s, loser)).toBeNull(); // loser gives it up
      const surfaced = conflictsFor(s, loser);
      expect(surfaced.some((c) => (c.doc as { uidConflict?: string }).uidConflict === 'marko')).toBe(true); // surfaced
    }
  });

  test('re-applying a uid is idempotent (no spurious conflict against itself)', async () => {
    const m = mgr();
    await m.executor('a').framedAsync('g.addV("person").property(id,"marko")', {});
    const a = m.storeOf('a');
    const gid = soleGid(a);
    const wire = bulkGet(a, [{ gid, kind: 'vertex' }]);
    const b = m.storeOf('b');
    applyWire(b, wire);
    applyWire(b, wire);
    expect(uidOf(b, gid)).toBe('marko');
    expect(conflictsFor(b, gid)).toHaveLength(0); // no self-conflict
  });
});
