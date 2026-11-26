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
import { CompileBudget } from '../../src/sql/kernel/budget.ts';
import { runSteps } from '../../src/program.ts';
import { isRowsBind } from '../../src/rel/emit.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { rawProperties, rawVertex } from '../support/graph.ts';
import { run, seededStore } from '../support/harness.ts';
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

/**
 * The drivers arrive as an `inject()` LITERAL of up to 8 000 maps, so one statement here is several MB of SQL —
 * past what a Durable Object accepts (100 KB) and past the compile budget (`COMPILE_BUDGET_BYTES`, 400 KB),
 * on purpose: what is under test is the merge's RUNTIME linearity in its drivers, and a literal is the one
 * way to hand a merge thousands of drivers on Bun. So these compiles run under a meter sized for that text.
 */
const SCALE_TEXT_BUDGET = 64_000_000;

function runRecorded(store: GraphStore, q: string): { rows: readonly Record<string, unknown>[]; ms: number; statements: { sql: string; binds: readonly unknown[] }[] } {
  const compiled = compile(q, {}, { budget: new CompileBudget(SCALE_TEXT_BUDGET) });
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

// THE SEARCH SEEKS ITS MOST SELECTIVE CRITERION, and the guard keys a map by its key set — each witness below
// was quadratic on trunk (8k traversers: 34 s, 65 s, 360 s, 149 s, 86 s, 8.7 s), each through a seek that
// was correct and read a whole key range per driver:
//  - a NUMERIC search over a string-valued key read every TEXT value of the key (`value >= ''`), now only
//    the decimal texts the number's cast could land on (`decimalTextSeeks`: a BigDecimal through `vp_decimal`);
//  - a search whose FIRST criterion every element shares (`kind`, `tenant`) seeked by it, now by the key
//    with the fewest capped matches per driver (`cappedCount`);
//  - a long past 2^53 is stored as decimal TEXT, so every such search read the whole TEXT range;
//  - the guard crossed every earlier creation with every distinct map KEY SET (N shapes, N²), now only with
//    the key sets it CONTAINS, met on (key set, signature) (`searchKeying`) — the WHOLE key: a composite
//    key whose every entry hundreds of maps share (`[x, y, z]` below) is one seek per map, not one per
//    sharer (keyed by the rarest entry alone it was 20–30× from 1k to 8k);
//  - a map naming OUT, IN and a label seeked the OUT vertex's every edge, now the `e_out` key whole.
const BIG = 9007199254740993n;
function shaped(n: number, extra: (i: number) => readonly (readonly [string, unknown, string])[], hub = false): GraphStore {
  const raw = new BunSqlite(':memory:');
  const store = new GraphStore(raw);
  raw.exec('BEGIN');
  const props: [number, string, unknown, string][] = [];
  for (let i = 1; i <= n; i++) {
    rawVertex(store, i, 'person');
    for (const [key, value, vtype] of [['name', `n${i}`, 'string'] as const, ['age', i, 'int'] as const, ...extra(i)]) props.push([i, key, value, vtype]);
  }
  rawProperties(store, props);
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
    // BigDecimals re-upserted by a double criterion — one `vp_decimal` probe per driver.
    [`g.inject(${maps((i) => `[d:${i}.5]`)}).mergeV().count()`, () => shaped(N, (i) => [['d', `${i}.5`, 'bigdecimal']]), N, "g.V().count()", N],
    // N maps of N different keys, every one creating — the guard's N shapes.
    [`g.inject(${maps((i) => `[k${i}:1]`)}).mergeV().count()`, () => graph(N), N, "g.V().has('k4242',1).count()", 1],
    // A composite key whose every ENTRY hundreds of maps share; a batch of two key sets, one containing the other.
    [`g.inject(${maps((i) => `[x:${i % 20},y:${Math.floor(i / 20) % 20},z:${Math.floor(i / 400)}]`)}).mergeV().count()`, () => shaped(N, () => []), N, "g.V().count()", 2 * N],
    [`g.inject(${maps((i) => i % 2 ? `[a:${i % 20},b:${Math.floor(i / 20)},e:${i}]` : `[a:${i % 20},b:${Math.floor(i / 20) + N}]`)}).mergeV().count()`, () => shaped(N, () => []), N, "g.V().count()", 2 * N],
    // KEY NAMES THAT ARE DATA: N distinct key sets, each key shared by N^(2/3) of them — the containment
    // between key sets is asked of the DISTINCT key sets and kept exact, inside the guard's one statement
    // (crossing every tuple with each key set sharing its rarest key was a 52 MB bind at 1k maps and a bare
    // `string or blob too big` at 8k); and half the maps' key sets strictly inside the other half's.
    [`g.inject(${maps((i) => `[a${i % 19}:1,b${Math.floor(i / 19) % 19}:1,c${Math.floor(i / 361)}:1]`)}).mergeV().count()`, () => shaped(N, () => []), N, "g.V().count()", 2 * N],
    [`g.inject(${maps((i) => i % 2 ? `[a${i % 50}:1,b${i}:1]` : `[a${(i + 1) % 50}:1,b${i + 1}:2,c:1]`)}).mergeV().count()`, () => shaped(N, () => []), N, "g.V().count()", 2 * N],
    // ONE NAME UNDER N LABELS — every pair shares the key set and signature, so the interleaving guard
    // meets them by label too (`searchKeying`'s carried label names); a collection label the same way.
    [`g.inject(${maps((i) => `[(T.label):'l${i}',name:'paris']`)}).mergeV().count()`, () => shaped(N, () => []), N, "g.V().has('name','paris').count()", N],
    [`g.inject(${maps((i) => `[(T.label):['a${i}','b'],name:'paris']`)}).mergeV().count()`, () => shaped(N, () => []), N, "g.V().hasLabel('b').count()", N],
    [`g.inject(${maps((i) => `[(T.label):'k${i}',(Direction.OUT):1,(Direction.IN):2]`)}).mergeE().count()`, () => shaped(N, () => []), N, "g.E().count()", N],
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
      // No value crossing a statement seam outgrows the traversers: a few hundred bytes each, never a cross.
      expect(Math.max(...statements.flatMap(({ binds }) => binds.map((bind) => (typeof bind === 'string' ? bind.length : 0))))).toBeLessThan(N * 1024);
    });
  }
});

// A MAP DRIVER PICKS ITS DRIVING ENTRY ONCE — K capped probes per driver, not K². The pick (the map's most
// selective string entry, `cappedCount`) once correlated to each EXPLODED ENTRY rather than to its driver,
// so one 1000-entry map took 1.9 s (250 entries: 0.25 s), and N 30-entry maps paid 900 probes apiece.
// Now `mapDrivers` projects the pick beside the driver, materialized, before the map is exploded. Ratios
// are of the merge's own run (`runRecorded` times execution, not the parse of a large literal).
describe('a map-valued merge picks its driving entry once per driver', () => {
  const wide = (k: number): string => `g.inject([${Array.from({ length: k }, (_, i) => `k${i}:${i}`).join(',')}]).mergeV().count()`;
  const thirty = (n: number): string =>
    `g.inject(${Array.from({ length: n }, (_, i) => `[${Array.from({ length: 30 }, (_, j) => `p${j}:${i * 30 + j}`).join(',')}]`).join(',')}).mergeV().count()`;
  const timed = (q: string, traversers: number, check: string, read: number): number => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    const { rows, ms, statements } = runRecorded(store, q);
    expect(rows.map((row) => row.v)).toEqual([traversers]);
    expect(run(store, check).map((row: any) => row.v)).toEqual([read]);
    expect(innerScans(store, statements)).toEqual([]);
    return ms;
  };
  test('one 1000-entry map costs well under 20× one 250-entry map', () => {
    const small = timed(wide(250), 1, "g.V().has('k249',249).count()", 1);
    const large = timed(wide(1000), 1, "g.V().has('k999',999).count()", 1);
    expect(large).toBeLessThan(20 * Math.max(small, 5));
  });
  test('30-entry maps grow linearly from 1k to 8k drivers', () => {
    const k1 = timed(thirty(1000), 1000, "g.V().has('p17',17).count()", 1);
    const k8 = timed(thirty(8000), 8000, "g.V().has('p29',239999).count()", 1);
    expect(k8).toBeLessThan(16 * Math.max(k1, 50));
    expect(k8).toBeLessThan(5 * BUDGET_MS);
  }, 120_000);
  // THE LABEL IS ONE MORE RANKED CRITERION. A batch sharing one `name` across N labels, re-upserted: every
  // driver matches, and by `name` each read all N `paris` vertices (8k: 409 s on trunk, 77× its 1k). Its
  // `T.label` is strictly more selective, so it seeks `vl_label` (`mapDrivers`' one pick).
  test('N labels sharing one name re-upsert linearly from 1k to 8k drivers', () => {
    const again = (n: number): number => {
      const store = new GraphStore(new BunSqlite(':memory:'));
      const q = `g.inject(${Array.from({ length: n }, (_, i) => `[(T.label):'l${i}',name:'paris']`).join(',')}).mergeV().count()`;
      runRecorded(store, q);
      const { rows, ms, statements } = runRecorded(store, q);
      expect(rows.map((row) => row.v)).toEqual([n]);
      expect(run(store, 'g.V().count()').map((row: any) => row.v)).toEqual([n]);
      expect(run(store, "g.V().hasLabel('l42').values('name')").map((row: any) => row.v)).toEqual(['paris']);
      expect(innerScans(store, statements)).toEqual([]);
      return ms;
    };
    const k1 = again(1000);
    const k8 = again(8000);
    expect(k8).toBeLessThan(16 * Math.max(k1, 20));
    expect(k8).toBeLessThan(BUDGET_MS);
  }, 120_000);
  // The two-pool grid — N maps `[a{i%s}:1, b{i/s}:1]`, every key shared by √N maps: N distinct key sets
  // drawn from two pools of √N keys, a regression guard on the guard's key-set containment at 8k.
  test('the two-pool grid at 8k drivers', () => {
    const n = 8000, s = Math.round(Math.sqrt(n));
    const q = `g.inject(${Array.from({ length: n }, (_, i) => `[a${i % s}:1,b${Math.floor(i / s)}:1]`).join(',')}).mergeV().count()`;
    expect(timed(q, n, 'g.V().count()', n)).toBeLessThan(BUDGET_MS);
  }, 60_000);
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
    stored.forEach((_, i) => rawVertex(s, i + 1, 'v'));
    rawProperties(s, stored.map(([value, vtype], i) => [i + 1, 'x', value, vtype] as const));
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

// THE GUARD'S KEY ONLY NARROWS — keyed by (key set, signature) over the key sets each earlier map CONTAINS,
// it still finds every pair where a later map's search would find an earlier one's creation: a later map
// whose entries an earlier map holds among more (refused), one whose `1.0` meets an earlier `1`, the empty
// map (every creation contains it), the empty-string key; and it admits the pairs no search could meet.
describe('a map-valued merge guard finds a later map an earlier creation contains', () => {
  const later = /where a later traverser would match what an earlier one created/;
  for (const q of [
    'g.inject([a:1,b:2],[a:1]).mergeV().count()',
    'g.inject([a:1,b:2],[b:2,a:1.0]).mergeV().count()',
    'g.inject([a:1,b:2,c:3],[c:3,a:1]).mergeV().count()',
    'g.inject([a:1,b:2],[:]).mergeV().count()',
    "g.inject(['':1,b:2],['':1]).mergeV().count()",
    "g.inject([a:1,(T.label):'x'],[a:1]).mergeV().count()",
    // Contained in a LONGER key set its rarest key finds, among key sets that only share a key with it.
    'g.inject([a:1,b:1,e:1],[b:1,c:1,d:1],[b:1,c:2],[a:1,b:1]).mergeV().count()',
  ]) test(`refuses: ${q}`, () => expect(() => run(new GraphStore(new BunSqlite(':memory:')), q)).toThrow(later));
  for (const [q, vertices] of [
    ['g.inject([a:1],[a:1,b:2]).mergeV().count()', 2],
    ['g.inject([a:1,b:2],[a:1,b:3]).mergeV().count()', 2],
    ['g.inject([:],[a:1]).mergeV().count()', 2],
    ['g.inject([a:1,b:2,c:3],[c:3,a:2]).mergeV().count()', 2],
    ['g.inject([a:1],[a:1]).mergeV().count()', 1],
    // `[a,b]`'s rarest key `b` is held by the longer `[b,c,d]`, which lacks `a` — a candidate, not contained.
    ['g.inject([b:1,c:1,d:1],[a:1,c:1,d:1],[a:1,c:1,e:1],[a:1,b:1]).mergeV().count()', 4],
  ] as const) test(`answers: ${q}`, () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    expect(run(store, q).map((row: any) => row.v)).toEqual([q.match(/\[[^\]]*\]/g)!.length]);
    expect(run(store, 'g.V().count()').map((row: any) => row.v)).toEqual([vertices]);
  });
});

// WHICHEVER CRITERION A MAP DRIVER SEEKS BY, the residual checks every entry and every label member — the
// label pick changes the access path, never the answer (modern graph: `name` is unique, `person` is four).
describe('a map driver seeking by its label answers as by its name', () => {
  for (const [q, ids, vertices] of [
    // The label is less selective: the name drives, as before.
    ["g.inject([(T.label):'person',name:'marko']).mergeV().id()", [1], 6],
    // A label no vertex carries counts 0 and drives — it seeks nothing, so the driver creates.
    ["g.inject([(T.label):'nolabelyet',name:'marko']).mergeV().id()", [7], 7],
    // A collection label is AND-checked whole, whichever member the pick read.
    ["g.inject([(T.label):['person','b'],name:'marko']).mergeV().id()", [7], 7],
    ["g.inject([(T.label):'software',name:'lop'],[(T.label):'person',name:'lop']).mergeV().id()", [3, 7], 7],
    // An edge map's label is not ranked: its partition is unchanged.
    ["g.inject([(T.label):'knows',(Direction.OUT):1,(Direction.IN):2,weight:0.5]).mergeE().id()", [7], 6],
  ] as const) test(q, () => {
    const store = seededStore();
    expect(run(store, q).map((row: any) => row.v).sort()).toEqual([...ids]);
    expect(run(store, 'g.V().count()').map((row: any) => row.v)).toEqual([vertices]);
  });
  test('a collection label creates with every member', () => {
    const store = seededStore();
    expect(run(store, "g.inject([(T.label):['a','b'],name:'x']).mergeV().label()").map((row: any) => row.v)).toEqual(['a']);
    expect(run(store, "g.V().hasLabel('b').values('name')").map((row: any) => row.v)).toEqual(['x']);
  });
});

// A mergeE SEARCH JOINS ITS OWN EDGE READ. The pairs meet the criteria read `E().hasLabel(…).has(…)` on
// `(src, tgt)`, so each pair is one endpoint-index seek, with the label and properties as residuals on the
// row it found (`edgeCriteria`/`pairedWith`, `src/compiler/rel/write.ts`). It once re-scanned `edges` and
// tested `id IN (every edge of the label)`, which SQLite expanded into a `rowid=?` probe per (pair, label
// member): 5.2 s at 8k traversers (65× the 1k time), and 18 ms for ONE `mergeE` against 100k `knows` edges.
describe('a mergeE search seeks the endpoint pair and tests the label on the row it found', () => {
  /** `n` persons, person i knows person i%n+1, plus `extra` more `knows` edges between other vertices. */
  const knowing = (n: number, extra = 0): GraphStore => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    store.query(`INSERT INTO labels(id,name) VALUES (1,'person'),(2,'knows'),(3,'other')`);
    store.query('WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<?) INSERT INTO nodes(id) SELECT i FROM c', [n + 2 * extra]);
    store.query('INSERT INTO vertex_labels(node,label) SELECT id, CASE WHEN id<=? THEN 1 ELSE 3 END FROM nodes', [n]);
    store.query('INSERT INTO edges(src,label,tgt) SELECT id, 2, (id % ?)+1 FROM nodes WHERE id<=?', [n, n]);
    store.query('INSERT INTO edges(src,label,tgt) SELECT id, 2, id+? FROM nodes WHERE id>? AND id<=?', [extra, n, n + extra]);
    return store;
  };
  /** Every edge-index line of the plans. The seek must be the endpoint key, never a label slice or a rowid list. */
  const edgeSeeks = (store: GraphStore, statements: readonly { sql: string; binds: readonly unknown[] }[]): string[] =>
    statements.flatMap(({ sql, binds }) => store.query<PlanRow>(`EXPLAIN QUERY PLAN ${sql}`, binds.map((bind) => (isRowsBind(bind) ? '[]' : bind))))
      .map((row) => row.detail).filter((detail) => /INDEX e_/.test(detail));
  const pairwise = (onMatch: string): string =>
    `g.V().hasLabel('person').as('a').out('knows').as('b').mergeE([(T.label):'knows',(Direction.from):Merge.outV,(Direction.to):Merge.inV])` +
    `.option(Merge.outV,__.select('a')).option(Merge.inV,__.select('b'))${onMatch}.count()`;
  for (const q of [pairwise(''), pairwise('.option(Merge.onMatch,[seen:true])')]) {
    test(`grows linearly: ${q.slice(54)}`, () => {
      const timed = (n: number): number => {
        const store = knowing(n);
        const { rows, ms, statements } = runRecorded(store, q);
        expect(rows.map((row) => row.v)).toEqual([n]);
        expect(run(store, "g.E().hasLabel('knows').count()").map((row: any) => row.v)).toEqual([n]);
        for (const seek of edgeSeeks(store, statements)) expect(seek).not.toMatch(/rowid=\?|e_label/);
        expect(innerScans(store, statements)).toEqual([]);
        return ms;
      };
      const k1 = timed(1000), k8 = timed(8000);
      expect(k8).toBeLessThan(16 * Math.max(k1, 20));
      expect(k8).toBeLessThan(BUDGET_MS);
    }, 60_000);
  }
  test('one mergeE against 100k knows edges reads its pair, not the label population', () => {
    const store = knowing(10, 100_000);
    // Matches, creates, then matches what it created. The plans are read after the last run: an EXPLAIN of
    // an `INSERT … RETURNING` between two runs leaves bun:sqlite's cached statement open across the commit.
    const runs = [
      ["g.mergeE([(T.label):'knows',(Direction.from):1,(Direction.to):2]).id()", 100_010],
      ["g.mergeE([(T.label):'knows',(Direction.from):1,(Direction.to):3]).id()", 100_011],
      ["g.mergeE([(T.label):'knows',(Direction.from):1,(Direction.to):3]).id()", 100_011],
    ] as const;
    const recorded = runs.map(([q, edges]) => {
      const { statements } = runRecorded(store, q);
      expect(run(store, 'g.E().count()').map((row: any) => row.v)).toEqual([edges]);
      return statements;
    });
    for (const statements of recorded) {
      const seeks = edgeSeeks(store, statements);
      expect(seeks.some((seek) => /src=\? AND|tgt=\? AND/.test(seek))).toBe(true);
      for (const seek of seeks) expect(seek).not.toMatch(/rowid=\?|e_label/);
    }
  });
});

// THE PAIR TEST SPELLS NO TAUTOLOGY. `guardMergeInterleaving` (src/compiler/rel/write.ts) conjoins the pair key, the
// `ord` order, `couldMatch` and the create-key test, and leaves out a part that holds for every pair rather than
// spelling it `1 = 1 AND`.
describe('a merge interleaving guard conjoins only real terms', () => {
  test("mergeV(constant).option(onMatch) over several traversers: the pair join has no '1 = 1'", () => {
    const plan = compile("g.V().hasLabel('person').mergeV([name:'zz']).option(Merge.onMatch, [x:1]).count()", {});
    if (plan.kind !== 'program') throw new Error('expected a program');
    const pairs = plan.steps.map((step) => step.emitted.sql).filter((sql) => /g_first/.test(sql) && /g_last/.test(sql) && /JOIN/.test(sql));
    expect(pairs.length).toBeGreaterThan(0);
    for (const sql of pairs) expect(sql).not.toContain('1 = 1');
  });
});
