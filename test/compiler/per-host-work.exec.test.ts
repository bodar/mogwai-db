import { describe, expect, test } from 'bun:test';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { loadBulk, type BulkEdge, type BulkVertex } from '../../src/bulk.ts';
import { bagOf, run, runWith, seededStore } from '../support/harness.ts';

// THE PER-HOST WORK FACT (`perHostWork`, `src/rel/work.ts`) — one cost fact read off the lowered algebra, beside
// `rowBounds`, where two consumers in `src/compiler/rel/lower/scoped.ts` used to read the query text or a private
// list of node kinds:
//  - `landValues` keeps a by() body CORRELATED (a first-row read per host) exactly where the body's correlated
//    plan reads a re-sourced element relation (`reSources` — the re-source cross, `reSourceCross` in
//    `src/rel/lineage.ts`), where it used to ask whether a `V()`/`E()` step NAME appeared at any depth;
//  - `correlatedExistence` declines a walk condition whose per-row work reads an unbounded input to its end
//    (`exhausts`), where it used to carry the node-kind list itself.
// Neither consumer may decline anything trunk answered: the walk-condition decline set below is pinned EXACTLY,
// so it cannot grow (nor shrink unnoticed).

const names = (rows: readonly { v: unknown }[]) => rows.map((row) => row.v);

describe('a landed by() that re-sources is read per host', () => {
  const store = seededStore();
  // `order()` keeps every host whose by() is productive (marko alone has no `V(1)` other than itself), and a
  // `dedup()` keeps one host per distinct pick. WHICH vertex a body's first row is follows `V()`'s iteration
  // order, which the query does not order (`docs/feature-support-matrix.md` §17), so only the bag is pinned.
  const all = ['marko', 'vadas', 'lop', 'josh', 'ripple', 'peter'];
  for (const [q, expected] of [
    ["g.V().as('a').order().by(V().where(neq('a')).values('name')).values('name')", all],
    ["g.V().as('a').order().by(V(1).where(neq('a')).values('name')).values('name')", all.slice(1)],
    ["g.V().as('a').order().by(V(1,2).where(neq('a')).values('name')).values('name')", all],
    ["g.V().as('a').order().by(map(V().where(neq('a')).values('name'))).values('name')", all],
    ["g.V().as('a').order().by(local(V().where(neq('a')).values('name'))).values('name')", all],
    ["g.V().as('a').order().by(coalesce(V().where(neq('a')).values('name'), constant('x'))).values('name')", all],
  ] as const) {
    test(q, () => expect(bagOf(names(run(store, q)))).toEqual(bagOf(expected)));
  }

  test("dedup().by(V().where(neq('a'))…) keeps one host per distinct pick", () => {
    expect(run(store, "g.V().as('a').dedup().by(V().where(neq('a')).values('name')).count()")).toEqual([{ v: 2 }]);
  });

  test("group().by(V().where(neq('a'))…) pools by the picked value", () => {
    expect(run(store, "g.V().as('a').group().by(V().where(neq('a')).values('name')).count(local)")).toEqual([{ v: 2 }]);
    expect(run(store, "g.V().as('a').groupCount().by(V().where(neq('a')).values('name'))")).toHaveLength(1);
  });

  // A first-row read per host stops at the first element the rest keeps, so it is ~linear in the hosts; the
  // decorrelated form would cross every host with the graph ahead of the pick (N × G).
  test('it stays ~linear in the hosts', () => {
    const graph = (n: number): GraphStore => {
      const store = new GraphStore(new BunSqlite(':memory:'));
      const vs: BulkVertex[] = [];
      const es: BulkEdge[] = [];
      for (let i = 1; i <= n; i++) {
        vs.push({ id: i, labels: ['person'], properties: [{ key: 'name', value: `p${i}` }, { key: 'age', value: i % 50 }] });
        es.push({ label: 'knows', src: i, tgt: (i % n) + 1 });
      }
      loadBulk(store, vs, es);
      return store;
    };
    const timed = (store: GraphStore, q: string): number => {
      runWith(store, q);
      let best = Infinity;
      for (let i = 0; i < 3; i++) { const t0 = performance.now(); runWith(store, q); best = Math.min(best, performance.now() - t0); }
      return best;
    };
    const small = graph(500), large = graph(4000);
    for (const q of [
      "g.V().as('a').order().by(V().where(neq('a')).values('name')).count()",
      "g.V().as('a').dedup().by(map(V().where(neq('a')).out().values('name'))).count()",
    ]) {
      expect(timed(large, q) / Math.max(timed(small, q), 2)).toBeLessThan(16);
    }
  }, 60_000);
});

describe('a walk condition: the decline set is pinned', () => {
  const store = seededStore();
  // Each is asked inside the walk's recursive term (`until`), where the per-row work must be bounded.
  const conditions = [
    "in('created').has('age',gt(30))",
    "in('created').values('age').max().is(gt(30))",
    "in('created').values('age').sum().is(gt(100))",
    "in('created').values('age').dedup().count().is(gt(3))",
    "in('created').values('age').dedup()",
    "in('created').values('age').dedup().limit(1)",
    "in('created').dedup().count().is(gt(1))",
    "in('created').count().is(gt(1))",
    "in('created').order().by('age').limit(1).has('age',gt(30))",
    "local(in('created').limit(1).has('age',gt(40)))",
    "optional(in('created').has('age',gt(45)))",
    "union(in('created'),out('knows')).has('age',gt(45))",
    "coalesce(in('created').has('age',gt(45)),out('nope'))",
    "local(in().order().by('age').limit(1))",
    "V().hasLabel('software')",
    "V().where(neq('x')).count().is(gt(3))",
  ];
  // What trunk declined before the fact existed — `distinct` is deliberately NOT a barrier (SQLite streams it), so
  // the `dedup()` conditions keep answering; the movement-head `correlatedExists` answers the reducer heads.
  const declined = new Set([
    "union(in('created'),out('knows')).has('age',gt(45))",
    "coalesce(in('created').has('age',gt(45)),out('nope'))",
    "local(in().order().by('age').limit(1))",
    "V().hasLabel('software')",
    "V().where(neq('x')).count().is(gt(3))",
  ]);

  test('exactly the recorded conditions decline, each as a clean UnsupportedTraversal', () => {
    const got = new Set<string>();
    for (const c of conditions) {
      try {
        run(store, `g.V().repeat(out()).until(${c}).count()`);
      } catch (error) {
        expect((error as Error).constructor.name).toBe('UnsupportedTraversal');
        got.add(c);
      }
    }
    expect([...got].sort()).toEqual([...declined].sort());
  });
});
