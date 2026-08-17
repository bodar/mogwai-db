// A BRANCH WHOSE ARMS PROJECT — `union`/`choose` over `project()` bodies, executed.
//
// `sameFraming` declined two `record` arms outright until now ("nothing builds a record-valued branch
// arm yet"), so a branch could produce elements, scalars, lists and maps but not a RECORD. The gap was
// the equality, not a node: a record's payload is its fields' PREFIXED columns and `RecordField.prefix`
// is POSITIONAL (`prefixAt`, `record.ts`), so two structurally-equal records already occupy the same
// columns and the ordinary positional `Union` merges them.
//
// The shape this unblocks is per-member type dispatch — one arm per concrete type, each projecting its
// own row. It is what a GraphQL interface/union field needs, and it is what the Neo4j GraphQL library
// emits for the same query: `CALL { MATCH (this0:Child1) WITH this0 { .id, __resolveType: "Child1" }
// AS this0 RETURN this0 AS this UNION … }` — one branch per member, each BUILDING ITS OWN ROW, so the
// members' shapes never have to meet as columns. Calcite models the same requirement from the algebra
// side: `SetOp` (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/core/SetOp.java`) requires
// its inputs' row types to agree, which is exactly the agreement `sameRecordFields` establishes.
import { test, expect, describe } from 'bun:test';
import { seededStore } from '../support/harness.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';

/** Decode a result set to plain JS (a Map → object, an array recurses) — a record result is a
 *  GraphBinary map, not a raw SQL column. Same helper as `branch.exec.test.ts`. */
const decodedRows = async (q: string): Promise<any[]> => {
  const store = seededStore();
  const norm = (v: any): any =>
    v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [String(k), norm(x)])) : Array.isArray(v) ? v.map(norm) : v;
  return (await decodeAll(executeQuery(store, q))).map(norm);
};

const sortByJson = (rows: any[]): any[] => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe('record-valued branch arms', () => {
  // `union` is a `BranchStep` draining arm by arm and every scenario of `Union.feature` asserts
  // UNORDERED, so the assertion sorts. Traversers are a MULTISET: both arms contribute every row.
  test('union() of two same-key project arms merges both arms', async () => {
    const rows = await decodedRows(
      `g.V().hasLabel('person').union(__.project('a').by(__.values('name')),__.project('a').by(__.values('age')))`);
    expect(sortByJson(rows)).toEqual(sortByJson([
      { a: 'marko' }, { a: 'vadas' }, { a: 'josh' }, { a: 'peter' },
      { a: 29 }, { a: 27 }, { a: 32 }, { a: 35 },
    ]));
  });

  // PER-MEMBER TYPE DISPATCH — each arm filters to one label and projects that label's own fields.
  // The `t` field is a per-arm constant, which is how a member names itself (a GraphQL `__typename`,
  // Neo4j's `__resolveType`); `n` reads a DIFFERENT property per arm, which is the point — the arms
  // agree on the record's SHAPE while disagreeing about what fills it.
  test('a hasLabel-guarded union dispatches per member', async () => {
    const rows = await decodedRows(
      `g.V().union(`
      + `__.hasLabel('person').project('t','n').by(__.constant('person')).by(__.values('name')),`
      + `__.hasLabel('software').project('t','n').by(__.constant('software')).by(__.values('lang')))`);
    expect(sortByJson(rows)).toEqual(sortByJson([
      { t: 'person', n: 'marko' }, { t: 'person', n: 'vadas' },
      { t: 'person', n: 'josh' }, { t: 'person', n: 'peter' },
      { t: 'software', n: 'java' }, { t: 'software', n: 'java' },
    ]));
  });

  // `choose(pred, then, else)` is per TRAVERSER (`ChooseStep`), so marko (age 29) takes the `then` arm
  // and the other three take the `else` arm — one row per input vertex, not two.
  test('choose() over project arms dispatches per traverser', async () => {
    const rows = await decodedRows(
      `g.V().hasLabel('person').choose(__.has('age',29),__.project('a').by(__.values('name')),__.project('a').by(__.values('age')))`);
    expect(sortByJson(rows)).toEqual(sortByJson([{ a: 'marko' }, { a: 27 }, { a: 32 }, { a: 35 }]));
  });

  // THE NESTED FORM — the branch inside a `project().by()` arm, folded to a per-host list. This is the
  // whole GraphQL union field: an object field whose members are dispatched by label and whose rows are
  // collected into the field's list.
  test('a record-armed union inside a by() folds to a per-host list', async () => {
    const rows = await decodedRows(
      `g.V().hasLabel('person').has('name','marko').project('name','created')`
      + `.by(__.values('name'))`
      + `.by(__.out('created').union(`
      + `__.hasLabel('software').project('t','n').by(__.constant('software')).by(__.values('name')),`
      + `__.hasLabel('person').project('t','n').by(__.constant('person')).by(__.values('name'))`
      + `).fold())`);
    expect(rows).toEqual([{ name: 'marko', created: [{ t: 'software', n: 'lop' }] }]);
  });

  // FAIL CLOSED on arms that do NOT agree. `sameRecordFields` compares key, order, shape and
  // `optional`, and a disagreement is a decline — never a silently-adopted first arm. `project()`'s
  // productivity rule is per FIELD (`ProjectStep.map`'s `ifProductive`,
  // `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ProjectStep.java:66`),
  // so adopting one arm's field list for the other's rows would put a key on a row the reference omits.
  test('arms whose records disagree DECLINE rather than adopt the first', () => {
    const store = seededStore();
    // Different KEY.
    expect(() => executeQuery(store, `g.V().union(__.project('a').by(__.values('name')),__.project('b').by(__.values('name')))`))
      .toThrow(/not supported yet/);
    // Different ARITY.
    expect(() => executeQuery(store, `g.V().union(__.project('a').by(__.values('name')),__.project('a','b').by(__.values('name')).by(__.values('age')))`))
      .toThrow(/not supported yet/);
    // Different field SHAPE — a scalar field against a folded LIST field under the same key.
    expect(() => executeQuery(store, `g.V().union(__.project('a').by(__.values('name')),__.project('a').by(__.out().fold()))`))
      .toThrow(/not supported yet/);
  });
});
