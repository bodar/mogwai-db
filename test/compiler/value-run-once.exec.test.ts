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
