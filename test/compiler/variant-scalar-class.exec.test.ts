// A VARIANT'S SCALAR ROWS KEEP EACH ARM'S OWN CLASS — a branch whose arms differ in SHAPE (an element or
// a list beside a scalar) frames its scalar rows per row off the variant's tag column
// (`variantVocabulary`, src/compiler/rel/variant.ts — `MERGED_VTYPE`), never by one arm's tag and never by value inference.
//
// A branch returns each arm's traverser objects unchanged (`BranchStep`,
// vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java),
// so a Long stays a Long however the sibling arm is shaped. The variant payload used to declare ONE
// static tag or `UNKNOWN`: a per-row arm (every scalar arm `mixedBranch` normalizes, a stored property)
// was dropped to inference — every integral value an Integer (`inject(3L).union(fold(), identity())`
// answered `[3L], 3i`; `V().coalesce(values('l'), identity())` answered `3i`) — and the old `dedupeArms` kept
// the FIRST scalar arm's type for all of them.
import { test, expect, describe } from 'bun:test';
import { seededStore } from '../support/harness.ts';
import { executeQuery } from '../support/executor.ts';
import { typedAll } from '../support/decode.ts';

const store = seededStore();
// One vertex holding the four numeric classes at the same value, so a class read wrongly collides.
executeQuery(store, "g.addV('n').property('f',3.0f).property('d',3.0d).property('i',3).property('l',3L)", {});
const typed = (q: string) => typedAll(executeQuery(store, q, {}));

const N = "g.V().hasLabel('n')";
const FOUR = `${N}.values('f','d','i','l')`;

describe('a list arm beside a scalar arm', () => {
  test('each scalar row keeps its class', () => {
    const cases: [string, string[]][] = [
      ["g.inject(3L).union(fold(), identity())", ['[3L]', '3L']],
      ["g.inject(3.0d).union(fold(), identity())", ['[3d]', '3d']],
      ["g.inject(true).union(fold(), identity())", ['[true]', 'true']],
      ["g.inject(9007199254740993L).union(fold(), identity())", ['[9007199254740993L]', '9007199254740993L']],
      ["g.inject(3L, 'x', 1.5d, 2.5f, true).union(fold(), identity())", ['[3L,"x",1.5d,2.5f,true]', '3L', '"x"', '1.5d', '2.5f', 'true']],
      [`${FOUR}.union(fold(), identity())`, ['[3f,3d,3i,3L]', '3f', '3d', '3i', '3L']],
      [`${N}.union(values('f','d','i','l').fold(), values('l'))`, ['[3f,3d,3i,3L]', '3L']],
      // Two scalar arms of different classes beside the list: neither takes the other's tag.
      ["g.inject(3L).union(fold(), identity(), constant(3))", ['[3L]', '3L', '3i']],
      ["g.inject(3L).union(fold(), union(identity(), constant(3)))", ['[3L]', '3L', '3i']],
      ["g.inject(3L, 4L).choose(is(3L), constant(1), fold())", ['1i', '[4L]']],
      ["g.inject(3L, 4L).choose(is(3L), fold(), identity())", ['[3L]', '4L']],
    ];
    for (const [q, want] of cases) expect(typed(q), q).toEqual(want);
  });

  test('dedup and a slice over the variant see the class', () => {
    // `3L` and `3` are one value (value plus family); the first arrival survives.
    expect(typed("g.inject(3L).union(fold(), identity(), constant(3)).dedup()")).toEqual(['[3L]', '3L']);
    expect(typed("g.inject(3L).union(fold(), identity(), constant(3)).limit(2)")).toEqual(['[3L]', '3L']);
    expect(typed(`${N}.union(values('f','d','i','l').fold(), values('l')).range(1,2)`)).toEqual(['3L']);
  });
});

describe('an element arm beside a scalar arm', () => {
  test('union / choose / coalesce / optional keep the scalar class', () => {
    const cases: [string, string][] = [
      [`${N}.union(identity(), values('l'))`, '3L'],
      [`${N}.choose(constant(true), values('l'))`, '3L'],
      [`${N}.choose(values('l').is(3L), values('l'))`, '3L'],
      [`${N}.coalesce(values('l'), identity())`, '3L'],
      [`${N}.optional(values('l'))`, '3L'],
      [`${N}.union(identity(), count())`, '1L'],
      [`${N}.union(identity(), values('l').sum())`, '3L'],
      [`${N}.union(identity(), values('f').max())`, '3f'],
      [`${N}.union(identity(), values('f').mean())`, '3d'],
    ];
    for (const [q, want] of cases) expect(typed(q).filter((x: string) => !x.startsWith('<')), q).toEqual([want]);
    // The four equal 3s of four classes are one value (value plus family), beside the vertex.
    expect(typed(`${N}.union(values('f','d','i','l'), identity()).dedup().count()`)).toEqual(['2L']);
  });
});

describe('a rebound label read beside a list read — the variant reads each entry by its own class', () => {
  test('union(select(all), select(first)) at every arm order and class mix', () => {
    const cases: [string, string[]][] = [
      ["g.inject(3L).as('a').union(constant(3).as('a'), constant(3L).as('a')).union(select(all,'a'), select(first,'a'))", ['[3L,3i]', '[3L,3L]', '3L', '3L']],
      ["g.inject(3L).as('a').union(constant(3).as('a'), constant(3L).as('a')).union(select(first,'a'), select(all,'a'))", ['3L', '3L', '[3L,3i]', '[3L,3L]']],
      ["g.inject(3L).as('a').constant(1).as('a').union(select(all,'a'), select(first,'a'))", ['[3L,1i]', '3L']],
      ["g.inject(3L).as('a').union(constant(1).as('a'), constant(2L).as('a')).union(select(all,'a'), select(first,'a'))", ['[3L,1i]', '[3L,2L]', '3L', '3L']],
      ["g.inject(3.5f).as('a').union(constant(1).as('a'), constant(2L).as('a')).union(select(all,'a'), select(first,'a'))", ['[3.5f,1i]', '[3.5f,2L]', '3.5f', '3.5f']],
      ["g.inject(3.5f).as('a').constant(1).as('a').union(select(all,'a'), select(first,'a'))", ['[3.5f,1i]', '3.5f']],
      ["g.inject(3L).as('a').constant(1).as('a').union(identity(), select(first,'a'), select(all,'a'))", ['1i', '3L', '[3L,1i]']],
      ["g.inject(3L).as('a').constant(1).as('a').union(select(all,'a'), select(last,'a'))", ['[3L,1i]', '1i']],
    ];
    for (const [q, want] of cases) expect(typed(q), q).toEqual(want);
    expect(typed(`${FOUR}.as('a').constant(1).as('a').union(select(all,'a'), select(first,'a'))`).slice(4).sort())
      .toEqual(['3L', '3d', '3f', '3i']);
  });
});
