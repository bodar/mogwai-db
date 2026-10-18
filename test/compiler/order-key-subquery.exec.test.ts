// order().by(k) computes a subquery-valued key ONCE — `withSubqueryColumns` (compiler/rel/build.ts)
// projects the key's subqueries as columns the productivity filter and the sort both read.
//
// The hoist closes the input relation into a projection, so every read of that relation, INCLUDING
// the free reads inside a key subquery that stays inline (a raising `math()` key), must follow it.
// A key it cannot re-read through the projection keeps the unhoisted form. Before that, every
// order().by(<math key>) answered a bare `RelIR emitter: column 'id' … is not in scope`.
import { test, expect, describe } from 'bun:test';
import { bagOf, run, seededStore } from '../support/harness.ts';

const store = seededStore();
const names = (q: string): string[] => run(store, q).map((row: any) => row.v);

describe('order().by(<subquery key>) answers', () => {
  test.each([
    ["g.V().hasLabel('person').order().by(values('age').math('_*2')).values('name')", ['vadas', 'marko', 'josh', 'peter']],
    ["g.V().order().by(values('age').math('_*2')).values('name')", ['vadas', 'marko', 'josh', 'peter']],
    ["g.V().order().by(math('_*2').by('age')).values('name')", ['vadas', 'marko', 'josh', 'peter']],
    ["g.V().order().by(values('age').math('_+1'),desc).values('name')", ['peter', 'josh', 'marko', 'vadas']],
    ["g.V().hasLabel('person').order().by(values('age').math('_*2')).by(out().count()).values('name')", ['vadas', 'marko', 'josh', 'peter']],
    ["g.V().order().by(outE().values('weight').max()).values('name')", ['peter', 'marko', 'josh']],
    ["g.V().order().by(out().count()).by('name').values('name')", ['lop', 'ripple', 'vadas', 'peter', 'josh', 'marko']],
  ] as const)('%s', (query, expected) => {
    expect(names(query)).toEqual([...expected]);
  });
});

// The emitter's compute-once FENCE (`fenced`, src/rel/emit.ts) computes every column of its block for
// every row. Under a filter that drops rows, a DEFERRAL in a column the predicate does not test would then
// fire for a row the query never reads. `format()` drops a traverser missing a variable, so a vertex whose
// `name` has no String spelling here, and which has no `age`, must be dropped, not declined.
test('a deferral in a column a filter drops stays off the dropped rows', () => {
  const graph = seededStore();
  run(graph, "g.addV('x').property('name', datetime('2020-01-01T00:00:00Z'))");
  expect(bagOf(run(graph, 'g.V().elementMap().format("%{name} is %{age} years old")').map((row: any) => row.v)))
    .toEqual(bagOf(['marko is 29 years old', 'vadas is 27 years old', 'josh is 32 years old', 'peter is 35 years old']));
});
