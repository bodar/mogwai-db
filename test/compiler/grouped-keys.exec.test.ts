// Consumer-driven fold: `cap("a").select(Column.keys)` over an element-keyed grouping reads the key
// SIDE of the member rows directly (rowids that MOVE), instead of folding to a JSONB map that would
// expand each key to a public payload and lose the rowid. See collection.ts `groupedKeys` and
// docs/2026-08-09-named-collections-are-bindings-plan.md.
import { test, expect, describe } from 'bun:test';
import { run, seededStore } from '../support/harness.ts';

describe('element-keyed select(Column.keys) — consumer-driven fold', () => {
  const names = (store: ReturnType<typeof seededStore>, g: string) =>
    (run(store, g) as { v: unknown }[]).map((r) => r.v).sort();
  const one = (store: ReturnType<typeof seededStore>, g: string) =>
    (run(store, g) as { v: unknown }[])[0]!.v;

  test('keys of an element-keyed groupCount are the vertices themselves', () => {
    const store = seededStore();
    // all six modern-graph vertices are keys
    expect(one(store, 'g.V().groupCount("a").cap("a").select(Column.keys).unfold().count()')).toBe(6);
    // the keys frame as real elements — their properties are reachable through the set
    expect(names(store, 'g.V().groupCount("a").cap("a").select(Column.keys).unfold().values("name")'))
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });

  test('the keys MOVE — both()/out() from a key is the ordinary element loop', () => {
    const store = seededStore();
    // both() from every key === both() from every vertex (the set is the whole vertex set)
    expect(one(store, 'g.V().groupCount("a").cap("a").select(Column.keys).unfold().both().count()'))
      .toBe(one(store, 'g.V().both().count()'));
    expect(one(store, 'g.V().groupCount("a").cap("a").select(Column.keys).unfold().out().count()'))
      .toBe(one(store, 'g.V().out().count()'));
  });

  test('keys of an element-keyed group("a") (collecting) also move', () => {
    const store = seededStore();
    // bare group("a") and a value-by() both key by the element identity; the KEY projection is
    // independent of the value shape, so the key set is the whole vertex set either way.
    expect(one(store, 'g.V().group("a").cap("a").select(Column.keys).unfold().count()')).toBe(6);
    expect(one(store, 'g.V().group("a").by(__.values("name")).cap("a").select(Column.keys).unfold().count()')).toBe(6);
  });
});
