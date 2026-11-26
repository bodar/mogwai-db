// The PROPERTY-TABLE authority (`PROPERTIES` / `propertyScan` / `propertyRows` in
// `src/compiler/rel/build.ts`): one column list, in one order, that every property read and write derives
// its Scan from. Every join over a property scan is POSITIONAL (`src/rel/emit.ts` join select), so these
// pin that the declared list IS the physical table and that the reads deriving their join type from it
// map each column to its own value.
import { test, expect, describe } from 'bun:test';
import { bagOf, bare, run, seededStore, zooStore } from '../support/harness.ts';
import { col, compilerInt } from '../../src/rel/expr.ts';
import * as make from '../../src/rel/factory.ts';
import { emitQuery } from '../../src/rel/emit.ts';
import { planOf } from '../../src/rel/plan.ts';
import { meta, minter, PROPERTIES, propertyRows, typeOf } from '../../src/compiler/rel/build.ts';
import type { Elem } from '../../src/compiler/elem.ts';

const values = (rows: readonly unknown[]): unknown[] => bare(rows).map((row: { v: unknown }) => row.v);

describe('PROPERTIES — the property tables as the algebra sees them', () => {
  test.each(['vertex', 'edge'] as const)('the %s column list is exactly the physical table', (kind: Elem) => {
    const store = seededStore();
    const physical = (store.query(`SELECT name FROM pragma_table_info('${PROPERTIES[kind].table}')`, []) as { name: string }[])
      .map((row) => row.name);
    expect(bagOf(PROPERTIES[kind].cols.map((c) => c.name))).toEqual(bagOf(physical));
    expect(PROPERTIES[kind].cols.map((c) => c.name)).toContain(PROPERTIES[kind].owner);
  });

  test("propertyRows' `of` keeps only that owner's rows", () => {
    const store = seededStore();
    const fresh = minter();
    const rows = propertyRows('vertex', fresh, { of: compilerInt(1) });
    const out = make.project({ id: fresh('p'), input: rows, channels: [], type: typeOf(meta('k', 'text')), exprs: [['k', col(rows.id, 'key')]] });
    const { sql, binds } = emitQuery(planOf(out));
    expect(bagOf((store.query(sql, binds as never[]) as { k: string }[]).map((row) => row.k))).toEqual(bagOf(['name', 'age']));
  });
});

describe('a positional join over a property scan maps every column to its own value', () => {
  test('values() reads the value, and a multi-valued key folds in insertion order', () => {
    expect(bagOf(values(run(seededStore(), "g.V().values('name')")))).toEqual(bagOf(['marko', 'vadas', 'lop', 'josh', 'ripple', 'peter']));
    // The zoo's list-cardinality keys: `pord` (the row id) must be the property's own id, or the fold
    // order is the scan's — which L8 reverses.
    const store = zooStore();
    const diets = bare(run(store, "g.V().has('diet', 'krill').local(__.values('diet').fold())")).map((row: { list: string }) => JSON.parse(row.list));
    expect(diets).toEqual([['fish', 'krill', 'squid']]);
  });

  test('the property stream and its owner read back under a host', () => {
    const store = seededStore();
    expect(values(run(store, "g.V().properties('name').key()"))).toEqual(Array(6).fill('name'));
    expect(values(run(store, "g.V().properties('name').element().count()"))).toEqual([6]);
    expect(values(run(store, "g.V().where(__.properties('age').value().is(gt(30))).values('name')")).sort()).toEqual(['josh', 'peter']);
    expect(values(run(store, "g.E().properties().value().sum()"))).toEqual([3.5]);
  });
});
