import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { check } from '../src/rel/check.ts';
import { col, lit } from '../src/rel/expr.ts';
import { emitStmt } from '../src/rel/emit.ts';
import { scan, values } from '../src/rel/factory.ts';
import { isStmt } from '../src/rel/stmt.ts';
import { insert, remove, update } from '../src/rel/stmt-factory.ts';
import { relId } from '../src/rel/types.ts';

const layout = { aliases: new Map(), origins: [], branchOrders: [] } as const;
const ids = [{ name: 'id', type: 'int', nullable: false }] as const;
const nodes = scan({ id: relId('nodes'), table: 'nodes', alias: 'nodes', layout, type: { cols: ids } });

describe('RelIR statements', () => {
  test('constructs branded named write nodes', () => {
    const source = values({ id: relId('source'), rows: [[lit(1, 'int')]], layout, type: { cols: ids } });
    const write = insert({ target: nodes, cols: ['id'], source, returning: [['id', lit(1, 'int')]] });
    expect(isStmt(write)).toBe(true);
    expect(() => check(write)).not.toThrow();
  });

  test('requires Delete.using to identify physical rows by id', () => {
    const noId = values({ id: relId('noId'), rows: [[lit('x', 'text')]], layout,
      type: { cols: [{ name: 'name', type: 'text', nullable: false }] },
    });
    const write = remove({ target: nodes, using: noId, returning: [] });
    expect(() => check(write)).toThrow('Delete.using must emit an id column');
  });

  test('emits Delete.using as SQLite id membership', () => {
    const doomed = values({ id: relId('doomed'), rows: [[lit(2, 'int')]], layout, type: { cols: ids } });
    const emitted = emitStmt(remove({ target: nodes, using: doomed, returning: [] }));
    expect(emitted.sql).toBe('DELETE FROM nodes WHERE id IN (SELECT id FROM (SELECT column1 AS id FROM (VALUES (?))) doomed)');
    expect(emitted.binds).toEqual([2]);
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER PRIMARY KEY)');
    db.run('INSERT INTO nodes VALUES (1), (2)');
    db.run(emitted.sql, ...emitted.binds);
    expect(db.query('SELECT id FROM nodes').all()).toEqual([{ id: 1 }]);
    db.close();
  });

  test('checks statement source arity and local SQL names at construction', () => {
    const source = values({ id: relId('source'), rows: [[lit(1, 'int')]], layout, type: { cols: ids } });
    const wrongArity = insert({ target: nodes, cols: ['id', 'uid'], source, returning: [] });
    expect(() => check(wrongArity)).toThrow('Insert has 2 target columns but source emits 1');
    expect(() => update({ target: nodes, set: [['uid', lit('x', 'text')], ['uid', lit('y', 'text')]], returning: [] }))
      .toThrow('duplicate Update assignment name');
  });

  test('checks target expressions in their target Scan scope', () => {
    const write = update({ target: nodes, set: [['id', col(nodes.id, 'missing')]], returning: [['id', col(nodes.id, 'id')]] });
    expect(() => check(write)).toThrow("has no declared column 'missing'");
  });

  test('counts statement-expression binds against the Durable Objects limit', () => {
    const write = update({ target: nodes, set: [['name', lit('x', 'text')]],
      returning: Array.from({ length: 100 }, (_, i) => [`r${i}`, lit(i, 'int')] as const),
    });
    expect(() => check(write)).toThrow('101 binds exceeds Durable Objects cap of 100');
  });
});
