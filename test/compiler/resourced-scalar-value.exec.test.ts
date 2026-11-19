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
import { UnsupportedTraversal } from '../../src/compiler/compiler.ts';

const s = seededStore();
const rows = (g: string): any[] => bare(run(s, g));
const NAMES = ['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas'];

/** Every host row is the same `{v, vtype}`, `n` of them, and `v` is one of `members`. */
const oneRepeated = (g: string, n: number, members: readonly unknown[], vtype: string): void => {
  const got = rows(g);
  expect(got).toHaveLength(n);
  expect(new Set(got.map((r) => JSON.stringify(r))).size).toBe(1);
  expect(members).toContain(got[0].v);
  expect(got[0].vtype ?? got[0].vt).toBe(vtype);
};

describe('an unordered re-sourced first value is one member, typed', () => {
  test('map(V.values(name))', () => oneRepeated("g.V().map(__.V().values('name'))", 6, NAMES, 'string'));
  test('map(V.values(name).limit(1))', () => oneRepeated("g.V().map(__.V().values('name').limit(1))", 6, NAMES, 'string'));
  test('map(V.values(name).dedup())', () => oneRepeated("g.V().map(__.V().values('name').dedup())", 6, NAMES, 'string'));
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
  test('sum keeps an int', () => oneRepeated("g.V().map(__.V().values('age').sum())", 6, [123], 'int'));
  test('max of edge weights is a double', () => oneRepeated("g.V().map(__.E().values('weight').max())", 6, [1], 'double'));
  test('mean is a double', () => oneRepeated("g.V().map(__.V().has('age').values('age').mean())", 6, [30.75], 'double'));
  test('under a choose arm', () => {
    const got = rows("g.V().choose(__.hasLabel('person'), __.map(__.V().values('age').order()), __.constant(0))");
    expect(got.map((r) => r.v).sort()).toEqual([0, 0, 27, 27, 27, 27]);
    expect(got.every((r) => r.vtype === 'int')).toBe(true);
  });
  test('an empty body maps to nothing', () => expect(rows("g.V().map(__.V().values('age').is(gt(100)))")).toEqual([]));
});

// A re-sourced body's FIRST value that is null is a PRODUCTIVE null: the body has a row, so `map()` emits it
// (`TraversalMapStep` emits whenever the child `hasNext()`, step/map/TraversalMapStep.java). The connector
// joins the body's ROW back (`lower/scoped.ts` `reSourcedBody`), so presence is the row, not the value's
// nullness. Consumers that still read the scalar first-row value (a concat() operand, a by() value) keep the
// §17 reading (docs/feature-support-matrix.md).
describe('a re-sourced first value that is null is a value', () => {
  const nulls = (g: string, n: number): void => expect(rows(g).map((r) => r.v)).toEqual(Array(n).fill(null));
  const CHOOSE = "__.V().choose(__.hasLabel('person'), __.values('age'), __.constant(null)).order().limit(1)";
  test('choose(…, constant(null)).order().limit(1)', () => nulls(`g.V().map(${CHOOSE})`, 6));
  test('coalesce(values(age), constant(null))', () =>
    nulls("g.V().map(__.V().coalesce(__.values('age'), __.constant(null)).order().limit(1))", 6));
  test('union(values(age), constant(null))', () =>
    nulls("g.V().map(__.V().union(__.values('age'), __.constant(null)).order().limit(1))", 6));
  test('an inject host', () => nulls(`g.inject(1).map(${CHOOSE})`, 1));
  test('constant(null)', () => nulls('g.V().map(__.V().constant(null))', 6));
  test('inside local(map())', () => nulls(`g.V().local(__.map(${CHOOSE}))`, 6));
  test('counted after the map', () => expect(rows('g.V().map(__.V().constant(null)).count()')[0].v).toBe(6));
  test('local() and flatMap() keep every null row', () => {
    expect(rows('g.V().local(__.V().constant(null)).count()')[0].v).toBe(36);
    expect(rows('g.V().flatMap(__.V().constant(null)).count()')[0].v).toBe(36);
  });
  test('a where() body over it keeps the row', () => expect(rows('g.V().where(__.V().constant(null).limit(1)).count()')[0].v).toBe(6));
  test('a concat() operand raises as an empty one does (§17)', () =>
    expect(() => run(s, "g.V().values('name').concat(__.V().constant(null))")).toThrow('does not map to a value'));
  test('an EMPTY re-source still drops the row', () => expect(rows('g.V().map(__.V(99).constant(null))')).toEqual([]));
  test('a non-null first value is unaffected', () =>
    expect(rows("g.V().map(__.V().values('age').order().limit(1))").map((r) => r.v)).toEqual(Array(6).fill(27)));
  // A re-sourced FINAL coalesce arm reads its own presence; an earlier arm's value still answers.
  test('a re-sourced coalesce fallback keeps the earlier arm', () =>
    expect(bagOf(rows("g.V().map(__.coalesce(__.values('age'), __.V(99).values('name')))").map((r) => r.v))).toEqual([27, 29, 32, 35]));
  test('a re-sourced coalesce fallback that is null is a null', () =>
    expect(bagOf(rows("g.V().map(__.coalesce(__.values('age'), __.V().constant(null).limit(1)))").map((r) => r.v)))
      .toEqual(bagOf([27, 29, 32, 35, null, null])));
  // A null `by()` value is absent (docs/feature-support-matrix.md §17): `project()` omits the key.
  test('a by() null is absent (§17)', () => expect(rows(`g.V().project('a').by(${CHOOSE})`).map((r) => r.map)).toEqual(Array(6).fill('[]')));
  // A write applies a productive null rather than skipping it: the reference REMOVES the key.
  test('a property() value that is a productive null removes the key', () => {
    const store = seededStore();
    run(store, "g.V().property('age', __.V().constant(null).limit(1))");
    expect(run(store, "g.V().has('age').count()").map((r) => r.v)).toEqual([0]);
  });
});

// A re-sourcing body's read is computed ONCE and crossed with each host, at any depth and under any host.
describe('a re-sourcing body composes', () => {
  test('a per-row total', () => expect(rows("g.V().as('p').map(__.V().hasLabel('software').count())").map((r) => r.v)).toEqual(Array(6).fill(2)));
  test('local() is every row per host', () => expect(rows("g.V().local(__.V().values('name')).count()")[0].v).toBe(36));
  test('a select() of a label every row binds is one row', () =>
    expect(rows("g.V().as('a').map(__.select('a').V().count())").map((r) => r.v)).toEqual(Array(6).fill(6)));
  test('group() pools each key: |pool| × the graph', () =>
    expect(rows('g.V().group().by(label).by(__.V().count())')[0].map)
      .toBe('[[{"t":"string","v":"person"},{"t":"long","v":24}],[{"t":"string","v":"software"},{"t":"long","v":12}]]'));
  test('group() with a fold keeps every member\'s crossing', () =>
    expect(rows("g.V().group().by(label).by(__.V().values('name').fold().count(local))")[0].map)
      .toBe('[[{"t":"string","v":"person"},{"t":"long","v":24}],[{"t":"string","v":"software"},{"t":"long","v":12}]]'));
  test('nested: inside a where() body and a union() arm', () => {
    expect(rows("g.V().where(__.map(__.V().has('age', gt(30)).count()).is(2)).count()")[0].v).toBe(6);
    expect(rows("g.V().union(__.map(__.V().count()), __.constant(0)).sum()")[0].v).toBe(36);
  });
  test('local() keeps the HOST\'s sack through the split (GraphStep head.split)', () =>
    expect(rows("g.withSack(1).V().sack(sum).by(__.constant(2)).local(__.V().hasLabel('software')).sack()").map((r) => r.v)).toEqual(Array(12).fill(3)));
  test('inside local(flatMap())', () => expect(rows("g.V().local(__.flatMap(__.V().hasLabel('software'))).count()")[0].v).toBe(12));
});


// A mid-traversal V() SPLITS the host traverser (GraphStep.java:196 `head.split(element, this)`), so the
// body sees the HOST's sack, loops, path and path labels. The shared rooted read cannot hold any of them, so
// under a first-row host (`map`/`by()`/a filter) such a body is GraphStep's cross with the host, read per host
// row by the host's correlated-first policy (`lower/scoped.ts` `reSourcedBody`) — never the withSack seed or a
// one-element path. The scalar seam alone (a `P` operand, a walk's `loops()`) still refuses.
describe('a re-sourced body that reads host traverser state answers per host', () => {
  const values = (g: string): unknown[] => rows(g).map((r) => r.v);
  const refuses = (g: string): void => { expect(() => run(s, g)).toThrow(UnsupportedTraversal); };
  const SACK3 = 'g.withSack(1).V().sack(sum).by(__.constant(2))';
  test('sack()', () => expect(values(`${SACK3}.map(__.V().sack())`)).toEqual(Array(6).fill(3)));
  test('sack().sum()', () => expect(values(`${SACK3}.map(__.V().sack().sum())`)).toEqual(Array(6).fill(18)));
  test('values().sack()', () => expect(values(`${SACK3}.map(__.V().values('age').sack())`)).toEqual(Array(6).fill(3)));
  test('sack().order()', () => expect(values(`${SACK3}.map(__.V().sack().order())`)).toEqual(Array(6).fill(3)));
  test('a per-row host sack', () => expect(bagOf(values("g.withSack(1).V().sack(sum).by('age').map(__.V().sack())"))).toEqual(bagOf([30, 28, 33, 36])));
  test('project().by()', () => expect(rows(`${SACK3}.project('s').by(__.V().sack())`).map((r) => JSON.parse(r.map)[0][1].v)).toEqual(Array(6).fill(3)));
  test('a sack fold in the body', () => expect(values(`${SACK3}.map(__.V().sack(sum).by(__.constant(1)).sack())`)).toEqual(Array(6).fill(4)));
  test('a where() body', () => expect(values(`${SACK3}.where(__.V().sack().is(3)).count()`)).toEqual([6]));
  test('a nested choose arm', () => expect(bagOf(values(`${SACK3}.choose(__.hasLabel('person'), __.map(__.V().sack()), __.constant(0))`))).toEqual(bagOf([3, 3, 3, 3, 0, 0])));
  test('simplePath()', () => expect(values("g.V().out().map(__.V().simplePath().count())")).toEqual(Array(6).fill(4)));
  test('a host path label', () => expect(values("g.V().as('x').map(__.V().as('y').select('x').count())")).toEqual(Array(6).fill(6)));
  test('a P operand still refuses', () => refuses(`${SACK3}.where(__.constant(3).is(eq(__.V().sack())))`)); // all 6
  test('loops() inside a walk still refuses', () => refuses("g.V().repeat(__.out()).times(1).map(__.V().loops())"));
});

describe('a SOURCE union arm starts fresh', () => {
  test('it reads the withSack seed', () =>
    expect(rows('g.withSack(1).union(__.V().sack())').map((r) => r.v)).toEqual([1, 1, 1, 1, 1, 1]));
  test('a host-state-free re-source under a sack host still answers', () =>
    oneRepeated("g.withSack(1).V().sack(sum).by(__.constant(2)).map(__.V().values('name').order().limit(1))", 6, ['josh'], 'string'));
});

// A CHOOSE with a re-sourced arm: the arm's presence is its value's nullness, so the choice's presence is the
// compile-time meet of its arms' — `meetPresence` (`rel/child.ts`), read by `scalarChoice`
// (`rel/lower/reduction.ts`) — and the chosen value's NULL is the dropped row. The chosen arm decides: a productive arm keeps its row, an unproductive
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
  test('over a possibly-absent label host it declines with an explanation', () =>
    expect(() => run(s, `g.V().optional(__.out().as('a')).map(__.choose(${PERSON}, __.select('a').V().values('name').order().limit(1), __.constant('x')))`))
      .toThrow(/V\(\)\/E\(\) inside this body discards the value before it/));
  // The unproductive pass-through is the VERTEX, so the choice is a VARIANT (a value arm beside an element arm);
  // the per-traverser rejoin carries a variant payload (`rowResident`, `src/compiler/rel/framing.ts`), so it answers.
  // Every vertex has a name, so no row takes the pass-through here.
  test('an unproductive choice over an element host answers as a variant (its pass-through is the vertex)', () =>
    expect(vals(`${O}.map(__.choose(__.values('name')).option('marko', ${FIRST_NAME}).option(Pick.none, __.constant('x')))`))
      .toEqual(['x', 'x', 'josh', 'x', 'x', 'x']));
});

// Over a possibly-absent host the re-source declines (`reSourcedUnder`) rather than choosing per row
// between the body over the graph and over an empty input — the discarded value makes that answer baffling.
test('a re-sourced body under an absent-able host declines, whatever follows it', () =>
  expect(() => run(s, "g.V().optional(__.out().as('a')).map(__.select('a').V().count().choose(__.is(0), __.constant(null), __.constant(1)))"))
    .toThrow(/missing on some rows \(an unbound label, an absent property or key\)/));
