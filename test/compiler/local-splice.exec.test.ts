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
