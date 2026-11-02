// A RE-SOURCING SCALAR CHILD VALUE carries its first row's own type beside its value. `map(__.V()…)`
// re-reads the graph per host traverser (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GraphStep.java)
// and takes the body's FIRST result (step/map/TraversalMapStep.java). The body's per-row type (a stored
// property's `vtype`, a reducer's `vt`) used to be framed as a column of the ROOTED relation, which the
// host cannot see — a bare `RelIR: relation … has no declared column 'vtype'` Error. `firstRootedValue`
// (`rel/build.ts`) now reads value AND type from ONE fenced one-row relation, and `reSourcedValue`
// (`rel/lower/reduction.ts`) frames them through `ChildValue.vtype`.
//
// An UNORDERED body's first value is SQLite's scan-order first, so these assert every host got the SAME
// value, of a member of the body's stream, with that member's type — never a particular member (L8).
import { test, expect, describe } from 'bun:test';
import { seededStore, run, bare } from '../support/harness.ts';

const s = seededStore();
const rows = (g: string): any[] => bare(run(s, g));
const NAMES = ['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas'];

/** Every host row is the same `{v, vtype}`, `n` of them, and `v` is one of `members`. */
const oneRepeated = (g: string, n: number, members: readonly unknown[], vtype: string): void => {
  const got = rows(g);
  expect(got).toHaveLength(n);
  expect(new Set(got.map((r) => JSON.stringify(r))).size).toBe(1);
  expect(members).toContain(got[0].v);
  expect(got[0].vtype).toBe(vtype);
};

describe('an unordered re-sourced first value is one member, typed', () => {
  test('map(V.values(name))', () => oneRepeated("g.V().map(__.V().values('name'))", 6, NAMES, 'string'));
  test('map(V.values(name).limit(1))', () => oneRepeated("g.V().map(__.V().values('name').limit(1))", 6, NAMES, 'string'));
  test('map(V.values(name).dedup())', () => oneRepeated("g.V().map(__.V().values('name').dedup())", 6, NAMES, 'string'));
  test('an absent host drops the row', () =>
    oneRepeated("g.V().optional(__.out().as('a')).map(__.select('a').V().values('name'))", 6, NAMES, 'string'));
  test('a mixed-type body keeps the member\'s own type', () => {
    const got = rows("g.V().map(__.V().choose(__.hasLabel('person'), __.values('age'), __.values('name')))");
    expect(got).toHaveLength(6);
    expect(new Set(got.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(got[0].vtype).toBe(typeof got[0].v === 'number' ? 'int' : 'string');
  });
  test('the tag reaches an outer order: a stored int orders numerically', () => {
    const got = rows("g.V().map(__.V().values('age')).order().limit(1)");
    expect(got).toHaveLength(1);
    expect([29, 27, 32, 35]).toContain(got[0].v);
    expect(got[0].vtype).toBe('int');
  });
});

describe('an order-pinned or reduced re-sourced value is exact', () => {
  test('order().limit(1)', () => oneRepeated("g.V().map(__.V().values('name').order().limit(1))", 6, ['josh'], 'string'));
  test('sum over an absent-able host', () =>
    oneRepeated("g.V().optional(__.out().as('a')).map(__.select('a').V().values('age').sum())", 6, [123], 'int'));
  test('max of edge weights over an absent-able host', () =>
    oneRepeated("g.V().optional(__.out().as('a')).map(__.select('a').E().values('weight').max())", 6, [1], 'double'));
  test('mean is a double', () => oneRepeated("g.V().map(__.V().has('age').values('age').mean())", 6, [30.75], 'double'));
  test('under a choose arm', () => {
    const got = rows("g.V().choose(__.hasLabel('person'), __.map(__.V().values('age').order()), __.constant(0))");
    expect(got.map((r) => r.v).sort()).toEqual([0, 0, 27, 27, 27, 27]);
    expect(got.every((r) => r.vtype === 'int')).toBe(true);
  });
  test('an empty body maps to nothing', () => expect(rows("g.V().map(__.V().values('age').is(gt(100)))")).toEqual([]));
});
