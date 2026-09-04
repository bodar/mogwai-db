import { test, expect, describe } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { changesFeed } from '../src/manager.ts';
import { makeRouter } from '../src/router.ts';
import type { ChangesFeed } from '../src/api.ts';

// Filtered replication F1a — the SOURCE-side selector (docs/2026-09-04-filtered-replication-plan.md §2/§9).
// A captured vertex-selector traversal (`Executor.filterVertexIds`) yields the matched vertices; `changesFeed`
// restricts the live feed to those matches PLUS their 1-hop edge-closure (the boundary endpoints their edges
// reach, and those edges), still shipping ALL tombstones. Never transitive, valid by construction.

const setup = async () => {
  const mgr = new BunGraphManager(undefined, standardRegistry);
  const exec = mgr.executor('g');
  // v1 task, v2 person(dan), v3 task, v4 person(eve, unconnected); e1 dan-assigned->task1, e2 task1-blocks->task3.
  await exec.framedAsync(
    `g.addV("task").property("name","t1").as("t1")
      .addV("person").property("name","dan").as("dan")
      .addV("task").property("name","t3").as("t3")
      .addV("person").property("name","eve").as("eve")
      .addE("assigned").from("dan").to("t1")
      .addE("blocks").from("t1").to("t3")`, {});
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
