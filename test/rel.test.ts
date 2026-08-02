import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { check } from '../src/rel/check.ts';
import { col, lit } from '../src/rel/expr.ts';
import { aggregate as aggregateRel, filter, join, materialize, project as projectRel, recursive as recursiveRel, scan as scanRel, explode, union, values as valuesRel, window as windowRel } from '../src/rel/factory.ts';
import { emit } from '../src/rel/emit.ts';
import { fuse } from '../src/rel/passes/fuse.ts';
import { name } from '../src/rel/passes/name.ts';
import { prune } from '../src/rel/passes/prune.ts';
import { relId } from '../src/rel/types.ts';

const layout = { aliases: new Map(), origins: [], branchOrders: [] } as const;
const cols = [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'text', nullable: false }] as const;
const scan = scanRel({ id: relId('n'), table: 'nodes', alias: 'n', layout, type: { cols } });

/** The realistic sharing shape: one subplan feeding two DISTINCT sides of a join. Sharing the very
 * same relation on both sides is a construction error — one FROM cannot carry one alias twice. */
const sharedUnderTwoSides = () => {
  const shared = projectRel({ id: relId('shared'), input: scan, layout, type: { cols }, exprs: [['id', col(scan.id, 'id')], ['name', col(scan.id, 'name')]] });
  const left = filter({ id: relId('leftSide'), input: shared, layout, type: { cols }, pred: { kind: 'binary', op: '>', left: col(shared.id, 'id'), right: lit(0, 'int') } });
  const right = filter({ id: relId('rightSide'), input: shared, layout, type: { cols }, pred: { kind: 'binary', op: '<', left: col(shared.id, 'id'), right: lit(99, 'int') } });
  return join({
    id: relId('joined'), left, right, join: 'inner', layout,
    type: { cols: [...cols, ...cols.map((column) => ({ ...column, name: `${column.name}_r` }))] },
    on: { kind: 'binary', op: '=', left: col(left.id, 'id'), right: col(right.id, 'id') },
  });
};

describe('RelIR', () => {
  test('emits a checked, bound query through the SQL kernel', () => {
    const plan = projectRel({ id: relId('p'),
      input: scan, layout, type: { cols },
      exprs: [['id', col(scan.id, 'id')], ['name', col(scan.id, 'name')]],
    });
    const filtered = filter({ id: relId('f'), input: plan, layout, type: { cols }, pred: { kind: 'binary', op: '=', left: col(plan.id, 'name'), right: lit('marko', 'text') } });
    const emitted = emit(filtered);
    expect(emitted.binds).toEqual(['marko']);
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko'), (2, 'vadas')");
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual([{ id: 1, name: 'marko' }]);
    db.close();
  });

  test('fails closed on an undeclared column', () => {
    const invalid = filter({ id: relId('f'), input: scan, layout, type: { cols }, pred: col(scan.id, 'missing') });
    expect(() => check(invalid)).toThrow("has no declared column 'missing'");
  });

  test('factories reject locally inconsistent output schemas', () => {
    expect(() => projectRel({
      id: relId('badProject'), input: scan, layout,
      type: { cols: [{ name: 'id', type: 'int', nullable: false }] },
      exprs: [['name', col(scan.id, 'name')]],
    })).toThrow('Project expressions must declare exactly its output columns');
  });

  test('fuses adjacent filters structurally', () => {
    const first = filter({ id: relId('a'), input: scan, layout, type: { cols }, pred: { kind: 'binary', op: '>', left: col(scan.id, 'id'), right: lit(0, 'int') } });
    const second = filter({ id: relId('b'), input: first, layout, type: { cols }, pred: { kind: 'binary', op: '=', left: col(first.id, 'name'), right: lit('marko', 'text') } });
    const fused = fuse(second);
    expect(fused.kind).toBe('filter');
    if (fused.kind === 'filter') expect(fused.pred.kind).toBe('binary');
  });

  test('allows aggregates only in Aggregate nodes', () => {
    const aggregate = aggregateRel({ id: relId('a'),
      input: scan, layout, type: { cols: [{ name: 'n', type: 'int', nullable: false }] },
      groupBy: [], aggs: [['n', { kind: 'agg', fn: 'count', args: [] }]],
    });
    expect(emit(aggregate).sql).toContain('count()');
    const invalid = projectRel({ id: relId('p'), input: scan, layout, type: { cols: [{ name: 'n', type: 'int', nullable: false }] }, exprs: [['n', { kind: 'agg', fn: 'count', args: [] }]] });
    expect(() => check(invalid)).toThrow('Agg is legal only in Aggregate.aggs');
  });

  test('requires any reducing Aggregate to consume row-associated layout', () => {
    const carried = { ...layout, origins: ['origin'] } as const;
    const input = valuesRel({ id: relId('aggregateInput'), rows: [[lit(1, 'int'), lit('marko', 'text')]], layout: carried, type: { cols } });
    const invalid = aggregateRel({
      id: relId('badAggregate'), input, layout: carried,
      type: { cols: [{ name: 'n', type: 'int', nullable: false }] },
      groupBy: [], aggs: [['n', { kind: 'agg', fn: 'count', args: [] }]],
    });
    expect(() => check(invalid)).toThrow('Aggregate must apply the barrier layout contract');
  });

  test('names Values columns for downstream expressions', () => {
    const values = valuesRel({ id: relId('v'), rows: [[lit(1, 'int'), lit('marko', 'text')]], layout, type: { cols } });
    const plan = projectRel({ id: relId('p'), input: values, layout, type: { cols }, exprs: [['id', col(values.id, 'id')], ['name', col(values.id, 'name')]] });
    expect(emit(plan).binds).toEqual([1, 'marko']);
    const db = new Database(':memory:');
    expect(db.query(emit(plan).sql).all(...emit(plan).binds)).toEqual([{ id: 1, name: 'marko' }]);
    db.close();
  });

  test('renders a legal recursive self-reference', () => {
    const oneCol = [{ name: 'id', type: 'int', nullable: false }] as const;
    const seed = valuesRel({ id: relId('seed'), rows: [[lit(1, 'int')]], layout, type: { cols: oneCol } });
    const recursive = recursiveRel({ id: relId('walk'), name: 'walk', cols: ['id'], seed, layout, type: { cols: oneCol }, step: (self) => self });
    expect(emit(recursive).sql).toContain('WITH RECURSIVE');
  });

  test('renders SelfRef as a top-level recursive table source', () => {
    const oneCol = [{ name: 'id', type: 'int', nullable: false }] as const;
    const seed = valuesRel({ id: relId('seed'), rows: [[lit(1, 'int')]], layout, type: { cols: oneCol } });
    const recursive = recursiveRel({ id: relId('walk'), name: 'walk', cols: ['id'], seed, layout, type: { cols: oneCol },
      step: (self) => filter({ id: relId('step'), input: self, layout, type: { cols: oneCol }, pred: { kind: 'binary', op: '<', left: col(self.id, 'id'), right: lit(0, 'int') } }),
    });
    const emitted = emit(recursive);
    expect(emitted.sql).toContain('FROM walk walk');
    const db = new Database(':memory:');
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual([{ id: 1 }]);
    db.close();
  });

  test('rejects recursive aggregates and hidden recursive references', () => {
    const oneCol = [{ name: 'id', type: 'int', nullable: false }] as const;
    const seed = valuesRel({ id: relId('seed'), rows: [[lit(1, 'int')]], layout, type: { cols: oneCol } });
    const aggregate = recursiveRel({ id: relId('walk'), name: 'walk', cols: ['id'], seed, layout, type: { cols: oneCol },
      step: (self) => aggregateRel({ id: relId('a'), input: self, layout, type: { cols: oneCol }, groupBy: [], aggs: [['id', { kind: 'agg', fn: 'max', args: [col(self.id, 'id')] }]] }),
    });
    expect(() => check(aggregate)).toThrow('SQLite forbids aggregate queries in a recursive term');
    const hidden = recursiveRel({ id: relId('hiddenWalk'), name: 'hiddenWalk', cols: ['id'], seed, layout, type: { cols: oneCol },
      step: (self) => {
        const inner = filter({ id: relId('inner'), input: self, layout, type: { cols: oneCol }, pred: { kind: 'binary', op: '>', left: col(self.id, 'id'), right: lit(0, 'int') } });
        return projectRel({ id: relId('outer'), input: inner, layout, type: { cols: oneCol }, exprs: [['id', col(inner.id, 'id')]] });
      },
    });
    expect(() => check(hidden)).toThrow("must reference 'hiddenWalk' at the top level of FROM");
  });

  test('places named dependencies beside a recursive CTE', () => {
    const oneCol = [{ name: 'id', type: 'int', nullable: false }] as const;
    const values = valuesRel({ id: relId('seedValues'), rows: [[lit(1, 'int')]], layout, type: { cols: oneCol } });
    const seed = materialize({ id: relId('seed'), name: 'seed', input: values, layout, type: { cols: oneCol } });
    const recursive = recursiveRel({ id: relId('walk'), name: 'walk', cols: ['id'], seed, layout, type: { cols: oneCol },
      step: (self) => filter({ id: relId('step'), input: self, layout, type: { cols: oneCol }, pred: { kind: 'binary', op: '<', left: col(self.id, 'id'), right: lit(0, 'int') } }),
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
    const overBudget = valuesRel({ id: relId('many'), rows: Array.from({ length: 101 }, (_, i) => [lit(i, 'int')]), layout, type: { cols: oneCol } });
    expect(() => check(overBudget)).toThrow('101 binds exceeds Durable Objects cap of 100');
  });

  test('prunes unobserved project columns while retaining requested output', () => {
    const project = projectRel({ id: relId('p'), input: scan, layout, type: { cols }, exprs: [['id', col(scan.id, 'id')], ['name', col(scan.id, 'name')]] });
    const pruned = prune(project, ['id']);
    expect(pruned.kind).toBe('project');
    if (pruned.kind === 'project') expect(pruned.exprs.map(([name]) => name)).toEqual(['id']);
  });

  test('names shared DAG vertices and explicit materialization boundaries', () => {
    const joined = sharedUnderTwoSides();
    expect(name(joined).named.map((binding) => binding.rel.id)).toEqual([relId('shared')]);
    const emitted = emit(joined, name(joined));
    expect(emitted.sql).toContain('WITH');
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko')");
    expect(db.query(emitted.sql).all(...emitted.binds)).toHaveLength(1);
    db.close();
  });

  test('a keyed dedup is a partitioned Window and a Filter, keeping the whole row', () => {
    const ranked = windowRel({
      id: relId('ranked'), input: scan, layout,
      type: { cols: [...cols, { name: 'rn', type: 'int', nullable: false }] },
      specs: [['rn', { kind: 'window-expr', fn: 'row_number', args: [],
        spec: { partitionBy: [col(scan.id, 'name')], orderBy: [{ expr: col(scan.id, 'id'), dir: 'asc' }] } }]],
    });
    const first = filter({ id: relId('firstPerKey'), input: ranked, layout,
      type: { cols: [...cols, { name: 'rn', type: 'int', nullable: false }] },
      pred: { kind: 'binary', op: '=', left: col(ranked.id, 'rn'), right: lit(1, 'int') } });
    const emitted = emit(first);
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko'), (2, 'marko'), (3, 'vadas')");
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual([
      { id: 1, name: 'marko', rn: 1 }, { id: 3, name: 'vadas', rn: 1 },
    ]);
    db.close();
  });

  test('every node answers for the carried channels it claims', () => {
    const claiming = { ...layout, bulk: 'bulk' } as const;
    const invalid = scanRel({ id: relId('claims'), table: 'nodes', alias: 'c', layout: claiming, type: { cols } });
    expect(() => check(invalid)).toThrow("scan declares layout column 'bulk' but does not emit it");
  });

  test('Explode declares exactly the member columns it emits', () => {
    const withValue = [...cols, { name: 'v', type: 'any', nullable: true }] as const;
    const good = explode({ id: relId('members'), input: scan, layout, type: { cols: withValue }, expr: lit('[1,2]', 'json'), as: { value: 'v' } });
    const emitted = emit(good);
    expect(emitted.sql).not.toContain('AS key');
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko')");
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual([
      { id: 1, name: 'marko', v: 1 }, { id: 1, name: 'marko', v: 2 },
    ]);
    db.close();
    const undeclared = explode({ id: relId('undeclared'), input: scan, layout, type: { cols }, expr: lit('[1]', 'json'), as: { value: 'v' } });
    expect(() => check(undeclared)).toThrow('explode output must be its input columns followed by v');
  });

  test('a left join cannot carry a rigid channel from its nullable right side', () => {
    const carried = { ...layout, bulk: 'bulk' } as const;
    const bulked = [...cols, { name: 'bulk', type: 'int', nullable: false }] as const;
    const left = scanRel({ id: relId('l'), table: 'nodes', alias: 'l', layout, type: { cols } });
    const right = projectRel({ id: relId('r'), input: scan, layout: carried, type: { cols: bulked },
      exprs: [['id', col(scan.id, 'id')], ['name', col(scan.id, 'name')], ['bulk', lit(1, 'int')]] });
    const invalid = join({ id: relId('outer'), left, right, join: 'left', layout: carried, type: { cols: bulked },
      on: { kind: 'binary', op: '=', left: col(left.id, 'id'), right: col(right.id, 'id') } });
    expect(() => check(invalid)).toThrow("left Join cannot carry rigid channel 'bulk' from its nullable right side");
  });

  test('rejects a join whose two sides are the same relation', () => {
    const shared = filter({ id: relId('same'), input: scan, layout, type: { cols }, pred: { kind: 'binary', op: '>', left: col(scan.id, 'id'), right: lit(0, 'int') } });
    const selfJoin = join({ id: relId('selfJoin'), left: shared, right: shared, join: 'cross', layout, type: { cols } });
    expect(() => check(selfJoin)).toThrow("a Join's sides must be distinct relations");
  });

  test('a pass preserves DAG sharing, so naming still sees a shared node', () => {
    const joined = sharedUnderTwoSides();
    for (const pass of [fuse, (plan: typeof joined) => prune(plan)]) {
      const after = pass(joined);
      expect(name(after).named.map((binding) => binding.rel.id)).toEqual([relId('shared')]);
      if (after.kind === 'join' && after.left.kind === 'filter' && after.right.kind === 'filter')
        expect(after.left.input).toBe(after.right.input);
    }
  });

  test('a generated CTE name never collides with an explicit Materialize name', () => {
    const pinned = materialize({ id: relId('pinned'), input: scan, layout, type: { cols }, name: 'r0' });
    const shared = filter({ id: relId('sharedTwice'), input: scan, layout, type: { cols }, pred: { kind: 'binary', op: '>', left: col(scan.id, 'id'), right: lit(0, 'int') } });
    const inner = join({ id: relId('innerJoin'), left: shared, right: shared, join: 'cross', layout, type: { cols } });
    const names = name(join({ id: relId('outerJoin'), left: pinned, right: inner, join: 'cross', layout, type: { cols } })).named.map((binding) => binding.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('r0');
  });

  test('requires Union to use the layout merge contract', () => {
    const left = valuesRel({ id: relId('left'), rows: [[lit(1, 'int'), lit('marko', 'text')]], layout, type: { cols } });
    const right = valuesRel({ id: relId('right'), rows: [[lit(2, 'int'), lit('vadas', 'text')]], layout, type: { cols } });
    expect(() => check(union({ id: relId('ok'), inputs: [left, right], all: true, layout, type: { cols } }))).not.toThrow();
    const carried = { ...layout, origins: ['origin'] } as const;
    const carriedLeft = valuesRel({ id: relId('carriedLeft'), rows: [[lit(1, 'int'), lit('marko', 'text')]], layout: carried, type: { cols } });
    const carriedRight = valuesRel({ id: relId('carriedRight'), rows: [[lit(2, 'int'), lit('vadas', 'text')]], layout: carried, type: { cols } });
    const invalid = union({ id: relId('bad'), inputs: [carriedLeft, carriedRight], all: true, layout, type: { cols } });
    expect(() => check(invalid)).toThrow('Union output layout must merge its inputs');
  });

  test('renders join predicates as SQL expressions', () => {
    const right = scanRel({ id: relId('m'), table: 'nodes', alias: 'm', layout, type: { cols } });
    const joined = join({ id: relId('j'), left: scan, right, join: 'inner', on: { kind: 'binary', op: '=', left: col(scan.id, 'id'), right: col(right.id, 'id') }, layout, type: { cols } });
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko'), (2, 'vadas')");
    expect(db.query(emit(joined).sql).all()).toHaveLength(2);
    db.close();
  });

  test('permits correlated scalar subqueries', () => {
    const inner = scanRel({ id: relId('innerRel'), table: 'nodes', alias: 'i', layout, type: { cols } });
    const filtered = filter({ id: relId('innerFiltered'), input: inner, layout, type: { cols }, pred: { kind: 'binary', op: '=', left: col(inner.id, 'id'), right: col(scan.id, 'id') } });
    const scalar = projectRel({ id: relId('outer'), input: scan, layout,
      type: { cols: [{ name: 'id', type: 'int', nullable: false }, { name: 'same', type: 'text', nullable: true }] },
      exprs: [['id', col(scan.id, 'id')], ['same', { kind: 'scalar', plan: projectRel({ id: relId('scalar'), input: filtered, layout, type: { cols: [{ name: 'name', type: 'text', nullable: false }] }, exprs: [['name', col(filtered.id, 'name')]] }) }]],
    });
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko'), (2, 'vadas')");
    expect(db.query(emit(scalar).sql).all()).toEqual([{ id: 1, same: 'marko' }, { id: 2, same: 'vadas' }]);
    db.close();
  });
});
