// A creation's COMPUTED label resolves PER TRAVERSER — `addV(<traversal>)`, `addE(<traversal>)` —
// through the creation's parameter site (`parameterSite`) and the one runtime-name resolver
// (`runtimeNameRows`) that a runtime property key also uses (`src/compiler/rel/write.ts`).
//
// The reference resolves the label against the traverser the creation consumes
// (`TraversalUtil.apply(traverser, label)`, `AddVertexStep.map`,
// `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/AddVertexStep.java:140-182`).
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { ValueParseError } from '../../src/gremlin/coerce.ts';
import { RaisedByQuery } from '../../src/rel/raise.ts';
import { bagOf, run, seededStore } from '../support/harness.ts';

const values = (rows: readonly any[]): unknown[] => rows.map((row) => row.v);
const labelsOf = (q: string): unknown[] => bagOf(values(run(seededStore(), q)) as string[]);

describe('a computed creation label, per traverser', () => {
  test('each traverser gets its own label, at depth', () => {
    for (const [q, want] of [
      ["g.V().hasLabel('person').addV(__.values('name')).label()", ['josh', 'marko', 'peter', 'vadas']],
      // after as()/select(), several traversers
      ["g.V().as('a').out('created').addV(__.select('a').values('name')).label()", ['josh', 'josh', 'marko', 'peter']],
      // after a repeat body and a where() filter
      ["g.V(1).repeat(__.out()).times(1).addV(__.values('name')).label()", ['josh', 'lop', 'vadas']],
      ["g.V().where(__.out('created')).addV(__.values('name')).label()", ['josh', 'marko', 'peter']],
      // a branch INSIDE the label body
      ["g.V().addV(__.coalesce(__.values('lang'), __.constant('none'))).label()", ['java', 'java', 'none', 'none', 'none', 'none']],
      // the edge host, implicit from()
      ["g.V().addE(__.label()).to(__.V(2)).label()", ['person', 'person', 'person', 'person', 'software', 'software']],
      // a second write after aliases — the seeder chain
      ["g.V(1).as('a').addV('x').as('b').addE(__.select('a').label()).from('a').to('b').label()", ['person']],
      ["g.V().addV(__.values('name')).as('n').addE(__.select('n').label()).to(__.V(1)).label()", ['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']],
    ] as const) expect(labelsOf(q), q).toEqual([...want]);
  });

  test('a body that re-sources answers over a scalar stream and the source, without a sequential refusal', () => {
    // Every label resolves against the pre-write snapshot (matrix §17 "Write visibility"), so several
    // traversers reading the graph is not a refusal — that would be a decline on data size.
    expect(labelsOf("g.V().hasLabel('person').addV(__.V().has('name','marko').label()).label()")).toEqual(['person', 'person', 'person', 'person']);
    expect(labelsOf("g.inject('a','b').addV(__.V(1).label()).label()")).toEqual(['person', 'person']);
    // the ROOTED instance of the same route
    expect(labelsOf("g.addV(__.V().has('name','marko').label()).label()")).toEqual(['person']);
    expect(labelsOf("g.V().hasLabel('software').addE(__.V(1).label()).to(__.V(2)).label()")).toEqual(['person', 'person']);
  });

  test('the first result is the label; several results are not a refusal', () => {
    // marko's first out() neighbour by edge order is vadas (`TraversalUtil.apply` is `next()`).
    expect(labelsOf("g.V(1).addV(__.out().values('name')).label()")).toEqual(['vadas']);
    expect(labelsOf("g.V(1).addV(__.union(__.values('name'), __.constant('z'))).label()")).toEqual(['marko']);
  });

  test('a label collection resolves each member and keeps a SET per traverser', () => {
    const store = seededStore();
    expect(bagOf(values(run(store, "g.V().hasLabel('person').addV(__.values('name'), __.label(), __.constant('person')).labels()")) as string[]))
      .toEqual(['josh', 'marko', 'person', 'person', 'person', 'person', 'peter', 'vadas']);
    // each new vertex carries exactly its traverser's two distinct labels
    expect(values(run(store, "g.V().hasLabel('marko').labels().fold().count(local)"))).toEqual([2]);
  });

  test('the reference refusals, before anything is written', () => {
    for (const [q, message] of [
      ["g.V(1).addV(__.values('age'))", 'Label traversal must produce a String, but got 29'],
      ["g.addV(__.V(1).values('age'))", 'Label traversal must produce a String, but got 29'],
      ["g.V().addV(__.values('lang'))", 'The provided traverser does not map to a value'],
      ["g.V(1).addV(__.constant(null).fold().unfold())", 'Label can not be null'],
      ["g.addV('x').property('n','').addV(__.values('n'))", 'Label can not be empty'],
      ["g.addV('x').property('n','~h').addV(__.values('n'))", 'Label can not be a hidden key: ~h'],
      ["g.V(1).addV(__.values('age'), __.constant('x'))", 'Label traversal must produce a String, but got 29'],
    ] as const) {
      const store = seededStore();
      expect(() => run(store, q), q).toThrow(RaisedByQuery);
      expect(() => run(store, q), q).toThrow(message);
      expect(values(run(store, 'g.V().count()')), q).toEqual([6]);
    }
  });

  test('an invalid CONSTANT label is a compile-time error, not a decline', () => {
    for (const [q, message] of [
      ["g.addV('')", 'Label can not be empty'],
      ["g.addV(__.constant(''))", 'Label can not be empty'],
      ["g.addE('').from(__.V(1)).to(__.V(2))", 'Label can not be empty'],
      ["g.addV('~x')", 'Label can not be a hidden key: ~x'],
      // a folded constant member is judged at compile time, beside a body too
      ["g.V(1).addV(__.constant(null), __.constant('x'))", 'Label traversal must not produce null'],
      ["g.V(1).addV(__.values('name'), __.constant(null))", 'Label traversal must not produce null'],
      ["g.addV(__.constant(['a','b']), __.constant('c'))", 'must produce a scalar String when multiple traversals are provided'],
      ["g.V(1).addV(__.values('name').fold(), __.constant('x'))", 'must produce a scalar String when multiple traversals are provided'],
    ] as const) {
      expect(() => compile(q, {}), q).toThrow(ValueParseError);
      expect(() => compile(q, {}), q).toThrow(message);
    }
  });
});

// `addLabel(<traversal>…)` — the same resolver over the snapshot the step mutates, under
// `TraversalUtil.resolveStringArguments`' sentences
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java:211-236`).
describe('a computed addLabel(), per traverser', () => {
  test('each vertex gets its own traverser\'s label', () => {
    const store = seededStore();
    run(store, "g.V().hasLabel('person').addLabel(__.values('name'), __.constant('x')).iterate()");
    for (const name of ['marko', 'vadas', 'josh', 'peter'])
      expect(bagOf(values(run(store, `g.V().has('name','${name}').labels()`)) as string[]), name).toEqual(bagOf([name, 'person', 'x']));
    expect(labelsOf("g.V(1).addLabel(__.values('name')).labels()")).toEqual(['marko', 'person']);
    // after as()/select(): lop is reached by three traversers and carries each one's name
    const aliased = seededStore();
    run(aliased, "g.V().as('a').out('created').addLabel(__.select('a').values('name')).iterate()");
    expect(bagOf(values(run(aliased, "g.V().has('name','lop').labels()")) as string[])).toEqual(['josh', 'marko', 'peter', 'software']);
    // a re-sourcing body over several traversers is not a refusal
    expect(labelsOf("g.V().hasLabel('software').addLabel(__.V(1).values('name')).labels()")).toEqual(['marko', 'marko', 'software', 'software']);
  });

  test('the reference refusals', () => {
    for (const [q, message] of [
      ["g.V(1).addLabel(__.values('age'))", 'Traversal argument must produce a String or Collection<String>, but got: 29'],
      ["g.V(1).addLabel(__.values('nope'))", 'The provided traverser does not map to a value'],
      ["g.V(1).addLabel(__.constant(null).fold().unfold())", 'Traversal argument must not produce null'],
    ] as const) {
      const store = seededStore();
      expect(() => run(store, q), q).toThrow(RaisedByQuery);
      expect(() => run(store, q), q).toThrow(message);
      expect(values(run(store, 'g.V(1).labels()')), q).toEqual(['person']);
    }
    // SOME traversers absent among several still raises, and NOTHING is written — the guard's
    // correlation re-reads the snapshot it ranges over (`shadowsOuter`, `src/rel/emit.ts`); fused, it
    // was a tautology and labelled only the traversers that had a value.
    for (const q of [
      "g.V().addLabel(__.values('lang')).count()",
      "g.V(1,3).addLabel(__.values('lang')).labels()",
      "g.V().hasLabel('person').addLabel(__.out('knows').values('name')).iterate()",
      "g.V(1).out().in().addLabel(__.out('knows').values('name')).count()",
      "g.V(1,3).addV(__.values('lang')).label()",
    ]) {
      const store = seededStore();
      expect(() => run(store, q), q).toThrow('The provided traverser does not map to a value');
      expect(bagOf(values(run(store, 'g.V().labels()')) as string[]), q).toEqual(bagOf(['person', 'person', 'person', 'person', 'software', 'software']));
      expect(values(run(store, 'g.V().count()')), q).toEqual([6]);
    }
    // ...while every traverser present answers: `out().in()` revisits marko, each `created` a value.
    expect(values(run(seededStore(), "g.V(1).out().in().addLabel(__.out('created').values('name')).count()"))).toEqual([5]);
    for (const [q, message] of [
      ["g.V(1).addLabel('')", 'Label can not be empty'],
      ["g.V(1).addLabel(__.values('name').fold(), __.constant('x'))", 'must produce a scalar String when multiple traversals are provided'],
    ] as const) expect(() => compile(q, {}), q).toThrow(message);
  });
});

// A CONSTANT label — a literal, `constant(…)`, a `withSideEffect` constant — is judged at compile time by
// the one `constantName`, under the same rules a resolved name is guarded by at run time, and with the
// TYPE the text states: a uuid, a datetime or a big decimal is not a String even where JS carries it as
// one. Every refusal leaves the graph untouched (`labels()` / `count()` after the raise).
describe('a constant label is judged like a resolved one', () => {
  const UUID = "UUID('8f7c2b0a-6e1d-4c3b-9a5f-2d4e6f8a0b1c')";
  const refuses = (q: string, message: string, after: string, want: unknown[]): void => {
    const store = seededStore();
    expect(() => run(store, q), q).toThrow(ValueParseError);
    expect(() => run(store, q), q).toThrow(message);
    expect(bagOf(values(run(store, after)) as string[]), q).toEqual(bagOf(want as string[]));
  };

  test('addLabel refuses a constant the reference refuses, and writes nothing', () => {
    const notString = 'Traversal argument must produce a String or Collection<String>, but got: ';
    for (const [q, message] of [
      ['g.V(1).addLabel(__.constant(null))', 'Traversal argument must not produce null'],
      ['g.V(1).addLabel(__.constant(5))', `${notString}5`],
      [`g.V(1).addLabel(__.constant(${UUID}))`, `${notString}8f7c2b0a-6e1d-4c3b-9a5f-2d4e6f8a0b1c`],
      ["g.V(1).addLabel(__.constant(datetime('2020-01-01T00:00:00Z')))", notString],
      ['g.V(1).addLabel(__.constant(1.5m))', `${notString}1.5`],
      ["g.withSideEffect('k', 5).V(1).addLabel(__.select('k'))", `${notString}5`],
      // an item of the sole collection — `resolveStringArguments`' Collection arm
      ["g.V(1).addLabel(__.constant(['a', 5]))", 'Traversal argument Collection must contain only Strings, but got: 5'],
      ["g.V(1).addLabel(__.constant(['a', null]))", 'Traversal argument Collection must contain only Strings, but got: null'],
      [`g.V(1).addLabel(__.constant(['a', ${UUID}]))`, 'Traversal argument Collection must contain only Strings'],
      ["g.V(1).addLabel(__.constant(''))", 'Label can not be empty'],
      // beside a per-traverser body, and at depth
      ["g.V(1).addLabel(__.values('lang'), __.constant(null))", 'Traversal argument must not produce null'],
      [`g.V(1).addLabel(__.values('name'), __.constant(${UUID}))`, notString],
      ['g.V(1).local(__.addLabel(__.constant(5)))', `${notString}5`],
      [`g.V(1).union(__.addLabel(__.constant(${UUID})))`, notString],
      ['g.V(1).choose(__.constant(true), __.addLabel(__.constant(null)))', 'Traversal argument must not produce null'],
    ] as const) refuses(q, message, 'g.V(1).labels()', ['person']);
  });

  test('a creation refuses a typed non-String constant label, and creates nothing', () => {
    for (const [q, message] of [
      [`g.addV(__.constant(${UUID}))`, 'Label traversal must produce a String, but got 8f7c2b0a-6e1d-4c3b-9a5f-2d4e6f8a0b1c'],
      ['g.addV(__.constant(null))', 'Label can not be null'],
      ["g.withSideEffect('k', 5).addV(__.select('k'))", 'Label traversal must produce a String, but got 5'],
      [`g.V(1).addV(__.values('name'), __.constant(${UUID}))`, 'Label traversal must produce a String'],
      // a sole label list reaches the graph as a `T.label` collection (`ElementHelper.getLabelsValue`)
      [`g.addV(__.constant(['a', ${UUID}]))`, 'T.label collection must contain only Strings'],
      ["g.addV(__.constant(['a', 5]))", 'T.label collection must contain only Strings'],
    ] as const) refuses(q, message, 'g.V().count()', [6]);
    refuses(`g.V(1).addE(__.constant(${UUID})).to(__.V(2))`, 'Label traversal must produce a String', 'g.E().count()', [6]);
  });

  test('a String constant still writes', () => {
    expect(labelsOf("g.V(1).addLabel(__.constant(['a','b'])).labels()")).toEqual(['a', 'b', 'person']);
    expect(labelsOf("g.V(1).addLabel(__.constant('q'), __.values('name')).labels()")).toEqual(['marko', 'person', 'q']);
    expect(labelsOf("g.withSideEffect('k', 'w').V(1).addLabel(__.select('k')).labels()")).toEqual(['person', 'w']);
    expect(labelsOf("g.addV(__.constant(['a','b'])).labels()")).toEqual(['a', 'b']);
  });

  test('an all-constant addLabel is the constant statement, whatever spelling it takes', () => {
    const sqlOf = (q: string): string => JSON.stringify(compile(q, {}));
    expect(sqlOf("g.V(1).addLabel(__.constant('a'), __.constant('b'))")).toBe(sqlOf("g.V(1).addLabel('a','b')"));
    expect(sqlOf("g.V(1).addLabel(__.constant(['a','b']))")).toBe(sqlOf("g.V(1).addLabel('a','b')"));
  });

  test('a refusal names a list or map by its JSON and a datetime by its ISO text', () => {
    const notString = 'Traversal argument must produce a String or Collection<String>, but got: ';
    for (const [q, message] of [
      ["g.V(1).addLabel(__.constant([['a']]))", 'Traversal argument Collection must contain only Strings, but got: ["a"]'],
      ['g.V(1).addLabel(__.constant([a:1]))', `${notString}{"a":1}`],
      ["g.V(1).addLabel(__.constant(datetime('2020-01-01T00:00:00Z')))", `${notString}2020-01-01T00:00:00.000Z`],
    ] as const) refuses(q, message, 'g.V(1).labels()', ['person']);
  });
});

// EVERY host of a constant name goes through the one judge (`constantName`, `src/gremlin/validate.ts`):
// a merge map's literal `T.label` (under `MergeElementStep.validate`'s own sentences,
// `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MergeElementStep.java:258-300`),
// `dropLabel(<traversal>)` (`resolveStringArguments` without `validateLabel`, `DropLabelsStep.java:98-103`), a
// TYPED `withSideEffect` constant, and a constant property KEY. Each used to write the wrong element, drop the
// wrong label, silently do nothing, or decline.
describe('every constant-name host is judged, typed', () => {
  const UUID = "UUID('8f7c2b0a-6e1d-4c3b-9a5f-2d4e6f8a0b1c')";
  const UUID_TEXT = '8f7c2b0a-6e1d-4c3b-9a5f-2d4e6f8a0b1c';
  const PERSON_LABELS = ['person', 'person', 'person', 'person', 'software', 'software'];
  const refuses = (q: string, message: string, after: string, want: unknown[]): void => {
    const store = seededStore();
    expect(() => run(store, q), q).toThrow(ValueParseError);
    expect(() => run(store, q), q).toThrow(message);
    expect(bagOf(values(run(store, after)) as string[]), q).toEqual(bagOf(want as string[]));
  };

  test("a merge map's non-String T.label raises the reference's sentence, and nothing is written", () => {
    const mergeV = 'mergeV() and option(onCreate) args expect T.label value to be String or Collection<String> - found: ';
    const onMatch = 'option(onMatch) expects T.label value to be String or Collection<String> - found: ';
    for (const [q, message] of [
      ['g.mergeV([(T.label): 5])', `${mergeV}5`],
      [`g.mergeV([(T.label): ${UUID}])`, `${mergeV}${UUID_TEXT}`],
      ["g.mergeV([(T.label): ['a', 5]])", 'mergeV() expects T.label collection to contain only Strings - found: 5'],
      ["g.mergeV([(T.label): ['a', null]])", 'mergeV() expects T.label collection to contain only Strings - found: null'],
      ["g.mergeV([name: 'zz']).option(Merge.onCreate, [(T.label): 5])", `${mergeV}5`],
      ["g.mergeV([name: 'marko']).option(Merge.onMatch, [(T.label): 5])", `${onMatch}5`],
      ["g.mergeV([name: 'marko']).option(Merge.onMatch, [(T.label): ['a', 5]])", 'option(onMatch) expects T.label collection to contain only Strings - found: 5'],
      ["g.mergeV([(T.label): ''])", 'Label can not be empty'],
      // at depth, and over a driver
      ['g.inject(1).mergeV([(T.label): 5])', `${mergeV}5`],
      // a side-effect map constant carries its declared types into the merge
      [`g.withSideEffect('m', [(T.label): ${UUID}]).mergeV(__.select('m'))`, `${mergeV}${UUID_TEXT}`],
    ] as const) refuses(q, message, 'g.V().labels()', PERSON_LABELS);
    for (const label of ['5', UUID] as const)
      refuses(`g.mergeE([(T.label): ${label}, (Direction.from): 1, (Direction.to): 2])`,
        'mergeE() and option(onCreate) args expect T.label value to be String or Collection<String> - found: ', 'g.E().count()', [6]);
  });

  test('a String merge label still writes, whatever key order the map takes', () => {
    // The map's per-key types are filed under the token's own slot (`mapSlot`), so `T.label` no longer shares
    // a slot with `Direction.from`/`to` and reads their `int`.
    expect(labelsOf("g.mergeE([(T.label): 'zz', (Direction.from): 1, (Direction.to): 3]).label()")).toEqual(['zz']);
    expect(labelsOf("g.mergeE([(Direction.from): 1, (Direction.to): 3, (T.label): 'zz']).label()")).toEqual(['zz']);
    expect(labelsOf("g.mergeV([(T.label): ['a','b'], name: 'x']).labels()")).toEqual(['a', 'b']);
    expect(labelsOf("g.mergeV([name: 'marko']).option(Merge.onMatch, [(T.label): ['a','b']]).labels()")).toEqual(['a', 'b', 'person']);
    expect(labelsOf("g.withSideEffect('m', [(T.label): 'q', name: 'z']).mergeV(__.select('m')).labels()")).toEqual(['q']);
  });

  test("a token key and a String key that spells it keep their own types (`mapSlot` is injective)", () => {
    // A user property literally named 'T.label' / 'Direction.from' beside the token key: each entry keeps
    // the type the text gave it, in either key order — never the token's `string`, never a decline.
    for (const q of [
      "g.mergeV(['T.label': 5, (T.label): 'zz']).values('T.label')",
      "g.mergeV([(T.label): 'zz', 'T.label': 5]).values('T.label')",
    ]) expect(run(seededStore(), q), q).toEqual([{ v: 5, vtype: 'int' }]);
    expect(values(run(seededStore(), "g.mergeV(['T.label': 5L, (T.label): 'zz']).values('T.label').math('_ / 2')"))).toEqual([2.5]);
    expect(labelsOf("g.mergeV([(T.label): 'zz', 'T.label': 5]).label()")).toEqual(['zz']);
    expect(run(seededStore(), "g.mergeE([(T.label): 'kk', 'Direction.from': 5, (Direction.from): 1, (Direction.to): 2]).values('Direction.from')"))
      .toEqual([{ v: 5, vtype: 'int' }]);
    // an Integer key and the String that spells it are two keys of one map, each typed
    expect(run(seededStore(), "g.V(1).property('m', [1: 'a', '1': 'b']).values('m')").map((r) => JSON.parse(r.v)))
      .toEqual([[[{ t: 'int', v: 1 }, { t: 'string', v: 'a' }], [{ t: 'string', v: '1' }, { t: 'string', v: 'b' }]]]);
  });

  test('dropLabel(<traversal>) refuses what resolveStringArguments refuses, before anything is dropped', () => {
    const notString = 'Traversal argument must produce a String or Collection<String>, but got: ';
    for (const [q, message] of [
      ["g.V(1).dropLabel(__.constant(['person', 5])).label()", 'Traversal argument Collection must contain only Strings, but got: 5'],
      ["g.V(1).dropLabel(__.constant('person'), __.constant(5)).label()", `${notString}5`],
      ['g.V(1).dropLabel(__.constant(null))', 'Traversal argument must not produce null'],
      [`g.V(1).dropLabel(__.constant(${UUID}))`, `${notString}${UUID_TEXT}`],
      ["g.V(1).dropLabel(__.constant(['person']), __.constant('x'))", 'must produce a scalar String when multiple traversals are provided'],
      // at depth, and through a side-effect constant
      ['g.V(1).local(__.dropLabel(__.constant(5)))', `${notString}5`],
      [`g.withSideEffect('k', ['person', ${UUID}]).V(1).dropLabel(__.select('k'))`, 'Traversal argument Collection must contain only Strings'],
    ] as const) refuses(q, message, 'g.V(1).labels()', ['person']);
  });

  test('dropLabel does not judge a name as an identifier: an empty one matches nothing', () => {
    expect(labelsOf("g.V(1).dropLabel(__.constant('')).labels()")).toEqual(['person']);
    expect(labelsOf("g.V(1).dropLabel(__.constant(['person'])).labels()")).toEqual([]);
    expect(labelsOf("g.withSideEffect('k', 'person').V(1).dropLabel(__.select('k')).labels()")).toEqual([]);
  });

  test('a typed withSideEffect constant keeps its type at every label host', () => {
    refuses(`g.withSideEffect('k', ${UUID}).addV(__.select('k'))`, `Label traversal must produce a String, but got ${UUID_TEXT}`, 'g.V().count()', [6]);
    refuses(`g.withSideEffect('k', ['a', ${UUID}]).V(1).addLabel(__.select('k'))`,
      `Traversal argument Collection must contain only Strings, but got: ${UUID_TEXT}`, 'g.V(1).labels()', ['person']);
    // ...and as a property VALUE, it is stored as the type it was declared with
    expect(run(seededStore(), `g.withSideEffect('k', ${UUID}).V(1).property('u', __.select('k')).values('u')`))
      .toEqual([{ v: UUID_TEXT, vtype: 'uuid' }]);
  });

  test("a constant property KEY raises the key's sentence rather than declining", () => {
    for (const [q, message] of [
      ['g.V(1).property(__.constant(5), 1)', 'The provided key/value array must have a String or T on even array indices'],
      [`g.V(1).property(__.constant(${UUID}), 1)`, 'The provided key/value array must have a String or T on even array indices'],
      ['g.V(1).property(__.constant(null), 1)', 'Property key can not be null'],
      ["g.V(1).property(__.constant(''), 1)", 'Property key can not be the empty string'],
      ["g.withSideEffect('k', 5).V(1).property(__.select('k'), 1)", 'The provided key/value array must have a String or T on even array indices'],
    ] as const) refuses(q, message, 'g.V(1).properties().count()', [2]);
    expect(values(run(seededStore(), "g.V(1).property(__.constant('x'), 1).values('x')"))).toEqual([1]);
  });

  test('a constant is judged at compile time, even over a stream that turns out empty (§17 "Error timing")', () => {
    for (const q of ['g.V().limit(0).dropLabel(__.constant(5))', 'g.V().limit(0).addLabel(__.constant(5))', 'g.V().limit(0).property(__.constant(5), 1)'])
      expect(() => compile(q, {}), q).toThrow(ValueParseError);
  });
});

describe('a Set constant is a Collection at every label host (one `collectionMembers`)', () => {
  // `resolveStringArguments` takes ANY `Collection` (`TraversalUtil.java:211-236`), as `getLabelsValue` and
  // `MergeElementStep.validate` do: a `{…}` literal is a Set, and a Set is not a non-String.
  test('dropLabel / addLabel / addV / a merge label take a Set exactly as a List', () => {
    expect(labelsOf("g.V(1).dropLabel(__.constant({'person'})).labels()")).toEqual([]);
    expect(labelsOf("g.withSideEffect('k', {'person'}).V(1).dropLabel(__.select('k')).labels()")).toEqual([]);
    expect(labelsOf("g.V(1).addLabel(__.constant({'x'})).labels()")).toEqual(['person', 'x']);
    expect(labelsOf("g.withSideEffect('k', {'q', 'r'}).V(1).addLabel(__.select('k')).labels()")).toEqual(['person', 'q', 'r']);
    expect(labelsOf("g.V(1).union(__.addLabel(__.constant({'x'}))).labels()")).toEqual(['person', 'x']);
    expect(labelsOf("g.addV(__.constant({'a', 'b'})).labels()")).toEqual(['a', 'b']);
    expect(labelsOf("g.mergeV([(T.label): {'a', 'b'}]).labels()")).toEqual(['a', 'b']);
  });

  test("a Set's members are judged under the Collection arm's sentences", () => {
    const store = seededStore();
    for (const [q, message] of [
      ["g.V(1).addLabel(__.constant({'x', 5}))", 'Traversal argument Collection must contain only Strings, but got: 5'],
      ["g.V(1).dropLabel(__.constant({'person'}), __.constant('x'))", 'must produce a scalar String when multiple traversals are provided'],
      ["g.mergeV([(T.label): {'a', 5}])", 'mergeV() expects T.label collection to contain only Strings - found: 5'],
    ] as const) expect(() => run(store, q), q).toThrow(message);
    expect(bagOf(values(run(store, 'g.V(1).labels()')) as string[])).toEqual(['person']);
  });
});

describe('a whole-arg merge select(k) folds to the side effect only where the traverser cannot be a Map', () => {
  // `Scoping.getScopeValue` (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135`)
  // reads the traverser's own Map entry FIRST, then the side effect. So the fold is exact over an element,
  // a scalar or the start — and is no answer at all over a Map, whose own `k` only the run decides.
  const BAD = "g.withSideEffect('k', [(T.label): 5])";
  const sentence = 'mergeV() and option(onCreate) args expect T.label value to be String or Collection<String> - found: 5';
  const notTheSideEffect = (q: string): void => {
    try { run(seededStore(), q); } catch (e) { expect(e, q).not.toBeInstanceOf(ValueParseError); }
  };

  test('over a traverser that may be a Map, the side effect is never judged in its place', () => {
    notTheSideEffect(`${BAD}.V(1).project('k').by(__.constant([name: 'marko'])).mergeV(__.select('k'))`);
    notTheSideEffect(`${BAD}.V(1).project('k').by(__.constant([name: 'marko'])).mergeV(__.constant([name: 'marko'])).option(Merge.onMatch, __.select('k'))`);
    notTheSideEffect(`${BAD}.inject([k: [name: 'marko']]).mergeV(__.select('k'))`);
    notTheSideEffect(`${BAD}.V(1).project('k').by(__.constant([name: 'marko'])).mergeE(__.select('k'))`);
  });

  test('over the start, an element, a scalar or a child of an element, the side effect IS the answer', () => {
    for (const q of [
      `${BAD}.mergeV(__.select('k'))`,
      `${BAD}.V(1).mergeV(__.select('k'))`,
      `${BAD}.V(1).out().mergeV(__.select('k'))`,
      `${BAD}.inject(1).mergeV(__.select('k'))`,
      `${BAD}.V(1).local(__.mergeV(__.select('k')))`,
    ]) expect(() => run(seededStore(), q), q).toThrow(sentence);
    expect(values(run(seededStore(), "g.withSideEffect('k', [name: 'zz']).inject(1).mergeV(__.select('k')).values('name')"))).toEqual(['zz']);
    expect(values(run(seededStore(), "g.withSideEffect('k', [name: 'zz']).V(1).union(__.mergeV(__.select('k'))).values('name')"))).toEqual(['zz']);
    expect(labelsOf("g.withSideEffect('k', [(T.label): 'person', name: 'marko']).V(1).mergeV(__.select('k')).labels()")).toEqual(['person']);
  });

  test('a withSideEffect constant keeps the number class its text states (3.0d is a Double)', () => {
    expect(run(seededStore(), "g.withSideEffect('k', 3.0d).V(1).property('d', __.select('k')).values('d')")).toEqual([{ v: 3, vtype: 'double' }]);
  });
});
