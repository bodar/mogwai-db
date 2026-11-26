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

describe('nameOf / withNames — an id decodes to its name', () => {
  test("a vertex reads its labels in INTERNING order, so label() is the payload's labels[0]", () => {
    const store = seededStore();
    // The seed interned `person` before this write interns `zeta`, though the vertex gets `zeta` first.
    run(store, "g.addV('zeta').property('name', 'z').addLabel('person')");
    const z = "g.V().has('name', 'z')";
    expect(values(run(store, `${z}.label()`))).toEqual(['person']);
    // A bare `labels()` stream reaching the wire is unordered (L8); its fold and the payload are ordered.
    expect(values(run(store, `${z}.labels()`)).sort()).toEqual(['person', 'zeta']);
    expect(bare(run(store, z))[0].label).toBe('["person","zeta"]');
    expect(bare(run(store, `${z}.local(__.labels().fold())`))[0].list).toBe('["person","zeta"]');
  });

  test('has(T.label, P) tests P on the decoded name, at the root and after a hop', () => {
    const store = seededStore();
    expect(values(run(store, "g.V().has(T.label, TextP.startingWith('p')).count()"))).toEqual([4]);
    expect(values(run(store, "g.E().has(T.label, TextP.endingWith('ows')).label()"))).toEqual(['knows', 'knows']);
    expect(values(run(store, "g.V().out().has(T.label, TextP.containing('oft')).count()"))).toEqual([4]);
  });

  test('an edge label decodes to its name', () => {
    const store = seededStore();
    expect(values(run(store, 'g.E().label()')).sort()).toEqual(['created', 'created', 'created', 'created', 'knows', 'knows']);
  });
});

describe('nameId — one name as its id, per merge driver', () => {
  test('a merge search by label seeks the interned id; an unknown label matches nothing and creates', () => {
    const store = seededStore();
    expect(values(run(store, "g.inject([(T.label):'person']).mergeV().count()"))).toEqual([4]);
    expect(values(run(store, "g.inject([(T.label):'nope']).mergeV().label()"))).toEqual(['nope']);
    expect(values(run(store, "g.inject([(T.label):'nope']).mergeV().count()"))).toEqual([1]);
    expect(values(run(store, "g.inject([(T.label):['person','x'],name:'marko']).mergeV().label()"))).toEqual(['person']);
  });

  test('a map label that is not a string is one name, written once and found again', () => {
    const store = seededStore();
    expect(values(run(store, 'g.inject([(T.label):5,k:1]).mergeV().label()'))).toEqual(['5']);
    expect(values(run(store, 'g.inject([(T.label):5,k:1]).mergeV().count()'))).toEqual([1]);
    expect(values(run(store, "g.V().hasLabel('5').count()"))).toEqual([1]);
  });

  test('a mergeE label is interned once per name and its id joined by name', () => {
    const store = seededStore();
    const kk = "[(T.label):'kk',(Direction.OUT):1,(Direction.IN):2]";
    expect(values(run(store, `g.inject(${kk},${kk},[(T.label):'knows',(Direction.OUT):1,(Direction.IN):2]).mergeE().label()`))).toEqual(['kk', 'kk', 'knows']);
    expect(values(run(store, `g.inject(${kk}).mergeE().count()`))).toEqual([1]);
    expect(values(run(store, "g.E().hasLabel('kk').count()"))).toEqual([1]);
    expect(store.query("SELECT count(*) AS n FROM labels WHERE name IN ('kk', 'knows')", [])).toEqual([{ n: 2 }]);
  });

  test('a per-vertex mergeE self-loop resolves its constant label once per driver', () => {
    const store = seededStore();
    const q = "g.V().as('d').mergeE([(T.label):'self',(Direction.from):Merge.outV,(Direction.to):Merge.inV]).option(Merge.outV,__.select('d')).option(Merge.inV,__.select('d')).count()";
    expect(values(run(store, q))).toEqual([6]);
    expect(values(run(store, q))).toEqual([6]);
    expect(values(run(store, "g.E().hasLabel('self').count()"))).toEqual([6]);
  });
});
