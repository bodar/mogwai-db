// `group` is LADDERLESS (docs/2026-11-16-ladder-retirement-plan.md, R5.3+R5.4 then the route delete): its connector
// row (`byValues`, src/compiler/rel/lower/scoped.ts) is its one lowering over an element or scalar host, so the
// dispatch offers no ladder there — every switch position runs the SAME lowering and answers alike. The value
// `by()` is ASSIGNED per traverser when its body has no barrier (`Operator.assign`) and POOLED per key at its first
// barrier otherwise (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Grouping.java:74-125).
import { test, expect, describe } from 'bun:test';
import { bagOf, bare, runWith, seededStore, storeSeededWith } from '../support/harness.ts';

const store = seededStore();
const CONNECTOR_ONLY = { fastPaths: { connectorOnly: true } } as const;
const LADDER_FIRST = { fastPaths: { correlatedChild: true } } as const;
/** The answer as a multiset of plain values (the map's entry list for a map row). */
const answer = (q: string, options?: object): string[] => bagOf(bare(runWith(store, q, options as never)).map((r: any) => JSON.stringify(r.map ?? r.v ?? r.id ?? r)));
/** Every switch position answers the same — one lowering. */
const agreed = (q: string) => {
  const ours = answer(q);
  expect(answer(q, CONNECTOR_ONLY)).toEqual(ours);
  expect(answer(q, LADDER_FIRST)).toEqual(ours);
  return ours;
};
/** A map row's entries as `key → value`. */
const entries = (row: string): Record<string, unknown> =>
  Object.fromEntries((JSON.parse(JSON.parse(row)) as [{ v: unknown }, { v: unknown }][]).map(([k, v]) => [String(k.v), v.v]));

describe('group() — the connector is the one lowering', () => {
  test('an assigned value by() keeps the last traverser per key', () => {
    const [row] = agreed("g.V().group().by(label).by(values('name'))");
    expect(entries(row!)).toEqual({ person: 'peter', software: 'ripple' });
  });
  test('a pooled value by() reduces per key', () => {
    const [row] = agreed('g.V().group().by(label).by(out().count())');
    expect(entries(row!)).toEqual({ person: 6, software: 0 });
    expect(entries(agreed("g.V().group().by(out().count()).by(values('name').fold())")[0]!))
      .toEqual({ 0: ['vadas', 'lop', 'ripple'], 1: ['peter'], 2: ['josh'], 3: ['marko'] });
  });
  test('a keyed group in a union arm, read by cap', () => {
    const [row] = agreed("g.V().union(group('a').by(label).by(count()), out()).cap('a')");
    expect(entries(row!)).toEqual({ person: 4, software: 2 });
    expect(entries(agreed("g.V().group('m').by(label).by(values('name')).cap('m')")[0]!)).toEqual({ person: 'peter', software: 'ripple' });
  });
  test('at depth — under local, map, project().by() and where()', () => {
    expect(agreed("g.V().local(out().group().by(label).by(values('name')))").length).toBe(6);
    expect(agreed("g.V().project('g').by(out().group().by(label).by(count()))").length).toBe(6);
    expect(agreed("g.V().map(both().group().by('name').by(out().count()))").length).toBe(6);
    expect(agreed("g.V().where(out().group().by(label).by(count()).select('software').is(gt(0))).values('name')"))
      .toEqual(bagOf(['"marko"', '"josh"', '"peter"']));
  });
});

// A `Scope.local` reducer ending the value body is a `MapStep` over ONE traverser's value, not a
// `ReducingBarrierStep`, so the body has no barrier and the value is ASSIGNED per traverser (`Operator.assign`,
// Grouping.java:74-125 — `determineBarrierStep` finds none). It used to reach the pooled arm by step NAME and
// answer the key's total (`person:4`, `person:123`).
describe('group() — a local reducer in the value by() is per traverser, not pooled', () => {
  test('count(local) of a member value is 1, not the key total', () => {
    expect(entries(agreed("g.V().group().by(label).by(values('name').count(local))")[0]!)).toEqual({ person: 1, software: 1 });
  });
  test('sum(local) keeps one member\'s own age, not the total 123', () => {
    const { person } = entries(agreed("g.V().group().by(label).by(values('age').sum(local))")[0]!);
    expect([29, 27, 32, 35]).toContain(person as number);
    expect(entries(agreed("g.V().hasLabel('person').group().by('name').by(values('age').sum(local))")[0]!))
      .toEqual({ marko: 29, vadas: 27, josh: 32, peter: 35 });
  });
  test('the keyed group(\'a\')…cap(\'a\') form and a local() variant', () => {
    expect(entries(agreed("g.V().group('a').by(label).by(values('name').count(local)).cap('a')")[0]!)).toEqual({ person: 1, software: 1 });
    const perVertex = agreed("g.V().local(group().by(label).by(values('name').count(local)))").map(entries);
    expect(bagOf(perVertex.map((m) => JSON.stringify(m))))
      .toEqual(bagOf([...Array(4).fill('{"person":1}'), ...Array(2).fill('{"software":1}')]));
  });
  test('a GLOBAL barrier before the local reducer still pools per key', () => {
    expect(entries(agreed("g.V().group().by(label).by(out().fold().count(local))")[0]!)).toEqual({ person: 6, software: 0 });
    expect(entries(agreed("g.V().group().by(label).by(values('age').fold().sum(local))")[0]!)).toEqual({ person: 123 });
    expect(entries(agreed("g.V().group().by(label).by(values('age').sum())")[0]!)).toEqual({ person: 123 });
  });
  test('a body after a local fold reducer answers per member', () => {
    expect(entries(agreed("g.V().group().by(id).by(local(out().fold()).count(local))")[0]!))
      .toEqual({ 1: 3, 2: 0, 3: 0, 4: 2, 5: 0, 6: 1 });
  });
  test('a local reader over a list-valued property splits the member\'s own list', () => {
    const listStore = storeSeededWith(["g.addV('x').property('name','a').property('l',[3,1,3])"]);
    const one = (q: string) => entries(JSON.stringify((bare(runWith(listStore, q)) as any[])[0].map));
    expect(one("g.V().group().by('name').by(values('l').count(local))")).toEqual({ a: 3 });
    expect(one("g.V().group().by('name').by(values('l').max(local))")).toEqual({ a: 3 });
  });
});

// A PROPERTY host is outside the connector's group row, so its group is the host's own lowering (`groupRows`,
// src/compiler/rel/map.ts), which builds NO pool: a value body with a barrier declines there — never the per-member
// assign arm, which would answer one member's value for the key's pool — except a bare `by(count())`, which pools
// nothing but the key's own traversers and is `groupCount()`'s value exactly. Not a `CONNECTORS` row, so the
// connector-only mode (L9) has no route for it; the default and ladder-first positions answer alike.
describe('group() over a property host — the host lowering pools nothing', () => {
  const declines = (q: string) => expect(() => runWith(store, q)).toThrow(/not supported/);
  const hostAnswer = (q: string) => {
    const ours = answer(q);
    expect(answer(q, LADDER_FIRST)).toEqual(ours);
    return ours;
  };
  test('by(count()) answers as groupCount', () => {
    expect(entries(hostAnswer('g.V().properties().group().by(key).by(count())')[0]!)).toEqual({ age: 4, lang: 2, name: 6 });
    expect(entries(hostAnswer('g.V().properties().groupCount().by(key)')[0]!)).toEqual({ age: 4, lang: 2, name: 6 });
  });
  test('a pooling body is a clean decline, not a per-member answer', () => {
    declines('g.V().properties().group().by(key).by(value().fold())');
    declines('g.V().properties().group().by(key).by(value().sum())');
    declines('g.V().properties().group().by(key).by(value().count())');
    declines('g.V().properties().group().by(key).by(value().dedup().fold())');
    declines('g.V().properties().group().by(key).by(value().order().fold())');
  });
  test('a barrier-free body is assigned per traverser, at depth too', () => {
    expect(entries(hostAnswer('g.V().properties().group().by(key).by(value().count(local))')[0]!)).toEqual({ age: 1, lang: 1, name: 1 });
    expect(hostAnswer('g.V().local(properties().group().by(key).by(count()))').map(entries).map((m) => JSON.stringify(m)))
      .toEqual(bagOf([...Array(4).fill('{"age":1,"name":1}'), ...Array(2).fill('{"lang":1,"name":1}')]));
  });
});
