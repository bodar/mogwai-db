import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { check, emit, fuse, name, prune, col, lit, relId, type Rel } from '../src/rel/index.ts';

const layout = { aliases: new Map(), origins: [], branchOrders: [] } as const;
const cols = [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'text', nullable: false }] as const;
const scan: Rel = { kind: 'scan', id: relId('n'), table: 'nodes', alias: 'n', layout, type: { cols } };

describe('RelIR', () => {
  test('emits a checked, bound query through the SQL kernel', () => {
    const plan: Rel = {
      kind: 'project', id: relId('p'), input: scan, layout, type: { cols },
      exprs: [['id', col(scan.id, 'id')], ['name', col(scan.id, 'name')]],
    };
    const filtered: Rel = { kind: 'filter', id: relId('f'), input: plan, layout, type: { cols }, pred: { kind: 'binary', op: '=', left: col(plan.id, 'name'), right: lit('marko', 'text') } };
    const emitted = emit(filtered);
    expect(emitted.binds).toEqual(['marko']);
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko'), (2, 'vadas')");
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual([{ id: 1, name: 'marko' }]);
    db.close();
  });

  test('fails closed on an undeclared column', () => {
    const invalid: Rel = { kind: 'filter', id: relId('f'), input: scan, layout, type: { cols }, pred: col(scan.id, 'missing') };
    expect(() => check(invalid)).toThrow("has no declared column 'missing'");
  });

  test('fuses adjacent filters structurally', () => {
    const first: Rel = { kind: 'filter', id: relId('a'), input: scan, layout, type: { cols }, pred: { kind: 'binary', op: '>', left: col(scan.id, 'id'), right: lit(0, 'int') } };
    const second: Rel = { kind: 'filter', id: relId('b'), input: first, layout, type: { cols }, pred: { kind: 'binary', op: '=', left: col(first.id, 'name'), right: lit('marko', 'text') } };
    const fused = fuse(second);
    expect(fused.kind).toBe('filter');
    if (fused.kind === 'filter') expect(fused.pred.kind).toBe('binary');
  });

  test('allows aggregates only in Aggregate nodes', () => {
    const aggregate: Rel = {
      kind: 'aggregate', id: relId('a'), input: scan, layout, type: { cols: [{ name: 'n', type: 'int', nullable: false }] },
      groupBy: [], aggs: [['n', { kind: 'agg', fn: 'count', args: [] }]],
    };
    expect(emit(aggregate).sql).toContain('count()');
    const invalid: Rel = { kind: 'project', id: relId('p'), input: scan, layout, type: { cols: [{ name: 'n', type: 'int', nullable: false }] }, exprs: [['n', { kind: 'agg', fn: 'count', args: [] }]] };
    expect(() => check(invalid)).toThrow('Agg is legal only in Aggregate.aggs');
  });

  test('rejects a self reference outside its recursive term', () => {
    const self: Rel = { kind: 'self-ref', id: relId('walk'), name: 'walk', layout, type: { cols } };
    expect(() => check(self)).toThrow('SelfRef is legal only in its Recursive step');
  });

  test('names Values columns for downstream expressions', () => {
    const values: Rel = { kind: 'values', id: relId('v'), rows: [[lit(1, 'int'), lit('marko', 'text')]], layout, type: { cols } };
    const plan: Rel = { kind: 'project', id: relId('p'), input: values, layout, type: { cols }, exprs: [['id', col(values.id, 'id')], ['name', col(values.id, 'name')]] };
    expect(emit(plan).binds).toEqual([1, 'marko']);
    const db = new Database(':memory:');
    expect(db.query(emit(plan).sql).all(...emit(plan).binds)).toEqual([{ id: 1, name: 'marko' }]);
    db.close();
  });

  test('renders a legal recursive self-reference', () => {
    const oneCol = [{ name: 'id', type: 'int', nullable: false }] as const;
    const seed: Rel = { kind: 'values', id: relId('seed'), rows: [[lit(1, 'int')]], layout, type: { cols: oneCol } };
    const recursive: Rel = { kind: 'recursive', id: relId('walk'), name: 'walk', cols: ['id'], seed, layout, type: { cols: oneCol }, step: (self) => self };
    expect(emit(recursive).sql).toContain('WITH RECURSIVE');
  });

  test('rejects a plan above the Durable Objects bind budget', () => {
    const oneCol = [{ name: 'v', type: 'int', nullable: false }] as const;
    const overBudget: Rel = { kind: 'values', id: relId('many'), rows: Array.from({ length: 101 }, (_, i) => [lit(i, 'int')]), layout, type: { cols: oneCol } };
    expect(() => check(overBudget)).toThrow('101 binds exceeds Durable Objects cap of 100');
  });

  test('prunes unobserved project columns while retaining requested output', () => {
    const project: Rel = { kind: 'project', id: relId('p'), input: scan, layout, type: { cols }, exprs: [['id', col(scan.id, 'id')], ['name', col(scan.id, 'name')]] };
    const pruned = prune(project, ['id']);
    expect(pruned.kind).toBe('project');
    if (pruned.kind === 'project') expect(pruned.exprs.map(([name]) => name)).toEqual(['id']);
  });

  test('names shared DAG vertices and explicit materialization boundaries', () => {
    const shared: Rel = { kind: 'filter', id: relId('shared'), input: scan, layout, type: { cols }, pred: { kind: 'binary', op: '>', left: col(scan.id, 'id'), right: lit(0, 'int') } };
    const joined: Rel = { kind: 'join', id: relId('joined'), left: shared, right: shared, join: 'cross', layout, type: { cols } };
    expect(name(joined).named.map((binding) => binding.rel.id)).toEqual([shared.id]);
    expect(emit(joined, name(joined)).sql).toContain('WITH');
  });
});
