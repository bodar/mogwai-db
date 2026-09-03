import { test, expect, describe } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';

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
