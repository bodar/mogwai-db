import { test, expect, describe } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { applyChanges, applyWire, bulkGet, conflictsFor } from '../src/replicate.ts';
import type { GraphStore } from '../src/storage.ts';

// Phase 4 step 4d (docs/archive/2026-09-02-replication-and-http-interop-plan.md §6·3): the referential rule (no
// CouchDB analog) + resurrect-on-upsert. A vertex delete a live edge still references is REFUSED — the
// edge is an existence-claim, so the vertex is resurrected (kept live, no tombstone) and the delete is
// surfaced. A live version likewise supersedes a local tombstone (not-deleted beats deleted). Neither
// rejects the delete nor drops the edge; the live graph stays consistent by construction.

const mgr = () => new BunGraphManager(undefined, standardRegistry);
const n = (s: GraphStore, sql: string, ...binds: unknown[]) => s.query<{ n: number }>(sql, binds)[0]!.n;
const gidOf = (s: GraphStore, name: string) =>
  s.query<{ gid: string }>("SELECT hex(n.gid) AS gid FROM nodes n JOIN vertex_properties p ON p.node = n.id WHERE p.key = 'name' AND p.value = ?", [name])[0]!.gid;
const revOf = (s: GraphStore, gid: string) =>
  s.query<{ rev: string }>('SELECT json(rev) AS rev FROM nodes WHERE hex(gid) = ?', [gid])[0]!.rev;

describe('replication — the referential rule + resurrect (§6·3)', () => {
  test('deleting a vertex a live edge references RESURRECTS it and surfaces the delete', async () => {
    const m = mgr();
    await m.executor('g').framedAsync(
      'g.addV("person").property("name","v").as("a").addV("person").property("name","w").as("b").addE("knows").from("a").to("b")', {});
    const s = m.storeOf('g');
    const vGid = gidOf(s, 'v'); // v is the edge's SOURCE — a live edge references it

    applyChanges(s, { deletes: [{ gid: vGid, rev: revOf(s, vGid), kind: 'vertex' }] });

    expect(n(s, 'SELECT count(*) AS n FROM nodes WHERE hex(gid) = ?', vGid)).toBe(1); // resurrected — still live
    expect(n(s, 'SELECT count(*) AS n FROM edges')).toBe(1); // edge intact, not dangling
    expect(n(s, 'SELECT count(*) AS n FROM tombstones')).toBe(0); // never tombstoned
    const surfaced = conflictsFor(s, vGid);
    expect(surfaced).toHaveLength(1); // the delete is surfaced, not lost
    expect((surfaced[0]!.doc as { deleted?: boolean }).deleted).toBe(true);
  });

  test('a normal delete (no referencing edge) propagates — removed + tombstoned', async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").property("name","u")', {});
    const s = m.storeOf('g');
    const uGid = gidOf(s, 'u');
    applyChanges(s, { deletes: [{ gid: uGid, rev: revOf(s, uGid), kind: 'vertex' }] });
    expect(n(s, 'SELECT count(*) AS n FROM nodes WHERE hex(gid) = ?', uGid)).toBe(0); // removed
    expect(n(s, 'SELECT count(*) AS n FROM tombstones WHERE hex(gid) = ?', uGid)).toBe(1); // tombstoned
  });

  test('delete-vs-CONCURRENT-edit: the live edit wins, the delete is surfaced (not-deleted beats deleted)', async () => {
    // Two peers diverge: one deletes V, the other edits V (same element, no referencing edge). The edit
    // must win and the delete be surfaced — proven order-independently through the loop.
    let router: import('../src/api.ts').Http;
    const m = new BunGraphManager(undefined, standardRegistry, undefined, undefined, undefined, (req) => router(req));
    router = (await import('../src/router.ts')).makeRouter(m);
    const url = (g: string) => `http://peer/gremlin/${g}`;
    const feed = async (g: string) => (await router(new Request(`${url(g)}/_changes?since=0`))).json() as Promise<import('../src/api.ts').ChangesFeed>;
    await m.executor('seed').framedAsync('g.addV("person").property("name","v")', {});
    for (const g of ['a', 'b']) await m.replicate(g, { source: url('seed') });
    await m.executor('a').framedAsync('g.V().property("age",99)', {}); // a EDITS V
    await m.executor('b').framedAsync('g.V().drop()', {}); // b DELETES V (concurrent)

    await m.replicate('a', { source: url('b') }); // a gets b's delete of a rev it has concurrently edited
    await m.replicate('b', { source: url('a') }); // b gets a's live edit — resurrects

    // Both converge on V LIVE (the edit won), with the delete surfaced.
    const gid = (await feed('a')).results.find((r) => !r.deleted)!.id;
    expect((await m.info('a')).vertexCount).toBe(1);
    expect((await m.info('b')).vertexCount).toBe(1);
    expect(conflictsFor(m.storeOf('a'), gid).some((c) => (c.doc as { deleted?: boolean }).deleted)).toBe(true);
    expect(conflictsFor(m.storeOf('b'), gid).some((c) => (c.doc as { deleted?: boolean }).deleted)).toBe(true);
    // The edit's content survived on both.
    for (const g of ['a', 'b'])
      expect(n(m.storeOf(g), "SELECT count(*) AS n FROM vertex_properties p JOIN nodes nn ON nn.id=p.node WHERE hex(nn.gid)=? AND p.key='age'", gid)).toBe(1);
  });

  test('resurrect-on-upsert: a live version supersedes a local tombstone, surfacing the delete', async () => {
    const m = mgr();
    await m.executor('g').framedAsync('g.addV("person").property("name","v").property("age",29)', {});
    const s = m.storeOf('g');
    const vGid = gidOf(s, 'v');
    const wire = bulkGet(s, [{ gid: vGid, kind: 'vertex' }]); // capture V's live version

    applyChanges(s, { deletes: [{ gid: vGid, rev: revOf(s, vGid), kind: 'vertex' }] }); // delete it (no edges)
    expect(n(s, 'SELECT count(*) AS n FROM nodes WHERE hex(gid) = ?', vGid)).toBe(0);
    expect(n(s, 'SELECT count(*) AS n FROM tombstones WHERE hex(gid) = ?', vGid)).toBe(1);

    applyWire(s, wire); // a live version arrives → resurrect
    expect(n(s, 'SELECT count(*) AS n FROM nodes WHERE hex(gid) = ?', vGid)).toBe(1); // back
    expect(n(s, 'SELECT count(*) AS n FROM tombstones WHERE hex(gid) = ?', vGid)).toBe(0); // tombstone dropped
    expect(conflictsFor(s, vGid).some((c) => (c.doc as { deleted?: boolean }).deleted)).toBe(true); // surfaced
    // Content came back intact.
    expect(n(s, "SELECT count(*) AS n FROM vertex_properties p JOIN nodes nn ON nn.id = p.node WHERE hex(nn.gid) = ? AND p.key = 'age'", vGid)).toBe(1);
  });
});
