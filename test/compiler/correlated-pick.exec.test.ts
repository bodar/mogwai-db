// ONE CORRELATED ROW READ PER HOST (`correlatedFirst`, `src/compiler/rel/lower/scoped.ts`). A first-row body read
// per host row comes back as ONE search, whatever the payload's width: where every payload column is a function of
// one key the body carries (`pickKey` — a stored row's rowid, or a value its position already orders by), the pick
// returns that key and the payload is read off it — a rowid join, or the payload's own lookup over the key — and its
// presence is the key's. So a value, its per-row type and its presence are columns of one pick, never three copies.
//
// `TraversalMapStep` emits the child's FIRST result and drops a traverser whose child has none
// (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TraversalMapStep.java:49-53);
// "first" is the body's emission order (`defaultCollation`), as every first-row read here.
import { test, expect, describe } from 'bun:test';
import { seededStore, run, read, bare, bagOf } from '../support/harness.ts';

const s = seededStore();
const rows = (g: string): any[] => bare(run(s, g));
const scalars = (g: string): unknown[] => rows(g).map((r) => r.v);
const count = (g: string): number => Number(scalars(g)[0]);
const field = (g: string): unknown[] => rows(g).map((r) => JSON.parse(r.map)[0]?.[1]?.v ?? null);
/** How many times one correlated search is spelled in a statement: the leading-key subquery of a re-source pick. */
const spellings = (sql: string, needle: string): number => sql.split(needle).length - 1;

describe('an id() after a hop, under map() and project().by() (N8)', () => {
  // v1's first other vertex with an out-edge is v4 (out: 3, 5), the rest's is v1 (out: 2, 3, 4).
  test('map(V().where(neq(a)).out().id())', () => {
    expect(bagOf(scalars("g.V().as('a').map(V().where(neq('a')).out().id())"))).toEqual(bagOf([3, 2, 2, 2, 2, 2]));
    expect(count("g.V().as('a').map(V().where(neq('a')).out().id()).count()")).toBe(6);
  });
  test('project().by(V().where(neq(a)).out().id())', () => {
    expect(bagOf(field("g.V().as('a').project('i').by(V().where(neq('a')).out().id())"))).toEqual(bagOf([3, 2, 2, 2, 2, 2]));
  });
  test('both().both().id(): the hop read through its direction', () => {
    // v1's first other vertex is v2 (both: v1), whose both() starts at v2; the rest's is v1, both() → v2 → v1.
    expect(bagOf(scalars("g.V().as('a').map(V().where(neq('a')).both().both().id())"))).toEqual(bagOf([2, 1, 1, 1, 1, 1]));
    expect(bagOf(field("g.V().as('a').project('i').by(V().where(neq('a')).both().both().id())"))).toEqual(bagOf([2, 1, 1, 1, 1, 1]));
  });
  test('E().where(outV().where(neq(a))).inV().id()', () => {
    // The first edge not out of v1 is e10 (4 → 5); out of anything else, e7 (1 → 2).
    expect(bagOf(scalars("g.V().as('a').map(E().where(outV().where(neq('a'))).inV().id())"))).toEqual(bagOf([5, 2, 2, 2, 2, 2]));
    expect(bagOf(field("g.V().as('a').project('i').by(E().where(outV().where(neq('a'))).inV().id())"))).toEqual(bagOf([5, 2, 2, 2, 2, 2]));
  });
  test('limit(3).out().id()', () => {
    expect(bagOf(scalars("g.V().as('a').map(V().where(neq('a')).limit(3).out().id())"))).toEqual(bagOf([3, 2, 2, 2, 2, 2]));
    expect(bagOf(field("g.V().as('a').project('i').by(V().where(neq('a')).limit(3).out().id())"))).toEqual(bagOf([3, 2, 2, 2, 2, 2]));
  });
});

describe('the pick composes at depth', () => {
  test('as an order().by() value', () => {
    expect(scalars("g.V().as('a').order().by(V().where(neq('a')).out().id()).id()").at(-1)).toBe(1);
  });
  test('inside local(), union() and coalesce()', () => {
    expect(bagOf(scalars("g.V().as('a').local(map(V().where(neq('a')).out().id()))"))).toEqual(bagOf([3, 2, 2, 2, 2, 2]));
    expect(bagOf(scalars("g.V().as('a').union(map(V().where(neq('a')).out().id()), constant(0))"))).toEqual(bagOf([3, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0]));
    expect(bagOf(scalars("g.V().as('a').coalesce(map(V().where(neq('a')).out().id()), constant(0))"))).toEqual(bagOf([3, 2, 2, 2, 2, 2]));
  });
  test('in a filter, and as a dedup() key', () => {
    expect(scalars("g.V().as('a').where(map(V().where(neq('a')).out().id()).is(3)).id()")).toEqual([1]);
    expect(count("g.V().as('a').dedup().by(V().where(neq('a')).out().id()).count()")).toBe(2);
  });
  test('a pick inside a pick', () => {
    expect(scalars("g.V().map(out().map(out().values('name')))")).toEqual(['lop']);
  });
});

describe('one search per host row', () => {
  // The leading-element search of a re-source pick (`leadingFirst`) is spelled once in the statement: the value,
  // its type tag and the presence test read one key (it was spelled once per column plus once for presence). It
  // tests each candidate with ONE `EXISTS` (`leadingRead`), so a second spelling would bring a second.
  const leading = 'EXISTS';
  test('map(V().where(neq(a)).out().values(name)): value, type and presence read one key', () => {
    const sql = read("g.V().as('a').map(V().where(neq('a')).out().values('name'))").sql;
    expect(spellings(sql, 'LEFT JOIN')).toBe(1);
    expect(spellings(sql, leading)).toBe(1);
  });
  test('groupCount().by(V().where(neq(a)).values(name))', () => {
    expect(rows("g.V().as('a').groupCount().by(V().where(neq('a')).values('name'))").map((r) => JSON.parse(r.map).map(([k, v]: any) => [k.v, v.v])))
      .toEqual([[['marko', 5], ['vadas', 1]]]);
    expect(spellings(read("g.V().as('a').groupCount().by(V().where(neq('a')).values('name'))").sql, leading)).toBe(1);
  });
});

describe('an unread pick is never searched for', () => {
  // A count() reads no field of the record, so the pick's join is dropped (`dropUnreadJoins`) and its body — whose
  // receiver check would raise on an age — never runs (docs/feature-support-matrix.md §17, error timing).
  test('project().by(values(age).toUpper()).count()', () => {
    expect(count("g.V().hasLabel('person').project('x').by(values('age').toUpper()).count()")).toBe(4);
    expect(read("g.V().project('x').by(out().values('name')).count()").sql).not.toContain('JOIN');
  });
  test('a field whose value may raise is guarded by its key', () => {
    // No host has an out-neighbour without a name, so no key is NULL here; the record of v2 has no field.
    expect(bagOf(field("g.V().project('n').by(out().values('name').toUpper())"))).toEqual(bagOf(['VADAS', null, null, 'LOP', null, 'LOP']));
  });
});
