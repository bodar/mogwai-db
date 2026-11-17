// A SEMI/ANTI JOIN WHOSE RIGHT SIDE IS A ROW-WISE FUNCTION OF ITS OWN LEFT needs no scope key on the right
// (`existenceOverOwnRows`, `src/rel/decorrelate.ts`). For `L ⋉ σ_P(π_x L)` on `x`, the left row's own image is in
// the right side of its own scope, so the test is `P(x)` — the same under every scope at once. The rule must
// REFUSE wherever the right side observes the scope's ROW SET or a column the join does not pair, because there
// the answer differs per scope: an aggregate, a limit, or a filter on an unpaired column.
import { describe, expect, test } from 'bun:test';
import { decorrelate } from '../../src/rel/decorrelate.ts';
import { col, compilerInt, eq, type Expr } from '../../src/rel/expr.ts';
import { aggregate, distinct, filter, join, limit, materialize, project, scan } from '../../src/rel/factory.ts';
import type { Rel } from '../../src/rel/rel.ts';
import { relId, type RelId } from '../../src/rel/types.ts';
import { forEachRel } from '../../src/rel/walk.ts';

const int = (name: string) => ({ name, type: 'int', nullable: false }) as const;
const gt = (left: Expr, n: number): Expr => ({ kind: 'binary', op: '>', left, right: compilerInt(n) });
const outer = scan({ id: relId('o'), table: 'nodes', alias: 'o', channels: [], type: { cols: [int('id')] } });
const edges = scan({ id: relId('e'), table: 'edges', alias: 'e', channels: [], type: { cols: [int('src'), int('tgt')] } });
/** L: the outer row's out-edges — correlated, so the decorrelator keys it by scope. */
const L = filter({ id: relId('L'), input: edges, channels: [], type: edges.type, pred: eq(col(edges.id, 'src'), col(outer.id, 'id')) });
const xOf = (id: string, input: Rel = L): Rel =>
  project({ id: relId(id), input, channels: [], type: { cols: [int('x')] }, exprs: [['x', col(input.id, 'tgt')]] });
const semi = (right: Rel): Rel =>
  join({ id: relId('j'), left: L, right, join: 'semi', channels: [], type: L.type, on: eq(col(L.id, 'tgt'), col(right.id, 'x')) });

let n = 0;
const fresh = (hint: string): RelId => relId(`${hint}${n++}`);
const keyed = (plan: Rel): Rel => {
  const out = decorrelate(plan, outer, 'id', fresh, undefined, () => true);
  if (!out) throw new Error('did not decorrelate');
  return out.rel;
};
/** The width of the node that kept id `id` in the rewritten plan — its own columns, plus the domain's if keyed. */
const width = (plan: Rel, id: string): number => {
  let w = -1;
  forEachRel(plan, (r) => { if (r.id === id) w = r.type.cols.length; });
  return w;
};

describe('decorrelate: a semi/anti join over a row-wise image of its own left', () => {
  const passing = (): Rel => {
    const states = distinct({ id: relId('d'), input: xOf('k'), channels: [], type: { cols: [int('x')] } });
    const tested = filter({ id: relId('f'), input: states, channels: [], type: states.type, pred: gt(col(states.id, 'x'), 1) });
    return materialize({ id: relId('m'), input: tested, channels: [], type: tested.type, fenced: true });
  };

  test('the right side is left UNKEYED: one passing set for every scope', () => {
    const out = keyed(semi(passing()));
    for (const id of ['k', 'd', 'f', 'm']) expect(width(out, id)).toBe(1);
  });

  test('an anti join too', () => {
    const right = passing();
    const out = keyed(join({ id: relId('j'), left: L, right, join: 'anti', channels: [], type: L.type, on: eq(col(L.id, 'tgt'), col(right.id, 'x')) }));
    expect(width(out, 'd')).toBe(1);
  });

  test('an AGGREGATE on the right sees the scope row set — it stays keyed', () => {
    const k = xOf('k');
    const counted = aggregate({
      id: relId('a'), input: k, channels: [], type: { cols: [int('x'), int('c')] },
      groupBy: [col(k.id, 'x')], aggs: [['c', { kind: 'agg', fn: 'count', args: [], distinct: false } as Expr]],
    });
    const many = filter({ id: relId('f'), input: counted, channels: [], type: counted.type, pred: gt(col(counted.id, 'c'), 1) });
    const out = keyed(semi(many));
    expect(width(out, 'a')).toBeGreaterThan(2);
  });

  test('a LIMIT on the right sees the scope row set — it stays keyed', () => {
    const k = xOf('k');
    const first = limit({ id: relId('l'), input: k, channels: [], type: k.type, count: compilerInt(1) });
    const out = keyed(semi(first));
    expect(width(out, 'k')).toBeGreaterThan(1);
  });

  test('a filter on a column the join does not pair asks whether SOME scope row passes — it stays keyed', () => {
    const bySrc = filter({ id: relId('f'), input: L, channels: [], type: L.type, pred: gt(col(L.id, 'src'), 1) });
    const out = keyed(semi(xOf('k', bySrc)));
    expect(width(out, 'k')).toBeGreaterThan(1);
  });

  test('a right side over ANOTHER relation is the general rule', () => {
    const other = filter({ id: relId('L2'), input: edges, channels: [], type: edges.type, pred: eq(col(edges.id, 'tgt'), col(outer.id, 'id')) });
    const out = keyed(semi(xOf('k', other)));
    expect(width(out, 'k')).toBeGreaterThan(1);
  });
});
