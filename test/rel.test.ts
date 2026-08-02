import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { check } from '../src/rel/check.ts';
import { col, lit } from '../src/rel/expr.ts';
import * as rel from '../src/rel/factory.ts';
import { emit } from '../src/rel/emit.ts';
import { fuse } from '../src/rel/passes/fuse.ts';
import { name } from '../src/rel/passes/name.ts';
import { prune } from '../src/rel/passes/prune.ts';
import { relId } from '../src/rel/types.ts';

const layout = { aliases: new Map(), origins: [], branchOrders: [] } as const;
const cols = [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'text', nullable: false }] as const;
const scan = rel.scan({ id: relId('n'), table: 'nodes', alias: 'n', layout, type: { cols } });

describe('RelIR', () => {
  test('emits a checked, bound query through the SQL kernel', () => {
    const plan = rel.project({ id: relId('p'),
      input: scan, layout, type: { cols },
      exprs: [['id', col(scan.id, 'id')], ['name', col(scan.id, 'name')]],
    });
    const filtered = rel.filter({ id: relId('f'), input: plan, layout, type: { cols }, pred: { kind: 'binary', op: '=', left: col(plan.id, 'name'), right: lit('marko', 'text') } });
    const emitted = emit(filtered);
    expect(emitted.binds).toEqual(['marko']);
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko'), (2, 'vadas')");
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual([{ id: 1, name: 'marko' }]);
    db.close();
  });

  test('fails closed on an undeclared column', () => {
    const invalid = rel.filter({ id: relId('f'), input: scan, layout, type: { cols }, pred: col(scan.id, 'missing') });
    expect(() => check(invalid)).toThrow("has no declared column 'missing'");
  });

  test('fuses adjacent filters structurally', () => {
    const first = rel.filter({ id: relId('a'), input: scan, layout, type: { cols }, pred: { kind: 'binary', op: '>', left: col(scan.id, 'id'), right: lit(0, 'int') } });
    const second = rel.filter({ id: relId('b'), input: first, layout, type: { cols }, pred: { kind: 'binary', op: '=', left: col(first.id, 'name'), right: lit('marko', 'text') } });
    const fused = fuse(second);
    expect(fused.kind).toBe('filter');
    if (fused.kind === 'filter') expect(fused.pred.kind).toBe('binary');
  });

  test('allows aggregates only in Aggregate nodes', () => {
    const aggregate = rel.aggregate({ id: relId('a'),
      input: scan, layout, type: { cols: [{ name: 'n', type: 'int', nullable: false }] },
      groupBy: [], aggs: [['n', { kind: 'agg', fn: 'count', args: [] }]],
    });
    expect(emit(aggregate).sql).toContain('count()');
    const invalid = rel.project({ id: relId('p'), input: scan, layout, type: { cols: [{ name: 'n', type: 'int', nullable: false }] }, exprs: [['n', { kind: 'agg', fn: 'count', args: [] }]] });
    expect(() => check(invalid)).toThrow('Agg is legal only in Aggregate.aggs');
  });

  test('names Values columns for downstream expressions', () => {
    const values = rel.values({ id: relId('v'), rows: [[lit(1, 'int'), lit('marko', 'text')]], layout, type: { cols } });
    const plan = rel.project({ id: relId('p'), input: values, layout, type: { cols }, exprs: [['id', col(values.id, 'id')], ['name', col(values.id, 'name')]] });
    expect(emit(plan).binds).toEqual([1, 'marko']);
    const db = new Database(':memory:');
    expect(db.query(emit(plan).sql).all(...emit(plan).binds)).toEqual([{ id: 1, name: 'marko' }]);
    db.close();
  });

  test('renders a legal recursive self-reference', () => {
    const oneCol = [{ name: 'id', type: 'int', nullable: false }] as const;
    const seed = rel.values({ id: relId('seed'), rows: [[lit(1, 'int')]], layout, type: { cols: oneCol } });
    const recursive = rel.recursive({ id: relId('walk'), name: 'walk', cols: ['id'], seed, layout, type: { cols: oneCol }, step: (self) => self });
    expect(emit(recursive).sql).toContain('WITH RECURSIVE');
  });

  test('renders SelfRef as a top-level recursive table source', () => {
    const oneCol = [{ name: 'id', type: 'int', nullable: false }] as const;
    const seed = rel.values({ id: relId('seed'), rows: [[lit(1, 'int')]], layout, type: { cols: oneCol } });
    const recursive = rel.recursive({ id: relId('walk'), name: 'walk', cols: ['id'], seed, layout, type: { cols: oneCol },
      step: (self) => rel.filter({ id: relId('step'), input: self, layout, type: { cols: oneCol }, pred: { kind: 'binary', op: '<', left: col(self.id, 'id'), right: lit(0, 'int') } }),
    });
    const emitted = emit(recursive);
    expect(emitted.sql).toContain('FROM walk walk');
    const db = new Database(':memory:');
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual([{ id: 1 }]);
    db.close();
  });

  test('rejects recursive aggregates and hidden recursive references', () => {
    const oneCol = [{ name: 'id', type: 'int', nullable: false }] as const;
    const seed = rel.values({ id: relId('seed'), rows: [[lit(1, 'int')]], layout, type: { cols: oneCol } });
    const aggregate = rel.recursive({ id: relId('walk'), name: 'walk', cols: ['id'], seed, layout, type: { cols: oneCol },
      step: (self) => rel.aggregate({ id: relId('a'), input: self, layout, type: { cols: oneCol }, groupBy: [], aggs: [['id', { kind: 'agg', fn: 'max', args: [col(self.id, 'id')] }]] }),
    });
    expect(() => check(aggregate)).toThrow('SQLite forbids aggregate queries in a recursive term');
    const hidden = rel.recursive({ id: relId('hiddenWalk'), name: 'hiddenWalk', cols: ['id'], seed, layout, type: { cols: oneCol },
      step: (self) => {
        const inner = rel.filter({ id: relId('inner'), input: self, layout, type: { cols: oneCol }, pred: { kind: 'binary', op: '>', left: col(self.id, 'id'), right: lit(0, 'int') } });
        return rel.project({ id: relId('outer'), input: inner, layout, type: { cols: oneCol }, exprs: [['id', col(inner.id, 'id')]] });
      },
    });
    expect(() => check(hidden)).toThrow("must reference 'hiddenWalk' at the top level of FROM");
  });

  test('places named dependencies beside a recursive CTE', () => {
    const oneCol = [{ name: 'id', type: 'int', nullable: false }] as const;
    const values = rel.values({ id: relId('seedValues'), rows: [[lit(1, 'int')]], layout, type: { cols: oneCol } });
    const seed = rel.materialize({ id: relId('seed'), name: 'seed', input: values, layout, type: { cols: oneCol } });
    const recursive = rel.recursive({ id: relId('walk'), name: 'walk', cols: ['id'], seed, layout, type: { cols: oneCol },
      step: (self) => rel.filter({ id: relId('step'), input: self, layout, type: { cols: oneCol }, pred: { kind: 'binary', op: '<', left: col(self.id, 'id'), right: lit(0, 'int') } }),
    });
    const emitted = emit(recursive, name(recursive));
    expect(emitted.sql).toContain('WITH RECURSIVE');
    expect(emitted.sql).toContain('seed AS');
    const db = new Database(':memory:');
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual([{ id: 1 }]);
    db.close();
  });

  test('rejects a plan above the Durable Objects bind budget', () => {
    const oneCol = [{ name: 'v', type: 'int', nullable: false }] as const;
    const overBudget = rel.values({ id: relId('many'), rows: Array.from({ length: 101 }, (_, i) => [lit(i, 'int')]), layout, type: { cols: oneCol } });
    expect(() => check(overBudget)).toThrow('101 binds exceeds Durable Objects cap of 100');
  });

  test('prunes unobserved project columns while retaining requested output', () => {
    const project = rel.project({ id: relId('p'), input: scan, layout, type: { cols }, exprs: [['id', col(scan.id, 'id')], ['name', col(scan.id, 'name')]] });
    const pruned = prune(project, ['id']);
    expect(pruned.kind).toBe('project');
    if (pruned.kind === 'project') expect(pruned.exprs.map(([name]) => name)).toEqual(['id']);
  });

  test('names shared DAG vertices and explicit materialization boundaries', () => {
    const shared = rel.filter({ id: relId('shared'), input: scan, layout, type: { cols }, pred: { kind: 'binary', op: '>', left: col(scan.id, 'id'), right: lit(0, 'int') } });
    const joined = rel.join({ id: relId('joined'), left: shared, right: shared, join: 'cross', layout, type: { cols } });
    expect(name(joined).named.map((binding) => binding.rel.id)).toEqual([shared.id]);
    expect(emit(joined, name(joined)).sql).toContain('WITH');
  });

  test('renders join predicates as SQL expressions', () => {
    const right = rel.scan({ id: relId('m'), table: 'nodes', alias: 'm', layout, type: { cols } });
    const joined = rel.join({ id: relId('j'), left: scan, right, join: 'inner', on: { kind: 'binary', op: '=', left: col(scan.id, 'id'), right: col(right.id, 'id') }, layout, type: { cols } });
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko'), (2, 'vadas')");
    expect(db.query(emit(joined).sql).all()).toHaveLength(2);
    db.close();
  });

  test('permits correlated scalar subqueries', () => {
    const inner = rel.scan({ id: relId('innerRel'), table: 'nodes', alias: 'i', layout, type: { cols } });
    const filtered = rel.filter({ id: relId('innerFiltered'), input: inner, layout, type: { cols }, pred: { kind: 'binary', op: '=', left: col(inner.id, 'id'), right: col(scan.id, 'id') } });
    const scalar = rel.project({ id: relId('outer'), input: scan, layout,
      type: { cols: [{ name: 'id', type: 'int', nullable: false }, { name: 'same', type: 'text', nullable: true }] },
      exprs: [['id', col(scan.id, 'id')], ['same', { kind: 'scalar', plan: rel.project({ id: relId('scalar'), input: filtered, layout, type: { cols: [{ name: 'name', type: 'text', nullable: false }] }, exprs: [['name', col(filtered.id, 'name')]] }) }]],
    });
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko'), (2, 'vadas')");
    expect(db.query(emit(scalar).sql).all()).toEqual([{ id: 1, same: 'marko' }, { id: 2, same: 'vadas' }]);
    db.close();
  });
});
