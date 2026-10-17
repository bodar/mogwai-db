// THE TRAVERSERSET MERGE — `bulkingPositions` (`src/compiler/ir/bulk.ts`) places every merge the reference
// makes, and `regroupFirstOccurrence` (`src/compiler/rel/build.ts`) reproduces one on the emission order.
// The L4 addendum (`traverser-set-merge.feature`) pins the reference answers; this file pins the
// MECHANISM: where the scan places a merge, where it refuses to say, and the one-drain window past which a
// merge RAISES rather than merging across a boundary the reference does not.
import { test, expect, describe } from 'bun:test';
import { parseGremlin, stepChain, extractStrategies } from '../../src/gremlin/frontend.ts';
import { runPasses } from '../../src/compiler/ir/passes.ts';
import { branchOrderedAfter, branchOrderedAt, bulkingPositions, MAX_BARRIER_SIZE, referenceUnbulkedAt } from '../../src/compiler/ir/bulk.ts';
import { MERGE_WINDOW_EXCEEDED, mergeWindowExceeded } from '../../src/compiler/rel/lower.ts';
import { RaisedByQuery } from '../../src/rel/raise.ts';
import { seededStore } from '../support/harness.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { loadCsv } from '../../src/formats/csv.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll, typedAll } from '../support/decode.ts';

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
    expect(merges('g.V(1).out().out().id()')).toEqual(['2:lazy']);
    // A start GraphStep generates one traverser at a time (GraphStep.java:193-196): no set merges its ids.
    expect(merges('g.V(1, 2, 1).out().id()')).toEqual([]);
  });

  test("properties() of distinct elements is distinct, so its barrier merges nothing", () => {
    expect(merges('g.V().properties().key()')).toEqual(['1:lazy=']);
  });

  test('a start step merges repeated literals; explicit and collecting barriers merge where they stand', () => {
    expect(merges('g.inject(1, 2, 1, 3).barrier().order().fold()')).toEqual(['0:start', '1:barrier=', '2:collecting=']);
    expect(merges('g.inject([1, 2, 1, 3]).unfold().math("_ % 2").is(P.gte(0)).limit(2)')).toEqual(['0:start=', '2:retraction']);
    // A KEYED groupCount('x') is a side-effect barrier that passes the stream ON — not a reduction to one.
    expect(merges('g.V().both().groupCount("x").id().fold()')).toEqual(['2:side-effect']);
  });

  test('a child handed ONE traverser merges nothing a one-to-one map of it makes', () => {
    // `local(select('a').values('name'))`'s body: PathRetractionStrategy's barrier after select('a') holds
    // the one traverser the local() run was handed.
    const body = ir('g.V().select("a").values("name")').slice(1);
    expect(bulkingPositions(body, false)).toEqual([{ after: 0, kind: 'retraction', window: MAX_BARRIER_SIZE, distinct: true }]);
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

  test('an explicit barrier(n) that cannot hold the stream says so in its own terms', async () => {
    let thrown: unknown;
    try { await run('g.V().both().both().barrier(2).id().fold()'); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(RaisedByQuery);
    expect((thrown as Error).message).toBe(mergeWindowExceeded(2, true));
  });
});

// `EarlyLimitStrategy` is a PRIOR of `LazyBarrierStrategy` (LazyBarrierStrategy.java:62-71): it moves a
// `limit`/`range`/`skip` left past every always-bound `MapStep`, and the moved `RangeGlobalStep` is a
// `Barrier` (`FilteringBarrier`, RangeGlobalStepContract.java:38), so no `NoOpBarrierStep` follows the
// flat-map it now stands after. `….id().limit(n)` and `….limit(n).id()` are therefore ONE traversal.
describe('the slice EarlyLimitStrategy moves decides where the merge is', () => {
  const names = (q: string) => ir(q).map((s) => s.name).join('.');

  test('a slice moves past the always-bound maps, and only those', () => {
    expect(names('g.V().both().both().id().limit(9)')).toBe('V.both.both.limit.id');
    expect(names('g.V().both().both().map(__.id()).project("a").by(__.label()).range(1, 3)')).toBe('V.both.both.range.map.project');
    // `values()` is a flat-map, `inV()` an `EdgeVertexStep` (a `FlatMapStep`), `asString()` unlisted: none crossed.
    expect(names('g.V().both().values("name").limit(2)')).toBe('V.both.values.limit');
    expect(names('g.E().inV().limit(1)')).toBe('E.inV.limit');
    expect(names('g.V().both().map(__.values("name")).limit(2)')).toBe('V.both.map.limit');
    // `tail()` is a `TailGlobalStepContract`, never moved.
    expect(names('g.V().both().id().tail(2)')).toBe('V.both.id.tail');
    // A `map()` body's reduction is a `ReducingBarrierStep` (DEFINITELY_SINGULAR); its KEYED form is a
    // `SideEffectStep`, which StepOutputArityPredictor counts MULTI — not crossed.
    expect(names('g.V().both().map(__.groupCount().count()).limit(1)')).toBe('V.both.limit.map');
    for (const keyed of ['groupCount("a")', 'group("a")', 'tree("a")'])
      expect(names(`g.V().both().map(__.${keyed}.count()).limit(1)`)).toBe('V.both.map.limit');
  });

  test('so the scan places no merge before a moved slice', () => {
    expect(merges('g.V().both().both().id().limit(9)')).toEqual(['1:lazy']);
    expect(merges('g.V().both().both().id().tail(9)')).toEqual(['1:lazy', '2:lazy']);
  });

  test('…and the two spellings answer alike, slot for slot', async () => {
    for (const [moved, written] of [
      ['g.V().both().both().id().limit(9)', 'g.V().both().both().limit(9).id()'],
      ['g.V().both().both().id().skip(25)', 'g.V().both().both().skip(25).id()'],
      ['g.V().both().both().id().range(5, 9)', 'g.V().both().both().range(5, 9).id()'],
      ['g.V(1).both().both().id().limit(4)', 'g.V(1).both().both().limit(4).id()'],
      ['g.V(1).both().both().constant(1).limit(4).fold()', 'g.V(1).both().both().limit(4).constant(1).fold()'],
    ]) expect(await run(moved!)).toEqual(await run(written!));
  });
});

// Every child traversal gets the strategies of its own (DefaultTraversal.java:144-148 →
// TraversalHelper.applyTraversalRecursively), so a body merges at its OWN positions — the same ones the
// root would, for a body handed one traverser.
describe('a child traversal merges where its own strategies put the barriers', () => {
  test('a per-traverser body answers as the root does over the same one start', async () => {
    for (const body of [
      "both().both().values('name').limit(4)",
      "both().both().values('name').tail(4)",
      'both().both().id().limit(4)',
      'both().both().id().skip(2).limit(3)',
    ]) {
      const root = await run(`g.V(1).${body}`);
      expect(await run(`g.V(1).local(__.${body})`)).toEqual(root);
      expect(await run(`g.V(1).flatMap(__.${body})`)).toEqual(root);
    }
    // marko is reached three times; the merged slot carries all three before josh.
    expect(await run("g.V(1).local(__.both().both().values('name').limit(4))")).toEqual(['marko', 'marko', 'marko', 'josh']);
  });

  test('a slice over a body with no emission order to merge on declines', async () => {
    for (const q of [
      "g.V(1).map(__.both().both().values('name').limit(4).fold())",
      "g.V(1).project('a').by(__.both().both().values('name').limit(4).fold())",
    ]) await expect(run(q)).rejects.toThrow(/not supported yet/);
  });

  test('a body handed ONE traverser merges nothing a map of it makes', async () => {
    // The retraction barrier after `select('a')` holds a single traverser per `local()` run.
    const rows = await run("g.V().as('a').out('knows').local(__.union(__.select('a').values('name'), __.values('name')).fold())");
    expect(rows).toHaveLength(2);
  });
});

// A branch's emission order is not the reference's yet (`BranchStep.java:123-158` walks its arms in order;
// RelIR plan §10 cluster B), so a merge or an order() tie that would READ it — on either side of the branch,
// at any depth — refuses rather than answer from the wrong order (`branchOrderedAt`/`branchOrderedAfter`,
// `mergeEqual`). Each witness below declined on trunk; the comment is the reference answer.
describe('a merge never reads a branch emission order', () => {
  test('branchOrderedAt — behind a branch, at this level or in a child that streams it, until an order-free reduction', () => {
    expect(branchOrderedAt(ir('g.V(1).union(__.constant(9), __.constant(5)).barrier().fold()'), 2)).toBe(true);
    expect(branchOrderedAt(ir('g.V(1).out().flatMap(__.union(__.out(), __.identity())).order().fold()'), 3)).toBe(true);
    expect(branchOrderedAt(ir('g.V(1).union(__.constant(9), __.constant(5)).count().barrier()'), 3)).toBe(false);
    expect(branchOrderedAt(ir('g.inject(1, 2, 1, 3).barrier().fold()'), 1)).toBe(false);
    // A list handed a branch's stream (an arm) inherits it.
    expect(branchOrderedAt(ir('g.inject(1).barrier()'), 1, true)).toBe(true);
  });

  test('branchOrderedAfter — an order that reaches its reader only through a branch', () => {
    expect(branchOrderedAfter(ir('g.inject(3, 2, 3, 1).barrier().union(__.identity()).fold()'), 2)).toBe(true);
    // An order-free reduction after the branch reads no order; a slice BEFORE it read the right one.
    expect(branchOrderedAfter(ir('g.inject(3, 2, 3, 1).barrier().union(__.identity()).count()'), 2)).toBe(false);
    expect(branchOrderedAfter(ir('g.inject(3, 2, 3, 1).barrier().limit(2).union(__.identity()).sum()'), 2)).toBe(false);
    expect(branchOrderedAfter(ir('g.inject(3, 2, 3, 1).barrier().fold()'), 2)).toBe(false);
    expect(branchOrderedAfter(ir('g.inject(3, 2, 3, 1).barrier()'), 2, true)).toBe(true);
  });

  test('every witness refuses', async () => {
    for (const q of [
      'g.V(1).union(__.constant(9), __.constant(5), __.constant(9)).barrier().fold()', // [9,9,5]
      'g.V(1).union(__.constant(9), __.constant(5), __.constant(9)).order().by(__.constant(0)).fold()', // [9,9,5]
      'g.V(1).local(__.union(__.constant(9), __.constant(5), __.constant(9)).barrier().fold())', // [9,9,5]
      'g.inject(1).union(__.constant(9), __.constant(5), __.constant(9)).barrier().fold()', // [9,9,5]
      'g.V(1).union(__.constant(9), __.constant(5)).order().by(__.constant(0)).fold()', // [9,5]
      'g.V(1).out().union(__.out(), __.identity()).order().by(__.constant(0)).id().fold()',
      'g.V(1).out().union(__.out(), __.identity()).barrier().id().fold()',
      'g.V(1).out().union(__.out(), __.identity()).id().barrier().fold()',
      'g.V(1).out().flatMap(__.union(__.out(), __.identity())).order().by(__.constant(0)).id().fold()',
      'g.V(1).union(__.out().out(), __.out()).order().by(__.constant(0)).id().fold()',
      'g.V(1).union(__.out().out(), __.out()).order().by(__.constant(0)).limit(1).id()',
      'g.V(1).union(__.out().out(), __.out()).order().by(__.constant(0)).limit(4).id()',
      // the order leaves through a branch: its ties never reach the reader as sorted
      'g.inject(3, 2, 3, 1).order().by(__.constant(0)).union(__.identity()).fold()', // [3,3,2,1]
      'g.inject(9, 5, 9).union(__.identity().barrier()).fold()', // [9,9,5]
      // an implicit merge behind a branch that would move a row
      'g.V().union(__.out(), __.in()).out().out().id().fold()',
    ]) await expect(run(q), q).rejects.toThrow();
  });

  test('…and answer where the arrival order is never read', async () => {
    // No two different traversers tie on `name`: the sort alone decides, whatever the arrival.
    expect(await run("g.V().union(__.out(), __.in()).order().by('name').values('name').fold()")).toEqual([
      ['josh', 'josh', 'josh', 'lop', 'lop', 'lop', 'marko', 'marko', 'marko', 'peter', 'ripple', 'vadas'],
    ]);
    // An order-free reduction reads no order.
    expect(await run('g.V(1).union(__.constant(9), __.constant(5), __.constant(9)).barrier().sum()')).toEqual([23]);
    expect(await run('g.V().union(__.out(), __.in()).out().out().id().count()')).toEqual([6]);
    // A slice before the branch read the merged order; the sum after it reads none.
    expect(await run('g.inject(1, 2, 1, 3).order().by(__.constant(0)).limit(2).union(__.identity(), __.identity()).sum()')).toEqual([4]);
  });
});

describe('traverser equality is the reference’s TYPED equals — AbstractTraverser.java:185-188', () => {
  // Integer(1) is not Double(1.0), and Double.equals(-0.0, 0.0) is false: SQLite's PARTITION BY says both
  // are equal, so every merge key term is widened by `typedEquality` (src/compiler/rel/build.ts). Read
  // TYPED (`typedAll`): the client decodes an Int and a Double to one JS number, and `-0` to `0` when nested.
  const typed = (q: string) => typedAll(executeQuery(seededStore(), q, {}));

  test('an Integer and a Double never share a slot, at any merge', () => {
    for (const q of [
      'g.inject(1, 2, 1.0).fold()',
      'g.inject(1, 2, 1.0).barrier().fold()',
      'g.inject(1, 2, 1.0).order().by(__.constant(0)).fold()',
      'g.inject(1, 2, 1.0).local(__.identity()).barrier().fold()',
      'g.inject(1, 2, 1.0).map(__.identity()).barrier().fold()',
      'g.inject(1, 2, 1.0).aggregate("a").fold()',
    ]) expect(typed(q), q).toEqual(['[1i,2i,1d]']);
    expect(typed('g.inject(1, 2, 1.0).limit(2)')).toEqual(['1i', '2i']);
    expect(typed('g.inject(1.0, 2, 1).limit(2)')).toEqual(['1d', '2i']);
    // equal TYPES still merge: two Doubles, two Integers
    expect(typed('g.inject(1.0d, 2, 1.0).limit(2)')).toEqual(['1d', '1d']);
    expect(typed('g.inject(1, 2, 1).limit(2)')).toEqual(['1i', '1i']);
  });

  test('a whole Double frames as a Double — scalar, folded, and as a list member', () => {
    // GenericLiteralVisitor.java:490-511: an unsuffixed `1.0` is a Double. SQLite hands a whole REAL back as
    // a JS integer, so the inject carries the class (`injectValueTypes`) and a list reads `1.0` by its
    // spelling (`parseExactJson`).
    expect(typed('g.inject(1.0)')).toEqual(['1d']);
    expect(typed('g.inject(1.0d)')).toEqual(['1d']);
    expect(typed('g.inject(2.0, 1).fold()')).toEqual(['[2d,1i]']);
    expect(typed('g.inject([1.0, 2.5, 2])')).toEqual(['[1d,2.5d,2i]']);
    expect(typed('g.inject(1).constant([1.0])')).toEqual(['[1d]']);
  });

  test('a signed zero keeps its own slot, and its sign, at every depth', () => {
    expect(typed('g.inject(-0.0, 2, 0.0).limit(2)')).toEqual(['-0d', '2i']);
    expect(typed('g.inject(-0.0, 0.0, -0.0).barrier()')).toEqual(['-0d', '-0d', '0d']);
    expect(typed('g.inject(-0.0, 2, 0.0).fold()')).toEqual(['[-0d,2i,0d]']);
    // in a LIST: List.equals compares members with Double.equals
    expect(typed('g.inject([-0.0], [2], [0.0]).limit(2)')).toEqual(['[-0d]', '[2i]']);
    expect(typed('g.inject([0.0], [2], [-0.0]).barrier().fold()')).toEqual(['[[0d],[2i],[-0d]]']);
    // in a MAP: Map.equals compares values with equals — `stringifyExact` spells the literal's `-0.0`
    expect(typed('g.inject([a:-0.0], [a:2], [a:0.0]).limit(2)')).toEqual(['{"a":-0d}', '{"a":2i}']);
    expect(typed('g.inject([a:0.0], [a:2], [a:-0.0]).limit(2)')).toEqual(['{"a":0d}', '{"a":2i}']);
    expect(typed('g.inject([a:-0.0], [a:2], [a:0.0]).barrier().fold()')).toEqual(['[{"a":-0d},{"a":2i},{"a":0d}]']);
    expect(typed('g.inject(1).constant([a:-0.0])')).toEqual(['{"a":-0d}']);
    expect(typed('g.inject([a:[-0.0]])')).toEqual(['{"a":[-0d]}']);
  });

  test('a map equals another holding the same entries in any order — AbstractMap.equals', () => {
    expect(typed('g.inject([a:1, b:2], [c:3], [b:2, a:1]).fold()')).toEqual(['[{"a":1i,"b":2i},{"b":2i,"a":1i},{"c":3i}]']);
    expect(typed('g.inject([a:1, b:2], [c:3], [b:2, a:1]).limit(2)')).toEqual(['{"a":1i,"b":2i}', '{"b":2i,"a":1i}']);
    expect(typed('g.inject([a:1], [a:1.0], [a:1]).fold()')).toEqual(['[{"a":1i},{"a":1i},{"a":1d}]']);
    // A NESTED map compares in its own order (`mapIdentity` reorders one level), so it raises, never merges short.
    expect(() => typed('g.inject([a:[b:1, c:2]], [d:1], [a:[c:2, b:1]]).fold()')).toThrow(/nested map is not supported/);
  });

  test('two different traversers tying on an order() key behind a branch still raise', async () => {
    await expect(run('g.inject(1.0, 1).union(__.identity()).order().by(__.constant(0)).fold()')).rejects.toThrow();
  });

  test('a list member the bare encoding cannot type declines rather than merge as another', async () => {
    // List.equals compares members with equals: [1] and [1L] differ.
    for (const q of ['g.inject([1], [2], [1L]).limit(2)', 'g.inject([1.0f], [2]).limit(2)', 'g.V().constant([1L]).limit(1)']) {
      await expect(run(q), q).rejects.toThrow(/not supported/);
    }
    expect(typed('g.inject([1.0], [2], [1]).limit(2)')).toEqual(['[1d]', '[2i]']);
    expect(typed('g.inject([1], [2], [1]).limit(2)')).toEqual(['[1i]', '[1i]']);
  });

  test('a collection property keeps a negative zero member — the stored tree is spelled by `stringifyExact`', () => {
    expect(typed("g.addV('q').property('x', [-0.0, 1.0]).values('x')")).toEqual(['[-0d,1d]']);
    expect(typed("g.addV('q').property('x', [a:-0.0]).values('x')")).toEqual(['{"a":-0d}']);
  });
});

describe('a sack with no merge operator merges nothing — B_O_S_SE_SL_Traverser.java:131-156', () => {
  test('so the traversal answers unmerged rather than declining', async () => {
    expect(await run('g.withSack(1).V().both().both().sack().fold()')).toEqual([Array(30).fill(1)]);
    expect(await run('g.withSack(1).V().both().both().sack(sum).by(__.constant(1)).sack().fold()')).toEqual([Array(30).fill(2)]);
    expect(await run('g.withSack(1).V().both().both().limit(4).sack()')).toEqual([1, 1, 1, 1]);
    // unmerged: the arrival order, not the merged slots' [1,1,1,1]
    expect(await run('g.withSack(1).V().both().both().limit(4).id()')).toEqual([1, 1, 4, 6]);
  });

  test('a sack WITH a merge operator combines sacks on merge, which declines', async () => {
    await expect(run('g.withSack(1, sum).V().both().both().limit(4).sack()')).rejects.toThrow(/not supported/);
  });
});
