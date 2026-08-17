// `by(<the host's OWN rows>.fold())` — a SELF-ROOTED collect inside a `by()` arm.
//
// `scalarChild`'s self-root arm hands a body with no leading hop to `correlatedReduce` against a one-row
// relation carrying the host id, so a barrier aggregates the host's own rows exactly as it does an
// adjacency's. `correlatedReduce` has had a per-origin FOLD arm all along (one list per host, `COALESCE`d
// to `[]` for `FoldStep`'s `ArrayListSupplier` seed) — but the gate admitting a body to the self root
// named only the numeric reducers and `count`, so nothing could reach it. The consequence was a
// reachability gap with a strange edge: `by(__.out().fold())` worked (movement-rooted) while
// `by(__.values(k).fold())` declined, though the second is the more ordinary Gremlin.
//
// Every case here asserts the `by()` arm against its CHAIN-POSITION control, because that is the claim:
// collecting a host's own rows in an arm must give what collecting them in the chain gives. The zoo graph
// is the fixture for the same reason — it is the only one with multi-label vertices AND `Cardinality.list`
// properties, so the modern graph (uniform per label, single-valued) cannot see either.
import { test, expect, describe } from 'bun:test';
import { seededStore, zooStore } from '../support/harness.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';
import type { GraphStore } from '../../src/storage.ts';

const norm = (v: any): any =>
  v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [String(k), norm(x)]))
    : v instanceof Set ? [...v].map(norm)
      : Array.isArray(v) ? v.map(norm) : v;

const rows = async (store: GraphStore, q: string): Promise<any[]> =>
  (await decodeAll(executeQuery(store, q))).map(norm);

describe('a self-rooted fold in a by() arm', () => {
  // MULTI-VALUED PROPERTY — `diet` is written with `Cardinality.list`, so `values('diet')` fans one
  // traverser into three and the fold collects them. The arm must agree with the chain.
  test('values(k).fold() collects a multi-valued property, as the chain does', async () => {
    const zoo = zooStore();
    expect(await rows(zoo, `g.V(1).project('n','d').by(__.values('name')).by(__.values('diet').fold())`))
      .toEqual([{ n: 'tux', d: ['fish', 'krill', 'squid'] }]);
    // The control: the same collect at chain position.
    expect(await rows(zoo, `g.V(1).values('diet').fold()`)).toEqual([['fish', 'krill', 'squid']]);
  });

  // MULTI-LABEL — `labels()` is a `FlatMapStep` over `element.labels()`
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/LabelsStep.java`),
  // so a four-label vertex fans out four ways. Emission order is the label dictionary id, which is the
  // same deterministic pick `label()` and `by(T.label)` make — so the first entry here and `label()`
  // name the same label, asserted below.
  test('labels().fold() collects every label of a multi-label vertex', async () => {
    const zoo = zooStore();
    expect(await rows(zoo, `g.V(1).project('n','t').by(__.values('name')).by(__.labels().fold())`))
      .toEqual([{ n: 'tux', t: ['animal', 'bird', 'aquatic', 'endangered'] }]);
    expect(await rows(zoo, `g.V(1).labels().fold()`)).toEqual([['animal', 'bird', 'aquatic', 'endangered']]);
    // `label()` is `labels[0]` — `LabelStep.map` returns `traverser.get().label()` — so the scalar step
    // and the first collected label agree. That agreement is why `by(T.label)` is not a second pick.
    expect(await rows(zoo, `g.V(1).label()`)).toEqual(['animal']);
  });

  // THE EMPTY CASES, which are `FoldStep`'s seed and not a null: an absent key and a zero-label vertex
  // each fold to `[]`, never to a missing field or a null. `Cardinality.ZERO_OR_MORE` makes the
  // zero-label vertex reachable at all (a bare `addV()`), and it is the case an OUTER join would answer
  // `[null]`.
  test('an absent key and a zero-label vertex both fold to []', async () => {
    const zoo = zooStore();
    expect(await rows(zoo, `g.V(1).project('n','x').by(__.values('name')).by(__.values('nope').fold())`))
      .toEqual([{ n: 'tux', x: [] }]);
    expect(await rows(zoo, `g.addV().project('t').by(__.labels().fold())`)).toEqual([{ t: [] }]);
  });

  // A single-valued property still folds to a ONE-element list, not to the bare value — the fold is a
  // collect, not a coercion.
  test('a single-valued property folds to a one-element list', async () => {
    expect(await rows(seededStore(), `g.V().hasLabel('person').project('n').by(__.values('name').fold())`))
      .toEqual([{ n: ['marko'] }, { n: ['vadas'] }, { n: ['josh'] }, { n: ['peter'] }]);
  });

  // AND IT COMPOSES with the nesting it has to live inside — a self-rooted fold as a field of a record
  // that is itself a folded list under an outer `by()`. This is the shape a GraphQL type-identity field
  // takes on a multi-label graph.
  test('a self-rooted fold nests inside an outer folded projection', async () => {
    expect(await rows(seededStore(),
      `g.V().has('name','marko').project('c')`
      + `.by(__.out('created').project('n','l').by(__.values('name')).by(__.labels().fold()).fold())`))
      .toEqual([{ c: [{ n: 'lop', l: ['software'] }] }]);
  });

  // STILL DECLINED, so the gate stays a gate: a bare `by(__.labels())` is NOT a collect. A `by()` takes
  // the FIRST value of a multi-yield body (`TraversalUtil.produce` returns `traversal.next()`,
  // `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java:108-118`),
  // which is a different cardinality (`yields: 'first'`) and belongs to the expression arm, not here.
  test('a bare labels() arm is not a collect and still declines', () => {
    expect(() => executeQuery(zooStore(), `g.V(1).project('t').by(__.labels())`)).toThrow(/not supported yet/);
  });
});
