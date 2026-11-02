// A PER-TRAVERSER `sample()` OVER A ROOTED BODY IS LINEAR IN THE TRAVERSERS — `property(k, __.V()…sample(1)…)`,
// `local(__.V().sample(1))`, every per-origin body that re-sources the graph and then draws.
//
// GraphStep inside a per-traverser body emits the graph PER INCOMING TRAVERSER, and the body used to be
// lowered literally: a `RANDOM()` window partitioned by origin over origins × graph, with the body's own
// `hasLabel` applied above the product. Measured on trunk: 1.8 s at 1k holders × 1k candidates, 28 s at 4k
// and 169 s at 8k — passing every six-vertex fixture, a CPU wall only a production-sized DO reaches. The
// prefix up to the draw is origin-INDEPENDENT, so it is now lowered ONCE (`reSourcedOnce`,
// `src/compiler/rel/lower/reduction.ts`) and `sample(n)` draws n distinct numbered candidates per origin
// (Floyd's algorithm) through an equi-join: O(origins · n² + candidates). A prefix that cannot be evaluated
// once declines rather than falling back to the product.
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
import { bare, run } from '../support/harness.ts';

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
    // Three values on every holder, three DIFFERENT persons' ages (Floyd's draw never repeats an index).
    expect(count(small, "g.V().hasLabel('holder').where(__.values('l').dedup().count().is(3)).count()")).toBe(200);
    expect(count(small, "g.V().hasLabel('holder').values('l').is(lte(200)).count()")).toBe(0);
    // n beyond the candidates takes them all: a sample never repeats a traverser.
    expect(count(small, "g.V().hasLabel('holder').limit(3).local(__.V().hasLabel('person').sample(500).dedup()).count()")).toBe(300);
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
  ])('declines %s', (q) => {
    expect(() => compile(q, {})).toThrow(/not supported/);
  });
});
