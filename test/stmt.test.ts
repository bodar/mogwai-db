import { describe, expect, test } from 'bun:test';
import { check } from '../src/rel/check.ts';
import { lit } from '../src/rel/expr.ts';
import * as rel from '../src/rel/factory.ts';
import { isStmt } from '../src/rel/stmt.ts';
import * as stmt from '../src/rel/stmt-factory.ts';
import { relId } from '../src/rel/types.ts';

const layout = { aliases: new Map(), origins: [], branchOrders: [] } as const;
const ids = [{ name: 'id', type: 'int', nullable: false }] as const;

describe('RelIR statements', () => {
  test('constructs branded named write nodes', () => {
    const source = rel.values({ id: relId('source'), rows: [[lit(1, 'int')]], layout, type: { cols: ids } });
    const write = stmt.insert({ table: 'nodes', cols: ['id'], source, returning: [['id', lit(1, 'int')]] });
    expect(isStmt(write)).toBe(true);
    expect(() => check(write)).not.toThrow();
  });

  test('requires Delete.using to identify physical rows by id', () => {
    const noId = rel.values({ id: relId('noId'), rows: [[lit('x', 'text')]], layout,
      type: { cols: [{ name: 'name', type: 'text', nullable: false }] },
    });
    const write = stmt.remove({ table: 'nodes', using: noId, returning: [] });
    expect(() => check(write)).toThrow('Delete.using must emit an id column');
  });

  test('checks statement source arity and local SQL names at construction', () => {
    const source = rel.values({ id: relId('source'), rows: [[lit(1, 'int')]], layout, type: { cols: ids } });
    const wrongArity = stmt.insert({ table: 'nodes', cols: ['id', 'uid'], source, returning: [] });
    expect(() => check(wrongArity)).toThrow('Insert has 2 target columns but source emits 1');
    expect(() => stmt.update({ table: 'nodes', set: [['uid', lit('x', 'text')], ['uid', lit('y', 'text')]], returning: [] }))
      .toThrow('duplicate Update assignment name');
  });

  test('counts statement-expression binds against the Durable Objects limit', () => {
    const write = stmt.update({ table: 'nodes', set: [['name', lit('x', 'text')]],
      returning: Array.from({ length: 100 }, (_, i) => [`r${i}`, lit(i, 'int')] as const),
    });
    expect(() => check(write)).toThrow('101 binds exceeds Durable Objects cap of 100');
  });
});
