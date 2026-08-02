import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { check } from '../src/rel/check.ts';
import { col, lit } from '../src/rel/expr.ts';
import { emit, isRowsBind } from '../src/rel/emit.ts';
import { ref, scan, values } from '../src/rel/factory.ts';
import { plan } from '../src/rel/plan.ts';
import type { Binding } from '../src/rel/plan.ts';
import { isStmt } from '../src/rel/stmt.ts';
import { insert, remove, update } from '../src/rel/stmt-factory.ts';
import { relId } from '../src/rel/types.ts';

const layout = { aliases: new Map(), origins: [], branchOrders: [] } as const;
const ids = [{ name: 'id', type: 'int', nullable: false }] as const;
const noReturning = { cols: [] } as const;
const nodes = scan({ id: relId('nodes'), table: 'nodes', alias: 'nodes', layout,
  type: { cols: [{ name: 'id', type: 'int', nullable: false }, { name: 'uid', type: 'text', nullable: true }] },
});
const nothing = values({ id: relId('nothing'), rows: [], layout, type: noReturning });

/** A write program: the statements are bindings, in order, and the plan's result is the last one's
 * retained rows — §3.0's "ordering IS the bindings list", with no `Sequence` node to own it. */
const program = (...steps: readonly { readonly name: string; readonly node: Binding['node'] }[]) => {
  const last = steps[steps.length - 1]!;
  const node = last.node;
  return plan({
    bindings: steps,
    result: isStmt(node) ? ref({ id: relId(`${last.name}_ref`), name: last.name, layout: node.layout, type: node.type }) : nothing,
  });
};

describe('RelIR statements', () => {
  test('constructs branded named write nodes', () => {
    const source = values({ id: relId('source'), rows: [[lit(1, 'int')]], layout, type: { cols: ids } });
    const write = insert({ target: nodes, cols: ['id'], source, returning: [['id', lit(1, 'int')]], layout, type: { cols: ids } });
    expect(isStmt(write)).toBe(true);
    expect(() => check(write)).not.toThrow();
  });

  test('requires Delete.using to identify physical rows by id', () => {
    const noId = values({ id: relId('noId'), rows: [[lit('x', 'text')]], layout,
      type: { cols: [{ name: 'name', type: 'text', nullable: false }] },
    });
    const write = remove({ target: nodes, using: noId, returning: [], layout, type: noReturning });
    expect(() => check(write)).toThrow('Delete.using must emit an id column');
  });

  test('emits Delete.using as SQLite id membership', () => {
    const doomed = values({ id: relId('doomed'), rows: [[lit(2, 'int')]], layout, type: { cols: ids } });
    const steps = emit(program({ name: 'drop', node: remove({ target: nodes, using: doomed, returning: [], layout, type: noReturning }) }));
    const emitted = steps[0]!.emitted;
    expect(emitted.sql).toBe('DELETE FROM nodes WHERE id IN (SELECT doomed.column1 FROM (VALUES (?)) doomed)');
    expect(emitted.binds).toEqual([2]);
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER PRIMARY KEY)');
    db.run('INSERT INTO nodes VALUES (1), (2)');
    db.run(emitted.sql, ...emitted.binds);
    expect(db.query('SELECT id FROM nodes').all()).toEqual([{ id: 1 }]);
    db.close();
  });

  test('a Plan is an ORDERED program: statement bindings are steps, in order', () => {
    const source = values({ id: relId('sequenceNode'), rows: [[lit(4, 'int'), lit('d', 'text')]], layout,
      type: { cols: [{ name: 'id', type: 'int', nullable: false }, { name: 'uid', type: 'text', nullable: false }] },
    });
    const steps = emit(program(
      { name: 'add', node: insert({ target: nodes, cols: ['id', 'uid'], source, returning: [], layout, type: noReturning }) },
      { name: 'rename', node: update({ target: nodes, set: [['uid', lit('sequenced', 'text')]], where: { kind: 'binary', op: '=', left: col(nodes.id, 'id'), right: lit(4, 'int') }, returning: [], layout, type: noReturning }) },
    ));
    expect(steps.map((step) => step.binding)).toEqual(['add', 'rename']);
    // The last statement IS the result: there is nothing left to query for rows the executor holds.
    expect(steps.map((step) => step.result)).toEqual([false, true]);

    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER PRIMARY KEY, uid TEXT)');
    for (const step of steps) db.run(step.emitted.sql, ...step.emitted.binds);
    expect(db.query('SELECT id, uid FROM nodes').all()).toEqual([{ id: 4, uid: 'sequenced' }]);
    db.close();
  });

  test("a Ref to a statement binding is ONE JSON bind the executor fills, never a placeholder list", () => {
    const source = values({ id: relId('priorSource'), rows: [[lit(5, 'int')]], layout, type: { cols: ids } });
    const added = insert({ target: nodes, cols: ['id'], source, returning: [['id', col(nodes.id, 'id')]], layout, type: { cols: ids } });
    const prior = ref({ id: relId('prior'), name: 'added', layout, type: { cols: ids } });
    const steps = emit(plan({
      bindings: [{ name: 'added', node: added }, { name: 'removed', node: remove({ target: nodes, using: prior, returning: [], layout, type: noReturning }) }],
      result: nothing,
    }));

    const membership = steps[1]!.emitted;
    expect(membership.sql).toBe("DELETE FROM nodes WHERE id IN (SELECT json_extract(prior.value, ?) FROM json_each(?) prior)");
    expect(membership.binds.filter(isRowsBind)).toEqual([{ rowsOf: 'added' }]);
  });

  test('a Ref must resolve to a binding declared BEFORE it', () => {
    const later = ref({ id: relId('later'), name: 'later', layout, type: { cols: ids } });
    expect(() => emit(plan({ bindings: [{ name: 'later', node: later }], result: later })))
      .toThrow("Ref 'later' is not a Plan binding declared before this point");
  });

  test('checks statement source arity and local SQL names at construction', () => {
    const source = values({ id: relId('source'), rows: [[lit(1, 'int')]], layout, type: { cols: ids } });
    const wrongArity = insert({ target: nodes, cols: ['id', 'uid'], source, returning: [], layout, type: noReturning });
    expect(() => check(wrongArity)).toThrow('Insert has 2 target columns but source emits 1');
    expect(() => update({ target: nodes, set: [['uid', lit('x', 'text')], ['uid', lit('y', 'text')]], returning: [], layout, type: noReturning }))
      .toThrow('duplicate Update assignment name');
  });

  test('checks target expressions in their target Scan scope', () => {
    const write = update({ target: nodes, set: [['id', col(nodes.id, 'missing')]], returning: [['id', col(nodes.id, 'id')]], layout, type: { cols: ids } });
    expect(() => check(write)).toThrow("has no declared column 'missing'");
  });

  test('counts statement-expression binds against the Durable Objects limit', () => {
    const write = update({ target: nodes, set: [['uid', lit('x', 'text')]],
      returning: Array.from({ length: 100 }, (_, i) => [`r${i}`, lit(i, 'int')] as const),
      layout, type: { cols: Array.from({ length: 100 }, (_, i) => ({ name: `r${i}`, type: 'int' as const, nullable: false })) },
    });
    expect(() => check(write)).toThrow('101 binds exceeds Durable Objects cap of 100');
  });
});
