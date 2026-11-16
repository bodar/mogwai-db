// A DRAW IN A PER-TRAVERSER BODY IS ONE DRAW PER SCOPE ROW — and every reader of it sees that one pick.
//
// The reference hands a child body ONE traverser at a time (`TraversalUtil.apply`,
// vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java),
// so `local(out().sample(1))` draws a neighbour PER VERTEX, independently. Three pieces make the connector
// answer that (`src/compiler/rel/lower/scoped.ts`):
//
// - a drawing body never stays CORRELATED (`correlatedBody`) — SQLite may evaluate a subquery part that does not
//   read the host once for every host row — so it always takes the decorrelated form (`scopedBody`);
// - the decorrelator counts a draw as touching the scope (`src/rel/decorrelate.ts`), so the `ORDER BY RANDOM()`
//   a draw sorts by is partitioned by the scope key: one sort, linear in the rows drawn from;
// - a shared drawing relation is FENCED (`src/rel/passes/name.ts`): `AS MATERIALIZED`, evaluated once, so two
//   readers of one pick agree (SQLite flattens a CTE whose top is a projection into each reader).
//
// Assertions are on what is semantic — cardinality per scope, the pick lands in the scope's own candidates,
// readers of one pick agree, picks are independent across scopes — never on Java's sampling order.
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { decorrelate } from '../../src/rel/decorrelate.ts';
import { col, compilerInt, type Expr } from '../../src/rel/expr.ts';
import { limit, scan, sort } from '../../src/rel/factory.ts';
import type { Rel } from '../../src/rel/rel.ts';
import { relId } from '../../src/rel/types.ts';
import { forEachRel } from '../../src/rel/walk.ts';
import { bare, runWith, seededStore } from '../support/harness.ts';

const CONNECTOR = { fastPaths: { connectorOnly: true } } as const;
const MODES = [['default', undefined], ['connector alone', CONNECTOR]] as const;
const store = seededStore();
const rows = (q: string, options?: typeof CONNECTOR) => bare(runWith(store, q, options));
const ids = (q: string, options?: typeof CONNECTOR): number[] => rows(q, options).map((r: any) => Number(r.v ?? r));
/** Out-neighbours in the modern graph — v2, v3 and v5 have none. */
const OUT: Record<number, number[]> = { 1: [2, 3, 4], 4: [3, 5], 6: [3] };

describe('a draw in local()/flatMap()/map() answers per scope row', () => {
  for (const [mode, options] of MODES) {
    test(`${mode}: one pick per vertex with an out-neighbour`, () => {
      for (const host of ['local', 'flatMap', 'map']) expect(rows(`g.V().${host}(out().sample(1)).count()`, options)).toEqual([{ v: 3 }]);
      expect(rows('g.V().local(out().sample(2)).count()', options)).toEqual([{ v: 5 }]);
    });

    test(`${mode}: each pick is one of ITS OWN vertex's neighbours, and the picks vary`, () => {
      const seen = new Map<number, Set<number>>();
      for (let i = 0; i < 60; i++) {
        for (const v of [1, 4, 6]) {
          const [pick, ...more] = ids(`g.V(${v}).local(out().sample(1)).id()`, options);
          expect(more).toEqual([]);
          expect(OUT[v]).toContain(pick!);
          seen.set(v, (seen.get(v) ?? new Set()).add(pick!));
        }
      }
      // 60 draws from 3 neighbours all landing on one: (1/3)^59 — never.
      expect(seen.get(1)!.size).toBeGreaterThan(1);
    });

    test(`${mode}: two readers of one pick agree`, () => {
      for (let i = 0; i < 40; i++) {
        expect(rows("g.V().local(out().order().by(shuffle).limit(1).union(identity(), identity()).dedup().count())", options))
          .toEqual([1, 0, 0, 1, 0, 1].map((v) => ({ v })));
        // One pick read by an out-arm and an in-arm: v1's picks give 1 (v2), 3 (v3) or 3 (v4) — never a mix of two picks.
        const [v1, , , v4, , v6] = rows("g.V().local(out().order().by(shuffle).limit(1).union(out(), __.in()).count())", options)
          .map((r: any) => r.v);
        expect([1, 3]).toContain(v1);
        expect([1, 3]).toContain(v4);
        expect(v6).toBe(3);
      }
    });

    test(`${mode}: the draw composes at depth`, () => {
      for (let i = 0; i < 20; i++) {
        // v1's pick of v4 is the only one with neighbours of its own (v3, v5).
        const nested = ids("g.V().local(out().sample(1).out().sample(1)).id()", options);
        expect(nested.length).toBeLessThanOrEqual(1);
        for (const id of nested) expect([3, 5]).toContain(id);
        expect(rows("g.V().map(local(out().sample(1)).id()).count()", options)).toEqual([{ v: 3 }]);
        expect(rows("g.V().project('x').by(out().sample(1).id().fold()).count()", options)).toEqual([{ v: 6 }]);
        // v4 and v6 reach only software; v1 does a third of the time.
        const kept = ids("g.V().where(out().sample(1).has('lang')).id()", options);
        expect(kept.filter((id) => id !== 1)).toEqual([4, 6]);
      }
    });
  }
});

describe('the plan', () => {
  test('the draw is partitioned by the scope key, never a correlated subquery', () => {
    const plan = compile('g.V().local(out().sample(1)).count()', {}, CONNECTOR);
    if (plan.kind !== 'read') throw new Error('expected a read');
    expect(plan.sql).toMatch(/PARTITION BY [^)]*ORDER BY RANDOM\(\)/);
  });

  test('a drawing relation two readers share is a fenced CTE', () => {
    const plan = compile("g.V().local(out().order().by(shuffle).limit(1).union(out(), __.in()).count())", {}, CONNECTOR);
    if (plan.kind !== 'read') throw new Error('expected a read');
    expect(plan.sql).toMatch(/AS MATERIALIZED \(SELECT [^;]*RANDOM\(\)/);
  });
});

describe('decorrelate: a draw counts as touching the scope', () => {
  // A plan that reads NOTHING of the outer row but draws — `inject(…)`/`V()` then `sample(1)` inside a body. Left
  // untouched it is one relation for every key, so every key would share ONE pick; keyed, its `ROW_NUMBER` is
  // partitioned by the key and each key draws its own.
  const idCol = { name: 'id', type: 'int', nullable: false } as const;
  const outer = scan({ id: relId('o'), table: 'nodes', alias: 'o', channels: [], type: { cols: [idCol] } });
  const drawn = (random: boolean): Rel => {
    const nodes = scan({ id: relId('n'), table: 'nodes', alias: 'n', channels: [], type: { cols: [idCol] } });
    const order: Expr = random ? { kind: 'call', fn: 'RANDOM', args: [] } : col(nodes.id, 'id');
    const sorted = sort({ id: relId('s'), input: nodes, channels: [], type: nodes.type, terms: [{ expr: order, dir: 'asc' }] });
    return limit({ id: relId('l'), input: sorted, channels: [], type: nodes.type, count: compilerInt(1) });
  };
  let n = 0;
  const fresh = (hint: string) => relId(`${hint}${n++}`);
  const partitioned = (r: Rel): boolean => {
    let hit = false;
    forEachRel(r, (x) => {
      if (x.kind === 'window' && x.specs.some(([, s]) => s.kind === 'window-expr' && s.spec.partitionBy.length > 0)) hit = true;
    });
    return hit;
  };

  test('an uncorrelated draw is keyed — its window partitioned by the scope key', () => {
    const out = decorrelate(drawn(true), outer, 'id', fresh);
    expect(out !== null && partitioned(out.rel)).toBe(true);
  });

  test('an uncorrelated deterministic subtree stays the same relation for every key', () => {
    const out = decorrelate(drawn(false), outer, 'id', fresh);
    expect(out !== null && partitioned(out.rel)).toBe(false);
  });
});
