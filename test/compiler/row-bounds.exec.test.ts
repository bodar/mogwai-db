// THE ROW-COUNT AUTHORITY — `rowBounds` (`src/rel/bounds.ts`) is the one answer to "how many rows can this
// relation yield", the question a correlated SCALAR subquery (at most one) and a child's `'always'` presence
// (exactly one) both ask. These pins hold the arms where the old three private walks disagreed, then the
// user-visible consequences: an exactly-one body carries no presence guard, and one that may be EMPTY keeps
// it (a scalar subquery over zero rows reads NULL — the body's absence, `TraversalMapStep`).
import { describe, expect, test } from 'bun:test';
import type { Channels } from '../../src/channels.ts';
import { atMostOneRow, exactlyOneRow, rowBounds } from '../../src/rel/bounds.ts';
import { col, compilerInt, lit, param } from '../../src/rel/expr.ts';
import { aggregate, distinct, filter, join, limit, scan as scanRel, union, values } from '../../src/rel/factory.ts';
import type { Rel } from '../../src/rel/rel.ts';
import { relId } from '../../src/rel/types.ts';
import { read, run, seededStore } from '../support/harness.ts';

const channels: Channels = [];
const one = { cols: [{ name: 'v', type: 'int', nullable: false }] } as const;
const scan = scanRel({ id: relId('n'), table: 'nodes', alias: 'n', channels, type: { cols: [{ name: 'id', type: 'int', nullable: false }] } });
const row = (id: string, n = 1) => values({ id: relId(id), channels, type: one, rows: Array.from({ length: n }, () => [compilerInt(1)]) });
const truthy = { kind: 'binary', op: '>', left: col(scan.id, 'id'), right: lit(0, 'int') } as const;
const count = (id: string, having?: boolean): Rel => aggregate({
  id: relId(id), input: scan, channels, type: one, groupBy: [],
  aggs: [['v', { kind: 'call', fn: 'count', args: [] }]],
  ...(having ? { having: { kind: 'binary', op: '>', left: col(relId(id), 'v'), right: lit(0, 'int') } } : {}),
});

describe('rowBounds', () => {
  test('values is its row count; a global aggregate is one row, or at most one under HAVING', () => {
    expect(rowBounds(row('v1'))).toEqual({ min: 1, max: 1 });
    expect(rowBounds(row('v3', 3))).toEqual({ min: 3, max: 3 });
    expect(rowBounds(count('c'))).toEqual({ min: 1, max: 1 });
    expect(rowBounds(count('ch', true))).toEqual({ min: 0, max: 1 });
    expect(exactlyOneRow(count('ch', true))).toBe(false);
    expect(atMostOneRow(count('ch', true))).toBe(true);
  });

  test('distinct over one row is still exactly one; a filter keeps only the ceiling', () => {
    const c = count('c');
    expect(exactlyOneRow(distinct({ id: relId('d'), input: c, channels, type: one }))).toBe(true);
    expect(rowBounds(filter({ id: relId('f'), input: c, channels, type: one, pred: truthy }))).toEqual({ min: 0, max: 1 });
    expect(rowBounds(scan)).toEqual({ min: 0, max: Infinity });
  });

  test('limit: a literal count caps, an offset subtracts, a parameter bounds nothing', () => {
    const f = filter({ id: relId('f'), input: scan, channels, type: scan.type, pred: truthy });
    expect(rowBounds(limit({ id: relId('l'), input: f, channels, type: scan.type, count: compilerInt(1) }))).toEqual({ min: 0, max: 1 });
    expect(rowBounds(limit({ id: relId('l'), input: row('v3', 3), channels, type: one, count: compilerInt(2), offset: compilerInt(2) }))).toEqual({ min: 1, max: 1 });
    expect(rowBounds(limit({ id: relId('l'), input: count('c'), channels, type: one, offset: compilerInt(1) }))).toEqual({ min: 0, max: 0 });
    expect(rowBounds(limit({ id: relId('l'), input: scan, channels, type: scan.type, count: param(1, 'n', 'int') }))).toEqual({ min: 0, max: Infinity });
  });

  test('a filter pinning a unique key over an element scan holds at most as many rows as it names', () => {
    const key = (name: string) => col(scan.id, name);
    const ids = (n: number) => ({ kind: 'in-list', expr: key('id'), values: Array.from({ length: n }, (_, i) => compilerInt(i + 1)) }) as const;
    const rowidOnly = { kind: 'binary', op: 'is', left: key('uid'), right: lit(null) } as const;
    const over = (pred: any) => rowBounds(filter({ id: relId('f'), input: scan, channels, type: scan.type, pred }));
    // `V(1)`, `V(1, 2)`, `V('a')`, `V(1, 'a')`, `V($x)` — `idMembership`'s shapes.
    expect(over({ kind: 'binary', op: 'and', left: ids(1), right: rowidOnly })).toEqual({ min: 0, max: 1 });
    expect(over({ kind: 'binary', op: 'and', left: ids(2), right: rowidOnly })).toEqual({ min: 0, max: 2 });
    expect(over({ kind: 'in-list', expr: key('uid'), values: [lit('a', 'text')] })).toEqual({ min: 0, max: 1 });
    expect(over({ kind: 'binary', op: 'or', left: { kind: 'binary', op: 'and', left: ids(1), right: rowidOnly }, right: { kind: 'in-list', expr: key('uid'), values: [lit('a', 'text')] } }))
      .toEqual({ min: 0, max: 2 });
    expect(over({ kind: 'binary', op: '=', left: key('id'), right: param(1, 'x', 'int') })).toEqual({ min: 0, max: 1 });
    // A disjunct that pins nothing, or a non-key column, bounds nothing.
    expect(over({ kind: 'binary', op: 'or', left: ids(1), right: truthy })).toEqual({ min: 0, max: Infinity });
    expect(over({ kind: 'in-list', expr: key('label'), values: [compilerInt(1)] })).toEqual({ min: 0, max: Infinity });
  });

  test('a join multiplies; only an ON that always holds keeps a floor; union all sums', () => {
    const [a, b] = [row('a', 2), row('b', 3)];
    const type = { cols: [one.cols[0], { ...one.cols[0], name: 'w' }] } as const;
    expect(rowBounds(join({ id: relId('j'), left: a, right: b, join: 'cross', channels, type }))).toEqual({ min: 6, max: 6 });
    expect(rowBounds(join({ id: relId('j'), left: a, right: b, join: 'inner', channels, type, on: { kind: 'binary', op: '=', left: col(a.id, 'v'), right: col(b.id, 'v') } }))).toEqual({ min: 0, max: 6 });
    expect(rowBounds(union({ id: relId('u'), inputs: [a, b], all: true, channels, type: one }))).toEqual({ min: 5, max: 5 });
  });
});

describe('a one-row child body', () => {
  const store = seededStore();
  const answer = (q: string) => run(store, q).map((r: { v: unknown }) => r.v);
  const guarded = (q: string) => /IS NOT NULL/.test(read(q).sql);

  test('exactly one row — always productive, no presence guard', () => {
    for (const q of ['g.V().map(__.V().count().dedup()).count()', 'g.V().map(__.V().count().limit(1)).count()', "g.V().map(__.V().has('name','nope').count()).count()"]) {
      expect(answer(q)).toEqual([6]);
      expect(guarded(q)).toBe(false);
    }
  });

  test('a body that may be empty keeps its guard and drops the traverser', () => {
    expect(answer('g.V().map(__.V().count().is(0)).count()')).toEqual([0]);
    expect(answer('g.V().map(__.out().count().skip(1)).count()')).toEqual([0]);
    expect(answer('g.V().local(__.out().fold().limit(0)).count()')).toEqual([0]);
    // ProjectStep keeps a key only for a productive by() (`ProjectStep.map`, `ifProductive`).
    expect(answer("g.V().project('a').by(__.out().count().skip(1)).count(local)")).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test('an unproductive group value drops its key', () => {
    // `Group.feature` g_V_group_byXvaluesXnameXX_byXout_fold_countXlocalX_isXgtX0XXX: a key whose value
    // traversal produces nothing is absent from the map, never mapped to null.
    expect(answer('g.inject([a:1]).unfold().group().by(keys).by(__.select(values).count().is(0)).count(local)')).toEqual([0]);
  });

  // A map entry's value may be a PRODUCTIVE null: over a body that may be empty its NULL cannot say "no
  // row", so presence is the row's EXISTENCE, never the value's nullness. `DedupGlobalStep.filter` keeps the
  // first null, `Grouping.doFinalReduction` drops a key only when its value traversal has no next, and a
  // sum over all-null input is null (`Sum.feature`). Each of these dropped the `a` key under value-nullness.
  test('a null map-entry value through a may-be-empty body keeps its group key', () => {
    const groups = (q: string) => (run(store, q) as { map: string }[]).map((r) => JSON.parse(r.map) as unknown);
    const NULL = { t: null, v: null };
    const A = [{ t: 'string', v: 'a' }, NULL], B = [{ t: 'string', v: 'b' }, { t: 'int', v: 1 }];
    for (const tail of ['dedup()', 'sum()', 'max()', 'dedup().limit(1)'])
      expect(groups(`g.inject(['a':null,'b':1]).unfold().group().by(keys).by(__.select(values).${tail})`)).toEqual([[A, B]]);
    for (const tail of ['is(null)', 'is(eq(null))', 'is(neq(1))', 'not(__.is(1))'])
      expect(groups(`g.inject(['a':null,'b':1]).unfold().group().by(keys).by(__.select(values).${tail})`)).toEqual([[A]]);
    // The key arm reads the same authority: a null key is a group, not an absent one.
    expect(groups("g.inject(['a':null]).unfold().group().by(__.select(values).dedup()).by(keys)"))
      .toEqual([[[NULL, { t: 'list', v: [{ t: 'string', v: 'a' }] }]]]);
    expect(groups("g.inject(['a':null,'b':1]).unfold().groupCount().by(__.select(values).dedup())"))
      .toEqual([[[{ t: 'int', v: 1 }, { t: 'long', v: 1 }], [NULL, { t: 'long', v: 1 }]]]);
    // A body that rejects the entry still drops its key.
    expect(groups("g.inject(['a':1,'b':2]).unfold().group().by(keys).by(__.select(values).is(1))")).toEqual([[[{ t: 'string', v: 'a' }, { t: 'int', v: 1 }]]]);
  });
});
