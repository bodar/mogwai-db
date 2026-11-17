// THE READER-DEMAND FACT (`readInFull`, `src/rel/work.ts`) at the algebra level: how much of each relation its readers
// demand, as SQLite evaluates it. `'spine'` is magic's question (every output row read on every path, never through a
// subplan); `'once'` asks which relations are read in full OR re-evaluated more than once, and returns the complement
// — `stopsEarly`, demanded partially and evaluated once — so a consumer is conservative about anything else.
import { describe, expect, test } from 'bun:test';
import type { Channels } from '../src/channels.ts';
import { col, compilerInt, type Expr } from '../src/rel/expr.ts';
import { aggregate, filter, join, limit, materialize, project, recursive, scan, sort, values } from '../src/rel/factory.ts';
import type { Rel } from '../src/rel/rel.ts';
import { relId, type ColMeta } from '../src/rel/types.ts';
import { recursiveStep } from '../src/rel/walk.ts';
import { readInFull, readsInputInFull } from '../src/rel/work.ts';

const channels: Channels = [];
const int = (name: string): ColMeta => ({ name, type: 'int', nullable: false });
const eq = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: '=', left, right });
const gt = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: '>', left, right });

let n = 0;
const id = (hint: string) => relId(`${hint}${n++}`);
const nodes = () => scan({ id: id('n'), table: 'nodes', alias: 'n', channels, type: { cols: [int('id')] } });
const edges = () => scan({ id: id('e'), table: 'edges', alias: 'e', channels, type: { cols: [int('src'), int('tgt')] } });
const unit = () => values({ id: id('u'), channels, type: { cols: [int('one')] }, rows: [[compilerInt(1)]] });
/** An unbounded relation with something to stop early in: a filter over a whole scan. */
const someNodes = (): Rel => { const s = nodes(); return filter({ id: id('f'), input: s, channels, type: s.type, pred: gt(col(s.id, 'id'), compilerInt(3)) }); };
const first = (input: Rel): Rel => limit({ id: id('l'), input, channels, type: input.type, count: compilerInt(1) });
const firstOf = (input: Rel, count = 5): Rel => limit({ id: id('l'), input, channels, type: input.type, count: compilerInt(count) });
const holding = (e: Expr): Rel => { const u = unit(); return project({ id: id('p'), input: u, channels, type: { cols: [{ name: 'x', type: 'any', nullable: true }] }, exprs: [['x', e]] }); };

const spine = (root: Rel, inFull = true) => readInFull([root], 'spine', inFull);
const once = (root: Rel, inFull = true) => readInFull([root], 'once', inFull);

describe('the blocking kinds', () => {
  test('an aggregate, sort, window and materialization read their input in full; a limit and a distinct do not', () => {
    const s = nodes();
    const kinds = [
      aggregate({ id: id('a'), input: s, channels, type: { cols: [int('id')] }, groupBy: [col(s.id, 'id')], aggs: [] }),
      sort({ id: id('s'), input: s, channels, type: s.type, terms: [{ expr: col(s.id, 'id'), dir: 'asc' }] }),
      materialize({ id: id('m'), input: s, channels, type: s.type }),
    ];
    for (const r of kinds) expect(readsInputInFull(r)).toBe(true);
    expect(readsInputInFull(first(s))).toBe(false);
  });
});

describe('readInFull', () => {
  test('a LIMIT stops early: its input is demanded partially, in both modes', () => {
    const input = someNodes(), root = firstOf(input);
    expect(spine(root).full.has(input)).toBe(false);
    expect(once(root).stopsEarly.has(input)).toBe(true);
    expect(once(root).full.has(root)).toBe(true);
  });

  test('a barrier under a LIMIT stops early itself and reads its own input in full', () => {
    const input = someNodes();
    const agg = aggregate({ id: id('a'), input, channels, type: { cols: [int('id')] }, groupBy: [col(input.id, 'id')], aggs: [] });
    const root = firstOf(agg);
    for (const demand of [spine(root), once(root)]) expect(demand.full.has(input)).toBe(true);
    expect(once(root).stopsEarly.has(agg)).toBe(true);
  });

  test('an AGGREGATE root reads its input in full', () => {
    const input = someNodes();
    const root = aggregate({ id: id('a'), input, channels, type: { cols: [int('c')] }, groupBy: [], aggs: [['c', { kind: 'agg', fn: 'count', args: [] }]] });
    expect(spine(root).full.has(input)).toBe(true);
    expect(once(root).full.has(input)).toBe(true);
    expect(once(root).stopsEarly.size).toBe(0);
  });

  test('a root read partially (`rootsInFull` false) stops early', () => {
    const root = someNodes();
    expect(spine(root, false).full.has(root)).toBe(false);
    expect(once(root, false).stopsEarly.has(root)).toBe(true);
  });

  test('an UNCORRELATED EXISTS is evaluated once and reads to its first row', () => {
    const plan = someNodes();
    const root = holding({ kind: 'exists', plan, negated: false });
    expect(once(root).stopsEarly.has(plan)).toBe(true);
    // The spine never enters a subplan: it is in neither set.
    expect(spine(root).full.has(plan)).toBe(false);
    expect(spine(root).stopsEarly.size).toBe(0);
  });

  test('a CORRELATED EXISTS is re-run per outer row: everything it reads is read in full, beneath a LIMIT too', () => {
    const host = nodes();
    const e = edges();
    const probe = filter({ id: id('pf'), input: e, channels, type: e.type, pred: eq(col(e.id, 'src'), col(host.id, 'id')) });
    const plan = firstOf(probe);
    const root = filter({ id: id('hf'), input: host, channels, type: host.type, pred: { kind: 'exists', plan, negated: false } });
    const demand = once(root);
    for (const r of [plan, probe, e]) {
      expect(demand.full.has(r)).toBe(true);
      expect(demand.stopsEarly.has(r)).toBe(false);
    }
  });

  test('an uncorrelated SCALAR reads to its first row, unless it is at most one row', () => {
    const plan = someNodes();
    expect(once(holding({ kind: 'scalar', plan })).stopsEarly.has(plan)).toBe(true);
    const counted = someNodes();
    const count = aggregate({ id: id('a'), input: counted, channels, type: { cols: [int('c')] }, groupBy: [], aggs: [['c', { kind: 'agg', fn: 'count', args: [] }]] });
    const demand = once(holding({ kind: 'scalar', plan: count }));
    expect(demand.full.has(count)).toBe(true);
    expect(demand.full.has(counted)).toBe(true);
  });

  test('an IN (SELECT …) list is materialised: read in full', () => {
    const host = nodes();
    const e = edges();
    const plan = project({ id: id('ip'), input: e, channels, type: { cols: [int('src')] }, exprs: [['src', col(e.id, 'src')]] });
    const root = firstOf(filter({ id: id('hf'), input: host, channels, type: host.type, pred: { kind: 'in-query', expr: col(host.id, 'id'), plan, negated: false } }));
    const demand = once(root);
    expect(demand.full.has(plan)).toBe(true);
    expect(demand.full.has(e)).toBe(true);
    expect(demand.stopsEarly.has(host)).toBe(true);
  });

  for (const kind of ['semi', 'anti'] as const) {
    test(`a ${kind} join probes its right side per left row: in full under 'once', unless the left is one row`, () => {
      const left = someNodes(), right = edges();
      const on = eq(col(right.id, 'src'), col(left.id, 'id'));
      const root = firstOf(join({ id: id('j'), left, right, join: kind, on, channels, type: left.type }));
      expect(spine(root).full.has(right)).toBe(false);
      expect(once(root).full.has(right)).toBe(true);
      expect(once(root).stopsEarly.has(left)).toBe(true);

      const one = unit(), probed = edges();
      const single = join({ id: id('j'), left: one, right: probed, join: kind, on: eq(col(probed.id, 'src'), col(one.id, 'one')), channels, type: one.type });
      expect(once(single).stopsEarly.has(probed)).toBe(true);
    });
  }

  test('an inner join re-scans its inner loop per outer row: in full under \'once\'', () => {
    const left = someNodes(), right = edges();
    const joined = join({ id: id('j'), left, right, join: 'inner', on: eq(col(right.id, 'src'), col(left.id, 'id')), channels, type: { cols: [int('id'), int('src'), int('tgt')] } });
    const root = firstOf(joined);
    expect(once(root).stopsEarly.has(joined)).toBe(true);
    // Unordered, SQLite may put either side inside.
    expect(once(root).stopsEarly.has(left)).toBe(false);
    expect(once(root).stopsEarly.has(right)).toBe(false);
    const ordered = join({ ...joined, id: id('j'), ordered: true } as Parameters<typeof join>[0]);
    expect(once(firstOf(ordered)).stopsEarly.has(left)).toBe(true);
    expect(once(firstOf(ordered)).full.has(right)).toBe(true);
  });

  test('a recursive SEED takes the walk\'s demand; its TERM is re-run per iteration, read in full', () => {
    const seed = someNodes();
    const walk = recursive({
      id: id('w'), name: 'walk', cols: ['id'], seed, channels, type: seed.type,
      step: (self) => {
        const e = edges();
        const hop = join({ id: id('h'), left: self, right: e, join: 'inner', on: eq(col(e.id, 'src'), col(self.id, 'id')), channels, type: { cols: [int('id'), int('src'), int('tgt')] } });
        return project({ id: id('hp'), input: hop, channels, type: { cols: [int('id')] }, exprs: [['id', col(hop.id, 'tgt')]] });
      },
    });
    const root = first(walk);
    const term = recursiveStep(walk as Extract<Rel, { kind: 'recursive' }>);
    expect(once(root).stopsEarly.has(seed)).toBe(true);
    expect(once(root).full.has(term)).toBe(true);
    expect(once(root).stopsEarly.has(term)).toBe(false);
    // The spine never enters the term: unvisited is NOT partial.
    expect(spine(root).full.has(term)).toBe(false);
    expect(spine(root).full.has(seed)).toBe(false);
  });

  test('a relation read in full on one path and partially on another is in neither set', () => {
    const shared = someNodes();
    const partly = firstOf(shared);
    const wholly = sort({ id: id('s'), input: shared, channels, type: shared.type, terms: [{ expr: col(shared.id, 'id'), dir: 'asc' }] });
    const demand = readInFull([partly, wholly], 'once');
    expect(demand.full.has(shared)).toBe(false);
    expect(demand.stopsEarly.has(shared)).toBe(false);
  });
});
