import { col, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ColMeta, RelId, SqlType } from '../../rel/types.ts';
import type { Elem } from '../elem.ts';
import {
    and, byEncounter, coalesce, EDGE_COLS, EMPTY_ARRAY, EMPTY_OBJECT, eq, jsonOf, meta, NODE_COLS, typeOf, typedNode, typedNodeDetached,
    type Minter,
} from './build.ts';

/**
 * THE ELEMENT PAYLOAD — an id-relation projected to the tuple a vertex or an edge is ON THE WIRE.
 *
 * The keystone of §6·3, and the decision that section records: `materialize.ts` BUILDS SQL, so by
 * decision #3 it is a query producer and therefore the algebra's. What is genuinely not the algebra's
 * is the layer after it — `execute.ts`'s framers, which take ROWS plus a `Shape` and yield GraphBinary
 * with no SQL anywhere. **`Shape` is the boundary**, and this module is what moves the last SQL-producing
 * step to the correct side of it.
 *
 * This module composes the element payload SELECT over RelIR's relation IN THE ALGEBRA, so RelIR
 * produces the whole query and §5's equivalence gate reads as it claims.
 *
 * ## What the tuple is, and why it is FIXED
 *
 * `id`, `label`, (`src`, `tgt` for an edge), `props` — plus `bulk` where a collapse carried a
 * multiplicity out. This tuple was previously spelled out by hand at fourteen sites, and two of them
 * had already drifted to internal rowids for an edge's endpoints. So the
 * one thing this module must not do is become a fifteenth spelling with its own opinions. Every field
 * below is the correct ANSWER — the id is `COALESCE(uid, id)`, a vertex's label is ALL of
 * its labels ordered by label id, an edge's endpoints are EXTERNAL ids, a property bag is insertion-ordered
 * and its values are self-describing `{t,v}` nodes.
 *
 * ## The one place it is deliberately MORE robust than the naive spelling
 *
 * A property bag's entry order is insertion order, and the naive spelling states it as an ORDER BY on a
 * SUBQUERY that an enclosing aggregate then consumes:
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
 * The bind-free empties (`json_object()` / `json_array()`) and the emission-order `Sort` are
 * `build.ts`'s, because every payload arm needs both.
 */

/** `labels`, as the algebra sees it. Declared per use rather than shared, because two scans of one
 *  table in one plan are two RELATIONS and a shared `RelId` is the one thing `Col` cannot disambiguate. */
const labelTable = (fresh: Minter): Rel =>
  make.scan({ id: fresh('wlb'), table: 'labels', alias: fresh('rwl'), channels: [], type: typeOf(meta('id', 'int'), meta('name', 'text')) });

/**
 * ONE column of a row a rowid names, as a correlated `{kind:'scalar'}` read — `scan(table) → filter(id =
 * rowid) → project(['v', <expr>])`. The edge/vertex correlated reads below (`edgeEndpoint`,
 * `nodeExternalId`, `edgeColumn`, and `externalId`'s edge arm) were four copies of exactly this shape,
 * differing only in the table scanned and the value projected; `value(scan)` builds the projection off
 * the filtered row so the fresh minter that owns the scan owns the read. Each caller still mints its OWN
 * scan (two scans of one table are two relations — see `labelTable`). */
function correlatedColumn(
  scan: Rel, rowid: Expr, valueType: SqlType, value: (row: RelId) => Expr, fresh: Minter,
): Expr {
  const matching = make.filter({ id: fresh('ccf'), input: scan, channels: [], type: scan.type, pred: eq(col(scan.id, 'id'), rowid) });
  const only = make.project({
    id: fresh('ccx'), input: matching, channels: [], type: typeOf(meta('v', valueType, true)),
    exprs: [['v', value(matching.id)]],
  });
  return { kind: 'scalar', plan: only };
}

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
export function vertexLabels(node: Expr, fresh: Minter): Expr {
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
export function edgeLabel(labelId: Expr, fresh: Minter): Expr {
  const names = labelTable(fresh);
  const matching = make.filter({ id: fresh('wlf'), input: names, channels: [], type: names.type, pred: eq(col(names.id, 'id'), labelId) });
  const only = make.project({
    id: fresh('wln'), input: matching, channels: [], type: typeOf(meta('name', 'text', true)),
    exprs: [['name', col(matching.id, 'name')]],
  });
  return { kind: 'scalar', plan: only };
}

/**
 * AN EDGE'S ENDPOINT, as the vertex ROWID — `outV()`/`inV()` reached from a correlated edge id rather
 * than from an edge relation.
 *
 * Deliberately NOT `movement()`: an endpoint read is exactly-one-per-traverser by the schema
 * (`edges.src`/`edges.tgt` are non-null columns), so it re-roots a `ChildHost` instead of producing a
 * relation of traversers. That distinction is what lets `by(__.outV().values('name'))` be a correlated
 * value at all — the generic movement arm has to refuse a non-reducing tail, because a hop that CAN
 * fan out would otherwise let SQLite silently pick a row.
 *
 * The rowid and not the external id: a `ChildHost` addresses an element by its rowid everywhere, and
 * `COALESCE(uid, id)` is what the PAYLOAD projections apply on the way out.
 */
export function edgeEndpoint(edgeRowid: Expr, end: 'src' | 'tgt', fresh: Minter): Expr {
  const edges = make.scan({ id: fresh('ee'), table: 'edges', alias: fresh('ree'), channels: [], type: typeOf(...EDGE_COLS) });
  return correlatedColumn(edges, edgeRowid, 'int', (row) => col(row, end), fresh);
}

/**
 * An edge endpoint's OUTWARD-FACING id — `extIdOf`'s twin, and the field two of the fourteen
 * hand-rolled payloads got wrong before the tuple had one authority. An endpoint column holds a rowid;
 * what a client sees is `COALESCE(uid, id)`, which is also what the write path returns for the same edge,
 * so projecting the rowid here would make the read and the write disagree about one element.
 */
function nodeExternalId(rowid: Expr, fresh: Minter): Expr {
  const nodes = make.scan({ id: fresh('wnd'), table: 'nodes', alias: fresh('rwn'), channels: [], type: typeOf(...NODE_COLS) });
  return correlatedColumn(nodes, rowid, 'any', (row) => coalesce(col(row, 'uid'), col(row, 'id')), fresh);
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
function vertexProps(node: Expr, fresh: Minter, detached = false): Expr {
  const vp = make.scan({
    id: fresh('wvp'), table: 'vertex_properties', alias: fresh('rwp'), channels: [],
    type: typeOf(meta('id', 'int'), meta('node', 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true), meta('meta', 'blob', true)),
  });
  const mine = make.filter({ id: fresh('wpf'), input: vp, channels: [], type: vp.type, pred: eq(col(vp.id, 'node'), node) });
  // The DETACHED path emits `{t,v,vpid,meta}` so a landed subgraph reconstructs a full
  // `DetachedVertexProperty` (its id + meta-properties); an ordinary read stays `{t,v}`.
  const memberNode = detached
    ? typedNodeDetached(col(mine.id, 'value'), col(mine.id, 'vtype'), col(mine.id, 'id'), jsonOf(col(mine.id, 'meta')))
    : typedNode(col(mine.id, 'value'), col(mine.id, 'vtype'));
  const perKey = make.aggregate({
    id: fresh('wpk'), input: mine, channels: [],
    type: typeOf(meta('key', 'text'), meta('vs', 'json'), meta('ord', 'int')),
    groupBy: [col(mine.id, 'key')],
    aggs: [
      ['vs', {
        kind: 'agg', fn: 'json_group_array', args: [memberNode],
        orderBy: [{ expr: col(mine.id, 'id'), dir: 'asc' }],
      }],
      ['ord', { kind: 'agg', fn: 'min', args: [col(mine.id, 'id')] }],
    ],
  });
  // `json()` AROUND THE INNER ARRAY IS LOAD-BEARING: a JSON value crossing the derived-table boundary
  // loses SQLite's json subtype, so `json_group_object` would quote the whole array as a STRING. The
  // first attempt at the edge bag reshaped every edge's properties by omitting it.
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

/**
 * AN ELEMENT AS A MEMBER OF THE TYPED TREE — `{"t": "vertex", "v": {id, label, props[, src, tgt]}}`,
 * correlated on a rowid.
 *
 * The same tuple `elementPayload` projects to COLUMNS, projected instead to the self-describing node the
 * wire framer already walks. That is the whole of what an element inside a collection needs, and it is
 * why nothing else here grows a per-position descriptor: a group's value list, a folded element list and
 * a map key that holds an element are one rule at three depths (`FrameNode`'s own note says the same
 * thing from the framer's side).
 *
 * CORRELATED rather than joined, because the caller has a rowid inside an aggregate rather than a
 * relation to join against — a group's members arrive as one array per key, not as rows.
 *
 * `json()` around each field for the reason the column form does NOT need it: inside `json_object` a
 * value that is itself JSON must carry the subtype or it is quoted as a string, and a subtype does not
 * survive a subquery boundary.
 */
export function elementNode(rowid: Expr, elem: Elem, fresh: Minter): Expr {
  return correlatedElement(rowid, elem, fresh,
    (payload) => ({ kind: 'json-object', entries: [['t', compilerText(elem)], ['v', payload]], binary: false }));
}

/**
 * AN ELEMENT AS A BARE PAYLOAD OBJECT — `{id, label, props[, src, tgt]}`, correlated on a rowid, with
 * NO `{t,v}` envelope around it.
 *
 * `elementNode`'s twin, and the pair is deliberate rather than a duplication: the two encodings serve
 * two different framers and the framer decides which. A member of a TYPED tree (a map side, a
 * `TYPED_LIST` member) is read by `frameTypedNode`, which needs the tag; an ELEMENT-membered list is
 * read by `listItemBuffers`' `of.kind === 'elem'` arm (`execute.ts`), which maps `rowVertex`/`rowEdge`
 * straight over the items and whose own comment states the contract — *"element items arrive as
 * `{id,label,props[,src,tgt]}` objects (rowids already expanded to public payloads in SQL)"*. A tag
 * there would be an extra level the framer does not unwrap, and the wrapper's absence is not a
 * simplification: `of` already says every member is an element, so a per-member tag would be the same
 * fact spelled twice.
 *
 * They share `correlatedElement` so the PAYLOAD itself has one authority — the id/label/props tuple and
 * its `json()` subtype wrappers are what a second copy would get subtly wrong.
 */
export function elementObject(rowid: Expr, elem: Elem, fresh: Minter): Expr {
  return correlatedElement(rowid, elem, fresh, (payload) => payload);
}

/** The correlated element row, projected through `wrap`. Both public forms differ only in that
 *  function, which is why the scan/filter/payload triple is stated once. */
function correlatedElement(rowid: Expr, elem: Elem, fresh: Minter, wrap: (payload: Expr) => Expr): Expr {
  const rowCols = elem === 'edge' ? EDGE_COLS : NODE_COLS;
  const row = make.scan({
    id: fresh('wen'), table: elem === 'edge' ? 'edges' : 'nodes', alias: fresh('rwm'), channels: [],
    type: typeOf(...rowCols),
  });
  const mine = make.filter({ id: fresh('wnm'), input: row, channels: [], type: row.type, pred: eq(col(row.id, 'id'), rowid) });
  const own = (name: string): Expr => col(mine.id, name);
  const payload: Expr = {
    kind: 'json-object',
    entries: [
      ['id', coalesce(own('uid'), own('id'))],
      // A VERTEX's label payload is a JSON ARRAY and an EDGE's is a bare name, so only the first needs
      // the subtype pinned — quoting an array as a string is the failure this prevents.
      ['label', elem === 'edge' ? edgeLabel(own('label'), fresh) : jsonOf(vertexLabels(own('id'), fresh))],
      ...(elem === 'edge'
        ? [['src', nodeExternalId(own('src'), fresh)] as const, ['tgt', nodeExternalId(own('tgt'), fresh)] as const]
        : []),
      ['props', jsonOf(elem === 'edge' ? edgeProps(own('id'), fresh) : vertexProps(own('id'), fresh))],
    ],
    binary: false,
  };
  const only = make.project({
    id: fresh('wnp'), input: mine, channels: [], type: typeOf(meta('n', 'json', true)),
    exprs: [['n', wrap(payload)]],
  });
  return { kind: 'scalar', plan: only };
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
export function elementPayload(input: Rel, elem: Elem, opts: { readonly bulk: boolean; readonly detached: boolean; readonly origin?: string }, fresh: Minter): Rel {
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
  // The tuple, in the established order — id, label, (src, tgt), props, then bulk. The framer reads rows by
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
    [meta('props', 'json'), elem === 'edge' ? edgeProps(rowid, fresh) : vertexProps(rowid, fresh, opts.detached)],
    ...(bulk ? [[meta('bulk', 'int'), col(ordered.id, bulk.col)] as const] : []),
    ...(opts.origin ? [[meta('corrId', 'int'), col(ordered.id, opts.origin)] as const] : []),
  ];
  return make.project({
    id: fresh('wpl'), input: ordered, channels: [], type: typeOf(...payload.map(([column]) => column)),
    exprs: payload.map(([column, expression]) => [column.name, expression] as const),
  });
}

/**
 * AN ELEMENT'S WIRE TUPLE, correlated on a ROWID rather than read off a joined row.
 *
 * `elementPayload`'s twin for a caller that holds an id and no relation to join against — the VARIANT
 * merge, whose rows are a tagged union and whose element rows carry only `rid`. Correlated reads expand
 * that without any tag-gating, because a subquery that matches nothing is NULL and a `vk` the framer
 * does not read never asks.
 *
 * It is a third caller of the SAME expressions rather than a third spelling of the tuple: the id is
 * `COALESCE(uid, id)`, a vertex label is the labels array and an edge label is the one name, the
 * endpoints are EXTERNAL ids. Those are the facts a hand-rolled payload got wrong before the tuple had
 * one authority, and the module note above says why they may not be re-derived.
 */
export function correlatedElementColumns(
  rowid: Expr, elem: Elem, fresh: Minter,
): readonly (readonly [ColMeta, Expr])[] {
  if (elem === 'edge') {
    const row = (name: string): Expr => edgeColumn(rowid, name, fresh);
    return [
      [meta('id', 'any', true), externalId(rowid, 'edge', fresh)],
      [meta('label', 'text', true), edgeLabel(row('label'), fresh)],
      [meta('src', 'any', true), nodeExternalId(row('src'), fresh)],
      [meta('tgt', 'any', true), nodeExternalId(row('tgt'), fresh)],
      [meta('props', 'json', true), edgeProps(rowid, fresh)],
    ];
  }
  return [
    [meta('id', 'any', true), externalId(rowid, 'vertex', fresh)],
    [meta('label', 'json', true), vertexLabels(rowid, fresh)],
    [meta('props', 'json', true), vertexProps(rowid, fresh)],
  ];
}

/** One raw column of the `edges` row a rowid names — the FK label and the two endpoint rowids, which
 *  the tuple above then resolves. A vertex needs no equivalent: every vertex fact above already takes
 *  the rowid directly. */
function edgeColumn(rowid: Expr, name: string, fresh: Minter): Expr {
  const edges = make.scan({ id: fresh('wec'), table: 'edges', alias: fresh('rwc'), channels: [], type: typeOf(...EDGE_COLS) });
  return correlatedColumn(edges, rowid, 'any', (row) => col(row, name), fresh);
}

/** The PUBLIC id of either element kind — `nodeExternalId`'s generalization, so the variant tuple does
 *  not need a second copy for edges. */
export function externalId(rowid: Expr, elem: Elem, fresh: Minter): Expr {
  if (elem === 'vertex') return nodeExternalId(rowid, fresh);
  const edges = make.scan({ id: fresh('wed'), table: 'edges', alias: fresh('rwd'), channels: [], type: typeOf(...EDGE_COLS) });
  return correlatedColumn(edges, rowid, 'any', (row) => coalesce(col(row, 'uid'), col(row, 'id')), fresh);
}
