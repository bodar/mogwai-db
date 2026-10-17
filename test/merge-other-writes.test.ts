// A merge over several traversers in a program with ANOTHER write its search could observe refuses
// (guardMergeInterleaving rule (0), mergeObservesOtherWrites — src/compiler/rel/write.ts).
//
// The reference runs the lazy pipeline one traverser at a time (MergeVertexStep/MergeEdgeStep flatMap;
// vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/LazyBarrierStrategy.java
// inserts no barrier after the first flat-map), so a LATER addV/addE creates something the next traverser's
// search finds. These forms carry no feature scenario because the reference's exact count depends on whether
// a search iterator sees elements created while it is being drained (at least 1+2+4 = 7); what is pinned is
// the refusal, and the graph left unwritten by the merge. The deterministic forms (a drop, an EARLIER
// write) live with their reference answers in test/L4-addendum/merge-one-traverser-at-a-time.feature.
import { test, expect, describe } from 'bun:test';
import { seededStore, run, bare } from './support/harness.ts';

const refuses = (q: string): void => {
  const store = seededStore();
  expect(() => run(store, q)).toThrow(/over several traversers/);
  expect(bare(run(store, 'g.V().has("name","zz").count()'))).toEqual([{ v: 0 }]);
  expect(bare(run(store, 'g.E().hasLabel("zz").count()'))).toEqual([{ v: 0 }]);
};

describe('merge over several traversers + another write the search observes', () => {
  test('a later addV whose vertex the vertex search matches', () =>
    refuses('g.inject(1,2,3).mergeV([name:"zz"]).addV("p").property("name","zz").count()'));
  test('a later addE whose edge the edge search matches', () =>
    refuses('g.inject(1,2,3).mergeE([(T.label):"zz",(Direction.OUT):1,(Direction.IN):2]).addE("zz").from(__.V(1)).to(__.V(2)).count()'));
  test('a later mergeV that creates what the first search matches', () =>
    refuses('g.inject(1,2,3).mergeV([name:"zz"]).mergeV([name:"zz",age:1]).count()'));
  test('a later property() write of a searched key, outside the fused tail', () =>
    refuses('g.inject(1,2,3).mergeV([name:"zz"]).as("a").property(single,"name","yy").count()'));
  test('one traverser still answers', () => {
    const store = seededStore();
    expect(bare(run(store, 'g.V(1).mergeV([name:"zz"]).addV("p").property("name","zz").count()'))).toEqual([{ v: 1 }]);
  });
});
