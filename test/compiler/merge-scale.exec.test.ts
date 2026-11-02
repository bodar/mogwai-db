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

// THE SEARCH SEEKS ITS MOST SELECTIVE CRITERION, and the guard keys a map by ONE entry — each witness below
// was quadratic on trunk (8k traversers: 34 s, 65 s, 360 s, 149 s, 86 s, 8.7 s), each through a seek that
// was correct and read a whole key range per driver:
//  - a NUMERIC search over a string-valued key read every TEXT value of the key (`value >= ''`), now only
//    the decimal texts the number's cast could land on (`decimalTextSeeks`);
//  - a search whose FIRST criterion every element shares (`kind`, `tenant`) seeked by it, now by the key
//    with the fewest capped matches per driver (`cappedCount`);
//  - a long past 2^53 is stored as decimal TEXT, so every such search read the whole TEXT range;
//  - the guard crossed every earlier creation with every distinct map KEY SET (N shapes, N²), now it meets
//    the later map's rarest entry (`searchKeying`);
//  - a map naming OUT, IN and a label seeked the OUT vertex's every edge, now the `e_out` key whole.
const BIG = 9007199254740993n;
function shaped(n: number, extra: (i: number) => readonly (readonly [string, unknown, string])[], hub = false): GraphStore {
  const raw = new BunSqlite(':memory:');
  const store = new GraphStore(raw);
  raw.exec('BEGIN');
  for (let i = 1; i <= n; i++) {
    rawVertex(store, i, 'person');
    for (const [key, value, vtype] of [['name', `n${i}`, 'string'] as const, ['age', i, 'int'] as const, ...extra(i)])
      store.query('INSERT INTO vertex_properties(node,key,value,vtype) VALUES(?,?,?,?)', [i, key, value, vtype]);
  }
  raw.exec('COMMIT');
  if (hub) {
    rawVertex(store, n + 1, 'hub');
    run(store, `g.V().hasLabel('person').as('t').V(${n + 1}).addE('x').to('t').count()`);
  }
  return store;
}
const maps = (f: (i: number) => string): string => persons.map(f).join(',');
describe(`a merge search over ${N} traversers seeks its most selective criterion`, () => {
  const kinded = (): GraphStore => shaped(N, () => [['kind', 'person', 'string']]);
  for (const [q, store, traversers, check, read] of [
    // A number searched over a string key: every driver creates.
    ["g.V().hasLabel('person').mergeV(__.project('name').by(values('age'))).count()", () => graph(N), N, "g.V().has('name',4242).count()", 1],
    // Every element shares the first computed criterion.
    ["g.V().mergeV(__.project('kind','name').by(constant('person')).by('name')).count()", kinded, N, "g.V().count()", N],
    // …and the first map entry.
    [`g.inject(${maps((i) => `[kind:'person',name:'n${i}']`)}).mergeV().count()`, kinded, N, "g.V().count()", N],
    // Longs past 2^53 — TEXT-stored — re-upserted by map and by computed search.
    [`g.inject(${maps((i) => `[sid:${BIG + BigInt(2 * i)}L]`)}).mergeV().count()`, () => shaped(N, (i) => [['sid', (BIG + BigInt(2 * i)).toString(), 'long']]), N, "g.V().count()", N],
    ["g.V().mergeV(__.project('sid').by('sid')).count()", () => shaped(N, (i) => [['sid', (BIG + BigInt(2 * i)).toString(), 'long']]), N, "g.V().count()", N],
    // N maps of N different keys, every one creating — the guard's N shapes.
    [`g.inject(${maps((i) => `[k${i}:1]`)}).mergeV().count()`, () => graph(N), N, "g.V().has('k4242',1).count()", 1],
    // N edges out of one hub, re-upserted.
    [`g.inject(${maps((i) => `[(T.label):'x',(Direction.OUT):${N + 1},(Direction.IN):${i}]`)}).mergeE().count()`, () => shaped(N, () => [], true), N, "g.E().count()", N],
  ] as const) {
    test(q.length > 160 ? `${q.slice(0, 120)}…` : q, () => {
      const graphed = store();
      const { rows, ms, statements } = runRecorded(graphed, q);
      expect(rows.map((row) => row.v)).toEqual([traversers]);
      expect(run(graphed, check).map((row: any) => row.v)).toEqual([read]);
      expect(innerScans(graphed, statements)).toEqual([]);
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }
});

// A SEEK ONLY NARROWS — whichever arm a numeric driver takes, the merge search finds exactly what `has()`
// finds over decimal TEXT a number's cast lands on: a BigDecimal rounding up to the next integer, a value
// underflowing to zero, longs past 2^53 by the INT cast and a BigDecimal by the REAL one, a magnitude whose
// neighbourhood crosses a power of ten, the least long.
describe('a numeric merge search finds every decimal TEXT the search compares equal', () => {
  const stored: readonly (readonly [unknown, string])[] = [
    ['30.99999999999999999999', 'bigdecimal'], [31, 'int'], [`-0.${'0'.repeat(400)}1`, 'bigdecimal'],
    ['9007199254740993', 'long'], ['9007199254740993.0', 'bigdecimal'], ['-9007199254740995', 'long'],
    ['99999999999999999.6', 'bigdecimal'], ['5.5', 'bigdecimal'], ['abc', 'string'], ['31', 'string'],
  ];
  const store = (): GraphStore => {
    const s = new GraphStore(new BunSqlite(':memory:'));
    stored.forEach(([value, vtype], i) => {
      rawVertex(s, i + 1, 'v');
      s.query('INSERT INTO vertex_properties(node,key,value,vtype) VALUES(?,?,?,?)', [i + 1, 'x', value, vtype]);
    });
    return s;
  };
  for (const [driver, ids] of [
    ['31', [1, 2]], ['0', [3]], ['0.0', [3]], ['9007199254740993L', [4]], ['9007199254740992', [5]],
    ['-9007199254740995L', [6]], ['100000000000000000L', [7]], ['5.5', [8]], ['5.5m', [8]], ['31.0m', [1, 2]],
    ['-9223372036854775808L', []], ['1e300', []],
  ] as const) {
    test(`[x:${driver}]`, () => {
      const s = store();
      expect(run(s, `g.V().has('x', ${driver}).id().fold()`).map((row: any) => row.list)).toEqual([JSON.stringify(ids)]);
      // A miss creates the 11th vertex.
      const merged = run(s, `g.inject([x:${driver}]).mergeV().id().order().fold()`).map((row: any) => row.list);
      expect(merged).toEqual([JSON.stringify(ids.length ? ids : [stored.length + 1])]);
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
  });
  // An onCreate value that DIFFERS from a driver's computed key is `validateNoOverrides`'s raise.
  for (const q of [
    "g.V().has('name','a').mergeV(__.project('k').by('name')).option(Merge.onCreate,[k:'zz']).id().fold()",
    "g.V().hasLabel('person').mergeV(__.project('code').by('name')).option(Merge.onCreate,[code:'q']).count()",
    "g.V().hasLabel('person').mergeE(__.project('w').by('name')).option(Merge.onCreate,[w:'z',(T.label):'self',(Direction.from):1,(Direction.to):1]).count()",
  ]) {
    test(`refuses cleanly: ${q}`, () => {
      expect(() => run(four(), q)).toThrow(RaisedByQuery);
      expect(() => run(four(), q)).toThrow(/cannot override values from merge\(\) argument/);
    });
  }
});
