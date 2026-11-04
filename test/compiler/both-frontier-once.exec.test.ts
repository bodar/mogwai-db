// A multi-direction hop (`both`/`bothE`/`bothV`) reads its incoming frontier ONCE.
//
// The bug this pins was a SQLite PREPARE-time wall, not a data-size one. `both()` lowered to a UNION ALL of
// two per-direction joins, each naming the incoming frontier; SQLite has no LATERAL and expands every
// reference to a derived table or CTE into its own copy, so k chained hops were 2^k copies of the first:
// `g.V().both()×16.count()` and `repeat(both()).times(16)` exceeded "too many references to edges",
// `local(both()×8.count())` was 46 KB of statement text doubling per hop (over a Durable Object's 100 KB cap
// by k≈9), and `local(repeat(both()).times(16))` spent 4.7 s in prepare before refusing. A hop whose frontier
// is not free to read twice now crosses it with a constant `(VALUES (0),(1))` direction row and joins
// `edges` once (`hopJoin`, src/compiler/rel/lower/movement.ts); a base-table frontier keeps the two plain
// seeks, which measured faster (`rereadsFreely`, src/rel/walk.ts).
//
// The oracles here are independent of the lowering: walk counts come from powers of the adjacency matrix,
// and every `both`-family read is compared with its `union()` spelling, which is a different lowering.
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { CfLimitedSql, CF_MAX_SQL_BYTES } from '../../src/cf-limits.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { executeQuery } from '../support/executor.ts';
import { bagOf, run } from '../support/harness.ts';

const MODERN_EDGES: readonly (readonly [number, number])[] = [[1, 2], [1, 4], [1, 3], [4, 5], [4, 3], [6, 3]];
/** A small graph with a SELF-LOOP on 2 and a parallel pair 1→3, 3→1 — the multiset cases `both()` must
 *  count once per direction. */
const LOOPY_EDGES: readonly (readonly [number, number, string])[] = [[1, 2, 'knows'], [2, 2, 'knows'], [2, 3, 'created'], [1, 3, 'knows'], [3, 1, 'knows']];
const LOOPY_SEED: readonly string[] = [
  ...[1, 2, 3].map((id) => `g.addV('person').property(T.id,${id}).property('name','p${id}')`),
  ...LOOPY_EDGES.map(([s, t, l]) => `g.V(${s}).addE('${l}').to(__.V(${t}))`),
];
/** A three-vertex path 1–2–3: walk counts grow ~√2^k, so a deep body stays cheap to ENUMERATE. */
const PATH_SEED: readonly string[] = [
  ...[1, 2, 3].map((id) => `g.addV('p').property(T.id,${id})`),
  'g.V(1).addE(\'knows\').to(__.V(2))', 'g.V(2).addE(\'knows\').to(__.V(3))',
];
const PATH_EDGES: readonly (readonly [number, number])[] = [[1, 2], [2, 3]];

const seeded = (seed: readonly string[], limited = false): GraphStore => {
  const store = new GraphStore(limited ? new CfLimitedSql(new BunSqlite(':memory:')) : new BunSqlite(':memory:'));
  for (const q of seed) executeQuery(store, q, {});
  return store;
};
const modern = seeded(MODERN_SEED);
const loopy = seeded(LOOPY_SEED);

/** Walks of length k from each vertex over the UNDIRECTED multigraph — a self-loop contributes twice (one
 *  per direction), as `both()` must. BigInt, since the modern graph's counts pass 2^53 by k≈30. */
function walkCounts(edges: readonly (readonly [number, number, ...unknown[]])[], ids: readonly number[], k: number): Map<number, bigint> {
  let at = new Map<number, bigint>(ids.map((id) => [id, 1n]));
  for (let hop = 0; hop < k; hop++) {
    const next = new Map<number, bigint>(ids.map((id) => [id, 0n]));
    for (const [s, t] of edges) {
      next.set(t, next.get(t)! + at.get(s)!);
      next.set(s, next.get(s)! + at.get(t)!);
    }
    at = next;
  }
  return at;
}
const total = (counts: Map<number, bigint>): bigint => [...counts.values()].reduce((a, b) => a + b, 0n);
const count = (store: GraphStore, q: string): bigint => BigInt((run(store, q) as { v: number }[])[0]!.v);
/** The traversers a read returns, as a bag of ids — a collapsed row carries its multiplicity as `bulk`. */
const ids = (store: GraphStore, q: string): number[] =>
  bagOf((run(store, q) as { id: number; bulk?: number }[]).flatMap((r) => Array.from({ length: r.bulk ?? 1 }, () => r.id)));
const sqlOf = (q: string): string => {
  const p = compile(q, {});
  if (p.kind !== 'read') throw new Error('expected a read plan');
  return p.sql;
};
const both = (k: number) => '.both()'.repeat(k);

describe('a deep both() chain answers under the default Sql', () => {
  for (const k of [16, 20]) {
    test(`g.V().both()×${k}.count() and repeat(both()).times(${k}).count() agree with the adjacency oracle`, () => {
      const expected = total(walkCounts(MODERN_EDGES, [1, 2, 3, 4, 5, 6], k));
      expect(count(modern, `g.V()${both(k)}.count()`)).toBe(expected);
      expect(count(modern, `g.V().repeat(both()).times(${k}).count()`)).toBe(expected);
    });
  }

  test('local(repeat(both()).times(20)).count() answers in bounded store time', () => {
    const path = seeded(PATH_SEED);
    const started = performance.now();
    expect(count(path, 'g.V().local(repeat(both()).times(20)).count()')).toBe(total(walkCounts(PATH_EDGES, [1, 2, 3], 20)));
    // Before: refused after seconds of SQLite PREPARE on a six-vertex graph. The bound is generous on purpose
    // — it guards the exponential prepare, not a micro-benchmark.
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe('local(both()×k.count()) — statement text is LINEAR in k, under the Durable Object caps', () => {
  const path = seeded(PATH_SEED, true);
  const q = (k: number) => `g.V().local(__${both(k)}.count())`;
  const bytes = new Map([8, 16, 32].map((k) => [k, sqlOf(q(k)).length] as const));

  test('each doubling of k adds ~the same bytes again (no 2^k)', () => {
    const d1 = bytes.get(16)! - bytes.get(8)!;
    const d2 = bytes.get(32)! - bytes.get(16)!;
    // Linear growth doubles the delta when k doubles; 2^k growth would multiply it by 256.
    expect(d2 / d1).toBeGreaterThan(1.5);
    expect(d2 / d1).toBeLessThan(2.5);
    expect(bytes.get(32)!).toBeLessThan(CF_MAX_SQL_BYTES);
  });

  for (const k of [8, 16, 32]) {
    test(`k=${k} runs on a CfLimitedSql store and matches the per-vertex walk counts`, () => {
      const counts = walkCounts(PATH_EDGES, [1, 2, 3], k);
      expect(bagOf((run(path, q(k)) as { v: number }[]).map((r) => BigInt(r.v)))).toEqual(bagOf([...counts.values()]));
    });
  }
});

describe('the multiset rule — a self-loop is reached once per direction', () => {
  test('both() over a self-loop yields the vertex twice, at every depth', () => {
    // 2's neighbours: 1 (in), 2 (out, via the loop), 2 (in, via the loop), 3 (out).
    expect(ids(loopy, 'g.V(2).both()')).toEqual(bagOf([1, 2, 2, 3]));
    for (const k of [1, 2, 3, 6]) {
      const expected = walkCounts(LOOPY_EDGES, [1, 2, 3], k);
      expect(count(loopy, `g.V()${both(k)}.count()`)).toBe(total(expected));
      // A frontier that is not a base-table read (the second hop on) takes the direction-row join.
      expect(count(loopy, `g.V().out().in()${both(k)}.count()`)).toBe(count(loopy, `g.V().out().in()${'.union(__.out(),__.in())'.repeat(k)}.count()`));
    }
  });

  test('bothE() over a self-loop is the loop edge twice, and otherV() returns to the vertex', () => {
    expect(count(loopy, 'g.V(2).bothE().count()')).toBe(4n);
    expect(ids(loopy, 'g.V(2).bothE().otherV()')).toEqual(bagOf([1, 2, 2, 3]));
    expect(ids(loopy, 'g.V(1).out().bothE().otherV()')).toEqual(ids(loopy, 'g.V(1).out().both()'));
  });
});

// Every both-family read against its `union()` spelling — a DIFFERENT lowering — across both frontier
// kinds (a base-table read keeps two seeks; anything else reads once) and the positions a hop composes
// into. Bags, since neither spelling orders its stream.
describe('both()/bothE()/bothV() agree with their union() spelling at depth', () => {
  const pairs: readonly (readonly [string, string])[] = [
    ['g.V().both()', 'g.V().union(__.out(),__.in())'],
    ["g.V().both('knows')", "g.V().union(__.out('knows'),__.in('knows'))"],
    ["g.V().out().both('created')", "g.V().out().union(__.out('created'),__.in('created'))"],
    ['g.V().out().both().both()', 'g.V().out().union(__.out(),__.in()).union(__.out(),__.in())'],
    ['g.V().bothE()', 'g.V().union(__.outE(),__.inE())'],
    ["g.V().out().bothE('knows')", "g.V().out().union(__.outE('knows'),__.inE('knows'))"],
    ['g.E().bothV()', 'g.E().union(__.outV(),__.inV())'],
    ['g.V().outE().bothV()', 'g.V().outE().union(__.outV(),__.inV())'],
    ['g.V().bothE().otherV()', 'g.V().both()'],
    ['g.V().out().bothE().otherV()', 'g.V().out().both()'],
    ['g.V().local(__.both().both())', 'g.V().local(__.union(__.out(),__.in()).union(__.out(),__.in()))'],
    ["g.V().where(__.out().both().has('name','p3'))", "g.V().where(__.out().union(__.out(),__.in()).has('name','p3'))"],
    ['g.V().optional(__.out().both())', 'g.V().optional(__.out().union(__.out(),__.in()))'],
    ['g.V().repeat(__.both()).times(3)', 'g.V().union(__.out(),__.in()).union(__.out(),__.in()).union(__.out(),__.in())'],
    // The UNBOUNDED walk: its frontier is the recursive reference, so its body is the direction-row join.
    ['g.V().repeat(__.both()).until(__.loops().is(3))', 'g.V().union(__.out(),__.in()).union(__.out(),__.in()).union(__.out(),__.in())'],
  ];
  for (const store of [modern, loopy]) {
    for (const [a, b] of pairs) {
      test(`${a}  ≡  ${b}  (${store === modern ? 'modern' : 'self-loop'} graph)`, () => {
        expect(ids(store, a)).toEqual(ids(store, b));
      });
    }
  }

  test('by() and count() positions', () => {
    for (const store of [modern, loopy]) {
      const a = run(store, "g.V().project('n').by(__.out().both().count())") as { n: unknown }[];
      const b = run(store, "g.V().project('n').by(__.out().union(__.out(),__.in()).count())") as { n: unknown }[];
      expect(bagOf(a.map((r) => JSON.stringify(r)))).toEqual(bagOf(b.map((r) => JSON.stringify(r))));
    }
  });
});

describe('access paths — every both() hop seeks e_out/e_in', () => {
  const plan = (q: string): string[] => {
    const p = compile(q, {});
    if (p.kind !== 'read') throw new Error('expected a read plan');
    return (modern.query(`EXPLAIN QUERY PLAN ${p.sql}`, p.binds) as { detail: string }[]).map((r) => r.detail);
  };
  for (const q of ["g.V(1).both().values('name')", "g.V(1).out().both().values('name')", "g.V(1).out().bothE('knows').otherV()", 'g.V(1).repeat(__.both()).emit()']) {
    test(q, () => {
      const detail = plan(q);
      expect(detail.some((d) => /SEARCH rme\d+ USING COVERING INDEX e_out \(src=\?/.test(d))).toBe(true);
      expect(detail.some((d) => /SEARCH rme\d+ USING COVERING INDEX e_in \(tgt=\?/.test(d))).toBe(true);
      expect(detail.filter((d) => /SCAN rme\d+/.test(d))).toEqual([]);
      expect(detail.filter((d) => /AUTOMATIC/.test(d))).toEqual([]);
    });
  }

  test('a base-table frontier keeps two plain seeks; a derived one is read once through the direction row', () => {
    // `g.V(1)` is a base-table read, so naming it twice is free — and measured faster than the OR.
    expect(sqlOf('g.V(1).both()')).not.toContain('VALUES (0), (1)');
    // The second hop's frontier is the first hop's join: one direction row per non-base hop, one reference.
    const twoHop = sqlOf('g.V(1).out().both()');
    expect(twoHop.match(/VALUES \(0\), \(1\)/g)).toHaveLength(1);
    expect(twoHop).not.toContain('UNION ALL');
  });
});
