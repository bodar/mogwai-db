// count(Scope.local) counts a collection's MEMBERS regardless of member kind — it never reads a
// member's value, so an ELEMENT-membered list (aggregate("a").cap("a")) counts exactly as a scalar
// one does. Answered before listRetype's bare-list gate (which the value reducers need). See list.ts.
import { test, expect, describe } from 'bun:test';
import { run, seededStore } from '../support/harness.ts';

describe('count(Scope.local) over element-membered collections', () => {
  const one = (store: ReturnType<typeof seededStore>, g: string) =>
    (run(store, g) as { v: number }[])[0]!.v;

  test('an element aggregate list reports its multiset SIZE', () => {
    const store = seededStore();
    expect(one(store, 'g.V().aggregate("a").cap("a").count(Scope.local)')).toBe(6);
    // both() = 12 traversers over the 6-edge modern graph — a multiset, counted as such
    expect(one(store, 'g.V().both().aggregate("a").cap("a").count(Scope.local)')).toBe(12);
    expect(one(store, 'g.V().out().aggregate("a").cap("a").count(Scope.local)')).toBe(6);
  });

  test('scalar-membered and map count(local) still report their own sizes', () => {
    const store = seededStore();
    expect(one(store, 'g.V().values("name").aggregate("a").cap("a").count(Scope.local)')).toBe(6);
    expect(one(store, 'g.V().groupCount("a").cap("a").count(Scope.local)')).toBe(6); // map entry count
  });
});
