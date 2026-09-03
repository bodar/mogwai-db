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

  test('loading the SAME gid-carrying document converges (two replicas share gids)', () => {
    // The replication property: gid is PRESERVED on load, so two graphs seeded from one document
    // agree element-for-element. (Independent CREATION producing disjoint gids is the separate gate,
    // covered by the compiled-path test below and the two-mints check above.)
    const a = freshStore(), b = freshStore();
    seed(a); seed(b);
    expect(gids(a, 'nodes')).toEqual(gids(b, 'nodes'));
    expect(gids(a, 'edges')).toEqual(gids(b, 'edges'));
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

describe('gid — the compiled write path (post-write refresh)', () => {
  const mgr = () => new BunGraphManager(undefined, standardRegistry);
  const nodeGids = (m: BunGraphManager, id: string) =>
    m.storeOf(id).query<{ id: number; gid: string | null }>('SELECT id, hex(gid) AS gid FROM nodes ORDER BY id');
  const edgeGids = (m: BunGraphManager, id: string) =>
    m.storeOf(id).query<{ id: number; gid: string | null }>('SELECT id, hex(gid) AS gid FROM edges ORDER BY id');

  test('a compiled addV gets a gid minted by the post-write refresh', async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").property("name","marko")', {});
    const vs = nodeGids(m, 'g');
    expect(vs).toHaveLength(1);
    expect(vs[0]!.gid).toMatch(/^[0-9A-F]{32}$/);
  });

  test('a multi-table chain (addV.addV.addE) gids every created element, all distinct', async () => {
    const m = mgr();
    await m.executor('g').framedAsync(
      'g.addV("person").as("a").addV("person").as("b").addE("knows").from("a").to("b")', {});
    const vs = nodeGids(m, 'g'), es = edgeGids(m, 'g');
    expect(vs).toHaveLength(2);
    expect(es).toHaveLength(1);
    const all = [...vs, ...es].map((r) => r.gid!);
    for (const g of all) expect(g).toMatch(/^[0-9A-F]{32}$/);
    expect(new Set(all).size).toBe(3); // vertex, vertex, edge — all gidded, all distinct
  });

  test('a property mutation does NOT change an existing gid (immutable identity)', async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").property("name","marko")', {});
    const before = nodeGids(m, 'g')[0]!.gid;
    await m.executor('g').framedAsync('g.V().property("age",29)', {});
    const after = nodeGids(m, 'g')[0]!.gid;
    expect(after).toBe(before);              // gid survives the mutation
    expect(nodeGids(m, 'g')).toHaveLength(1); // no phantom null-gid element created
  });

  test('two independent graphs never collide on compiled-created gid', async () => {
    const m = mgr();
    await m.executor('a').framedAsync('g.addV("person").property("name","marko")', {});
    await m.executor('b').framedAsync('g.addV("person").property("name","marko")', {});
    expect(nodeGids(m, 'a')[0]!.gid).not.toBe(nodeGids(m, 'b')[0]!.gid);
  });
});
