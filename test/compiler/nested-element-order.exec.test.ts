// order/dedup(Scope.local) over an ELEMENT-membered nested list (`order-dedup-local.ts` D2).
//
// A `Map<K,List<vertex>>` value ordered/deduped WHOLE. The barrier carries each element member as its raw
// ROWID through the JS ORDERABILITY comparator and materializes only at the edge, so the result re-enters
// the graph. The L4 addendum (`nested-list-order-dedup.feature`) pins the REFERENCE-SAFE, order-independent
// claim (the name multiset after re-source); this file REGRESSION-LOCKS the exact sorted structure our
// engine produces — which is stable (byte-identical under `MOGWAI_REVERSE_UNORDERED`) but not a conformance
// claim, because order(local)'s outer sort compares the inner vertex-lists element-wise by id and each
// inner list's order is out()'s iteration order, which the reference leaves unspecified. What is conformant
// is that the OUTER list is sorted by ORDERABILITY and every element round-trips.
import { test, expect, describe } from 'bun:test';
import { seededStore } from '../support/harness.ts';
import { executeFramed } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';

const framed = (q: string) => decodeAll(executeFramed(seededStore(), q).map((f) => f.buf));

/** Project a decoded value to ids (a vertex/edge → its id, a list → a list of ids), so the assertions read
 *  as the nesting structure rather than a wall of framed property objects. */
const ids = (v: any): any => Array.isArray(v) ? v.map(ids) : v && typeof v === 'object' && 'id' in v ? v.id : v;

const P = 'g.V().hasLabel("person").group().by("name").by(__.out().fold()).select(Column.values)';

describe('order/dedup(Scope.local) over an element-membered nested list', () => {
  test('order(local): the outer list is sorted by ORDERABILITY (element-wise by id), members re-source', async () => {
    const r = await framed(`${P}.order(Scope.local)`);
    // ONE traverser (select(values) → one list). Sorted outer members: [] < [2,3,4] < [3] < [3,5].
    expect(ids(r)).toEqual([[[], [2, 3, 4], [3], [3, 5]]]);
  });

  test('dedup(local): all four value-lists are distinct, so all survive, and every member re-sources', async () => {
    const r = await framed(`${P}.dedup(Scope.local)`);
    // First-occurrence order preserved (map-value order): josh, marko, peter, vadas.
    expect(ids(r)).toEqual([[[3, 5], [2, 3, 4], [3], []]]);
  });

  test('order(local).unfold().unfold().values(name): the re-sourced name multiset', async () => {
    const r = await framed(`${P}.order(Scope.local).unfold().unfold().values("name")`);
    expect([...r].sort()).toEqual(['josh', 'lop', 'lop', 'lop', 'ripple', 'vadas']);
  });

  test('order(local).unfold().unfold().out(): the re-sourced vertices take a MOVEMENT step', async () => {
    const r = await framed(`${P}.order(Scope.local).unfold().unfold().out().values("name")`);
    expect([...r].sort()).toEqual(['lop', 'ripple']);
  });

  test('T.label key: group().by(T.label).by(fold()).select(values).order(local), members re-source', async () => {
    const r = await framed('g.V().group().by(T.label).by(__.fold()).select(Column.values).order(Scope.local)');
    // Two vertex-lists: person [1,2,4,6] and software [3,5]; sorted [1,…] < [3,…].
    expect(ids(r)).toEqual([[[1, 2, 4, 6], [3, 5]]]);
  });

  // GLOBAL order() over an element-membered list STREAM — the neighbouring combination (unfold the values
  // to a stream of vertex-lists, then order the whole stream). Same rowid carriage as Scope.local.
  test('global order() sorts a STREAM of element-lists by ORDERABILITY, members re-source', async () => {
    const r = await framed(`${P}.unfold().order()`);
    // Four traversers (one per value-list), sorted as a stream: [] < [2,3,4] < [3] < [3,5].
    expect(ids(r)).toEqual([[], [2, 3, 4], [3], [3, 5]]);
  });

  test('global order() over an element-list stream then unfold/read: the re-sourced name multiset', async () => {
    const r = await framed(`${P}.unfold().order().unfold().values("name")`);
    expect([...r].sort()).toEqual(['josh', 'lop', 'lop', 'lop', 'ripple', 'vadas']);
  });
});
