// ---------- list-value tail: unfold + the list arm of the dispatcher ----------
//
// A ListStream (stream.ts) is a single list value in a one-row relation with a JSONB
// `list` column. This module explodes it (unfold) and routes the list phase of the
// re-enterable tail (compileFromList). The producers live in projection.ts (compileFold)
// and, later, inject-of-a-list / select(Column.values).

import { q, type Expression } from '../q.ts';
import { predicateSql, jsonbGroupArray } from '../plan.ts';
import { type PStep } from '../strategies.ts';
import { carryOf, toListStream, mapOfToListOf, type ListStream, type ScalarStream, type MapStream } from './stream.ts';
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

/** none(pred): keep each list where NO element satisfies pred (a per-list collection
 *  filter) — stays a list stream. (SQL null semantics: an eq(null)/neq(null) predicate
 *  won't match a null element, so those edge forms may differ from TinkerPop.) */
function listNoneFilter(s: ListStream, pred: any): ListStream {
  const c = s.rel.as('c');
  const rel = s.q.cte(
    q`SELECT ${c.c.list} AS list FROM ${c} WHERE NOT EXISTS (SELECT 1 FROM json_each(${c.c.list}) je WHERE ${predicateSql(q`je.value`, pred)})`,
    ['list'],
  );
  return toListStream(carryOf(s), rel, s.of);
}

/** The Scope.local collection transforms that keep a list a list (per-list, not a
 *  whole-stream reduction). Each rebuilds each row's list via a correlated json_each. */
const LIST_LOCAL_TX = new Set(['order', 'dedup', 'limit', 'skip', 'range', 'tail']);

/**
 * A Scope.local collection transform over a list value (order/dedup/limit/skip/range/
 * tail) — rebuild EACH row's list with a correlated json_each aggregate, so it works
 * uniformly on a one-row fold() list and a multi-row select(Column.values).unfold()
 * stream of lists. Element order is preserved: order() sorts by element value, the
 * subset ops keep original position order (json_each `.key`), dedup keeps first
 * occurrence (GROUP BY value ORDER BY MIN(key)). Stays a ListStream, so downstream
 * (unfold / another list op / terminal) continues. by()/nested comparators defer.
 */
function listLocalTransform(s: ListStream, step: PStep): ListStream {
  const c = s.rel.as('c');
  const name = step.name;
  const nums = (step.args ?? []).filter((a: any) => typeof a === 'number') as number[];
  const je = q`json_each(${c.c.list})`;
  // Every branch re-aggregates with `json_group_array(value ORDER BY ord)` so the final
  // list order is explicit (never relying on subquery-order-into-aggregate). COALESCE to
  // '[]' keeps an empty result a list, not NULL.
  const rebuild = (rows: Expression): Expression =>
    q`(SELECT jsonb(COALESCE(json_group_array(value ORDER BY ord), json('[]'))) FROM (${rows}))`;
  let sub: Expression;
  if (name === 'order') {
    // Bare order(Scope.local) = ascending by element value. A direction-only
    // by(Order.desc/asc) flips it; a by(key)/by(traversal)/shuffle defers.
    let desc = false;
    for (const by of step.bys ?? []) {
      if (by.some((a: any) => typeof a === 'string' || (a && typeof a === 'object' && 'nested' in a)))
        throw new Error('order(Scope.local).by(key/traversal) not yet supported');
      const ord = by.find((a: any) => a && typeof a === 'object' && 'order' in a);
      if (ord?.order === 'shuffle') throw new Error('order(Scope.local) shuffle not yet supported');
      desc = ord?.order === 'desc';
    }
    sub = q`(SELECT jsonb(COALESCE(json_group_array(x.value ORDER BY x.value ${desc ? 'DESC' : 'ASC'}), json('[]'))) FROM ${je} x)`;
  } else if (name === 'dedup') {
    // First-occurrence order: group by value, order by earliest position.
    sub = rebuild(q`SELECT x.value AS value, MIN(x.key) AS ord FROM ${je} x GROUP BY x.value`);
  } else {
    // Positional subset (limit/skip/range/tail): pick rows by original position, then
    // re-aggregate in ascending position order. tail selects the LAST n via DESC LIMIT
    // (avoids a count() subquery that can't correlate two json_each levels deep).
    let lim = -1, off = 0, dir = 'ASC';
    if (name === 'limit') lim = nums[0];
    else if (name === 'skip') off = nums[0];
    else if (name === 'range') { off = nums[0]; lim = nums[1] < 0 ? -1 : nums[1] - nums[0]; }
    else if (name === 'tail') { lim = nums[0] ?? 1; dir = 'DESC'; }
    sub = rebuild(q`SELECT x.value AS value, x.key AS ord FROM ${je} x ORDER BY x.key ${dir} LIMIT ${lim} OFFSET ${off}`);
  }
  const rel = s.q.cte(q`SELECT ${sub} AS list FROM ${c}`, ['list']);
  return toListStream(carryOf(s), rel, s.of);
}

/**
 * The list arm of dispatchNext. A non-terminal fold always leaves a follower, so a
 * ListStream here is never terminal (a terminal fold stays the reducer path). unfold()
 * retypes and re-enters; Scope.local reductions/transforms reshape each list; the
 * set-op family (combine/…) lands later — until then it defers with a clear message.
 */
export function compileFromList(s: ListStream, steps: PStep[], at: number): Compiled {
  // End of chain → frame each list value as one GraphBinary List (json() so the JSONB
  // blob reads back as text for the handler to parse).
  if (at >= steps.length) {
    const c = s.rel.as('c');
    return readCompiled(s.q, q`SELECT json(${c.c.list}) AS list FROM ${c}`, { kind: 'jsonbList' });
  }
  const step = steps[at];
  if (step.name === 'unfold') return dispatchNext(compileUnfold(s), steps, at + 1);
  // none(pred): keep each list where NO element satisfies pred (a collection filter);
  // stays a list stream, so downstream continues.
  if (step.name === 'none') return dispatchNext(listNoneFilter(s, step.args[0]), steps, at + 1);
  // Scope.local collection transforms (order/dedup/limit/skip/range/tail) — reshape
  // each list and stay a ListStream, so downstream continues.
  if (LIST_LOCAL_TX.has(step.name) && isLocal(step))
    return dispatchNext(listLocalTransform(s, step), steps, at + 1);
  // Scope.local per-list reducers (count/sum/min/max/mean) — reduce each list to a
  // scalar. Terminal only for now; a trailing step (e.g. .is(P)) defers.
  if (['count', 'sum', 'min', 'max', 'mean'].includes(step.name) && isLocal(step)) {
    if (at + 1 !== steps.length) throw new Error(`step after ${step.name}(Scope.local) not yet supported`);
    return listReducer(s, step.name);
  }
  throw new Error(`${step.name}() on a list value not yet supported`);
}

/** The single Column arg of a select() over a map, if any. */
const columnOf = (step: PStep): 'keys' | 'values' | undefined =>
  (step.args ?? []).map((a: any) => a && typeof a === 'object' && a.column).find((c: any) => c === 'keys' || c === 'values');

/**
 * The map arm of dispatchNext. A MapStream (stream.ts) is a `(mk, mv)` row relation
 * reached only when a follower consumes a group()/groupCount(). select(Column.values)/
 * select(Column.keys) aggregate one column into a single list value (mirroring how
 * fold() builds a list), which unfold()/framing then handles — so
 * group().select(Column.values).unfold() flows map→list→scalar. Map-unfold (→ Map.Entry)
 * and select(Column) with a trailing key defer with a clear message.
 */
export function compileFromMap(s: MapStream, steps: PStep[], at: number): Compiled {
  // Terminal is unreachable: a group() only retypes to a MapStream when a follower
  // exists (else it stays the row-folding groupBuffer path).
  if (at >= steps.length) throw new Error('a map value at end of chain should not be a MapStream');
  const step = steps[at];
  if (step.name === 'select') {
    const col = columnOf(step);
    if (!col) throw new Error('select() on a map value requires Column.keys or Column.values');
    const c = s.rel.as('c');
    // Column.values → all values as one list; Column.keys → all keys as one list.
    const [srcCol, of] = col === 'values' ? [c.c.mv, mapOfToListOf(s.valOf)] : [c.c.mk, mapOfToListOf(s.keyOf)];
    const rel = s.q.cte(q`SELECT ${jsonbGroupArray(srcCol)} AS list FROM ${c}`, ['list']);
    return dispatchNext(toListStream(carryOf(s), rel, of), steps, at + 1);
  }
  throw new Error(`${step.name}() on a map value not yet supported`);
}
