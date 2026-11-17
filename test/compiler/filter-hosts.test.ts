import { describe, expect, test } from 'bun:test';
import { FILTER_HOSTS, PER_TRAVERSER_RESET_HOSTS, SINGLE_BODY_FILTER_HOSTS } from '../../src/compiler/ir/step.ts';
import { COLLAPSE_FILTERS } from '../../src/compiler/ir/bulk.ts';
import { bare, run, seededStore } from '../support/harness.ts';

// THE FILTER HOSTS are one set in the step vocabulary (`ir/step.ts`); every set that means "the filter hosts"
// derives from it, so a new filter host is learned once rather than declined by a stale copy.
describe('filter hosts — one authority', () => {
  test('the derived vocabularies contain every filter host', () => {
    for (const host of FILTER_HOSTS) {
      expect(COLLAPSE_FILTERS.has(host)).toBe(true);
      expect(PER_TRAVERSER_RESET_HOSTS.has(host)).toBe(true);
    }
    expect([...SINGLE_BODY_FILTER_HOSTS].sort()).toEqual(['filter', 'not', 'where']);
  });

  test('the filter hosts answer at the top and inside a fan-out host', () => {
    const store = seededStore();
    const names = (q: string) => (bare(run(store, q)) as { v: unknown }[]).map((r) => r.v).sort();
    expect(names("g.V().where(out('created')).values('name')")).toEqual(['josh', 'marko', 'peter']);
    expect(names("g.V().local(where(out('created')).values('name'))")).toEqual(['josh', 'marko', 'peter']);
    expect(bare(run(store, "g.V().not(out('knows')).count()"))).toEqual([{ v: 5 }]);
    expect(bare(run(store, 'g.V().and(out(), __.in()).count()'))).toEqual([{ v: 1 }]);
  });

  // Every filter host shares the write-in-filter wording, at any depth.
  for (const q of [
    "g.V().where(property('x', 1))",
    "g.V().filter(property('x', 1))",
    "g.V().not(property('x', 1))",
    "g.V().and(property('x', 1), out())",
    "g.V().or(out(), property('x', 1))",
    "g.V().local(where(property('x', 1)))",
  ]) {
    test(`a write inside a filter body declines with the write-in-filter wording: ${q}`, () => {
      expect(() => run(seededStore(), q)).toThrow(/a write \(property\(\)\) inside (where|filter|not|and|or)\(\) — a filter body that writes/);
    });
  }
});
