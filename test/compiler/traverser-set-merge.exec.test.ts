// THE TRAVERSERSET MERGE — `bulkingPositions` (`src/compiler/ir/bulk.ts`) places every merge the reference
// makes, and `regroupFirstOccurrence` (`src/compiler/rel/build.ts`) reproduces one on the emission order.
// The L4 addendum (`traverser-set-merge.feature`) pins the reference answers; this file pins the
// MECHANISM: where the scan places a merge, where it refuses to say, and the one-drain window past which a
// merge RAISES rather than merging across a boundary the reference does not.
import { test, expect, describe } from 'bun:test';
import { parseGremlin, stepChain, extractStrategies } from '../../src/gremlin/frontend.ts';
import { runPasses } from '../../src/compiler/ir/passes.ts';
import { bulkingPositions, MAX_BARRIER_SIZE, referenceUnbulkedAt } from '../../src/compiler/ir/bulk.ts';
import { MERGE_WINDOW_EXCEEDED } from '../../src/compiler/rel/lower.ts';
import { RaisedByQuery } from '../../src/rel/raise.ts';
import { seededStore } from '../support/harness.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { loadCsv } from '../../src/formats/csv.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';

const ir = (q: string) => {
  const tree = parseGremlin(q);
  return runPasses(stepChain(tree, {}, {}), extractStrategies(tree, {}), {}, new Map()).steps;
};
const merges = (q: string) => {
  const positions = bulkingPositions(ir(q), true);
  return positions === 'unknown' ? positions : positions.map((p) => `${p.after}:${p.kind}${p.distinct ? '=' : ''}`);
};
const run = async (q: string) => decodeAll(executeQuery(seededStore(), q, {}));

describe('bulkingPositions — LazyBarrierStrategy.java:86-135, PathRetractionStrategy.java:134-141', () => {
  test('a barrier after every flat-map but the first, unless the next step is a Barrier', () => {
    // V() counts as the first flat-map; the first both() is followed by a flat-map, the second by a slice.
    expect(merges('g.V().both().both().limit(4)')).toEqual(['1:lazy']);
    expect(merges('g.V().both().both().id()')).toEqual(['1:lazy', '2:lazy']);
    // V(1) names fewer than five ids, so it is no flat-map and the first out() is the first.
    expect(merges('g.V(1).out().out().id()')).toEqual(['0:start=', '2:lazy']);
  });

  test("properties() of distinct elements is distinct, so its barrier merges nothing", () => {
    expect(merges('g.V().properties().key()')).toEqual(['1:lazy=']);
  });

  test('a start step merges repeated literals; explicit and collecting barriers merge where they stand', () => {
    expect(merges('g.inject(1, 2, 1, 3).barrier().order().fold()')).toEqual(['0:start', '1:barrier=', '2:collecting=']);
    expect(merges('g.inject([1, 2, 1, 3]).unfold().math("_ % 2").is(P.gte(0)).limit(2)')).toEqual(['0:start=', '2:retraction']);
  });

  test('RepeatUnrollStrategy puts a barrier after every unrolled body', () => {
    // RepeatUnrollStrategy.java:100-113 — the last body takes none before a Barrier.
    expect(merges('g.V().repeat(__.both()).times(3).range(5, 11)')).toEqual(['1:lazy', '2:lazy']);
  });

  test('a spliced flatMap() still stands where a counted flat-map stands', () => {
    expect(merges('g.inject([1, 2, 1, 3]).unfold().flatMap(__.identity()).is(P.gt(0)).fold()')).toEqual(['0:start=', '2:lazy']);
  });

  test('it refuses to say where the merges depend on what it cannot model', () => {
    for (const q of [
      'g.V().as("a").out().out().select("a")', // a labelled path suppresses barriers and enters equals()
      'g.withoutStrategies(LazyBarrierStrategy).V().out().out().id()',
      'g.V().out().out().path()', // a PATH requirement switches the strategy off
    ]) expect(merges(q)).toBe('unknown');
  });

  test('the superset scan still answers "merged nothing before here" where it can', () => {
    expect(referenceUnbulkedAt(ir('g.V().out().fold()'), 2, true)).toBe(true);
    expect(referenceUnbulkedAt(ir('g.V().both().both().fold()'), 3, true)).toBe(false);
    // ElementStep switches LazyBarrierStrategy off for the whole traversal.
    expect(referenceUnbulkedAt(ir('g.E().properties().element()'), 2, true)).toBe(true);
  });
});

describe('the merge, reproduced', () => {
  test('equal traversers share their first arrival’s slot, whatever the key that sorts them', async () => {
    expect(await run('g.inject(1, 2, 1, 3).order().by(__.math("_ * 0")).fold()')).toEqual([[1, 1, 2, 3]]);
    expect(await run('g.inject("a", "b", "a").order().by(__.length()).fold()')).toEqual([['a', 'a', 'b']]);
    expect(await run('g.V().out().order().by(__.V(1).id()).id().fold()')).toEqual([[2, 3, 3, 3, 4, 5]]);
  });

  test('a merged slot stays ONE traverser downstream — a branch emits its arms per slot', async () => {
    // Slot-major: the merged first traverser's whole bulk takes the first arm before the next arm runs.
    expect(await run('g.V().both().both().union(__.constant(2), __.constant(1)).limit(3)')).toEqual([2, 2, 2]);
  });

  test(`one drain holds ${MAX_BARRIER_SIZE} distinct traversers; past it the merge RAISES where the order is read`, async () => {
    // `values()` is the second flat-map after a bare `V()`, so a `NoOpBarrierStep(2500)` follows it. One
    // value repeats, so a merge happens; how many DISTINCT values reach the set decides whether one drain
    // holds them.
    const graph = (distinct: number) => {
      const store = new GraphStore(new BunSqlite(':memory:'));
      const rows = [...Array.from({ length: distinct }, (_, i) => `${i + 1},n,${i}`), `${distinct + 1},n,0`];
      loadCsv(store, ['~id,~label,k:int', ...rows].join('\n'));
      return store;
    };
    const q = (tail: string) => `g.V().values('k').is(P.gte(0)).${tail}`;
    const within = graph(MAX_BARRIER_SIZE);
    const merged = (await decodeAll(executeQuery(within, q('fold()'), {})))[0];
    expect(merged).toHaveLength(MAX_BARRIER_SIZE + 1);
    // The last vertex's `0` joined the first one's slot.
    expect(merged.slice(0, 3)).toEqual([0, 0, 1]);
    const past = graph(MAX_BARRIER_SIZE + 1);
    let thrown: unknown;
    try { await decodeAll(executeQuery(past, q('fold()'), {})); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(RaisedByQuery);
    expect((thrown as Error).message).toBe(MERGE_WINDOW_EXCEEDED);
    // Nothing reads the order a count erases, so no merge is minted and nothing raises.
    expect(await decodeAll(executeQuery(past, q('count()'), {}))).toEqual([MAX_BARRIER_SIZE + 2]);
    // A stream that overflows one drain but holds no two equal traversers merges nothing either way.
    const unique = new GraphStore(new BunSqlite(':memory:'));
    loadCsv(unique, ['~id,~label,k:int', ...Array.from({ length: MAX_BARRIER_SIZE + 1 }, (_, i) => `${i + 1},n,${i}`)].join('\n'));
    expect((await decodeAll(executeQuery(unique, q('fold()'), {})))[0]).toHaveLength(MAX_BARRIER_SIZE + 1);
  });
});
