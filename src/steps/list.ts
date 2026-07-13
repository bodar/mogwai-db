// ---------- list-value tail: unfold + the list arm of the dispatcher ----------
//
// A ListStream (stream.ts) is a single list value in a one-row relation with a JSONB
// `list` column. This module explodes it (unfold) and routes the list phase of the
// re-enterable tail (compileFromList). The producers live in projection.ts (compileFold)
// and, later, inject-of-a-list / select(Column.values).

import { q, type Expression } from '../q.ts';
import { type PStep } from '../strategies.ts';
import { carryOf, type ListStream, type ScalarStream } from './stream.ts';
import { type St } from './context.ts';
import { type Compiled } from '../render.ts';
import { dispatchNext } from './index.ts';

/**
 * unfold() a list value → its element or scalar stream. The JSONB array is exploded
 * with json_each (ordered by array position `.key`, preserving list order): an element
 * list → a fresh id-relation (a St the movement/tail dispatch re-enters, rejoining
 * nodes/edges downstream); a scalar list → a `v` ScalarStream carrying the value tag.
 * Mirrors compilePathArray's json_each idiom. Aliases/path/origin are NOT carried
 * through the retype (compileFold refused to fold them in), so the new stream starts
 * clean.
 */
export function compileUnfold(s: ListStream): St | ScalarStream {
  const c = carryOf(s);
  const explode = (col: string): Expression =>
    q`SELECT je.value AS ${col} FROM ${s.rel}, json_each(${s.rel.c.list}) je ORDER BY je.key`;
  if (s.of.kind === 'elem') {
    const rel = s.q.cte(explode('id'), ['id']);
    return { ...c, kind: 'elements', last: rel, elem: s.of.elem, aliases: new Map(), path: undefined, origin: undefined };
  }
  const rel = s.q.cte(explode('v'), ['v']);
  return { ...c, kind: 'scalar', rel, as: s.of.as };
}

/**
 * The list arm of dispatchNext. A non-terminal fold always leaves a follower, so a
 * ListStream here is never terminal (a terminal fold stays the reducer path). unfold()
 * retypes and re-enters; Scope.local reductions and the set-op family (combine/…) land
 * later — until then they defer with a clear message.
 */
export function compileFromList(s: ListStream, steps: PStep[], at: number): Compiled {
  if (at >= steps.length) throw new Error('a bare list value cannot be framed here (only a terminal fold() can)');
  const step = steps[at].name;
  if (step === 'unfold') return dispatchNext(compileUnfold(s), steps, at + 1);
  throw new Error(`${step}() on a list value not yet supported`);
}
