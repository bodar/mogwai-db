// The NAME DICTIONARY authority (`src/compiler/rel/names.ts`): every label read filters `labels` by name
// (`nameIds`), every label write upserts its names (`internNames`). These pin the behaviour each caller
// relies on: an unknown name is an empty set, an interned name is reused, and a name resolves inside
// the statement — an inline label spends no bind, a parameter spends exactly one.
import { test, expect, describe } from 'bun:test';
import { bare, read, run, seededStore } from '../support/harness.ts';

const values = (rows: readonly unknown[]): unknown[] => bare(rows).map((row: { v: unknown }) => row.v);

describe('nameIds — a name set as label ids', () => {
  test('an inline label spends no bind; a scalar and a list parameter spend one each', () => {
    expect(read("g.V().hasLabel('person')").binds).toHaveLength(0);
    expect(read('g.V().hasLabel(l)', undefined, { l: 'person' }).binds).toHaveLength(1);
    const listed = read('g.V().hasLabel(ls)', undefined, { ls: ['person', 'software', 'x'] });
    expect(listed.binds).toHaveLength(1);
    expect(listed.sql).toContain('json_each(jsonb(?');
  });

  test('a name that was never interned matches nothing, and dropping it is a no-op', () => {
    const store = seededStore();
    expect(values(run(store, "g.V().hasLabel('nope').count()"))).toEqual([0]);
    expect(values(run(store, "g.V().dropLabel('nope').count()"))).toEqual([6]);
    expect(values(run(store, "g.V().hasLabel('person').count()"))).toEqual([4]);
  });

  test('dropLabel removes exactly the named label, read back through the same dictionary', () => {
    const store = seededStore();
    expect(values(run(store, "g.V().dropLabel('person').count()"))).toEqual([6]);
    expect(values(run(store, "g.V().hasLabel('person').count()"))).toEqual([0]);
    expect(values(run(store, "g.V().hasLabel('software').count()"))).toEqual([2]);
  });
});

describe('internNames — a creation upserts its names once', () => {
  test('a constant and a per-traverser label both resolve to the interned name', () => {
    const store = seededStore();
    expect(values(run(store, "g.addV('a').addV(__.constant('b')).label()"))).toEqual(['b']);
    expect(values(run(store, "g.V().hasLabel('a', 'b').label()")).sort()).toEqual(['a', 'b']);
  });

  test('re-using an existing name writes no second dictionary row', () => {
    const store = seededStore();
    run(store, "g.addV('person').addV('person')");
    run(store, "g.V().hasLabel('software').addLabel('person')");
    expect(values(run(store, "g.V().hasLabel('person').count()"))).toEqual([8]);
    expect(store.query("SELECT count(*) AS n FROM labels WHERE name = 'person'", [])).toEqual([{ n: 1 }]);
  });
});
