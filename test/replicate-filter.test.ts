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

// Filtered replication F1a — the SOURCE-side selector (docs/2026-09-04-filtered-replication-plan.md §2/§9).
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
