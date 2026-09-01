import { col, compilerInt, compilerText, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ColMeta } from '../../rel/types.ts';
import { type Binding } from '../../rel/plan.ts';
import type { Elem } from '../elem.ts';
import type { ForeignRow } from '../../api.ts';
import type { ValueNode } from '../../gremlin/types.ts';
import { meta, typeOf, type Minter } from './build.ts';

// ---------- DETACHED elements — a barrier call()'s awaited rows, as a relation ----------
//
// A barrier service (`federate`, `io()`) answers on a Promise, so its rows exist only
// AFTER the segment boundary the executor drives. What comes back is a detached REFERENCE — an id, a
// label set and a property snapshot — never a row of this graph's `nodes`/`edges`. This module lands
// that array as a relation the ordinary fold can continue from.
//
// **The landed relation IS the element payload, column for column** (`element.ts`'s tuple: `id`,
// `label`, (`src`, `tgt`), `props`), which is why the `detached` framing arm projects it unchanged
// rather than rebuilding it. A detached element has no rowid to join on, so re-deriving the payload
// the ordinary way — `COALESCE(uid, id)` off `nodes`, the labels sub-select, the property bag
// aggregate — would read THIS graph for an element that lives in another one. Same columns, so
// `execute.ts`'s framers are untouched: a vertex's `label` is the JSON labels ARRAY and a `props` bag
// is the per-key `{t,v}` tree, exactly what `foreignLabels`/`propsOf` already parse coming back.
//
// **The rows cross as ONE bind** (§6·2): a set whose size is a function of DATA is a single JSON value
// exploded by `json_each`, never N parameters. A federated hop returning 26 vertices was a hard DO
// failure while this was a `VALUES (?,?,…)` list, and nothing on Bun could see it (65 535 vs 100).
// The empty case needs no branch — `json_each('[]')` is a zero-row relation with these columns.
//
// What a detached element does NOT support is live adjacency: `out()`/`both()`/`properties()` have no
// table to reach. Those decline in `lower.ts`'s detached tail rather than silently joining this
// graph's, which is TinkerPop's own rule for a detached reference.

/** The exploded cell relation's columns — one landed ROW per `json_each` member, its cells read by
 *  position. `ord` is `json_each.key`, the array index, which is the order the sibling emitted. */
const CELL = { value: 'fcv', ord: 'fco' } as const;
const MAP_PAIR = { value: 'fmp' } as const;
const MAP_MEMBER = { value: 'fmm' } as const;

/** The payload tuple a landed element carries, in `elementPayload`'s own order. A vertex's `label` is
 *  the JSON labels array (the wire carries the SET and derives `.label` from `labels[0]`); an edge's
 *  is the bare name, since TinkerPop fixes edge label cardinality at one. */
export const foreignPayloadCols = (elem: Elem): readonly ColMeta[] =>
  elem === 'edge'
    ? [meta('id', 'any'), meta('label', 'text', true), meta('src', 'any', true), meta('tgt', 'any', true), meta('props', 'json')]
    : [meta('id', 'any'), meta('label', 'json'), meta('props', 'json')];

/** One landed row's cells, in `foreignPayloadCols` order. `props` (and a vertex's label set) are
 *  stringified so each lands as one scalar cell; the framing layer parses them back, which is the
 *  same round trip `runForeign()` already performs in the other direction. */
const cellsOf = (row: ForeignRow, extra: readonly unknown[]): unknown[] =>
  row.kind === 'edge'
    ? [row.id, row.label, row.src, row.tgt, JSON.stringify(row.props), ...extra]
    : [row.id, JSON.stringify(row.labels), JSON.stringify(row.props), ...extra];

/**
 * Land a barrier's awaited rows as a relation projecting the element payload.
 *
 * `extra` names columns beyond the payload that each row carries — the mid-traversal rejoin's parent
 * key — and `extraOf` supplies the matching cell per row.
 */
export function foreignRelation(
  rows: readonly ForeignRow[],
  elem: Elem,
  fresh: Minter,
  extra: readonly ColMeta[] = [],
  extraOf: (row: ForeignRow) => readonly unknown[] = () => [],
  withOrder = false,
): Rel {
  const cols = [...foreignPayloadCols(elem), ...extra];
  const payload = JSON.stringify(rows.map((row) => cellsOf(row, extraOf(row))));
  const exploded = make.explode({
    id: fresh('fgx'), channels: [], expr: lit(payload, 'text'), as: { value: CELL.value, ord: CELL.ord },
    type: typeOf(meta(CELL.value, 'any', true), meta(CELL.ord, 'int')),
  });
  // `withOrder` keeps the json_each KEY (the array index) as an `ord` column — the order the sibling
  // EMITTED these rows, which is the only order a landed stream can carry. The seed renumbers by it to
  // mint the `encounter` channel, so a bound `fold()`/`order()` collects in the sibling's own order.
  const ordCol = withOrder ? [meta(CELL.ord, 'int')] as const : [];
  return make.project({
    id: fresh('fgp'), input: exploded, channels: [], type: typeOf(...cols, ...ordCol),
    exprs: [
      ...cols.map((column, at) => [column.name, cellAt(col(exploded.id, CELL.value), at)] as const),
      ...(withOrder ? [[CELL.ord, col(exploded.id, CELL.ord)] as const] : []),
    ],
  });
}

/** Land the standard mapValues result without flattening it in JavaScript. The outer `json_each`
 * reads the ordinary `{parentId -> List<element>}` map pairs; the inner one reads that entry's list,
 * retaining the key as the correlation column until the ordinary parent join consumes it. */
export function foreignMapRelation(
  map: Extract<ValueNode, { readonly t: 'map' }>, elem: Elem, fresh: Minter,
  extra: readonly ColMeta[] = [], withOrder = false,
): Rel {
  const pairs = make.explode({
    id: fresh('fmx'), channels: [], expr: lit(JSON.stringify(map.v), 'text'), as: { value: MAP_PAIR.value },
    type: typeOf(meta(MAP_PAIR.value, 'json')),
  });
  const members = make.explode({
    id: fresh('fmy'), input: pairs, channels: [],
    expr: { kind: 'call', fn: 'json_extract', args: [col(pairs.id, MAP_PAIR.value), compilerText('$[1].v')] },
    as: { value: MAP_MEMBER.value, ord: CELL.ord },
    type: typeOf(...pairs.type.cols, meta(MAP_MEMBER.value, 'json'), meta(CELL.ord, 'int')),
  });
  const filtered = make.filter({
    id: fresh('fmf'), input: members, channels: [], type: members.type,
    pred: { kind: 'binary', op: '=', left: nodeField(col(members.id, MAP_MEMBER.value), 't'), right: compilerText(elem) },
  });
  const payload = foreignPayloadCols(elem);
  const parentId = { kind: 'call' as const, fn: 'json_extract', args: [col(filtered.id, MAP_PAIR.value), compilerText('$[0].v')] };
  return make.project({
    id: fresh('fmp'), input: filtered, channels: [], type: typeOf(...payload, ...extra, ...(withOrder ? [meta(CELL.ord, 'int')] : [])),
    exprs: [
      ...payload.map((column) => [column.name, nodeField(col(filtered.id, MAP_MEMBER.value), column.name)] as const),
      ...extra.map((column) => [column.name, parentId] as const),
      ...(withOrder ? [[CELL.ord, col(filtered.id, CELL.ord)] as const] : []),
    ],
  });
}

const nodeField = (node: Expr, field: string): Expr =>
  ({ kind: 'call', fn: 'json_extract', args: [node, compilerText(field === 't' ? '$.t' : `$.v.${field}`)] });

/** The standard mapValues parent IDs are map keys, not a hidden transport channel. Joining the
 * per-entry rows to this parent relation preserves two equal values under two different keys. */
export function foreignMapRejoin(pool: Rel, elem: Elem, parentCount: number, fresh: Minter): Rel {
  const parents = make.explode({
    id: fresh('fmd'), channels: [],
    expr: lit(JSON.stringify(Array.from({ length: parentCount }, (_, parentId) => String(parentId))), 'text'),
    as: { value: 'fmdv' }, type: typeOf(meta('fmdv', 'text')),
  });
  const joined = make.join({
    id: fresh('fmj'), left: pool, right: parents, channels: [],
    join: 'inner', type: typeOf(...pool.type.cols, meta('fmdv', 'text')),
    on: { kind: 'binary', op: '=', left: col(pool.id, 'parentId'), right: col(parents.id, 'fmdv') },
  });
  const payload = foreignPayloadCols(elem);
  return make.project({
    id: fresh('fmr'), input: joined, channels: [], type: typeOf(...payload),
    exprs: payload.map((column) => [column.name, col(joined.id, column.name)] as const),
  });
}

/** The name of the emission-order column `foreignRelation(…, withOrder=true)` carries. */
export const FOREIGN_ORD = CELL.ord;

/** `json_extract(<row>, '$[i]')` — a landed row's cell by position. The path is a compiler constant,
 *  so it splices literally and the statement text stays fixed however many rows landed. */
const cellAt = (row: Expr, at: number): Expr =>
  ({ kind: 'call', fn: 'json_extract', args: [row, compilerText(`$[${at}]`)] });

/**
 * SCATTER a batched barrier's pooled results back over the parents that asked for them.
 *
 * A constant mid-traversal runs once, then every parent receives its complete result pool through an
 * ordinary CROSS join. `parentCount` supplies that parent relation.
 */
export function foreignRejoin(pool: Rel, elem: Elem, parentCount: number, fresh: Minter): Rel {
  // ONE parent per row, the same one-bind rule the pool itself lands under: a parent set is data-sized.
  const parents = make.explode({
    id: fresh('fgd'), channels: [], expr: lit(JSON.stringify(Array.from({ length: parentCount }, (_, parentId) => parentId)), 'text'), as: { value: 'fdv' },
    type: typeOf(meta('fdv', 'int')),
  });
  const payload = foreignPayloadCols(elem);
  // A single parent takes the pool unchanged — the join would multiply by one, and
  // skipping it keeps the ordinary one-parent federate plan as small as it was.
  if (parentCount <= 1) return pool;
  const joined = make.join({
    id: fresh('fgj'), left: pool, right: parents, channels: [],
    join: 'cross',
    type: typeOf(...pool.type.cols, meta('fdv', 'int')),
  });
  return make.project({
    id: fresh('fgr'), input: joined, channels: [], type: typeOf(...payload),
    exprs: payload.map((column) => [column.name, col(joined.id, column.name)] as const),
  });
}

/** A landed element's `label()` — the SCALAR the step promises. A vertex's payload column holds the
 *  whole label set, so the step reads its first member; an edge's is already the name. */
export const foreignLabelValue = (landed: Rel, elem: Elem): Expr =>
  elem === 'edge' ? col(landed.id, 'label') : cellAt(col(landed.id, 'label'), 0);

/** The columns a landed relation's Plan binding (and every `Ref` to it) declares: the wire payload plus
 *  the `ord` emission-order column (`foreignRelation(withOrder)`), from which the seed and `.V()`/`.E()`
 *  re-root mint the `encounter` channel. Every read projects the subset it needs and ignores `ord`. */
export const landedCols = (kind: Elem): readonly ColMeta[] =>
  [...foreignPayloadCols(kind), meta(FOREIGN_ORD, 'int')];

/**
 * LAND a barrier's awaited rows as one or two `fenced` (`AS MATERIALIZED`) CTE bindings — the physical
 * substrate a `boundGraph` reads through.
 *
 * Each landed relation is declared ONCE and every read (the stream seed, each rejoin, the leaf)
 * REFERENCES it by name (a `Ref`). That is Calcite's materialize-once (`RelOptMaterialization`): N reads
 * share one CTE and its ONE `json_each` bind, computed once, rather than re-exploding the JSON literal
 * per read. A binding is used rather than a structurally shared node because a shared node is duplicated
 * by a tree-rebuild pass (the RelIR scope check refuses it) — a `Ref` is a named leaf.
 *
 * A SUBGRAPH result is MIXED — edges (the graph, carrying `src`/`tgt`) plus their incident vertices WITH
 * data — so the presence of BOTH kinds IS the signal (`isSubgraph`); the edges become the stream and the
 * vertices a bound lookup the tail's `inV`/`outV`/`bothV` join. A homogeneous result lands its one kind.
 * A `mapValues` result lands per-key with a DISTINCT payload (one sibling element can appear under several
 * parent keys; the payload binding stays per-element, the keyed pool preserves the multiplicity). `null`
 * binding = the KIND is absent (a vertex list has no edges), which fails a hop closed; an EMPTY same-kind
 * relation is still declared (a zero-row CTE), so an empty federated list frames rather than throws.
 *
 * Shared by `lowerForeignResume` (the top-level barrier resume) and the nested-branch federate segment.
 */
export function landForeignRows(
  rows: readonly ForeignRow[], elem: Elem, fresh: Minter,
  mapValues: Extract<ValueNode, { readonly t: 'map' }> | null = null,
): { vertexBinding: string | null; edgeBinding: string | null; streamElem: Elem; isSubgraph: boolean; bindings: Binding[] } {
  const dedupById = (rs: readonly ForeignRow[]): ForeignRow[] => [...new Map(rs.map((r) => [r.id, r])).values()];
  const vertexRows = dedupById(rows.filter((r) => r.kind === 'vertex'));
  const edgeRows = dedupById(rows.filter((r) => r.kind === 'edge'));
  const isSubgraph = edgeRows.length > 0 && vertexRows.length > 0;
  const streamElem: Elem = isSubgraph ? 'edge' : elem;
  const bindings: Binding[] = [];
  const declare = (landedRows: readonly ForeignRow[], kind: Elem): string => {
    const name = fresh(kind === 'edge' ? 'bge' : 'bgv');
    // `withOrder`: the binding carries the landed emission order (`ord`) beside the payload, so the seed
    // and a `.V()`/`.E()` re-root mint the `encounter` channel from it — channels over a bound graph.
    const raw = mapValues
      ? foreignMapRelation(mapValues, kind, fresh)
      : foreignRelation(landedRows, kind, fresh, [], undefined, true);
    // The bound payload is one row per element. A mapValues result may carry the same sibling
    // element under several parent keys; parent multiplicity belongs to the rejoin pool.
    const landedRelation = mapValues
      ? (() => {
          const deduped = make.distinct({ id: fresh('fmd'), input: raw, channels: [], type: raw.type });
          return make.project({
            id: fresh('fmo'), input: deduped, channels: [], type: typeOf(...landedCols(kind)),
            exprs: [
              ...foreignPayloadCols(kind).map((column) => [column.name, col(deduped.id, column.name)] as const),
              [FOREIGN_ORD, compilerInt(0)],
            ],
          });
        })()
      : raw;
    const materialized = make.materialize({ id: fresh('bgm'), input: landedRelation, channels: [], type: landedRelation.type, name, fenced: true });
    bindings.push({ name, node: materialized });
    return name;
  };
  const vertexBinding = isSubgraph || elem === 'vertex' ? declare(vertexRows, 'vertex') : null;
  const edgeBinding = isSubgraph || elem === 'edge' ? declare(edgeRows, 'edge') : null;
  return { vertexBinding, edgeBinding, streamElem, isSubgraph, bindings };
}
