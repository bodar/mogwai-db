// ---------- the one read materialization boundary ----------
//
// Semantic lowering builds relational state. Only this module turns a final SQL
// relation/expression into the handler-facing Compiled + GraphBinary Shape contract.
// During the staged migration some leaf compilers still provide their historical tail
// expression directly; keeping that compatibility behind this function prevents new
// readCompiled islands while those leaves are converted to Stream -> Stream lowerers.

import { type Expression, type Query } from '../q.ts';
import { readCompiled, type Compiled, type ListOf, type Shape } from '../render.ts';
import { list, q } from '../q.ts';
import { framedProps, extIdOf } from '../plan.ts';
import { edges, labels, nodes } from '../schema.ts';
import { groupResultColumns, pathColumns, recordResultColumns, type GroupStream, type ListStream, type PathStream, type PropertyStream, type RecordStream, type ScalarStream } from './stream.ts';

export function materializeRoot(query: Query, tail: Expression, shape: Shape): Compiled {
  return readCompiled(query, tail, shape);
}

/** Materialize a lowered scalar relation. Reducer result metadata lives on the
 * stream, so terminal position no longer decides whether a Long count or an
 * ordinary value is framed. */
export function materializeScalarRoot(stream: ScalarStream): Compiled {
  const shape: Shape = stream.result === 'count'
    ? { kind: 'count' }
    : stream.result === 'number'
      ? { kind: 'scalar', productiveNull: stream.productiveNull }
    : { kind: 'value', as: stream.as };
  const cols = stream.result === 'number' ? q`v, vt` : q`v`;
  return materializeRoot(stream.q, q`SELECT ${cols} FROM ${stream.rel}`, shape);
}

/** Turn a JSON list of internal element rowids into an ordered JSON array carrying
 * the complete public element payload. The raw relational list remains rowids for
 * downstream unfold; only the root wire projection expands it. */
function elementListResult(listExpr: Expression, elem: 'node' | 'edge'): Expression {
  const n = (elem === 'edge' ? edges : nodes).as('n');
  const l = labels.as('l');
  const object = elem === 'edge'
    ? q`json_object('id', COALESCE(${n.c.uid}, ${n.c.id}), 'label', ${l.c.name}, 'src', ${extIdOf(n.c.src)}, 'tgt', ${extIdOf(n.c.tgt)}, 'props', json(${framedProps(n, elem)}))`
    : q`json_object('id', COALESCE(${n.c.uid}, ${n.c.id}), 'label', ${l.c.name}, 'props', json(${framedProps(n, elem)}))`;
  const expanded = q`json_each(json(${listExpr})) AS j JOIN ${n} ON ${n.c.id}=j.value JOIN ${l} ON ${l.c.id}=${n.c.label}`;
  return q`json(COALESCE((SELECT json_group_array(${object} ORDER BY j.key) FROM ${expanded}), json('[]')))`;
}

const listResult = (expr: Expression, of: ListOf): Expression =>
  of.kind === 'elem' ? elementListResult(expr, of.elem) : q`json(${expr})`;

/** Materialize one list value per relation row. Scalar lists retain a uniform item
 * tag; element/nested lists continue through the existing JSONB framing path. */
export function materializeListRoot(stream: ListStream): Compiled {
  const c = stream.rel.as('c');
  if (stream.of.kind === 'elem') {
    const elem = stream.of.elem;
    return materializeRoot(
      stream.q,
      q`SELECT ${elementListResult(c.c.list, elem)} AS list FROM ${c}`,
      { kind: 'jsonbElementList', elem: elem === 'edge' ? 'edge' : 'vertex' },
    );
  }
  const as = stream.of.kind === 'scalar' ? stream.of.as : undefined;
  return materializeRoot(
    stream.q,
    q`SELECT json(${c.c.list}) AS list FROM ${c}`,
    as ? { kind: 'jsonbList', as } : { kind: 'jsonbList' },
  );
}

/** Materialize a PropertyStream only at the root boundary. Edge Property rows use
 * the same payload shape (with a null vpid/meta) as the historical properties()
 * compiler; VertexProperty rows retain their real id and meta-properties. */
export function materializePropertyRoot(stream: PropertyStream): Compiled {
  const p = stream.rel.as('p');
  return materializeRoot(
    stream.q,
    q`SELECT ${p.c.vpid}, ${p.c.owner}, ${p.c.pk}, ${p.c.pv}, ${p.c.pmeta} FROM ${p}`,
    { kind: 'property' },
  );
}

/** Materialize a per-traverser heterogeneous record as the existing map wire shape.
 * Carried compiler state is deliberately not projected across the root boundary. */
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
    : { kind: 'pathGrouped', elem: stream.layout.elem };
  return materializeRoot(stream.q, q`SELECT ${list(cols, ', ')} FROM ${p}`, shape);
}
