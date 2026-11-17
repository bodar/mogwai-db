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
import { aggregate, filter, join, project, scan as scanRel, sort, window } from '../src/rel/factory.ts';
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

// `fuse`'s second rule — Calcite's AggregateJoinTransposeRule over a CROSS join (`factor`). The claim is the
// answer, so every factored plan runs beside the unfactored one; the shape check is that no Aggregate reads the
// cross join's |L|×|R| rows any more (each side is grouped below it).
describe('fuse: an Aggregate factored over a cross Join', () => {
  const side = (id: string, keep?: string): Rel => {
    const s = scanRel({ id: relId(`${id}s`), table: 'nodes', alias: id, channels, type: { cols } });
    return keep === undefined ? s : filter({ id: relId(`${id}f`), input: s, channels, type: { cols },
      pred: { kind: 'binary', op: '!=', left: col(s.id, 'name'), right: lit(keep, 'text') } });
  };
  const crossOf = (l: Rel, r: Rel): Rel => join({ id: relId('j'), left: l, right: r, join: 'cross', channels,
    type: { cols: [...cols, { name: 'rid', type: 'int', nullable: false }, { name: 'rname', type: 'text', nullable: false }] } });
  const agg = (fn: 'sum' | 'count', ...args: Expr[]): Expr => ({ kind: 'agg', fn, args });
  const times = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: '*', left, right });
  /** `Aggregate(keys; aggs)` over a renaming Project over the cross join — the shape the pooled re-source lowers to. */
  const grouped = (l: Rel, r: Rel, keys: readonly string[], aggs: (j: Rel) => readonly (readonly [string, Expr])[]): Rel => {
    const j = crossOf(l, r);
    const p = project({ id: relId('p'), input: j, channels, type: j.type, exprs: j.type.cols.map((c) => [c.name, col(j.id, c.name)] as const) });
    const out = aggs(p);
    return aggregate({ id: relId('a'), input: p, channels, groupBy: keys.map((k) => col(p.id, k)),
      aggs: out, type: { cols: [...keys.map((k) => p.type.cols.find((c) => c.name === k)!), ...out.map(([name]): ColMeta => ({ name, type: 'any', nullable: true }))] } });
  };
  const factored = (plan: Rel): boolean => {
    let crossUnderAggregate = false;
    const go = (r: Rel, aggregated: boolean): void => {
      if (r.kind === 'join' && r.join === 'cross') {
        crossUnderAggregate ||= aggregated && ![r.left, r.right].every((s) => s.kind === 'aggregate' || (s.kind === 'filter' && s.input.kind === 'aggregate'));
        go(r.left, false); go(r.right, false); return;
      }
      if ('input' in r && r.input) go(r.input as Rel, r.kind === 'aggregate' || (aggregated && r.kind === 'project'));
    };
    go(plan, false);
    return !crossUnderAggregate;
  };
  const sorted = (rows: unknown[]): unknown[] => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const same = (plan: Rel): Rel => {
    const fused = fuse(plan);
    expect(() => check(fused)).not.toThrow();
    expect(sorted(rowsOf(fused))).toEqual(sorted(rowsOf(plan)));
    return fused;
  };

  test('COUNT(*), SUM of one side and SUM of a cross-side PRODUCT factor, keyed on both sides', () => {
    const plan = grouped(side('l', 'x'), side('r'), ['name', 'rname'], (p) => [
      ['c', agg('count')], ['s', agg('sum', col(p.id, 'rid'))], ['m', agg('sum', times(col(p.id, 'id'), col(p.id, 'rid')))],
    ]);
    const fused = same(plan);
    expect(factored(plan)).toBe(false);
    expect(factored(fused)).toBe(true);
  });

  test('a side with NO key is guarded: it keeps the key-side answer and never invents a group over an empty side', () => {
    const counted = grouped(side('l'), side('r'), ['name'], (p) => [['c', agg('count')], ['s', agg('sum', times(col(p.id, 'id'), col(p.id, 'rid')))]]);
    expect(factored(same(counted))).toBe(true);
    expect(sorted(rowsOf(fuse(counted)))).toContainEqual({ name: 'a', c: 6, s: 21 });
    // An EMPTY key-less side: the cross join is empty, so there is no group at all — not one group with a 0.
    const empty = filter({ id: relId('rz'), input: side('r'), channels, type: { cols },
      pred: { kind: 'binary', op: '=', left: col(relId('rs'), 'name'), right: lit('zzz', 'text') } });
    const none = grouped(side('l'), empty, ['name'], () => [['c', agg('count')]]);
    expect(rowsOf(same(none))).toEqual([]);
  });

  test('is left alone: DISTINCT, another function, a key that is not a bare column, and sides already grouped on their keys', () => {
    const distinct = grouped(side('l'), side('r'), ['name'], (p) => [['c', { kind: 'agg', fn: 'sum', args: [col(p.id, 'rid')], distinct: true }]]);
    expect(fuse(distinct)).toBe(distinct);
    const avg = grouped(side('l'), side('r'), ['name'], (p) => [['c', { kind: 'agg', fn: 'avg', args: [col(p.id, 'rid')] }]]);
    expect(fuse(avg)).toBe(avg);
    const once = fuse(grouped(side('l'), side('r'), ['name'], () => [['c', agg('count')]]));
    expect(fuse(once)).toBe(once);
  });
});

// THE NORMALISATION `factor` needs (`fuse.ts` `normalise`): a pooled re-source's body lands ABOVE its cross
// join — a hop as an inner Join over it, a predicate as a Filter — so the cross is brought up to the Aggregate
// by JoinAssociate / FilterJoin, KEPT only when `factor` then fires. Each plan is executed beside the
// unrewritten one; a shape the rule must refuse comes back as the SAME node, so its SQL is byte-identical.
describe('fuse: the cross join brought up to an Aggregate so it factors', () => {
  const side = (id: string): Rel => scanRel({ id: relId(`${id}s`), table: 'nodes', alias: id, channels, type: { cols } });
  const wide: readonly ColMeta[] = [...cols, { name: 'rid', type: 'int', nullable: false }, { name: 'rname', type: 'text', nullable: false }];
  const crossOf = (): Rel => join({ id: relId('j'), left: side('l'), right: side('r'), join: 'cross', channels, type: { cols: wide } });
  const renamed = (j: Rel): Rel => project({ id: relId('q'), input: j, channels, type: j.type, exprs: wide.map((c) => [c.name, col(j.id, c.name)] as const) });
  /** `Join(kind, Rename → Join(cross, l, r), c)` ON `c.id = <onCol> + 1` — a hop from one side of the product. */
  const hop = (kind: 'inner' | 'left', onCol: string): Rel => {
    const q = renamed(crossOf());
    const c = side('c');
    return join({ id: relId('h'), left: q, right: c, join: kind, channels,
      on: { kind: 'binary', op: '=', left: col(c.id, 'id'), right: { kind: 'binary', op: '+', left: col(q.id, onCol), right: lit(1, 'int') } },
      type: { cols: [...wide, { name: 'cid', type: 'int', nullable: kind === 'left' }, { name: 'cname', type: 'text', nullable: kind === 'left' }] } });
  };
  const agg = (fn: 'sum' | 'count' | 'max', ...args: Expr[]): Expr => ({ kind: 'agg', fn, args });
  const groupedOver = (input: Rel, keys: readonly string[], aggs: (r: Rel) => readonly (readonly [string, Expr])[]): Rel => {
    const out = aggs(input);
    return aggregate({ id: relId('a'), input, channels, groupBy: keys.map((k) => col(input.id, k)), aggs: out,
      type: { cols: [...keys.map((k) => input.type.cols.find((c) => c.name === k)!), ...out.map(([name]): ColMeta => ({ name, type: 'any', nullable: true }))] } });
  };
  const sorted = (rows: unknown[]): unknown[] => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  /** Is there a cross join beneath an Aggregate whose sides are not both grouped — the |L|×|R| product kept? */
  const crossUnderAggregate = (plan: Rel): boolean => {
    let found = false;
    const go = (r: Rel, under: boolean): void => {
      if (r.kind === 'join') {
        const grouped = [r.left, r.right].every((s) => s.kind === 'aggregate' || (s.kind === 'filter' && s.input.kind === 'aggregate'));
        found ||= under && r.join === 'cross' && !grouped;
        go(r.left, under && r.join !== 'cross'); go(r.right, under && r.join !== 'cross'); return;
      }
      if ('input' in r && r.input) go(r.input as Rel, under || r.kind === 'aggregate');
    };
    go(plan, false);
    return found;
  };
  const same = (plan: Rel): Rel => {
    const fused = fuse(plan);
    expect(() => check(fused)).not.toThrow();
    expect(sorted(rowsOf(fused))).toEqual(sorted(rowsOf(plan)));
    return fused;
  };

  test('JoinAssociate: an inner hop from the KEY-LESS side moves under it, and the product factors', () => {
    // Keyed on the left's name, the hop reads the right: `Join(cross, l, Join(inner, r, c))`, then factored.
    const plan = groupedOver(hop('inner', 'rid'), ['name'], (h) => [
      ['n', agg('count')], ['s', agg('sum', col(h.id, 'cid'))], ['m', agg('max', col(h.id, 'cname'))], ['w', agg('sum', col(h.id, 'id'))],
    ]);
    expect(crossUnderAggregate(plan)).toBe(true);
    const fused = same(plan);
    expect(crossUnderAggregate(fused)).toBe(false);
    expect(sorted(rowsOf(fused))).toContainEqual({ name: 'a', n: 5, s: 20, m: 'x', w: 5 });
  });

  test('a hop from the KEYED side moves that side under it instead; a LEFT hop is never re-associated', () => {
    // `Join(cross, r, Join(inner, l, c))`: the key is the inner side's, the plain side is the key-less one.
    const keyed = groupedOver(hop('inner', 'id'), ['name'], () => [['n', agg('count')]]);
    expect(crossUnderAggregate(same(keyed))).toBe(false);
    expect(sorted(rowsOf(fuse(keyed)))).toContainEqual({ name: 'x', n: 12 });
    // LEFT: an unmatched row of the product is padded once PER PAIR, which the move would not keep.
    const left = groupedOver(hop('left', 'rid'), ['name'], () => [['n', agg('count')]]);
    expect(fuse(left)).toBe(left);
  });

  test('FilterJoin: a predicate on the key-less side moves under the cross, conjunct by conjunct', () => {
    const q = renamed(crossOf());
    const f = filter({ id: relId('f'), input: q, channels, type: q.type, pred: {
      kind: 'binary', op: 'and',
      left: { kind: 'binary', op: '>', left: col(q.id, 'rid'), right: lit(2, 'int') },
      right: { kind: 'binary', op: '!=', left: col(q.id, 'rname'), right: lit('x', 'text') } } });
    const plan = groupedOver(f, ['name'], (r) => [['n', agg('count')], ['s', agg('sum', col(r.id, 'rid'))]]);
    const fused = same(plan);
    expect(crossUnderAggregate(fused)).toBe(false);
    expect(sorted(rowsOf(fused))).toContainEqual({ name: 'a', n: 3, s: 13 });
    // A conjunct reading BOTH sides has no place below: the plan is kept as it was.
    const mixed = groupedOver(filter({ id: relId('f'), input: q, channels, type: q.type,
      pred: { kind: 'binary', op: '<', left: col(q.id, 'id'), right: col(q.id, 'rid') } }), ['name'], () => [['n', agg('count')]]);
    expect(fuse(mixed)).toBe(mixed);
  });

  test('no Aggregate, or one factor cannot split: the plan is the SAME node — its SQL byte-identical', () => {
    const bare = hop('inner', 'rid');
    expect(fuse(bare)).toBe(bare);
    const avg = groupedOver(hop('inner', 'rid'), ['name'], (h) => [['v', { kind: 'agg', fn: 'avg', args: [col(h.id, 'cid')] }]]);
    expect(fuse(avg)).toBe(avg);
  });
});
