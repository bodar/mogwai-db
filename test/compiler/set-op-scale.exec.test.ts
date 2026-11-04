// A SET OP AGAINST A DATA-SIZED OPERAND IS N log M — `fold().intersect(__.V().values('name').fold())` over
// every name of a graph a production DO actually holds.
//
// The membership test used to probe each of the incoming list's N members with a correlated EXISTS over a
// `json_each` of the operand's M members — no index can serve a table-valued function, so O(N·M): measured
// on trunk 61.6 ms at 1k and 3297 ms at 8k (53×) for `intersect`, the same for `difference`, and twice that
// for `disjunct`. The operand is now ONE fenced, MATERIALIZED relation of member rows (`listSetOp`,
// `src/compiler/rel/list.ts`) the membership joins on its (payload, family) columns, so SQLite builds its
// automatic covering index and each probe is O(log M).
//
// Two assertions of different kinds, as `merge-scale.exec.test.ts`: the PLAN (the probe SEARCHes the
// operand through an automatic index rather than scanning a `json_each`) and a WALL budget generous enough
// for a loaded CI runner yet far below the quadratic cost.
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { rawVertex } from '../support/graph.ts';
import { run } from '../support/harness.ts';

const N = 8000;
/** Quadratic was ≥ 3 s at this size on trunk; linear is ~0.1 s. */
const BUDGET_MS = 1500;

/** N `person` vertices, each `name` distinct (`n<i>`), `age` i. */
function graph(n: number): GraphStore {
  const raw = new BunSqlite(':memory:');
  const store = new GraphStore(raw);
  raw.exec('BEGIN');
  for (let i = 1; i <= n; i++) {
    rawVertex(store, i, 'person');
    store.query('INSERT INTO vertex_properties(node,key,value,vtype) VALUES(?,?,?,?)', [i, 'name', `n${i}`, 'string']);
    store.query('INSERT INTO vertex_properties(node,key,value,vtype) VALUES(?,?,?,?)', [i, 'age', i, 'int']);
  }
  raw.exec('COMMIT');
  return store;
}

describe(`a set op against a ${N}-member operand is not quadratic`, () => {
  const store = graph(N);
  const half = "__.V().has('age', P.lte(" + N / 2 + ")).values('name').fold()";
  for (const [q, expected] of [
    ["g.V().values('name').fold().intersect(__.V().values('name').fold()).count(Scope.local)", N],
    [`g.V().values('name').fold().intersect(${half}).count(Scope.local)`, N / 2],
    [`g.V().values('name').fold().difference(${half}).count(Scope.local)`, N / 2],
    [`g.V().values('name').fold().disjunct(${half}).count(Scope.local)`, N / 2],
    [`g.V().values('name').fold().merge(${half}).count(Scope.local)`, N],
    [`g.V().values('name').fold().combine(${half}).count(Scope.local)`, N + N / 2],
    // Per-row lists, one operand relation: each vertex's own one-name list against the half.
    [`g.V().local(__.values('name').fold()).intersect(${half}).unfold().count()`, N / 2],
    // Element lists compare by rowid through the same relation.
    ["g.V().fold().intersect(__.V().has('age', P.gt(" + N / 2 + ")).fold()).count(Scope.local)", N / 2],
  ] as const) {
    test(q, () => {
      run(store, q);
      const start = performance.now();
      const rows = run(store, q);
      const ms = performance.now() - start;
      expect(rows.map((row: any) => row.v)).toEqual([expected]);
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }

  test('the membership probe SEARCHes the operand through an automatic index', () => {
    const plan = compile("g.V().values('name').fold().intersect(__.V().values('name').fold())", {});
    if (plan.kind !== 'read') throw new Error('expected a read plan');
    const details = store.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${plan.sql}`, plan.binds).map((row) => row.detail);
    expect(details.some((detail) => /^SEARCH .* USING AUTOMATIC (PARTIAL )?COVERING INDEX/.test(detail))).toBe(true);
    expect(details.some((detail) => /^MATERIALIZE /.test(detail))).toBe(true);
  });
});
