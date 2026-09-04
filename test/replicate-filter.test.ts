import { test, expect, describe } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { changesFeed } from '../src/manager.ts';
import { makeRouter } from '../src/router.ts';
import { runReplication, remotePeer, localPeer, replicationId, peerForRef, validateReplicationFilter, type Checkpoint } from '../src/replicate.ts';
import { ReplicatorStore, storeRegistry } from '../src/replicator-registry.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import type { ChangesFeed, Http } from '../src/api.ts';

// The task/person subgraph the F1 tests select over: 2 tasks, 2 people (eve unconnected),
// dan-assigned->t1, t1-blocks->t3. `hasLabel("task")` closes to {t1, t3, dan} + both edges; eve is dropped.
const TASK_GRAPH =
  `g.addV("task").property("name","t1").as("t1")
    .addV("person").property("name","dan").as("dan")
    .addV("task").property("name","t3").as("t3")
    .addV("person").property("name","eve").as("eve")
    .addE("assigned").from("dan").to("t1")
    .addE("blocks").from("t1").to("t3")`;

// Filtered replication F1a — the SOURCE-side selector (docs/archive/2026-09-04-filtered-replication-plan.md §2/§9).
// A captured vertex-selector traversal (`Executor.filterVertexIds`) yields the matched vertices; `changesFeed`
// restricts the live feed to those matches PLUS their 1-hop edge-closure (the boundary endpoints their edges
// reach, and those edges), still shipping ALL tombstones. Never transitive, valid by construction.

const setup = async () => {
  const mgr = new BunGraphManager(undefined, standardRegistry);
  const exec = mgr.executor('g');
  await exec.framedAsync(TASK_GRAPH, {});
  return { mgr, exec, store: mgr.storeOf('g') };
};

describe('filterVertexIds — the captured vertex-selector', () => {
  test('yields the matched vertices’ external ids', async () => {
    const { exec } = await setup();
    const ids = exec.filterVertexIds('g.V().hasLabel("task")');
    expect(ids).toHaveLength(2); // t1, t3
    expect(ids.every((i) => typeof i === 'number')).toBe(true); // no uid → the rowid
  });

  test('fails closed on a non-vertex terminal — scalar, edge, or write', async () => {
    const { exec } = await setup();
    expect(() => exec.filterVertexIds('g.V().count()')).toThrow(/vertex stream/); // scalar
    expect(() => exec.filterVertexIds('g.E()')).toThrow(/vertex stream/);          // edge
    expect(() => exec.filterVertexIds('g.addV("x")')).toThrow(/not a write/);      // write
    expect(() => exec.filterVertexIds('g.V().values("name")')).toThrow(/vertex stream/); // value stream
  });
});

describe('changesFeed with a match set — the 1-hop edge-closed feed', () => {
  test('restricts to matches + boundary endpoints + incident edges, dropping the unconnected vertex', async () => {
    const { exec, store } = await setup();
    const full = changesFeed(store, 0);
    expect(full.results.filter((r) => r.kind === 'vertex')).toHaveLength(4);
    expect(full.results.filter((r) => r.kind === 'edge')).toHaveLength(2);

    const match = exec.filterVertexIds('g.V().hasLabel("task")'); // t1, t3
    const filtered = changesFeed(store, 0, undefined, match);
    // Closure: {t1, t3} matched + {dan} boundary (assigned-edge endpoint) = 3 vertices; both edges incident.
    // eve is unconnected to any task, so she is NOT pulled in.
    expect(filtered.results.filter((r) => r.kind === 'vertex')).toHaveLength(3);
    expect(filtered.results.filter((r) => r.kind === 'edge')).toHaveLength(2);
    // The boundary pulled the person in — 3, not the 2 matched tasks (the load-bearing closure assertion).
    const fullVertexIds = new Set(full.results.filter((r) => r.kind === 'vertex').map((r) => r.id));
    const filteredVertexIds = new Set(filtered.results.filter((r) => r.kind === 'vertex').map((r) => r.id));
    expect(filteredVertexIds.size).toBe(3);
    expect([...fullVertexIds].filter((id) => !filteredVertexIds.has(id))).toHaveLength(1); // exactly eve dropped
  });

  test('an empty match set ships no live elements (only tombstones)', async () => {
    const { exec, store } = await setup();
    const match = exec.filterVertexIds('g.V().hasLabel("nonexistent")');
    expect(match).toHaveLength(0);
    const filtered = changesFeed(store, 0, undefined, match);
    expect(filtered.results.filter((r) => !r.deleted)).toHaveLength(0);
  });

  test('tombstones ride the filtered feed regardless of the match (§4 deletes always propagate)', async () => {
    const { exec, store } = await setup();
    await exec.framedAsync('g.V().has("name","eve").drop()', {}); // eve was never in the closure
    const match = exec.filterVertexIds('g.V().hasLabel("task")');
    const filtered = changesFeed(store, 0, undefined, match);
    const deletes = filtered.results.filter((r) => r.deleted);
    expect(deletes).toHaveLength(1); // eve's tombstone ships even though she is out of scope
    expect(deletes[0]!.kind).toBe('vertex');
  });
});

describe('the _changes endpoint carries the filter — GET query + POST body', () => {
  const FILTER = 'g.V().hasLabel("task")';
  const withRouter = async () => {
    const { mgr } = await setup();
    return makeRouter(mgr);
  };

  test('GET ?filter= returns the 1-hop edge-closed subgraph', async () => {
    const http = await withRouter();
    const res = await http(new Request(`http://x/gremlin/g/_changes?since=0&filter=${encodeURIComponent(FILTER)}`));
    expect(res.status).toBe(200);
    const feed = (await res.json()) as ChangesFeed;
    expect(feed.results.filter((r) => r.kind === 'vertex')).toHaveLength(3); // 2 tasks + boundary person
    expect(feed.results.filter((r) => r.kind === 'edge')).toHaveLength(2);
  });

  test('POST {filter} returns the same subgraph (the arbitrary-length carrier)', async () => {
    const http = await withRouter();
    const res = await http(new Request('http://x/gremlin/g/_changes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since: 0, filter: FILTER }),
    }));
    expect(res.status).toBe(200);
    const feed = (await res.json()) as ChangesFeed;
    expect(feed.results.filter((r) => r.kind === 'vertex')).toHaveLength(3);
    expect(feed.results.filter((r) => r.kind === 'edge')).toHaveLength(2);
  });

  test('a non-vertex filter fails closed with a 400 (both verbs)', async () => {
    const http = await withRouter();
    const bad = 'g.V().count()';
    const g = await http(new Request(`http://x/gremlin/g/_changes?filter=${encodeURIComponent(bad)}`));
    expect(g.status).toBe(400);
    expect(((await g.json()) as { error: string }).error).toMatch(/vertex stream/);
    const p = await http(new Request('http://x/gremlin/g/_changes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filter: bad }),
    }));
    expect(p.status).toBe(400);
  });
});

describe('F1b — a configured/one-shot replication pulls only the filtered subgraph', () => {
  // Two graphs behind one in-memory router (the manager's http loops back), so a remote peer runs the
  // whole hop in memory — the same discipline the paging tests use.
  const twoGraph = async () => {
    let router: Http;
    const mgr = new BunGraphManager(undefined, standardRegistry, undefined, undefined, undefined, (req) => router(req));
    router = makeRouter(mgr);
    await mgr.executor('remote').framedAsync(TASK_GRAPH, {});
    return { mgr, router: router!, url: (g: string) => `http://peer/gremlin/${g}` };
  };
  const FILTER = 'g.V().hasLabel("task")';

  test('runReplication with a filter lands only the 1-hop edge-closed subgraph on the target', async () => {
    const s = await twoGraph();
    const replId = replicationId('pull', s.url('remote'), 'local');
    const cp: Checkpoint = { read: () => s.mgr.checkpoint('local', replId), write: async (seq) => { await s.mgr.checkpoint('local', replId, seq); } };
    const stats = await runReplication(remotePeer(s.router, s.url('remote')), localPeer(s.mgr, 'local'), cp, {}, FILTER);
    expect(stats.written).toBe(5); // 3 vertices (t1, t3, dan) + 2 edges — eve is NOT pulled
    const info = await s.mgr.info('local');
    expect(info).toEqual({ vertexCount: 3, edgeCount: 2 });
  });

  test('the one-shot _replicate endpoint carries the filter in its body (ReplicateOptions.filter)', async () => {
    const s = await twoGraph();
    const res = await s.router(new Request(`${s.url('local')}/_replicate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: s.url('remote'), filter: FILTER }),
    }));
    expect(res.status).toBe(200);
    expect(await s.mgr.info('local')).toEqual({ vertexCount: 3, edgeCount: 2 });
  });

  test('an unfiltered replication still pulls the whole graph (no regression)', async () => {
    const s = await twoGraph();
    const replId = replicationId('pull', s.url('remote'), 'local');
    const cp: Checkpoint = { read: () => s.mgr.checkpoint('local', replId), write: async (seq) => { await s.mgr.checkpoint('local', replId, seq); } };
    await runReplication(remotePeer(s.router, s.url('remote')), localPeer(s.mgr, 'local'), cp, {});
    expect(await s.mgr.info('local')).toEqual({ vertexCount: 4, edgeCount: 2 }); // eve included
  });
});

describe('F2b — placement grafts the current match set into pre-existing target structure', () => {
  // The idempotent edge-attach idiom the engine supports TODAY: guard the addE with `where(not(<existing
  // edge>))`, so re-running each pass never duplicates (mergeE-over-an-incoming-stream is not lowered yet).
  const FILTER = 'g.V().hasLabel("task")';
  const PLACEMENT = 'g.V(matchedIds).where(__.not(__.inE("inbox_holds"))).addE("inbox_holds").from(V().hasLabel("inbox"))';

  // F2b-1 exercises the LOCAL mechanism (both peers via the manager); the remote `_match_set`/`_placement`
  // HTTP endpoints are F2b-2.
  const twoGraph = async () => {
    const mgr = new BunGraphManager(undefined, standardRegistry);
    await mgr.executor('remote').framedAsync(TASK_GRAPH, {});
    await mgr.executor('local').framedAsync('g.addV("inbox")', {}); // the pre-existing target structure
    const replId = replicationId('pull', 'remote', 'local');
    const cp: Checkpoint = { read: () => mgr.checkpoint('local', replId), write: async (seq) => { await mgr.checkpoint('local', replId, seq); } };
    const pull = (placement?: string) => runReplication(localPeer(mgr, 'remote'), localPeer(mgr, 'local'), cp, {}, FILTER, placement);
    const heldCount = () => mgr.storeOf('local').query<{ c: number }>('SELECT count(*) AS c FROM edges e JOIN labels l ON l.id = e.label WHERE l.name = ?', ['inbox_holds'])[0].c;
    return { mgr, pull, heldCount };
  };

  test('placement attaches the matched vertices (only) to the inbox, idempotently', async () => {
    const s = await twoGraph();
    await s.pull(PLACEMENT);
    // The two matched tasks are grafted under the inbox; the boundary person (dan) is NOT matched, eve
    // was never pulled — so exactly 2 inbox_holds edges.
    expect(s.heldCount()).toBe(2);
    // A second pass re-runs the placement over the same match set and MUST NOT duplicate (the guard).
    await s.pull(PLACEMENT);
    expect(s.heldCount()).toBe(2);
  });

  test('a run with no placement lands the subgraph unattached', async () => {
    const s = await twoGraph();
    await s.pull(); // no placement
    expect(s.heldCount()).toBe(0); // nothing grafted
    // The subgraph itself DID land: the closure carries both incident edges (assigned + blocks).
    expect(s.mgr.storeOf('local').query<{ c: number }>('SELECT count(*) AS c FROM edges')[0].c).toBe(2);
  });
});

describe('F2b-2 — the remote placement endpoints (_match_set + _placement over HTTP)', () => {
  const FILTER = 'g.V().hasLabel("task")';
  const PLACEMENT = 'g.V(matchedIds).where(__.not(__.inE("inbox_holds"))).addE("inbox_holds").from(V().hasLabel("inbox"))';
  const held = (mgr: BunGraphManager, g: string) =>
    mgr.storeOf(g).query<{ c: number }>('SELECT count(*) AS c FROM edges e JOIN labels l ON l.id = e.label WHERE l.name = ?', ['inbox_holds'])[0].c;
  const setup = async () => {
    let router: Http;
    const mgr = new BunGraphManager(undefined, standardRegistry, undefined, undefined, undefined, (req) => router(req));
    router = makeRouter(mgr);
    const url = (g: string) => `http://peer/gremlin/${g}`;
    return { mgr, router: router!, url };
  };

  test('_match_set: a remote-source PULL grafts on the local target', async () => {
    const s = await setup();
    await s.mgr.executor('remote').framedAsync(TASK_GRAPH, {}); // the remote source
    await s.mgr.executor('local').framedAsync('g.addV("inbox")', {}); // the local target
    const replId = replicationId('pull', s.url('remote'), 'local');
    const cp: Checkpoint = { read: () => s.mgr.checkpoint('local', replId), write: async (seq) => { await s.mgr.checkpoint('local', replId, seq); } };
    await runReplication(remotePeer(s.router, s.url('remote')), localPeer(s.mgr, 'local'), cp, {}, FILTER, PLACEMENT);
    expect(held(s.mgr, 'local')).toBe(2); // the remote's matched tasks, grafted here
  });

  test('_placement: a PUSH grafts on the remote target', async () => {
    const s = await setup();
    await s.mgr.executor('src').framedAsync(TASK_GRAPH, {}); // the local source
    await s.mgr.executor('backup').framedAsync('g.addV("inbox")', {}); // the remote target
    const replId = replicationId('push', s.url('backup'), 'src');
    const cp: Checkpoint = { read: () => s.mgr.checkpoint('src', replId), write: async (seq) => { await s.mgr.checkpoint('src', replId, seq); } };
    await runReplication(localPeer(s.mgr, 'src'), remotePeer(s.router, s.url('backup')), cp, {}, FILTER, PLACEMENT);
    expect(held(s.mgr, 'backup')).toBe(2); // grafted on the remote target via the _placement endpoint
  });

  test('_match_set rejects a non-vertex filter (400)', async () => {
    const s = await setup();
    await s.mgr.executor('g').framedAsync(TASK_GRAPH, {});
    const res = await s.router(new Request(`${s.url('g')}/_match_set`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filter: 'g.V().count()' }),
    }));
    expect(res.status).toBe(400);
  });
});

describe('F3 — dedicated-target undo (destroy the replica + remove the config)', () => {
  const withRegistry = async () => {
    let router: Http;
    const mgr = new BunGraphManager(undefined, standardRegistry, undefined, undefined, undefined, (req) => router(req));
    const registry = storeRegistry(new ReplicatorStore(new BunSqlite(':memory:')));
    router = makeRouter(mgr, undefined, undefined, registry);
    return { mgr, registry, router: router! };
  };
  const jsonReq = (url: string, method: string, body?: unknown) =>
    new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });

  test('undo destroys a LOCAL target replica and deletes the config', async () => {
    const s = await withRegistry();
    await s.mgr.executor('replica').framedAsync('g.addV("x").addV("y")', {}); // the landed replica
    await s.registry.putConfig({ id: 'j', source: 'http://peer/gremlin/prod', target: 'replica' });
    expect((await s.mgr.info('replica')).vertexCount).toBe(2);
    const res = await s.router(jsonReq('http://h/_replicator/j?destroy_target=true', 'DELETE'));
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ undone: true, target_destroyed: 'replica' });
    expect(await s.registry.getConfig('j')).toBeNull(); // config gone
    expect((await s.mgr.info('replica')).vertexCount).toBe(0); // replica destroyed
  });

  test('a plain DELETE (no destroy_target) removes the config but leaves the target', async () => {
    const s = await withRegistry();
    await s.mgr.executor('replica').framedAsync('g.addV("x")', {});
    await s.registry.putConfig({ id: 'j', source: 'http://peer/gremlin/prod', target: 'replica' });
    expect((await s.router(jsonReq('http://h/_replicator/j', 'DELETE'))).status).toBe(204);
    expect(await s.registry.getConfig('j')).toBeNull();
    expect((await s.mgr.info('replica')).vertexCount).toBe(1); // target untouched
  });

  test('undo of a REMOTE target leaves it (deferred with the shared-target journal)', async () => {
    const s = await withRegistry();
    await s.registry.putConfig({ id: 'push', source: 'local', target: 'http://peer/gremlin/backup' });
    const res = await s.router(jsonReq('http://h/_replicator/push?destroy_target=true', 'DELETE'));
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ undone: true, target_destroyed: null });
    expect(await s.registry.getConfig('push')).toBeNull();
  });
});

describe('F2c-2 — a weak placement edge cascades on a deleted endpoint, never resurrects it (§5)', () => {
  const FILTER = 'g.V().hasLabel("task")';
  const PLACEMENT = 'g.V(matchedIds).where(__.not(__.inE("inbox_holds"))).addE("inbox_holds").from(V().hasLabel("inbox"))';

  const setup = async () => {
    const mgr = new BunGraphManager(undefined, standardRegistry);
    await mgr.executor('src').framedAsync('g.addV("task").property("name","t1")', {}); // one matched vertex
    await mgr.executor('tgt').framedAsync('g.addV("inbox")', {});
    const replId = replicationId('pull', 'src', 'tgt');
    const cp: Checkpoint = { read: () => mgr.checkpoint('tgt', replId), write: async (seq) => { await mgr.checkpoint('tgt', replId, seq); } };
    const pull = () => runReplication(localPeer(mgr, 'src'), localPeer(mgr, 'tgt'), cp, {}, FILTER, PLACEMENT);
    const count = (label: string) => mgr.storeOf('tgt').query<{ c: number }>('SELECT count(*) AS c FROM edges e JOIN labels l ON l.id = e.label WHERE l.name = ?', [label])[0].c;
    const tasks = () => mgr.storeOf('tgt').query<{ c: number }>("SELECT count(*) AS c FROM nodes n JOIN vertex_labels vl ON vl.node=n.id JOIN labels l ON l.id=vl.label WHERE l.name='task'")[0].c;
    return { mgr, pull, count, tasks };
  };

  test('a source delete of the endpoint cascades the weak mount instead of resurrecting the vertex', async () => {
    const s = await setup();
    await s.pull();
    expect(s.tasks()).toBe(1); // t1 landed
    expect(s.count('inbox_holds')).toBe(1); // and got its weak mount edge
    // The source deletes t1 (the matched vertex the weak edge points at).
    await s.mgr.executor('src').framedAsync('g.V().hasLabel("task").drop()', {});
    await s.pull();
    // The weak edge did NOT pin t1: t1 is deleted and its weak mount cascaded with it — not resurrected.
    expect(s.tasks()).toBe(0);
    expect(s.count('inbox_holds')).toBe(0);
    // The inbox itself is untouched.
    expect(s.mgr.storeOf('tgt').query<{ c: number }>("SELECT count(*) AS c FROM nodes n JOIN vertex_labels vl ON vl.node=n.id JOIN labels l ON l.id=vl.label WHERE l.name='inbox'")[0].c).toBe(1);
  });

  test('the cascaded weak edge is tombstoned, so it propagates downstream', async () => {
    const s = await setup();
    await s.pull();
    await s.mgr.executor('src').framedAsync('g.V().hasLabel("task").drop()', {});
    await s.pull();
    // A tombstone exists for an edge kind (the cascaded weak inbox_holds) beyond t1's own vertex tombstone.
    const toms = s.mgr.storeOf('tgt').query<{ kind: string }>('SELECT kind FROM tombstones');
    expect(toms.some((t) => t.kind === 'edge')).toBe(true);
    expect(toms.some((t) => t.kind === 'vertex')).toBe(true);
  });
});

describe('F2c-1 — placement edges are WEAK references, replicated/user edges are STRONG', () => {
  const FILTER = 'g.V().hasLabel("task")';
  const PLACEMENT = 'g.V(matchedIds).where(__.not(__.inE("inbox_holds"))).addE("inbox_holds").from(V().hasLabel("inbox"))';

  test('the synthesized mount edges are marked weak; the replicated ones are not', async () => {
    const mgr = new BunGraphManager(undefined, standardRegistry);
    await mgr.executor('remote').framedAsync(TASK_GRAPH, {});
    await mgr.executor('local').framedAsync('g.addV("inbox")', {});
    const replId = replicationId('pull', 'remote', 'local');
    const cp: Checkpoint = { read: () => mgr.checkpoint('local', replId), write: async (seq) => { await mgr.checkpoint('local', replId, seq); } };
    await runReplication(localPeer(mgr, 'remote'), localPeer(mgr, 'local'), cp, {}, FILTER, PLACEMENT);
    const byLabel = mgr.storeOf('local').query<{ name: string; weak: number }>(
      'SELECT l.name AS name, e.weak AS weak FROM edges e JOIN labels l ON l.id = e.label ORDER BY l.name, e.id');
    const holds = byLabel.filter((r) => r.name === 'inbox_holds');
    expect(holds).toHaveLength(2);
    expect(holds.every((r) => r.weak === 1)).toBe(true); // the placement edges are weak
    // The replicated graph edges (assigned, blocks) are strong.
    expect(byLabel.filter((r) => r.name !== 'inbox_holds').every((r) => r.weak === 0)).toBe(true);
  });

  test('a normal addE creates a STRONG edge (weak defaults to 0)', async () => {
    const mgr = new BunGraphManager(undefined, standardRegistry);
    await mgr.executor('g').framedAsync('g.addV("a").as("x").addV("b").addE("rel").from("x")', {});
    expect(mgr.storeOf('g').query<{ c: number }>('SELECT count(*) AS c FROM edges WHERE weak = 0')[0].c).toBe(1);
    expect(mgr.storeOf('g').query<{ c: number }>('SELECT count(*) AS c FROM edges WHERE weak = 1')[0].c).toBe(0);
  });
});

describe('matchSet — the source-side current match set as gids', () => {
  test('returns the matched vertices’ gids (the full current set, not a delta)', async () => {
    const mgr = new BunGraphManager(undefined, standardRegistry);
    await mgr.executor('g').framedAsync(TASK_GRAPH, {});
    const gids = await mgr.matchSet('g', 'g.V().hasLabel("task")');
    expect(gids).toHaveLength(2); // t1, t3 — not the boundary people
    expect(gids.every((g) => /^[0-9A-F]{32}$/i.test(g))).toBe(true); // hex gids, cross-peer identity
  });
});

describe('F1c — save-time filter validation (run-on-save, not static analysis)', () => {
  const jsonReq = (url: string, body: unknown) =>
    new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

  const withValidation = async () => {
    let router: Http;
    const mgr = new BunGraphManager(undefined, standardRegistry, undefined, undefined, undefined, (req) => router(req));
    await mgr.executor('src').framedAsync(TASK_GRAPH, {}); // the source the filter is validated against
    const registry = storeRegistry(new ReplicatorStore(new BunSqlite(':memory:')));
    const validateFilter = (source: string, filter: string) =>
      validateReplicationFilter(peerForRef(mgr, (req) => router(req), source), filter);
    router = makeRouter(mgr, undefined, undefined, registry, undefined, validateFilter);
    return { router: router!, registry };
  };

  test('a valid vertex-selector filter is accepted at save', async () => {
    const s = await withValidation();
    const res = await s.router(jsonReq('http://h/_replicator', { id: 'j', source: 'src', target: 'local', filter: 'g.V().hasLabel("task")' }));
    expect(res.status).toBe(201);
    expect(await s.registry.getConfig('j')).toMatchObject({ filter: 'g.V().hasLabel("task")' });
  });

  test('a non-vertex filter is REJECTED at save (400) and NOT stored — fail-closed', async () => {
    const s = await withValidation();
    const res = await s.router(jsonReq('http://h/_replicator', { id: 'bad', source: 'src', target: 'local', filter: 'g.V().count()' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/filter rejected/);
    expect(await s.registry.getConfig('bad')).toBeNull(); // nothing persisted
  });

  test('a config without a filter skips validation', async () => {
    const s = await withValidation();
    const res = await s.router(jsonReq('http://h/_replicator', { id: 'plain', source: 'src', target: 'local' }));
    expect(res.status).toBe(201);
  });
});
