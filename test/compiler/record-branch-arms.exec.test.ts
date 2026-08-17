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
const norm = (v: any): any =>
  v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [String(k), norm(x)])) : Array.isArray(v) ? v.map(norm) : v;

const decodedRows = async (q: string): Promise<any[]> =>
  (await decodeAll(executeQuery(seededStore(), q))).map(norm);

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

  // `coalesce` needs one more fact than the merge does: "can a later arm ever fire", which is
  // `alwaysProduces` (`ir/productivity.ts`) reading the arm's LAST step. A `project()` is a
  // `ScalarMapStep` whose `processNextStart` splits unconditionally
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ScalarMapStep.java:38-40`)
  // and whose `map()` returns its map however empty, so it ALWAYS produces — the first arm wins for
  // every traverser and the second is dead. That is the counterintuitive half and the reason it is
  // asserted: `lop` and `ripple` have no `age`, so arm 1 gives them `{}` (the key omitted per
  // `ifProductive`) rather than falling through to arm 2's `lang`.
  test('coalesce() over project arms — the first arm always wins, empty map included', async () => {
    expect(await decodedRows(`g.V().coalesce(__.project('a').by(__.values('age')),__.project('a').by(__.values('lang')))`))
      .toEqual([{ a: 29 }, { a: 27 }, {}, { a: 32 }, {}, { a: 35 }]);
    // `valueMap` is the same `ScalarMapStep` rule: an absent key yields `{}`, not a fall-through.
    expect(await decodedRows(`g.V().hasLabel('software').coalesce(__.valueMap('nope'),__.valueMap('lang'))`))
      .toEqual([{}, {}]);
    // THE CONTROL that keeps the set honest — a `values()` arm CAN be unproductive, so the software
    // vertices really do fall through to `lang` here. Same query shape, opposite outcome, and the only
    // difference is which step ends the arm.
    const store = seededStore();
    expect((await decodeAll(executeQuery(store, `g.V().coalesce(__.values('age'),__.values('lang'))`))).map(norm))
      .toEqual([29, 27, 32, 35, 'java', 'java']);
  });

  // ---------- arms whose records DISAGREE: the divergence moves inside the value ----------
  //
  // Each GraphQL union member selects its OWN fields, so the arms disagree by construction and the
  // record merge above cannot apply. `mapDemotedArms` collapses each record into the single `map`
  // column the map vocabulary reads, whose entries are self-describing `{t,v}` nodes — so arms with
  // entirely different key sets become two rows of ONE column and the positional `Union` has nothing
  // left to disagree about. Neo4j's GraphQL library reaches the same place from Cypher: each branch
  // does `WITH this0 { .id, __resolveType: "Child1" } AS this0 RETURN this0 AS this`, building the map
  // INSIDE the branch so the branches union over one column.
  test('a union of per-member records keeps each member its own fields', async () => {
    const rows = await decodedRows(
      `g.V().union(`
      + `__.hasLabel('person').project('__typename','name').by(__.constant('person')).by(__.values('name')),`
      + `__.hasLabel('software').project('__typename','lang').by(__.constant('software')).by(__.values('lang')))`);
    expect(sortByJson(rows)).toEqual(sortByJson([
      { __typename: 'person', name: 'marko' }, { __typename: 'person', name: 'vadas' },
      { __typename: 'person', name: 'josh' }, { __typename: 'person', name: 'peter' },
      { __typename: 'software', lang: 'java' }, { __typename: 'software', lang: 'java' },
    ]));
  });

  // THE SAME-KEY / DIFFERENT-TYPE CLASH, which is the whole reason the demotion is the right shape and
  // a flattened superset projection is not. One key `v`, an `int` on one member and a `string` on the
  // other: as columns that is one column with two storage classes, and as map ENTRIES each keeps its
  // own exact type, because `MapOf`'s scalar side is always a self-describing `{t,v}` node
  // (`render.ts` — "heterogeneous maps round-trip").
  test('the same key may hold a different TYPE per member', async () => {
    const rows = await decodedRows(
      `g.V().union(`
      + `__.hasLabel('person').project('v').by(__.values('age')),`
      + `__.hasLabel('software').project('v').by(__.values('lang')))`);
    expect(sortByJson(rows)).toEqual(sortByJson([
      { v: 29 }, { v: 27 }, { v: 32 }, { v: 35 }, { v: 'java' }, { v: 'java' },
    ]));
  });

  // A RECORD arm and a genuine MAP arm merge by the same route — the record demotes, the map is already
  // there. `valueMap` is list-valued per key (its own semantics, not a wrapper this adds).
  test('a project arm merges with a valueMap arm', async () => {
    const rows = await decodedRows(`g.V().hasLabel('software').union(__.project('a').by(__.values('name')),__.valueMap('lang'))`);
    expect(sortByJson(rows)).toEqual(sortByJson([{ a: 'lop' }, { a: 'ripple' }, { lang: ['java'] }, { lang: ['java'] }]));
  });

  // THE GRAPHQL UNION FIELD, end to end: divergent members dispatched by label, nested in a `by()` and
  // folded into the field's list.
  test('divergent member records fold into a per-host list', async () => {
    const rows = await decodedRows(
      `g.V().hasLabel('person').has('name','marko').project('name','created')`
      + `.by(__.values('name'))`
      + `.by(__.out('created').union(`
      + `__.hasLabel('software').project('__typename','lang').by(__.constant('software')).by(__.values('lang')),`
      + `__.hasLabel('person').project('__typename','age').by(__.constant('person')).by(__.values('age'))`
      + `).fold())`);
    expect(rows).toEqual([{ name: 'marko', created: [{ __typename: 'software', lang: 'java' }] }]);
  });

  // `select(k)` AFTER the merge — the part that is easy to get silently wrong, because a row whose key
  // is ABSENT must drop rather than read a sibling arm's value. `SelectOneStep` tries the traverser's own
  // map and a missing key raises `KeyNotFoundException` -> `EmptyTraverser`
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectStep.java:65-90`).
  //
  // So the demotion costs the field's COLUMN, not its reachability — the read goes through the map
  // vocabulary's JSON member instead. All three key arrangements are asserted, because only the third
  // distinguishes a correct member read from "read arm 1's column and hope": `a` on arm 2 ALONE must give
  // arm 2's values, and only FOUR of the six vertices at that, since the two software vertices have no
  // `age`, `ifProductive` omits their key, and `select` then drops the row.
  test('select() after a demoted merge reads the MEMBER, and drops rows without the key', async () => {
    const sel = async (q: string) => (await decodedRows(q)).sort();
    // Both arms carry `a` -> both arms' values.
    expect(await sel(`g.V().union(__.project('a').by(__.values('name')),__.project('a','b').by(__.values('name')).by(__.values('age'))).select('a')`))
      .toEqual(['josh', 'josh', 'lop', 'lop', 'marko', 'marko', 'peter', 'peter', 'ripple', 'ripple', 'vadas', 'vadas']);
    // Only arm 1 carries `a` -> arm 2's six rows drop.
    expect(await sel(`g.V().union(__.project('a').by(__.values('name')),__.project('b').by(__.values('age'))).select('a')`))
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
    // Only arm 2 carries `a` -> arm 2's values, and only the four vertices that HAVE an age.
    expect(await sel(`g.V().union(__.project('b').by(__.values('name')),__.project('a').by(__.values('age'))).select('a')`))
      .toEqual([27, 29, 32, 35]);
  });

  // A FILTTERED project arm is the case a last-step-only productivity rule got WRONG, and it is exactly
  // per-member type dispatch — the shape a GraphQL union field takes. A `project()` is a MAPPING terminal
  // (one traverser out per traverser IN), so a `hasLabel()` in front of it takes its input away and its
  // productivity with it. Reading only the terminal claimed arm 1 always fires, which exhausted the
  // coalesce and made arm 2 unreachable: the two software vertices returned NOTHING instead of their
  // `lang`. Measured, and asserted here so it cannot come back.
  // The assertions SORT: nothing downstream observes position here, so the merge takes the positionless
  // route and is arm-major rather than traverser-major (`coalesceArms`' `dropEncounter`; the
  // order-observing case goes through `mintTraverserMajor` instead). What is under test is WHICH ROWS
  // exist, and the bug was that two of them did not.
  test('coalesce() over FILTERED project arms dispatches per member', async () => {
    expect(sortByJson(await decodedRows(
      `g.V().coalesce(__.hasLabel('person').project('a').by(__.values('name')),`
      + `__.hasLabel('software').project('a').by(__.values('lang')))`)))
      .toEqual(sortByJson([{ a: 'marko' }, { a: 'vadas' }, { a: 'josh' }, { a: 'peter' }, { a: 'java' }, { a: 'java' }]));
    // The same trap one step down, and it predates the mapping terminals joining the set: `constant()`
    // also needs an input, so a filtered `constant` arm must not exhaust the coalesce either. Before the
    // fix this returned four `P`s and NO `S` at all.
    expect((await decodedRows(`g.V().coalesce(__.hasLabel('person').constant('P'),__.hasLabel('software').constant('S'))`)).sort())
      .toEqual(['P', 'P', 'P', 'P', 'S', 'S']);
    expect(sortByJson(await decodedRows(`g.V().coalesce(__.hasLabel('person').valueMap('name'),__.hasLabel('software').valueMap('lang'))`)))
      .toEqual(sortByJson([{ name: ['marko'] }, { name: ['vadas'] }, { name: ['josh'] }, { name: ['peter'] }, { lang: ['java'] }, { lang: ['java'] }]));
  });

  // FAIL CLOSED where the demotion does NOT apply — an arm that is neither a record nor an already
  // `{t,v}`-valued map. An `elem`- or `list`-valued map's entries are a different physical form, so
  // merging would union two encodings under one framing; declining is the answer, never a first-arm guess.
  test('a record arm against a non-map arm DECLINES', () => {
    const store = seededStore();
    // ...against an ELEMENT arm.
    expect(() => executeQuery(store, `g.V().union(__.project('a').by(__.values('name')),__.out())`))
      .toThrow(/not supported yet/);
    // ...against a bare SCALAR arm.
    expect(() => executeQuery(store, `g.V().union(__.project('a').by(__.values('name')),__.values('name'))`))
      .toThrow(/not supported yet/);
    // ...against a LIST arm.
    expect(() => executeQuery(store, `g.V().union(__.project('a').by(__.values('name')),__.out().fold())`))
      .toThrow(/not supported yet/);
  });
});
