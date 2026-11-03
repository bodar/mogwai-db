// `select(k)` over a PER-ROW SCALAR stream whose rows may be Maps (`selectMapFirst`, `src/compiler/rel/lower.ts`;
// `scalarMapKey`, `src/compiler/rel/map.ts`). The end-to-end answers live in
// test/L4-addendum/scalar-map-scope-select.feature; this pins what a result cannot show — WHERE the per-row
// Map probe is spent (only where no scope beyond the Map names the key) — and the declines the query text
// decides.
import { test, expect, describe } from 'bun:test';
import { bare, read, run, seededStore } from '../support/harness.ts';
import { UnsupportedTraversal } from '../../src/compiler/unsupported.ts';

const values = (rows: readonly any[]): unknown[] => rows.map((row) => row.v);

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

  test('a merge by a side effect over values that may be stored Maps follows the side effect, as the chain spelling does', () => {
    // §17 "Map scope": the named scope WINS over a per-row scalar, no row probed — the child spelling
    // `mergeV(__.select('k'))` and the chain spelling `select('k').mergeV()` are one query.
    const store = seededStore();
    run(store, "g.V(1).property('m',[k:[name:'own']])");
    expect(values(run(store, "g.withSideEffect('k',[name:'zz']).V().values('m').mergeV(__.select('k')).values('name')"))).toEqual(['zz']);
    expect(values(run(seededStore(), "g.withSideEffect('k',[name:'zz']).V().values('name').mergeV(__.select('k')).values('name')"))).toEqual(['zz', 'zz', 'zz', 'zz', 'zz', 'zz']);
    expect(bare(run(seededStore(), "g.withSideEffect('k',[name:'zz']).V().values('name').select('k').mergeV().count()"))).toEqual([{ v: 6 }]);
    expect(bare(run(seededStore(), "g.withSideEffect('k',[name:'zz']).inject(1).mergeV(__.select('k')).count()"))).toEqual([{ v: 1 }]);
    // With no side effect `k` there is no map to merge: a clear decline.
    expect(() => run(seededStore(), "g.V().values('name').mergeV(__.select('k'))")).toThrow(UnsupportedTraversal);
  });

  // A merge `select(k)` over a stream of Maps is decided by the stream's MAY key set (`MergeTraverser`).
  // `Scoping.getScopeValue` reads the Map's own `k` first, then the side effect
  // (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135).
  test('a key no Map can hold reads the side effect — the merge answers', () => {
    expect(bare(run(seededStore(), "g.withSideEffect('c',[age:1]).inject([name:'x']).mergeV().option(Merge.onCreate, __.select('c')).valueMap()")))
      .toEqual(bare(run(seededStore(), "g.inject([name:'x']).mergeV().option(Merge.onCreate, [age:1]).valueMap()")));
    // A whole-arg map over a Map driver is a mere multiplier, which the Map-driver lowering does not cover
    // yet whatever spells the map (`inject([a:1]).mergeV([name:'q'])` declines too) — a clean decline, never
    // the collision message.
    expect(() => run(seededStore(), "g.withSideEffect('k',[name:'zz']).inject([name:'q']).mergeV(__.select('k'))"))
      .toThrow(/^this traversal is not supported yet: no lowering covers/);
    expect(values(run(seededStore(), "g.withSideEffect('c',[age:1]).inject([name:'nobody']).mergeV().option(Merge.onMatch, __.select('c')).values('name')"))).toEqual(['nobody']);
    // At depth: after as(), into a barrier, both arms.
    expect(values(run(seededStore(), "g.withSideEffect('c',[age:1]).inject([name:'x']).as('m').mergeV().option(Merge.onCreate, __.select('c')).values('age')"))).toEqual([1]);
    expect(values(run(seededStore(), "g.withSideEffect('c',[age:1]).inject([name:'x'],[name:'y']).mergeV().option(Merge.onCreate, __.select('c')).values('age').sum()"))).toEqual([2]);
    // The side effect answers, so its own reference error follows: an onCreate cannot override the merge map.
    expect(() => run(seededStore(), "g.withSideEffect('c',[(T.label):'person',name:'zz']).inject([name:'nobody']).mergeV().option(Merge.onCreate, __.select('c')).values('name')"))
      .toThrow("option(onCreate) cannot override values from merge() argument");
  });

  test('a key a Map MAY hold beside a same-named side effect declines naming the collision', () => {
    for (const q of [
      "g.withSideEffect('k',[name:'zz']).inject([k:[name:'q']]).mergeV(__.select('k'))",
      "g.withSideEffect('name',[age:1]).V(1).valueMap().mergeV(__.select('name'))",
      "g.withSideEffect('c',[age:1]).inject([c:2],[name:'x']).mergeV().option(Merge.onCreate, __.select('c'))",
    ]) expect(() => run(seededStore(), q), q).toThrow(/a Map stream MAY hold '(k|name|c)' and a side effect '\1' is declared/);
  });

  test('a key a Map MAY hold with no side effect is a plain own-entry decline, with no rename advice', () => {
    for (const q of [
      "g.inject([lookup:[name:'x'], create:[name:'x',age:3]]).mergeV(__.select('lookup')).option(Merge.onCreate, __.select('create'))",
      "g.V(1).valueMap().mergeV(__.select('name'))",
    ]) {
      let message = '';
      try { run(seededStore(), q); } catch (e) { message = (e as Error).message; expect(e).toBeInstanceOf(UnsupportedTraversal); }
      expect(message, q).toMatch(/^this traversal is not supported yet: reading a Map's own '(lookup|name)' entry \(select\('\1'\) over a stream of Maps\) as a merge argument$/);
    }
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

  test('a key the map cannot hold reads the side effect for every row; a key it may hold declines', () => {
    expect(bare(run(seededStore(), "g.withSideEffect('k',5).inject([j:2]).select('k')"))).toEqual([{ v: 5 }]);
    // The key fact is a MAY set only, so even a literal holding `k` on every row declines.
    for (const q of [
      "g.withSideEffect('k',5).inject([k:1]).select('k')",
      "g.V().as('name').constant([name:'x']).select('name')",
      "g.V().as('name').local(constant([name:'x']).select('name'))",
      "g.V().as('name').union(constant([name:'x']), constant([name:'y'])).select('name')",
      "g.V().as('name').constant([name:'x']).limit(local, 1).select('name')",
    ]) expect(() => run(seededStore(), q), q).toThrow(UnsupportedTraversal);
    // The ordinary forms keep answering: no collision, and the record path is untouched.
    expect(bare(run(seededStore(), "g.inject([a:1],[b:2]).as('x').select('x').select('a')"))).toEqual([{ v: 1, vtype: 'int' }]);
    expect(bare(run(seededStore(), "g.V().as('n').constant([name:'x']).select('name')")).length).toBe(6);
    expect(bare(run(seededStore(), "g.V().project('name','age').by('name').by('age').select('name')")).length).toBe(6);
  });
});

// A `choose` arm `select(k)` of a side-effect constant: the constant's presence is its HOST's (`hostPresence`,
// `constantSelectChild`), so over a host that is always there the arm is `'always'` — the choice's meet
// answers and no per-row `IS NOT NULL` is spent on a literal. The end-to-end answers, at depth, are
// test/L4-addendum/side-effect-choose-arm.feature.
describe('a side-effect constant read in a choose arm', () => {
  test('over an always-present host: no presence term, and the choice answers', () => {
    const q = "g.withSideEffect('k',5).V().map(__.choose(__.hasLabel('person'), __.select('k'), __.constant(0)))";
    expect(read(q).sql).not.toMatch(/IS NOT NULL/i);
    expect(values(run(seededStore(), q)).sort()).toEqual([0, 0, 5, 5, 5, 5]);
  });

  test('over a may-be-absent host the arm states its presence, so the choice still declines', () => {
    expect(() => run(seededStore(),
      "g.withSideEffect('k',5).V().optional(__.out('knows').as('b')).map(__.select('b').choose(__.hasLabel('person'), __.select('k'), __.constant(0)))",
    )).toThrow(UnsupportedTraversal);
    // …while the bare read over the same host keeps answering, gated on the label.
    expect(bare(run(seededStore(), "g.withSideEffect('k',5).V().optional(__.out('knows').as('b')).project('x').by(__.select('b').select('k'))")))
      .toHaveLength(7);
  });
});
