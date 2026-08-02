import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { emit } from '../src/rel/emit.ts';
import { col, lit } from '../src/rel/expr.ts';
import type { Expr } from '../src/rel/expr.ts';
import { aggregate, distinct, filter, join, limit, project, recursive, scan as scanRel, sort, union, values } from '../src/rel/factory.ts';
import { relId } from '../src/rel/types.ts';

/**
 * An EMITTER SNAPSHOT — one exact string per node kind, and the block assembler's own properties.
 *
 * It is deliberately NOT the Phase-1 exit gate, and an earlier version of the build plan recorded it
 * as one: a gate over ten L2 traversal FAMILIES cannot be met by transcribing the emitter's own
 * output, which is what a per-kind pin is. It survives because a byte-exact record of what one node
 * renders to is the cheapest way to review an emitter change, and because the assembler's whole
 * claim — a run of operators is ONE `SELECT`, and a nested one opens only where a slot is already
 * occupied — is a statement about strings.
 */
const layout = { aliases: new Map(), origins: [], branchOrders: [] } as const;
const cols = [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'text', nullable: false }] as const;
const pairedCols = [...cols, ...cols.map((column) => ({ ...column, name: `${column.name}_r` }))] as const;
const scan = (id: string, alias = id) => scanRel({ id: relId(id), table: 'nodes', alias, layout, type: { cols } });
const eq = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: '=', left, right });

describe('RelIR relational-core SQL', () => {
  test('pins the rendering of every relational node kind', () => {
    const n = scan('n');
    const v = values({ id: relId('v'), rows: [[lit(1, 'int'), lit('marko', 'text')]], layout, type: { cols } });
    const p = project({ id: relId('p'), input: n, layout, type: { cols }, exprs: [['id', col(n.id, 'id')], ['name', col(n.id, 'name')]] });
    const f = filter({ id: relId('f'), input: n, layout, type: { cols }, pred: eq(col(n.id, 'name'), lit('marko', 'text')) });
    const a = aggregate({ id: relId('a'), input: n, layout, type: { cols: [{ name: 'n', type: 'int', nullable: false }] }, groupBy: [], aggs: [['n', { kind: 'agg', fn: 'count', args: [] }]] });
    const s = sort({ id: relId('s'), input: n, layout, type: { cols }, terms: [{ expr: col(n.id, 'name'), dir: 'asc' }] });
    const l = limit({ id: relId('l'), input: n, layout, type: { cols }, count: lit(2, 'int') });
    const d = distinct({ id: relId('d'), input: n, layout, type: { cols } });
    const m = scan('m');
    const j = join({ id: relId('j'), left: n, right: m, join: 'inner', on: eq(col(n.id, 'id'), col(m.id, 'id')), layout, type: { cols: pairedCols } });
    const u = union({ id: relId('u'), inputs: [n, m], all: true, layout, type: { cols } });

    expect([
      emit(v).sql,
      emit(p).sql,
      emit(f).sql,
      emit(a).sql,
      emit(s).sql,
      emit(l).sql,
      emit(d).sql,
      emit(j).sql,
      emit(u).sql,
      emit(recursive({ id: relId('walk'), name: 'walk', cols: ['id', 'name'], seed: v, layout, type: { cols }, step: (self) => self })).sql,
    ]).toEqual([
      'SELECT v.column1 AS id, v.column2 AS name FROM (VALUES (?, ?)) v',
      'SELECT n.id AS id, n.name AS name FROM nodes n',
      'SELECT n.id AS id, n.name AS name FROM nodes n WHERE (n.name = ?)',
      'SELECT count() AS n FROM nodes n',
      'SELECT n.id AS id, n.name AS name FROM nodes n ORDER BY n.name ASC',
      'SELECT n.id AS id, n.name AS name FROM nodes n LIMIT ?',
      'SELECT DISTINCT n.id AS id, n.name AS name FROM nodes n',
      'SELECT n.id AS id, n.name AS name, m.id AS id_r, m.name AS name_r FROM nodes n INNER JOIN nodes m ON (n.id = m.id)',
      // Unparenthesised on purpose: SQLite's compound arms are select-CORES, and `(SELECT …) UNION
      // ALL (SELECT …)` is `near "(": syntax error`.
      'SELECT n.id AS id, n.name AS name FROM nodes n UNION ALL SELECT m.id AS id, m.name AS name FROM nodes m',
      'WITH RECURSIVE walk(id, name) AS (SELECT v.column1 AS id, v.column2 AS name FROM (VALUES (?, ?)) v UNION ALL SELECT walk.id AS id, walk.name AS name FROM walk walk) SELECT * FROM walk',
    ]);
  });

  test('a run of operators is ONE SELECT, not one derived table per node', () => {
    const edgeCols = [{ name: 'src', type: 'int', nullable: false }, { name: 'tgt', type: 'int', nullable: false }] as const;
    const e = scanRel({ id: relId('e'), table: 'edges', alias: 'e', layout, type: { cols: edgeCols } });
    const p = scan('p');
    const joined = join({
      id: relId('j'), left: e, right: p, join: 'inner', layout,
      on: eq(col(e.id, 'src'), col(p.id, 'id')),
      type: { cols: [...edgeCols, ...cols] },
    });
    const kept = filter({ id: relId('kept'), input: joined, layout, type: joined.type, pred: eq(col(joined.id, 'name'), lit('marko', 'text')) });
    const out = project({ id: relId('out'), input: kept, layout, type: { cols: [{ name: 'id', type: 'int', nullable: false }] }, exprs: [['id', col(kept.id, 'tgt')]] });

    expect(emit(out).sql).toBe('SELECT e.tgt AS id FROM edges e INNER JOIN nodes p ON (e.src = p.id) WHERE (p.name = ?)');
  });

  test('a nested SELECT opens exactly where a slot is already occupied', () => {
    const n = scan('n');
    const capped = limit({ id: relId('capped'), input: n, layout, type: { cols }, count: lit(2, 'int') });
    // LIMIT is the slot the outer LIMIT needs, so this one — and only this one — nests.
    const twice = limit({ id: relId('twice'), input: capped, layout, type: { cols }, count: lit(1, 'int') });
    expect(emit(twice).sql).toBe('SELECT capped.id AS id, capped.name AS name FROM (SELECT n.id AS id, n.name AS name FROM nodes n LIMIT ?) capped LIMIT ?');

    // A filter over the same source needs only WHERE, which is free, so nothing nests.
    const named = filter({ id: relId('named'), input: n, layout, type: { cols }, pred: eq(col(n.id, 'name'), lit('marko', 'text')) });
    expect(emit(named).sql).not.toContain('(SELECT');
  });

  test('a Filter over an Aggregate is HAVING, not a wrapping SELECT', () => {
    const n = scan('n');
    const byName = aggregate({
      id: relId('byName'), input: n, layout,
      type: { cols: [{ name: 'name', type: 'text', nullable: false }, { name: 'n', type: 'int', nullable: false }] },
      groupBy: [col(n.id, 'name')], aggs: [['n', { kind: 'agg', fn: 'count', args: [] }]],
    });
    const popular = filter({ id: relId('popular'), input: byName, layout, type: byName.type, pred: { kind: 'binary', op: '>', left: col(byName.id, 'n'), right: lit(1, 'int') } });
    const emitted = emit(popular);
    expect(emitted.sql).toBe('SELECT n.name AS name, count() AS n FROM nodes n GROUP BY n.name HAVING (count() > ?)');

    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko'), (2, 'marko'), (3, 'vadas')");
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual([{ name: 'marko', n: 2 }]);
    db.close();
  });
});
