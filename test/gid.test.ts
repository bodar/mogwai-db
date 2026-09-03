import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { writeGraphson, loadGraphson } from '../src/formats/graphson.ts';
import { writeCsv, loadCsv } from '../src/formats/csv.ts';
import { mintGid } from '../src/uuid.ts';

// Phase 1a (docs/2026-09-02-replication-and-http-interop-plan.md §6·1): every element carries a
// globally-unique `gid` (uuid_v7). Here on the BULK/FORMAT path — a fresh gid is minted on load, it is
// unique per graph, two independent graphs never collide, GraphSON PRESERVES it across a round trip,
// and CSV (interop-only) RE-MINTS it. gid is not user-visible yet, so we read it straight off the
// store as hex.

const freshStore = () => new GraphStore(new BunSqlite(':memory:'));

/** The modern graph as a GraphSON document, minted with fresh gids (via a throwaway seeded graph),
 *  built once. Seeding is async (the write path), so it is produced in beforeAll. */
let seedDoc: string;
const seed = (store: GraphStore) => loadGraphson(store, seedDoc);
beforeAll(async () => {
  const src = new BunGraphManager(undefined, standardRegistry);
  for (const g of MODERN_SEED) await src.executor('m').framedAsync(g, {});
  seedDoc = writeGraphson(src.storeOf('m'));
});

const gids = (store: GraphStore, table: 'nodes' | 'edges'): Map<number, string> =>
  new Map(store.query<{ id: number; gid: string | null }>(`SELECT id, hex(gid) AS gid FROM ${table} ORDER BY id`)
    .map((r) => [r.id, r.gid!]));

describe('gid — uuid_v7 minting', () => {
  test('mintGid is a well-formed uuid_v7 (version 7, variant 2), 32 hex chars', () => {
    const hex = mintGid();
    expect(hex).toMatch(/^[0-9a-f]{32}$/);
    expect(hex[12]).toBe('7');                       // version nibble (byte 6 high)
    expect(Number.parseInt(hex[16]!, 16) >> 2).toBe(0b10); // variant bits (byte 8 top two)
  });
  test('two mints never collide', () => {
    const n = 10000, set = new Set<string>();
    for (let i = 0; i < n; i++) set.add(mintGid());
    expect(set.size).toBe(n);
  });
});

describe('gid — the bulk/format path', () => {
  test('every loaded element gets a gid, and they are unique within the graph', () => {
    const store = freshStore();
    seed(store);
    const vs = gids(store, 'nodes'), es = gids(store, 'edges');
    expect(vs.size).toBe(6); // modern: 6 vertices
    expect(es.size).toBe(6); // modern: 6 edges
    for (const g of [...vs.values(), ...es.values()]) expect(g).toMatch(/^[0-9A-F]{32}$/);
    expect(new Set([...vs.values(), ...es.values()]).size).toBe(12); // all distinct
  });

  test('two independent graphs never collide on gid', () => {
    const a = freshStore(), b = freshStore();
    seed(a); seed(b);
    const A = new Set([...gids(a, 'nodes').values(), ...gids(a, 'edges').values()]);
    const B = new Set([...gids(b, 'nodes').values(), ...gids(b, 'edges').values()]);
    for (const g of B) expect(A.has(g)).toBe(false); // disjoint despite identical content
  });

  test('GraphSON round-trip PRESERVES gid (the io() backup contract)', () => {
    const src = freshStore();
    seed(src);
    const doc = writeGraphson(src); // now carries gid per element
    const round = freshStore();
    loadGraphson(round, doc);
    // Modern ids are numeric, so a preserve-load keeps rowids — element id N maps to the same gid.
    expect(gids(round, 'nodes')).toEqual(gids(src, 'nodes'));
    expect(gids(round, 'edges')).toEqual(gids(src, 'edges'));
  });

  test('CSV round-trip RE-MINTS gid (interop-only, not a backup format)', () => {
    const src = freshStore();
    seed(src);
    const dump = writeCsv(src);
    const round = freshStore();
    loadCsv(round, dump.vertices);
    loadCsv(round, dump.edges);
    const srcV = gids(src, 'nodes'), roundV = gids(round, 'nodes');
    expect(roundV.size).toBe(srcV.size);
    // same elements (by rowid), but every gid is freshly minted — none survives.
    for (const [id, g] of roundV) expect(g).not.toBe(srcV.get(id));
  });
});
