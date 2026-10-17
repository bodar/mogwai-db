// A merge over a MULTI-ROW literal `Values` input (`g.inject(1,2,3)`) emits ONE result per incoming
// traverser per element the search found — `MergeEdgeStep`/`MergeVertexStep` are a `flatMap` over each
// incoming traverser (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/
// traversal/step/map/MergeEdgeStep.java, MergeVertexStep.java). Every write host read an input with no
// `ord` column as ONE row, which a source seed is and a three-row inject is not: every pair shared
// position 1, so each found row re-joined all three traversers — N² rows (`writeSnapshot`, write.ts).
import { test, expect, describe } from 'bun:test';
import { seededStore, run } from './support/harness.ts';

const count = (q: string): number => (run(seededStore(), q) as { v: number }[])[0]!.v;
const KNOWS_1_2 = '[(T.label):"knows", (Direction.OUT):1, (Direction.IN):2]';

describe('a merge over a multi-row inject emits one row per traverser, not N²', () => {
  test('mergeE matching an existing edge', () => {
    expect(count(`g.inject(1,2,3).mergeE(${KNOWS_1_2}).count()`)).toBe(3);
    expect(count(`g.inject(1,1).mergeE(${KNOWS_1_2}).count()`)).toBe(2);
  });
  test('mergeE with onMatch and a property() tail', () => {
    expect(count(`g.inject(1,2,3).mergeE(${KNOWS_1_2}).option(Merge.onMatch, [w:1]).count()`)).toBe(3);
    expect(count(`g.inject(1,2,3).mergeE(${KNOWS_1_2}).property("q",1).count()`)).toBe(3);
  });
  test('mergeE creating: the first traverser creates, the rest match that one edge', () => {
    const s = seededStore();
    const ids = (run(s, 'g.inject(1,2,3).mergeE([(T.label):"new", (Direction.OUT):1, (Direction.IN):2]).id()') as { v: number }[]).map((r) => r.v);
    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(1);
    expect((run(s, 'g.E().hasLabel("new").count()') as { v: number }[])[0]!.v).toBe(1);
  });
  test('mergeE([:]) pairs every traverser with every edge exactly once', () => {
    expect(count('g.inject(1,2,3).mergeE([:]).count()')).toBe(18);
  });
  test('computed mergeE / mergeV searches', () => {
    expect(count('g.inject(1,2,3).mergeE(__.project("weight").by(constant(0.5))).option(Merge.onCreate,[(T.label):"k",(Direction.OUT):1,(Direction.IN):2]).count()')).toBe(3);
    const s = seededStore();
    const ids = (run(s, 'g.inject(1,2,3).mergeV(__.project("name").by(constant("zz"))).id()') as { v: number }[]).map((r) => r.v);
    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(1);
  });
  test('mergeV and the creations were already per traverser, and stay so', () => {
    expect(count('g.inject(1,2,3).mergeV([(T.label):"person"]).count()')).toBe(12);
    expect(count('g.inject(1,2,3).mergeV([name:"zz"]).count()')).toBe(3);
    expect(count('g.inject(1,2,3).addV("x").count()')).toBe(3);
    expect(count('g.inject(1,2,3).addE("x").from(V(1)).to(V(2)).count()')).toBe(3);
  });
  test('a single-row source seed is unchanged', () => {
    expect(count(`g.mergeE(${KNOWS_1_2}).count()`)).toBe(1);
    expect(count(`g.inject(1).mergeE(${KNOWS_1_2}).count()`)).toBe(1);
  });
});
