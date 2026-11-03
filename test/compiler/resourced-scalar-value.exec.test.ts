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
import { seededStore, run, bare, bagOf } from '../support/harness.ts';
import { UnsupportedTraversal, compile } from '../../src/compiler/compiler.ts';

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

// WHETHER the body produced is read off its first value's NULLNESS: a scalar subquery over no rows is NULL,
// and SQLite cannot tell that from a productive-null first value, so a re-sourced body whose first value is
// null reads as producing nothing (docs/feature-support-matrix.md §17 — the reference's TraversalMapStep
// hasNext()/next() distinction, step/map/TraversalMapStep.java, is not worth an EXISTS per read).
describe('a re-sourced first value that is null reads as nothing (§17)', () => {
  const none = (g: string): void => expect(rows(g)).toEqual([]);
  const CHOOSE = "__.V().choose(__.hasLabel('person'), __.values('age'), __.constant(null)).order().limit(1)";
  test('choose(…, constant(null)).order().limit(1)', () => none(`g.V().map(${CHOOSE})`));
  test('coalesce(values(age), constant(null))', () =>
    none("g.V().map(__.V().coalesce(__.values('age'), __.constant(null)).order().limit(1))"));
  test('union(values(age), constant(null))', () =>
    none("g.V().map(__.V().union(__.values('age'), __.constant(null)).order().limit(1))"));
  test('an inject host', () => none(`g.inject(1).map(${CHOOSE})`));
  test('constant(null)', () => none('g.V().map(__.V().constant(null))'));
  test('under an absent-able host', () => none(`g.V().optional(__.out().as('a')).map(__.select('a').${CHOOSE.slice(3)})`));
  test('inside local(map())', () => none(`g.V().local(__.map(${CHOOSE}))`));
  test('counted after the map', () => expect(rows('g.V().map(__.V().constant(null).limit(1)).count()')[0].v).toBe(0));
  test('a where() body over it drops the row', () => none('g.V().where(__.V().constant(null).limit(1))'));
  test('a concat() operand raises as an empty one does', () =>
    expect(() => run(s, "g.V().values('name').concat(__.V().constant(null))")).toThrow('does not map to a value'));
  test('an EMPTY re-source still drops the row', () => none('g.V().map(__.V(99).constant(null))'));
  test('a non-null first value is unaffected', () =>
    expect(rows("g.V().map(__.V().values('age').order().limit(1))").map((r) => r.v)).toEqual(Array(6).fill(27)));
  // A re-sourced FINAL coalesce arm reads its own presence; an earlier arm's value still answers.
  test('a re-sourced coalesce fallback keeps the earlier arm', () =>
    expect(bagOf(rows("g.V().map(__.coalesce(__.values('age'), __.V(99).values('name')))").map((r) => r.v))).toEqual([27, 29, 32, 35]));
  test('a re-sourced coalesce fallback that is null is no fallback', () =>
    expect(bagOf(rows("g.V().map(__.coalesce(__.values('age'), __.V().constant(null).limit(1)))").map((r) => r.v)))
      .toEqual([27, 29, 32, 35]));
  // A null `by()` value is absent (docs/feature-support-matrix.md §17): `project()` omits the key.
  test('a by() null is absent (§17)', () => expect(rows(`g.V().project('a').by(${CHOOSE})`).map((r) => r.map)).toEqual(Array(6).fill('[]')));
  // A write applies a productive null rather than skipping it: the reference REMOVES the key.
  test('a property() value that is a productive null removes the key', () => {
    const store = seededStore();
    run(store, "g.V().property('age', __.V().constant(null).limit(1))");
    expect(run(store, "g.V().has('age').count()").map((r) => r.v)).toEqual([0]);
  });
});

// A mid-traversal V() SPLITS the host traverser (GraphStep.java:196 `head.split(element, this)`), so the
// body sees the HOST's sack, loops, path and path labels. The rooted read is computed once for every host,
// so it cannot hold any of them: a body that reads one refuses (`rootedRead`'s `readsHostState`) rather
// than answering with the withSack seed or a one-element path. Reference answers in the comments.
describe('a re-sourced body that reads host traverser state refuses', () => {
  const refuses = (g: string): void => { expect(() => run(s, g)).toThrow(UnsupportedTraversal); };
  const SACK3 = 'g.withSack(1).V().sack(sum).by(__.constant(2))';
  test('sack()', () => refuses(`${SACK3}.map(__.V().sack())`)); // 6 x 3
  test('sack().sum()', () => refuses(`${SACK3}.map(__.V().sack().sum())`)); // 6 x 18
  test('values().sack()', () => refuses(`${SACK3}.map(__.V().values('age').sack())`)); // 6 x 3
  test('sack().order()', () => refuses(`${SACK3}.map(__.V().sack().order())`)); // 6 x 3
  test('a per-row host sack', () => refuses("g.withSack(1).V().sack(sum).by('age').map(__.V().sack())")); // 30, 28, 33, 36
  test('project().by()', () => refuses(`${SACK3}.project('s').by(__.V().sack())`)); // 6 x {s:3}
  test('a sack fold in the body', () => refuses(`${SACK3}.map(__.V().sack(sum).by(__.constant(1)).sack())`)); // 6 x 4
  test('a where() body', () => refuses(`${SACK3}.where(__.V().sack().is(3))`)); // all 6
  test('a P operand', () => refuses(`${SACK3}.where(__.constant(3).is(eq(__.V().sack())))`)); // all 6
  test('a nested choose arm', () => refuses(`${SACK3}.choose(__.hasLabel('person'), __.map(__.V().sack()), __.constant(0))`));
  test('simplePath()', () => refuses("g.V().out().map(__.V().simplePath().count())")); // 6 x 4
  test('a host path label', () => refuses("g.V().as('x').map(__.V().as('y').select('x').count())")); // 6 x 6
  test('loops() inside a walk', () => refuses("g.V().repeat(__.out()).times(1).map(__.V().loops())"));
});

describe('a SOURCE union arm starts fresh', () => {
  test('it reads the withSack seed', () =>
    expect(rows('g.withSack(1).union(__.V().sack())').map((r) => r.v)).toEqual([1, 1, 1, 1, 1, 1]));
  test('a host-state-free re-source under a sack host still answers', () =>
    oneRepeated("g.withSack(1).V().sack(sum).by(__.constant(2)).map(__.V().values('name').order().limit(1))", 6, ['josh'], 'string'));
});

// A CHOOSE with a re-sourced arm: the arm's presence is its value's nullness, so the choice's presence is a CASE over the SAME guards as its value — `choicePresence`
// (`rel/child.ts`), built with the value and type CASEs from one branches array (`scalarChoice`,
// `rel/lower/reduction.ts`). The chosen arm decides: a productive arm keeps its row, an unproductive
// chosen arm drops it (TraversalMapStep over BranchStep's chosen branch,
// vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java).
const vals = (g: string): unknown[] => rows(g).map((r) => r.v);
/** The hosts in a pinned order (josh, lop, marko, peter, ripple, vadas) — a per-row map keeps it. */
const O = "g.V().order().by('name')";
describe('a choose whose arm is a re-sourced value', () => {
  const PERSON = "__.hasLabel('person')";
  const FIRST_NAME = "__.V().values('name').order().limit(1)";
  test('an ordered first value vs a constant', () =>
    expect(vals(`${O}.map(__.choose(${PERSON}, ${FIRST_NAME}, __.constant('x')))`)).toEqual(['josh', 'x', 'josh', 'josh', 'x', 'josh']));
  test('a reduced value vs a constant', () =>
    expect(vals(`${O}.map(__.choose(${PERSON}, __.V().values('age').sum(), __.constant(0)))`)).toEqual([123, 0, 123, 123, 0, 123]));
  test('a productive arm keeps its row; an empty chosen arm drops it', () =>
    expect(vals(`${O}.map(__.choose(${PERSON}, ${FIRST_NAME}, __.V(99).values('name')))`)).toEqual(['josh', 'josh', 'josh', 'josh']));
  test('where() keeps exactly the rows whose chosen arm produced', () => {
    const W = `__.choose(${PERSON}, ${FIRST_NAME}, __.V(99).values('name'))`;
    expect(bagOf(vals(`g.V().where(${W}).values('name')`))).toEqual(bagOf(['marko', 'vadas', 'josh', 'peter']));
    expect(bagOf(vals(`g.V().not(${W}).values('name')`))).toEqual(bagOf(['lop', 'ripple']));
  });
  test('an option map with a re-sourced option', () =>
    expect(vals(`${O}.map(__.choose(__.values('name')).option('marko', ${FIRST_NAME}).option(Pick.none, __.constant('x')).option(Pick.unproductive, __.constant('y')))`))
      .toEqual(['x', 'x', 'josh', 'x', 'x', 'x']));
  test('a T-keyed option map', () =>
    expect(vals(`${O}.map(__.choose(__.label()).option('person', ${FIRST_NAME}).option(Pick.none, __.constant('x')))`))
      .toEqual(['josh', 'x', 'josh', 'josh', 'x', 'josh']));
  test('a correlated movement guard, spelled in each CASE, picks the same arm in all three', () =>
    expect(vals(`${O}.map(__.choose(__.out().count().is(P.gt(1)), ${FIRST_NAME}, __.constant('x')))`)).toEqual(['josh', 'x', 'josh', 'x', 'x', 'x']));
  test('a value-nullness arm beside a stated one drops only its own null', () =>
    expect(bare(run(s, `g.V().map(__.choose(${PERSON}, ${FIRST_NAME}, __.values('age'))).fold()`))[0].list).toBe('["josh","josh","josh","josh"]'));
  test('a nested choose', () =>
    expect(bagOf(vals(`${O}.map(__.choose(${PERSON}, __.choose(__.has('age', P.gt(30)), ${FIRST_NAME}, __.V(99).values('name')), __.constant('x')))`)))
      .toEqual(bagOf(['x', 'josh', 'x', 'josh'])));
  test('under coalesce, an empty chosen arm falls through', () =>
    expect(vals(`${O}.map(__.coalesce(__.choose(${PERSON}, __.V(99).values('name'), __.constant('x')), __.constant('c')))`)).toEqual(['c', 'x', 'c', 'c', 'x', 'c']));
  test('as an order key', () =>
    expect(vals(`g.V().order().by(__.choose(${PERSON}, __.V().values('age').sum(), __.constant(0)), desc).by('name').values('name')`))
      .toEqual(['josh', 'marko', 'peter', 'vadas', 'lop', 'ripple']));
  test('over a possibly-absent label host', () =>
    expect(bagOf(vals(`g.V().optional(__.out().as('a')).map(__.choose(${PERSON}, __.select('a').V().values('name').order().limit(1), __.constant('x')))`)))
      .toEqual(bagOf(['josh', 'josh', 'x', 'x', 'x', 'x', 'x', 'x'])));
  test('an unproductive choice over an element host still declines (its pass-through is the vertex)', () =>
    expect(() => run(s, `g.V().map(__.choose(__.values('name')).option('marko', ${FIRST_NAME}).option(Pick.none, __.constant('x')))`)).toThrow(UnsupportedTraversal));
});

// `reSourcedUnder`'s case 3 — the body over the graph vs over an empty input — chooses its presence through
// the same `choicePresence`. Both of its arms read presence as value nullness, so the choice does too: the
// filter is the chosen value's `IS NOT NULL`, with no EXISTS and no presence column. The empty-input arm's
// null (`count()` is 0 there) therefore reads as nothing (§17), so the unbound hosts drop.
test('a re-sourced body under an absent-able host: presence is the chosen value, no EXISTS', () => {
  const g = "g.V().optional(__.out().as('a')).map(__.select('a').V().count().choose(__.is(0), __.constant(null), __.constant(1)))";
  expect(vals(g)).toEqual([1, 1, 1, 1, 1, 1]);
  const plan = compile(g, {});
  if (plan.kind !== 'read') throw new Error('expected read plan');
  expect(plan.sql).not.toContain('EXISTS (SELECT 1 AS one');
  expect(plan.sql).toMatch(/WHERE \(fm\d+\.v IS NOT NULL\)$/);
});
