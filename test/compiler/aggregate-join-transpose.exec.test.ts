// A POOLED RE-SOURCE IS FACTORED, NOT CROSSED — `fuse`'s AggregateJoinTransposeRule (`src/rel/passes/fuse.ts` `factor`).
//
// `g.V().group().by('name').by(V().count())` pools each key's members into one weight and crosses it with the
// graph: an Aggregate per key over |keys| × |V| rows, which SQLite (no hash join, no aggregate transpose) runs as a
// nested loop — 47 ms at 500 vertices, 811 ms at 2 000. Factored, each side is grouped once and the per-key value is
// a product of sub-totals. These pin the ANSWERS (every key kept, a bulked key's weight, the integer class), and the
// shape: no Aggregate over the cross join in the emitted SQL's pooled value.
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { bare, grouped, run, seededStore, storeSeededWith } from '../support/harness.ts';

const store = seededStore();
const WITNESSES = [
  "g.V().group().by('name').by(V().values('age').sum())",
  "g.V().group().by('name').by(V().out().count())",
  "g.V().group().by('name').by(V().has('age',gt(30)).count())",
] as const;
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

  // The body's hop / predicate lands ABOVE the cross join; `fuse`'s normalisation (JoinAssociate, FilterJoin)
  // brings the cross up to the Aggregate, so these factor too (was 641 ms at 1k vertices, 2 662 ms at 2k).
  test('a hop or a predicate after the re-source factors: V().values().sum(), V().out().count(), V().has().count()', () => {
    for (const q of WITNESSES) expect(sqlOf(q)).toMatch(/ajt/);
    expect(values(WITNESSES[0])).toEqual({ josh: 123, lop: 123, marko: 123, peter: 123, ripple: 123, vadas: 123 });
    expect(values(WITNESSES[1])).toEqual({ josh: 6, lop: 6, marko: 6, peter: 6, ripple: 6, vadas: 6 });
    expect(values(WITNESSES[2])).toEqual({ josh: 2, lop: 2, marko: 2, peter: 2, ripple: 2, vadas: 2 });
    // The integer class survives the split (sum × count of integers).
    expect(JSON.stringify(bare(run(store, WITNESSES[0])))).toContain('{\\"t\\":\\"int\\",\\"v\\":123}');
    expect(values("g.V().both().group().by('name').by(V().out().has('age',gt(30)).count())"))
      .toEqual({ josh: 3, lop: 3, marko: 3, peter: 1, ripple: 1, vadas: 1 });
  });

  test('over a graph with REPEATED keys every key is its pool weight × the body total', () => {
    const big = storeSeededWith([
      'g.addV("person").property("name","a").property("age",10).as("a").addV("person").property("name","a").property("age",20).as("b")'
        + '.addV("person").property("name","b").property("age",31).as("c").addV("software").property("name","c").as("d")'
        + '.addE("knows").from("a").to("b").addE("knows").from("a").to("c").addE("created").from("c").to("d")',
    ]);
    const of = (q: string): Record<string, unknown> => grouped(bare(run(big, q)));
    expect(of("g.V().group().by('name').by(V().values('age').sum())")).toEqual({ a: 122, b: 61, c: 61 });
    expect(of("g.V().group().by('name').by(V().out().count())")).toEqual({ a: 6, b: 3, c: 3 });
    expect(of("g.V().group().by('name').by(V().has('age',gt(30)).count())")).toEqual({ a: 2, b: 1, c: 1 });
    expect(of("g.V().group().by('name').by(V().out().out().count())")).toEqual({ a: 2, b: 1, c: 1 });
  });

  test('at depth: inside project().by(), and read back through select(values)', () => {
    expect(bare(run(store, "g.V().group().by('name').by(V().count()).select(values).unfold().sum()"))).toEqual([{ v: 36, vt: 'long' }]);
    const nested = bare(run(store, "g.V().hasLabel('software').project('g').by(V().group().by('name').by(V().count()))"));
    expect(nested).toHaveLength(2);
    expect(JSON.stringify(nested)).toContain('{\\"t\\":\\"string\\",\\"v\\":\\"ripple\\"},{\\"t\\":\\"long\\",\\"v\\":6}');
  });
});
