// R7a — a `local()` whose body holds no stream barrier is spliced into its host chain
// (`spliceableLocalBody`, src/compiler/ir/strategies.ts). `LocalStep` emits its child's OWN traversers
// (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/LocalStep.java:60-75),
// so labels, path and sack made inside the body survive it, and only a stream barrier sees the per-start reset.
// These pin the OBSERVABLE equivalence (the spliced form answers the inline chain's multiset, path and labels
// included) and the negatives that must keep the per-start answer.
import { describe, expect, test } from 'bun:test';
import { bagOf, bare, run, seededStore } from '../support/harness.ts';

const store = seededStore();
const answer = (q: string) => bagOf(run(store, q).map(bare).map((r) => JSON.stringify(r)));

describe('local() over a barrier-free body answers its inline chain', () => {
  const pairs: [string, string][] = [
    ['g.V().local(__.bothE()).otherV()', 'g.V().bothE().otherV()'],
    ['g.V().local(__.bothE()).otherV().path()', 'g.V().bothE().otherV().path()'],
    ["g.V().local(__.out().as('a')).select('a').values('name')", "g.V().out().as('a').select('a').values('name')"],
    ["g.V().as('s').local(__.out().as('a')).select('s','a').by('name')", "g.V().as('s').out().as('a').select('s','a').by('name')"],
    ['g.V().local(__.union(__.outE(),__.inE())).otherV().count()', 'g.V().union(__.outE(),__.inE()).otherV().count()'],
    ["g.V().local(__.bothE().where(__.otherV().has('age',gt(30)))).otherV().values('name')", "g.V().bothE().where(__.otherV().has('age',gt(30))).otherV().values('name')"],
    ["g.V().map(__.local(__.outE()).otherV().values('name').order().fold())", "g.V().map(__.outE().otherV().values('name').order().fold())"],
    ["g.withSack(1).V().local(__.out().sack(sum).by('age')).sack()", "g.withSack(1).V().out().sack(sum).by('age').sack()"],
    ["g.V().where(__.local(__.out().has('age',gt(30)))).values('name')", "g.V().where(__.out().has('age',gt(30))).values('name')"],
    ["g.V().repeat(__.local(__.out())).times(2).values('name')", "g.V().repeat(__.out()).times(2).values('name')"],
    ['g.V().local(__.both().simplePath()).count()', 'g.V().both().simplePath().count()'],
  ];
  for (const [local, inline] of pairs) test(local, () => expect(answer(local)).toEqual(answer(inline)));

  test('the counts the plan measured', () => {
    expect(answer('g.V().local(__.bothE()).otherV().count()')).toEqual(answer('g.inject(12L)'));
    expect(answer("g.V().local(__.bothE().where(__.otherV().has('age',gt(30)))).otherV().count()")).toEqual(answer('g.inject(4L)'));
  });
});

describe('the per-start answer is kept where the body holds a barrier', () => {
  test('local(bothE().limit(1)) keeps ONE edge per start', () => {
    // Every modern vertex has an edge, so one per start is six — inline it would be one.
    expect(answer('g.V().local(__.bothE().limit(1)).otherV().count()')).toEqual(answer('g.inject(6L)'));
  });
  test('local(out().count()) is one count per start', () => {
    expect(answer('g.V().local(__.out().count())')).toEqual(bagOf(['3', '0', '0', '2', '0', '1'].map((n) => JSON.stringify(bare(run(store, `g.inject(${n}L)`)[0])))));
  });
});

describe('arm productivity is the BODY’s, not identity’s', () => {
  // `out()` is inline-equivalent but may produce nothing, so a splice must never make an arm always-firing
  // (branch.ts `alwaysFires` reads only the identity question).
  test('optional(local(out())) falls back on a vertex with no out-edges', () => {
    expect(answer('g.V().optional(__.local(__.out())).count()')).toEqual(answer('g.inject(9L)'));
  });
  test('coalesce(local(out()), constant(0)) takes the second arm on a vertex with no out-edges', () => {
    const names = run(store, "g.V().coalesce(__.local(__.out()).values('name'), __.constant('none'))").map((r) => bare(r).v);
    expect(bagOf(names)).toEqual(bagOf(['vadas', 'lop', 'josh', 'lop', 'ripple', 'lop', 'none', 'none', 'none']));
  });
});

// R7b — a `local()` inside a BOUNDED `repeat()`. A barrier-free body splices and the unroll admits its steps as
// ordinary per-traverser phases (U4's `unrollableBodyStep`); a body that RE-SOURCES at any depth — an arm's `V()`
// included — stays a `local` the connector owns (`reSourcedBody`), and the unroll admits it as a per-traverser
// reset host. Both keep the answers R7a's splice briefly lost.
describe('local() inside a bounded repeat() answers', () => {
  test('a sack body: sack(sum) accumulates across the unrolled iterations', () => {
    expect(answer("g.withSack(0.0).V().repeat(__.local(__.outE().sack(Operator.sum).by('weight').inV())).times(2).sack()"))
      .toEqual(bagOf([{ v: 1.4, vtype: 'double' }, { v: 2, vtype: 'double' }].map((r) => JSON.stringify(r))));
  });
  test('a label body: a label bound inside the local survives the repeat', () => {
    expect(answer("g.V().repeat(__.local(__.out().as('x'))).times(2).select('x').values('name')"))
      .toEqual(bagOf([{ v: 'lop', vtype: 'string' }, { v: 'ripple', vtype: 'string' }].map((r) => JSON.stringify(r))));
  });
  test('a value body: select() of a label bound before the repeat', () => {
    expect(answer("g.V().as('s').repeat(__.local(__.out().select('s'))).times(2).count()")).toEqual(answer('g.inject(14L)'));
  });
  test('a union arm that re-sources stays the connector’s', () => {
    expect(answer("g.V().repeat(__.local(__.union(__.V().has('name','marko'), __.out()))).times(2).count()")).toEqual(answer('g.inject(32L)'));
    expect(answer("g.V().repeat(__.local(__.local(__.union(__.V().has('name','marko'), __.out())))).times(2).count()")).toEqual(answer('g.inject(32L)'));
  });
  test('a coalesce arm that re-sources stays the connector’s', () => {
    expect(answer("g.V().repeat(__.local(__.coalesce(__.out('knows'), __.V().has('name','peter')))).times(2).count()")).toEqual(answer('g.inject(7L)'));
  });
  test('R7a’s gains stay', () => {
    expect(run(store, "g.withSack(1.0).V().repeat(__.local(__.outE().sack(Operator.mult).by('weight').inV())).emit().sack()")).toHaveLength(8);
    expect(run(store, "g.withSack(1.0).V().repeat(__.local(__.outE().sack(Operator.mult).by('weight').inV())).until(__.outE().count().is(0)).sack()")).toHaveLength(7);
    expect(run(store, "g.V().until(__.has('name','ripple')).repeat(__.local(__.out())).path()")).toHaveLength(3);
  });
});
