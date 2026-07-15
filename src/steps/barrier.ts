import { q } from '../q.ts';
import { carryOf, toScalarStream, type Stream, type ScalarStream } from './stream.ts';
import { withoutCarried } from './context.ts';

/** Global count is a relational barrier: it consumes any shaped row stream and
 * returns exactly one Long scalar traverser. Row-associated state cannot cross it. */
export function lowerGlobalCount(input: Stream): ScalarStream {
  const rel = input.q.cte(q`SELECT COUNT(*) AS v FROM ${input.rel}`, ['v']);
  return toScalarStream(withoutCarried(carryOf(input)), rel, 'long', 'count');
}

export type NumericReducer = 'sum' | 'min' | 'max' | 'mean';

/** A numeric/comparable reduction carries SQLite's winning storage class as `vt`.
 * That is part of the physical scalar payload, so a following is()/order()/limit()
 * can remain relational without losing GraphBinary numeric framing. */
export function lowerGlobalNumericReducer(input: ScalarStream, reducer: NumericReducer): ScalarStream {
  const src = input.rel.as('s');
  let body;
  if (reducer === 'sum') {
    body = q`SELECT SUM(${src.c.v}) AS v, typeof(SUM(${src.c.v})) AS vt FROM ${src}`;
  } else if (reducer === 'mean') {
    body = q`SELECT AVG(${src.c.v}) AS v, 'real' AS vt FROM ${src} WHERE typeof(${src.c.v}) in ('integer', 'real')`;
  } else {
    const fn = reducer === 'min' ? 'MIN' : 'MAX';
    body = q`SELECT ${fn}(${src.c.v}) AS v, typeof(${fn}(${src.c.v})) AS vt FROM ${src} WHERE typeof(${src.c.v}) in ('integer', 'real', 'text')`;
  }
  const rel = input.q.cte(body, ['v', 'vt']);
  return toScalarStream(withoutCarried(carryOf(input)), rel, undefined, 'number');
}
