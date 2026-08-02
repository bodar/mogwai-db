import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { check } from '../src/rel/check.ts';
import { col, lit } from '../src/rel/expr.ts';
import { aggregate as aggregateRel, filter, join, materialize, project as projectRel, recursive as recursiveRel, scan as scanRel, explode, union, values as valuesRel, window as windowRel } from '../src/rel/factory.ts';
import { emitQuery } from '../src/rel/emit.ts';
import { planOf } from '../src/rel/plan.ts';
import { fuse } from '../src/rel/passes/fuse.ts';
import { land } from '../src/rel/passes/land.ts';
import { name } from '../src/rel/passes/name.ts';
import { prune } from '../src/rel/passes/prune.ts';
import type { Channels } from '../src/channels.ts';
import { relId } from '../src/rel/types.ts';

const channels: Channels = [];
const cols = [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'text', nullable: false }] as const;
const scan = scanRel({ id: relId('n'), table: 'nodes', alias: 'n', channels, type: { cols } });
/** A join emits both sides' columns positionally, so a two-column pair needs four distinct names. */
const pairedCols = [...cols, ...cols.map((column) => ({ ...column, name: `${column.name}_r` }))] as const;

/** The realistic sharing shape: one subplan feeding two DISTINCT sides of a join. Sharing the very
 * same relation on both sides is a construction error — one FROM cannot carry one alias twice. */
const sharedUnderTwoSides = () => {
  const shared = projectRel({ id: relId('shared'), input: scan, channels, type: { cols }, exprs: [['id', col(scan.id, 'id')], ['name', col(scan.id, 'name')]] });
  const left = filter({ id: relId('leftSide'), input: shared, channels, type: { cols }, pred: { kind: 'binary', op: '>', left: col(shared.id, 'id'), right: lit(0, 'int') } });
  const right = filter({ id: relId('rightSide'), input: shared, channels, type: { cols }, pred: { kind: 'binary', op: '<', left: col(shared.id, 'id'), right: lit(99, 'int') } });
  return join({
    id: relId('joined'), left, right, join: 'inner', channels,
    type: { cols: [...cols, ...cols.map((column) => ({ ...column, name: `${column.name}_r` }))] },
    on: { kind: 'binary', op: '=', left: col(left.id, 'id'), right: col(right.id, 'id') },
  });
};

describe('RelIR', () => {
  test('emits a checked, bound query through the SQL kernel', () => {
    const plan = projectRel({ id: relId('p'),
      input: scan, channels, type: { cols },
      exprs: [['id', col(scan.id, 'id')], ['name', col(scan.id, 'name')]],
    });
    const filtered = filter({ id: relId('f'), input: plan, channels, type: { cols }, pred: { kind: 'binary', op: '=', left: col(plan.id, 'name'), right: lit('marko', 'text') } });
    const emitted = emitQuery(planOf(filtered));
    expect(emitted.binds).toEqual(['marko']);
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko'), (2, 'vadas')");
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual([{ id: 1, name: 'marko' }]);
    db.close();
  });

  test('fails closed on an undeclared column', () => {
    const invalid = filter({ id: relId('f'), input: scan, channels, type: { cols }, pred: col(scan.id, 'missing') });
    expect(() => check(invalid)).toThrow("has no declared column 'missing'");
  });

  test('factories reject locally inconsistent output schemas', () => {
    expect(() => projectRel({
      id: relId('badProject'), input: scan, channels,
      type: { cols: [{ name: 'id', type: 'int', nullable: false }] },
      exprs: [['name', col(scan.id, 'name')]],
    })).toThrow('Project expressions must declare exactly its output columns');
  });

  test('fuses adjacent filters structurally', () => {
    const first = filter({ id: relId('a'), input: scan, channels, type: { cols }, pred: { kind: 'binary', op: '>', left: col(scan.id, 'id'), right: lit(0, 'int') } });
    const second = filter({ id: relId('b'), input: first, channels, type: { cols }, pred: { kind: 'binary', op: '=', left: col(first.id, 'name'), right: lit('marko', 'text') } });
    const fused = fuse(second);
    expect(fused.kind).toBe('filter');
    if (fused.kind === 'filter') expect(fused.pred.kind).toBe('binary');
  });

  test('allows aggregates only in Aggregate nodes', () => {
    const aggregate = aggregateRel({ id: relId('a'),
      input: scan, channels, type: { cols: [{ name: 'n', type: 'int', nullable: false }] },
      groupBy: [], aggs: [['n', { kind: 'agg', fn: 'count', args: [] }]],
    });
    expect(emitQuery(planOf(aggregate)).sql).toContain('count()');
    const invalid = projectRel({ id: relId('p'), input: scan, channels, type: { cols: [{ name: 'n', type: 'int', nullable: false }] }, exprs: [['n', { kind: 'agg', fn: 'count', args: [] }]] });
    expect(() => check(invalid)).toThrow('Agg is legal only in Aggregate.aggs');
  });

  test('requires any reducing Aggregate to consume row-associated channels', () => {
    const carried: Channels = [{ col: 'origin', role: 'origin' }];
    const input = valuesRel({ id: relId('aggregateInput'), rows: [[lit(1, 'int'), lit('marko', 'text')]], channels: carried, type: { cols } });
    const invalid = aggregateRel({
      id: relId('badAggregate'), input, channels: carried,
      type: { cols: [{ name: 'n', type: 'int', nullable: false }] },
      groupBy: [], aggs: [['n', { kind: 'agg', fn: 'count', args: [] }]],
    });
    expect(() => check(invalid)).toThrow('Aggregate must apply the barrier channel contract');
  });

  test('names Values columns for downstream expressions', () => {
    const values = valuesRel({ id: relId('v'), rows: [[lit(1, 'int'), lit('marko', 'text')]], channels, type: { cols } });
    const plan = projectRel({ id: relId('p'), input: values, channels, type: { cols }, exprs: [['id', col(values.id, 'id')], ['name', col(values.id, 'name')]] });
    expect(emitQuery(planOf(plan)).binds).toEqual([1, 'marko']);
    const db = new Database(':memory:');
    expect(db.query(emitQuery(planOf(plan)).sql).all(...emitQuery(planOf(plan)).binds)).toEqual([{ id: 1, name: 'marko' }]);
    db.close();
  });

  test('renders a legal recursive self-reference', () => {
    const oneCol = [{ name: 'id', type: 'int', nullable: false }] as const;
    const seed = valuesRel({ id: relId('seed'), rows: [[lit(1, 'int')]], channels, type: { cols: oneCol } });
    const recursive = recursiveRel({ id: relId('walk'), name: 'walk', cols: ['id'], seed, channels, type: { cols: oneCol }, step: (self) => self });
    expect(emitQuery(planOf(recursive)).sql).toContain('WITH RECURSIVE');
  });

  test('renders SelfRef as a top-level recursive table source', () => {
    const oneCol = [{ name: 'id', type: 'int', nullable: false }] as const;
    const seed = valuesRel({ id: relId('seed'), rows: [[lit(1, 'int')]], channels, type: { cols: oneCol } });
    const recursive = recursiveRel({ id: relId('walk'), name: 'walk', cols: ['id'], seed, channels, type: { cols: oneCol },
      step: (self) => filter({ id: relId('step'), input: self, channels, type: { cols: oneCol }, pred: { kind: 'binary', op: '<', left: col(self.id, 'id'), right: lit(0, 'int') } }),
    });
    const emitted = emitQuery(planOf(recursive));
    expect(emitted.sql).toContain('FROM walk walk');
    const db = new Database(':memory:');
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual([{ id: 1 }]);
    db.close();
  });

  test('rejects recursive aggregates and hidden recursive references', () => {
    const oneCol = [{ name: 'id', type: 'int', nullable: false }] as const;
    const seed = valuesRel({ id: relId('seed'), rows: [[lit(1, 'int')]], channels, type: { cols: oneCol } });
    const aggregate = recursiveRel({ id: relId('walk'), name: 'walk', cols: ['id'], seed, channels, type: { cols: oneCol },
      step: (self) => aggregateRel({ id: relId('a'), input: self, channels, type: { cols: oneCol }, groupBy: [], aggs: [['id', { kind: 'agg', fn: 'max', args: [col(self.id, 'id')] }]] }),
    });
    expect(() => check(aggregate)).toThrow('SQLite forbids aggregate queries in a recursive term');
    const hidden = recursiveRel({ id: relId('hiddenWalk'), name: 'hiddenWalk', cols: ['id'], seed, channels, type: { cols: oneCol },
      step: (self) => {
        const inner = filter({ id: relId('inner'), input: self, channels, type: { cols: oneCol }, pred: { kind: 'binary', op: '>', left: col(self.id, 'id'), right: lit(0, 'int') } });
        return projectRel({ id: relId('outer'), input: inner, channels, type: { cols: oneCol }, exprs: [['id', col(inner.id, 'id')]] });
      },
    });
    expect(() => check(hidden)).toThrow("must reference 'hiddenWalk' at the top level of FROM");
  });

  test('places named dependencies beside a recursive CTE', () => {
    const oneCol = [{ name: 'id', type: 'int', nullable: false }] as const;
    const values = valuesRel({ id: relId('seedValues'), rows: [[lit(1, 'int')]], channels, type: { cols: oneCol } });
    const seed = materialize({ id: relId('seed'), name: 'seed', input: values, channels, type: { cols: oneCol } });
    const recursive = recursiveRel({ id: relId('walk'), name: 'walk', cols: ['id'], seed, channels, type: { cols: oneCol },
      step: (self) => filter({ id: relId('step'), input: self, channels, type: { cols: oneCol }, pred: { kind: 'binary', op: '<', left: col(self.id, 'id'), right: lit(0, 'int') } }),
    });
    const emitted = emitQuery(name(recursive));
    expect(emitted.sql).toContain('WITH RECURSIVE');
    expect(emitted.sql).toContain('seed AS');
    const db = new Database(':memory:');
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual([{ id: 1 }]);
    db.close();
  });

  test('rejects a plan above the Durable Objects bind budget', () => {
    const oneCol = [{ name: 'v', type: 'int', nullable: false }] as const;
    const overBudget = valuesRel({ id: relId('many'), rows: Array.from({ length: 101 }, (_, i) => [lit(i, 'int')]), channels, type: { cols: oneCol } });
    expect(() => check(overBudget)).toThrow('101 binds exceeds Durable Objects cap of 100');
  });

  test('lands an over-budget Values as ONE JSON bind, and declines what it cannot serialise', () => {
    const oneCol = [{ name: 'v', type: 'int', nullable: false }] as const;
    const overBudget = valuesRel({ id: relId('many'), rows: Array.from({ length: 101 }, (_, i) => [lit(i, 'int')]), channels, type: { cols: oneCol } });
    const landed = land(overBudget);
    const emitted = emitQuery(planOf(landed));
    expect(emitted.binds).toHaveLength(2);   // the whole payload, plus one `$[i]` path per column
    expect(emitted.binds.filter((bind) => typeof bind !== 'string')).toEqual([]);
    const db = new Database(':memory:');
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual(Array.from({ length: 101 }, (_, i) => ({ v: i })));
    db.close();

    // A row holding something other than a Lit has no compile-time JSON, so the pass leaves it and
    // the budget fails closed rather than the plan silently executing a different query.
    const computed = valuesRel({ id: relId('computed'), channels, type: { cols: oneCol },
      rows: Array.from({ length: 102 }, (_, i) => [i ? lit(i, 'int') : { kind: 'call' as const, fn: 'random', args: [] }]),
    });
    expect(land(computed)).toBe(computed);
    expect(() => check(computed)).toThrow('exceeds Durable Objects cap');
  });

  test('prunes unobserved project columns while retaining requested output', () => {
    const project = projectRel({ id: relId('p'), input: scan, channels, type: { cols }, exprs: [['id', col(scan.id, 'id')], ['name', col(scan.id, 'name')]] });
    const pruned = prune(project, ['id']);
    expect(pruned.kind).toBe('project');
    if (pruned.kind === 'project') expect(pruned.exprs.map(([name]) => name)).toEqual(['id']);
  });

  test('names shared DAG vertices and explicit materialization boundaries', () => {
    const joined = sharedUnderTwoSides();
    expect(name(joined).bindings.map((binding) => binding.node.kind)).toEqual(['project']);
    const emitted = emitQuery(name(joined));
    expect(emitted.sql).toContain('WITH');
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko')");
    expect(db.query(emitted.sql).all(...emitted.binds)).toHaveLength(1);
    db.close();
  });

  test('a keyed dedup is a partitioned Window and a Filter, keeping the whole row', () => {
    const ranked = windowRel({
      id: relId('ranked'), input: scan, channels,
      type: { cols: [...cols, { name: 'rn', type: 'int', nullable: false }] },
      specs: [['rn', { kind: 'window-expr', fn: 'row_number', args: [],
        spec: { partitionBy: [col(scan.id, 'name')], orderBy: [{ expr: col(scan.id, 'id'), dir: 'asc' }] } }]],
    });
    const first = filter({ id: relId('firstPerKey'), input: ranked, channels,
      type: { cols: [...cols, { name: 'rn', type: 'int', nullable: false }] },
      pred: { kind: 'binary', op: '=', left: col(ranked.id, 'rn'), right: lit(1, 'int') } });
    const emitted = emitQuery(planOf(first));
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko'), (2, 'marko'), (3, 'vadas')");
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual([
      { id: 1, name: 'marko', rn: 1 }, { id: 3, name: 'vadas', rn: 1 },
    ]);
    db.close();
  });

  test('every node answers for the carried channels it claims', () => {
    const claiming: Channels = [{ col: 'bulk', role: 'bulk' }];
    const invalid = scanRel({ id: relId('claims'), table: 'nodes', alias: 'c', channels: claiming, type: { cols } });
    expect(() => check(invalid)).toThrow("scan declares channel 'bulk' but does not emit it");
  });

  test('Explode declares exactly the member columns it emits', () => {
    const withValue = [...cols, { name: 'v', type: 'any', nullable: true }] as const;
    const good = explode({ id: relId('members'), input: scan, channels, type: { cols: withValue }, expr: lit('[1,2]', 'json'), as: { value: 'v' } });
    const emitted = emitQuery(planOf(good));
    expect(emitted.sql).not.toContain('AS key');
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko')");
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual([
      { id: 1, name: 'marko', v: 1 }, { id: 1, name: 'marko', v: 2 },
    ]);
    db.close();
    const undeclared = explode({ id: relId('undeclared'), input: scan, channels, type: { cols }, expr: lit('[1]', 'json'), as: { value: 'v' } });
    expect(() => check(undeclared)).toThrow('explode output must be its input columns followed by v');
  });

  test('a left join cannot carry a rigid channel from its nullable right side', () => {
    const carried: Channels = [{ col: 'bulk', role: 'bulk' }];
    const bulked = [...cols, { name: 'bulk', type: 'int', nullable: false }] as const;
    const left = scanRel({ id: relId('l'), table: 'nodes', alias: 'l', channels, type: { cols } });
    const right = projectRel({ id: relId('r'), input: scan, channels: carried, type: { cols: bulked },
      exprs: [['id', col(scan.id, 'id')], ['name', col(scan.id, 'name')], ['bulk', lit(1, 'int')]] });
    const invalid = join({ id: relId('outer'), left, right, join: 'left', channels: carried,
      type: { cols: [...cols, { name: 'id_r', type: 'int', nullable: false }, { name: 'name_r', type: 'text', nullable: false }, { name: 'bulk', type: 'int', nullable: false }] },
      on: { kind: 'binary', op: '=', left: col(left.id, 'id'), right: col(right.id, 'id') } });
    expect(() => check(invalid)).toThrow("left Join cannot carry rigid channel 'bulk' from its nullable right side");
  });

  test('rejects a join whose two sides are the same relation', () => {
    const shared = filter({ id: relId('same'), input: scan, channels, type: { cols }, pred: { kind: 'binary', op: '>', left: col(scan.id, 'id'), right: lit(0, 'int') } });
    const selfJoin = join({ id: relId('selfJoin'), left: shared, right: shared, join: 'cross', channels, type: { cols: pairedCols } });
    expect(() => check(selfJoin)).toThrow("a Join's sides must be distinct relations");
  });

  test('a pass preserves DAG sharing, so naming still sees a shared node', () => {
    const joined = sharedUnderTwoSides();
    for (const pass of [fuse, (plan: typeof joined) => prune(plan)]) {
      const after = pass(joined);
      expect(name(after).bindings.map((binding) => binding.name)).toEqual(['r0']);
      if (after.kind === 'join' && after.left.kind === 'filter' && after.right.kind === 'filter')
        expect(after.left.input).toBe(after.right.input);
    }
  });

  test('a generated CTE name never collides with an explicit Materialize name', () => {
    const pinned = materialize({ id: relId('pinned'), input: scan, channels, type: { cols }, name: 'r0' });
    const shared = filter({ id: relId('sharedTwice'), input: scan, channels, type: { cols }, pred: { kind: 'binary', op: '>', left: col(scan.id, 'id'), right: lit(0, 'int') } });
    const inner = join({ id: relId('innerJoin'), left: shared, right: shared, join: 'cross', channels, type: { cols: pairedCols } });
    const names = name(join({ id: relId('outerJoin'), left: pinned, right: inner, join: 'cross', channels,
      type: { cols: [...cols, ...pairedCols.map((column) => ({ ...column, name: `${column.name}2` }))] } })).bindings.map((binding) => binding.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('r0');
  });

  test('requires Union to use the channels merge contract', () => {
    const left = valuesRel({ id: relId('left'), rows: [[lit(1, 'int'), lit('marko', 'text')]], channels, type: { cols } });
    const right = valuesRel({ id: relId('right'), rows: [[lit(2, 'int'), lit('vadas', 'text')]], channels, type: { cols } });
    expect(() => check(union({ id: relId('ok'), inputs: [left, right], all: true, channels, type: { cols } }))).not.toThrow();
    const carried: Channels = [{ col: 'origin', role: 'origin' }];
    const carriedLeft = valuesRel({ id: relId('carriedLeft'), rows: [[lit(1, 'int'), lit('marko', 'text')]], channels: carried, type: { cols } });
    const carriedRight = valuesRel({ id: relId('carriedRight'), rows: [[lit(2, 'int'), lit('vadas', 'text')]], channels: carried, type: { cols } });
    const invalid = union({ id: relId('bad'), inputs: [carriedLeft, carriedRight], all: true, channels, type: { cols } });
    expect(() => check(invalid)).toThrow('Union output channels must merge its inputs');
  });

  test('renders join predicates as SQL expressions', () => {
    const right = scanRel({ id: relId('m'), table: 'nodes', alias: 'm', channels, type: { cols } });
    const joined = join({ id: relId('j'), left: scan, right, join: 'inner', on: { kind: 'binary', op: '=', left: col(scan.id, 'id'), right: col(right.id, 'id') }, channels, type: { cols: pairedCols } });
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko'), (2, 'vadas')");
    expect(db.query(emitQuery(planOf(joined)).sql).all()).toHaveLength(2);
    db.close();
  });

  test('permits correlated scalar subqueries', () => {
    const inner = scanRel({ id: relId('innerRel'), table: 'nodes', alias: 'i', channels, type: { cols } });
    const filtered = filter({ id: relId('innerFiltered'), input: inner, channels, type: { cols }, pred: { kind: 'binary', op: '=', left: col(inner.id, 'id'), right: col(scan.id, 'id') } });
    const scalar = projectRel({ id: relId('outer'), input: scan, channels,
      type: { cols: [{ name: 'id', type: 'int', nullable: false }, { name: 'same', type: 'text', nullable: true }] },
      exprs: [['id', col(scan.id, 'id')], ['same', { kind: 'scalar', plan: projectRel({ id: relId('scalar'), input: filtered, channels, type: { cols: [{ name: 'name', type: 'text', nullable: false }] }, exprs: [['name', col(filtered.id, 'name')]] }) }]],
    });
    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko'), (2, 'vadas')");
    expect(db.query(emitQuery(planOf(scalar)).sql).all()).toEqual([{ id: 1, same: 'marko' }, { id: 2, same: 'vadas' }]);
    db.close();
  });
});
