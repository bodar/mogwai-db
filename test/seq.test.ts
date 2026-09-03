import { test, expect, describe } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { loadBulk } from '../src/bulk.ts';

// Phase 2 step 2a (docs/2026-09-02-replication-and-http-interop-plan.md §5·2): a per-element `seq`, a
// LOCAL per-graph monotonic last-modified cursor assigned by the post-write refresh from `update_seq`.
// `_changes?since=N` will be `WHERE seq > N ORDER BY seq`; here we assert the cursor itself — every write
// bumps it, a mutation MOVES the element's entry forward, an untouched sibling keeps its seq, and it stays
// current-state-sized (one row per element, no append-only growth).

const mgr = () => new BunGraphManager(undefined, standardRegistry);
const seqs = (m: BunGraphManager, id: string, table: 'nodes' | 'edges'): number[] =>
  m.storeOf(id).query<{ seq: number | null }>(`SELECT seq FROM ${table} ORDER BY id`).map((r) => r.seq!);
const counter = (m: BunGraphManager, id: string): number =>
  m.storeOf(id).query<{ value: number }>('SELECT value FROM update_seq WHERE rowid = 1')[0]!.value;

describe('seq — the by-sequence cursor (compiled path)', () => {
  test('a created element gets a positive seq; siblings get distinct increasing seqs', async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").addV("person").addV("person")', {});
    const s = seqs(m, 'g', 'nodes');
    expect(s).toHaveLength(3);
    expect(s.every((v) => v > 0)).toBe(true);
    expect([...s].sort((a, b) => a - b)).toEqual(s); // already increasing by id order
    expect(new Set(s).size).toBe(3); // distinct
  });

  test('a mutation MOVES the element to a fresh higher seq; the feed stays one-row-per-element', async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").property("name","marko")', {});
    const before = seqs(m, 'g', 'nodes')[0]!;
    await m.executor('g').framedAsync('g.V().property("age",29)', {});
    const after = seqs(m, 'g', 'nodes')[0]!;
    expect(after).toBeGreaterThan(before); // MOVED forward
    // Current-state-sized: still exactly one nodes row, not an append-only log.
    expect(m.storeOf('g').query<{ n: number }>('SELECT count(*) AS n FROM nodes')[0]!.n).toBe(1);
  });

  test('an untouched sibling keeps its seq while another mutates', async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").property("name","a").addV("person").property("name","b")', {});
    const before = seqs(m, 'g', 'nodes');
    await m.executor('g').framedAsync('g.V().has("name","a").property("age",1)', {});
    const after = seqs(m, 'g', 'nodes');
    expect(after[0]!).toBeGreaterThan(before[0]!); // mutated → moved
    expect(after[1]!).toBe(before[1]!); // untouched → unchanged
  });

  test('seq is monotonic across writes and node seqs precede edge seqs within one write', async () => {
    const m = mgr();
    await m.executor('g').framedAsync(
      'g.addV("person").as("a").addV("person").as("b").addE("knows").from("a").to("b")', {});
    const nodeSeqs = seqs(m, 'g', 'nodes'), edgeSeqs = seqs(m, 'g', 'edges');
    expect(Math.max(...nodeSeqs)).toBeLessThan(edgeSeqs[0]!); // §6·2 order: nodes before edges
    // A later write draws strictly higher seqs than everything so far.
    const high = counter(m, 'g');
    await m.executor('g').framedAsync('g.addV("software")', {});
    expect(seqs(m, 'g', 'nodes').at(-1)!).toBeGreaterThan(high);
  });

  test('every live element has a seq > 0 — the full-state guarantee since=0 needs', async () => {
    const m = mgr();
    await m.executor('g').framedAsync(
      'g.addV("person").as("a").addV("person").as("b").addE("knows").from("a").to("b").property("w",1)', {});
    expect(seqs(m, 'g', 'nodes').every((v) => v > 0)).toBe(true);
    expect(seqs(m, 'g', 'edges').every((v) => v > 0)).toBe(true);
  });
});

describe('seq — the bulk/format path', () => {
  const store = (): GraphStore => new GraphStore(new BunSqlite(':memory:'));
  const storeSeqs = (s: GraphStore, table: 'nodes' | 'edges'): number[] =>
    s.query<{ seq: number | null }>(`SELECT seq FROM ${table} ORDER BY id`).map((r) => r.seq!);

  test('a rev-less bulk load assigns fresh local seqs', () => {
    const s = store();
    loadBulk(s, [
      { id: 1, labels: ['person'], properties: [{ key: 'name', value: 'a' }] },
      { id: 2, labels: ['person'], properties: [{ key: 'name', value: 'b' }] },
    ]);
    const seq = storeSeqs(s, 'nodes');
    expect(seq.every((v) => v > 0)).toBe(true);
    expect(new Set(seq).size).toBe(2);
  });

  test('a PRESERVED-rev bulk load keeps rev but still takes a fresh LOCAL seq (§5·2)', () => {
    const s = store();
    // A carried rev (as a replicated/dumped element ships) — preserved, but seq is this graph's own.
    loadBulk(s, [{ id: 1, labels: ['person'], gid: 'a'.repeat(32), rev: JSON.stringify({ gen: 5, hash: 'deadbeef' }), properties: [] }]);
    expect(JSON.parse(s.query<{ rev: string }>('SELECT json(rev) AS rev FROM nodes')[0]!.rev)).toMatchObject({ gen: 5, hash: 'deadbeef' }); // rev preserved (leaf)
    expect(storeSeqs(s, 'nodes')[0]!).toBeGreaterThan(0); // but a local seq was assigned
    expect(s.query<{ n: number }>('SELECT count(*) AS n FROM nodes WHERE dirty')[0]!.n).toBe(0); // dirty cleared
  });
});
