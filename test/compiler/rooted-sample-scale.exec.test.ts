// A PER-TRAVERSER `sample()` OVER A ROOTED BODY IS LINEAR IN THE TRAVERSERS — `property(k, __.V()…sample(1)…)`,
// `local(__.V().sample(1))`, every per-origin body that re-sources the graph and then draws.
//
// GraphStep inside a per-traverser body emits the graph PER INCOMING TRAVERSER, and the body used to be
// lowered literally: a `RANDOM()` window partitioned by origin over origins × graph, with the body's own
// `hasLabel` applied above the product. Measured on trunk: 1.8 s at 1k holders × 1k candidates, 28 s at 4k
// and 169 s at 8k — passing every six-vertex fixture, a CPU wall only a production-sized DO reaches. The
// prefix up to the draw is origin-INDEPENDENT, so it is now lowered ONCE (`reSourcedOnce`,
// `src/compiler/rel/lower/reduction.ts`): `sample(1)` draws ONE numbered candidate per origin through an
// equi-join, O(origins + candidates); `sample(n > 1)` ranks each origin's (row, candidate) pairs by RANDOM()
// and keeps n — origins × CANDIDATES, the traversers the reference streams (an owner's trade for deleting a
// with-replacement walk), never origins × the whole graph. A prefix that
// cannot be evaluated once (a barrier, a branch, a label, a draw, a collector) is not this fast path's: it
// falls through to GraphStep's cross join, the reference's own origins × candidates traversers.
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

  // The draw and the plain re-source share ONE crossing (`crossCarried`, `rel/lower/movement.ts`): the origin's
  // bulk is promoted before the join and carried into a later movement, an arriving position is re-minted
  // origin-major then candidate order, and a carried label survives. n >= the candidates makes it deterministic.
  test('the draw crosses the origin channels as a re-source does — bulk, position, label', () => {
    const modern = seededStore();
    const names = (q: string) => bare(run(modern, q)).map((row: { v: unknown }) => row.v);
    // Within one origin the draw imposes no order, so each origin's pair is compared as a set.
    const pairs = (q: string) => {
      const all = names(q);
      return Array.from({ length: all.length / 2 }, (_, i) => all.slice(2 * i, 2 * i + 2).sort());
    };
    const perOrigin = Array(6).fill(['lop', 'ripple']);
    expect(pairs("g.V().order().by('name').local(__.V().hasLabel('software').sample(2)).values('name')")).toEqual(perOrigin);
    expect(pairs("g.V().order().by('name').V().hasLabel('software').values('name')")).toEqual(perOrigin);
    // Four persons per origin, out('created'): marko 1 + josh 2 + peter 1, six origins — summed through the bulk.
    expect(count(modern, "g.V().local(__.V().hasLabel('person').sample(4)).out('created').count()")).toBe(24);
    expect(names("g.V().order().by('name').as('a').local(__.V().hasLabel('software').sample(2)).select('a').values('name')"))
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas'].flatMap((name) => [name, name]));
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

  test('sample(n > 1) — n DISTINCT picks per origin, each a candidate', () => {
    const small = graph(200, 200);
    expect(count(small, "g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(2)).count()")).toBe(400);
    expect(count(small, "g.V().hasLabel('holder').flatMap(__.V().sample(2)).hasLabel('person','software','holder').count()")).toBe(400);
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

  test('sample(n) keeps every candidate at most once per origin, n below or beyond the candidates', () => {
    expect(count(graph(10, 100), "g.V().hasLabel('holder').local(__.V().hasLabel('person','software').sample(100000)).count()")).toBe(1000);
    const small = graph(5, 40);
    expect(count(small, "g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(15).dedup()).count()")).toBe(75);
    expect(count(small, "g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(4).dedup()).count()")).toBe(20);
    expect(count(small, "g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(10).dedup()).count()")).toBe(50);
  });

  // A positioned body (`property()`) must not take GraphStep's product for n > 1: that re-mints a position over
  // origins × the whole GRAPH before the candidate filter runs (32 s at 8k holders). Origins × candidates here.
  test('property(list, k, __.V()…sample(2)…) over many holders and few candidates runs inside the budget', () => {
    const store = graph(N, 8);
    const { rows, ms } = timed(store, "g.V().hasLabel('holder').property(list,'l', __.V().hasLabel('person').sample(2).values('age')).count()");
    expect(rows).toEqual([{ v: N }]);
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(count(store, "g.V().hasLabel('holder').where(__.values('l').dedup().count().is(2)).count()")).toBe(N);
  });

  test('the draw is a uniform subset — every 2-subset of 4 persons about equally often', () => {
    // Each origin's (row, candidate) pairs ranked by RANDOM(): 4000 holders × 8 candidates is 32k pairs.
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

  test('a barrier or a host-reading prefix keeps its own product', () => {
    const small = graph(30, 30);
    expect(count(small, "g.V().hasLabel('holder').local(__.V().order().by(shuffle).sample(1)).count()")).toBe(30);
    expect(count(small, "g.V().hasLabel('holder').as('h').local(__.V().where(neq('h')).sample(1)).count()")).toBe(30);
    // The slice runs per origin over that origin's own copy of the graph. The two youngest persons are ids
    // (= ages) 32 and 34.
    const youngest = "g.V().hasLabel('holder').local(__.V().hasLabel('person').order().by('age').limit(2).sample(1)).values('age')";
    expect(count(small, `${youngest}.count()`)).toBe(30);
    expect(count(small, `${youngest}.is(gt(34)).count()`)).toBe(0);
  });


  // What a once-evaluated prefix cannot be — a stream barrier, a branch, a label, a slice over a shuffle — is
  // not the fast path's, and it FALLS THROUGH to GraphStep's cross join rather than declining: the reference
  // streams R concatenated copies of the graph per origin (`GraphStep.java`), and the product route is that
  // stream. Modern graph: out() gives marko/josh/peter R = 3/2/1 rows, every other origin none. A barrier in a
  // union/choose/option arm or a repeat body sees all R copies (`BranchStep.java:168`), so a dedup there keeps
  // one; an unproductive choice goes to `none` (`BranchStep.pickBranches`).
  test.each([
    ["g.V().local(__.out().V().dedup().sample(100)).count()", 18],
    ["g.V().local(__.out().V().dedup().sample(2)).count()", 6],
    ["g.V().local(__.V().order().by(shuffle).limit(2).sample(100)).count()", 12],
    ["g.V().local(__.V().order().by(shuffle).limit(2).sample(1)).count()", 6],
    ["g.V().local(__.V().as('x').sample(100).select('x')).count()", 36],
    ["g.V().local(__.V().as('x').sample(1).select('x')).count()", 6],
    ["g.V().has('name','marko').local(__.out().V().union(__.dedup()).sample(100)).count()", 6],
    ["g.V().local(__.out().V().union(__.dedup(), __.identity()).sample(100)).count()", 54],
    ["g.V().local(__.out().V().union(__.limit(1), __.identity()).sample(100)).count()", 39],
    ["g.V().local(__.out().V().choose(__.constant(true), __.dedup(), __.identity()).sample(100)).count()", 18],
    ["g.V().local(__.out().V().union(__.union(__.dedup())).sample(100)).count()", 18],
    ["g.V().local(__.out().V().repeat(__.dedup()).times(1).sample(100)).count()", 18],
    ["g.V().has('name','marko').property(list,'c', __.out().V().union(__.dedup().id()).sample(100)).values('c').count()", 6],
    ["g.V().has('name','marko').local(__.out().V().choose(__.label()).option('person', __.dedup()).option('software', __.identity()).sample(100)).count()", 10],
    ["g.V().has('name','marko').flatMap(__.out().V().choose(__.label()).option('person', __.dedup()).option('software', __.identity()).sample(100)).count()", 10],
    ["g.V().local(__.out().V().choose(__.label()).option('person', __.limit(1)).option(none, __.identity()).sample(100)).count()", 15],
    ["g.V().has('name','marko').local(__.out().V().choose(__.values('age')).option(29, __.dedup()).option(none, __.identity()).sample(100)).count()", 16],
    // ... at depth: inside a union arm, a flatMap, after an outer label.
    ["g.V().union(__.local(__.out().V().dedup().sample(100))).count()", 18],
    ["g.V().flatMap(__.out().V().dedup().sample(100)).count()", 18],
    ["g.V().as('a').local(__.out().V().dedup().sample(100)).select('a').dedup().count()", 3],
    ["g.V().local(__.out().V().as('x').sample(100).select('x').dedup()).count()", 18],
  ] as const)('falls through to the product: %s', (q, expected) => {
    expect(count(seededStore(), q)).toBe(expected);
  });

  // A slice over a shuffle draws per origin: how many distinct vertices six origins land on is a range.
  test.each([
    ["g.V().local(__.V().order().by(shuffle).choose(__.label()).option('person', __.limit(1)).option(none, __.limit(1)).sample(5)).dedup().count()", 2, 6],
    ["g.V().local(__.V().order().by(shuffle).union(__.limit(1)).sample(1)).dedup().count()", 1, 6],
    ["g.V().local(__.V().order().by(shuffle).choose(__.constant(true), __.limit(1), __.limit(1)).sample(5)).dedup().count()", 1, 6],
  ] as const)('falls through to the product, drawn per origin: %s', (q, low, high) => {
    const seen = count(seededStore(), q);
    expect(seen).toBeGreaterThanOrEqual(low);
    expect(seen).toBeLessThanOrEqual(high);
  });

  // What the product route ITSELF does not lower yet stays a clear refusal — a side-effect collector, a coin
  // (at any depth of the prefix), a reducer in a union arm, a branch() over options. Depth gaps of the
  // general route, not of this fast path.
  test.each([
    "g.V().local(__.V().groupCount('x').sample(1)).cap('x')",
    "g.V().local(__.V().group('x').by(label).sample(2)).cap('x')",
    "g.V().property('c', __.V().groupCount('x').sample(1).id()).cap('x').select(values).unfold().sum()",
    "g.V().local(__.V().aggregate('a').sample(1)).cap('a')",
    "g.V().local(__.V().sideEffect(__.groupCount('a')).sample(1)).count()",
    "g.V().local(__.V().where(__.aggregate('x')).sample(100)).count()",
    "g.V().local(__.V().coin(0.5).sample(1)).count()",
    "g.V().local(__.V().where(__.coin(0.5)).sample(100)).count()",
    "g.V().local(__.out().V().union(__.count(), __.constant(0)).sample(100)).count()",
    "g.V().local(__.out().V().branch(__.label()).option('person', __.dedup()).option(none, __.identity()).sample(100)).count()",
  ])('declines %s', (q) => {
    expect(() => compile(q, {})).toThrow(/not supported/);
  });
});
