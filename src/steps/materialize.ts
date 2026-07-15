// ---------- the one read materialization boundary ----------
//
// Semantic lowering builds relational state. Only this module turns a final SQL
// relation/expression into the handler-facing Compiled + GraphBinary Shape contract.
// During the staged migration some leaf compilers still provide their historical tail
// expression directly; keeping that compatibility behind this function prevents new
// readCompiled islands while those leaves are converted to Stream -> Stream lowerers.

import { type Expression, type Query } from '../q.ts';
import { readCompiled, type Compiled, type Shape } from '../render.ts';
import { list, q } from '../q.ts';
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
      ? { kind: 'scalar' }
    : { kind: 'value', as: stream.as };
  const cols = stream.result === 'number' ? q`v, vt` : q`v`;
  return materializeRoot(stream.q, q`SELECT ${cols} FROM ${stream.rel}`, shape);
}

/** Materialize one list value per relation row. Scalar lists retain a uniform item
 * tag; element/nested lists continue through the existing JSONB framing path. */
export function materializeListRoot(stream: ListStream): Compiled {
  const c = stream.rel.as('c');
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
  const cols = stream.fields.flatMap(recordResultColumns).map((name) => r.c[name]);
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
