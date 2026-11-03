// `fuse`'s one transpose — a Filter pushed below a ROW_NUMBER() renumber Window — at the algebra level.
//
// The rule is sound exactly when every reader of the window's column uses it as an ORDER position, so
// these pin both halves: the shapes it must move (the column only ever sorted by), and the shapes it must
// leave alone, each of which reads the number as a VALUE and would answer differently over the filtered
// row set (a slice `enc <= k`, the predicate itself reading the number, the number reaching the user, a
// PARTITIONED numbering whose cross-partition order a filter can reshuffle). Every moved plan is executed
// beside the unmoved one: the answer, not the shape, is the claim.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { Channels } from '../src/channels.ts';
import { check } from '../src/rel/check.ts';
import { emitQuery } from '../src/rel/emit.ts';
import { col, lit, type Expr } from '../src/rel/expr.ts';
import { filter, project, scan as scanRel, sort, window } from '../src/rel/factory.ts';
import { fuse } from '../src/rel/passes/fuse.ts';
import { planOf } from '../src/rel/plan.ts';
import type { Rel } from '../src/rel/rel.ts';
import { relId, type ColMeta } from '../src/rel/types.ts';

const channels: Channels = [];
const cols: readonly ColMeta[] = [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'text', nullable: false }];
const withEnc: readonly ColMeta[] = [...cols, { name: 'enc', type: 'int', nullable: false }];
const scan = scanRel({ id: relId('n'), table: 'nodes', alias: 'n', channels, type: { cols } });

/** `Filter(pred) → Project(id, name, enc ← rn) → Window(rn: row_number OVER (ORDER BY id DESC))`. */
function renumbered(pred: (projected: Rel) => Expr, partitioned = false): Rel {
  const w = window({
    id: relId('w'), input: scan, channels, type: { cols: [...cols, { name: 'rn', type: 'int', nullable: false }] },
    specs: [['rn', { kind: 'window-expr', fn: 'row_number', args: [],
      spec: { partitionBy: partitioned ? [col(scan.id, 'name')] : [], orderBy: [{ expr: col(scan.id, 'id'), dir: 'desc' }] } }]],
  });
  const p = project({ id: relId('p'), input: w, channels, type: { cols: withEnc },
    exprs: [['id', col(w.id, 'id')], ['name', col(w.id, 'name')], ['enc', col(w.id, 'rn')]] });
  return filter({ id: relId('f'), input: p, channels, type: { cols: withEnc }, pred: pred(p) });
}
const named = (r: Rel): Expr => ({ kind: 'binary', op: '!=', left: col(r.id, 'name'), right: lit('x', 'text') });
/** Sort by the number, then hand the user `id`/`name` only — the number is observed as an order and nothing else. */
const sortedOut = (f: Rel): Rel => {
  const s = sort({ id: relId('s'), input: f, channels, type: f.type, terms: [{ expr: col(f.id, 'enc'), dir: 'asc' }] });
  return project({ id: relId('out'), input: s, channels, type: { cols }, exprs: [['id', col(s.id, 'id')], ['name', col(s.id, 'name')]] });
};

const rowsOf = (plan: Rel): unknown[] => {
  const db = new Database(':memory:');
  db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
  db.run("INSERT INTO nodes VALUES (1, 'a'), (2, 'x'), (3, 'b'), (4, 'c'), (5, 'x'), (6, 'd')");
  const emitted = emitQuery(planOf(plan));
  const rows = db.query(emitted.sql).all(...emitted.binds);
  db.close();
  return rows;
};

/** Is the filter now BELOW the window — i.e. does a `Window` sit above some `Filter` in the spine? */
const pushed = (plan: Rel): boolean => {
  const go = (r: Rel, underWindow: boolean): boolean =>
    (r.kind === 'filter' && underWindow) || ('input' in r && r.input !== undefined && go(r.input, underWindow || r.kind === 'window'));
  return go(plan, false);
};

describe('fuse: a Filter below a renumber Window', () => {
  test('moves when the number is only ever an ORDER position, and the answer (in order) is unchanged', () => {
    const plan = sortedOut(renumbered(named));
    const fused = fuse(plan);
    expect(pushed(plan)).toBe(false);
    expect(pushed(fused)).toBe(true);
    expect(() => check(fused)).not.toThrow();
    expect(rowsOf(fused)).toEqual(rowsOf(plan));
    expect(rowsOf(fused)).toEqual([{ id: 6, name: 'd' }, { id: 4, name: 'c' }, { id: 3, name: 'b' }, { id: 1, name: 'a' }]);
  });

  test('does NOT move when a slice above reads the number as a value (enc <= 2)', () => {
    const f = renumbered(named);
    const slice = filter({ id: relId('slice'), input: f, channels, type: f.type,
      pred: { kind: 'binary', op: '<=', left: col(f.id, 'enc'), right: lit(2, 'int') } });
    const plan = project({ id: relId('out'), input: slice, channels, type: { cols }, exprs: [['id', col(slice.id, 'id')], ['name', col(slice.id, 'name')]] });
    expect(fuse(plan)).toBe(plan);
    // Moving it WOULD change the answer: the window numbered 5 (an x) at 2, so only id 6 survives; pushed, 4 would join it `enc <= 2`.
    expect(rowsOf(plan)).toEqual([{ id: 6, name: 'd' }]);
  });

  test('does NOT move a predicate that reads the number itself', () => {
    const plan = sortedOut(renumbered((p) => ({ kind: 'binary', op: '>', left: col(p.id, 'enc'), right: lit(1, 'int') })));
    expect(fuse(plan)).toBe(plan);
  });

  test('does NOT move when the number reaches the user', () => {
    const plan = renumbered(named);
    expect(fuse(plan)).toBe(plan);
  });

  test('does NOT move below a PARTITIONED numbering — a filter can reshuffle its cross-partition order', () => {
    const plan = sortedOut(renumbered(named, true));
    expect(fuse(plan)).toBe(plan);
  });
});
