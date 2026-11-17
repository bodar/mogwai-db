// `leading` — the physical first-hit read of a CORRELATED re-source (`src/rel/passes/leading.ts`), at the algebra
// level. It recognises one shape — a `Limit 1` over a `Sort` led by the scan's rowid, or an `EXISTS` of a
// one-column projection, over the re-source cross (`reSourceCross`, `src/rel/lineage.ts`) whose seed reads an
// OUTER row — and is a total identity on everything else: a root-level re-source (an uncorrelated seed) is
// SQLite's to plan, and a sort not led by the rowid has no first element to find.
import { describe, expect, test } from 'bun:test';
import type { Channels } from '../src/channels.ts';
import { col, compilerInt, type Expr } from '../src/rel/expr.ts';
import { join, limit, project, scan, sort, values } from '../src/rel/factory.ts';
import { leading } from '../src/rel/passes/leading.ts';
import { reSourceCross } from '../src/rel/lineage.ts';
import type { Rel } from '../src/rel/rel.ts';
import { relId, type ColMeta } from '../src/rel/types.ts';

const channels: Channels = [];
const int = (name: string): ColMeta => ({ name, type: 'int', nullable: false });
const nodes = scan({ id: relId('n'), table: 'nodes', alias: 'n', channels, type: { cols: [int('id'), int('gid')] } });

/** A one-row seed: a unit row whose `h` column is `host` — an outer row's column, or a literal. */
function seed(host: Expr): Rel {
  const unit = values({ id: relId('u'), channels, type: { cols: [int('one')] }, rows: [[compilerInt(1)]] });
  return project({ id: relId('sd'), input: unit, channels, type: { cols: [int('h')] }, exprs: [['h', host]] });
}
function cross(host: Expr): Rel {
  const s = seed(host);
  return join({ id: relId('x'), left: s, right: nodes, join: 'cross', channels, type: { cols: [int('h'), int('id'), int('gid')] } });
}
function firstRow(host: Expr, terms = ['id', 'gid']): Rel {
  const x = cross(host);
  const sorted = sort({ id: relId('s'), input: x, channels, type: x.type, terms: terms.map((name) => ({ expr: col(x.id, name), dir: 'asc' as const })) });
  return limit({ id: relId('l'), input: sorted, channels, type: x.type, count: compilerInt(1) });
}
const outer = col(relId('host'), 'id');

describe('the re-source cross', () => {
  test('is a whole element scan crossed with a one-row seed, keyed by the scan rowid', () => {
    const found = reSourceCross(cross(outer));
    expect(found?.key).toBe('id');
    expect(found?.side).toBe(nodes);
  });
  test('a side that reads an outer row is not a whole-relation read', () => {
    const s = seed(outer);
    const x = join({ id: relId('x'), left: s, right: nodes, join: 'inner', on: { kind: 'binary', op: '=', left: col(nodes.id, 'id'), right: col(s.id, 'h') }, channels, type: { cols: [int('h'), int('id'), int('gid')] } });
    expect(reSourceCross(x)).toBeNull();
  });
});

describe('leading', () => {
  test('rewrites a correlated first-row pick to read its leading element first', () => {
    const plan = firstRow(outer);
    const out = leading(plan);
    expect(out).not.toEqual(plan);
    expect(out.kind).toBe('limit');
    expect(out.id).toBe(plan.id);
  });
  test('is the identity over a ROOT re-source: its seed reads no outer row', () => {
    const plan = firstRow(compilerInt(7));
    expect(leading(plan)).toEqual(plan);
  });
  test('is the identity where the sort is not led by the scan rowid, or by it alone', () => {
    for (const terms of [['gid', 'id'], ['id']]) {
      const plan = firstRow(outer, terms);
      expect(leading(plan)).toEqual(plan);
    }
  });
});
