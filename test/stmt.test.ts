import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { check } from '../src/rel/check.ts';
import { col, lit } from '../src/rel/expr.ts';
import { emitSequence, emitStmt } from '../src/rel/emit.ts';
import { priorResult, scan, values } from '../src/rel/factory.ts';
import { isStmt } from '../src/rel/stmt.ts';
import { insert, remove, sequence, update } from '../src/rel/stmt-factory.ts';
import { relId } from '../src/rel/types.ts';

const layout = { aliases: new Map(), origins: [], branchOrders: [] } as const;
const ids = [{ name: 'id', type: 'int', nullable: false }] as const;
const noReturning = { cols: [] } as const;
const nodes = scan({ id: relId('nodes'), table: 'nodes', alias: 'nodes', layout,
  type: { cols: [{ name: 'id', type: 'int', nullable: false }, { name: 'uid', type: 'text', nullable: true }] },
});

describe('RelIR statements', () => {
  test('constructs branded named write nodes', () => {
    const source = values({ id: relId('source'), rows: [[lit(1, 'int')]], layout, type: { cols: ids } });
    const write = insert({ target: nodes, cols: ['id'], source, returning: [['id', lit(1, 'int')]], returningType: { cols: ids } });
    expect(isStmt(write)).toBe(true);
    expect(() => check(write)).not.toThrow();
  });

  test('requires Delete.using to identify physical rows by id', () => {
    const noId = values({ id: relId('noId'), rows: [[lit('x', 'text')]], layout,
      type: { cols: [{ name: 'name', type: 'text', nullable: false }] },
    });
    const write = remove({ target: nodes, using: noId, returning: [], returningType: noReturning });
    expect(() => check(write)).toThrow('Delete.using must emit an id column');
  });

  test('emits Delete.using as SQLite id membership', () => {
    const doomed = values({ id: relId('doomed'), rows: [[lit(2, 'int')]], layout, type: { cols: ids } });
    const emitted = emitStmt(remove({ target: nodes, using: doomed, returning: [], returningType: noReturning }));
    expect(emitted.sql).toBe('DELETE FROM nodes WHERE id IN (SELECT id FROM (SELECT column1 AS id FROM (VALUES (?))) doomed)');
    expect(emitted.binds).toEqual([2]);
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER PRIMARY KEY)');
    db.run('INSERT INTO nodes VALUES (1), (2)');
    db.run(emitted.sql, ...emitted.binds);
    expect(db.query('SELECT id FROM nodes').all()).toEqual([{ id: 1 }]);
    db.close();
  });

  test('emits executable insert and update expressions', () => {
    const source = values({ id: relId('newNode'), rows: [[lit(3, 'int'), lit('c', 'text')]], layout,
      type: { cols: [{ name: 'id', type: 'int', nullable: false }, { name: 'uid', type: 'text', nullable: false }] },
    });
    const insertSql = emitStmt(insert({ target: nodes, cols: ['id', 'uid'], source, returning: [], returningType: noReturning }));
    const updateSql = emitStmt(update({ target: nodes, set: [['uid', lit('updated', 'text')]], where: { kind: 'binary', op: '=', left: col(nodes.id, 'id'), right: lit(3, 'int') }, returning: [], returningType: noReturning }));
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER PRIMARY KEY, uid TEXT)');
    db.run(insertSql.sql, ...insertSql.binds);
    db.run(updateSql.sql, ...updateSql.binds);
    expect(db.query('SELECT id, uid FROM nodes').all()).toEqual([{ id: 3, uid: 'updated' }]);
    db.close();
  });

  test('emits a Sequence as ordered SQLite statements', () => {
    const source = values({ id: relId('sequenceNode'), rows: [[lit(4, 'int'), lit('d', 'text')]], layout,
      type: { cols: [{ name: 'id', type: 'int', nullable: false }, { name: 'uid', type: 'text', nullable: false }] },
    });
    const statements = emitSequence(sequence({ steps: [
      insert({ target: nodes, cols: ['id', 'uid'], source, returning: [], returningType: noReturning }),
      update({ target: nodes, set: [['uid', lit('sequenced', 'text')]], where: { kind: 'binary', op: '=', left: col(nodes.id, 'id'), right: lit(4, 'int') }, returning: [], returningType: noReturning }),
    ] }));
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER PRIMARY KEY, uid TEXT)');
    for (const statement of statements) db.run(statement.sql, ...statement.binds);
    expect(db.query('SELECT id, uid FROM nodes').all()).toEqual([{ id: 4, uid: 'sequenced' }]);
    db.close();
  });

  test('types PriorResult from an earlier Sequence returningType', () => {
    const source = values({ id: relId('priorSource'), rows: [[lit(5, 'int')]], layout, type: { cols: ids } });
    const prior = priorResult({ id: relId('prior'), step: 0, layout, type: { cols: ids } });
    const plan = sequence({ steps: [
      insert({ target: nodes, cols: ['id'], source, returning: [['id', col(nodes.id, 'id')]], returningType: { cols: ids } }),
      remove({ target: nodes, using: prior, returning: [], returningType: noReturning }),
    ] });
    expect(() => check(plan)).not.toThrow();
  });

  test('checks statement source arity and local SQL names at construction', () => {
    const source = values({ id: relId('source'), rows: [[lit(1, 'int')]], layout, type: { cols: ids } });
    const wrongArity = insert({ target: nodes, cols: ['id', 'uid'], source, returning: [], returningType: noReturning });
    expect(() => check(wrongArity)).toThrow('Insert has 2 target columns but source emits 1');
    expect(() => update({ target: nodes, set: [['uid', lit('x', 'text')], ['uid', lit('y', 'text')]], returning: [], returningType: noReturning }))
      .toThrow('duplicate Update assignment name');
  });

  test('checks target expressions in their target Scan scope', () => {
    const write = update({ target: nodes, set: [['id', col(nodes.id, 'missing')]], returning: [['id', col(nodes.id, 'id')]], returningType: { cols: ids } });
    expect(() => check(write)).toThrow("has no declared column 'missing'");
  });

  test('counts statement-expression binds against the Durable Objects limit', () => {
    const write = update({ target: nodes, set: [['uid', lit('x', 'text')]],
      returning: Array.from({ length: 100 }, (_, i) => [`r${i}`, lit(i, 'int')] as const),
      returningType: { cols: Array.from({ length: 100 }, (_, i) => ({ name: `r${i}`, type: 'int' as const, nullable: false })) },
    });
    expect(() => check(write)).toThrow('101 binds exceeds Durable Objects cap of 100');
  });
});
