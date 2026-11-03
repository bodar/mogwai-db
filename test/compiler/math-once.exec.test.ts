// `math()` over a value LABEL spells each variable ONCE (`once`, `src/compiler/rel/build.ts`).
//
// A label's value is a per-row read (`json_extract` of its history), and the formula names a variable once
// per use, its Number test names it again, and the NaN guard once more — so before `once` the statement
// text grew O(uses × read): `values('age').as('a').math('a+…+a')` with ten uses was ~60 KB, and seventeen
// uses passed every bun:sqlite test while a Durable Object (100 KB statement cap) rejected it. Every run
// here is against a `CfLimitedSql` store, so a statement a DO would reject fails here too.
import { test, expect, describe } from 'bun:test';
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
const values = (g: string) => decodeAll(executeQuery(store, g));
const sqlBytes = (g: string) => {
  const p = compile(g, {});
  if (p.kind !== 'read') throw new Error('expected a read plan');
  return p.sql.length;
};
const uses = (n: number) => Array.from({ length: n }, () => 'a').join('+');
const AGES = [29, 27, 32, 35];

describe('math() over a value label — each variable spelled once', () => {
  test('ten uses of one label stay a few KB, and answer', async () => {
    const q = `g.V().values('age').as('a').math('${uses(10)}')`;
    expect(sqlBytes(q)).toBeLessThan(6 * 1024);
    expect(bagOf(await values(q))).toEqual(bagOf(AGES.map((a) => a * 10)));
  });

  test('seventeen uses run under the DO statement cap', async () => {
    const q = `g.V().values('age').as('a').math('${uses(17)}').sum()`;
    expect(sqlBytes(q)).toBeLessThan(8 * 1024);
    expect(await values(q)).toEqual([AGES.reduce((s, a) => s + a, 0) * 17]);
  });

  test('a label read through a branch arm and a local body keeps its answer', async () => {
    expect(bagOf(await values("g.V().local(values('age').as('a').math('a*2'))"))).toEqual(bagOf(AGES.map((a) => a * 2)));
    expect(bagOf(await values("g.V().union(values('age').as('a').math('a+1'), constant(1))")))
      .toEqual(bagOf([...AGES.map((a) => a + 1), 1, 1, 1, 1, 1, 1]));
  });

  test('a REAL keeps all its digits — the once row is a VALUES cell, not a JSON transport', async () =>
    expect(await values("g.inject(0.1d).as('a').math('a*3')")).toEqual([0.30000000000000004]));

  test("the Number test, the reference's raise and the NaN deferral read the held value", () => {
    expect(() => values("g.inject(0.1d, 'x').as('a').math('a*3')")).toThrow('The variable a for math() step must resolve to a Number');
    // First-seen order: `a` is tested before `b`, and only `b` offends.
    expect(() => values("g.V().hasLabel('person').as('a').as('b').math('a+b').by('age').by('name')"))
      .toThrow('The variable b for math() step must resolve to a Number');
    expect(() => values("g.inject(-1).as('a').math('sqrt(a)')")).toThrow('math() producing NaN');
  });
});
