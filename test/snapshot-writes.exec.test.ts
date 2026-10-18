// SNAPSHOT WRITES — the deliberate divergence (docs/feature-support-matrix.md §17, "Write visibility"):
// a write step sees a snapshot of its input, and every step after it sees all of its writes — what an
// explicit `barrier()` before the write gives in TinkerPop, and what its docs tell users to add when they
// mutate what they traverse. Each write step is ONE set-based statement over its input; nothing emulates
// the lazy pipeline's per-traverser interleave, and no answer depends on graph size.
import { describe, expect, test } from 'bun:test';
import { run, seededStore } from './support/harness.ts';

type Store = ReturnType<typeof seededStore>;
const values = (store: Store, q: string): unknown[] => run(store, q).map((row: any) => row.v);
const count = (store: Store, q: string): unknown => values(store, q)[0];

describe('a write step sees a snapshot of its input', () => {
  test('a drop removes the whole set its input names', () => {
    const out = seededStore();
    run(out, 'g.V().out().drop()');
    expect(values(out, 'g.V().id().order()')).toEqual([1, 6]);

    // the classic "drop the leaves": lop's removal does not make peter a leaf mid-statement
    const leaves = seededStore();
    run(leaves, 'g.V().not(__.out()).drop()');
    expect(values(leaves, 'g.V().id().order()')).toEqual([1, 4, 6]);

    // four traversers name two to four distinct edges (bothE() meets each edge twice; an unordered
    // limit keeps unspecified ones), and every one of them goes
    const edges = seededStore();
    run(edges, 'g.V().bothE().limit(4).drop()');
    const left = count(edges, 'g.E().count()') as number;
    expect(left).toBeGreaterThanOrEqual(2);
    expect(left).toBeLessThanOrEqual(4);
  });

  test('addE() creates one edge per input traverser', () => {
    const to = seededStore();
    run(to, "g.V(1,4).out().addE('k').to(V(3))");
    expect(count(to, "g.E().hasLabel('k').count()")).toBe(5);

    const from = seededStore();
    run(from, "g.V().as('a').out().addE('k').from('a')");
    expect(count(from, "g.E().hasLabel('k').count()")).toBe(6);

    // past a second flat-map: the same answer whatever the graph's size (no 2,500-traverser window)
    const twice = seededStore();
    run(twice, "g.V(1,4).out().out().addE('k').to(V(3))");
    expect(count(twice, "g.E().hasLabel('k').count()")).toBe(2);
  });

  test('a write runs once per traverser, equal traversers included', () => {
    const store = seededStore();
    run(store, "g.V().out().addV('x')");
    expect(count(store, "g.V().hasLabel('x').count()")).toBe(6);

    const visited = seededStore();
    run(visited, "g.V().out().property('visited',true)");
    expect(count(visited, "g.V().has('visited',true).count()")).toBe(4);
  });
});

describe('steps after a write see all of its writes', () => {
  test('a read after a creation over several traversers', () => {
    expect(values(seededStore(), "g.inject(1,2).addV('x').V().hasLabel('x').count()")).toEqual([4]);
    expect(values(seededStore(), "g.V(1,2).addE('k').to(V(3)).V(3).inE('k').count()")).toEqual([4]);
  });

  test('two writes of one key apply in step order: the later step wins', () => {
    const store = seededStore();
    run(store, "g.inject(1,2).as('a').V(1).property(single,'w',5).filter(select('a').is(1)).property(single,'w',9)");
    expect(values(store, "g.V(1).values('w')")).toEqual([9]);
  });
});
