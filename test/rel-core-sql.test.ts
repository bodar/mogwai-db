import { describe, expect, test } from 'bun:test';
import { emit } from '../src/rel/emit.ts';
import { col, lit } from '../src/rel/expr.ts';
import * as rel from '../src/rel/factory.ts';
import { relId } from '../src/rel/types.ts';

/** Phase-1 exit gate: relational cores of representative L2 traversal families.
 *
 * These deliberately stop before legacy result framing. RelIR has no Gremlin shape and the
 * framing adapter stays outside this clean-room boundary; each assertion is byte-exact SQL for
 * the relational algebra the legacy L2 plan contains. */
const layout = { aliases: new Map(), origins: [], branchOrders: [] } as const;
const cols = [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'text', nullable: false }] as const;
const scan = (id: string, alias = id) => rel.scan({ id: relId(id), table: 'nodes', alias, layout, type: { cols } });

describe('RelIR relational-core SQL', () => {
  test('pins ten representative L2 relational cores byte-for-byte', () => {
    const n = scan('n');
    const v = rel.values({ id: relId('v'), rows: [[lit(1, 'int'), lit('marko', 'text')]], layout, type: { cols } });
    const p = rel.project({ id: relId('p'), input: n, layout, type: { cols }, exprs: [['id', col(n.id, 'id')], ['name', col(n.id, 'name')]] });
    const f = rel.filter({ id: relId('f'), input: n, layout, type: { cols }, pred: { kind: 'binary', op: '=', left: col(n.id, 'name'), right: lit('marko', 'text') } });
    const a = rel.aggregate({ id: relId('a'), input: n, layout, type: { cols: [{ name: 'n', type: 'int', nullable: false }] }, groupBy: [], aggs: [['n', { kind: 'agg', fn: 'count', args: [] }]] });
    const s = rel.sort({ id: relId('s'), input: n, layout, type: { cols }, terms: [{ expr: col(n.id, 'name'), dir: 'asc' }] });
    const l = rel.limit({ id: relId('l'), input: n, layout, type: { cols }, count: lit(2, 'int') });
    const d = rel.distinct({ id: relId('d'), input: n, layout, type: { cols } });
    const m = scan('m');
    const j = rel.join({ id: relId('j'), left: n, right: m, join: 'inner', on: { kind: 'binary', op: '=', left: col(n.id, 'id'), right: col(m.id, 'id') }, layout, type: { cols } });
    const u = rel.union({ id: relId('u'), inputs: [n, m], all: true, layout, type: { cols } });

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
      emit(rel.recursive({ id: relId('walk'), name: 'walk', cols: ['id', 'name'], seed: v, layout, type: { cols }, step: (self) => self })).sql,
    ]).toEqual([
      'SELECT column1 AS id, column2 AS name FROM (VALUES (?, ?))',
      'SELECT n.id AS id, n.name AS name FROM nodes n',
      'SELECT * FROM nodes n WHERE (n.name = ?)',
      'SELECT count() AS n FROM nodes n',
      'SELECT * FROM nodes n ORDER BY n.name ASC',
      'SELECT * FROM nodes n LIMIT ?',
      'SELECT DISTINCT * FROM nodes n',
      'SELECT * FROM nodes n INNER JOIN nodes m ON (n.id = m.id)',
      '(SELECT n.id AS id, n.name AS name FROM nodes n) UNION ALL (SELECT m.id AS id, m.name AS name FROM nodes m)',
      'WITH RECURSIVE walk(id, name) AS (SELECT column1 AS id, column2 AS name FROM (VALUES (?, ?)) UNION ALL SELECT walk.id AS id, walk.name AS name FROM walk) SELECT * FROM walk',
    ]);
  });
});
