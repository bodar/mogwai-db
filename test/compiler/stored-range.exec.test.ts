// AN ORDERING ON A STORED PROPERTY IS AN INDEX RANGE PLUS A TYPE RESIDUAL (`storedRange`,
// src/compiler/rel/predicate.ts). The range uses SQLite's storage-class order (NULL < numbers < TEXT <
// BLOB), so it can hold rows of another Gremlin type that share the storage class: a Boolean's 0/1 and a
// Date's epoch millis among the numbers, a UUID among the Strings. The residual vtype test keeps them out.
// These tests pin the answers over one key that holds every type at once; the plans are in
// test/plan-stability.test.ts.
import { describe, expect, test } from 'bun:test';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';

const UUID_ROW = '6f2c1b2a-0000-4000-8000-000000000001';
const mixed = (): GraphStore => {
  const s = new GraphStore(new BunSqlite(':memory:'));
  for (const w of [
    "g.addV('t').property('k', 29)", "g.addV('t').property('k', 30)", "g.addV('t').property('k', 29.5m)",
    "g.addV('t').property('k', 29.5d)", "g.addV('t').property('k', 100L)",
    "g.addV('t').property('k', 123456789012345678901234567890n)", "g.addV('t').property('k', true)",
    "g.addV('t').property('k', datetime('2010-06-01T00:00:00Z'))", "g.addV('t').property('k', 'apple')",
    "g.addV('t').property('k', 'zebra')", `g.addV('t').property('k', UUID('${UUID_ROW}'))`,
    "g.addV('t').property('k', [1, 2])",
  ]) executeQuery(s, w, {});
  return s;
};
const show = (v: any): string => typeof v === 'bigint' ? `${v}n`
  : v && typeof v === 'object' && 'unscaled' in v ? `${v.unscaled}e-${v.scale}m`
    : v instanceof Date ? v.toISOString() : typeof v === 'object' && v !== null ? String(v) : JSON.stringify(v);
const answer = async (q: string): Promise<string[]> => (await decodeAll(executeQuery(mixed(), q, {}))).map(show).sort();

describe('a numeric range on a stored key', () => {
  test('gt keeps every Number above the bound — a stored 29.5m included — and no Boolean, Date or String', async () => {
    expect(await answer("g.V().has('k', gt(29)).values('k')"))
      .toEqual(['100', '123456789012345678901234567890n', '29.5', '295e-1m', '30'].sort());
  });
  test('lte(1) does not read a stored true as 1', async () => {
    expect(await answer("g.V().has('k', lte(1)).count()")).toEqual(['0']);
  });
  test('between / inside / outside', async () => {
    expect(await answer("g.V().has('k', between(29, 30)).count()")).toEqual(['3']);
    expect(await answer("g.V().has('k', inside(29, 31)).count()")).toEqual(['3']);
    expect(await answer("g.V().has('k', outside(29.5, 50)).count()")).toEqual(['3']);
  });
  test('a BigDecimal and a BigInteger bound meet the stored comparable form', async () => {
    expect(await answer("g.V().has('k', gt(29.25m)).count()")).toEqual(['5']);
    expect(await answer("g.V().has('k', lt(123456789012345678901234567891n)).count()")).toEqual(['5']);
  });
});

describe('a datetime range on a stored key', () => {
  test('between two dates keeps the Date, never a Number of the same millis range', async () => {
    expect(await answer("g.V().has('k', between(datetime('2010-01-01T00:00:00Z'), datetime('2011-01-01T00:00:00Z'))).count()")).toEqual(['1']);
    expect(await answer("g.V().has('k', gt(datetime('1970-01-01T00:00:00Z'))).count()")).toEqual(['1']);
  });
});

describe('a string range on a stored key', () => {
  test('gt / lt keep Strings only — no UUID, no Number, no collection', async () => {
    expect(await answer("g.V().has('k', gt('m')).values('k')")).toEqual(['"zebra"']);
    expect(await answer("g.V().has('k', lt('m')).values('k')")).toEqual(['"apple"']);
    expect(await answer("g.V().has('k', gte('')).count()")).toEqual(['2']);
  });
  test('a UUID bound orders the UUID row only', async () => {
    expect(await answer("g.V().has('k', lt(UUID('ff2c1b2a-0000-4000-8000-000000000001'))).count()")).toEqual(['1']);
  });
  test('a range across two type spaces is empty', async () => {
    expect(await answer("g.V().has('k', between(1, 'z')).count()")).toEqual(['0']);
  });
});

describe('the range composes', () => {
  test('negated, after a hop, in a child body, and in a disjunction', async () => {
    expect(await answer("g.V().has('k', not(gt(29))).count()")).toEqual(['7']);
    expect(await answer("g.V().not(has('k', gt(29))).count()")).toEqual(['7']);
    expect(await answer("g.V().where(has('k', gt(29))).count()")).toEqual(['5']);
    expect(await answer("g.V().local(has('k', gt(29)).values('k')).count()")).toEqual(['5']);
    expect(await answer("g.V().has('k', gt(29).or(lt('b'))).count()")).toEqual(['6']);
    expect(await answer("g.V().union(has('k', gt(29)), has('k', gt('m'))).count()")).toEqual(['6']);
  });
});
