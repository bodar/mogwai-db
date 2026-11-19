// `group` is LADDERLESS (docs/2026-11-16-ladder-retirement-plan.md, R5.3+R5.4 then the route delete): its connector
// row (`byValues`, src/compiler/rel/lower/scoped.ts) is its one lowering over an element or scalar host, so the
// dispatch offers no ladder there — every switch position runs the SAME lowering and answers alike. The value
// `by()` is ASSIGNED per traverser when its body has no barrier (`Operator.assign`) and POOLED per key at its first
// barrier otherwise (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Grouping.java:74-125).
import { test, expect, describe } from 'bun:test';
import { bagOf, bare, runWith, seededStore } from '../support/harness.ts';

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
