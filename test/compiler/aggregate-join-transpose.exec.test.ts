// A POOLED RE-SOURCE IS FACTORED, NOT CROSSED — `fuse`'s AggregateJoinTransposeRule (`src/rel/passes/fuse.ts` `factor`).
//
// `g.V().group().by('name').by(V().count())` pools each key's members into one weight and crosses it with the
// graph: an Aggregate per key over |keys| × |V| rows, which SQLite (no hash join, no aggregate transpose) runs as a
// nested loop — 47 ms at 500 vertices, 811 ms at 2 000. Factored, each side is grouped once and the per-key value is
// a product of sub-totals. These pin the ANSWERS (every key kept, a bulked key's weight, the integer class), and the
// shape: no Aggregate over the cross join in the emitted SQL's pooled value.
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { bare, grouped, run, seededStore } from '../support/harness.ts';

const store = seededStore();
const values = (q: string): Record<string, unknown> => grouped(bare(run(store, q)));
const sqlOf = (q: string): string => {
  const plan = compile(q, {});
  return plan.kind === 'read' ? plan.sql : '';
};

describe('fuse: an Aggregate over a pooled re-source cross join is factored per side', () => {
  test('group().by(name).by(V().count()) — every key, the graph counted once', () => {
    expect(values("g.V().group().by('name').by(V().count())"))
      .toEqual({ josh: 6, lop: 6, marko: 6, peter: 6, ripple: 6, vadas: 6 });
    // The graph side is a scalar aggregate (guarded `count > 0`), never a GROUP BY over `pool CROSS JOIN nodes`.
    expect(sqlOf("g.V().group().by('name').by(V().count())")).not.toMatch(/CROSS JOIN nodes \w+ GROUP BY/);
  });

  test('a BULKED key weighs its pool: both() reaches josh/lop/marko three times each', () => {
    expect(values("g.V().both().group().by('name').by(V().count())"))
      .toEqual({ josh: 18, lop: 18, marko: 18, peter: 6, ripple: 6, vadas: 6 });
  });

  test('E() and a label key factor the same way', () => {
    expect(values("g.V().group().by('name').by(E().count())"))
      .toEqual({ josh: 6, lop: 6, marko: 6, peter: 6, ripple: 6, vadas: 6 });
    expect(values('g.V().group().by(label).by(V().count())')).toEqual({ person: 24, software: 12 });
  });

  test('values the factor does not reach keep their answers and class', () => {
    expect(values('g.V().group().by(label).by(V().out().count())')).toEqual({ person: 24, software: 12 });
    expect(values("g.V().group().by('name').by(V().has('name','zzz').count())"))
      .toEqual({ josh: 0, lop: 0, marko: 0, peter: 0, ripple: 0, vadas: 0 });
    const summed = bare(run(store, "g.V().group().by('name').by(V().values('age').sum())"));
    expect(JSON.stringify(summed)).toContain('{\\"t\\":\\"int\\",\\"v\\":123}');
  });

  test('at depth: inside project().by(), and read back through select(values)', () => {
    expect(bare(run(store, "g.V().group().by('name').by(V().count()).select(values).unfold().sum()"))).toEqual([{ v: 36, vt: 'long' }]);
    const nested = bare(run(store, "g.V().hasLabel('software').project('g').by(V().group().by('name').by(V().count()))"));
    expect(nested).toHaveLength(2);
    expect(JSON.stringify(nested)).toContain('{\\"t\\":\\"string\\",\\"v\\":\\"ripple\\"},{\\"t\\":\\"long\\",\\"v\\":6}');
  });
});
