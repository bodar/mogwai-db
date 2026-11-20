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
    // `branch()` is the same lowering under its own match policy: every admitting option, `Pick.any` included.
    ["g.V().local(__.out().V().branch(__.label()).option('person', __.dedup()).option(none, __.identity()).sample(100)).count()", 24],
    ["g.V().has('name','marko').local(__.out().V().branch(__.label()).option('person', __.dedup()).option(any, __.identity()).sample(100)).count()", 22],
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
  // (at any depth of the prefix), a reducer in a union arm. Depth gaps of the
  // general route, not of this fast path.
  test.each([
    "g.V().local(__.V().groupCount('x').sample(1)).cap('x')",
    "g.V().local(__.V().group('x').by(label).sample(2)).cap('x')",
    "g.V().property('c', __.V().groupCount('x').sample(1).id()).cap('x').select(values).unfold().sum()",
    "g.V().local(__.V().aggregate('a').sample(1)).cap('a')",
    "g.V().local(__.V().coin(0.5).sample(1)).count()",
    "g.V().local(__.V().where(__.coin(0.5)).sample(100)).count()",
    "g.V().local(__.out().V().union(__.count(), __.constant(0)).sample(100)).count()",
  ])('declines %s', (q) => {
    expect(() => compile(q, {})).toThrow(/not supported/);
  });

  // A collector in a CHILD body of the rooted read (a `sideEffect`/`where` body) is the connector's: keyed per
  // scope with its body (`keyedBody`), so every origin's re-sourced V() reaches it — six origins × six vertices.
  test('a collector in a child body of the rooted read collects per origin', () => {
    expect(count(seededStore(), "g.V().local(__.V().sideEffect(__.groupCount('a')).sample(1)).count()")).toBe(6);
    expect(count(seededStore(), "g.V().local(__.V().where(__.aggregate('x')).sample(100)).cap('x').unfold().count()")).toBe(36);
  });
});

// THE PER-ORIGIN DRAW CARRIES THE ORIGIN'S PATH AND SACK, as GraphStep's split does (`head.split(element, this)`,
// `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GraphStep.java:193-221`):
// the sack crosses unchanged and the path gains the element drawn — `splitInto`, the one rule `reSource` keeps too.
// The gate is GraphStep's own refusal (`splitRefuses`): a path rides only where the prefix does not MOVE (the
// re-source and filters), so the draw adds exactly one position. Before, a tracked path or a sack sent the draw to
// the origins × graph product: 417 ms at 1k holders, 6.9 s at 4k.
describe('the per-origin draw carries the origin path and sack', () => {
  /** Best of three after one warm-up. */
  const best = (f: () => unknown): number => {
    f();
    let ms = Infinity;
    for (let i = 0; i < 3; i++) { const t0 = performance.now(); f(); ms = Math.min(ms, performance.now() - t0); }
    return ms;
  };
  /** 1k → 8k traversers: linear is ≈8×, N log N ≈10×; the product route measured ≫16×. */
  const expectLinear = (small: number, large: number) => expect(large / Math.max(small, 5)).toBeLessThan(16);
  const small = graph(1000, 1000);
  const large = graph(8000, 8000);
  const scalar = (store: GraphStore, q: string): number => Number(bare(run(store, q))[0].v);

  test.each([
    ["g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(1)).path().count(local).sum()", 2],
    ["g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(1)).path().count()", 1],
    ["g.withSack(1).V().hasLabel('holder').local(__.V().hasLabel('person').sample(1)).sack().sum()", 1],
    ["g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(1)).simplePath().count()", 1],
    ["g.withSack(1).V().hasLabel('holder').local(__.V().hasLabel('person').sample(1)).sack(sum).by(constant(1)).sack().sum()", 2],
    ["g.V().hasLabel('holder').flatMap(__.V().hasLabel('person').sample(1)).path().count(local).sum()", 2],
    ["g.V().hasLabel('holder').union(__.local(__.V().hasLabel('person').where(__.has('name')).sample(1))).path().count(local).sum()", 2],
    ["g.V().hasLabel('holder').repeat(__.local(__.V().hasLabel('person').sample(1))).times(1).path().count(local).sum()", 2],
  ] as const)('%s is exact and linear', (q, perHolder) => {
    expect(scalar(small, q)).toBe(1000 * perHolder);
    expect(scalar(large, q)).toBe(8000 * perHolder);
    expectLinear(best(() => run(small, q)), best(() => run(large, q)));
  }, 60_000);

  test('each path is [holder, a person], drawn independently per holder', () => {
    const store = graph(300, 300);
    const paths = bare(run(store, "g.V().hasLabel('holder').as('h').local(__.V().hasLabel('person').sample(1)).path().by(label)"));
    expect(paths).toHaveLength(300);
    for (const row of paths) expect(JSON.parse(row.list).map((e: { v: string }) => e.v)).toEqual(['holder', 'person']);
    const drawn = bare(run(store, "g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(1)).path().by(id)"))
      .map((row: { list: string }) => JSON.parse(row.list));
    // The origin is each holder once; the draws spread over the 150 persons rather than one shared pick.
    expect(new Set(drawn.map((p: { v: number }[]) => p[0]!.v)).size).toBe(300);
    expect(new Set(drawn.map((p: { v: number }[]) => p[1]!.v)).size).toBeGreaterThan(50);
  });

  test('on modern every path is [origin, drawn]; a sack keeps its origin value', () => {
    const modern = seededStore();
    const NAMES = ['marko', 'vadas', 'lop', 'josh', 'ripple', 'peter'];
    const paths = bare(run(modern, "g.V().order().by('name').local(__.V().sample(1)).path().by('name')"))
      .map((row: { list: string }) => JSON.parse(row.list).map((e: { v: string }) => e.v));
    expect(paths.map((p: string[]) => p[0])).toEqual([...NAMES].sort());
    for (const p of paths) { expect(p).toHaveLength(2); expect(NAMES).toContain(p[1]); }
    expect(count(modern, "g.withSack(2).V().local(__.V().sample(1)).sack().sum()")).toBe(12);
    // After a hop the path is three long: the hop's position, then the draw's.
    expect(bare(run(modern, "g.V().out().local(__.V().sample(1)).path().count(local).dedup()"))).toEqual([{ v: 3 }]);
    // An edge re-source is the same split: [edge, edge].
    expect(bare(run(modern, "g.E().local(__.E().sample(1)).path().count(local).dedup()"))).toEqual([{ v: 2 }]);
  });

  // A MOVING prefix adds positions the draw does not hold, so the per-origin route refuses it and GraphStep's
  // product answers (every position extended there): [origin, V, out]. That product is origins × graph ahead of the
  // per-origin draw (as it was before the draw carried a path); a linear form needs the read's own path concatenated
  // onto the origin's after the join — residue in docs/outstanding-work.md.
  test('a moving prefix under a path falls through to the product, never a short path', () => {
    expect(bare(run(seededStore(), "g.V().local(__.V().out().sample(1)).path().count(local).dedup()"))).toEqual([{ v: 3 }]);
  });
});

// A RE-SOURCE INSIDE local() ON A PATH-TRACKED TRAVERSER: the child's path is the host's extended by the read's
// positions. While the read keeps its position (filters, reorders, slices) that is ONE position, so the connector's
// shared read answers — computed once, crossed with the hosts, the path extended after the join (`reSourcedBody`,
// `splitPosition`) — and a slice or reducer in it costs one evaluation, never hosts × graph. Where the read MOVES,
// the fold extends each later position over the cross; a stream barrier there would cut a hosts × graph product down
// per host, so it declines naming the shape.
describe('a re-source in local() on a path-tracked traverser', () => {
  const pathsOf = (q: string): string[][] => bare(run(seededStore(), q)).map((row: { list: string }) => JSON.parse(row.list).map((e: { v: string }) => e.v));

  test('answers host × read, each path the host extended by the read', () => {
    const modern = seededStore();
    expect(count(modern, "g.V().local(__.V().hasLabel('person')).path().count()")).toBe(24);
    expect(pathsOf("g.V().has('name','marko').local(__.V().hasLabel('software')).path().by('name')").sort())
      .toEqual([['marko', 'lop'], ['marko', 'ripple']]);
    expect(pathsOf("g.V().has('name','marko').local(__.V().hasLabel('software').in().simplePath()).path().by('name')").sort())
      .toEqual([['marko', 'lop', 'josh'], ['marko', 'lop', 'peter'], ['marko', 'ripple', 'josh']]);
    expect(pathsOf("g.V().has('name','vadas').local(__.V().hasLabel('software').order().by('name').limit(1)).path().by('name')"))
      .toEqual([['vadas', 'lop']]);
    expect(count(modern, "g.V().union(__.local(__.V().hasLabel('software'))).path().count()")).toBe(12);
  });

  test('scales with host × read', () => {
    const best = (f: () => unknown): number => { f(); let ms = Infinity; for (let i = 0; i < 3; i++) { const t0 = performance.now(); f(); ms = Math.min(ms, performance.now() - t0); } return ms; };
    // 20 persons per host: 20k then 160k paths.
    const q = "g.V().hasLabel('holder').local(__.V().hasLabel('person')).path().count(local).sum()";
    const small = graph(1000, 40), large = graph(8000, 40);
    expect(count(small, q)).toBe(40_000);
    expect(count(large, q)).toBe(320_000);
    expect(best(() => run(large, q)) / Math.max(best(() => run(small, q)), 5)).toBeLessThan(16);
  }, 60_000);

  describe('a slice in the shared read is cut once, never per host over hosts × graph', () => {
    const best = (f: () => unknown): number => { f(); let ms = Infinity; for (let i = 0; i < 3; i++) { const t0 = performance.now(); f(); ms = Math.min(ms, performance.now() - t0); } return ms; };
    const small = graph(1000, 1000), large = graph(8000, 8000);
    // The product route measured 432 ms → 29 s (limit) and 2.5 s @1k (order().limit), ≈4× per doubling.
    test.each([
      ["g.V().hasLabel('holder').local(__.V().hasLabel('person').limit(1)).path().count()", 1],
      ["g.V().hasLabel('holder').local(__.V().hasLabel('person').order().by('age').limit(1)).path().count()", 1],
      ["g.V().hasLabel('holder').local(__.V().hasLabel('person').range(0,1)).path().count(local).sum()", 2],
      ["g.V().hasLabel('holder').local(__.V().hasLabel('person').where(__.has('name')).dedup().limit(1)).path().count(local).sum()", 2],
      ["g.V().hasLabel('holder').local(__.V().hasLabel('person').limit(1).simplePath()).path().count()", 1],
      ["g.V().hasLabel('holder').union(__.local(__.V().hasLabel('person').limit(1)), __.identity()).path().count()", 2],
      ["g.V().hasLabel('holder').repeat(__.local(__.V().hasLabel('person').order().by('age').limit(1))).times(2).path().count(local).sum()", 3],
      ["g.V().hasLabel('holder').optional(__.V().hasLabel('person').limit(1)).path().count(local).sum()", 2],
      // A host-reading filter with no barrier after it is the cross the query asks for, extended in the fold.
      ["g.V().hasLabel('holder').as('h').flatMap(__.V().hasLabel('person').where(neq('h')).limit(1)).path().count()", 1],
    ] as const)('%s is exact and linear', (q, perHolder) => {
      expect(count(small, q)).toBe(1000 * perHolder);
      expect(count(large, q)).toBe(8000 * perHolder);
      expect(best(() => run(large, q)) / Math.max(best(() => run(small, q)), 5)).toBeLessThan(16);
    }, 60_000);

    test('each path is the host extended by the ONE element the read met', () => {
      const store = graph(50, 50);
      const paths = bare(run(store, "g.V().hasLabel('holder').local(__.V().hasLabel('person').order().by('age', desc).limit(1)).path().by(id)"))
        .map((row: { list: string }) => JSON.parse(row.list).map((e: { v: number }) => e.v));
      // The oldest person is the last odd-indexed candidate: id 100.
      expect(paths).toHaveLength(50);
      for (const [i, p] of paths.entries()) expect(p).toEqual([i + 1, 100]);
    });
  });

  // A barrier AFTER the read moves would cut hosts × graph per host: declined (the shared read would need a path
  // tracked from its own start, concatenated onto the host's after the cross — not built). So would a bounding
  // slice after a step that reads the HOST (`where(neq('h'))` cuts the shared read per host): the reference stops
  // at the bound, the product route measured 991 ms @1k → 15.7 s @4k.
  test.each([
    "g.V().local(__.V().out().limit(1)).path()",
    "g.V().local(__.V().hasLabel('person').out().order().by('name').limit(1)).path()",
    "g.V().hasLabel('person').as('h').local(__.V().hasLabel('person').where(neq('h')).limit(1)).path().count()",
    "g.V().hasLabel('person').as('h').local(__.V().hasLabel('person').where(neq('h')).order().by('age').limit(1)).path()",
    "g.V().hasLabel('person').as('h').local(__.V().hasLabel('person').where(neq('h')).range(0, 2)).simplePath().count()",
  ])('%s declines naming the shape', (q) => {
    expect(() => compile(q, {})).toThrow(/a V\(\)\/E\(\) inside local\(\) on a traverser whose path is tracked/);
  });

  // Without a bounding slice, a host-reading filter is the hosts × read rows the query streams: it answers.
  test('a host-reading filter with no slice after it answers host × read', () => {
    expect(count(seededStore(), "g.V().hasLabel('person').as('h').local(__.V().hasLabel('person').where(neq('h'))).path().count()")).toBe(12);
    expect(pathsOf("g.V().has('name','vadas').as('h').local(__.V().hasLabel('person').where(neq('h'))).path().by('name')").sort())
      .toEqual([['vadas', 'josh'], ['vadas', 'marko'], ['vadas', 'peter']]);
  });

  test.each([
    "g.V().hasLabel('person').as('h').local(__.V().hasLabel('person').where(neq('h')).count()).path()",
    "g.V().local(__.V().hasLabel('software').count()).path()",
    "g.V().local(__.V().hasLabel('software').fold()).path()",
  ])('%s declines naming the shape, never a wrong path', (q) => {
    expect(() => compile(q, {})).toThrow(/a V\(\)\/E\(\) inside local\(\) on a traverser whose path is tracked/);
  });
});

// A DRAW IN A ONCE-EVALUATED SPLIT READ. A `by()`/`map()` value, a `P` operand, a list operand or a write
// endpoint that re-sources (`__.V()…`) is lowered ONCE for every host (`rootedRead`'s 'split' gate), so a
// `sample`/`coin`/`shuffle` in it would be ONE random choice shared by every row, where the reference draws
// per traverser. Where the host may be MORE than one row it declines from the query text naming the
// problem — and, from a `map()`/`flatMap()` body, the per-row `local(…)` form, but ONLY where that form's
// per-origin draw admits the same body over the same input (`reSourcesOncePerOrigin`, the route's own gate,
// `src/compiler/rel/lower/reduction.ts`), so the advice never names a form that declines too. Where the host
// is provably ONE row (`rowBounds`, `src/rel/bounds.ts`: a source `addE`, `g.V(1)`, `g.inject(x)`) one draw
// IS the per-traverser draw, so it answers.
const SHARED = /a random draw \(sample\/coin\/shuffle\) inside a V\(\)\/E\(\) body is not supported where the body may run for more than one traverser — it would be drawn once and shared by every row/;
const LOCAL_HINT = /; local\(…\) draws per row, so use local\(__\.V\(\)…sample\(1\)\) in place of (map|flatMap)\(…\)$/;
describe('a draw in a body evaluated once for several hosts declines', () => {
  test.each([
    "g.V().project('x').by(__.V().sample(1).values('name'))",
    "g.V().order().by(__.V().order().by(shuffle).values('name'))",
    "g.V().values('age').is(gt(__.V().sample(1).values('age')))",
    "g.V().has('age', __.V().sample(1).values('age'))",
    "g.V().values('name').is(within(__.V().sample(1).values('name').fold()))",
    "g.V().where(__.V().sample(1).values('age').is(29))",
    "g.V().group().by(__.V().sample(1).values('name'))",
    "g.V().addE('x').to(__.V().sample(1))",
    // Two literal ids are two hosts, whatever the graph holds.
    "g.V(1,1).addE('x').to(__.V().sample(1))",
    "g.V(1,2).project('x').by(__.V().sample(1).values('name'))",
    // A one-row host INSIDE a per-row body is still evaluated once per statement.
    "g.V().local(__.V(1).project('x').by(__.V().sample(1).values('name')))",
    "g.V().V(1).project('x').by(__.V().sample(1).values('name'))",
    "g.V(1).out().project('x').by(__.V().sample(1).values('name'))",
    // A predicate operand is not row-bounded by its host, so even `V(1)`'s MAY run for several.
    "g.V(1).has('age', __.V().sample(1).values('age'))",
    // map()/flatMap() hosts whose local(…) form declines too: the advice would be a dead end.
    // A SCALAR host has no per-row rejoin.
    "g.inject(1,2).map(__.V().sample(1).values('name'))",
    "g.inject(1,2).flatMap(__.project('x').by(__.V().sample(1).values('name')))",
    // `coin` is not the per-origin draw.
    "g.V().map(__.V().coin(0.5).count())",
    // A path rides into the body and the prefix MOVES: the draw would add two positions, not one.
    "g.V().map(__.V().out().sample(1)).path()",
    // The draw sits under a by(), not at the body's re-source.
    "g.V().flatMap(__.project('x').by(__.V().sample(1).values('name')))",
    // Sufficient, not necessary: a stream barrier before the draw is outside the per-origin gate, so no
    // suggestion, though GraphStep's product happens to answer the local(…) form.
    "g.V().map(__.V().order().by(shuffle).limit(2).sample(1).values('name'))",
  ])('%s', (q) => {
    expect(() => compile(q, {})).toThrow(SHARED);
    expect(() => compile(q, {})).not.toThrow(LOCAL_HINT);
  });

  // One drawn row per host traverser: modern has 6 vertices and 6 out() traversers.
  test.each([
    ["g.V().map(__.V().sample(1).values('name'))", "g.V().local(__.V().sample(1).values('name')).count()", 6],
    ["g.V().out().map(__.V().hasLabel('person').sample(1).values('name'))", "g.V().out().local(__.V().hasLabel('person').sample(1).values('name')).count()", 6],
    ["g.V().as('a').map(__.V().sample(1)).select('a')", "g.V().as('a').local(__.V().sample(1)).select('a').count()", 6],
    ["g.V().map(__.V().sample(1).values('name').fold())", "g.V().local(__.V().sample(1).values('name').fold()).count()", 6],
    // A shuffle cut to one IS `sample(1)` (`ir/shuffle-cut.ts`), so it takes the same per-origin draw.
    ["g.V().map(__.V().order().by(shuffle).limit(1).values('name'))", "g.V().local(__.V().order().by(shuffle).limit(1).values('name')).count()", 6],
    // A sack crosses the split as any carried channel does (`splitInto`), so the per-row form draws per origin.
    ["g.withSack(1).V().map(__.V().sample(1))", "g.withSack(1).V().local(__.V().sample(1)).count()", 6],
  ] as const)('%s names the per-row local() form, and that form answers', (q, local, n) => {
    expect(() => compile(q, {})).toThrow(SHARED);
    expect(() => compile(q, {})).toThrow(LOCAL_HINT);
    expect(count(seededStore(), local)).toBe(n);
  });
});

describe('a draw in a body evaluated for ONE host answers', () => {
  const NAMES = ['marko', 'vadas', 'lop', 'josh', 'ripple', 'peter'];
  const nameOf = (store: GraphStore, id: unknown): string => bare(run(store, `g.V(${id}).values('name')`))[0].v;

  test('a source addE draws each endpoint from the graph', () => {
    const store = seededStore();
    const [edge] = bare(run(store, "g.addE('rnd').from(__.V().sample(1)).to(__.V().sample(1))"));
    expect(edge.label).toBe('rnd');
    expect(NAMES).toContain(nameOf(store, edge.src));
    expect(NAMES).toContain(nameOf(store, edge.tgt));
    expect(count(store, "g.E().hasLabel('rnd').count()")).toBe(1);
  });

  test('a one-vertex addE draws its other end', () => {
    const store = seededStore();
    const [edge] = bare(run(store, "g.V(1).addE('x').to(__.V().sample(1))"));
    expect(edge.src).toBe(1);
    expect(NAMES).toContain(nameOf(store, edge.tgt));
  });

  test('a ZERO-row host draws nothing and writes nothing', () => {
    const store = seededStore();
    const before = count(store, 'g.E().count()');
    expect(bare(run(store, "g.V(99).addE('x').to(__.V().sample(1))"))).toEqual([]);
    expect(count(store, 'g.E().count()')).toBe(before);
    expect(count(store, "g.E().hasLabel('x').count()")).toBe(0);
  });

  test('two by() draws over one host are INDEPENDENT draws, not one shared pick', () => {
    // Each by() is its own child traversal, produced per key (`TraversalUtil.produce` in `ProjectStep.map`,
    // `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ProjectStep.java`), so one host
    // gets two draws. 6 vertices × 40 tries: they coincide every time with probability 6^-40.
    const store = seededStore();
    const ids = new Set<number>();
    let differed = false;
    for (let i = 0; i < 40; i++) {
      const [row] = bare(run(store, "g.V(1).project('a','b').by(__.V().sample(1).id()).by(__.V().sample(1).id())"));
      const [[, a], [, b]] = JSON.parse(row.map) as [unknown, { v: number }][];
      ids.add(a!.v).add(b!.v);
      if (a!.v !== b!.v) differed = true;
    }
    expect([...ids].every((id) => [1, 2, 3, 4, 5, 6].includes(id))).toBe(true);
    expect(differed).toBe(true);
  });

  test('a drawn endpoint is ONE draw: the absence guard and the insert agree', () => {
    // Half the vertices have no `created` out-edge. Drawn separately by the guard and the insert, the
    // insert hit NOT NULL on a draw the guard never saw; drawn once, it either writes or refuses cleanly.
    const store = seededStore();
    for (let i = 0; i < 20; i++) {
      try {
        const [edge] = bare(run(store, "g.V(1).addE('x').to(__.V().sample(1).out('created'))"));
        expect([3, 5]).toContain(edge.tgt);
      } catch (e) {
        expect((e as Error).message).toMatch(/to\(\) traversal \(which should give a Vertex\) failed/);
      }
    }
  });

  test.each([
    ["g.V(1).project('x').by(__.V().sample(1).values('name'))", (rows: any[]) => JSON.parse(rows[0].map)[0][1].v],
    ["g.inject(1).map(__.V().sample(1).values('name'))", (rows: any[]) => rows[0].v],
    ["g.V().hasId(1).map(__.V().sample(1).values('name'))", (rows: any[]) => rows[0].v],
    ["g.V().count().project('x').by(__.V().sample(1).values('name'))", (rows: any[]) => JSON.parse(rows[0].map)[0][1].v],
  ] as const)('%s', (q, valueOf) => {
    const rows = bare(run(seededStore(), q));
    expect(rows).toHaveLength(1);
    expect(NAMES).toContain(valueOf(rows));
  });


  test('the per-row forms keep answering, one draw per traverser', () => {
    const store = graph(30, 30);
    expect(count(store, "g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(1)).count()")).toBe(30);
    expect(count(store, "g.V().hasLabel('holder').flatMap(__.V().hasLabel('person').order().by(shuffle).limit(1)).count()")).toBe(30);
    expect(count(store, "g.V().hasLabel('holder').property('c', __.V().hasLabel('person').sample(1).values('name')).values('c').dedup().count()"))
      .toBeGreaterThan(1);
  });
});
