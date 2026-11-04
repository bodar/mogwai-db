// A child body's VALUE RUN spells its running value ONCE per step (`once`, `src/compiler/rel/build.ts`,
// applied in `valueRun`, `src/compiler/rel/lower/reduction.ts`).
//
// Every member of a run reads its receiver more than once — an `is()` in its test and its THEN, a
// transform in its receiver check and its expression (`substring` four times). Built over the inline
// value, a k-step run was O(2^k) statement text: `where(__.values('name').toUpper()…)` with seven
// transforms was ~100 KB, past a Durable Object's statement cap, and four chained `is()` over a selected
// label passed the compile budget and declined. Short runs passed every bun:sqlite test, so every run here
// is against a `CfLimitedSql` store: a statement a DO would reject fails here too.
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { CfLimitedSql } from '../../src/cf-limits.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';
import { bagOf } from '../support/harness.ts';

const store = new GraphStore(new CfLimitedSql(new BunSqlite(':memory:')));
for (const q of MODERN_SEED) executeQuery(store, q);
const answer = async (g: string) => bagOf(await decodeAll(executeQuery(store, g)));
const sqlBytes = (g: string): number => {
  const p = compile(g, {});
  return p.kind === 'read' ? p.sql.length : p.steps.reduce((n, s) => n + s.emitted.sql.length, 0);
};

/** `toUpper().toLower()` repeated: an even run ends lower-case, so it answers what ONE pair does. */
const cases = (k: number) => Array.from({ length: k }, (_, i) => (i % 2 ? '.toLower()' : '.toUpper()')).join('');
/** `is(neq(…))` over values no age has: a filter that keeps every value, so it answers what ONE does. */
const neqs = (k: number) => Array.from({ length: k }, (_, i) => `.is(neq(${i + 100}))`).join('');
const substrings = (k: number) => Array.from({ length: k }, () => '.substring(0,4)').join('');

/** Each position a child body reaches a value run from, with a run of `run` spliced in. */
const POSITIONS: readonly (readonly [string, (run: string) => string])[] = [
  ['by()', (run) => `g.V().project('a').by(__.values('name')${run})`],
  ['where()', (run) => `g.V().where(__.values('name')${run}.is('marko')).values('age')`],
  ['not()', (run) => `g.V().not(__.values('name')${run}.is('marko')).values('name')`],
  ['map()', (run) => `g.V().map(__.values('name')${run})`],
  ['local()', (run) => `g.V().local(__.values('name')${run})`],
  ['a choose() arm', (run) => `g.V().choose(__.hasLabel('person'), __.values('name')${run}, __.constant('x'))`],
  ['a union() arm', (run) => `g.V().union(__.values('name')${run}, __.constant('x'))`],
  ['after a repeat() body', (run) => `g.V().hasLabel('software').repeat(__.in('created')).times(1).project('a').by(__.values('name')${run})`],
  ['order().by()', (run) => `g.V().hasLabel('person').order().by(__.values('name')${run}, desc).values('name')`],
  ['group().by() value', (run) => `g.V().group().by(label).by(__.values('name')${run}.fold())`],
];

describe('twelve chained transforms answer what one pair does, in every position, under the DO caps', () => {
  for (const [where, query] of POSITIONS) {
    test(where, async () => expect(await answer(query(cases(12)))).toEqual(await answer(query(cases(2)))));
  }
});

describe('twelve chained is() answer what one does', () => {
  const shapes: readonly (readonly [string, (run: string) => string])[] = [
    ['by()', (run) => `g.V().project('a').by(__.values('age')${run})`],
    ['where()', (run) => `g.V().where(__.values('age')${run}).values('name')`],
    ['map()', (run) => `g.V().hasLabel('person').map(__.values('age')${run})`],
    ['a selected label', (run) => `g.V().union(values('age').as('k'), constant(0)).map(select('k')${run})`],
    ['a scalar host', (run) => `g.inject(1, 2, 3).map(__.identity()${run})`],
  ];
  for (const [where, query] of shapes) {
    test(where, async () => expect(await answer(query(neqs(12)))).toEqual(await answer(query(neqs(1)))));
  }

  test('an UNPRODUCTIVE is() mid-run still drops the value at depth', async () => {
    // `is(gt(28))` then `is(lt(33))`: marko (29) and josh (32) survive, the rest are unproductive.
    expect(await answer(`g.V().hasLabel('person').map(__.values('age').is(gt(28))${neqs(10)}.is(lt(33)))`)).toEqual([29, 32]);
    expect(await answer(`g.V().hasLabel('person').where(__.values('age')${neqs(10)}.is(gt(28)).is(lt(33))).values('name')`))
      .toEqual(['josh', 'marko']);
  });

  test('is() and transforms interleave', async () =>
    expect(await answer(`g.V().where(__.values('name')${cases(6)}${neqs(3)}.toUpper().is('MARKO')).values('age')`)).toEqual([29]));
});

describe('a raising receiver still raises the same message where the value is read', () => {
  test("by(values('age').toUpper())", () =>
    expect(() => executeQuery(store, "g.V().project('a').by(__.values('age').toUpper())"))
      .toThrow('The toUpper() step can only take string as argument'));

  test('at depth, in a by() and a where()', () => {
    expect(() => executeQuery(store, `g.V().project('a').by(__.values('age')${cases(12)})`))
      .toThrow('The toUpper() step can only take string as argument');
    expect(() => executeQuery(store, `g.V().where(__.values('age')${neqs(4)}.toLower()${cases(6)})`))
      .toThrow('The toLower() step can only take string as argument');
  });

  test('a filtered-out value does not raise — the is() ran first', async () =>
    expect(await answer(`g.V().hasLabel('person').map(__.values('age').is(gt(100)).toUpper())`)).toEqual([]));
});

describe('statement text grows LINEARLY in the run length — doubling the run at most ~doubles the text', () => {
  const shapes: readonly (readonly [string, (k: number) => string])[] = [
    ['transforms in a where()', (k) => `g.V().where(__.values('name')${cases(k)}.is('X'))`],
    ['transforms in a by()', (k) => `g.V().project('a').by(__.values('name')${cases(k)})`],
    ['substring in a by()', (k) => `g.V().project('a').by(__.values('name')${substrings(k)})`],
    ['is() in a by()', (k) => `g.V().project('a').by(__.values('age')${neqs(k)})`],
    ['is() over a selected label', (k) => `g.V().union(values('age').as('k'), constant(0)).map(select('k')${neqs(k)})`],
  ];
  for (const [what, query] of shapes) {
    test(what, () => expect(sqlBytes(query(12))).toBeLessThanOrEqual(2.2 * sqlBytes(query(6))));
  }
});

// A TRANSFORMED order()/dedup() KEY AFTER A HOP. The key's run is a LET (`once`: a Project over a one-row
// VALUES) whose body may RAISE, so `withSubqueryColumns` (build.ts) did not land it below the productivity
// filter, and the sort term — built over the filter's INPUT — read the hop's renumbered relation THROUGH
// the filter. `check` never looked at a window's ORDER BY, and the emitter resolved it while both sat in
// one SELECT, until `fuse` pushed the filter below the renumber and handed it the renumber's id: every one
// of these leaked the emitter's bare "column 'id' of relation 'ro7' is not in scope" Error. The terms now
// read the filter (`keptBy`), and `check` walks a window's terms. The oracle is the same query keyed by the plain property — the
// modern graph's names are already lower-case and `_+1` keeps the age order — so each answer is checked
// against an independent lowering, IN ORDER where the query imposes one.
describe('a transformed order()/dedup() key after a hop answers, in every position', () => {
  const ordered = async (g: string) => decodeAll(executeQuery(store, g));
  const KEYS: readonly (readonly [string, string, string])[] = [
    ['toLower()', "values('name').toLower()", "'name'"],
    ['toLower().toUpper()', "values('name').toLower().toUpper()", "'name'"],
    ["math('_+1')", "values('age').math('_+1')", "'age'"],
  ];
  const ORDER: readonly (readonly [string, (by: string) => string])[] = [
    ['after out()', (by) => `g.V().out().order().by(${by}).values('name')`],
    ['after out().out()', (by) => `g.V().out().out().order().by(${by}).values('name')`],
    ['after a labelled hop', (by) => `g.V().hasLabel('person').out('knows').order().by(${by}).values('name')`],
    ['then a limit', (by) => `g.V().out().order().by(${by}).limit(2).values('name')`],
    ['inside local()', (by) => `g.V().local(__.out().order().by(${by})).values('name')`],
    ['inside map().fold()', (by) => `g.V().map(__.out().order().by(${by}).values('name').fold())`],
    ['after a repeat() body', (by) => `g.V().repeat(__.out()).times(2).order().by(${by}).values('name')`],
  ];
  for (const [key, by, oracle] of KEYS) {
    for (const [where, query] of ORDER) {
      test(`order().by(${key}) ${where}`, async () => expect(await ordered(query(by))).toEqual(await ordered(query(oracle))));
    }
    test(`order().by(${key}) in a union() arm`, async () =>
      expect(await answer(`g.V().union(__.out().order().by(${by}), __.identity()).values('name')`))
        .toEqual(await answer(`g.V().union(__.out().order().by(${oracle}), __.identity()).values('name')`)));
    for (const [where, query] of [
      ['after out()', (b: string) => `g.V().out().dedup().by(${b}).values('name')`],
      ['inside local()', (b: string) => `g.V().local(__.out().dedup().by(${b})).values('name')`],
      ['in a union() arm', (b: string) => `g.V().union(__.out().dedup().by(${b}), __.identity()).values('name')`],
    ] as const) {
      test(`dedup().by(${key}) ${where}`, async () => expect(await answer(query(by))).toEqual(await answer(query(oracle))));
    }
  }

  test("a selected label's transformed key after the hop", async () =>
    expect(await ordered("g.V().as('a').out().order().by(select('a').values('name').toLower()).select('a').values('name')"))
      .toEqual(await ordered("g.V().as('a').out().order().by(select('a').values('name')).select('a').values('name')")));

  test('the case-insensitive sort an application writes', async () =>
    expect(await ordered("g.V().hasLabel('person').out('knows').order().by(values('name').toLower()).values('name')"))
      .toEqual(['josh', 'vadas']));

  test('a raising key still raises its own message after the hop, not an internal Error', () =>
    expect(() => executeQuery(store, "g.V().out().order().by(values('age').toLower())"))
      .toThrow('The toLower() step can only take string as argument'));
});

// COMPUTE ONCE: the key's correlated reads — its value and its per-row tag — are read ONCE per row, below
// both nodes that spell the key (the productivity filter and the sort window; the filter and the rank
// window for a dedup). The LET's raising body stays where it is; only its unconditionally evaluated cells
// land as columns. Before, each node re-read both, so a one-step key read the property four times per row
// (+45% at 8k vertices). `.id()` keeps the framing's own property read out of the count, and `group()`
// never had the duplicate (its key is one node) and must not gain one.
describe("a transformed key's property is read once per row", () => {
  const reads = (g: string): number => {
    const p = compile(g, {});
    const sql = p.kind === 'read' ? p.sql : p.steps.map((s) => s.emitted.sql).join('\n');
    return sql.match(/vertex_properties/g)?.length ?? 0;
  };
  for (const g of [
    "g.V().order().by(values('name').toUpper()).id()",
    "g.V().out().order().by(values('name').toLower().toUpper()).id()",
    "g.V().out().order().by(values('age').math('_+1')).id()",
    "g.V().local(__.out().order().by(values('name').toLower())).id()",
    "g.V().dedup().by(values('name').substring(0,1)).id()",
    "g.V().group().by(values('name').substring(0,1)).by(constant(1))",
  ]) {
    test(g, () => expect(reads(g)).toBe(2));
  }
});
