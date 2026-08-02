import type { Channels } from '../../channels.ts';
import { col, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { name as nameBindings } from '../../rel/passes/name.ts';
import type { Plan } from '../../rel/plan.ts';
import type { Rel } from '../../rel/rel.ts';
import { relId, type ColMeta, type RelType, type SqlType } from '../../rel/types.ts';
import { PER_ROW, STATIC, type ScalarType } from '../../sql/kernel/render.ts';
import type { Elem } from '../plan/plan.ts';
import { flattenListArgs } from '../../gremlin/frontend.ts';
import type { IRStep } from '../ir/strategies.ts';
import { containsTextSearch, predicateExpr, storedCompare } from './predicate.ts';

/**
 * THE SECOND LOWERING — `Step[] -> RelIR` (§10·4 of `docs/2026-08-01-relir-build-plan.md`).
 *
 * The legacy spine (`LoweringEngine`) builds SQL into an append-only `Query`, so the query never
 * exists as data and every optimization has to happen before or during lowering. This module is the
 * replacement route, and it grows STEP BY STEP: a traversal whose every step is covered here lowers
 * to a `Plan` and takes the RelIR route end-to-end; anything else returns `null` and the legacy
 * spine handles it whole. **Never mixed inside one traversal** — that is what keeps RelIR a real
 * algebra rather than a wrapper, and it is why there is no opaque escape node and never will be
 * (§10·4: "not as a bridge, not temporarily, not behind a flag").
 *
 * `null` is therefore the ONLY decline, and it must stay cheap and total: a step this module has
 * not learned yet is not an error, it is coverage that has not been written. What it must never do
 * is answer a DIFFERENT question — a partial lowering that silently drops a filter would be
 * invisible to the differential, since both spines would be asked and only one asked correctly.
 *
 * ## What this module does NOT do
 *
 * **Framing.** Gremlin shape is resolved above RelIR and rides to the wire as `Compiled.shape`
 * (§2), so this returns a RELATION plus the channel/layout facts the framing layer needs, and
 * `spine.ts` hands that to the existing per-shape framing. Re-encoding the element payload
 * projection in RelIR would be §7's named risk ("re-encoding, not simplification") for no gain: the
 * shape-interpreting class stays per-shape forever and correctly so.
 */

/**
 * WHAT THE FRAMING LAYER MUST BUILD over the result relation — the shape half of a lowering.
 *
 * Gremlin shape is resolved ABOVE RelIR and rides to the wire as `Compiled.shape` (§2), so a
 * lowering hands back a relation plus the minimum the framing layer needs to pick its per-shape
 * projection. This union is that minimum, and it is deliberately a union rather than a widened
 * record: an element stream has no scalar type and a scalar stream has no element kind, and
 * pretending otherwise is how a shape vocabulary starts leaking into the algebra.
 *
 * It grows one arm per stream kind the spine learns, and `spine.ts` switches on it TOTALLY — the
 * shape-interpreting class stays per-shape forever and correctly so (§6, Phase 4).
 */
export type RelFraming =
  | { readonly kind: 'elements'; readonly elem: Elem }
  | { readonly kind: 'scalar'; readonly type: ScalarType; readonly result?: 'value' | 'count' | 'number' };

/** A covered chain, lowered: a relation, its output columns, its channels, and what to frame. */
export interface RelLowering {
  readonly plan: Plan;
  readonly framing: RelFraming;
  /** The result relation's output columns, in order — the framing layer's `Relation` header. */
  readonly cols: readonly string[];
  readonly channels: Channels;
}

const meta = (colName: string, type: SqlType, nullable = false): ColMeta => ({ name: colName, type, nullable });
const typeOf = (...cols: readonly ColMeta[]): RelType => ({ cols });

/** Physical columns of the two element tables, as `Scan` must declare them. `Scan` is the one node
 *  that names the physical schema (§3.3), so this list IS the algebra's view of storage. */
const NODE_COLS = [meta('id', 'int'), meta('uid', 'text', true)];
const EDGE_COLS = [meta('id', 'int'), meta('uid', 'text', true), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')];

/** The bulk channel every element source seeds: the RLE traverser count a reducer reads as
 *  `SUM(bulk)` and a movement collapse merges convergent walks on. One channel, one column, and the
 *  role vocabulary is the neutral core's — a RelIR node cannot know what a sack is. */
const BULK: Channels = [{ col: 'bulk', role: 'bulk' }];
const SOURCE_COLS = ['id', 'bulk'] as const;

/** Relation ids, minted PER LOWERING. A module-global counter would make the emitted SQL depend on
 *  how many traversals this process had already compiled — two compiles of one query producing two
 *  different strings, which breaks every snapshot and every cache keyed on the text. */
type Minter = (hint: string) => import('../../rel/types.ts').RelId;
const minter = (): Minter => { let n = 0; return (hint) => relId(`${hint}${n++}`); };

/** The two element tables' property side-tables, and the column each keys its owner by. The
 *  asymmetry (`node` vs `edge`) is the physical schema's, so it lives beside the `Scan` tables. */
const PROPERTIES = {
  vertex: { table: 'vertex_properties', owner: 'node' },
  edge: { table: 'edge_properties', owner: 'edge' },
} as const;

function and(left: Expr | undefined, right: Expr): Expr;
function and(left: Expr, right: Expr | undefined): Expr;
function and(left: Expr | undefined, right: Expr | undefined): Expr {
  if (!left || !right) {
    const only = left ?? right;
    if (!only) throw new Error('RelIR lowering: a conjunction of nothing');
    return only;
  }
  return { kind: 'binary', op: 'and', left, right };
}

const eq = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: '=', left, right });


/** `SELECT id FROM labels WHERE name IN (…)` — the name→id indirection every label-aware step
 *  reaches through, and the reason `labels` is a `Scan` table rather than a string in an emitter. */
function labelIds(names: readonly string[], fresh: Minter): Rel {
  const scan = make.scan({ id: fresh('lbl'), table: 'labels', alias: fresh('rl'), channels: [], type: typeOf(meta('id', 'int'), meta('name', 'text')) });
  const matching = make.filter({
    id: fresh('f'), input: scan, channels: [], type: scan.type,
    pred: { kind: 'in-list', expr: col(scan.id, 'name'), values: names.map((n) => lit(n, 'text')) },
  });
  return make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('id', 'int')), exprs: [['id', col(matching.id, 'id')]] });
}

/**
 * A source-scope FILTER as a predicate over the element scan — the whole of `hasLabel`/`has` that
 * needs no predicate vocabulary.
 *
 * Written against the SCAN rather than against a projected id-relation, which is the structural
 * difference from the legacy spine and the point of the exercise: legacy gives every filter its own
 * CTE that re-joins the element table to reach a column its predecessor projected away
 * (`… FROM nodes n JOIN c1 p ON n.id=p.id WHERE EXISTS(…)`), so `has(a).has(b)` is three CTEs and
 * two redundant self-joins. Here they conjoin into ONE `WHERE` over one scan, because a filter
 * neither changes the relation's cardinality contract nor consumes a channel, and the plan is data
 * so a later step can still see the columns.
 */
function sourceFilter(step: IRStep, scan: Rel, elem: Elem, fresh: Minter): Expr | null {
  if (step.modulators?.length || step.optionArms) return null;
  const args = step.args ?? [];

  if (step.name === 'hasLabel') {
    const names = flattenListArgs(args);
    if (!names.length || names.some((n) => typeof n !== 'string')) return null;
    const ids = labelIds(names as string[], fresh);
    // An EDGE carries its label inline; a VERTEX may hold several, in a side table. Two different
    // physical questions, which is exactly why `Scan` is the only node that names a table.
    return elem === 'edge'
      ? { kind: 'in-query', expr: col(scan.id, 'label'), plan: ids, negated: false }
      : (() => {
          const vl = make.scan({ id: fresh('vl'), table: 'vertex_labels', alias: fresh('rvl'), channels: [], type: typeOf(meta('node', 'int'), meta('label', 'int')) });
          const matching = make.filter({ id: fresh('f'), input: vl, channels: [], type: vl.type, pred: { kind: 'in-query', expr: col(vl.id, 'label'), plan: ids, negated: false } });
          const owners = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('node', 'int')), exprs: [['node', col(matching.id, 'node')]] });
          return { kind: 'in-query', expr: col(scan.id, 'id'), plan: owners, negated: false };
        })();
  }

  if (step.name === 'has') {
    // `has(key)` and `has(key, <value-or-predicate>)`. `has(label, key, value)` and the `T`-token
    // forms decline rather than being half-answered — a token key is a different question (it
    // reads the element's id or label, not a property row).
    const [key, val, extra] = args;
    if (typeof key !== 'string' || extra !== undefined) return null;
    // A substring `TextP` over a STORED property is `ftsSubstringPredicate`'s, and taking it here
    // would swap a trigram-index seek for a base-table LIKE scan — a regression the census cannot
    // see, reported by the coverage number as progress. §4.7 lifts this.
    if (containsTextSearch(val)) return null;

    const { table, owner } = PROPERTIES[elem];
    const props = make.scan({
      id: fresh('vp'), table, alias: fresh('rp'), channels: [],
      type: typeOf(meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
    });
    // The property row's own `vtype` is in scope here, so an ordering comparison gets the
    // vtype-aware key — the whole reason `predicateExpr` takes `compare` as a parameter.
    const matches = val === undefined ? undefined
      : predicateExpr(col(props.id, 'value'), val, storedCompare(props.id));
    if (val !== undefined && !matches) return null;

    const matching = make.filter({
      id: fresh('f'), input: props, channels: [], type: props.type,
      pred: matches
        ? and(and(eq(col(props.id, owner), col(scan.id, 'id')), eq(col(props.id, 'key'), lit(key, 'text'))), matches)
        : and(eq(col(props.id, owner), col(scan.id, 'id')), eq(col(props.id, 'key'), lit(key, 'text'))),
    });
    // `EXISTS (SELECT 1 …)`, correlated on the outer scan — a property FILTER asks whether a row
    // exists, and joining instead would multiply the traverser once per matching property.
    const probe = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', lit(1, 'int')]] });
    return { kind: 'exists', plan: probe, negated: false };
  }

  return null;
}

/**
 * `V(...)` / `E(...)` — the element source, and the same relation the legacy `seedSource` builds for
 * the same arguments: one row per element at bulk 1, narrowed by an id list bounded by the QUERY
 * TEXT (never by row count, so `InList` is right here and a JSON bind is not).
 *
 * Numeric args match the rowid and string args the user id, because the id-relation carries rowids
 * throughout and a `uid` match still projects the rowid. That asymmetry is the storage schema's,
 * which is why it lives at the one node that names a table.
 */
function elementScan(step: IRStep, fresh: Minter): { scan: Rel; pred?: Expr; elem: Elem } | null {
  const elem: Elem = step.name === 'E' ? 'edge' : 'vertex';
  // A `r`-prefixed alias, so a RelIR scan can never SHADOW one of the framing layer's (`n`/`e`/`p`/
  // `s`/`v`/`g`/`j`/`l`). The plan is spliced in as a derived table, so shadowing would be legal
  // SQL and silently resolve an outer correlation to the inner table.
  const scan = make.scan({
    id: fresh('src'), table: elem === 'edge' ? 'edges' : 'nodes', alias: elem === 'edge' ? 're' : 'rn', channels: [],
    type: typeOf(...(elem === 'edge' ? EDGE_COLS : NODE_COLS)),
  });

  const ids = flattenListArgs(step.args);
  const nums = ids.filter((a): a is number => typeof a === 'number');
  const strs = ids.filter((a): a is string => typeof a === 'string');
  // An id argument that is neither is a hard error in the legacy spine too, but this route must
  // not THROW on a shape it merely has not learned — declining routes it to the spine that owns
  // the message.
  if (ids.length !== nums.length + strs.length) return null;

  const clauses: Expr[] = [];
  if (nums.length) clauses.push({ kind: 'in-list', expr: col(scan.id, 'id'), values: nums.map((n) => lit(n, 'int')) });
  if (strs.length) clauses.push({ kind: 'in-list', expr: col(scan.id, 'uid'), values: strs.map((s) => lit(s, 'text')) });
  const pred = clauses.reduce<Expr | undefined>((left, right) =>
    left ? { kind: 'binary', op: 'or', left, right } : right, undefined);
  return { scan, pred, elem };
}

/** The storage-class recovery every stored value goes through on the way out: a JSON-typed value
 *  comes back as JSON, everything else as itself. Shared by `values()` and, later, every other
 *  reader of a property value. */
const storedValue = (rel: import('../../rel/types.ts').RelId): Expr => ({
  kind: 'case',
  whens: [[{ kind: 'in-list', expr: col(rel, 'vtype'), values: ['list', 'map', 'set'].map((t) => lit(t, 'text')) },
    { kind: 'call', fn: 'json', args: [col(rel, 'value')] }]],
  else: col(rel, 'value'),
});

/**
 * A TERMINAL that retypes the element relation into another shape — the SHAPE BOUNDARY, and the
 * substrate every scalar-valued step then rides on.
 *
 * `null` declines, as everywhere here. What makes this the boundary rather than one more step is
 * that both arms change the STREAM KIND: everything before produces elements and frames as the
 * element payload, and these produce one scalar per row and frame through the value projection.
 */
function terminal(step: IRStep, input: Rel, elem: Elem, fresh: Minter): Omit<RelLowering, 'plan'> & { readonly rel: Rel } | null {
  if (step.modulators?.length || step.optionArms) return null;
  const args = step.args ?? [];

  // count() is the RLE traverser TOTAL, not the row count: a collapse merges convergent walks into
  // (row, N) pairs, so the answer is SUM(bulk) — identical to COUNT(*) only while bulk is 1
  // everywhere. Reading it off the carried channel rather than off the step is what keeps the two
  // in step when movement lands.
  if (step.name === 'count') {
    if (args.length) return null;
    const total: Expr = { kind: 'call', fn: 'COALESCE', args: [{ kind: 'agg', fn: 'sum', args: [col(input.id, 'bulk')] }, lit(0, 'int')] };
    // A reducing aggregate is a BARRIER: no channel survives it (§3.5), which is exactly what
    // `barrierChannels` says and why the channels list is empty rather than trimmed by hand.
    return {
      rel: make.aggregate({ id: fresh('agg'), input, channels: [], type: typeOf(meta('v', 'int')), groupBy: [], aggs: [['v', total]] }),
      framing: { kind: 'scalar', type: STATIC('long'), result: 'count' }, cols: ['v'], channels: [],
    };
  }

  if (step.name === 'values') {
    // TinkerPop's `PropertiesStep` is `element.properties(keys)`: no keys means EVERY key, several
    // mean membership in the set. A non-string key is a decline rather than a guess — answering
    // "every key" for one would be answering a different question.
    const keys = args.filter((a): a is string => typeof a === 'string');
    if (keys.length !== args.length) return null;

    const { table, owner } = PROPERTIES[elem];
    const props = make.scan({
      id: fresh('vp'), table, alias: fresh('rp'), channels: [],
      type: typeOf(meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
    });
    // A JOIN, not an EXISTS: `values()` emits one traverser PER matching property, so multiplying
    // the row is the answer rather than the bug it would be in a filter.
    const joined = make.join({
      id: fresh('j'), left: input, right: props, join: 'inner', channels: BULK,
      type: typeOf(meta('id', 'int'), meta('bulk', 'int'), meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
      // The key set is bounded by the QUERY TEXT, never by row count, so an `InList` is right here
      // and a JSON bind is not (root CLAUDE.md's rule is about data-sized sets).
      on: and(eq(col(props.id, owner), col(input.id, 'id')), keys.length
        ? { kind: 'in-list', expr: col(props.id, 'key'), values: keys.map((k) => lit(k, 'text')) }
        : undefined),
    });
    return {
      rel: make.project({
        id: fresh('sv'), input: joined, channels: BULK,
        type: typeOf(meta('v', 'any', true), meta('vtype', 'text', true), meta('bulk', 'int')),
        exprs: [['v', storedValue(joined.id)], ['vtype', col(joined.id, 'vtype')], ['bulk', col(joined.id, 'bulk')]],
      }),
      // The value's Gremlin type is PER ROW, off the stored `vtype` column — one compile-time tag
      // would be a lie for an untyped property key.
      framing: { kind: 'scalar', type: PER_ROW('vtype') }, cols: ['v', 'vtype', 'bulk'], channels: BULK,
    };
  }

  return null;
}

/**
 * Lower a whole rooted chain, or decline.
 *
 * Coverage today is the element SOURCE plus a run of source-scope filters. The declines are the
 * growth list, and the measured order of what each is worth over the 2,298-traversal corpus is
 * recorded in the build plan — `has(key, P…)` is the next single largest, then the reducers.
 */
export function lowerToRel(steps: readonly IRStep[]): RelLowering | null {
  const first = steps[0];
  if (!first) return null;
  if (first.name !== 'V' && first.name !== 'E') return null;
  // A modulator or an option arm on the source is not a source argument; decline rather than
  // silently ignore it.
  if (first.modulators?.length || first.optionArms) return null;

  const fresh = minter();
  const seeded = elementScan(first, fresh);
  if (!seeded) return null;

  let pred = seeded.pred;
  let at = 1;
  for (; at < steps.length; at++) {
    const clause = sourceFilter(steps[at], seeded.scan, seeded.elem, fresh);
    if (!clause) break;
    pred = and(pred, clause);
  }

  const source = pred ? make.filter({ id: fresh('f'), input: seeded.scan, channels: [], type: seeded.scan.type, pred }) : seeded.scan;
  const projected = make.project({
    id: fresh('c'), input: source, channels: BULK, type: typeOf(meta('id', 'int'), meta('bulk', 'int')),
    exprs: [['id', col(source.id, 'id')], ['bulk', lit(1, 'int')]],
  });
  if (at === steps.length)
    return { plan: nameBindings(projected), framing: { kind: 'elements', elem: seeded.elem }, cols: [...SOURCE_COLS], channels: BULK };

  const retyped = terminal(steps[at], projected, seeded.elem, fresh);
  if (!retyped) return null;
  const { rel, ...rest } = retyped;

  // Past the shape change the vocabulary is the NEW shape's, and `is(P)` is the whole of it here.
  // It is the same predicate module the source filters use, over the scalar's own `v` — which is
  // the point of having built that module rather than a `has`-shaped helper.
  const vtyped = rest.cols.includes('vtype');
  // A BOUNDARY before the filters, and it is not cosmetic. Fusing a `Filter` into its input's
  // block means the input's outputs are spelled as the EXPRESSIONS that compute them (§5) — SQL
  // has no other option, since a `WHERE` cannot name a select alias. So each `is` re-inlines the
  // whole projection, and with the vtype-aware ordering CASE in play that is ~20 binds apiece:
  // measured 25 / 45 / 65 for one, two and three range predicates, against legacy's 2 / 3 / 4.
  // Four would exceed the DO cap and fail closed where legacy answers — a support regression, not
  // a wall worth shipping. `Materialize` is exactly the declared remedy (§3.3: "a boundary hint …
  // where the planner needs a fence"), and it lands the same CTE-then-filter shape legacy emits.
  let filtered: Rel = steps[at + 1]?.name === 'is'
    ? make.materialize({ id: fresh('m'), input: rel, channels: rest.channels, type: rel.type })
    : rel;
  for (at++; at < steps.length; at++) {
    const step = steps[at];
    if (step.name !== 'is' || step.modulators?.length || step.optionArms) return null;
    const args = step.args ?? [];
    if (args.length !== 1) return null;
    // A per-row `vtype` is in scope only where the value came from a stored property; a `count` is
    // a compile-time long and needs no ordering key. Same distinction `predicateSql` draws as
    // `typeCtx.kind === 'perRow'`.
    const pred = predicateExpr(col(filtered.id, 'v'), args[0], vtyped ? storedCompare(filtered.id) : undefined);
    if (!pred) return null;
    filtered = make.filter({ id: fresh('f'), input: filtered, channels: rest.channels, type: filtered.type, pred });
  }
  return { plan: nameBindings(filtered), ...rest };
}
