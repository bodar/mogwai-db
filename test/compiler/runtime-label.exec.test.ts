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
      ["g.V(1).addV(__.constant(null), __.constant('x'))", 'Label traversal must not produce null'],
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
      ["g.addV(__.constant(['a','b']), __.constant('c'))", 'must produce a scalar String when multiple traversals are provided'],
      ["g.V(1).addV(__.values('name').fold(), __.constant('x'))", 'must produce a scalar String when multiple traversals are provided'],
    ] as const) {
      expect(() => compile(q, {}), q).toThrow(ValueParseError);
      expect(() => compile(q, {}), q).toThrow(message);
    }
  });
});
