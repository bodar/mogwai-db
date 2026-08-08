import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { check } from '../src/rel/check.ts';
import { col, lit } from '../src/rel/expr.ts';
import { aggregate as aggregateRel, distinct as distinctRel, explode, filter, join, limit as limitRel, materialize, project as projectRel, recursive as recursiveRel, scan as scanRel, sort as sortRel, union, values as valuesRel, window as windowRel } from '../src/rel/factory.ts';
import { emitQuery } from '../src/rel/emit.ts';
import { planOf } from '../src/rel/plan.ts';
import { fuse } from '../src/rel/passes/fuse.ts';
import { name } from '../src/rel/passes/name.ts';
import { prune } from '../src/rel/passes/prune.ts';
import type { Channels } from '../src/channels.ts';
import type { Rel } from '../src/rel/rel.ts';
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

  test('allows aggregates only in Aggregate nodes', () => {
    const aggregate = aggregateRel({ id: relId('a'),
      input: scan, channels, type: { cols: [{ name: 'n', type: 'int', nullable: false }] },
      groupBy: [], aggs: [['n', { kind: 'agg', fn: 'count', args: [] }]],
    });
    expect(emitQuery(planOf(aggregate)).sql).toContain('count(*)');
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
    expect(() => check(invalid)).toThrow('Aggregate must either apply the barrier channel contract');
  });

  test('a GROUPED Aggregate may carry channels through, but only roles a grouping can combine', () => {
    // The third case §3.5 did not have, and the one `dedup()` under an emission order needs: a
    // grouping by the traverser's own identity emits one row per SURVIVING traverser, so its
    // channels have to come out the other side. What decides legality is the ROLE — a multiplicity
    // adds and an emission position is the earliest of the group, while an alias, a path or a sack
    // belongs to ONE member and a grouping would take it from whichever row came first.
    const ordered: Channels = [{ col: 'bulk', role: 'bulk' }, { col: 'encounter', role: 'encounter' }];
    const shape = { cols: [{ name: 'id', type: 'int' as const, nullable: false }, { name: 'bulk', type: 'int' as const, nullable: false }, { name: 'encounter', type: 'int' as const, nullable: false }] };
    const input = valuesRel({ id: relId('groupedInput'), rows: [[lit(1, 'int'), lit(1, 'int'), lit(1, 'int')]], channels: ordered, type: shape });
    const grouped = aggregateRel({
      id: relId('grouped'), input, channels: ordered, type: shape, groupBy: [col(input.id, 'id')],
      aggs: [['bulk', lit(1, 'int')], ['encounter', { kind: 'agg', fn: 'min', args: [col(input.id, 'encounter')] }]],
    });
    expect(() => check(grouped)).not.toThrow();

    // …and the counterexample, which is the half worth having: the same shape carrying an ALIAS.
    const aliased: Channels = [{ col: 'bulk', role: 'bulk' }, { col: 'encounter', role: 'alias' }];
    const aliasInput = valuesRel({ id: relId('aliasInput'), rows: [[lit(1, 'int'), lit(1, 'int'), lit(1, 'int')]], channels: aliased, type: shape });
    const badGroup = aggregateRel({
      id: relId('badGroup'), input: aliasInput, channels: aliased, type: shape, groupBy: [col(aliasInput.id, 'id')],
      aggs: [['bulk', lit(1, 'int')], ['encounter', { kind: 'agg', fn: 'min', args: [col(aliasInput.id, 'encounter')] }]],
    });
    expect(() => check(badGroup)).toThrow("cannot carry the 'alias' channel");
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
    // A FENCE is the same rejection, and it is the one worth naming: a `Materialize` is a legal
    // unary node whose whole purpose is to force a named CTE boundary, which is exactly the derived
    // table P1 measured as fatal (`circular reference`) even as the SOLE reference — SQLite's rule
    // is positional, not a count. So it is refused where a `Filter` is admitted.
    const fenced = recursiveRel({ id: relId('fencedWalk'), name: 'fencedWalk', cols: ['id'], seed, channels, type: { cols: oneCol },
      step: (self) => materialize({ id: relId('fence'), name: 'fence', input: self, channels, type: { cols: oneCol } }),
    });
    expect(() => check(fenced)).toThrow("must reference 'fencedWalk' at the top level of FROM");
  });

  // P3 — SQLite ACCEPTS all three and none of them means what an author writing it means. Measured
  // on bun:sqlite 3.53.0 against a 6-edge cyclic graph: DISTINCT leaves the duplicates in place
  // (byte-identical result to the same walk without it), and LIMIT 2 returns 2 rows for the WHOLE
  // walk rather than 2 per iteration. An accepted wrong answer is the one outcome no instrument in
  // this repo can see, so the checker is the only place it can be caught.
  test('refuses a per-iteration barrier inside a recursive term (P3) — SQLite accepts each one silently', () => {
    const oneCol = [{ name: 'id', type: 'int', nullable: false }] as const;
    const seed = valuesRel({ id: relId('seed'), rows: [[lit(1, 'int')]], channels, type: { cols: oneCol } });
    const walkWith = (id: string, step: (self: Rel) => Rel) =>
      recursiveRel({ id: relId(id), name: id, cols: ['id'], seed, channels, type: { cols: oneCol }, step });

    const deduped = walkWith('dedupWalk', (self) => distinctRel({ id: relId('d'), input: self, channels, type: { cols: oneCol } }));
    expect(() => check(deduped)).toThrow('silently ignores it — no per-iteration dedup exists');

    const capped = walkWith('limitWalk', (self) => limitRel({ id: relId('l'), input: self, channels, type: { cols: oneCol }, count: lit(2, 'int') }));
    expect(() => check(capped)).toThrow('applies it to the WHOLE walk, not per iteration');

    const ordered = walkWith('sortWalk', (self) => sortRel({ id: relId('s'), input: self, channels, type: { cols: oneCol }, terms: [{ expr: col(self.id, 'id'), dir: 'asc' }] }));
    expect(() => check(ordered)).toThrow('applies it to the WHOLE walk, not per iteration');
  });

  // The OTHER direction, and it is the one that would have blocked Phase 3: the barrier laws are
  // laws of the recursive SELECT, not of every SELECT beneath it. Measured legal on bun:sqlite —
  // a correlated scalar carrying COUNT(*) inside a recursive term runs and returns the right
  // per-row value. `flatten` (§4.2) decorrelates into exactly this shape, per P2, so a law that
  // fired inside a subquery would refuse the shapes Phase 3 exists to produce.
  // The same defect one layer up from P3's, and reachable by a LOWERING rather than by the engine:
  // every row differs in a row-unique column, so the operator collapses nothing. Same arity, same
  // plan shape, no throw — just more rows than the step means.
  test('refuses a whole-row Distinct carrying a row-unique channel', () => {
    const carried: Channels = [{ col: 'enc', role: 'encounter' }];
    const withEnc = [...cols, { name: 'enc', type: 'int', nullable: false }] as const;
    const source = projectRel({ id: relId('src'), input: scan, channels: carried, type: { cols: withEnc },
      exprs: [['id', col(scan.id, 'id')], ['name', col(scan.id, 'name')], ['enc', lit(1, 'int')]] });
    const deduped = distinctRel({ id: relId('dd'), input: source, channels: carried, type: { cols: withEnc } });
    expect(() => check(deduped)).toThrow("cannot carry the row-unique channel(s) 'encounter'");

    // `bulk` is NOT row-unique, and this is the shape that proves the rule had to be per-role: the
    // landed unordered `dedup()` projects `bulk = 1` and dedups over `(id, 1)`, which is a dedup on
    // `id`. A blanket "a Distinct may carry no channels" would refuse correct, shipped code.
    const bulk: Channels = [{ col: 'bulk', role: 'bulk' }];
    const withBulk = [...cols, { name: 'bulk', type: 'int', nullable: false }] as const;
    const counted = projectRel({ id: relId('bsrc'), input: scan, channels: bulk, type: { cols: withBulk },
      exprs: [['id', col(scan.id, 'id')], ['name', col(scan.id, 'name')], ['bulk', lit(1, 'int')]] });
    expect(() => check(distinctRel({ id: relId('bdd'), input: counted, channels: bulk, type: { cols: withBulk } }))).not.toThrow();
  });

  // ⚠️ SQLite ACCEPTS `SELECT k, x FROM t GROUP BY k` and returns `x` from an arbitrary row of each
  // group; every other engine rejects it. So this is a wrong VALUE with the right shape, and it is
  // non-deterministic between runs — the class no ladder level sees.
  test('refuses a bare input column in Aggregate.aggs, and admits the two legal forms', () => {
    const outCols = [{ name: 'id', type: 'int', nullable: false }, { name: 'v', type: 'text', nullable: false }] as const;
    const grouped = (value: Parameters<typeof aggregateRel>[0]['aggs'][number][1]) =>
      aggregateRel({ id: relId('g'), input: scan, channels, type: { cols: outCols }, groupBy: [col(scan.id, 'id')], aggs: [['v', value]] });

    expect(() => check(grouped(col(scan.id, 'name')))).toThrow('neither a group key nor inside an Agg');
    // Inside an Agg the same column is exactly what an aggregate is for.
    expect(() => check(grouped({ kind: 'agg', fn: 'max', args: [col(scan.id, 'name')] }))).not.toThrow();
    // …and a column the GROUP BY fixed is legal bare, because the group has only one value for it.
    expect(() => check(grouped(col(scan.id, 'id')))).not.toThrow();
  });

  test('admits an aggregate inside a CORRELATED SUBQUERY in a recursive term (P2)', () => {
    const oneCol = [{ name: 'id', type: 'int', nullable: false }] as const;
    const seed = valuesRel({ id: relId('seed'), rows: [[lit(1, 'int')]], channels, type: { cols: oneCol } });
    const recursive = recursiveRel({ id: relId('aggSubWalk'), name: 'aggSubWalk', cols: ['id'], seed, channels, type: { cols: oneCol },
      step: (self) => {
        const inner = scanRel({ id: relId('n'), table: 'nodes', alias: 'n', channels, type: { cols: [{ name: 'id', type: 'int', nullable: false }] } });
        const counted = aggregateRel({ id: relId('c'), input: inner, channels, type: { cols: [{ name: 'n', type: 'int', nullable: false }] },
          groupBy: [], aggs: [['n', { kind: 'agg', fn: 'count', args: [] }]] });
        return projectRel({ id: relId('p'), input: self, channels, type: { cols: oneCol },
          exprs: [['id', { kind: 'scalar', plan: counted }]] });
      },
    });
    expect(() => check(recursive)).not.toThrow();
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

  test('prunes unobserved project columns while retaining requested output', () => {
    const project = projectRel({ id: relId('p'), input: scan, channels, type: { cols }, exprs: [['id', col(scan.id, 'id')], ['name', col(scan.id, 'name')]] });
    const pruned = prune(project, ['id']);
    expect(pruned.kind).toBe('project');
    if (pruned.kind === 'project') expect(pruned.exprs.map(([name]) => name)).toEqual(['id']);
  });

  test('pruning retains a column read only by a Filter predicate', () => {
    const projected = projectRel({ id: relId('predicateInput'), input: scan, channels, type: { cols },
      exprs: [['id', col(scan.id, 'id')], ['name', col(scan.id, 'name')]] });
    const filtered = filter({ id: relId('predicateReader'), input: projected, channels, type: { cols },
      pred: { kind: 'binary', op: '=', left: col(projected.id, 'name'), right: lit('marko', 'text') } });
    const pruned = prune(filtered, ['id']);
    expect(pruned.kind).toBe('filter');
    if (pruned.kind === 'filter' && pruned.input.kind === 'project')
      expect(pruned.input.exprs.map(([name]) => name)).toEqual(['id', 'name']);
    expect(() => check(pruned)).not.toThrow();
  });

  test('type-preserving nodes declare exactly their input type', () => {
    const wellFormed = [
      filter({ id: relId('typedFilter'), input: scan, channels, type: { cols }, pred: lit(1, 'int') }),
      sortRel({ id: relId('typedSort'), input: scan, channels, type: { cols }, terms: [{ expr: col(scan.id, 'name'), dir: 'asc' }] }),
      limitRel({ id: relId('typedLimit'), input: scan, channels, type: { cols }, count: lit(1, 'int') }),
      distinctRel({ id: relId('typedDistinct'), input: scan, channels, type: { cols } }),
      materialize({ id: relId('typedMaterialize'), name: 'typed_materialize', input: scan, channels, type: { cols } }),
    ];
    for (const node of wellFormed) expect(() => check(node)).not.toThrow();

    const narrowed = { cols: [cols[0]] };
    const malformed = [
      filter({ id: relId('badTypedFilter'), input: scan, channels, type: narrowed, pred: lit(1, 'int') }),
      sortRel({ id: relId('badTypedSort'), input: scan, channels, type: narrowed, terms: [{ expr: col(scan.id, 'name'), dir: 'asc' }] }),
      limitRel({ id: relId('badTypedLimit'), input: scan, channels, type: narrowed, count: lit(1, 'int') }),
      distinctRel({ id: relId('badTypedDistinct'), input: scan, channels, type: narrowed }),
      materialize({ id: relId('badTypedMaterialize'), name: 'bad_typed_materialize', input: scan, channels, type: narrowed }),
    ];
    for (const node of malformed) expect(() => check(node)).toThrow(`RelIR: ${node.kind} type must match its input's`);
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

  test("a left Join declares every right-side output column nullable", () => {
    const left = scanRel({ id: relId('nullableLeft'), table: 'nodes', alias: 'nl', channels, type: { cols } });
    const right = scanRel({ id: relId('nullableRight'), table: 'nodes', alias: 'nr', channels, type: { cols } });
    const rightOutput = cols.map((column) => ({ ...column, name: `${column.name}_r`, nullable: true as const }));
    const on = { kind: 'binary' as const, op: '=' as const, left: col(left.id, 'id'), right: col(right.id, 'id') };
    const valid = join({ id: relId('validLeftJoin'), left, right, join: 'left', channels, type: { cols: [...cols, ...rightOutput] }, on });
    expect(() => check(valid)).not.toThrow();

    const invalidRight = rightOutput.map((column, i) => i === 0 ? { ...column, nullable: false } : column);
    const invalid = join({ id: relId('invalidLeftJoin'), left, right, join: 'left', channels, type: { cols: [...cols, ...invalidRight] }, on });
    expect(() => check(invalid)).toThrow("RelIR: a left Join's right-side output columns must be nullable");
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
