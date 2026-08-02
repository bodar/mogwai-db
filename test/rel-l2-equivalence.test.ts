import { describe, expect, test } from 'bun:test';
import { emitQuery } from '../src/rel/emit.ts';
import { col, lit, type Expr } from '../src/rel/expr.ts';
import * as make from '../src/rel/factory.ts';
import { name } from '../src/rel/passes/name.ts';
import type { Rel, Table } from '../src/rel/rel.ts';
import type { Channels } from '../src/channels.ts';
import { relId, type ColMeta, type SqlType } from '../src/rel/types.ts';
import { read, seededStore } from './support/harness.ts';
import { accessPaths, relationalCore } from './support/sql-core.ts';

/**
 * PHASE 1's EXIT GATE — §5a of `docs/2026-08-01-relir-build-plan.md`, over real L2 traversal
 * families rather than over the emitter's own output.
 *
 * For each family: compile the canonical Gremlin, take the legacy plan's RELATIONAL CORE
 * mechanically (its CTE chain, with the result-framing SELECT replaced — RelIR sits below framing,
 * §2), hand-build the equivalent RelIR plan, and assert the two properties worth holding:
 *
 *   1. the SAME ROWS on the reference fixture, and
 *   2. the SAME ACCESS PATH — identical `EXPLAIN QUERY PLAN` index decisions.
 *
 * Byte-identical SQL is deliberately NOT the gate (it is against `test/CLAUDE.md`'s own rule, and
 * the assembler legitimately collapses the legacy's derived tables). Together these two are a
 * STRONGER falsification: they fail a plan that reads the same and executes differently, which
 * string equality catches only by accident and result-equivalence misses entirely.
 *
 * The plans below carry the trivial layout: which columns are CHANNELS is orthogonal to whether
 * the algebra can express the core, and the channel obligations have their own counterexample
 * tests in `test/rel.test.ts`.
 */

const channels: Channels = [];
const meta = (name: string, type: SqlType = 'any', nullable = false): ColMeta => ({ name, type, nullable });
const cols = (...names: readonly (string | ColMeta)[]) => ({ cols: names.map((n) => (typeof n === 'string' ? meta(n) : n)) });

let seq = 0;
const fresh = (hint: string) => relId(`${hint}${seq++}`);

const scan = (table: Table, alias: string, ...columns: readonly string[]) =>
  make.scan({ id: relId(alias), table, alias, channels, ...{ type: cols(...columns) } });
/** `Project` is the only node that may declare output columns, so it is also the shorthand for
 * narrowing a wide physical scan to the attributes a plan actually reads. */
const project = (input: Rel, exprs: readonly (readonly [string, Expr])[], id = fresh('p')) =>
  make.project({ id, input, channels, type: cols(...exprs.map(([n]) => n)), exprs });
const pick = (input: Rel, ...names: readonly string[]) => project(input, names.map((n) => [n, col(input.id, n)] as const));
const filter = (input: Rel, pred: Expr) => make.filter({ id: fresh('f'), input, channels, type: input.type, pred });
const join = (left: Rel, right: Rel, on: Expr, names: readonly string[]) =>
  make.join({ id: fresh('j'), left, right, join: 'inner', on, channels, type: cols(...names) });
const cte = (input: Rel, cteName: string) => make.materialize({ id: relId(`${cteName}_m`), input, channels, type: input.type, name: cteName });

const binary = (op: Extract<Expr, { kind: 'binary' }>['op'], left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
const inList = (expr: Expr, values: readonly Expr[]): Expr => ({ kind: 'in-list', expr, values });
const inQuery = (expr: Expr, plan: Rel): Expr => ({ kind: 'in-query', expr, plan, negated: false });

const NODE = ['id', 'uid'] as const;
const EDGE = ['id', 'uid', 'src', 'label', 'tgt'] as const;
const VP = ['id', 'node', 'key', 'value', 'vtype', 'meta'] as const;

/** `c0` — every element-source family starts here: one row per vertex at bulk 1. */
const vertexSource = (where?: (n: Rel) => Expr) => {
  const n = scan('nodes', 'n', ...NODE);
  const source = where ? filter(n, where(n)) : n;
  return cte(project(source, [['id', col(source.id, 'id')], ['bulk', lit(1, 'int')]], fresh('c')), 'c0');
};
/** `SELECT id FROM labels WHERE name IN (…)` — the label-name indirection every label-aware step
 * reaches through, and the reason `labels` is a `Scan` table rather than a string. */
const labelIds = (...names: readonly string[]) => {
  const l = scan('labels', 'l', 'id', 'name');
  const matching = filter(l, inList(col(l.id, 'name'), names.map((n) => lit(n, 'text'))));
  return pick(matching, 'id');
};

interface Family { readonly gremlin: string; readonly plan: () => Rel; }

const FAMILIES: readonly Family[] = [
  // 1 — the element source.
  { gremlin: 'g.V()', plan: () => vertexSource() },

  // 2 — the source narrowed by id: an `InList` bounded by the query text, not by row count.
  { gremlin: 'g.V(1)', plan: () => vertexSource((n) => inList(col(n.id, 'id'), [lit(1, 'int')])) },

  // 3 — movement, with the bulk coalescing that makes it a grouped aggregate.
  {
    gremlin: "g.V().out('knows')",
    plan: () => {
      const c0 = vertexSource();
      const e = pick(scan('edges', 'e', ...EDGE), 'src', 'label', 'tgt');
      const j = join(e, c0, binary('and', binary('=', col(e.id, 'src'), col(c0.id, 'id')), inQuery(col(e.id, 'label'), labelIds('knows'))), ['src', 'label', 'tgt', 'pid', 'bulk']);
      const moved = project(j, [['id', col(j.id, 'tgt')], ['bulk', col(j.id, 'bulk')]]);
      return make.aggregate({
        id: fresh('agg'), input: moved, channels, type: cols('id', 'bulk'),
        groupBy: [col(moved.id, 'id')], aggs: [['bulk', { kind: 'agg', fn: 'sum', args: [col(moved.id, 'bulk')] }]],
      });
    },
  },

  // 4 — the label filter: `vertex_labels` seeked by its covering index, nested one level deeper
  // than the edge case because a label NAME resolves through `labels` first.
  {
    gremlin: "g.V().hasLabel('person')",
    plan: () => {
      const c0 = vertexSource();
      const nId = pick(scan('nodes', 'n2', ...NODE), 'id');
      const j = join(nId, c0, binary('=', col(nId.id, 'id'), col(c0.id, 'id')), ['id', 'pid', 'bulk']);
      const vl = scan('vertex_labels', 'vl', 'node', 'label');
      const labelled = pick(filter(vl, inQuery(col(vl.id, 'label'), labelIds('person'))), 'node');
      return pick(filter(j, inQuery(col(j.id, 'id'), labelled)), 'id', 'bulk');
    },
  },

  // 5 — the property filter, as a correlated `EXISTS` rather than a join.
  {
    gremlin: "g.V().has('name','marko')",
    plan: () => {
      const c0 = vertexSource();
      const nId = pick(scan('nodes', 'n2', ...NODE), 'id');
      const j = join(nId, c0, binary('=', col(nId.id, 'id'), col(c0.id, 'id')), ['id', 'pid', 'bulk']);
      const vp = scan('vertex_properties', 'vp', ...VP);
      const matching = filter(vp, binary('and',
        binary('and', binary('=', col(vp.id, 'node'), col(j.id, 'id')), binary('=', col(vp.id, 'key'), lit('name', 'text'))),
        binary('=', col(vp.id, 'value'), lit('marko', 'text'))));
      return pick(filter(j, { kind: 'exists', negated: false, plan: project(matching, [['one', lit(1, 'int')]]) }), 'id', 'bulk');
    },
  },

  // 6 — the value projection: two joins and the storage-class CASE that recovers a JSON value.
  {
    gremlin: "g.V().values('name')",
    plan: () => {
      const c0 = vertexSource();
      const nId = pick(scan('nodes', 'n2', ...NODE), 'id');
      const j1 = join(nId, c0, binary('=', col(nId.id, 'id'), col(c0.id, 'id')), ['id', 'pid', 'bulk']);
      const vp = pick(scan('vertex_properties', 'vp', ...VP), 'node', 'key', 'value', 'vtype');
      const j2 = join(j1, vp, binary('and', binary('=', col(j1.id, 'id'), col(vp.id, 'node')), binary('=', col(vp.id, 'key'), lit('name', 'text'))),
        ['id', 'pid', 'bulk', 'node', 'key', 'value', 'vtype']);
      const jsonValue: Expr = {
        kind: 'case',
        whens: [[inList(col(j2.id, 'vtype'), [lit('list', 'text'), lit('map', 'text'), lit('set', 'text')]), { kind: 'call', fn: 'json', args: [col(j2.id, 'value')] }]],
        else: col(j2.id, 'value'),
      };
      return project(j2, [['v', jsonValue], ['vtype', col(j2.id, 'vtype')], ['bulk', col(j2.id, 'bulk')]]);
    },
  },

  // 7 — the reducing barrier: a whole-relation aggregate whose aggregate is wrapped in a call.
  {
    gremlin: 'g.V().count()',
    plan: () => {
      const c0 = vertexSource();
      return make.aggregate({
        id: fresh('agg'), input: c0, channels, type: cols(meta('v', 'int')), groupBy: [],
        aggs: [['v', { kind: 'call', fn: 'COALESCE', args: [{ kind: 'agg', fn: 'sum', args: [col(c0.id, 'bulk')] }, lit(0, 'int')] }]],
      });
    },
  },

  // 8 — the row-algebraic class: `Sort` then `Limit`, one SELECT with both slots filled.
  {
    gremlin: 'g.V().limit(2)',
    plan: () => {
      const n = scan('nodes', 'n', ...NODE);
      const c0 = cte(project(n, [['id', col(n.id, 'id')], ['bulk', lit(1, 'int')], ['encounter', col(n.id, 'id')]]), 'c0');
      const ordered = make.sort({ id: fresh('s'), input: c0, channels, type: c0.type, terms: [{ expr: col(c0.id, 'encounter'), dir: 'asc' }] });
      return make.limit({ id: fresh('l'), input: ordered, channels, type: c0.type, count: lit(2, 'int') });
    },
  },

  // 9 — whole-row dedup over a projection, one of §3's declared collapses.
  {
    gremlin: 'g.V().dedup()',
    plan: () => {
      const c0 = vertexSource();
      const projected = project(c0, [['id', col(c0.id, 'id')], ['bulk', lit(1, 'int')]]);
      return make.distinct({ id: fresh('d'), input: projected, channels, type: projected.type });
    },
  },

  // 10 — the branch merge: an n-ary UNION ALL over two independently rooted arms.
  {
    gremlin: 'g.union(__.V(2),__.V(4))',
    plan: () => {
      const arm = (cteName: string, id: number) => {
        const n = scan('nodes', `n_${cteName}`, ...NODE);
        const chosen = filter(n, inList(col(n.id, 'id'), [lit(id, 'int')]));
        return cte(project(chosen, [['id', col(chosen.id, 'id')], ['bulk', lit(1, 'int')]]), cteName);
      };
      const [left, right] = [arm('c0', 2), arm('c1', 4)];
      return make.union({ id: fresh('u'), inputs: [left, right], all: true, channels, type: cols('id', 'bulk') });
    },
  },

  // 11 — the one construct measured emitting `VALUES`.
  {
    gremlin: 'g.inject(1,2)',
    plan: () => make.values({ id: fresh('v'), rows: [[lit(1, 'int')], [lit(2, 'int')]], channels, type: cols('v') }),
  },
];

const sorted = (rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).sort();

describe('RelIR ↔ L2 equivalence (Phase 1 exit gate)', () => {
  const store = seededStore();

  for (const family of FAMILIES) {
    test(`${family.gremlin} — same rows, same access path`, () => {
      const legacy = read(family.gremlin);
      const core = relationalCore(legacy.sql);
      if (!core) throw new Error(`no relational core in the compiled plan for ${family.gremlin}`);

      seq = 0;
      const plan = family.plan();
      const mine = emitQuery(name(plan));

      expect(sorted(store.query(mine.sql, mine.binds))).toEqual(sorted(store.query(core, legacy.binds)));
      expect(accessPaths(store, mine.sql, mine.binds)).toEqual(accessPaths(store, core, legacy.binds));
    });
  }
});
