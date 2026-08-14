import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { CfLimitedSql } from '../src/cf-limits.ts';
import { insertSet, deleteMembers, type SetColumn } from '../src/setwrite.ts';

// The set-based write substrate on its own, below the bulk loader: N rows in as ONE relational
// Insert over json_each, a membership Delete over one json_each bind. bulk.test.ts pins the loader's
// graph byte-for-byte; this pins the primitives directly — storage class, the jsonb shape, the empty
// and ragged edges, and the DO bind cap.

const fresh = () => new GraphStore(new BunSqlite(':memory:'));
/** Under the CF-parity store, so any statement past 100 binds fails here as it would on a DO. */
const freshLimited = () => new GraphStore(new CfLimitedSql(new BunSqlite(':memory:')));

const PROP: SetColumn[] = [
  { name: 'id', type: 'int' }, { name: 'node', type: 'int' }, { name: 'key', type: 'text' },
  { name: 'value', type: 'any' }, { name: 'vtype', type: 'text' }, { name: 'meta', type: 'blob', jsonb: true },
];

describe('insertSet', () => {
  test('lands rows and PRESERVES each cell\'s SQLite storage class', () => {
    const store = fresh();
    insertSet(store, 'nodes', [{ name: 'id', type: 'int' }, { name: 'uid', type: 'text' }], [[1, null], [2, 'x']]);
    insertSet(store, 'vertex_properties', PROP, [
      [1, 1, 'age', 42, 'g:Int32', null],
      [2, 2, 'name', 'hi', 'g:String', '{"m":1}'],
      [3, 1, 'score', 3.5, 'g:Double', null],
    ]);
    expect(store.query('SELECT id, uid FROM nodes ORDER BY id')).toEqual([
      { id: 1, uid: null }, { id: 2, uid: 'x' },
    ]);
    // typeof(value) is the point: 42→integer, "hi"→text, 3.5→real — the JSON value's own class, which
    // every numeric order/range predicate rides on, and which AGREES across runtimes.
    expect(store.query(`SELECT id, value, typeof(value) AS tv, json(meta) AS meta FROM vertex_properties ORDER BY id`)).toEqual([
      { id: 1, value: 42, tv: 'integer', meta: null },
      { id: 2, value: 'hi', tv: 'text', meta: '{"m":1}' },
      { id: 3, value: 3.5, tv: 'real', meta: null },
    ]);
  });

  test('an empty batch issues no statement', () => {
    expect(insertSet(fresh(), 'nodes', [{ name: 'id', type: 'int' }], [])).toBe(0);
  });

  test('a non-empty batch issues exactly one statement, whatever the row count', () => {
    const store = fresh();
    const rows = Array.from({ length: 500 }, (_, i) => [i + 1, null] as const);
    expect(insertSet(store, 'nodes', [{ name: 'id', type: 'int' }, { name: 'uid', type: 'text' }], rows)).toBe(1);
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM nodes')[0].n).toBe(500);
  });

  test('a ragged row throws rather than silently shifting the tuple', () => {
    expect(() => insertSet(fresh(), 'nodes', [{ name: 'id', type: 'int' }, { name: 'uid', type: 'text' }], [[1]]))
      .toThrow(/row has 1 values for 2 columns/);
  });

  test('2,000 rows land in one statement under the DO bind cap', () => {
    const store = freshLimited();
    const rows = Array.from({ length: 2000 }, (_, i) => [i + 1, `n${i}`] as const);
    expect(insertSet(store, 'nodes', [{ name: 'id', type: 'int' }, { name: 'uid', type: 'text' }], rows)).toBe(1);
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM nodes')[0].n).toBe(2000);
  });
});

describe('deleteMembers', () => {
  const seeded = () => {
    const store = fresh();
    insertSet(store, 'nodes', [{ name: 'id', type: 'int' }, { name: 'uid', type: 'text' }],
      [[1, null], [2, 'a'], [3, 'b'], [4, 'c']]);
    return store;
  };

  test('removes exactly the members named, by their own storage class', () => {
    const store = seeded();
    expect(deleteMembers(store, 'nodes', 'id', [2, 4])).toBe(1);
    expect(store.query('SELECT id FROM nodes ORDER BY id').map((r: any) => r.id)).toEqual([1, 3]);
  });

  test('matches TEXT keys too (a uid set)', () => {
    const store = seeded();
    deleteMembers(store, 'nodes', 'uid', ['a', 'c']);
    expect(store.query('SELECT id FROM nodes ORDER BY id').map((r: any) => r.id)).toEqual([1, 3]);
  });

  test('an empty id set issues no statement', () => {
    expect(deleteMembers(fresh(), 'nodes', 'id', [])).toBe(0);
  });

  test('2,000 members delete in one statement under the DO bind cap', () => {
    const store = freshLimited();
    insertSet(store, 'nodes', [{ name: 'id', type: 'int' }], Array.from({ length: 2000 }, (_, i) => [i + 1]));
    expect(deleteMembers(store, 'nodes', 'id', Array.from({ length: 2000 }, (_, i) => i + 1))).toBe(1);
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM nodes')[0].n).toBe(0);
  });
});
