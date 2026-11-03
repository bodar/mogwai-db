// A CORRELATED BODY THAT SCANS THE HOST'S TABLE AGAIN MUST NOT RE-DECLARE THE HOST'S ALIAS. Every scan
// of `nodes` carries the fixed alias `rn`, so `local(__.values('name').as('e').V()…)` rendered its
// re-scan as `CROSS JOIN nodes rn` INSIDE the subquery that reads the host's `rn.id` — and SQLite
// resolves a qualifier to the innermost FROM item declaring it, so the body read its own row as the
// host: every person counted all 6 vertices instead of the 1 that carries its name. The body of a
// `local()`/`map()`/`by()`/`where()` is a per-traverser child traversal over the HOST traverser
// (`TraversalUtil.apply`, vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java),
// so its values('name') is the host's name. The emitter now places a direct-source FROM item under a
// fresh alias whenever an enclosing scope already binds its fixed one (`freshAlias`, src/rel/emit.ts),
// and ONLY then — a plan with no collision keeps its aliases byte for byte.
import { describe, expect, test } from 'bun:test';
import { bagOf, bare, read, run, seededStore, zooStore } from '../support/harness.ts';

const BODY = "__.values('name').as('e').V().has('name', select('e'))";
// Host order is the planner's (an unordered stream — L8 reverses it), so answers compare as multisets.
const values = (s: ReturnType<typeof seededStore>, g: string): unknown[] => bagOf(bare(run(s, g)).map((row: { v: unknown }) => row.v));

describe.each([
  ['modern', seededStore(), 4],
  ['zoo', zooStore(), 1],
] as const)('a re-scan inside a correlated body reads the host row (%s)', (_name, s, persons) => {
  const ones = Array.from({ length: persons }, () => 1);
  test('local()', () => expect(values(s, `g.V().hasLabel('person').local(${BODY}.count())`)).toEqual(ones));
  test('map()', () => expect(values(s, `g.V().hasLabel('person').map(${BODY}.count())`)).toEqual(ones));
  test('project().by()', () =>
    expect(bare(run(s, `g.V().hasLabel('person').project('a').by(${BODY}.count())`)).length).toBe(persons));
  test('where() twin', () => expect(values(s, `g.V().hasLabel('person').where(${BODY}.count().is(1)).count()`)).toEqual([persons]));
  test('filter() twin', () => expect(values(s, `g.V().hasLabel('person').filter(${BODY}.count().is(1)).count()`)).toEqual([persons]));
  test('not() twin', () => expect(values(s, `g.V().hasLabel('person').not(${BODY}.count().is(1)).count()`)).toEqual([0]));
  test('flatMap() agrees', () => expect(values(s, `g.V().hasLabel('person').flatMap(${BODY}).count()`)).toEqual([persons]));
});

describe('deeper compositions on modern', () => {
  const s = seededStore();
  test('a movement before the re-scan: each person counts its out-neighbours by name', () =>
    expect(values(s, "g.V().hasLabel('person').local(__.out().values('name').as('e').V().has('name', select('e')).count())"))
      .toEqual(bagOf([3, 0, 2, 1])));
  test('a movement after a bare re-scan: out-degree × |V|', () =>
    expect(values(s, "g.V().hasLabel('person').map(__.out().V().count())")).toEqual(bagOf([18, 0, 12, 6])));
  test('a where() body that moves on from the re-scan', () =>
    expect(values(s, "g.V().hasLabel('person').where(__.values('name').as('e').V().has('name', select('e')).out().count().is(gt(0))).values('name')"))
      .toEqual(bagOf(['marko', 'josh', 'peter'])));
  test('a property read off the re-scanned vertex', () =>
    expect(values(s, `g.V().hasLabel('person').local(${BODY}.values('age'))`)).toEqual(bagOf([29, 27, 32, 35])));
});

describe('alias placement', () => {
  const declarations = (sql: string): number => sql.match(/\bnodes rn\b/g)?.length ?? 0;
  test('the re-scan takes a fresh alias; the host keeps rn', () => {
    const { sql } = read(`g.V().hasLabel('person').local(${BODY}.count())`);
    expect(declarations(sql)).toBe(1);
    expect(sql).toMatch(/ FROM nodes rn WHERE /);
  });
  test('top-level aliases do not move when nothing collides', () => {
    expect(read("g.V().hasLabel('person').values('name')").sql).toMatch(/FROM nodes rn\b/);
    expect(read("g.V().hasLabel('person').local(__.out().count())").sql).not.toMatch(/nodes src\d/);
  });
});
