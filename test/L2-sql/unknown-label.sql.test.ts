// L2 — an UNKNOWN label is an empty set, never an error.
//
// A label is a rowid into the `labels` dictionary, and every RelIR read of it goes through ONE seam
// (`src/compiler/rel/names.ts`; `mise run arch` keeps it the only one). The name resolves INSIDE the
// statement through the `UNIQUE (name)` index, so the compile never reads the store, and a name that was
// never interned matches no id. TinkerPop answers the same: `HasContainer` over `T.label` is a plain
// equality test (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/util/HasContainer.java),
// so a label no element carries filters every element out.
import { describe, expect, test } from 'bun:test';
import { bare, read, run, seededStore } from '../support/harness.ts';

const names = (store: ReturnType<typeof seededStore>): string[] =>
  store.query<{ name: string }>('SELECT name FROM labels ORDER BY name').map((r) => r.name);

describe('an unknown label', () => {
  test('resolves in the statement, by name, with zero binds', () => {
    for (const q of ["g.V().hasLabel('nope')", "g.V().out('nope')", "g.E().hasLabel('nope')"]) {
      const plan = read(q);
      expect(plan.sql).toContain("FROM labels");
      expect(plan.sql).toContain("IN ('nope')");
      expect(plan.binds).toEqual([]);
    }
  });

  test('every read answers the empty set, and interns nothing', () => {
    const store = seededStore();
    const before = names(store);
    for (const q of [
      "g.V().hasLabel('nope')",
      "g.V().out('nope')",
      "g.V().in('nope')",
      "g.V().outE('nope')",
      "g.V().has('nope','name','marko')",
      "g.V().has(T.label, 'nope')",
      "g.E().hasLabel('nope')",
      "g.V().repeat(out('nope')).times(2)",
      "g.V().union(inE('nope'), outE('nope'))",
    ]) expect(run(store, q)).toEqual([]);
    expect(names(store)).toEqual(before);
  });

  test('composes at depth as the empty set', () => {
    const store = seededStore();
    const v = (q: string) => bare(run(store, q)).map((r: { v: unknown }) => r.v);
    expect(v("g.V().local(out('nope').count())")).toEqual([0, 0, 0, 0, 0, 0]);
    expect(v("g.V().where(outE('nope')).count()")).toEqual([0]);
    expect(v("g.V().not(hasLabel('nope')).count()")).toEqual([6]);
    expect(v("g.V().optional(out('nope')).count()")).toEqual([6]);
    expect(v("g.V().both('nope','knows').count()")).toEqual([4]);
    expect(v("g.V().coalesce(out('nope'), constant('x')).dedup()")).toEqual(['x']);
  });

  test('dropLabel of an unknown label is a no-op', () => {
    const store = seededStore();
    const labelsOf = () => bare(run(store, "g.V().order().by(id).label()")).map((r: { v: unknown }) => r.v);
    const before = labelsOf();
    expect(run(store, "g.V().dropLabel('nope')")).toHaveLength(6);
    expect(labelsOf()).toEqual(before);
    expect(names(store)).not.toContain('nope');
  });
});
