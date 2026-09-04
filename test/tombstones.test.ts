import { test, expect, describe } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';

// Phase 2 step 2b (docs/archive/2026-09-02-replication-and-http-interop-plan.md §6·4/§6·5): drop() records a
// TOMBSTONE carrying the deleted element's gid (which element), its last rev (which version), a fresh
// local seq (so the delete enters the feed), and kind. Only elements that HAD a committed gid are
// recorded — a create-and-drop in one program leaves nothing, since no peer ever saw it.

interface Tomb { gid: string; rev: string | null; seq: number | null; kind: string }
const mgr = () => new BunGraphManager(undefined, standardRegistry);
const tombs = (m: BunGraphManager, id: string): Tomb[] =>
  m.storeOf(id).query<Tomb>('SELECT hex(gid) AS gid, json(rev) AS rev, seq, kind FROM tombstones ORDER BY seq');
const nodeGid = (m: BunGraphManager, id: string): string =>
  m.storeOf(id).query<{ gid: string }>('SELECT hex(gid) AS gid FROM nodes ORDER BY id')[0]!.gid;

describe('tombstones — drop() records a delete', () => {
  test('dropping a vertex records a tombstone with its gid, last rev, a fresh seq, and kind', async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").property("name","marko")', {});
    const gid = nodeGid(m, 'g');
    const rev = m.storeOf('g').query<{ rev: string }>('SELECT json(rev) AS rev FROM nodes')[0]!.rev;
    await m.executor('g').framedAsync('g.V().drop()', {});

    const t = tombs(m, 'g');
    expect(t).toHaveLength(1);
    expect(t[0]!.gid).toBe(gid); // identifies the deleted element cross-peer
    expect(t[0]!.rev).toBe(rev); // the version at deletion (for the conflict winner, §6·3)
    expect(t[0]!.seq!).toBeGreaterThan(0); // in the feed
    expect(t[0]!.kind).toBe('vertex');
    // The live row is gone; the tombstone is the only trace.
    expect(m.storeOf('g').query<{ n: number }>('SELECT count(*) AS n FROM nodes')[0]!.n).toBe(0);
  });

  test('dropping a vertex also tombstones its incident edges (cascade)', async () => {
    const m = mgr();
    await m.executor('g').framedAsync(
      'g.addV("person").as("a").addV("person").as("b").addE("knows").from("a").to("b")', {});
    await m.executor('g').framedAsync('g.V().limit(1).drop()', {}); // drop one vertex + its edge
    const kinds = tombs(m, 'g').map((t) => t.kind).sort();
    expect(kinds).toEqual(['edge', 'vertex']); // both the vertex and the cascade-deleted edge
    // No dangling edge left behind.
    expect(m.storeOf('g').query<{ n: number }>('SELECT count(*) AS n FROM edges')[0]!.n).toBe(0);
  });

  test('dropping an edge records an edge tombstone; the vertices stand', async () => {
    const m = mgr();
    await m.executor('g').framedAsync(
      'g.addV("person").as("a").addV("person").as("b").addE("knows").from("a").to("b")', {});
    await m.executor('g').framedAsync('g.E().drop()', {});
    const t = tombs(m, 'g');
    expect(t).toHaveLength(1);
    expect(t[0]!.kind).toBe('edge');
    expect(m.storeOf('g').query<{ n: number }>('SELECT count(*) AS n FROM nodes')[0]!.n).toBe(2); // vertices untouched
  });

  test('a create-and-drop in one program records NO tombstone (no gid ever committed)', async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").drop()', {});
    expect(tombs(m, 'g')).toHaveLength(0);
    expect(m.storeOf('g').query<{ n: number }>('SELECT count(*) AS n FROM nodes')[0]!.n).toBe(0);
  });

  test('a tombstone seq is monotonic — later than every live seq before the delete', async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").addV("person")', {});
    const beforeMax = m.storeOf('g').query<{ m: number }>('SELECT max(seq) AS m FROM nodes')[0]!.m;
    await m.executor('g').framedAsync('g.V().limit(1).drop()', {});
    expect(tombs(m, 'g')[0]!.seq!).toBeGreaterThan(beforeMax);
  });
});
