// EVERY ROW IS ONE TRAVERSER. No lowering regroups equal traversers into a bulked slot the way Java's
// `TraverserSet` does at the barriers `LazyBarrierStrategy`/`PathRetractionStrategy` place — that is an
// execution detail of the reference, not an answer (`docs/feature-support-matrix.md`, deliberate
// divergences). The multiset of rows is the reference's; an explicit `barrier()` is a pass-through, and an
// unordered `limit()` takes n of the stream in the plan's order. What this
// file still pins is TYPED identity where it decides an answer (a value's class rides every container).
import { test, expect, describe } from 'bun:test';
import { seededStore } from '../support/harness.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll, typedAll } from '../support/decode.ts';

const run = async (q: string) => decodeAll(executeQuery(seededStore(), q, {}));
const typed = (q: string) => typedAll(executeQuery(seededStore(), q, {}));
/** Is `got` exactly `n` rows, each drawn from `pool` without reuse? */
const isSubBag = (got: readonly unknown[], pool: readonly unknown[], n: number): boolean => {
  const left = pool.map((x) => JSON.stringify(x));
  return got.length === n && got.every((x) => {
    const i = left.indexOf(JSON.stringify(x));
    return i >= 0 && left.splice(i, 1).length === 1;
  });
};

describe('no TraverserSet merge — each row is one traverser, in arrival order', () => {
  test('an explicit barrier() and barrier(n) pass the stream through', () => {
    expect(typed('g.inject(1, 2, 1, 3).barrier()')).toEqual(['1i', '2i', '1i', '3i']);
    expect(typed('g.inject(1, 2, 1, 3).barrier(2).fold()')).toEqual(['[1i,2i,1i,3i]']);
  });

  test('an unordered limit() takes n of the stream', async () => {
    // Which n is the plan's scan order (an accepted divergence); the count and membership are the answer.
    expect(isSubBag(await run('g.V().both().both().limit(4).id()'), await run('g.V().both().both().id()'), 4)).toBe(true);
    expect(typed('g.inject(1, 2, 1).limit(2)')).toEqual(['1i', '2i']);
    // ties under a constant key are unordered: the slice takes any two of the tied rows
    expect(['2i', '3i', '4i', '5i']).toContain(typed('g.inject(1, 2, 1, 3).order().by(__.constant(0)).limit(2).sum()')[0]);
  });

  test('a seeded fold folds every traverser', async () => {
    expect(await run("g.V().both().values('age').fold(0, Operator.sum)")).toEqual([245]);
  });

  test('a write runs once per traverser', async () => {
    expect(await run("g.V().out().addV('x').count()")).toEqual([6]);
    expect(await run("g.V().both().addV('x').count()")).toEqual([12]);
  });

  test('a per-start body keeps its own sorted run per start (start-major)', async () => {
    expect(await run("g.V().flatMap(__.out().values('name').order()).fold()")).toEqual([['josh', 'lop', 'vadas', 'lop', 'ripple', 'lop']]);
    expect(await run("g.V().local(__.out().values('name').order()).fold()")).toEqual([['josh', 'lop', 'vadas', 'lop', 'ripple', 'lop']]);
  });

  test('withoutStrategies(IdentityRemovalStrategy) keeps identity() as a no-op', async () => {
    expect(await run('g.withoutStrategies(IdentityRemovalStrategy).V().identity().out().count()')).toEqual([6]);
  });
});

describe('typed identity — a value keeps its class through every container', () => {
  test('an Integer and a Double stay apart', () => {
    for (const q of [
      'g.inject(1, 2, 1.0).fold()',
      'g.inject(1, 2, 1.0).barrier().fold()',
      'g.inject(1, 2, 1.0).order().by(__.constant(0)).fold()',
      'g.inject(1, 2, 1.0).local(__.identity()).barrier().fold()',
      'g.inject(1, 2, 1.0).aggregate("a").fold()',
    ]) expect(typed(q), q).toEqual(['[1i,2i,1d]']);
    expect(typed('g.inject(1.0, 2, 1).limit(2)')).toEqual(['1d', '2i']);
  });

  test('a whole Double frames as a Double — scalar, folded, and as a list member', () => {
    expect(typed('g.inject(1.0)')).toEqual(['1d']);
    expect(typed('g.inject(1.0d)')).toEqual(['1d']);
    expect(typed('g.inject(2.0, 1).fold()')).toEqual(['[2d,1i]']);
    expect(typed('g.inject([1.0, 2.5, 2])')).toEqual(['[1d,2.5d,2i]']);
    expect(typed('g.inject(1).constant([1.0])')).toEqual(['[1d]']);
  });

  test('a list member whose class its storage cannot say rides typed', () => {
    expect(typed('g.inject([1.0f], [2]).limit(2)')).toEqual(['[1f]', '[2i]']);
    expect(typed('g.V().constant([1L]).limit(1)')).toEqual(['[1L]']);
    expect(typed('g.inject([1], [1L], [1]).dedup()')).toEqual(['[1i]', '[1L]']);
  });

  test('a typed inject payload crosses a branch and the slice after it — the merged arm frames by MERGED_VTYPE', () => {
    // The per-row `vt` an inject carries is re-projected to `vtype` by the branch merge (`withMergedVtype`);
    // framing the union by `vt` raised `RelIR: relation … has no declared column 'vt'` at every depth below.
    const cases: [string, string[]][] = [
      ['g.inject(1, 2, 1.0).union(__.identity(), __.identity()).limit(3)', ['1i', '1i', '2i']],
      ['g.inject(1.0, 2).union(__.identity(), __.identity()).limit(3)', ['1d', '1d', '2i']],
      ['g.inject(1, 2, 1.0).choose(__.is(1), __.identity(), __.identity()).limit(2)', ['1i', '2i']],
      ['g.inject(1, 2, 1.0).optional(__.identity()).limit(2)', ['1i', '2i']],
      ['g.inject(1.0, 2).optional(__.identity()).limit(3)', ['1d', '2i']],
      ['g.inject(1.0, 2).union(__.identity(), __.identity()).dedup().limit(3)', ['1d', '2i']],
      ['g.inject(1.0, 2).union(__.identity(), __.identity()).is(P.gt(0)).limit(3)', ['1d', '1d', '2i']],
      ['g.inject(1, 2, 1.0).union(__.identity(), __.identity()).tail(2)', ['1d', '1d']],
      ['g.inject(1, 2, 1.0).union(__.identity(), __.identity()).range(1, 3)', ['1i', '2i']],
      ['g.inject(1, 1L).union(__.identity(), __.identity()).limit(3)', ['1i', '1i', '1L']],
      ['g.inject(1, 1L).union(__.identity(), __.identity())', ['1i', '1L', '1i', '1L']],
      ['g.inject(1, 1L).union(__.identity(), __.identity()).fold()', ['[1i,1i,1L,1L]']],
      ['g.inject(1, 1L).optional(__.identity())', ['1i', '1L']],
      ['g.inject(1, 1L).coalesce(__.identity(), __.identity())', ['1i', '1L']],
    ];
    for (const [q, expected] of cases) {
      // An unordered limit/range is "some n" of the merged stream — pinned by count and membership.
      const sliceAt = q.search(/\.(?:limit|range)\([^)]*\)$/);
      if (sliceAt < 0) expect(typed(q), q).toEqual(expected);
      else expect(isSubBag(typed(q), typed(q.slice(0, sliceAt)), expected.length), q).toBe(true);
    }
  });

  test('a NULL per-row tag reads the value at every predicate subject — perRowSubject', () => {
    // `inject(1.0, 2)` declares only the Double; the 2's NULL tag is "read the value", an Integer.
    const cases: [string, string[]][] = [
      ['g.inject(1.0, 2).union(__.identity(), __.identity()).is(P.gt(0))', ['1d', '2i', '1d', '2i']],
      ['g.inject(1.0, 2).union(__.identity(), __.constant(3)).is(P.gt(0))', ['1d', '2i', '3i', '3i']],
      ['g.inject(1.0, 2).union(__.identity(), __.identity()).where(__.is(P.gt(1)))', ['2i', '2i']],
      ['g.inject(1.0, 2).union(__.identity(), __.identity()).choose(__.is(P.gt(0)), __.constant("y"), __.constant("n"))', ['"y"', '"y"', '"y"', '"y"']],
      ['g.inject(1.5, 2).union(__.identity(), __.constant(3L)).choose(__.is(P.gt(0)), __.constant("y"), __.constant("n"))', ['"y"', '"y"', '"y"', '"y"']],
      // the inference is the framer's: an INTEGER inside int32 is an Int, beyond it a Long
      ['g.inject(1, 1L).is(P.typeOf(GType.INT))', ['1i']],
      ['g.inject(1.0, 2).union(__.identity(), __.identity()).is(P.typeOf(GType.INT))', ['2i', '2i']],
      ['g.inject(1, 3000000000).union(__.identity(), __.constant(2.5)).is(P.typeOf(GType.LONG))', ['3000000000L']],
    ];
    for (const [q, expected] of cases) expect(typed(q), q).toEqual(expected);
  });
});
