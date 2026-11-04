// A multi-direction hop (`both`/`bothE`/`bothV`) reads its incoming frontier ONCE.
//
// The bug this pins was a SQLite PREPARE-time wall, not a data-size one. `both()` lowered to a UNION ALL of
// two per-direction joins, each naming the incoming frontier; SQLite has no LATERAL and expands every
// reference to a derived table or CTE into its own copy, so k chained hops were 2^k copies of the first:
// `g.V().both()×16.count()` and `repeat(both()).times(16)` exceeded "too many references to edges",
// `local(both()×8.count())` was 46 KB of statement text doubling per hop (over a Durable Object's 100 KB cap
// by k≈9), and `local(repeat(both()).times(16))` spent 4.7 s in prepare before refusing. A hop whose frontier
// already holds `BOTH_COPY_BOUND` doubled reads now crosses it with a constant `(VALUES (0),(1))` direction
// row and joins `edges` once (`hopJoin`, src/compiler/rel/lower/movement.ts); any other frontier keeps the
// two plain seeks, which measured faster than SQLite's MULTI-INDEX OR (`doubledReads`, src/rel/copies.ts).
// The gate used to admit only a BASE-TABLE frontier, so an ordinary `out().both()` paid the OR (+25–47%).
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
import { rawVertex } from '../support/graph.ts';

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
    // Frontiers whose second copy would repeat work (`copyRepeatsWork`) read once — a label carrier, a
    // sliced order, a keyed dedup, the per-traverser form — and still answer as the union spelling.
    ["g.V().as('a').both().both().where(neq('a'))", "g.V().as('a').union(__.out(),__.in()).union(__.out(),__.in()).where(neq('a'))"],
    ["g.V().as('a').out().both().where(neq('a'))", "g.V().as('a').out().union(__.out(),__.in()).where(neq('a'))"],
    ["g.V().out().order().by('name').limit(2).both()", "g.V().out().order().by('name').limit(2).union(__.out(),__.in())"],
    ["g.V().both().order().by('name').limit(3).both()", "g.V().both().order().by('name').limit(3).union(__.out(),__.in())"],
    ["g.V().out().dedup().by('name').both()", "g.V().out().dedup().by('name').union(__.out(),__.in())"],
    ["g.V().local(__.out().order().by('name').limit(1).both())", "g.V().local(__.out().order().by('name').limit(1).union(__.out(),__.in()))"],
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

  // A LABELLED hop off a derived frontier: the label must sit inside EACH direction's disjunct, or the
  // MULTI-INDEX OR seeks `e_out (src=?)` / `e_in (tgt=?)` and filters the label afterwards — every hop
  // then pays the vertex's total degree, not its degree for the label (×59 from 1k to 8k vertices on a
  // hub, measured). Both seeks must carry `label=?`, and no seek of either index may lack it.
  for (const q of ["g.V().out('created').both('knows').path().count()", "g.V().out('created').bothE('knows').path().count()",
    "g.V(1).out('knows').both('knows','created')", "g.V().repeat(__.both('knows')).times(2).path()"]) {
    test(`labelled: ${q}`, () => {
      const seeks = plan(q).filter((d) => /SEARCH rme\d+ USING COVERING INDEX e_(out|in) /.test(d));
      expect(seeks.some((d) => /e_out \(src=\? AND label=\?\)/.test(d))).toBe(true);
      expect(seeks.some((d) => /e_in \(tgt=\? AND label=\?\)/.test(d))).toBe(true);
      expect(seeks.filter((d) => !/label=\?/.test(d))).toEqual([]);
    });
  }

  // A frontier with fewer than BOTH_COPY_BOUND (2) doubled reads beneath it keeps the per-direction joins:
  // two plain `e_out`/`e_in` seeks, never the MULTI-INDEX OR, which measured 25–47% slower at 8k vertices.
  // `both().both()` is the D=2 case: its second hop's frontier holds the first hop's ONE doubling.
  // The last four are frontiers SQLite MATERIALIZES once — their CTE's top is the order's window, the
  // DISTINCT, the LIMIT, the HAVING of a collapsed hop — so a second read is one more seek (`copyRepeatsWork`).
  for (const q of ['g.V().out().both()', "g.V().out('knows').bothE().otherV()", 'g.V().optional(__.out().both())',
    'g.V().both().both()', "g.V().hasLabel('person').out('knows').both('created')", 'g.V().out().out().both().count()',
    'g.V().out().dedup().both().count()', "g.V().out().order().by('name').both().count()", 'g.V().out().limit(4).both().count()',
    "g.V().out().has('name',neq('x')).both().count()"]) {
    test(`two plain seeks, no MULTI-INDEX OR: ${q}`, () => {
      const detail = plan(q);
      expect(detail.filter((d) => /MULTI-INDEX OR/.test(d))).toEqual([]);
      expect(detail.filter((d) => /SEARCH rme\d+ USING COVERING INDEX e_out \(src=\?/.test(d)).length).toBeGreaterThanOrEqual(1);
      expect(detail.filter((d) => /SEARCH rme\d+ USING COVERING INDEX e_in \(tgt=\?/.test(d)).length).toBeGreaterThanOrEqual(1);
      expect(sqlOf(q)).not.toContain('VALUES (0), (1)');
    });
  }

  test('the bound is per LINEAGE: two doublings take the seeks, every later hop reads its frontier once', () => {
    expect(sqlOf('g.V(1).both()')).not.toContain('VALUES (0), (1)');
    expect(sqlOf('g.V(1).out().both()')).not.toContain('VALUES (0), (1)');
    expect(sqlOf('g.V().both().both()')).not.toContain('VALUES (0), (1)');
    // The third hop's frontier holds two doublings: one direction row, the OR.
    expect(sqlOf('g.V().both().both().both()').match(/VALUES \(0\), \(1\)/g)).toHaveLength(1);
    expect(plan('g.V().both().both().both()').some((d) => /MULTI-INDEX OR/.test(d))).toBe(true);
    // A plain hop between doublings adds none, so it does not reset the count either.
    expect(sqlOf('g.V().both().out().both().out().both()').match(/VALUES \(0\), \(1\)/g)).toHaveLength(1);
    // k hops: k − 2 direction rows, so the copy factor stays 2^2 however long the chain.
    for (const k of [4, 8, 16]) expect(sqlOf(`g.V()${both(k)}`).match(/VALUES \(0\), \(1\)/g)).toHaveLength(k - 2);
    // A walk's frontier is its recursive reference — unbounded — so a walk body always reads it once.
    expect(sqlOf('g.V().repeat(__.both()).until(__.loops().is(3))')).toContain('VALUES (0), (1)');
  });
});

// A frontier whose second COPY would repeat per-row work is read ONCE, through the direction row, even
// with no doubled read beneath it (`copyRepeatsWork`, src/rel/copies.ts). SQLite flattens a CTE whose top is
// a plain projection or filter into each reader — under a plain compound and a MERGE UNION ALL alike — and
// spells a correlated frontier at every reference, so the two-seek form ran the frontier's window, or
// recomputed its label carrier, once per direction: `as('a').both().both().where(neq('a')).count()` 2.4×
// and `out().order().by('name').limit(500).both().count()` 2× slower at 8 000 vertices than reading it once.
describe('a frontier whose copy repeats work is evaluated once', () => {
  type PlanRow = { id: number; parent: number; detail: string };
  const planRows = (store: GraphStore, q: string): PlanRow[] => {
    const p = compile(q, {});
    if (p.kind !== 'read') throw new Error('expected a read plan');
    return store.query(`EXPLAIN QUERY PLAN ${p.sql}`, p.binds) as PlanRow[];
  };
  /** The seeks of `index` NOT under a MULTI-INDEX OR — one per evaluation of a hop the FRONTIER makes
   *  through that index (the copies of a frontier each seek it again). */
  const plainSeeks = (index: 'e_out' | 'e_in', rows: readonly PlanRow[]): number => {
    const orIndex = new Set(rows.filter((r) => /^INDEX \d+$/.test(r.detail)).map((r) => r.id));
    return rows.filter((r) => r.detail.startsWith('SEARCH rme') && r.detail.includes(`INDEX ${index} (`) && !orIndex.has(r.parent)).length;
  };
  const nodeScans = (rows: readonly PlanRow[]): number => rows.filter((r) => /^SCAN rn\b/.test(r.detail)).length;

  for (const [cls, q, frontierScans] of [
    ['label carrier', "g.V().as('a').both().both().where(neq('a')).count()", (rows: PlanRow[]) => nodeScans(rows)],
    ['label carrier after a hop', "g.V().as('a').out().both().where(neq('a')).count()", (rows: PlanRow[]) => nodeScans(rows)],
    ['order + limit', "g.V().out().order().by('name').limit(500).both().count()", (rows: PlanRow[]) => plainSeeks('e_out', rows)],
    // The first both() is two plain seeks off a scan; its in-arm is the frontier's one `e_in` seek.
    ['order + limit after both()', "g.V().both().order().by('name').limit(10).both().count()", (rows: PlanRow[]) => plainSeeks('e_in', rows)],
    ['dedup().by()', "g.V().out().dedup().by('name').both().count()", (rows: PlanRow[]) => plainSeeks('e_out', rows)],
    ['the per-traverser form', "g.V().local(__.out().order().by('name').limit(1).both().count()).sum()", (rows: PlanRow[]) => plainSeeks('e_out', rows)],
  ] as const) {
    test(`${cls}: ${q}`, () => {
      const rows = planRows(modern, q);
      expect(rows.some((r) => r.detail === 'MULTI-INDEX OR')).toBe(true);
      expect(sqlOf(q)).toContain('VALUES (0), (1)');
      // The frontier's root access appears ONCE: it is evaluated once, not once per direction.
      expect(frontierScans(rows)).toBe(1);
    });
  }

  test('the bound is unchanged: a frontier SQLite materializes keeps its two seeks', () => {
    for (const q of ["g.V().out().order().by('name').both().count()", 'g.V().out().dedup().both().count()', 'g.V().out().limit(4).both().count()']) {
      expect(planRows(modern, q).some((r) => r.detail === 'MULTI-INDEX OR')).toBe(false);
    }
  });

  // The SCALING PROBE, pinned: linear is ≈8× from 1 000 to 8 000 vertices, N log N ≈10×, above 16× is
  // super-linear. The minimum of several runs, so a loaded runner's spikes cannot push the ratio up.
  describe('linear from 1 000 to 8 000 vertices', () => {
    /** n vertices named in a scrambled order, two `knows` edges out of each. */
    const synthetic = (n: number): GraphStore => {
      const raw = new BunSqlite(':memory:');
      const store = new GraphStore(raw);
      raw.exec('BEGIN');
      const knows = store.labelId('knows');
      for (let i = 1; i <= n; i++) {
        rawVertex(store, i, 'person');
        store.query('INSERT INTO vertex_properties(node,key,value,vtype) VALUES(?,?,?,?)', [i, 'name', `n${(i * 7919) % n}`, 'string']);
      }
      for (let i = 1; i <= n; i++) {
        for (const t of [((i * 7 + 1) % n) + 1, ((i * 13 + 5) % n) + 1]) store.query('INSERT INTO edges(src,label,tgt) VALUES(?,?,?)', [i, knows, t]);
      }
      raw.exec('COMMIT');
      return store;
    };
    const fastest = (store: GraphStore, q: string): number => {
      run(store, q);
      let best = Infinity;
      for (let i = 0; i < 7; i++) {
        const started = performance.now();
        run(store, q);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const small = synthetic(1_000);
    const large = synthetic(8_000);
    for (const [q, expected] of [
      ["g.V().as('a').both().both().where(neq('a')).count()", 95_960],
      ["g.V().out().order().by('name').limit(500).both().count()", 2_000],
    ] as const) {
      test(q, () => {
        expect((run(large, q) as { v: number }[])[0]!.v).toBe(expected);
        expect(fastest(large, q) / fastest(small, q)).toBeLessThan(16);
      });
    }
  });
});

describe('g.V().both()×k — statement text is LINEAR in k, up to 32 hops', () => {
  const bytes = new Map([8, 16, 32].map((k) => [k, sqlOf(`g.V()${both(k)}.count()`).length] as const));
  test('each doubling of k adds ~the same bytes again (no 2^k)', () => {
    const d1 = bytes.get(16)! - bytes.get(8)!;
    const d2 = bytes.get(32)! - bytes.get(16)!;
    expect(d2 / d1).toBeGreaterThan(1.5);
    expect(d2 / d1).toBeLessThan(2.5);
    expect(bytes.get(32)!).toBeLessThan(CF_MAX_SQL_BYTES);
  });
  test('×32 answers on a CfLimitedSql store and matches the adjacency oracle', () => {
    expect(count(seeded(PATH_SEED, true), `g.V()${both(32)}.count()`)).toBe(total(walkCounts(PATH_EDGES, [1, 2, 3], 32)));
  });
});

// A frontier that DRAWS is evaluated ONCE per traverser. Inside a per-traverser body (local/map/by()) a
// relation that cannot move out to a CTE is spelled at every reference and SQLite evaluates every copy on
// its own, so two copies of `out().order().by(shuffle).limit(1)` pick two different vertices. Read through
// the two-seek form, both() read the out-arm of one pick and the in-arm of another: v1's out-neighbours 2, 3
// and 4 have both() counts 1, 3 and 3, yet it answered 5, and `both().id().fold()` answered [1,3,4,5,6].
// `doubledReads` (src/rel/copies.ts) treats a drawing frontier as unbounded, so the hop reads it once; two
// branches that would each read it decline (`name`, src/rel/passes/name.ts).
describe('a drawing frontier is read once — no reader mixes two picks', () => {
  const RUNS = 150;
  const outcomes = (q: string): Set<string> => {
    const seen = new Set<string>();
    for (let i = 0; i < RUNS; i++) seen.add(JSON.stringify(run(modern, q)));
    return seen;
  };
  /** The single scalar each run answers, whatever its column is called. */
  const scalars = (q: string): unknown[] => [...outcomes(q)].map((r) => Object.values(JSON.parse(r)[0])[0]);

  for (const q of ['g.V(1).local(__.out().order().by(shuffle).limit(1).both().count())',
    'g.V(1).map(__.out().order().by(shuffle).limit(1).both().count())',
    'g.V(1).local(__.out().order().by(shuffle).limit(1).bothE().count())',
    "g.V(1).local(__.out().order().by(shuffle).limit(1).as('a').both().select('a').count())",
    'g.V(1).local(__.out().order().by(shuffle).limit(1)).union(__.out(), __.in()).count()',
    'g.V(1).local(__.out().sample(1)).union(__.out(), __.in()).count()']) {
    test(`${q} is always one pick's degree, 1 or 3`, () => {
      for (const n of scalars(q)) expect([1, 3]).toContain(Number(n));
    });
  }

  test("project('n').by(…shuffle.limit(1).both().count()) is always 1 or 3", () => {
    for (const map of scalars("g.V(1).project('n').by(__.out().order().by(shuffle).limit(1).both().count())")) {
      expect([1, 3]).toContain(Number(/"long","v":(\d+)/.exec(String(map))![1]));
    }
  });

  test("both().id().fold() is one pick's neighbourhood — never two picks mixed", () => {
    for (const list of scalars('g.V(1).local(__.out().order().by(shuffle).limit(1).both().id().order().fold())')) {
      expect(['[1]', '[1,3,5]', '[1,4,6]']).toContain(String(list));
    }
  });

  test("both().both() over a drawn frontier is one pick's two-step walk count (3 or 7)", () => {
    for (const n of scalars('g.V(1).local(__.out().order().by(shuffle).limit(1).both().both().count())')) expect([3, 7]).toContain(Number(n));
  });

  test('the hop over a drawing frontier is the direction-row join', () => {
    expect(sqlOf('g.V(1).local(__.out().order().by(shuffle).limit(1).both().count())')).toContain('VALUES (0), (1)');
  });

  // Two BRANCHES over one drawn frontier cannot read it once: each arm is its own reference, and SQLite has
  // no way to evaluate a correlated relation once for two readers. They answered 5 and 11 — counts no single
  // pick has — so they decline, naming the draw and the spelling that answers (the test above). optional()
  // and coalesce() are two branches too (an arm and its absence test): they answered 0 and 5.
  for (const q of ['g.V(1).local(__.out().order().by(shuffle).limit(1).union(__.out(), __.in()).count())',
    'g.V(1).local(__.out().order().by(shuffle).limit(1).optional(__.out()).count())',
    'g.V(1).local(__.out().order().by(shuffle).limit(1).coalesce(__.out(), __.in()).count())',
    "g.V(1).local(__.out().order().by(shuffle).limit(1).choose(__.hasLabel('software'), __.in(), __.out()).both().count())"]) {
    test(`declines, naming the draw: ${q}`, () => {
      expect(() => compile(q, {})).toThrow(/random draw .* more than one branch reads/);
    });
  }
});
