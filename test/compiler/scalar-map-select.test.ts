// `select(k)` over a PER-ROW SCALAR stream whose rows may be Maps (`selectMapFirst`, `src/compiler/rel/lower.ts`;
// `scalarMapKey`, `src/compiler/rel/map.ts`). The end-to-end answers live in
// test/L4-addendum/scalar-map-scope-select.feature; this pins what a result cannot show — WHERE the per-row
// Map probe is spent (only where no scope beyond the Map names the key) — and the declines the query text
// decides.
import { test, expect, describe } from 'bun:test';
import { bare, read, run, seededStore } from '../support/harness.ts';
import { UnsupportedTraversal } from '../../src/compiler/unsupported.ts';

const probes = (q: string): boolean => /vtype = 'map'/.test(read(q).sql);

describe('select(k) over a per-row scalar stream — Map first only where nothing else names k', () => {
  test('a live path label keeps its answer with NO per-row Map probe (the §17 line)', () => {
    expect(probes("g.V().as('a').values('name').select('a')")).toBe(false);
  });

  test('a side-effect constant WINS with NO per-row Map probe — in select() and in math()', () => {
    expect(probes("g.withSideEffect('k','se').V().values('m').select('k')")).toBe(false);
    const math = read("g.withSideEffect('k',5).V().values('age').math('k + 1')").sql;
    expect(math).not.toMatch(/vtype = 'map'/);
    expect(math).not.toMatch(/json_each/);
  });

  test('an unbound key spends the probe, once, behind the vtype test', () => {
    expect(probes("g.V().values('m').select('k')")).toBe(true);
    // ONE correlated entry read in the chain form: the node lands in one fenced column and its three
    // readers (presence, value, tag) read that column.
    expect(read("g.V().values('m').select('k')").sql.match(/json_each/g)).toHaveLength(1);
  });

  test('a list or map constant is that collection for every row, a stored Map holding k or not', () => {
    const store = seededStore();
    expect(bare(run(store, "g.withSideEffect('k',[1,2]).V(1).property('m',[k:1]).values('m').select('k')"))).toEqual([{ list: '[1,2]' }]);
    expect(bare(run(store, "g.withSideEffect('k',[(T.label):'x']).V(1).values('m').select('k')")))
      .toEqual([{ map: '[[{"t":"T","v":"label"},{"t":"string","v":"x"}]]' }]);
  });

  test('a merge by a side effect over values that may be stored Maps DECLINES (it could write the wrong element)', () => {
    expect(() => run(seededStore(), "g.withSideEffect('k',[a:1]).V().values('m').mergeV(__.select('k'))")).toThrow(UnsupportedTraversal);
    // …while a scalar with no per-row tag is never a Map, so the side effect IS the answer there.
    expect(bare(run(seededStore(), "g.withSideEffect('k',[name:'zz']).inject(1).mergeV(__.select('k')).count()"))).toEqual([{ v: 1 }]);
  });

  test('a map or record that MAY hold k beside a same-named side effect DECLINES — chain, child, math() and dedup()', () => {
    for (const q of [
      "g.withSideEffect('k',5).inject([k:1],[j:2]).select('k')",
      "g.withSideEffect('k',5).V().valueMap().select('k')",
      "g.withSideEffect('k',5).inject([k:1],[j:2]).math('k + 1')",
      "g.withSideEffect('k',5).inject([k:1],[j:2]).dedup('k')",
      "g.withSideEffect('k',5).V().project('k').by('age').select('k')",
    ]) expect(() => run(seededStore(), q), q).toThrow(UnsupportedTraversal);
  });

  test('a key the map cannot hold reads the side effect for every row; a key it holds on every row reads the entry', () => {
    expect(bare(run(seededStore(), "g.withSideEffect('k',5).inject([j:2]).select('k')"))).toEqual([{ v: 5 }]);
    expect(bare(run(seededStore(), "g.withSideEffect('k',5).inject([k:1]).select('k')"))).toEqual([{ v: 1, vtype: 'int' }]);
  });
});
