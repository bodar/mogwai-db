import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { applyChanges, type ReplVertex, type ReplEdge } from '../src/replicate.ts';

// Phase 3 step 3a (docs/2026-09-02-replication-and-http-interop-plan.md §4·5, §6·1/§6·2): applyChanges
// lands a peer's changes by GID, idempotently, at their stated rev. A fresh gid → a fresh local rowid; a
// known gid → its rowid, content overwritten; edge endpoints resolved gid→rowid; a delete removes the
// element and tombstones it. This is the write half the peer protocol (3b) and the replicator (3c) drive.

const store = () => new GraphStore(new BunSqlite(':memory:'));
const rev = (gen: number, hash: string) => JSON.stringify({ gen, hash });
const A = 'A'.repeat(32), B = 'B'.repeat(32), C = 'C'.repeat(32);
const v = (gid: string, r: string, labels: string[], props: Record<string, unknown> = {}): ReplVertex =>
  ({ gid, rev: r, labels, properties: Object.entries(props).map(([key, value]) => ({ key, value })) });
const e = (gid: string, r: string, label: string, srcGid: string, tgtGid: string, props: Record<string, unknown> = {}): ReplEdge =>
  ({ gid, rev: r, label, srcGid, tgtGid, properties: Object.entries(props).map(([key, value]) => ({ key, value })) });
// The stored rev's LEAF (gen/hash) as a normalized string — the rev now also carries the tree `ids`
// (Phase 4a), which these assertions don't pin.
const storedRev = (s: GraphStore, table: 'nodes' | 'edges', gid: string) => {
  const raw = s.query<{ rev: string }>(`SELECT json(rev) AS rev FROM ${table} WHERE hex(gid) = ?`, [gid])[0]?.rev;
  if (!raw) return undefined;
  const { gen, hash } = JSON.parse(raw) as { gen: number; hash: string };
  return JSON.stringify({ gen, hash });
};
const counts = (s: GraphStore) => ({
  v: s.query<{ n: number }>('SELECT count(*) AS n FROM nodes')[0]!.n,
  e: s.query<{ n: number }>('SELECT count(*) AS n FROM edges')[0]!.n,
});
// An edge's endpoints by GID — proves gid→rowid endpoint resolution landed the right connection.
const edgeEnds = (s: GraphStore, gid: string) =>
  s.query<{ src: string; tgt: string }>(
    'SELECT hex(sv.gid) AS src, hex(tv.gid) AS tgt FROM edges e JOIN nodes sv ON sv.id = e.src JOIN nodes tv ON tv.id = e.tgt WHERE hex(e.gid) = ?', [gid])[0];
const prop = (s: GraphStore, gid: string, key: string) =>
  s.query<{ value: unknown }>('SELECT value FROM vertex_properties p JOIN nodes n ON n.id = p.node WHERE hex(n.gid) = ? AND key = ?', [gid, key])[0]?.value;

describe('applyChanges — landing a peer\'s changes by gid', () => {
  test('applies to a FRESH graph: fresh rowids, gid + rev preserved, edge endpoints resolved by gid', () => {
    const s = store();
    applyChanges(s, {
      vertices: [v(A, rev(1, 'aa'), ['person'], { name: 'marko' }), v(B, rev(1, 'bb'), ['person'], { name: 'vadas' })],
      edges: [e(C, rev(1, 'cc'), 'knows', A, B, { weight: 0.5 })],
    });
    expect(counts(s)).toEqual({ v: 2, e: 1 });
    expect(storedRev(s, 'nodes', A)).toBe(rev(1, 'aa')); // preserved verbatim, not recomputed
    expect(storedRev(s, 'edges', C)).toBe(rev(1, 'cc'));
    // The edge connects the right endpoints, resolved from their gids.
    expect(edgeEnds(s, C)).toEqual({ src: A, tgt: B });
    // Every element has a local seq (enters this graph's own feed).
    expect(s.query<{ n: number }>('SELECT count(*) AS n FROM nodes WHERE seq > 0')[0]!.n).toBe(2);
  });

  test('is IDEMPOTENT: re-applying the same batch changes nothing (no duplicates, rev unchanged)', () => {
    const s = store();
    const batch = { vertices: [v(A, rev(3, 'aa'), ['person'], { name: 'marko' })] };
    applyChanges(s, batch);
    applyChanges(s, batch);
    expect(counts(s)).toEqual({ v: 1, e: 0 }); // no duplicate
    expect(storedRev(s, 'nodes', A)).toBe(rev(3, 'aa')); // rev PRESERVED, never chained to gen 4
  });

  test('a known gid is UPDATED in place, preserving the incoming (newer) rev — not chaining', () => {
    const s = store();
    applyChanges(s, { vertices: [v(A, rev(1, 'aa'), ['person'], { name: 'marko', age: 29 })] });
    const rowid = s.query<{ id: number }>('SELECT id FROM nodes WHERE hex(gid) = ?', [A])[0]!.id;
    // The source mutated it: a new rev, new content.
    applyChanges(s, { vertices: [v(A, rev(2, 'aa2'), ['person'], { name: 'marko', age: 30 })] });
    expect(counts(s)).toEqual({ v: 1, e: 0 }); // same element
    expect(s.query<{ id: number }>('SELECT id FROM nodes WHERE hex(gid) = ?', [A])[0]!.id).toBe(rowid); // same rowid
    expect(storedRev(s, 'nodes', A)).toBe(rev(2, 'aa2')); // the source's rev, PRESERVED
    expect(prop(s, A, 'age')).toBe(30); // content overwritten
  });

  test('a delete removes the element and records a tombstone at the carried rev; re-apply is a no-op', () => {
    const s = store();
    applyChanges(s, { vertices: [v(A, rev(1, 'aa'), ['person'])] });
    applyChanges(s, { deletes: [{ gid: A, rev: rev(2, 'del'), kind: 'vertex' }] });
    expect(counts(s)).toEqual({ v: 0, e: 0 }); // gone
    const t = s.query<{ gid: string; rev: string; seq: number | null; kind: string }>(
      'SELECT hex(gid) AS gid, json(rev) AS rev, seq, kind FROM tombstones');
    expect(t).toHaveLength(1);
    expect(t[0]!).toMatchObject({ gid: A, rev: rev(2, 'del'), kind: 'vertex' });
    expect(t[0]!.seq!).toBeGreaterThan(0); // a fresh LOCAL seq — the delete enters the feed
    applyChanges(s, { deletes: [{ gid: A, rev: rev(2, 'del'), kind: 'vertex' }] });
    expect(s.query<{ n: number }>('SELECT count(*) AS n FROM tombstones')[0]!.n).toBe(1); // deduped
  });

  test('edge endpoints resolve by gid ACROSS batches (vertices landed earlier)', () => {
    const s = store();
    applyChanges(s, { vertices: [v(A, rev(1, 'aa'), ['person'], { name: 'a' }), v(B, rev(1, 'bb'), ['person'], { name: 'b' })] });
    applyChanges(s, { edges: [e(C, rev(1, 'cc'), 'knows', A, B)] }); // endpoints already local
    expect(counts(s)).toEqual({ v: 2, e: 1 });
    expect(edgeEnds(s, C)).toEqual({ src: A, tgt: B }); // resolved against the earlier batch's vertices
  });
});
