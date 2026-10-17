// property(k, <traversal>) — the two wrong-answer classes an audit found behind the landed sequencing
// guard, pinned so neither can come back.
//
// 1. AN UPSTREAM WRITE BEHIND A FILTER. The reference pulls traverser 2 through an upstream mutating step
//    only after traverser 1 has gone all the way through the property() site — whatever filter, limit or
//    select sits between (lazy pull; `LazyBarrierStrategy` adds no barrier for a short id source,
//    vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/LazyBarrierStrategy.java:93-125).
//    So `g.V(1,2).addLabel('z').has('name','marko').property('n', __.V().hasLabel('z').count())` owes n=1:
//    vadas is not labelled yet when marko's body runs. The site's own host is ONE row there, so a guard
//    that counts it passes; the authority is the count of traversers through the UPSTREAM write
//    (`afterWrite`, src/compiler/rel/write.ts). Each case here answered the wrong number before; it must
//    now refuse — and the single-traverser forms, where one statement IS the reference, still answer.
//
// 2. THE STORED TYPE OF A NUMERIC REDUCER. `max()`/`min()` return the winning Number itself and `mean()`
//    is always floating point (`MeanGlobalStep.java:175-177`, `div(sum, count, true)`; Max.feature and
//    Mean.feature pin `d[1.0].d`). Stored untyped, an integral Double the store keeps as INTEGER read back
//    as an Int.
import { describe, expect, test } from 'bun:test';
import { bare, run, seededStore } from './support/harness.ts';
import { executeQuery } from './support/executor.ts';

const SEQUENTIAL = /may read what another traverser writes/;

describe('property(k, <traversal>) refuses when an upstream write ran over more traversers than the site sees', () => {
  // [traversal, the reference's answer it used to get wrong]
  const refused: readonly string[] = [
    // label mutations behind a filter (reference n=1, 7, 3, 1; we answered 2, 8, 2, 2)
    `g.V(1,2).addLabel('z').has('name','marko').property('n', __.V().hasLabel('z').count())`,
    `g.V(1,2).addLabel('z').has('name','marko').property('n', __.V().labels().count())`,
    `g.V(1,2).dropLabel('person').has('name','marko').property('n', __.V().hasLabel('person').count())`,
    `g.V(1,2).addLabel('z').where(__.values('name').is('marko')).property('n', __.V(2).labels().count())`,
    // a key written upstream — every write form of the site (reference n=1; we answered 2)
    `g.V(1,2).property('a',1).has('name','marko').property('n', __.V().values('a').count())`,
    `g.V(1,2).property('a',1).has('name','marko').property(__.constant('n'), __.V().values('a').count())`,
    `g.V(1,2).property('a',1).has('name','marko').property(__.project('n').by(__.V().values('a').count()))`,
    `g.V(1,2).property('a',1).limit(1).property('n', __.V().values('a').count())`,
    // creations upstream (reference n=1; we answered 2)
    `g.V(1,2).addV('x').limit(1).property('n', __.V().hasLabel('x').count())`,
    `g.V(1,2).as('s').addV('x').select('s').has('name','marko').property('n', __.V().hasLabel('x').count())`,
    `g.inject(1,2).addV('x').limit(1).property('n', __.V().hasLabel('x').count())`,
    `g.V(1,2).addE('q').to(__.V(3)).limit(1).property('n', __.V(3).inE('q').count())`,
    // the write upstream in a branch arm, and the site in one / under another write / at depth in the body
    `g.V(1,2).union(__.addLabel('z')).has('name','marko').property('n', __.V().hasLabel('z').count())`,
    `g.V(1,2).addLabel('z').has('name','marko').union(__.property('n', __.V().hasLabel('z').count()))`,
    `g.V(1,2).addLabel('z').has('name','marko').addV('q').property('n', __.V().hasLabel('z').count())`,
    `g.V(1,2).addLabel('z').has('name','marko').mergeV([name:'zz']).property('n', __.V().hasLabel('z').count())`,
    `g.V(1,2).addLabel('z').has('name','marko').property('n', __.local(__.V().hasLabel('z').count()))`,
    `g.V(1,2).addLabel('z').has('name','marko').property('n', __.project('a').by(__.V().hasLabel('z').count()).select('a'))`,
    `g.V(1,2).addLabel('z').has('name','marko').property('n', __.constant(1).where(__.V().hasLabel('z').count().is(1)).constant(7))`,
    `g.V(1,2).as('a').addLabel('z').select('a').has('name','marko').property('n', __.V().hasLabel('z').count())`,
    `g.V(1,2).addLabel('z').range(0,1).property('n', __.V().hasLabel('z').count())`,
    `g.V(1,2).addLabel('z').tail(1).property('n', __.V().hasLabel('z').count())`,
    // writes in a UNION's arms: `BranchStep` drains each arm lazily and only then the next
    // (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java:123-153),
    // so arm 2's writes run after arm 1's traversers passed the site, and an arm's own write over an
    // arm-internal stream interleaves too. The branch's input is ONE traverser in each (reference 1, 1, 0,
    // 7, 0, 1, 1, 1; we answered 2, 2, 1, 8, 1, 2, 2, 2).
    `g.union(__.addV('x'), __.addV('x')).limit(1).property('n', __.V().hasLabel('x').count())`,
    `g.union(__.addV('x'), __.addV('x')).range(0,1).property('n', __.V().hasLabel('x').count())`,
    `g.union(__.addV('x'), __.addV('y')).hasLabel('x').property('n', __.V().hasLabel('y').count())`,
    `g.union(__.addV('x'), __.addV('y')).hasLabel('x').property('n', __.V().count())`,
    `g.union(__.addV('x'), __.V(1).property('a',1)).hasLabel('x').property('n', __.V().values('a').count())`,
    `g.union(__.addV('x').property('a',1), __.addV('x')).limit(1).property('n', __.V().hasLabel('x').count())`,
    `g.union(__.V(1,2).addLabel('z')).has('name','marko').property('n', __.V().hasLabel('z').count())`,
    `g.union(__.inject(1,2).addV('x')).limit(1).property('n', __.V().hasLabel('x').count())`,
    // the count is a statement of its own over the write's input, so a program that DRAWS cannot be
    // counted — the count would draw afresh (`ProgramWrites.draws`)
    `g.V().sample(1).property('a',1).has('name').property('n', __.V().values('a').count())`,
  ];
  for (const traversal of refused) test(traversal, () => {
    expect(() => run(seededStore(), traversal)).toThrow(SEQUENTIAL);
  });

  // ONE traverser through the upstream write is the reference's loop exactly, so these still answer.
  const answered: readonly (readonly [string, string, unknown])[] = [
    [`g.V(1).addLabel('z').has('name','marko').property('n', __.V().hasLabel('z').count())`, `g.V(1).values('n')`, 1],
    [`g.V(1).property('a',1).has('name','marko').property('n', __.V().values('a').count())`, `g.V(1).values('n')`, 1],
    [`g.addV('x').as('a').addV('y').property('n', __.V().hasLabel('x').count())`, `g.V().hasLabel('y').values('n')`, 1],
    // an upstream write the body cannot observe is no reason to refuse
    [`g.V(1,2).property('b',1).has('name','marko').property('n', __.V().values('a').count())`, `g.V(1).values('n')`, 0],
    [`g.V(1,2).addLabel('z').limit(1).property('n', __.values('name'))`, `g.V(1).values('n')`, 'marko'],
    [`g.V(1).union(__.addLabel('z')).property('n', __.values('name'))`, `g.V(1).values('n')`, 'marko'],
  ];
  for (const [traversal, check, expected] of answered) test(traversal, () => {
    const store = seededStore();
    run(store, traversal);
    expect(bare(run(store, check)).map((row: { v: unknown }) => row.v)).toEqual([expected]);
  });
});

describe('property(k, <numeric reducer>) stores the reference type', () => {
  const stored = (traversal: string): { v: unknown; vtype: unknown } => {
    const store = seededStore();
    run(store, traversal);
    const [row] = run(store, `g.V(1).values('n')`);
    return row;
  };
  test('max() over Doubles stays a Double, even integral (Max.feature d[1.0].d)', () => {
    expect(stored(`g.V(1).property('n', __.outE().values('weight').max())`)).toEqual({ v: 1, vtype: 'double' });
    expect(stored(`g.V(1).property('n', __.outE().values('weight').fold().max(local))`)).toEqual({ v: 1, vtype: 'double' });
  });
  test('min() over Doubles stays a Double', () => {
    expect(stored(`g.V(1).property('n', __.outE().values('weight').min())`)).toEqual({ v: 0.4, vtype: 'double' });
  });
  test('max() over Ints stays an Int', () => {
    expect(stored(`g.V(1).property('n', __.values('age').max())`)).toEqual({ v: 29, vtype: 'int' });
  });
  test('mean() is always a Double, even of Ints (MeanGlobalStep forces floating point)', () => {
    expect(stored(`g.V(1).property('n', __.values('age').mean())`)).toEqual({ v: 29, vtype: 'double' });
    expect(stored(`g.V(1).property('n', __.values('age').fold().mean(local))`)).toEqual({ v: 29, vtype: 'double' });
  });
  // A FRACTIONAL sum of Doubles only: a WHOLE-number one (`has('weight',1.0)`) is still an Int on the read
  // side and so here — `typeof(sum)` of an integral Double the store keeps as INTEGER is `integer`. Not
  // this fix's (max/min/mean); recorded in docs/outstanding-work.md (Value carriage).
  test('a fractional sum() of Doubles is a Double', () => {
    expect(stored(`g.V(1).property('n', __.outE().values('weight').sum())`)).toEqual({ v: 1.9, vtype: 'double' });
  });
  test('sum() of Ints stays untyped (framed Int/Long by magnitude)', () => {
    expect(stored(`g.V(1).property('n', __.values('age').sum())`)).toEqual({ v: 29, vtype: null });
    expect(stored(`g.V(1).property('n', __.local(__.values('age').sum()))`)).toEqual({ v: 29, vtype: null });
  });
  // The reducer's type one level deeper in the body: a `local`/`map`/`flatMap` wrapper, a `choose` arm
  // (both forms), a `coalesce` arm. Each stored `vtype: 'real'` — a storage class, not a Gremlin type —
  // and read back an Int 29 (`reductionTail` renamed the reducer's `vt` to a per-row `vtype`; a choose
  // tagged its rows with the arm's raw `vt`).
  for (const body of [
    `__.local(__.values('age').mean())`,
    `__.map(__.values('age').mean())`,
    `__.flatMap(__.values('age').mean())`,
    `__.choose(__.has('age'), __.values('age').mean(), __.constant(0))`,
    `__.choose(__.values('age')).option(29, __.values('age').mean()).option(none, __.constant(0))`,
    `__.coalesce(__.values('age').mean(), __.constant(0))`,
  ]) test(`mean() under ${body} is a Double`, () => {
    expect(stored(`g.V(1).property('n', ${body})`)).toEqual({ v: 29, vtype: 'double' });
  });
  test('max() under a wrapper keeps the winner\'s type', () => {
    expect(stored(`g.V(1).property('n', __.local(__.outE().values('weight').max()))`)).toEqual({ v: 1, vtype: 'double' });
    expect(stored(`g.V(1).property('n', __.choose(__.has('age'), __.outE().values('weight').max(), __.constant(0)))`)).toEqual({ v: 1, vtype: 'double' });
  });
});

// THE READ SIDE answers the same type the write stores — property() stores what the read answers, so
// both were wrong together. Asserted on the GraphBinary TYPE CODE, since a decoded JS number cannot tell
// an Int 29 from a Double 29.0 (L4's typed notation compares numbers, so it cannot pin this either).
describe('a numeric reducer under a wrapper answers its reference type on the wire', () => {
  const INT = 0x01, DOUBLE = 0x07;
  const codes = (traversal: string): number[] => executeQuery(seededStore(), traversal).map((buffer) => buffer[0]!);
  const cases: readonly (readonly [string, readonly number[]])[] = [
    // mean is always floating point (MeanGlobalStep.java:175-177, div(sum, count, true); Mean.feature d[..].d)
    [`g.V(1).values('age').mean()`, [DOUBLE]],
    [`g.V(1).local(__.values('age').mean())`, [DOUBLE]],
    [`g.V(1).map(__.values('age').mean())`, [DOUBLE]],
    [`g.V(1).flatMap(__.values('age').mean())`, [DOUBLE]],
    [`g.V(1).union(__.values('age').mean(), __.constant(1))`, [DOUBLE, INT]],
    // max keeps the winning Number (Max.feature d[1.0].d), under a wrapper too
    [`g.V(1).local(__.outE().values('weight').max())`, [DOUBLE]],
    [`g.V(1).union(__.outE().values('weight').max(), __.constant(1))`, [DOUBLE, INT]],
    // a sum of Ints is an Int, under a wrapper too (its `'integer'` storage class crosses as untyped)
    [`g.V(1).values('age').sum()`, [INT]],
    [`g.V(1).local(__.values('age').sum())`, [INT]],
    [`g.V(1).outE().values('weight').sum()`, [DOUBLE]],
    [`g.V(1).local(__.outE().values('weight').sum())`, [DOUBLE]],
  ];
  for (const [traversal, expected] of cases) test(traversal, () => {
    expect(codes(traversal)).toEqual([...expected]);
  });
});
