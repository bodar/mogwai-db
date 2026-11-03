// A PER-TRAVERSER `sample()` OVER A ROOTED BODY IS LINEAR IN THE TRAVERSERS — `property(k, __.V()…sample(1)…)`,
// `local(__.V().sample(1))`, every per-origin body that re-sources the graph and then draws.
//
// GraphStep inside a per-traverser body emits the graph PER INCOMING TRAVERSER, and the body used to be
// lowered literally: a `RANDOM()` window partitioned by origin over origins × graph, with the body's own
// `hasLabel` applied above the product. Measured on trunk: 1.8 s at 1k holders × 1k candidates, 28 s at 4k
// and 169 s at 8k — passing every six-vertex fixture, a CPU wall only a production-sized DO reaches. The
// prefix up to the draw is origin-INDEPENDENT, so it is now lowered ONCE (`reSourcedOnce`,
// `src/compiler/rel/lower/reduction.ts`) and `sample(n)` draws n distinct numbered candidates per origin
// (3n+4 draws with replacement, keeping the first n distinct, where 2n <= the origin's P rows; else a
// RANDOM() rank of those P < 2n rows) through an equi-join: O(origins · n log n + candidates). A prefix that
// cannot be evaluated once declines rather than falling back to the product.
//
// Assertions of two kinds: the ANSWER (cardinality per origin, the draw lands in the candidate set, draws are
// independent per origin, a sample of nothing is nothing) and a WALL budget generous enough for a loaded CI
// runner yet far below the quadratic cost.
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { runSteps } from '../../src/program.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { rawVertex } from '../support/graph.ts';
import { bare, run, seededStore } from '../support/harness.ts';

const N = 6000;
/** Quadratic was ≥ 60 s at this size on trunk; linear is ~0.1 s. */
const BUDGET_MS = 3000;

/** `holders` holder vertices, then `candidates` alternating person/software, each with a name and an age. */
function graph(holders: number, candidates: number): GraphStore {
  const raw = new BunSqlite(':memory:');
  const store = new GraphStore(raw);
  raw.exec('BEGIN');
  let id = 1;
  for (let i = 0; i < holders; i++) rawVertex(store, id++, 'holder');
  for (let i = 0; i < candidates; i++) {
    const v = id++;
    rawVertex(store, v, i % 2 ? 'person' : 'software');
    store.query('INSERT INTO vertex_properties(node,key,value,vtype) VALUES(?,?,?,?)', [v, 'name', `n${v}`, 'string']);
    store.query('INSERT INTO vertex_properties(node,key,value,vtype) VALUES(?,?,?,?)', [v, 'age', v, 'int']);
  }
  raw.exec('COMMIT');
  return store;
}

const count = (store: GraphStore, q: string): number => bare(run(store, q))[0].v;

/** Execute one traversal's statements, timing execution only (compile is constant in the graph size). */
function timed(store: GraphStore, q: string): { rows: any[]; ms: number } {
  const compiled = compile(q, {});
  const start = performance.now();
  const rows = compiled.kind === 'program' ? [...runSteps(store, compiled)] : store.query(compiled.sql, compiled.binds);
  return { rows: bare(rows), ms: performance.now() - start };
}

describe('a rooted body sampled per traverser is lowered once and drawn per origin', () => {
  test('property(list, k, __.V()…sample(1)…) over 6k holders × 6k candidates runs inside the budget', () => {
    const store = graph(N, N);
    const { rows, ms } = timed(store, "g.V().hasLabel('holder').property(list,'l', __.V().hasLabel('person','software').sample(1).values('age')).count()");
    expect(rows).toEqual([{ v: N }]);
    expect(ms).toBeLessThan(BUDGET_MS);
    // EXACTLY one value per holder, and every one of them a candidate's age.
    expect(count(store, "g.V().hasLabel('holder').properties('l').count()")).toBe(N);
    expect(count(store, "g.V().hasLabel('holder').where(__.properties('l').count().is(1)).count()")).toBe(N);
    expect(count(store, `g.V().hasLabel('holder').values('l').is(gt(${N})).count()`)).toBe(N);
  });

  test('the candidate filter runs before the origins are met — no statement crosses the origins with the graph', () => {
    const compiled = compile("g.V().hasLabel('holder').property('c', __.V().hasLabel('person').sample(1).values('name'))", {});
    if (compiled.kind !== 'program') throw new Error('expected a write program');
    // The old plan's tell: `… CROSS JOIN nodes rn) ro27` — a product with the graph, no ON to seek by.
    for (const step of compiled.steps) expect(step.emitted.sql).not.toMatch(/CROSS JOIN nodes \w+\)/);
  });

  test('every holder gets exactly one person name, drawn independently per holder', () => {
    const store = graph(1000, 1000);
    run(store, "g.V().hasLabel('holder').property('c', __.V().hasLabel('person').sample(1).values('name'))");
    expect(count(store, "g.V().hasLabel('holder').properties('c').count()")).toBe(1000);
    // Persons are the odd-indexed candidates — ids 1002, 1004, … — so every drawn name is one of theirs.
    const persons = new Set(Array.from({ length: 500 }, (_, i) => `n${1002 + 2 * i}`));
    const names = bare(run(store, "g.V().hasLabel('holder').values('c')")).map((row: any) => row.v ?? row);
    expect(names.every((name: string) => persons.has(name))).toBe(true);
    // 1000 independent uniform draws over 500 names leave ~432 distinct; ONE draw shared by every holder
    // would leave 1.
    expect(new Set(names).size).toBeGreaterThan(300);
  });

  test('a sample of nothing is nothing — the property is not written, the holders still pass', () => {
    const store = graph(100, 100);
    expect(count(store, "g.V().hasLabel('holder').property('c', __.V().hasLabel('nope').sample(1).values('name')).count()")).toBe(100);
    expect(count(store, "g.V().properties('c').count()")).toBe(0);
  });

  test('local(__.V().sample(1)) answers one vertex per traverser, local(__.V().sample(2)) two', () => {
    const store = graph(50, 50);
    expect(count(store, 'g.V().local(__.V().sample(1)).count()')).toBe(100);
    expect(count(store, 'g.V().local(__.V().sample(2)).count()')).toBe(200);
    expect(count(store, "g.V().local(__.V().hasLabel('nope').sample(1)).count()")).toBe(0);
    expect(count(store, 'g.V().local(__.V().sample(0)).count()')).toBe(0);
  });

  test('the draw composes at depth — a branch arm, a union, a scalar prefix, a later hop, an outer label', () => {
    const store = graph(40, 40);
    expect(count(store, "g.V().hasLabel('holder').local(__.union(__.V().hasLabel('person').sample(1), __.V().hasLabel('software').sample(1))).count()")).toBe(80);
    expect(count(store, "g.V().hasLabel('holder').local(__.choose(__.hasLabel('holder'), __.V().hasLabel('person').sample(1), __.identity())).hasLabel('person').count()")).toBe(40);
    expect(count(store, "g.V().hasLabel('holder').local(__.V().hasLabel('person').values('name').sample(1)).count()")).toBe(40);
    expect(count(store, "g.V().hasLabel('holder').flatMap(__.V().hasLabel('person').sample(1).values('name')).count()")).toBe(40);
    expect(count(store, "g.V().hasLabel('holder').as('h').local(__.V().hasLabel('person').sample(1).as('p')).select('h','p').dedup().count()")).toBe(40);
  });

  test('a top-level sample keeps its fence — sample(1).fold() is one member', () => {
    const store = graph(10, 10);
    expect(count(store, "g.V().hasLabel('person').sample(1).fold().count(local)")).toBe(1);
    expect(count(store, "g.V().hasLabel('person').sample(3).fold().count(local)")).toBe(3);
  });

  test('sample(n > 1) is linear too — n DISTINCT picks per origin, each a candidate', () => {
    const store = graph(N, N);
    for (const q of [
      "g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(2)).count()",
      "g.V().hasLabel('holder').flatMap(__.V().sample(2)).hasLabel('person','software','holder').count()",
    ]) {
      const { rows, ms } = timed(store, q);
      expect(rows).toEqual([{ v: 2 * N }]);
      expect(ms).toBeLessThan(BUDGET_MS);
    }
    const small = graph(200, 200);
    run(small, "g.V().hasLabel('holder').property(list,'l', __.V().hasLabel('person').sample(3).values('age'))");
    // Three values on every holder, three DIFFERENT persons' ages (the draw never repeats an index).
    expect(count(small, "g.V().hasLabel('holder').where(__.values('l').dedup().count().is(3)).count()")).toBe(200);
    expect(count(small, "g.V().hasLabel('holder').values('l').is(lte(200)).count()")).toBe(0);
    // n beyond the candidates takes them all: a sample never repeats a traverser.
    expect(count(small, "g.V().hasLabel('holder').limit(3).local(__.V().hasLabel('person').sample(500).dedup()).count()")).toBe(300);
  });

  test('a barrier in a per-traverser child of the prefix couples nothing; one in an arm over a single row is evaluated once', () => {
    const store = graph(20, 20);
    // V() opens the body, so each origin has one row; the arm's limit(1) runs over its ONE copy of the graph.
    expect(count(store, "g.V().hasLabel('holder').local(__.V().union(__.hasLabel('person').limit(1)).sample(2)).count()")).toBe(20);
    // AFTER a fan-out (marko/josh/peter have 3/2/1 out-edges, so R = 3/2/1 rows each): a dedup in a `where()`
    // child runs per candidate, so the 3 persons with out-edges stand R times each — sample(30) takes all 18.
    const modern = seededStore();
    expect(count(modern, "g.V().local(__.out().V().hasLabel('person').where(__.out().dedup().count().is(gt(0))).sample(30)).count()")).toBe(18);
  });

  test('sample(n) with n at least the candidates stays linear — each origin ranks its own rows', () => {
    // 10 origins × M candidates, n ≥ M: q = M, the dense route — ranking the origin's own M rows, ~0.1 s.
    const store = graph(10, N);
    const { rows, ms } = timed(store, "g.V().hasLabel('holder').local(__.V().hasLabel('person','software').sample(100000)).count()");
    expect(rows).toEqual([{ v: 10 * N }]);
    expect(ms).toBeLessThan(BUDGET_MS);
    // Every candidate at most once per origin, whichever route draws it: 2q > P ranks, 2q <= P draws.
    const small = graph(5, 40);
    expect(count(small, "g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(15).dedup()).count()")).toBe(75);
    expect(count(small, "g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(4).dedup()).count()")).toBe(20);
    expect(count(small, "g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(10).dedup()).count()")).toBe(50);
  });

  test('sample(n) between √P and P stays linear — no origin ranks P rows to keep n << P of them', () => {
    // The band a q²-vs-P route choice sent to the rank: 2000 origins × 8000 persons, sample(100) (q² > P) —
    // 16M ranked (origin, candidate) pairs before (9.9 s measured), 200k drawn indexes now (~1 s).
    const store = graph(2000, 16000);
    const { rows, ms } = timed(store, "g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(100)).count()");
    expect(rows).toEqual([{ v: 200_000 }]);
    expect(ms).toBeLessThan(BUDGET_MS);
    // ... and n DISTINCT per origin: a per-origin dedup removes none of them.
    expect(count(store, "g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(100).dedup()).count()")).toBe(200_000);
  });

  test('the draw is a uniform subset — every 2-subset of 4 persons about equally often', () => {
    // Sparse (2·2 <= 4: draws with replacement, first two distinct) and dense (sample(3): 2·3 > 4, ranked).
    const store = graph(4000, 8);
    for (const [n, subsets] of [[2, 6], [3, 4]] as const) {
      const lists = bare(run(store, `g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(${n}).values('name').order().fold())`));
      const freq = new Map<string, number>();
      for (const row of lists) { const key = String(row.list ?? row); freq.set(key, (freq.get(key) ?? 0) + 1); }
      expect(freq.size).toBe(subsets);
      // 4000 / 6 ≈ 667 (σ ≈ 24), 4000 / 4 = 1000 (σ ≈ 27): a skew of 7σ fails, chance alone almost never.
      for (const seen of freq.values()) expect(Math.abs(seen - 4000 / subsets)).toBeLessThan(200);
    }
  });

  test('a shuffle no slice observes is harmless; a host-reading prefix keeps its own product', () => {
    const store = graph(N, N);
    const { rows, ms } = timed(store, "g.V().hasLabel('holder').local(__.V().order().by(shuffle).sample(1)).count()");
    expect(rows).toEqual([{ v: N }]);
    expect(ms).toBeLessThan(BUDGET_MS);
    const small = graph(30, 30);
    expect(count(small, "g.V().hasLabel('holder').as('h').local(__.V().where(neq('h')).sample(1)).count()")).toBe(30);
    // A body-opening re-source has one row per origin, so a coupling barrier before the draw is evaluated once.
    // The two youngest persons are ids (= ages) 32 and 34.
    const youngest = "g.V().hasLabel('holder').local(__.V().hasLabel('person').order().by('age').limit(2).sample(1)).values('age')";
    expect(count(small, `${youngest}.count()`)).toBe(30);
    expect(count(small, `${youngest}.is(gt(34)).count()`)).toBe(0);
  });

  // What a once-evaluated prefix cannot be, the draw DECLINES rather than answering wrong or crossing the
  // origins with the graph: a side-effect collector counts PER origin in the reference (6 × 6 on the
  // modern graph, where one evaluation counts each vertex once), a draw or a sliced shuffle would be
  // shared by every origin, and a coupling barrier after a fan-out sees R concatenated copies.
  test.each([
    "g.V().local(__.V().groupCount('x').sample(1)).cap('x')",
    "g.V().local(__.V().group('x').by(label).sample(2)).cap('x')",
    "g.V().property('c', __.V().groupCount('x').sample(1).id()).cap('x').select(values).unfold().sum()",
    "g.V().local(__.V().aggregate('a').sample(1)).cap('a')",
    "g.V().local(__.V().sideEffect(__.groupCount('a')).sample(1)).count()",
    "g.V().local(__.V().coin(0.5).sample(1)).count()",
    "g.V().local(__.V().order().by(shuffle).limit(2).sample(1)).count()",
    "g.V().local(__.out().V().dedup().sample(2)).count()",
    "g.V().local(__.V().as('x').sample(1).select('x')).count()",
    // A barrier in a union/choose arm or a repeat body sees every start fed into it — the R concatenated
    // copies — exactly as a top-level one does (`BranchStep.java:168`), so it couples them too.
    "g.V().has('name','marko').local(__.out().V().union(__.dedup()).sample(100)).count()",
    "g.V().local(__.out().V().union(__.dedup(), __.identity()).sample(100)).count()",
    "g.V().local(__.out().V().union(__.limit(1), __.identity()).sample(100)).count()",
    "g.V().local(__.out().V().union(__.count(), __.constant(0)).sample(100)).count()",
    "g.V().local(__.out().V().choose(__.constant(true), __.dedup(), __.identity()).sample(100)).count()",
    "g.V().local(__.out().V().union(__.union(__.dedup())).sample(100)).count()",
    "g.V().local(__.out().V().repeat(__.dedup()).times(1).sample(100)).count()",
    "g.V().has('name','marko').property(list,'c', __.out().V().union(__.dedup().id()).sample(100)).values('c').count()",
    // An option() arm is a global child of its choose/branch (`BranchStep.getGlobalChildren`) — the same
    // concatenated stream, one level down.
    "g.V().has('name','marko').local(__.out().V().choose(__.label()).option('person', __.dedup()).option('software', __.identity()).sample(100)).count()",
    "g.V().has('name','marko').flatMap(__.out().V().choose(__.label()).option('person', __.dedup()).option('software', __.identity()).sample(100)).count()",
    "g.V().local(__.out().V().choose(__.label()).option('person', __.limit(1)).option(none, __.identity()).sample(100)).count()",
    "g.V().has('name','marko').local(__.out().V().choose(__.values('age')).option(29, __.dedup()).option(none, __.identity()).sample(100)).count()",
    "g.V().local(__.out().V().branch(__.label()).option('person', __.dedup()).option(none, __.identity()).sample(100)).count()",
    "g.V().local(__.V().order().by(shuffle).choose(__.label()).option('person', __.limit(1)).option(none, __.limit(1)).sample(5)).dedup().count()",
    // ... and a slice there observes a shuffle every origin would otherwise share.
    "g.V().local(__.V().order().by(shuffle).union(__.limit(1)).sample(1)).dedup().count()",
    "g.V().local(__.V().order().by(shuffle).choose(__.constant(true), __.limit(1), __.limit(1)).sample(5)).dedup().count()",
  ])('declines %s', (q) => {
    expect(() => compile(q, {})).toThrow(/not supported/);
  });
});
