// `select(k)` over a PER-ROW SCALAR stream whose rows may be Maps (`selectMapFirst`, `src/compiler/rel/lower.ts`;
// `scalarMapKey`, `src/compiler/rel/map.ts`). The end-to-end answers live in
// test/L4-addendum/scalar-map-scope-select.feature; this pins the two properties a result cannot show —
// WHERE the per-row Map probe is spent, and that a constant the stored encoding cannot spell declines.
import { test, expect, describe } from 'bun:test';
import { bare, read, run, seededStore } from '../support/harness.ts';
import { UnsupportedTraversal } from '../../src/compiler/unsupported.ts';

const probes = (q: string): boolean => /vtype = 'map'/.test(read(q).sql);

describe('select(k) over a per-row scalar stream — Map first', () => {
  test('a live path label keeps its answer with NO per-row Map probe (the §17 line)', () => {
    expect(probes("g.V().as('a').values('name').select('a')")).toBe(false);
  });

  test('a side-effect constant or an unbound key spends the probe, once, behind the vtype test', () => {
    expect(probes("g.withSideEffect('k','se').V().values('m').select('k')")).toBe(true);
    expect(probes("g.V().values('m').select('k')")).toBe(true);
    // ONE correlated entry read in the chain form: the node lands in one fenced column and its three
    // readers (presence, value, tag) read that column.
    expect(read("g.V().values('m').select('k')").sql.match(/json_each/g)).toHaveLength(1);
  });

  test('a list constant falls through as a per-row list value', () => {
    const store = seededStore();
    const rows = run(store, "g.withSideEffect('k',[1,2]).V(1).property('m',[j:1]).values('m').select('k')");
    expect(bare(rows)).toEqual([{ v: '[{"t":"int","v":1},{"t":"int","v":2}]', vtype: 'list' }]);
  });

  test('a constant the stored encoding cannot spell (a T.label key) DECLINES rather than answer', () => {
    const store = seededStore();
    expect(() => run(store, "g.withSideEffect('k',[(T.label):'x']).V(1).property('m',[j:1]).values('m').select('k')"))
      .toThrow(UnsupportedTraversal);
  });
});
