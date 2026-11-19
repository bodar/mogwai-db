// scripts/sql-plan.ts — the plan-shape gate resolves each EQP loop's ALIAS to its table through the emitted
// SQL's FROM items, and classifies a base-table SCAN by its tree position. The earlier check matched the
// word after SCAN against table NAMES, which the emitter never writes there, so it could not fire; these
// pin each class on a real compiled plan so that blindness cannot come back.
import { describe, expect, test } from 'bun:test';
import { aliasTables, classify, planOf, schemaFacts, seededPlanStore, type PlanRow } from '../scripts/sql-plan.ts';

const store = seededPlanStore();
const facts = schemaFacts(store);
const classes = (q: string) => {
  const got = planOf(store, q);
  if (!got) throw new Error(`no plan for ${q}`);
  return classify(got.plan, got.sql, facts).map((s) => `${s.cls}:${s.table}`).sort();
};

describe('sql-plan scan classification', () => {
  test('a root V() is a ROOT scan of nodes — a read of every element by meaning', () => {
    expect(classes('g.V()')).toEqual(['root:nodes']);
  });

  test('E().hasLabel seeks e_label: no base scan at all', () => {
    expect(classes(`g.E().hasLabel('knows')`)).toEqual([]);
  });

  test('a mid-traversal V() is an inner loop: NESTED', () => {
    expect(classes(`g.V().out('knows').V().values('name')`)).toEqual(['nested:nodes', 'root:nodes']);
  });

  test('a V() under a correlated subquery is NESTED', () => {
    expect(classes(`g.V().values('age').fold().difference(__.V().values('age').fold())`)).toContain('nested:nodes');
  });

  test('a nested child under a where() keeps its position: deeper compositions classify too', () => {
    expect(classes(`g.V().where(__.out('knows')).values('name')`)).toEqual(['root:nodes']);
  });

  test('TextP probes property_fts with a constraint (containing) or a rowid seek (notContaining): not flagged', () => {
    expect(classes(`g.V().has('name', TextP.containing('ark'))`)).toEqual([]);
    expect(classes(`g.V().has('name', TextP.notContaining('ark'))`)).toEqual([]);
  });

  test('call() reads are planned through the standard registry: tinker.search probes property_fts', () => {
    expect(planOf(store, `g.call('tinker.search', ['search':'mar'])`)).toBeDefined();
    expect(classes(`g.call('tinker.search', ['search':'mar'])`)).toEqual([]);
  });

  test('an unconstrained property_fts scan (bare idxStr) is the hard class; a constrained one is not', () => {
    const sql = `SELECT 1 FROM property_fts rf1 CROSS JOIN vertex_properties rp2 ON rp2.id = rf1.pid`;
    const rows = (idx: string): PlanRow[] => [
      { id: 3, parent: 0, detail: `SCAN rf1 VIRTUAL TABLE INDEX ${idx}` },
      { id: 9, parent: 0, detail: 'SEARCH rp2 USING INTEGER PRIMARY KEY (rowid=?)' },
    ];
    expect(classify(rows('0:'), sql, facts).map((s) => s.cls)).toEqual(['unconstrained-virtual']);
    expect(classify(rows('0:L4'), sql, facts)).toEqual([]);
    expect(classify(rows('0:='), sql, facts)).toEqual([]);
  });

  test('a string literal spelling a FROM item is not a FROM item; one alias naming two tables fails loudly', () => {
    expect([...aliasTables(`SELECT 'from edges rn' FROM nodes rn`, facts)]).toEqual([['rn', 'nodes']]);
    expect(() => aliasTables(`SELECT 1 FROM nodes rx CROSS JOIN edges rx`, facts)).toThrow(/names both/);
  });

  test('a derived relation is not a base table', () => {
    const sql = `SELECT 1 FROM (SELECT rn.id FROM nodes rn) rs1 CROSS JOIN json_each('[]') mx2`;
    const rows: PlanRow[] = [
      { id: 2, parent: 0, detail: 'SCAN rs1' },
      { id: 4, parent: 0, detail: 'SCAN mx2 VIRTUAL TABLE INDEX 1:' },
    ];
    expect(classify(rows, sql, facts)).toEqual([]);
  });
});
