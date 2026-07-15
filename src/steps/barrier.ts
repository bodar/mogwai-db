import { q } from '../q.ts';
import { carryOf, toScalarStream, type Stream, type ScalarStream } from './stream.ts';
import { withoutCarried } from './context.ts';

/** Global count is a relational barrier: it consumes any shaped row stream and
 * returns exactly one Long scalar traverser. Row-associated state cannot cross it. */
export function lowerGlobalCount(input: Stream): ScalarStream {
  const rel = input.q.cte(q`SELECT COUNT(*) AS v FROM ${input.rel}`, ['v']);
  return toScalarStream(withoutCarried(carryOf(input)), rel, 'long', 'count');
}
