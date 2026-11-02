// A PER-TRAVERSER MERGE IS LINEAR IN THE TRAVERSERS — `mergeV`/`mergeE` over every vertex of a graph a
// production DO actually holds, for each search kind: a constant map, a computed map
// (`mergeV(__.project(…))`), and a map-valued driver (`inject(map).mergeV()`).
//
// Three relations of a merge paired every driver with something, each as a predicate no index answers:
// the interleaving guard paired every two drivers that missed (`guardMergeInterleaving`, a self-join of
// the snapshot), the SEARCH paired every driver with every vertex (a correlated EXISTS per key), and the
// per-driver CREATION was joined back on a JSON spelling of the tuple. Each passed every six-vertex fixture
// and was O(N²) — measured on trunk, `g.V().mergeV(__.project('name').by(values('name')))` 23.8 s and the
// constant `mergeE` 4.5 s at 8k traversers. The guard now collapses drivers by tuple and joins by an equi
// key (`searchKeying`), the search seeks the property index (`seekedSearch`), the creation joins by its
// own columns (`createdPerDriver`) — all in `src/compiler/rel/write.ts`.
//
// Two assertions of different kinds, as `runtime-name-scale.exec.test.ts`: the PLAN (no statement scans a
// taken snapshot or a base table once per snapshot row, `test/support/snapshot-scans.ts`) and a WALL budget
// generous enough for a loaded CI runner yet far below the quadratic cost.
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { runSteps } from '../../src/program.ts';
import { isRowsBind } from '../../src/rel/emit.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { rawVertex } from '../support/graph.ts';
import { run } from '../support/harness.ts';
import { RaisedByQuery } from '../../src/rel/raise.ts';
import { nestedSnapshotScans, type PlanRow } from '../support/snapshot-scans.ts';

const N = 6000;
/** Quadratic was ≥ 8 s at this size on trunk; linear is ~0.1–0.3 s. */
const BUDGET_MS = 3000;

/** N `person` vertices, `name` n<i> and `age` i, plus N/4 `software` vertices with only a name. */
function graph(n: number): GraphStore {
  const raw = new BunSqlite(':memory:');
  const store = new GraphStore(raw);
  raw.exec('BEGIN');
  for (let i = 1; i <= n; i++) {
    rawVertex(store, i, 'person');
    store.query('INSERT INTO vertex_properties(node,key,value,vtype) VALUES(?,?,?,?)', [i, 'name', `n${i}`, 'string']);
    store.query('INSERT INTO vertex_properties(node,key,value,vtype) VALUES(?,?,?,?)', [i, 'age', i, 'int']);
  }
  for (let i = n + 1; i <= n + n / 4; i++) {
    rawVertex(store, i, 'software');
    store.query('INSERT INTO vertex_properties(node,key,value,vtype) VALUES(?,?,?,?)', [i, 'name', `s${i}`, 'string']);
  }
  raw.exec('COMMIT');
  return store;
}

function runRecorded(store: GraphStore, q: string): { rows: readonly Record<string, unknown>[]; ms: number; statements: { sql: string; binds: readonly unknown[] }[] } {
  const compiled = compile(q, {});
  if (compiled.kind !== 'program') throw new Error(`expected a write program for ${q}`);
  const statements: { sql: string; binds: readonly unknown[] }[] = [];
  const recording = {
    query: <T>(sql: string, binds: readonly unknown[] = []): T[] => { statements.push({ sql, binds }); return store.query<T>(sql, binds); },
    atomically: <T>(fn: () => T): T => store.atomically(fn),
  };
  const start = performance.now();
  const rows = runSteps(recording, compiled);
  return { rows, ms: performance.now() - start, statements };
}

const innerScans = (store: GraphStore, statements: readonly { sql: string; binds: readonly unknown[] }[]): string[] =>
  statements.flatMap(({ sql, binds }) => {
    const plan = store.query<PlanRow>(`EXPLAIN QUERY PLAN ${sql}`, binds.map((bind) => (isRowsBind(bind) ? '[]' : bind)));
    return nestedSnapshotScans(sql, plan).map((alias) => `${alias} in: ${sql.slice(0, 160)}`);
  });

const persons = Array.from({ length: N }, (_, i) => i + 1);
describe(`a merge over ${N} traversers is linear`, () => {
  for (const [q, traversers, check, read] of [
    // The constant search: every driver misses one edge and shares its creation — the guard's self-join.
    ["g.V().hasLabel('person').mergeE([(T.label):'kk',(Direction.from):1,(Direction.to):1]).count()", N, "g.E().hasLabel('kk').count()", 1],
    // A computed search that MATCHES — each driver finds itself by name.
    ["g.V().mergeV(__.project('name').by(values('name'))).count()", N + N / 4, "g.V().count()", N + N / 4],
    // A computed search that CREATES — every key distinct, the guard over N distinct tuples.
    ["g.V().hasLabel('person').mergeV(__.project('code').by(values('name'))).count()", N, "g.V().has('code','n4242').count()", 1],
    // MIXED MASKS — a software vertex's age body is unproductive, so its search narrows by name alone.
    ["g.V().mergeV(__.project('name','age').by('name').by('age')).count()", N + N / 4, "g.V().count()", N + N / 4],
    // A computed edge search, each driver creating its own self-loop.
    ["g.V().hasLabel('person').as('d').mergeE(__.project('w').by(values('age'))).option(Merge.onCreate,[T.label:'self',Direction.from:Merge.outV,Direction.to:Merge.inV]).option(Merge.outV,__.select('d')).option(Merge.inV,__.select('d')).count()",
      N, "g.V(4242).outE('self').values('w')", 4242],
    // Map-valued drivers: one shape of map, every driver creating; and edge maps naming their endpoints.
    [`g.inject(${persons.map((i) => `[kind:'u',code:'z${i}']`).join(',')}).mergeV().count()`, N, "g.V().has('code','z4242').count()", 1],
    [`g.inject(${persons.map((i) => `[(T.label):'kk',(Direction.OUT):${i},(Direction.IN):${(i % N) + 1}]`).join(',')}).mergeE().count()`,
      N, "g.V(4242).out('kk').id()", 4243],
  ] as const) {
    test(q.length > 160 ? `${q.slice(0, 120)}…` : q, () => {
      const store = graph(N);
      const { rows, ms, statements } = runRecorded(store, q);
      expect(rows.map((row) => row.v)).toEqual([traversers]);
      expect(run(store, check).map((row: any) => row.v)).toEqual([read]);
      expect(innerScans(store, statements)).toEqual([]);
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }
});

// The detector itself, on the two shapes it gained for this: SQLite's own plan for each, on a real store.
describe('nestedSnapshotScans names a pairing with no equi key', () => {
  const store = graph(4);
  const plan = (sql: string): readonly PlanRow[] => store.query<PlanRow>(`EXPLAIN QUERY PLAN ${sql}`, ['[]']);
  const spooled = "WITH s AS MATERIALIZED (SELECT json_extract(j.value, '$[0]') AS k FROM json_each(?) j)";
  test('a snapshot self-join with no equi key', () => {
    const sql = `${spooled} SELECT 1 FROM s a JOIN s b ON a.k < b.k`;
    expect(nestedSnapshotScans(sql, plan(sql))).toEqual(['b (a snapshot self-join with no equi key)']);
  });
  test('a snapshot self-join ON an equi key is a seek', () => {
    const sql = `${spooled} SELECT 1 FROM s a JOIN s b ON a.k = b.k`;
    expect(nestedSnapshotScans(sql, plan(sql))).toEqual([]);
  });
  test('a base table scanned once per snapshot row', () => {
    const sql = `${spooled} SELECT 1 FROM s a CROSS JOIN nodes n WHERE abs(n.id) = a.k`;
    expect(nestedSnapshotScans(sql, plan(sql))).toEqual(['n (a base table scanned per snapshot row)']);
  });
  test('a base table SEEKED per snapshot row', () => {
    const sql = `${spooled} SELECT 1 FROM s a CROSS JOIN nodes n WHERE n.id = a.k`;
    expect(nestedSnapshotScans(sql, plan(sql))).toEqual([]);
  });
});

// NOTHING TO KEY THE GUARD BY — every compared key is an `onCreate` key, so `searchKeying` has no criterion
// and the pair join runs without a seek. It once built an empty conjunction and leaked a bare `TypeError`.
describe('a computed merge whose every compared key is an onCreate key', () => {
  const four = (): GraphStore => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    for (const name of ['a', 'b', 'c', 'd']) run(store, `g.addV('person').property('name','${name}')`);
    return store;
  };
  test('answers when no pair can differ', () => {
    expect(run(four(), "g.V().mergeV(__.project('k').by(constant(1))).option(Merge.onCreate,[k:1]).id().fold()").map((row: any) => row.list))
      .toEqual(['[5,5,5,5]']);
    expect(run(four(), "g.V().has('name','a').mergeV(__.project('k').by('name')).option(Merge.onCreate,[k:'zz']).id().fold()").map((row: any) => row.list))
      .toEqual(['[5]']);
  });
  for (const q of [
    "g.V().hasLabel('person').mergeV(__.project('code').by('name')).option(Merge.onCreate,[code:'q']).count()",
    "g.V().hasLabel('person').mergeE(__.project('w').by('name')).option(Merge.onCreate,[w:'z',(T.label):'self',(Direction.from):1,(Direction.to):1]).count()",
  ]) {
    test(`refuses cleanly: ${q}`, () => {
      expect(() => run(four(), q)).toThrow(RaisedByQuery);
    });
  }
});
