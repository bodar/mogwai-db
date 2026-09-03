import { test, expect, describe } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { loadGraphson, writeGraphson } from '../src/formats/graphson.ts';
import { loadBulk } from '../src/bulk.ts';
import { computeRev, descendsFrom, revWins } from '../src/rev.ts';

// Phase 4 step 4a: the rev-TREE. A rev carries its stemmed ancestry (newest-first), so apply can tell a
// fast-forward from a divergent conflict; `descendsFrom`/`revWins` are the primitives conflict handling
// (4b) and `_revs_diff` build on.
describe('rev — the rev-tree (Phase 4a)', () => {
  test('chains ancestry newest-first; descendsFrom tracks the line; divergent leaves do not', () => {
    const r1 = computeRev(null, 'a'), r2 = computeRev(r1, 'b'), r3 = computeRev(r2, 'c');
    expect(r1.ids).toEqual([r1.hash]);
    expect(r3.ids).toEqual([r3.hash, r2.hash, r1.hash]); // full lineage
    expect(descendsFrom(r3, r1)).toBe(true); // r3 is a descendant of r1 (fast-forward)
    expect(descendsFrom(r1, r3)).toBe(false); // r1 is an ancestor, not a descendant
    const a = computeRev(r1, 'x'), b = computeRev(r1, 'y'); // two gen-2 siblings off r1
    expect(descendsFrom(a, b)).toBe(false);
    expect(descendsFrom(b, a)).toBe(false); // divergent → neither descends → a conflict
  });

  test('revWins is the deterministic winner: not-deleted > higher gen > higher hash', () => {
    const g1 = computeRev(null, 'a'), g2 = computeRev(g1, 'b');
    expect(revWins(g2, false, g1, false)).toBe(true); // higher gen
    const a = computeRev(g1, 'x'), b = computeRev(g1, 'y'); // same gen
    expect(revWins(a, false, b, false)).toBe(a.hash > b.hash); // higher hash lexically
    expect(revWins(a, true, b, false)).toBe(false); // deleted loses to not-deleted
    expect(revWins(a, false, b, true)).toBe(true);
  });
});

// Phase 2b (docs/2026-09-02-replication-and-http-interop-plan.md §5·1): every created element carries a
// rev {gen, hash} computed by the post-write refresh on the unified dirty sweep. Here on the compiled
// write path — rev is present on create, identical content converges to the same rev (idempotent
// replay), different content diverges, and an edge's rev references its endpoint gids. rev is not
// user-visible yet, so we read it off the store.

interface Rev { gen: number; hash: string }
const mgr = () => new BunGraphManager(undefined, standardRegistry);
const revs = (m: BunGraphManager, id: string, table: 'nodes' | 'edges'): Rev[] =>
  m.storeOf(id).query<{ rev: string | null }>(`SELECT json(rev) AS rev FROM ${table} ORDER BY id`)
    .map((r) => JSON.parse(r.rev!) as Rev);
const gids = (m: BunGraphManager, id: string, table: 'nodes' | 'edges'): string[] =>
  m.storeOf(id).query<{ gid: string }>(`SELECT hex(gid) AS gid FROM ${table} ORDER BY id`).map((r) => r.gid);

describe('rev — the post-write refresh (compiled path)', () => {
  test('a created vertex has a rev: gen 1, a 128-bit hash', async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").property("name","marko").property("age",29)', {});
    const [rev] = revs(m, 'g', 'nodes');
    expect(rev!.gen).toBe(1);
    expect(rev!.hash).toMatch(/^[0-9a-f]{32}$/);
  });

  test('identical content converges to the same rev across independent graphs (gid still differs)', async () => {
    const m = mgr();
    const q = 'g.addV("person").property("name","marko").property("age",29)';
    await m.executor('a').framedAsync(q, {});
    await m.executor('b').framedAsync(q, {});
    expect(revs(m, 'a', 'nodes')[0]).toEqual(revs(m, 'b', 'nodes')[0]); // same content → same rev
    expect(gids(m, 'a', 'nodes')[0]).not.toBe(gids(m, 'b', 'nodes')[0]); // but independent identity
  });

  test('different content diverges', async () => {
    const m = mgr();
    await m.executor('a').framedAsync('g.addV("person").property("name","marko")', {});
    await m.executor('b').framedAsync('g.addV("person").property("name","vadas")', {});
    expect(revs(m, 'a', 'nodes')[0]!.hash).not.toBe(revs(m, 'b', 'nodes')[0]!.hash);
  });

  test('label set is part of the content', async () => {
    const m = mgr();
    await m.executor('a').framedAsync('g.addV("person")', {});
    await m.executor('b').framedAsync('g.addV("software")', {});
    expect(revs(m, 'a', 'nodes')[0]!.hash).not.toBe(revs(m, 'b', 'nodes')[0]!.hash);
  });

  test('a property() mutation on an existing vertex chains the rev (gen 2, new hash)', async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").property("name","marko")', {});
    const before = revs(m, 'g', 'nodes')[0]!;
    expect(before.gen).toBe(1);
    await m.executor('g').framedAsync('g.V().property("age",29)', {});
    const after = revs(m, 'g', 'nodes')[0]!;
    expect(after.gen).toBe(2); // chained from the parent
    expect(after.hash).not.toBe(before.hash); // content changed (age added) and lineage chained
  });

  test('a property() REMOVAL (property(k,null)) chains the rev', async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").property("name","marko").property("age",29)', {});
    const before = revs(m, 'g', 'nodes')[0]!;
    await m.executor('g').framedAsync('g.V().property("age",null)', {}); // TinkerPop removal rule
    const after = revs(m, 'g', 'nodes')[0]!;
    expect(after.gen).toBe(2);
    expect(after.hash).not.toBe(before.hash);
  });

  test('properties().drop() chains the owner element rev', async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").property("name","marko").property("age",29)', {});
    const before = revs(m, 'g', 'nodes')[0]!;
    await m.executor('g').framedAsync('g.V().properties("age").drop()', {});
    const after = revs(m, 'g', 'nodes')[0]!;
    expect(after.gen).toBe(2);
    expect(after.hash).not.toBe(before.hash);
  });

  test('a label mutation (addLabel/dropLabel) chains the rev', async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person")', {});
    const before = revs(m, 'g', 'nodes')[0]!;
    await m.executor('g').framedAsync('g.V().addLabel("employee")', {});
    const after = revs(m, 'g', 'nodes')[0]!;
    expect(after.gen).toBe(2);
    expect(after.hash).not.toBe(before.hash); // the label set is part of the content
  });

  test("mergeV onMatch chains the matched element's rev; a pure match does not", async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").property("name","marko")', {});
    const born = revs(m, 'g', 'nodes')[0]!;
    // A pure match with no writes leaves the element untouched — no rev bump.
    await m.executor('g').framedAsync('g.mergeV([(T.label):"person","name":"marko"])', {});
    expect(revs(m, 'g', 'nodes')[0]!.gen).toBe(born.gen);
    // onMatch mutates it — the rev chains.
    await m.executor('g').framedAsync('g.mergeV([(T.label):"person","name":"marko"]).option(Merge.onMatch,["age":29])', {});
    const after = revs(m, 'g', 'nodes')[0]!;
    expect(after.gen).toBe(2);
    expect(after.hash).not.toBe(born.hash);
  });

  test('an untouched element keeps its rev while a sibling mutates', async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").property("name","a").addV("person").property("name","b")', {});
    const before = revs(m, 'g', 'nodes');
    // Mutate only the first vertex.
    await m.executor('g').framedAsync('g.V().has("name","a").property("age",1)', {});
    const after = revs(m, 'g', 'nodes');
    expect(after[0]!.gen).toBe(2); // mutated
    expect(after[1]!).toEqual(before[1]!); // untouched — same rev, no spurious bump
  });

  test('a multi-table chain gives every element a rev; the edge rev references endpoint gids', async () => {
    const m = mgr();
    await m.executor('g').framedAsync(
      'g.addV("person").as("a").addV("person").as("b").addE("knows").from("a").to("b").property("weight",0.5)', {});
    const vRevs = revs(m, 'g', 'nodes'), eRevs = revs(m, 'g', 'edges');
    expect(vRevs).toHaveLength(2);
    expect(eRevs).toHaveLength(1);
    for (const r of [...vRevs, ...eRevs]) { expect(r.gen).toBe(1); expect(r.hash).toMatch(/^[0-9a-f]{32}$/); }
    // The edge's rev incorporates its endpoint gids, so it is distinct from a bare-label edge's rev in
    // a graph whose endpoints have different gids.
    const other = mgr();
    await other.executor('g').framedAsync(
      'g.addV("person").as("a").addV("person").as("b").addE("knows").from("a").to("b").property("weight",0.5)', {});
    expect(eRevs[0]!.hash).not.toBe(revs(other, 'g', 'edges')[0]!.hash); // different endpoint gids → different edge rev
  });
});

// Phase 1 item 2: rev through the bulk/format path — a mogwai GraphSON dump carries `rev`, so an io()
// round-trip PRESERVES it (idempotent replay); a rev-less load COMPUTES one via the single refresh
// authority, so it converges with the compiled path for identical content.
describe('rev — the bulk/format path', () => {
  const store = (): GraphStore => new GraphStore(new BunSqlite(':memory:'));
  const storeRevs = (s: GraphStore, table: 'nodes' | 'edges'): Rev[] =>
    s.query<{ rev: string | null }>(`SELECT json(rev) AS rev FROM ${table} ORDER BY id`).map((r) => JSON.parse(r.rev!) as Rev);

  test('a GraphSON round-trip PRESERVES rev verbatim, including a chained generation', async () => {
    const m = mgr();
    await m.executor('g').framedAsync(
      'g.addV("person").as("a").addV("person").as("b").addE("knows").from("a").to("b").property("weight",0.5)', {});
    await m.executor('g').framedAsync('g.V().limit(1).property("age",29)', {}); // bump one vertex to gen 2
    const srcV = revs(m, 'g', 'nodes'), srcE = revs(m, 'g', 'edges');
    expect(srcV.some((r) => r.gen === 2)).toBe(true); // a mutated vertex exists

    const dump = writeGraphson(m.storeOf('g'));
    const reloaded = store();
    loadGraphson(reloaded, dump);
    expect(storeRevs(reloaded, 'nodes')).toEqual(srcV); // preserved verbatim, gen and hash
    expect(storeRevs(reloaded, 'edges')).toEqual(srcE);
  });

  test('a rev-LESS bulk load COMPUTES a rev that converges with the compiled path', async () => {
    // Same content two ways: a compiled create, and a rev-less bulk load.
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").property("name","marko").property("age",29)', {});
    const compiled = revs(m, 'g', 'nodes')[0]!;

    const bulk = store();
    loadBulk(bulk, [{ id: 1, labels: ['person'], properties: [{ key: 'name', value: 'marko' }, { key: 'age', value: 29 }] }]);
    const computed = storeRevs(bulk, 'nodes')[0]!;
    expect(computed).toEqual(compiled); // one authority (refresh.ts) → identical content, identical rev
  });

  test('a bulk load without rev mints a fresh rev; the dirty flag is cleared afterwards', () => {
    const bulk = store();
    loadBulk(bulk, [{ id: 1, labels: ['person'], properties: [{ key: 'name', value: 'a' }] }]);
    expect(storeRevs(bulk, 'nodes')[0]!.gen).toBe(1);
    expect(bulk.query<{ n: number }>('SELECT count(*) AS n FROM nodes WHERE dirty')[0]!.n).toBe(0);
  });
});
