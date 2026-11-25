import { test, expect, describe } from 'bun:test';
import { decodeRev } from '../src/rev.ts';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { makeRouter } from '../src/router.ts';
import { changesFeed, revsDiff } from '../src/manager.ts';
import { localPeer, runReplication, applyWire, bulkGet, validateReplicationFilter, type Checkpoint } from '../src/replicate.ts';
import { loadBulk } from '../src/bulk.ts';
import { writeGraphson, writeGraphsonToSink, loadGraphson } from '../src/formats/graphson.ts';
import { writeCsv } from '../src/formats/csv.ts';
import { ReplicatorStore, storeRegistry } from '../src/replicator-registry.ts';
import { runDueReplications } from '../src/scheduler.ts';
import type { ChangesFeed, Http } from '../src/api.ts';
import type { GraphStore } from '../src/storage.ts';

// Replication metadata ON DEMAND (docs/2026-11-25-storage-density-plan.md S3, `src/refresh.ts`). A graph
// computes and stores no gid, rev or seq until it first EXPOSES identity — a replication call or a GraphSON
// export. Enabling backfills the earlier elements in resumable rowid pages, vertices before edges.

const mgr = (http?: Http) => new BunGraphManager(undefined, standardRegistry, undefined, undefined, undefined, http);
const run = (m: BunGraphManager, g: string, q: string) => m.executor(g).framedAsync(q, {});
const meta = (s: GraphStore, table: 'nodes' | 'edges') =>
  s.query<{ id: number; gid: string; rev: string | null; seq: number | null }>(
    `SELECT id, hex(gid) AS gid, nullif(hex(rev), '') AS rev, seq FROM ${table} ORDER BY id`);
const memCp = (): Checkpoint => { let s = 0; return { read: async () => s, write: async (v) => { s = v; } }; };
const count = (s: GraphStore, sql: string) => s.query<{ n: number }>(sql)[0]!.n;

/** 5 vertices, 3 edges, written before anything exposed identity. */
const FIVE_THREE = `g.addV('p').property('n',0).as('a').addV('p').property('n',1).as('b').addV('p').property('n',2).as('c')
  .addV('p').property('n',3).addV('p').property('n',4)
  .addE('k').from('a').to('b').addE('k').from('b').to('c').addE('k').from('c').to('a')`;

describe('replication metadata on demand', () => {
  test('a write before any replication call or export stores no gid, rev or seq', async () => {
    const m = mgr();
    await run(m, 'g', "g.addV('p').as('a').addV('p').addE('k').from('a')");
    await run(m, 'g', "g.V().property('x', 1)");
    const s = m.storeOf('g');
    for (const t of ['nodes', 'edges'] as const)
      for (const r of meta(s, t)) expect([r.gid, r.rev, r.seq]).toEqual(['', null, null]);
    // CSV carries no identity and leaves the graph off.
    writeCsv(s);
    expect(meta(s, 'nodes')[0]!.seq).toBeNull();
  });

  test('a paged first _changes drains every element once, vertices before edges, truncated until done', async () => {
    const m = mgr();
    await run(m, 'g', FIVE_THREE);
    const http = makeRouter(m);
    const seen: ChangesFeed['results'][number][] = [];
    let since = 0, pages = 0;
    for (;;) {
      const f = (await (await http(new Request(`http://x/gremlin/g/_changes?since=${since}&limit=2`))).json()) as ChangesFeed;
      seen.push(...f.results);
      since = f.last_seq;
      if (++pages > 20) throw new Error('feed never drained');
      if (!f.truncated) break;
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen.map((r) => r.id)).size).toBe(8);
    expect(seen.map((r) => r.kind)).toEqual(['vertex', 'vertex', 'vertex', 'vertex', 'vertex', 'edge', 'edge', 'edge']);
    for (const r of seen) expect(r.rev!.gen).toBe(1);
  });

  test('a post-enable edge between pre-enable vertices gives them seqs below the edge', async () => {
    const m = mgr();
    await run(m, 'g', "g.addV('p').property('n','v').addV('p').property('n','w')");
    const s = m.storeOf('g');
    changesFeed(s, 0, 1); // enable; backfill one element only, so one endpoint is still un-sequenced
    await run(m, 'g', "g.V().has('n','v').as('v').V().has('n','w').addE('k').from('v')");
    const [v, w] = meta(s, 'nodes');
    const e = meta(s, 'edges')[0]!;
    expect(v!.seq).not.toBeNull();
    expect(w!.seq).not.toBeNull();
    expect(w!.gid).toMatch(/^[0-9A-F]{32}$/);
    expect(Math.max(v!.seq!, w!.seq!)).toBeLessThan(e.seq!);
    // The backfill then finds nothing left: every element appears once in the feed.
    const all = changesFeed(s, 0);
    expect(all.results.map((r) => r.kind)).toEqual(['vertex', 'vertex', 'edge']);
  });

  test('seed-from-dump: a replica loaded from a GraphSON dump holds every element; replication adds none', async () => {
    const m = mgr();
    await run(m, 'a', FIVE_THREE);
    const dump = writeGraphson(m.storeOf('a')); // the export turns A on and backfills it
    loadGraphson(m.storeOf('b'), dump);
    const offer: Record<string, { gen: number; hash: string }[]> = {};
    for (const r of changesFeed(m.storeOf('a'), 0).results) offer[r.id] = [r.rev!];
    expect(revsDiff(m.storeOf('b'), offer)).toEqual({}); // B already holds every rev
    const stats = await runReplication(localPeer(m, 'a'), localPeer(m, 'b'), memCp());
    expect(stats.written).toBe(0);
    expect((await m.info('b'))).toEqual({ vertexCount: 5, edgeCount: 3 });
  });

  test('a preserved rev is kept current while off, and the change reaches a peer after enable', async () => {
    const m = mgr();
    await run(m, 'a', "g.addV('p').property('n',1)");
    const dump = writeGraphson(m.storeOf('a'));
    const peer = m.storeOf('peer');
    loadGraphson(peer, dump); // the peer holds the old rev
    const b = m.storeOf('b');
    loadGraphson(b, dump); // b: replication off, but carrying a lineage
    await run(m, 'b', "g.V().property('x', 1)");
    const row = meta(b, 'nodes')[0]!;
    expect(decodeRev(row.rev)!.gen).toBe(2);
    expect(row.seq).toBeNull();
    await runReplication(localPeer(m, 'b'), localPeer(m, 'peer'), memCp());
    expect(decodeRev(meta(peer, 'nodes')[0]!.rev)!.gen).toBe(2);
    expect(peer.query<{ n: number }>("SELECT count(*) AS n FROM vertex_properties WHERE key = 'x'")[0]!.n).toBe(1);
  });

  test('drop() before enable leaves no tombstone; drop() of an exported element leaves one', async () => {
    const m = mgr();
    await run(m, 'g', "g.addV('p').property('n',1).addV('p').property('n',2)");
    const s = m.storeOf('g');
    await run(m, 'g', "g.V().has('n',1).drop()");
    expect(count(s, 'SELECT count(*) AS n FROM tombstones')).toBe(0);
    writeGraphson(s);
    await run(m, 'g', "g.V().has('n',2).drop()");
    expect(count(s, 'SELECT count(*) AS n FROM tombstones')).toBe(1);
  });

  test('matchSet on a graph that never replicated returns the matched vertices', async () => {
    const m = mgr();
    await run(m, 'g', FIVE_THREE);
    const gids = await m.matchSet('g', "g.V().has('n', within(1, 3))");
    expect(gids).toHaveLength(2);
    for (const g of gids) expect(g).toMatch(/^[0-9A-F]{32}$/);
    // The backfill then keeps those gids and gives them revs and seqs.
    const feed = changesFeed(m.storeOf('g'), 0);
    for (const g of gids) expect(feed.results.some((r) => r.id === g)).toBe(true);
  });

  test('a replicated uid colliding with a target holder that has no gid reconciles', async () => {
    const m = mgr();
    await run(m, 'src', "g.addV('p').property(T.id, 'shared').property('n','src')");
    await run(m, 'dst', "g.addV('p').property(T.id, 'shared').property('n','dst')");
    const doc = bulkGet(m.storeOf('src'), changesFeed(m.storeOf('src'), 0).results.map((r) => ({ gid: r.id, kind: r.kind })));
    const dst = m.storeOf('dst');
    applyWire(dst, doc);
    // Both elements survive; exactly one holds the uid, the other's claim is surfaced as a conflict.
    expect(count(dst, 'SELECT count(*) AS n FROM nodes')).toBe(2);
    expect(count(dst, "SELECT count(*) AS n FROM nodes WHERE uid = 'shared'")).toBe(1);
    expect(count(dst, 'SELECT count(*) AS n FROM nodes WHERE gid IS NULL AND uid IS NOT NULL')).toBe(0);
    expect(count(dst, 'SELECT count(*) AS n FROM conflicts')).toBe(1);
  });

  test('the scheduler drains a backfill larger than one wake across ticks', async () => {
    let router: Http;
    const httpSeam: Http = (req) => router(req);
    const m = mgr(httpSeam);
    const registry = storeRegistry(new ReplicatorStore(new BunSqlite(':memory:')));
    router = makeRouter(m, undefined, undefined, registry);
    await run(m, 'remote', FIVE_THREE);
    await run(m, 'remote', FIVE_THREE);
    await registry.putConfig({ id: 'j', source: 'http://peer/gremlin/remote', target: 'local', continuous: true });
    const opts = { now: 1, batchSize: 3, maxBatchesPerWake: 2 };
    let ticks = 0;
    for (;;) {
      const r = await runDueReplications({ registry, manager: m, http: httpSeam }, opts);
      ticks++;
      if (!r.outcomes[0]!.more) break;
      if (ticks > 10) throw new Error('never drained');
    }
    expect(ticks).toBeGreaterThan(1);
    expect(await m.info('local')).toEqual({ vertexCount: 10, edgeCount: 6 });
  });
});

// A first filtered call on a graph that never exposed identity must do bounded work: the backfill goes a
// page at a time, never the whole graph in one request (storage density plan, F1).
describe('filtered replication backfills a bounded page', () => {
  /** `n` vertices with no metadata, loaded while replication is off. */
  const seeded = (n: number) => {
    const m = mgr();
    loadBulk(m.storeOf('g'), Array.from({ length: n }, (_, i) => ({ id: i + 1, labels: ['p'], properties: [] })));
    return m;
  };
  const unsequenced = (s: GraphStore) => count(s, 'SELECT count(*) AS n FROM nodes WHERE seq IS NULL');

  test('the first save-time filter validation backfills one element, not the graph', async () => {
    const m = seeded(50);
    await validateReplicationFilter(localPeer(m, 'g'), "g.V().hasLabel('p')");
    expect(unsequenced(m.storeOf('g'))).toBe(49);
  });

  test('a filtered run with batchSize <= 0 pages its backfill and still lands the whole match', async () => {
    const m = seeded(1200);
    const r = await runReplication(localPeer(m, 'g'), localPeer(m, 't'), memCp(), { batchSize: 0 }, "g.V().hasLabel('p')");
    expect(r.batches).toBeGreaterThan(2);
    expect(await m.info('t')).toEqual({ vertexCount: 1200, edgeCount: 0 });
  });
});

// The first streaming GraphSON export of a never-replicated graph backfills page by page, a turn each, so
// on a DO no single turn or transaction holds the whole backfill (storage density plan, F2).
describe('the streaming GraphSON export backfills in pages', () => {
  test('the backfill advances one page before the first await, and every line still carries gid and rev', async () => {
    const m = mgr();
    const s = m.storeOf('g');
    const n = 2500;
    loadBulk(s, Array.from({ length: n }, (_, i) => ({ id: i + 1, labels: ['p'], properties: [] })),
      Array.from({ length: n - 1 }, (_, i) => ({ id: i + 1, label: 'k', src: i + 1, tgt: i + 2, properties: [] })));
    const chunks: Uint8Array[] = [];
    const sink = { write: async (c: Uint8Array) => { chunks.push(c); }, close: async () => {}, abort: async () => {} };
    const exported = writeGraphsonToSink(s, sink);
    // The call ran synchronously up to its first await: exactly one backfill page is done.
    const sequenced = () => count(s, 'SELECT count(*) AS n FROM nodes WHERE seq IS NOT NULL');
    expect(sequenced()).toBe(1000);
    await exported;
    expect(sequenced()).toBe(n);
    expect(count(s, 'SELECT count(*) AS n FROM edges WHERE seq IS NULL')).toBe(0);
    const lines = Buffer.concat(chunks).toString('utf8').split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(n);
    for (const v of lines) {
      expect(v.gid).toMatch(/^[0-9A-F]{32}$/);
      expect(v.rev.gen).toBe(1);
      for (const e of v.outE?.k ?? []) { expect(e.gid).toMatch(/^[0-9A-F]{32}$/); expect(e.rev.gen).toBe(1); }
    }
  });
});
