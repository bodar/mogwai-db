import { col, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ColMeta } from '../../rel/types.ts';
import type { Elem } from '../plan/plan.ts';
import {
  and, byEncounter, coalesce, EDGE_COLS, EMPTY_ARRAY, EMPTY_OBJECT, eq, jsonOf, meta, NODE_COLS, typeOf, typedNode,
  type Minter,
} from './build.ts';

/**
 * THE ELEMENT PAYLOAD — an id-relation projected to the tuple a vertex or an edge is ON THE WIRE.
 *
 * The keystone of §10·10, and the decision that section records: `materialize.ts` BUILDS SQL, so by
 * decision #3 it is a query producer and therefore the algebra's. What is genuinely not the algebra's
 * is the layer after it — `execute.ts`'s framers, which take ROWS plus a `Shape` and yield GraphBinary
 * with no SQL anywhere. **`Shape` is the boundary**, and this module is what moves the last SQL-producing
 * step to the correct side of it.
 *
 * Before this, every covered element traversal — most of the corpus RelIR answers — ended with legacy's
 * `lowerSteps` composing the payload SELECT over RelIR's relation, which meant RelIR did not produce the
 * whole query and §5a's equivalence gate did not read as it claimed. It also meant the next arm of the
 * map family was blocked by a `throw` inside the code §8 deletes, i.e. by the migration running backwards.
 *
 * ## What the tuple is, and why it is FIXED
 *
 * `id`, `label`, (`src`, `tgt` for an edge), `props` — plus `bulk` where a collapse carried a
 * multiplicity out. Legacy's `elementPayload`/`elementPayloadObject` (`plan/plan.ts`) are the same tuple
 * built from a `ScalarCtx`, and the comment above them is the history: it was spelled out by hand at
 * fourteen sites and two of them had already drifted to internal rowids for an edge's endpoints. So the
 * one thing this module must not do is become a fifteenth spelling with its own opinions. Every field
 * below is the same ANSWER as its legacy twin — the id is `COALESCE(uid, id)`, a vertex's label is ALL of
 * its labels ordered by label id, an edge's endpoints are EXTERNAL ids, a property bag is insertion-ordered
 * and its values are self-describing `{t,v}` nodes — and where the SQL differs it differs only in
 * spelling, which is what §5a's gate admits.
 *
 * ## The one place it is deliberately MORE correct than its twin
 *
 * A property bag's entry order is insertion order, and legacy states it as an ORDER BY on a SUBQUERY that
 * an enclosing aggregate then consumes:
 *
 * ```sql
 * SELECT json_group_object(key, json(vs)) FROM (SELECT … GROUP BY key ORDER BY MIN(id))
 * ```
 *
 * That is precisely the shape `jsonbGroupArray`'s own warning describes — "a relation's ORDER BY does not
 * survive the boundary into an enclosing aggregate" — so the bag's order rides on the planner not
 * flattening the subquery. Here the order is stated where it is actually binding, as the aggregate's own
 * `ORDER BY` (`Agg.orderBy`, SQLite ≥ 3.44; the DO's is 3.47 and `json_group_array … ORDER BY` already
 * ships in the read path, so this is the same capability applied to the object form). Same answer,
 * stated where nothing can drop it.
 *
 * The bind-free empties (`json_object()` / `json_array()` rather than the `'{}'` / `'[]'` literals legacy
 * inlines) and the emission-order `Sort` are `build.ts`'s, because every payload arm needs both.
 */

/** `labels`, as the algebra sees it. Declared per use rather than shared, because two scans of one
 *  table in one plan are two RELATIONS and a shared `RelId` is the one thing `Col` cannot disambiguate. */
const labelTable = (fresh: Minter): Rel =>
  make.scan({ id: fresh('wlb'), table: 'labels', alias: fresh('rwl'), channels: [], type: typeOf(meta('id', 'int'), meta('name', 'text')) });

/**
 * ALL of a vertex's labels as a JSON array of names — the PAYLOAD position (`labelPayloadFor`), which is
 * unconditional and has no `LabelRegime`: GraphBinary's `{label}` field IS a list and the client derives
 * `.label` from `labels[0]`, so a vertex element carries the whole set whatever `with("singlelabel")` says
 * about how `elementMap()` renders a `T.label` entry.
 *
 * Ordered by LABEL ID, which is the same deterministic pick `vertexLabelName` makes, so the scalar
 * `label()` and the payload's first entry name the same label. `json_group_array` over no rows is NULL —
 * a vertex may carry zero labels under `ZERO_OR_MORE` — so the `COALESCE` is the totality, not a defence.
 */
function vertexLabels(node: Expr, fresh: Minter): Expr {
  const vl = make.scan({ id: fresh('wvl'), table: 'vertex_labels', alias: fresh('rwv'), channels: [], type: typeOf(meta('node', 'int'), meta('label', 'int')) });
  const names = labelTable(fresh);
  const joined = make.join({
    id: fresh('wlj'), left: vl, right: names, join: 'inner', channels: [],
    type: typeOf(meta('node', 'int'), meta('lid', 'int'), meta('id', 'int'), meta('name', 'text')),
    on: and(eq(col(names.id, 'id'), col(vl.id, 'label')), eq(col(vl.id, 'node'), node)),
  });
  const collected = make.aggregate({
    id: fresh('wlc'), input: joined, channels: [], type: typeOf(meta('labels', 'json', true)),
    groupBy: [],
    aggs: [['labels', {
      kind: 'agg', fn: 'json_group_array', args: [col(joined.id, 'name')],
      orderBy: [{ expr: col(joined.id, 'lid'), dir: 'asc' }],
    }]],
  });
  return coalesce({ kind: 'scalar', plan: collected }, EMPTY_ARRAY);
}

/** An EDGE's label — the bare name, because TinkerPop fixes edge label cardinality at exactly one and the
 *  id is inline on `edges` rather than in a side table. `labelNameSub`'s twin. */
function edgeLabel(labelId: Expr, fresh: Minter): Expr {
  const names = labelTable(fresh);
  const matching = make.filter({ id: fresh('wlf'), input: names, channels: [], type: names.type, pred: eq(col(names.id, 'id'), labelId) });
  const only = make.project({
    id: fresh('wln'), input: matching, channels: [], type: typeOf(meta('name', 'text', true)),
    exprs: [['name', col(matching.id, 'name')]],
  });
  return { kind: 'scalar', plan: only };
}

/**
 * An edge endpoint's OUTWARD-FACING id — `extIdOf`'s twin, and the field two of legacy's fourteen
 * hand-rolled payloads got wrong before the tuple had one authority. An endpoint column holds a rowid;
 * what a client sees is `COALESCE(uid, id)`, which is also what the write path returns for the same edge,
 * so projecting the rowid here would make the read and the write disagree about one element.
 */
function nodeExternalId(rowid: Expr, fresh: Minter): Expr {
  const nodes = make.scan({ id: fresh('wnd'), table: 'nodes', alias: fresh('rwn'), channels: [], type: typeOf(...NODE_COLS) });
  const matching = make.filter({ id: fresh('wnf'), input: nodes, channels: [], type: nodes.type, pred: eq(col(nodes.id, 'id'), rowid) });
  const only = make.project({
    id: fresh('wnx'), input: matching, channels: [], type: typeOf(meta('v', 'any', true)),
    exprs: [['v', coalesce(col(matching.id, 'uid'), col(matching.id, 'id'))]],
  });
  return { kind: 'scalar', plan: only };
}

/**
 * A VERTEX's property bag — `{key: [value, …]}`, insertion-ordered in both directions.
 *
 * TWO aggregates because a vertex key is MULTI-VALUED: the inner one collects each key's values into an
 * array (ordered by the property rowid, which is insertion order), the outer one collects the keys into
 * the object (ordered by each key's earliest property, so the bag's key order is the order the keys were
 * first written). `vertexPropsAgg` is the same two levels; the difference is only where the outer order
 * is stated (see the module note).
 */
function vertexProps(node: Expr, fresh: Minter): Expr {
  const vp = make.scan({
    id: fresh('wvp'), table: 'vertex_properties', alias: fresh('rwp'), channels: [],
    type: typeOf(meta('id', 'int'), meta('node', 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
  });
  const mine = make.filter({ id: fresh('wpf'), input: vp, channels: [], type: vp.type, pred: eq(col(vp.id, 'node'), node) });
  const perKey = make.aggregate({
    id: fresh('wpk'), input: mine, channels: [],
    type: typeOf(meta('key', 'text'), meta('vs', 'json'), meta('ord', 'int')),
    groupBy: [col(mine.id, 'key')],
    aggs: [
      ['vs', {
        kind: 'agg', fn: 'json_group_array', args: [typedNode(col(mine.id, 'value'), col(mine.id, 'vtype'))],
        orderBy: [{ expr: col(mine.id, 'id'), dir: 'asc' }],
      }],
      ['ord', { kind: 'agg', fn: 'min', args: [col(mine.id, 'id')] }],
    ],
  });
  // `json()` AROUND THE INNER ARRAY IS LOAD-BEARING: a JSON value crossing the derived-table boundary
  // loses SQLite's json subtype, so `json_group_object` would quote the whole array as a STRING. Legacy
  // carries the identical wrapper for the identical reason, and the first attempt at the edge bag
  // reshaped every edge's properties by omitting it.
  const bag = make.aggregate({
    id: fresh('wpb'), input: perKey, channels: [], type: typeOf(meta('props', 'json', true)),
    groupBy: [],
    aggs: [['props', {
      kind: 'agg', fn: 'json_group_object', args: [col(perKey.id, 'key'), jsonOf(col(perKey.id, 'vs'))],
      orderBy: [{ expr: col(perKey.id, 'ord'), dir: 'asc' }],
    }]],
  });
  return coalesce({ kind: 'scalar', plan: bag }, EMPTY_OBJECT);
}

/**
 * An EDGE's property bag — `{key: value}`, insertion-ordered. ONE aggregate, because
 * `UNIQUE(edge, key)` makes an edge property single-valued by schema: TinkerPop's edge `Property` is
 * single by spec, which is the same rule that gave `edge_properties` no `meta` column.
 */
function edgeProps(edge: Expr, fresh: Minter): Expr {
  const ep = make.scan({
    id: fresh('wep'), table: 'edge_properties', alias: fresh('rwe'), channels: [],
    type: typeOf(meta('id', 'int'), meta('edge', 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
  });
  const mine = make.filter({ id: fresh('wef'), input: ep, channels: [], type: ep.type, pred: eq(col(ep.id, 'edge'), edge) });
  const bag = make.aggregate({
    id: fresh('web'), input: mine, channels: [], type: typeOf(meta('props', 'json', true)),
    groupBy: [],
    aggs: [['props', {
      kind: 'agg', fn: 'json_group_object',
      args: [col(mine.id, 'key'), jsonOf(typedNode(col(mine.id, 'value'), col(mine.id, 'vtype')))],
      orderBy: [{ expr: col(mine.id, 'id'), dir: 'asc' }],
    }]],
  });
  return coalesce({ kind: 'scalar', plan: bag }, EMPTY_OBJECT);
}

/** The renamed element-row columns a JOIN may declare beside the traverser's own. A `Join` emits its
 *  sides POSITIONALLY and refuses a duplicate output name (`Col{rel, name}` cannot say which side it
 *  meant), and both sides carry `id` — so the element row's columns arrive under a prefix nothing else
 *  in this route mints. */
const ROW = (name: string): string => `w_${name}`;

/**
 * The id-relation, projected to its wire tuple. The result carries NO channels: at this boundary the
 * per-traverser state has been spent — the emission order became the `ORDER BY`, and a collapse's
 * multiplicity became the `bulk` COLUMN the framer reads as a per-value count.
 *
 * The wire's row order is `byEncounter`'s (`build.ts`), shared with every other payload arm.
 *
 * ## `bulk` is a COLUMN here, not a channel
 *
 * Under `movementCollapse` a bare element leaf carries the collapsed multiplicity out to the wire, and
 * framing picks up a `bulk` column wherever it finds one — bulk is orthogonal to `Shape`, not a variant of
 * it. `opts.bulk` is the caller's collapse switch, asked once, so an uncollapsed compile's projection is
 * unchanged.
 */
export function elementPayload(input: Rel, elem: Elem, opts: { readonly bulk: boolean }, fresh: Minter): Rel {
  const rowCols = elem === 'edge' ? EDGE_COLS : NODE_COLS;
  const row = make.scan({
    id: fresh('wel'), table: elem === 'edge' ? 'edges' : 'nodes', alias: fresh('rwx'), channels: [],
    type: typeOf(...rowCols),
  });
  const joined = make.join({
    id: fresh('wjn'), left: input, right: row, join: 'inner', channels: input.channels,
    type: typeOf(...input.type.cols, ...rowCols.map((column) => meta(ROW(column.name), column.type, column.nullable))),
    on: eq(col(row.id, 'id'), col(input.id, 'id')),
  });

  const ordered = byEncounter(joined, fresh);
  const rowid = col(ordered.id, ROW('id'));
  const bulk = opts.bulk ? ordered.channels.find((channel) => channel.role === 'bulk') : undefined;
  // The tuple, in legacy's own order — id, label, (src, tgt), props, then bulk. The framer reads rows by
  // NAME, so the order is parity rather than contract; keeping it is what makes a wire diff readable.
  const payload: readonly (readonly [ColMeta, Expr])[] = [
    [meta('id', 'any'), coalesce(col(ordered.id, ROW('uid')), rowid)],
    elem === 'edge'
      ? [meta('label', 'text', true), edgeLabel(col(ordered.id, ROW('label')), fresh)]
      : [meta('label', 'json'), vertexLabels(rowid, fresh)],
    ...(elem === 'edge'
      ? [
          [meta('src', 'any', true), nodeExternalId(col(ordered.id, ROW('src')), fresh)] as const,
          [meta('tgt', 'any', true), nodeExternalId(col(ordered.id, ROW('tgt')), fresh)] as const,
        ]
      : []),
    [meta('props', 'json'), elem === 'edge' ? edgeProps(rowid, fresh) : vertexProps(rowid, fresh)],
    ...(bulk ? [[meta('bulk', 'int'), col(ordered.id, bulk.col)] as const] : []),
  ];
  return make.project({
    id: fresh('wpl'), input: ordered, channels: [], type: typeOf(...payload.map(([column]) => column)),
    exprs: payload.map(([column, expression]) => [column.name, expression] as const),
  });
}
