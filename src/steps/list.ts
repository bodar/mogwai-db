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
import { readCompiled, type Compiled } from '../render.ts';
import { dispatchNext } from './index.ts';

/** Does this step carry a Scope.local token (the per-list, not whole-stream, form)? */
const isLocal = (s: PStep): boolean => (s.args ?? []).some((a: any) => a && typeof a === 'object' && a.scope === 'local');

/** A Scope.local reducer over a list value: reduce EACH list (row) to one scalar via a
 *  correlated json_each aggregate. count() counts elements (any list); sum/min/max/mean
 *  reduce the numeric elements (non-numeric filtered out, matching the global reducers).
 *  Terminal — a trailing step defers. */
function listReducer(s: ListStream, name: string): Compiled {
  const c = s.rel.as('c');
  if (name === 'count')
    return readCompiled(s.q, q`SELECT (SELECT COUNT(*) FROM json_each(${c.c.list}) je) AS v FROM ${c}`, { kind: 'count' });
  // Numeric aggregate over the list's numeric elements (typeof guard mirrors wrapReducer).
  const agg = (fn: string): Expression => q`(SELECT ${fn}(je.value) FROM json_each(${c.c.list}) je WHERE typeof(je.value) in ('integer', 'real'))`;
  if (name === 'mean') return readCompiled(s.q, q`SELECT ${agg('AVG')} AS v, 'real' AS vt FROM ${c}`, { kind: 'scalar' });
  const fn = name === 'sum' ? 'SUM' : name === 'min' ? 'MIN' : 'MAX';
  return readCompiled(s.q, q`SELECT ${agg(fn)} AS v, typeof(${agg(fn)}) AS vt FROM ${c}`, { kind: 'scalar' });
}

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
  const step = steps[at];
  if (step.name === 'unfold') return dispatchNext(compileUnfold(s), steps, at + 1);
  // Scope.local per-list reducers (count/sum/min/max/mean) — reduce each list to a
  // scalar. Terminal only for now; a trailing step (e.g. .is(P)) defers.
  if (['count', 'sum', 'min', 'max', 'mean'].includes(step.name) && isLocal(step)) {
    if (at + 1 !== steps.length) throw new Error(`step after ${step.name}(Scope.local) not yet supported`);
    return listReducer(s, step.name);
  }
  throw new Error(`${step.name}() on a list value not yet supported`);
}
