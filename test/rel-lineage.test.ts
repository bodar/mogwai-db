// Column lineage through a JOIN is POSITIONAL (`joinSide`, `src/rel/walk.ts`): a join's output is its sides'
// columns left then right under the join's OWN declared names, so two sides routinely carry the same name and a
// lookup by name into a side can pick the wrong one. Every lineage question — `definingPath`/`columnAt`/
// `rowidScan` (`src/rel/lineage.ts`), `columnLineage`/`columnIsRowKey`/`columnIsStored` (`src/rel/copies.ts`) —
// resolves through the one mapper. Built by hand, because the lowering mints distinct names today.
import { describe, expect, test } from 'bun:test';
import type { Channels } from '../src/channels.ts';
import { col, compilerInt, eq } from '../src/rel/expr.ts';
import { distinct, join, limit, materialize, scan } from '../src/rel/factory.ts';
import { columnAt, definingPath, rowidScan } from '../src/rel/lineage.ts';
import { columnIsRowKey, columnIsStored, columnLineage } from '../src/rel/copies.ts';
import { joinSide } from '../src/rel/walk.ts';
import type { Rel } from '../src/rel/rel.ts';
import { relId, type ColMeta } from '../src/rel/types.ts';

const channels: Channels = [];
const int = (name: string, nullable = false): ColMeta => ({ name, type: 'int', nullable });
const edges = scan({ id: relId('e'), table: 'edges', alias: 'e', channels, type: { cols: [int('id'), int('src')] } });
const nodes = scan({ id: relId('n'), table: 'nodes', alias: 'n', channels, type: { cols: [int('id'), int('gid')] } });

/** `edges ⋈ nodes`, both sides carrying `id`: the join names the RIGHT side's `id` as `id`, the left's as `eid`. */
function swapped(kind: 'inner' | 'left' = 'inner'): Extract<Rel, { readonly kind: 'join' }> {
  return join({
    id: relId('j'), left: edges, right: nodes, join: kind, channels,
    on: eq(col(edges.id, 'src'), col(nodes.id, 'id')),
    type: { cols: [int('eid'), int('src'), int('id', kind === 'left'), int('gid', kind === 'left')] },
  }) as Extract<Rel, { readonly kind: 'join' }>;
}

describe('joinSide — a join column by POSITION', () => {
  test('maps the join name to the side holding its position, under the side\'s own name', () => {
    const j = swapped();
    expect(joinSide(j, 'eid')).toEqual({ side: edges, name: 'id', nullable: false });
    expect(joinSide(j, 'id')).toEqual({ side: nodes, name: 'id', nullable: false });
    expect(joinSide(j, 'gid')).toEqual({ side: nodes, name: 'gid', nullable: false });
    expect(joinSide(j, 'nope')).toBeNull();
  });
  test('marks a LEFT join\'s right side nullable — NULL where the left row is unmatched', () => {
    const j = swapped('left');
    expect(joinSide(j, 'eid')?.nullable).toBe(false);
    expect(joinSide(j, 'id')).toEqual({ side: nodes, name: 'id', nullable: true });
  });
  test('a semi join emits the left side alone', () => {
    const j = join({
      id: relId('sj'), left: edges, right: nodes, join: 'semi', channels,
      on: eq(col(edges.id, 'src'), col(nodes.id, 'id')), type: { cols: [int('x'), int('y')] },
    }) as Extract<Rel, { readonly kind: 'join' }>;
    expect(joinSide(j, 'x')).toEqual({ side: edges, name: 'id', nullable: false });
    expect(joinSide(j, 'y')).toEqual({ side: edges, name: 'src', nullable: false });
  });
});

describe('every lineage authority resolves a join column positionally', () => {
  test('definingPath / columnAt / rowidScan follow the position, not the name', () => {
    const j = swapped();
    const path = definingPath(j, 'id');
    expect(path.rels).toEqual([j, nodes]);
    expect(path.name).toBe('id');
    expect(definingPath(j, 'eid').rels.at(-1)).toBe(edges);
    expect(columnAt(j, 'eid', edges)).toBe('id');
    expect(columnAt(j, 'id', edges)).toBeNull();
    expect(rowidScan(j, j.id, 'id')).toBe(nodes);
    expect(rowidScan(j, j.id, 'eid')).toBe(edges);
    expect(rowidScan(j, j.id, 'src')).toBeNull();
  });
  test('columnLineage spells each join column over the side at its position', () => {
    const j = swapped();
    expect(columnLineage(j, 'id', new Map())).toEqual(col(nodes.id, 'id'));
    expect(columnLineage(j, 'eid', new Map())).toEqual(col(edges.id, 'id'));
    expect(columnIsStored(j, 'gid')).toBe(true);
  });
  test('a LEFT join\'s null-padded side is defined by the join itself', () => {
    const j = swapped('left');
    expect(definingPath(j, 'id').rels).toEqual([j]);
    expect(columnLineage(j, 'id', new Map())).toEqual(col(j.id, 'id'));
    expect(rowidScan(j, j.id, 'id')).toBeNull();
    expect(rowidScan(j, j.id, 'eid')).toBe(edges);
  });
  test('a row key stays one only where the other side is at most one row', () => {
    expect(columnIsRowKey(swapped(), 'id')).toBe(false);
    const one = limit({ id: relId('one'), input: nodes, channels, type: nodes.type, count: compilerInt(1) });
    const j = join({
      id: relId('j1'), left: edges, right: one, join: 'inner', channels, on: eq(col(edges.id, 'src'), col(one.id, 'id')),
      type: { cols: [int('eid'), int('src'), int('id'), int('gid')] },
    });
    expect(columnIsRowKey(j, 'eid')).toBe(true);
    expect(columnIsRowKey(j, 'src')).toBe(false);
  });
});

describe('definingPath passes the operators that carry their input\'s rows unchanged', () => {
  test('limit, distinct and materialize', () => {
    const fenced = materialize({ id: relId('m'), input: nodes, channels, type: nodes.type, fenced: true });
    const unique = distinct({ id: relId('d'), input: fenced, channels, type: nodes.type });
    const first = limit({ id: relId('l'), input: unique, channels, type: nodes.type, count: compilerInt(5) });
    expect(definingPath(first, 'id').rels).toEqual([first, unique, fenced, nodes]);
    expect(columnAt(first, 'gid', nodes)).toBe('gid');
    expect(rowidScan(first, first.id, 'id')).toBe(nodes);
  });
});
