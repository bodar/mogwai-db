import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';

// SEQUENTIAL barrier chaining — two OLAP DECORATE barriers in one traversal
// (`pageRank().connectedComponent()`). Each is a segment: the first runs, decorates the live stream,
// and the resume re-plans its tail — which still holds the second `call()`, so `planOf` makes IT a
// segment too, reading THROUGH the first decoration and stacking its own on the resume. Both scores
// therefore compose onto the final element stream, and the plan holds both landed `barrier_state` CTEs
// (self-declared by the `decorateGraph` stack). No official corpus scenario chains OLAP steps, so this
// is our own safety net for the composition (root CLAUDE.md: X works, Y works ⇒ X-then-Y must work).
// Substrate: docs/2026-08-23-barrier-substrate-reshape-plan.md §7 item 4.

const PR = 'gremlin.pageRankVertexProgram.pageRank';
const CC = 'gremlin.connectedComponentVertexProgram.component';
const unmap = (v: any): any => v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, unmap(x)])) : v;
const run = async (store: ReturnType<typeof seeded>, gremlin: string): Promise<unknown[]> =>
  Promise.all((await exec(store).framedAsync(gremlin, {})).map((f) => decode(f.buf)));

describe('sequential barrier chaining — pageRank() then connectedComponent()', () => {
  test('the SECOND barrier decorates over the first — component id lands on every vertex', async () => {
    const store = seeded(MODERN_SEED);
    // modern is one undirected component, so every component id is "1" (marko's external id).
    const rows = (await run(store, `g.V().pageRank().connectedComponent().project("name","${CC}").by("name").by("${CC}")`)).map(unmap);
    expect(Object.fromEntries(rows.map((r: any) => [r.name, r[CC]]))).toEqual({
      marko: '1', vadas: '1', lop: '1', josh: '1', ripple: '1', peter: '1',
    });
  });

  test('the FIRST barrier survives the second — both scores readable on the final stream', async () => {
    const store = seeded(MODERN_SEED);
    const both = (await run(store, `g.V().pageRank().connectedComponent().project("${PR}","${CC}").by("${PR}").by("${CC}")`)).map(unmap);
    expect(both.length).toBe(6);
    // pageRank stays a REAL score (its own layer's binding), the component a string id (wcc's layer).
    expect(both.every((r: any) => typeof r[PR] === 'number' && r[PR] > 0 && r[CC] === '1')).toBe(true);
  });

  test('chaining does NOT corrupt the first algorithm — pageRank scores equal the standalone run', async () => {
    const store = seeded(MODERN_SEED);
    const alone = (await run(store, `g.V().pageRank().project("name","${PR}").by("name").by("${PR}")`)).map(unmap);
    const chained = (await run(store, `g.V().pageRank().connectedComponent().project("name","${PR}").by("name").by("${PR}")`)).map(unmap);
    const byName = (rs: any[]) => Object.fromEntries(rs.map((r: any) => [r.name, r[PR]]));
    expect(byName(chained)).toEqual(byName(alone));
  });

  test('reverse order composes too — connectedComponent() then pageRank()', async () => {
    const store = seeded(MODERN_SEED);
    // The pageRank score is readable off the twice-decorated stream; every vertex has one.
    expect(await run(store, `g.V().connectedComponent().pageRank().has("${PR}").count()`)).toEqual([6]);
    expect(await run(store, `g.V().connectedComponent().pageRank().has("${CC}").count()`)).toEqual([6]);
  });

  test('order().by(a-score) after a chained barrier composes over the stacked decoration', async () => {
    const store = seeded(MODERN_SEED);
    // wcc id is constant here, so order by name after both barriers is a clean total order.
    expect(await run(store, `g.V().pageRank().connectedComponent().order().by("name").values("name")`))
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });
});
