// ---------- the one read materialization boundary ----------
//
// Semantic lowering builds relational state. Only this module turns a final SQL
// relation/expression into the handler-facing Compiled + GraphBinary Shape contract.
// During the staged migration some leaf compilers still provide their historical tail
// expression directly; keeping that compatibility behind this function prevents new
// readCompiled islands while those leaves are converted to Stream -> Stream lowerers.

import { type Expression, type Query } from '../q.ts';
import { readCompiled, type Compiled, type Shape } from '../render.ts';
import { q } from '../q.ts';
import { type ScalarStream } from './stream.ts';

export function materializeRoot(query: Query, tail: Expression, shape: Shape): Compiled {
  return readCompiled(query, tail, shape);
}

/** Materialize a lowered scalar relation. Reducer result metadata lives on the
 * stream, so terminal position no longer decides whether a Long count or an
 * ordinary value is framed. */
export function materializeScalarRoot(stream: ScalarStream): Compiled {
  const shape: Shape = stream.result === 'count'
    ? { kind: 'count' }
    : { kind: 'value', as: stream.as };
  return materializeRoot(stream.q, q`SELECT v FROM ${stream.rel}`, shape);
}
