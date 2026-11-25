/**
 * `within`/`without` over a RUN-TIME folded set compares each member's PAYLOAD, never its `{t,v}` envelope.
 *
 * `Contains.within` is `.equals` on each collection member's value
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Contains.java`).
 * A typed fold stores a Double, a Date or a Long held as text as a `{t,v}` node, so a raw read of the
 * member compared JSON text with the subject and matched nothing: `has('d', within(__.V().values('d').fold()))`
 * returned no row, and `without` kept every row. `foldedListSet` (`src/compiler/rel/lower/reduction.ts`) now
 * reads each member through `payloadOf` (`src/compiler/rel/list.ts`), the list module's one payload authority,
 * at every host that resolves a folded operand: `has`, `is`, `where`, a connector body, and the map-entry
 * `select(Column.values)` form.
 */
import { describe, expect, test } from 'bun:test';
import { bare, run, storeSeededWith } from '../support/harness.ts';

const store = storeSeededWith([
  "g.addV('p').property('name','a').property('d',1.5d).property('t',datetime('2020-01-01T00:00:00Z')).property('i',1)",
  "g.addV('p').property('name','b').property('d',2.25d).property('t',datetime('2021-01-01T00:00:00Z')).property('i',2)",
  "g.addV('p').property('name','c').property('i',3)",
  "g.V().has('name','c').addE('e').to(V().has('name','a'))",
]);
const values = (q: string): unknown[] => (bare(run(store, q)) as { v: unknown }[]).map((row) => row.v).sort();

describe('a folded within/without set reads member payloads', () => {
  test('has() over a folded set of doubles', () => {
    expect(values("g.V().has('d', within(__.V().values('d').fold())).values('name')")).toEqual(['a', 'b']);
    expect(values("g.V().has('d', within(__.V().has('name','a').values('d').fold())).values('name')")).toEqual(['a']);
  });

  test('has() over a folded set of datetimes', () => {
    expect(values("g.V().has('t', within(__.V().values('t').fold())).values('name')")).toEqual(['a', 'b']);
  });

  test('where() and is() over a value stream', () => {
    expect(values("g.V().values('d').where(within(__.V().values('d').fold()))")).toEqual([1.5, 2.25]);
    expect(values("g.V().values('d').is(within(__.V().values('d').fold()))")).toEqual([1.5, 2.25]);
  });

  test('without() excludes every member', () => {
    expect(values("g.V().has('d', without(__.V().values('d').fold())).count()")).toEqual([0]);
    expect(values("g.V().not(has('d', within(__.V().has('name','a').values('d').fold()))).values('name')")).toEqual(['b', 'c']);
  });

  test('inside a connector body', () => {
    expect(values("g.V().where(out().has('d', within(__.V().values('d').fold()))).values('name')")).toEqual(['c']);
    expect(values("g.V().local(has('d', within(__.V().values('d').fold()))).values('name')")).toEqual(['a', 'b']);
    expect(values("g.V().union(has('d', within(__.V().values('d').fold())), has('t', without(__.V().values('t').fold()))).values('name')")).toEqual(['a', 'b']);
  });

  test('a mixed set holds bare and envelope members', () => {
    const mixed = "__.V().union(values('d'), values('i')).fold()";
    expect(values(`g.V().has('d', within(${mixed})).values('name')`)).toEqual(['a', 'b']);
    expect(values(`g.V().has('i', within(${mixed})).values('name')`)).toEqual(['a', 'b', 'c']);
    expect(values("g.V().has('d', within(__.inject(1.5d, 3).fold())).values('name')")).toEqual(['a']);
  });

  test('the map-entry select(Column.values) form', () => {
    const entry = (q: string): unknown => JSON.parse((bare(run(store, q)) as { map: string }[])[0]!.map)[0][1];
    expect(entry("g.inject(['n':[1.5d,2.25d]]).unfold().group().by(keys).by(__.V().has('d', within(select(values))).count())"))
      .toEqual({ t: 'long', v: 2 });
    expect(entry("g.inject(['n':[2.25d]]).unfold().group().by(keys).by(__.V().has('d', without(select(values))).count())"))
      .toEqual({ t: 'long', v: 1 });
    expect(entry("g.inject(['n':[1,3]]).unfold().group().by(keys).by(__.V().has('i', within(select(values))).count())"))
      .toEqual({ t: 'long', v: 2 });
  });
});
