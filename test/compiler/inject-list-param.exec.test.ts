// A user LIST parameter as a LIST TRAVERSER — `inject($ns)` — crosses as ONE `jsonb(?)` bind, the same
// rule `within($ns)` follows (`within-param.exec.test.ts`): a user parameter is one bind, and a set sized
// by DATA is one JSON value. Before, `listLiteralBlob` spelled it member by member as `jsonb_array(…)`,
// one SQL function argument per member, so `inject($ns)` with a few thousand members raised SQLite's own
// bare `too many arguments on function jsonb_array` — a refusal on data size, and the parameter's data
// inlined into the statement text. A literal list whose members are all constants (`constant([…])`)
// takes the same JS encoding as ONE compiler JSON text, so its statement is one argument too.
//
// Every run here is against a `CfLimitedSql` store, so a statement a Durable Object would reject fails.
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { CfLimitedSql } from '../../src/cf-limits.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll, typedAll } from '../support/decode.ts';
import type { TypeNode } from '../../src/gremlin/types.ts';

const limited = () => {
  const store = new GraphStore(new CfLimitedSql(new BunSqlite(':memory:')));
  for (const q of MODERN_SEED) executeQuery(store, q);
  return store;
};
const N = 5000;
const ns = Array.from({ length: N }, (_, i) => i);
const values = (g: string, p: Record<string, any> = {}, types: Record<string, TypeNode> = {}) =>
  decodeAll(executeQuery(limited(), g, p, types));
const typed = (g: string, p: Record<string, any> = {}, types: Record<string, TypeNode> = {}) =>
  typedAll(executeQuery(limited(), g, p, types));

describe('inject($list) — ONE jsonb(?) bind at any size', () => {
  test('the plan is one bind, and none of the data is in the statement text', () => {
    const p = compile('g.inject(ns).unfold().count()', { ns }) as any;
    expect(p.kind).toBe('read');
    expect(p.binds).toHaveLength(1);
    expect(p.binds[0]).toBe(JSON.stringify(ns));
    expect(p.sql).toContain('jsonb(?)');
    expect(p.sql).not.toContain('jsonb_array');
    expect(p.sql).not.toContain('4999');
  });

  test(`inject(ns).unfold().count() over ${N} members`, async () =>
    expect(typed('g.inject(ns).unfold().count()', { ns })).toEqual([`${N}L`]));

  test('inject(ns).count() — ONE list traverser', async () =>
    expect(typed('g.inject(ns).count()', { ns })).toEqual(['1L']));

  test('inject(ns).unfold().sum() and an ordered slice read the members', async () => {
    expect(await values('g.inject(ns).unfold().sum()', { ns })).toEqual([N * (N - 1) / 2]);
    expect(await values('g.inject(ns).unfold().order().by(desc).limit(2)', { ns })).toEqual([N - 1, N - 2]);
  });

  test(`inject(ns).unfold().addV('x') writes ${N} vertices`, async () => {
    const store = limited();
    expect(typedAll(executeQuery(store, "g.inject(ns).unfold().addV('x').count()", { ns }))).toEqual([`${N}L`]);
    expect(typedAll(executeQuery(store, "g.V().hasLabel('x').count()"))).toEqual([`${N}L`]);
  });

  test('the list round-trips whole, in order', async () => {
    const [list] = await values('g.inject(ns)', { ns }) as number[][];
    expect(list).toEqual(ns);
  });

  test('two list arguments are two list traversers of one parameter, still one bind', async () => {
    const p = compile('g.inject(ns, ns).count(local)', { ns }) as any;
    expect(p.binds).toHaveLength(1);
    expect(typed('g.inject(ns, ns).count(local)', { ns })).toEqual([`${N}L`, `${N}L`]);
  });

  test('beside within($ns) — one JSON value, one key, both sites read it', async () =>
    expect(typed('g.inject(ns).unfold().is(within(ns)).count()', { ns })).toEqual([`${N}L`]));
});

describe('a TYPED member list keeps every member\'s class', () => {
  test('long members are Longs, and the list is one bind', async () => {
    const longs: Record<string, TypeNode> = { ns: { t: 'list', items: ns.map(() => 'long') } };
    const p = compile('g.inject(ns).unfold()', { ns }, undefined, longs) as any;
    expect(p.binds).toHaveLength(1);
    const rows = typed('g.inject(ns).unfold()', { ns }, longs);
    expect(rows).toHaveLength(N);
    expect(rows.slice(0, 3)).toEqual(['0L', '1L', '2L']);
    expect(typed('g.inject(ns).unfold().sum()', { ns }, longs)).toEqual([`${N * (N - 1) / 2}L`]);
  });

  test('double members — a whole one stays a Double, a 17-digit one stays exact', async () => {
    const ds = [2, 0.5, 0.30000000000000004, 1.2345678901234568e16];
    const types: Record<string, TypeNode> = { ds: { t: 'list', items: ds.map(() => 'double') } };
    expect(typed('g.inject(ds).unfold()', { ds }, types)).toEqual(['2d', '0.5d', '0.30000000000000004d', '12345678901234568d']);
    expect(typed('g.inject(ds)', { ds }, types)).toEqual(['[2d,0.5d,0.30000000000000004d,12345678901234568d]']);
  });

  test('beside within($ds), an ENVELOPED encoding does not share the within bind', async () => {
    const ds = [2, 3];
    const types: Record<string, TypeNode> = { ds: { t: 'list', items: ['long', 'long'] } };
    const p = compile('g.inject(ds).unfold().is(within(ds))', { ds }, undefined, types) as any;
    expect(p.binds).toHaveLength(2);
    expect(typed('g.inject(ds).unfold().is(within(ds))', { ds }, types)).toEqual(['2L', '3L']);
  });

  test('a boolean member still declines, at any size', () =>
    expect(() => executeQuery(limited(), 'g.inject(bs)', { bs: [true, false] })).toThrow(/not supported/));
});

describe('a LITERAL list of constants past SQLite\'s function-argument cap', () => {
  const literal = `[${Array.from({ length: 2000 }, (_, i) => i).join(',')}]`;

  test('constant([…2000]).unfold().count() — one compiler JSON text, zero binds', async () => {
    const g = `g.V().constant(${literal}).unfold().count()`;
    const p = compile(g, {}) as any;
    expect(p.binds).toHaveLength(0);
    expect(p.sql).not.toContain('jsonb_array');
    expect(typed(g)).toEqual([`${6 * 2000}L`]);
  });

  test('inject([…2000]).unfold().count()', async () =>
    expect(typed(`g.inject(${literal}).unfold().count()`)).toEqual(['2000L']));

  test('a typed literal keeps its envelopes and spellings', async () =>
    expect(typed('g.inject([1, 2.0d, 3L, 0.30000000000000004d, 1.5f, null, "a"])')).toEqual(
      ['[1i,2d,3L,0.30000000000000004d,1.5f,null,"a"]']));
});
