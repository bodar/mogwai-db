// ---------- the one read materialization boundary ----------
//
// Semantic lowering builds relational state. Only this module turns a final SQL
// relation/expression into the handler-facing Compiled + GraphBinary Shape contract.
// During the staged migration some leaf compilers still provide their historical tail
// expression directly; keeping that compatibility behind this function prevents new
// readCompiled islands while those leaves are converted to Stream -> Stream lowerers.

import { raw, type Expression, type Query } from '../../../sql/kernel/q.ts';
import { perRowColumnOf, readCompiled, STATIC, UNKNOWN, type Compiled, type ListOf, type Shape, type VariantShapeArm } from '../../../sql/kernel/render.ts';
import { list, q } from '../../../sql/kernel/q.ts';
import { framedProps, extIdOf, elemTable, labelNameFor, labelNameSub, vertexLabelName } from '../../plan/plan.ts';
import { edges, nodes } from '../../../sql/schema.ts';
import { groupResultColumns, pathColumns, recordResultColumns, type ForeignStream, type GroupStream, type ListStream, type MapEntryStream, type MapOf, type MapStream, type PathStream, type PropertyStream, type RecordStream, type ScalarStream, type Stream, type VariantStream } from '../context/stream.ts';
import type { ElementStream } from '../context/context.ts';

export function materializeRoot(query: Query, tail: Expression, shape: Shape): Compiled {
  return readCompiled(query, tail, shape);
}

/** Materialize a lowered scalar relation. Reducer result metadata lives on the
 * stream, so terminal position no longer decides whether a Long count or an
 * ordinary value is framed. */
export function materializeScalarRoot(stream: ScalarStream): Compiled {
  // `result: 'count'` needs no arm of its own — every one of its five producers already passes
  // 'long' as the type, so the generic value arm frames it identically (countBuffer and
  // frameValue(v,'long') were the same expression). Retiring the redundant `result` value itself
  // is a separate change: it still distinguishes a count from a 'number' reducer for column sets.
  const shape: Shape = stream.result === 'number'
    ? { kind: 'scalar', productiveNull: stream.productiveNull }
    : { kind: 'value', type: stream.type };
  // A per-row stored vtype column (values() of a typed prop) rides alongside v so the
  // handler frames each row by its own type, not one compile-time tag.
  const perRow = perRowColumnOf(stream.type);
  const cols = stream.result === 'number' ? q`v, vt` : perRow ? q`v, ${raw(perRow)}` : q`v`;
  if (!stream.traverserLayout.encounter) return materializeRoot(stream.q, q`SELECT ${cols} FROM ${stream.rel}`, shape);
  const s = stream.rel.as('s');
  return materializeRoot(stream.q, q`SELECT ${cols} FROM ${s} ORDER BY ${s.c[stream.traverserLayout.encounter]}`, shape);
}

/** Expand each present arm at the wire boundary (P4 dynamic-tag row). The tag is put
 * in each element join condition (`vk=2`/`vk=3`) so a node and an edge sharing a rowid
 * never cross-match; a row is exactly one arm, so id/label/props are a CASE over the two
 * possible element aliases and one labels join keys off whichever is populated. Scalar
 * (`v`) / null rows join nothing; a list arm expands its `list` column like ListStream.
 * Internal rowids remain available until this final SELECT. */
export function materializeVariantRoot(stream: VariantStream): Compiled {
  const v = stream.rel.as('v');
  const arms: VariantShapeArm[] = [{ kind: 'scalar', type: stream.scalarAs ? STATIC(stream.scalarAs) : UNKNOWN }];
  if (stream.node) arms.push({ kind: 'vertex' });
  if (stream.edge) arms.push({ kind: 'edge' });
  if (stream.listOf) arms.push({ kind: 'list', of: stream.listOf });
  const shape: Shape = { kind: 'variant', arms, wholeResult: stream.result === 'list' || undefined };
  const cols: Expression[] = [v.c.vk, v.c.v];
  const joins: Expression[] = [];
  if (stream.node || stream.edge) {
    const n = stream.node ? nodes.as('n') : undefined;
    const e = stream.edge ? edges.as('e') : undefined;
    const idParts = [n && q`WHEN 2 THEN COALESCE(${n.c.uid}, ${n.c.id})`, e && q`WHEN 3 THEN COALESCE(${e.c.uid}, ${e.c.id})`].filter(Boolean) as Expression[];
    // Each arm reads its own label: the vertex correlates into vertex_labels and picks,
    // the edge reads its inline column. The old single `LEFT JOIN labels` keyed on
    // COALESCE(n.label, e.label) is gone with nodes.label.
    const labelParts = [n && q`WHEN 2 THEN ${vertexLabelName(n.c.id)}`, e && q`WHEN 3 THEN ${labelNameSub(e.c.label)}`].filter(Boolean) as Expression[];
    const propParts = [n && q`WHEN 2 THEN json(${framedProps(n, 'vertex')})`, e && q`WHEN 3 THEN json(${framedProps(e, 'edge')})`].filter(Boolean) as Expression[];
    cols.push(q`CASE ${v.c.vk} ${list(idParts, ' ')} END AS id`);
    cols.push(q`CASE ${v.c.vk} ${list(labelParts, ' ')} END AS label`);
    cols.push(q`CASE ${v.c.vk} ${list(propParts, ' ')} END AS props`);
    if (e) cols.push(q`${extIdOf(e.c.src)} AS src`, q`${extIdOf(e.c.tgt)} AS tgt`);
    if (n) joins.push(q` LEFT JOIN ${n} ON ${n.c.id}=${v.c.rid} AND ${v.c.vk}=2`);
    if (e) joins.push(q` LEFT JOIN ${e} ON ${e.c.id}=${v.c.rid} AND ${v.c.vk}=3`);
  }
  if (stream.listOf) cols.push(q`${listResult(v.c.list, stream.listOf)} AS list`);
  return materializeRoot(stream.q, q`SELECT ${list(cols, ', ')} FROM ${v}${list(joins, '')}`, shape);
}

/** Turn a JSON list of internal element rowids into an ordered JSON array carrying
 * the complete public element payload. The raw relational list remains rowids for
 * downstream unfold; only the root wire projection expands it. */
function elementListResult(listExpr: Expression, elem: 'vertex' | 'edge'): Expression {
  const n = elemTable(elem).as('n');
  const lbl = labelNameFor(n, elem);
  const object = elem === 'edge'
    ? q`json_object('id', COALESCE(${n.c.uid}, ${n.c.id}), 'label', ${lbl}, 'src', ${extIdOf(n.c.src)}, 'tgt', ${extIdOf(n.c.tgt)}, 'props', json(${framedProps(n, elem)}))`
    : q`json_object('id', COALESCE(${n.c.uid}, ${n.c.id}), 'label', ${lbl}, 'props', json(${framedProps(n, elem)}))`;
  const expanded = q`json_each(json(${listExpr})) AS j JOIN ${n} ON ${n.c.id}=j.value`;
  return q`json(COALESCE((SELECT json_group_array(${object} ORDER BY j.key) FROM ${expanded}), json('[]')))`;
}

/** A list-of-lists whose LEAF is an element list — e.g. a terminal
 * `select(Column.values)` over an element-list-valued group produces
 * `{list, of:{list, of:{elem}}}`. Each outer array element is itself a JSON list of
 * internal rowids, so we `json_each` the outer array and recurse listResult() over each
 * inner value, expanding the leaf rowids to full element payloads. Without this the outer
 * list would frame as `json(expr)` — the raw inner rowid arrays, an internal-id leak.
 * Ordering matches elementListResult (by the json_each key). The `depth` names a unique
 * iterator alias per nesting level (`jj0`, `jj1`, …) so an inner elementListResult's own
 * `json_each … AS j` never shadows this level's iterator. */
function nestedListResult(listExpr: Expression, of: ListOf, depth: number): Expression {
  const it = `jj${depth}`;
  const inner = listResult(q`${it}.value`, of, depth + 1);
  return q`json(COALESCE((SELECT json_group_array(${inner} ORDER BY ${it}.key) FROM json_each(json(${listExpr})) AS ${it}), json('[]')))`;
}

const listResult = (expr: Expression, of: ListOf, depth = 0): Expression =>
  of.kind === 'elem' ? elementListResult(expr, of.elem)
    : of.kind === 'list' ? nestedListResult(expr, of.of, depth)
    : q`json(${expr})`;

/** Materialize one list value per relation row. Scalar lists retain a uniform item
 * tag; element/nested lists continue through the existing JSONB framing path. */
export function materializeListRoot(stream: ListStream): Compiled {
  const c = stream.rel.as('c');
  if (stream.of.kind === 'elem') {
    const elem = stream.of.elem;
    return materializeRoot(
      stream.q,
      q`SELECT ${elementListResult(c.c.list, elem)} AS list FROM ${c}`,
      { kind: 'jsonbElementList', elem },
    );
  }
  // A nested list whose leaf is an element list (e.g. a terminal select(Column.values)
  // over an element-list-valued group) must expand its leaf rowids to element payloads;
  // listResult recurses and only the leaf join hits nodes/edges. The `of` descriptor rides
  // on the jsonbList shape so frameListOf recurses the same nesting on the framing side.
  if (stream.of.kind === 'list')
    return materializeRoot(stream.q, q`SELECT ${listResult(c.c.list, stream.of)} AS list FROM ${c}`, { kind: 'jsonbList', items: stream.of });
  const typed = stream.of.kind === 'scalar' && stream.of.typed ? true : undefined;
  const shape: Shape = stream.set
    ? { kind: 'jsonbSet', typed }
    : { kind: 'jsonbList', items: stream.of };
  return materializeRoot(stream.q, q`SELECT json(${c.c.list}) AS list FROM ${c}`, shape);
}

/** Expand one internal element rowid into a JSON object carrying the public element
 * payload (id/label/props[/src/tgt]) — the single-value twin of elementListResult, for a
 * Map.Entry key/value that holds an element. json_object over a correlated join to
 * nodes/edges + labels; NULL rowid → SQL NULL (framed as a null value). */
function elementValueResult(ridExpr: Expression, elem: 'vertex' | 'edge'): Expression {
  const n = elemTable(elem).as('en');
  const lbl = labelNameFor(n, elem);
  const object = elem === 'edge'
    ? q`json_object('id', COALESCE(${n.c.uid}, ${n.c.id}), 'label', ${lbl}, 'src', ${extIdOf(n.c.src)}, 'tgt', ${extIdOf(n.c.tgt)}, 'props', json(${framedProps(n, elem)}))`
    : q`json_object('id', COALESCE(${n.c.uid}, ${n.c.id}), 'label', ${lbl}, 'props', json(${framedProps(n, elem)}))`;
  return q`(SELECT ${object} FROM ${n} WHERE ${n.c.id}=${ridExpr})`;
}

/** One side (key/value) of a Map.Entry row projected to a wire-ready column. A scalar rides
 * as its {t,v} node JSON; a single element rowid expands to its public payload JSON; a list
 * is expanded via listResult (an element list's rowids become full payload objects). */
const mapSideResult = (col: Expression, of: MapOf): Expression =>
  of.kind === 'elem' ? elementValueResult(col, of.elem) : of.kind === 'list' ? listResult(col, of.of) : col;

/** Materialize a MapStream at the root — each row is one whole map VALUE, framed as one
 * GraphBinary MAP. The `map` blob is `[[keyNode,valNode],…]`; a scalar side is a self-
 * describing {t,v} node, so the handler frames the whole blob via frameTypedNode-style
 * decoding. An element/list side is expanded to its public payload here so the framer sees
 * ready JSON (only when a side is elem/list — the common scalar case passes the blob through). */
export function materializeMapRoot(stream: MapStream): Compiled {
  const c = stream.rel.as('c');
  // All-scalar (the common case: stored map, groupCount, scalar-valued group) → the blob is
  // already a frameable [[{t,v},{t,v}],…] tree; hand it straight to the map framer.
  if (stream.keyOf.kind === 'scalar' && stream.valOf.kind === 'scalar')
    return materializeRoot(stream.q, q`SELECT json(${c.c.map}) AS map FROM ${c}`, { kind: 'mapValue' });
  // A LIST value side is what a valueMap-derived map carries (properties are multi-valued). It
  // frames with NO conversion: the blob's value side is a naked array — the untyped list
  // substrate's contract, which the re-entry consumers own — and the typed framer treats a bare
  // array as a list of bare members, exactly as it treats a bare scalar as an inferred value.
  // So there is ONE blob encoding, not two with a rebuild between them.
  if (stream.keyOf.kind === 'scalar' && stream.valOf.kind === 'list')
    return materializeRoot(stream.q, q`SELECT json(${c.c.map}) AS map FROM ${c}`, { kind: 'mapValue' });
  // An ELEMENT side still needs per-pair expansion — deferred, fails closed.
  throw new Error('a terminal map with an element key or value not yet supported');
}

/** Materialize a MapEntryStream (post-unfold) — each row is one Map.Entry, framed as a size-1
 * GraphBinary MAP (the settled v4 wire form: a Map.Entry has no dedicated DataType; TinkerPop's
 * MapEntrySerializer transforms it into a one-entry Map, TINKERPOP-3104). */
export function materializeMapEntryRoot(stream: MapEntryStream): Compiled {
  const c = stream.rel.as('c');
  return materializeRoot(
    stream.q,
    q`SELECT ${mapSideResult(c.c.mk, stream.keyOf)} AS mk, ${mapSideResult(c.c.mv, stream.valOf)} AS mv FROM ${c}`,
    { kind: 'mapEntry', keyOf: stream.keyOf, valOf: stream.valOf },
  );
}

/** Materialize a PropertyStream only at the root boundary. Edge Property rows use
 * the same payload shape (with a null vpid/meta) as the historical properties()
 * compiler; VertexProperty rows retain their real id and meta-properties. */
export function materializePropertyRoot(stream: PropertyStream): Compiled {
  const p = stream.rel.as('p');
  return materializeRoot(
    stream.q,
    q`SELECT ${p.c.vpid}, ${p.c.owner}, ${p.c.pk}, ${p.c.pv}, ${p.c.pvtype}, ${p.c.pmeta} FROM ${p}`,
    { kind: 'property' },
  );
}

/** Materialize a per-traverser heterogeneous record as the existing map wire shape.
 * Per-traverser layout state is deliberately not projected across the root boundary. */
export function materializeRecordRoot(stream: RecordStream): Compiled {
  const r = stream.rel.as('r');
  const cols: Expression[] = [];
  for (const field of stream.fields) {
    if (field.sub === 'list')
      cols.push(q`${listResult(r.c[`${field.prefix}_list`], field.of)} AS ${`${field.prefix}_list`}`);
    else cols.push(...recordResultColumns(field).map((name) => r.c[name]));
  }
  return materializeRoot(stream.q, q`SELECT ${list(cols, ', ')} FROM ${r}`, { kind: 'map', entries: [...stream.fields] });
}

/** Materialize the rich group barrier layout. The handler folds rows into one Map;
 * internal re-entry columns remain behind the root boundary. */
export function materializeGroupRoot(stream: GroupStream): Compiled {
  const g = stream.rel.as('g');
  const cols = groupResultColumns(stream).map((name) => g.c[name]);
  return materializeRoot(stream.q, q`SELECT ${list(cols, ', ')} FROM ${g}`, { kind: 'group', key: stream.key, val: stream.val });
}

export function materializePathRoot(stream: PathStream): Compiled {
  const p = stream.rel.as('p');
  const cols = pathColumns(stream.layout).map((name) => p.c[name]);
  const shape: Shape = stream.layout.kind === 'linear'
    ? { kind: 'path', positions: [...stream.layout.positions] }
    : { kind: 'pathGrouped', elem: stream.layout.elem, ...(stream.layout.byKey ? { byKey: true } : {}) };
  return materializeRoot(stream.q, q`SELECT ${list(cols, ', ')} FROM ${p}`, shape);
}

/** Materialize a foreign (detached) element stream — the result of a federated call().
 * Reuses the ordinary vertex/edge Shape and framing; only the projection differs: the
 * id/label/props (+ src/tgt) columns come straight off the landed VALUES CTE with NO
 * framedProps join (a detached element has no local nodes/edges row). `fprops` is already
 * JSON text in the per-key {t,v}-node shape rowVertex/rowEdge parse, so `json(...)` hands the
 * framer ready payload. */
export function materializeForeignRoot(stream: ForeignStream): Compiled {
  const p = stream.rel.as('p');
  const cols: Expression[] = [q`${p.c.fid} AS id`, q`${p.c.flabel} AS label`];
  if (stream.elem === 'edge') cols.push(q`${p.c.fsrc} AS src`, q`${p.c.ftgt} AS tgt`);
  cols.push(q`json(${p.c.fprops}) AS props`);
  return materializeRoot(stream.q, q`SELECT ${list(cols, ', ')} FROM ${p}`, { kind: stream.elem });
}

/** The single terminal dispatch for every fully-typed relational stream. ElementStream
 * still passes through compileTail because its historical projection accumulator can
 * produce a terminal expression; migrating that compatibility island is the final
 * materialization-boundary slice. An `entries` MapStream materializes as a Map.Entry
 * stream (each row → a size-1 MAP); a non-entry (aggregate) MapStream always retypes to
 * a ListStream before the root, so it is not a terminal value. */
export function materializeStream(stream: Exclude<Stream, ElementStream>): Compiled {
  switch (stream.kind) {
    case 'result': return materializeRoot(stream.q, stream.tail, stream.shape);
    case 'scalar': return materializeScalarRoot(stream);
    case 'variant': return materializeVariantRoot(stream);
    case 'list': return materializeListRoot(stream);
    case 'property': return materializePropertyRoot(stream);
    case 'record': return materializeRecordRoot(stream);
    case 'group': return materializeGroupRoot(stream);
    case 'path': return materializePathRoot(stream);
    case 'map': return materializeMapRoot(stream);
    case 'mapEntry': return materializeMapEntryRoot(stream);
    case 'foreign': return materializeForeignRoot(stream);
  }
}

/** Cross the read boundary after lowering has finished. Keeping the ElementStream
 * rejection here makes `lowerSteps` reusable without letting a caller accidentally
 * frame an element relation before its public element projection is built. */
export function materializeRootStream(stream: Stream): Compiled {
  if (stream.kind === 'elements') throw new Error('element lowering ended before root projection');
  return materializeStream(stream);
}
