// The NAME DICTIONARY authority (`src/compiler/rel/names.ts`): every label read filters `labels` by name
// (`nameIds`), every label write upserts its names (`internNames`). These pin the behaviour each caller
// relies on: an unknown name is an empty set, an interned name is reused, and a name resolves inside
// the statement — an inline label spends no bind, a parameter spends exactly one.
import { test, expect, describe } from 'bun:test';
import { bagOf, bare, read, run, seededStore } from '../support/harness.ts';

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

  // `labelOwners` is ONE (owner, label) relation for both kinds, so every label read composes the same
  // way under a connector host as at the root, for a vertex and for an edge.
  test('label reads compose at depth for both element kinds', () => {
    const store = seededStore();
    expect(values(run(store, "g.V().where(label().is('person')).count()"))).toEqual([4]);
    expect(values(run(store, "g.V().local(outE().has(T.label, TextP.startingWith('k')).count()).sum()"))).toEqual([2]);
    expect(values(run(store, "g.V().where(outE().has(T.label, eq('created'))).count()"))).toEqual([3]);
    expect(values(run(store, "g.V().not(has(T.label, TextP.containing('f'))).count()"))).toEqual([4]);
    expect(bagOf(values(run(store, "g.V().hasLabel('person').local(outE().label().fold()).unfold()")))).toEqual(bagOf(['knows', 'knows', 'created', 'created', 'created', 'created']));
    expect(values(run(store, "g.E().order().by(T.label).label().dedup()"))).toEqual(['created', 'knows']);
    expect(values(run(store, "g.V().order().by(T.label).values('name')")).slice(4).sort()).toEqual(['lop', 'ripple']);
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

  // `nameId` is NULL for a never-interned name, so it is safe only in a positive `=`: the search's
  // `clabel = nameId('nope')` is NULL for every candidate, so none matches and the arm creates.
  test('a mergeE with an unknown label between linked endpoints matches nothing and creates one edge', () => {
    const store = seededStore();
    expect(values(run(store, "g.inject([(T.label):'nope',(Direction.OUT):1,(Direction.IN):2]).mergeE().count()"))).toEqual([1]);
    expect(values(run(store, 'g.E().count()'))).toEqual([7]);
    expect(values(run(store, "g.V(1).outE('nope').inV().id()"))).toEqual([2]);
  });

  test('a per-vertex mergeE self-loop resolves its constant label once per driver', () => {
    const store = seededStore();
    const q = "g.V().as('d').mergeE([(T.label):'self',(Direction.from):Merge.outV,(Direction.to):Merge.inV]).option(Merge.outV,__.select('d')).option(Merge.inV,__.select('d')).count()";
    expect(values(run(store, q))).toEqual([6]);
    expect(values(run(store, q))).toEqual([6]);
    expect(values(run(store, "g.E().hasLabel('self').count()"))).toEqual([6]);
  });

  // A non-string label is its SQLite TEXT, a deliberate divergence (`docs/limitations.md` §3): the reference
  // raises. On an edge it is one name too, so a re-merge finds the edge it created.
  test('a mergeE map label that is not a string is one name, found again by the re-merge', () => {
    const store = seededStore();
    const q = 'g.inject([(T.label):5,(Direction.OUT):1,(Direction.IN):2]).mergeE().id()';
    const first = values(run(store, q));
    expect(values(run(store, q))).toEqual(first);
    expect(values(run(store, "g.E().hasLabel('5').count()"))).toEqual([1]);
  });

  // A null `T`/`Direction` value refuses with the constant path's sentence (`validateMergeKey`), so a
  // null label never reads as "names no label" and merges onto an unrelated element.
  test('a null T.label or endpoint in a merge map refuses, as the constant path does, and writes nothing', () => {
    const store = seededStore();
    expect(() => run(store, 'g.inject([(T.label):null,(Direction.OUT):1,(Direction.IN):2]).mergeE()'))
      .toThrow('mergeE() does not allow null Map values - check: label');
    expect(() => run(store, "g.inject([(T.label):null,name:'zz']).mergeV()"))
      .toThrow('mergeV() does not allow null Map values - check: label');
    expect(() => run(store, "g.inject([(T.label):'person',name:'marko'],[(T.label):null,name:'q']).mergeV()"))
      .toThrow('mergeV() does not allow null Map values - check: label');
    expect(() => run(store, "g.inject([(Direction.OUT):null,(T.label):'knows',(Direction.IN):2]).mergeE()"))
      .toThrow('mergeE() does not allow null Map values - check: OUT');
    expect(() => run(store, "g.inject([(T.label):'knows',(Direction.OUT):1,(Direction.IN):null]).mergeE()"))
      .toThrow('mergeE() does not allow null Map values - check: IN');
    expect(() => run(store, "g.inject(1).constant([(T.label):null,name:'z']).mergeV()"))
      .toThrow('mergeV() does not allow null Map values - check: label');
    expect(values(run(store, 'g.E().count()'))).toEqual([6]);
    expect(values(run(store, 'g.V().count()'))).toEqual([6]);
    expect(values(run(store, "g.inject([(T.label):'person',name:'marko'],[(T.label):'person',name:'new']).mergeV().count()"))).toEqual([2]);
    expect(values(run(store, 'g.V().count()'))).toEqual([7]);
  });

  // Under ZERO_OR_MORE a map with no T.label creates a vertex with NO label, which no label matches — not
  // even 'vertex' (TinkerGraph's `Vertex.DEFAULT_LABEL`; `docs/limitations.md` §3).
  test('a labelless map creates a labelless vertex, which a vertex-labelled map does not find', () => {
    const store = seededStore();
    expect(bagOf(values(run(store, "g.inject([name:'x'],[(T.label):'vertex',name:'x']).mergeV().label()")))).toEqual(bagOf([null, 'vertex']));
    expect(values(run(store, "g.V().has('name','x').count()"))).toEqual([2]);
    expect(values(run(store, "g.V().hasLabel('vertex').count()"))).toEqual([1]);
    // The other order: the later labelless map WOULD find the earlier creation, which is the interleaving
    // decline, not a wrong count.
    const fresh = seededStore();
    expect(() => run(fresh, "g.inject([(T.label):'vertex',name:'x'],[name:'x']).mergeV()")).toThrow('one traverser at a time');
    expect(values(run(fresh, "g.V().has('name','x').count()"))).toEqual([0]);
  });
});
