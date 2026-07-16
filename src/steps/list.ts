// ---------- list-value tail: unfold + the list arm of the dispatcher ----------
//
// A ListStream (stream.ts) is a single list value in a one-row relation with a JSONB
// `list` column. This module explodes it (unfold) and routes the list phase of the
// re-enterable tail (compileFromList). The producers live in projection.ts (compileFold)
// and, later, inject-of-a-list / select(Column.values).

import { q, value, raw, list, empty, type Expression, type Relation } from '../q.ts';
import { predicateSql, scalarTx } from '../plan.ts';
import { stepChain } from '../frontend.ts';
import { type PStep } from '../strategies.ts';
import { carryOf, continueLowering, toListStream, toResultStream, toScalarStream, mapOfToListOf, type ListStream, type LoweringResult, type ScalarStream, type MapStream } from './stream.ts';
import { carryFrag, carriedCols, type ElementStream } from './context.ts';
import { type Compiled } from '../render.ts';
import { compileRead } from './index.ts';

/** Does this step carry a Scope.local token (the per-list, not whole-stream, form)? */
const isLocal = (s: PStep): boolean => (s.args ?? []).some((a: any) => a && typeof a === 'object' && a.scope === 'local');

/** A Scope.local reducer over a list value: reduce EACH list (row) to one scalar via a
 *  correlated json_each aggregate. count() counts elements (any list); sum/min/max/mean
 *  reduce the numeric elements (non-numeric filtered out, matching the global reducers).
 *  Terminal — a trailing step defers. */
function lowerListReducer(s: ListStream, name: string): ScalarStream {
  const c = s.rel.as('c');
  // Each list row reduces to one scalar, so the row's carried schema (as() alias
  // history, path, …) rides through unchanged — one reduced value per original
  // traverser. So `as("v")…map(...).sum(Scope.local).as("s")` keeps "v".
  const carry = carryFrag(s.carried, c);
  const carried = carriedCols(s.carried);
  if (name === 'count') {
    const rel = s.q.cte(q`SELECT (SELECT COUNT(*) FROM json_each(${c.c.list}) je) AS v${carry} FROM ${c}`, ['v', ...carried]);
    return toScalarStream(carryOf(s), rel, 'long', 'count');
  }
  // Numeric aggregate over the list's numeric elements (typeof guard mirrors wrapReducer);
  // min/max also range over text (TinkerPop 4 Strings are Comparable), sum/mean stay numeric.
  const types = (name === 'min' || name === 'max') ? "('integer', 'real', 'text')" : "('integer', 'real')";
  const agg = (fn: string): Expression => q`(SELECT ${fn}(je.value) FROM json_each(${c.c.list}) je WHERE typeof(je.value) in ${types})`;
  if (name === 'mean') {
    const rel = s.q.cte(q`SELECT ${agg('AVG')} AS v, 'real' AS vt${carry} FROM ${c}`, ['v', 'vt', ...carried]);
    return toScalarStream(carryOf(s), rel, undefined, 'number', undefined, s.of.kind === 'scalar' && s.of.productiveNull);
  }
  const fn = name === 'sum' ? 'SUM' : name === 'min' ? 'MIN' : 'MAX';
  const rel = s.q.cte(q`SELECT ${agg(fn)} AS v, typeof(${agg(fn)}) AS vt${carry} FROM ${c}`, ['v', 'vt', ...carried]);
  return toScalarStream(carryOf(s), rel, undefined, 'number', undefined, s.of.kind === 'scalar' && s.of.productiveNull);
}

/**
 * unfold() a list value → its element or scalar stream. The JSONB array is exploded
 * with json_each (ordered by array position `.key`, preserving list order): an element
 * list → a fresh id-relation (a ElementStream the movement/tail dispatch re-enters, rejoining
 * nodes/edges downstream); a scalar list → a `v` ScalarStream carrying the value tag.
 * Mirrors compilePathArray's json_each idiom. Every exploded member retains the
 * list row's carried schema; global folds simply have an empty schema, while child
 * folds and record fields preserve their parent traverser identity through re-entry.
 */
export function compileUnfold(s: ListStream): ElementStream | ScalarStream | ListStream {
  const c = carryOf(s);
  const p = s.rel.as('c');
  const explode = (col: string): Relation => s.q.cte(
    q`SELECT je.value AS ${col}${carryFrag(s.carried, p)} FROM ${p}, json_each(${p.c.list}) je ORDER BY je.key`,
    [col, ...carriedCols(s.carried)],
  );
  if (s.of.kind === 'elem') {
    const rel = explode('id');
    return { ...c, kind: 'elements', rel, elem: s.of.elem };
  }
  // A list-of-lists: each exploded element is itself a JSONB array → a ListStream row
  // of the inner shape (so a further unfold / Scope.local op re-enters the list phase).
  if (s.of.kind === 'list') {
    const rel = explode('list');
    return toListStream(c, rel, s.of.of);
  }
  const rel = explode('v');
  return toScalarStream(c, rel, s.of.as, 'value', undefined, s.of.productiveNull);
}

/** Build a per-row list CTE that PRESERVES the carried schema (origin/aliases). A
 *  per-element list (valueMap().select(Column.*)) carries an origin ordinal, so every
 *  per-row list op must thread it through or the stream-column contract breaks. */
function listCte(s: ListStream, c: Relation, listExpr: Expression, of: ListStream['of'], where: Expression = empty): ListStream {
  const rel = s.q.cte(q`SELECT ${listExpr} AS list${carryFrag(s.carried, c)} FROM ${c}${where}`, ['list', ...carriedCols(s.carried)]);
  return toListStream(carryOf(s), rel, of);
}

/** none(pred): keep each list where NO element satisfies pred (a per-list collection
 *  filter) — stays a list stream. (SQL null semantics: an eq(null)/neq(null) predicate
 *  won't match a null element, so those edge forms may differ from TinkerPop.) */
function listNoneFilter(s: ListStream, pred: any): ListStream {
  const c = s.rel.as('c');
  return listCte(s, c, c.c.list, s.of, q` WHERE NOT EXISTS (SELECT 1 FROM json_each(${c.c.list}) je WHERE ${predicateSql(q`je.value`, pred)})`);
}

/** The Scope.local collection transforms that keep a list a list (per-list, not a
 *  whole-stream reduction). Each rebuilds each row's list via a correlated json_each. */
const LIST_LOCAL_TX = new Set(['order', 'dedup', 'limit', 'skip', 'range', 'tail']);

/** Scalar string transforms that, on a list, apply to EACH element (Scope.local) —
 *  toUpper(local)/trim(local)/length(local)/… over a folded list. Reuse scalarTx per
 *  element (list.ts is the only per-element caller besides the scalar tail). reverse
 *  is NOT here: on a list it reverses element ORDER (listReverse), not each string. */
const STRING_LOCAL_TX = new Set(['toUpper', 'toLower', 'trim', 'lTrim', 'rTrim', 'asString', 'length', 'substring', 'replace', 'concat']);

/** A per-element string transform over a list value (Scope.local): rebuild each row's
 *  list applying scalarTx to every element, preserving position order. Null elements
 *  pass through (SQLite null propagation → the transformed element stays null). */
function listStringTransform(s: ListStream, step: PStep): ListStream {
  const c = s.rel.as('c');
  const elem = scalarTx(step.name, step.args ?? [], q`x.value`);
  if (!elem) throw new Error(`scalar transform ${step.name}() not supported`);
  const sub = q`(SELECT jsonb(COALESCE(json_group_array(${elem} ORDER BY x.key), json('[]'))) FROM json_each(${c.c.list}) x)`;
  return listCte(s, c, sub, s.of);
}

/** reverse() on a list value → reverse element order (json_each ordered by position
 *  DESC). Stays a list stream. */
function listReverse(s: ListStream): ListStream {
  const c = s.rel.as('c');
  const sub = q`(SELECT jsonb(COALESCE(json_group_array(x.value ORDER BY x.key DESC), json('[]'))) FROM json_each(${c.c.list}) x)`;
  return listCte(s, c, sub, s.of);
}

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
  return listCte(s, c, sub, s.of);
}

// ---------- set-op / list-algebra family ----------
//
// combine/intersect/difference/disjunct/product take a second list (the OPERAND) and
// an incoming list; conjoin joins the incoming list into a string; all/any filter the
// list by a predicate. Intersect/difference/disjunct return a SET (dedup); combine a
// List; product a List of pair-Lists; conjoin a String. Operands: a literal list or
// constant(c).fold() (a compile-time JSONB list) — a standalone-traversal operand
// (__.V()…fold()) defers (needs fresh-root sub-traversal compilation).

const SET_RESULT = new Set(['intersect', 'difference', 'disjunct']);
const jsGtype = (v: any): string => (typeof v === 'number' ? (Number.isInteger(v) ? 'Integer' : 'Double') : typeof v === 'string' ? 'String' : typeof v === 'boolean' ? 'Boolean' : 'Object');

/** Resolve a set-op operand argument to a JSONB list expression, raising TinkerPop's
 *  exact argument errors. Literal array / constant(c).fold() only; a standalone
 *  traversal operand defers. */
function operandList(arg: any, op: string, params: Record<string, any>): Expression {
  if (arg === null || arg === undefined) throw new Error(`Argument provided for ${op} step can't be null`);
  if (Array.isArray(arg)) return q`jsonb(${value(JSON.stringify(arg))})`;
  if (typeof arg === 'object' && 'nested' in arg) {
    const inner = stepChain(arg.nested, params);
    const last = inner[inner.length - 1];
    if (last?.name !== 'fold') {
      if (inner.length === 1 && inner[0].name === 'constant') {
        const c = inner[0].args[0];
        if (c === null || c === undefined) throw new Error(`traversal argument for ${op} step must yield an iterable type, not null`);
        throw new Error(`traversal argument for ${op} step must yield an iterable type, encountered ${jsGtype(c)}`);
      }
      throw new Error(`traversal argument for ${op} step must yield an iterable type, encountered a non-fold traversal`);
    }
    const pre = inner.slice(0, -1);
    if (pre.length === 1 && pre[0].name === 'constant') {
      const c = pre[0].args[0];
      return q`jsonb(${value(JSON.stringify([c ?? null]))})`;
    }
    // A standalone read traversal ending in fold() → its own scalar list. It is
    // independent of the incoming traverser (a fresh V()/E() root), so compile it as a
    // separate read and aggregate its `v` column into one JSONB list, embedded as a
    // scalar subquery. Only a scalar-list fold is supported (values/id/label → v col).
    const sub = compileRead(inner, params);
    if (sub.shape.kind === 'jsonbList')
      return q`(SELECT jsonb(list) FROM (${embedSql(sub)}))`;
    if (sub.shape.kind !== 'list' || sub.shape.elem !== 'scalar')
      throw new Error(`${op}() operand traversal must fold a scalar list (values/id/label), got ${sub.shape.kind === 'list' ? sub.shape.elem : sub.shape.kind}`);
    return q`(SELECT jsonb(COALESCE(json_group_array(v), json('[]'))) FROM (${embedSql(sub)}))`;
  }
  throw new Error(`${op} step can only take an array or an Iterable as an argument, encountered ${jsGtype(arg)}`);
}

/** Embed a fully-rendered Compiled (its own `with … select …`) as an Expression, so it
 *  can nest as a scalar subquery. The SQL has exactly one `?` per bind (every value is
 *  bound, never inlined), so splitting on `?` and re-interleaving `value()` tokens
 *  reconstructs the tree with its binds in order. */
function embedSql(c: Compiled): Expression {
  const parts = c.sql.split('?');
  let e: Expression = raw(parts[0]);
  for (let i = 0; i < c.binds.length; i++) e = q`${e}${value(c.binds[i])}${raw(parts[i + 1] ?? '')}`;
  return e;
}

/** Build the JSONB-list result of a set-op over the incoming list `self` and `op`. */
function setOpExpr(name: string, self: Expression, op: Expression): Expression {
  const se = q`json_each(${self})`, oe = q`json_each(${op})`;
  switch (name) {
    // combine = concatenation: self elements then op elements, order + dups + nulls kept.
    case 'combine':
      return q`(SELECT jsonb(COALESCE(json_group_array(value ORDER BY seg, ord), json('[]'))) FROM (SELECT je.value AS value, 0 AS seg, je.key AS ord FROM ${se} je UNION ALL SELECT je.value, 1, je.key FROM ${oe} je))`;
    // intersect = distinct self-elements also in op (null-safe membership via IS).
    case 'intersect':
      return q`(SELECT jsonb(COALESCE(json_group_array(value), json('[]'))) FROM (SELECT DISTINCT je.value AS value FROM ${se} je WHERE EXISTS (SELECT 1 FROM ${oe} o WHERE o.value IS je.value)))`;
    // difference = distinct self-elements NOT in op.
    case 'difference':
      return q`(SELECT jsonb(COALESCE(json_group_array(value), json('[]'))) FROM (SELECT DISTINCT je.value AS value FROM ${se} je WHERE NOT EXISTS (SELECT 1 FROM ${oe} o WHERE o.value IS je.value)))`;
    // disjunct = symmetric difference (in exactly one), deduped (UNION dedups nulls too).
    case 'disjunct':
      return q`(SELECT jsonb(COALESCE(json_group_array(value), json('[]'))) FROM (SELECT je.value AS value FROM ${se} je WHERE NOT EXISTS (SELECT 1 FROM ${oe} o WHERE o.value IS je.value) UNION SELECT o.value FROM ${oe} o WHERE NOT EXISTS (SELECT 1 FROM ${se} je WHERE je.value IS o.value)))`;
    // product = cartesian product → a list of [selfElem, opElem] pair-lists.
    case 'product':
      return q`(SELECT jsonb(COALESCE(json_group_array(jsonb(json_array(a.value, b.value)) ORDER BY a.key, b.key), json('[]'))) FROM ${q`json_each(${self})`} a, ${q`json_each(${op})`} b)`;
  }
  throw new Error(`set-op ${name}() not implemented`);
}

/** all(P)/any(P): keep the incoming list iff every / some element satisfies P (a list
 *  filter — the list itself passes through, like none()). `IS TRUE`/`IS NOT TRUE` make
 *  null elements fail a predicate (all([null,x]) drops); an eq/neq(null) predicate is
 *  null-aware so all([null,null], eq(null)) keeps. */
function listAllAny(s: ListStream, step: PStep): ListStream {
  const c = s.rel.as('c');
  const pred = step.args[0];
  const je = q`json_each(${c.c.list})`;
  const isNullEq = pred && typeof pred === 'object' && (pred.op === 'eq' || pred.op === 'neq') && (pred.value === null || pred.value === undefined);
  const elemPred = isNullEq ? (pred.op === 'eq' ? q`je.value IS NULL` : q`je.value IS NOT NULL`) : predicateSql(q`je.value`, pred);
  const keep = step.name === 'all'
    ? q`NOT EXISTS (SELECT 1 FROM ${je} je WHERE (${elemPred}) IS NOT TRUE)`
    : q`EXISTS (SELECT 1 FROM ${je} je WHERE (${elemPred}) IS TRUE)`;
  return listCte(s, c, c.c.list, s.of, q` WHERE ${keep}`);
}

/** The set-op family names that consume a list operand + retype the stream. */
const LIST_OPERAND_OPS = new Set(['combine', 'intersect', 'difference', 'disjunct', 'product']);

/**
 * The list arm of lowerSteps. A non-terminal fold always leaves a follower, so a
 * ListStream here is never terminal (a terminal fold stays the reducer path). unfold()
 * retypes and re-enters; Scope.local reductions/transforms reshape each list; the
 * set-op family reshapes the list (set/list/product) or reduces it (conjoin/all/any).
 */
export function compileFromList(s: ListStream, steps: PStep[], at: number): LoweringResult {
  const step = steps[at];
  if (step.name === 'unfold') return continueLowering(compileUnfold(s), at + 1);
  // none(pred): keep each list where NO element satisfies pred (a collection filter);
  // stays a list stream, so downstream continues.
  if (step.name === 'none') return continueLowering(listNoneFilter(s, step.args[0]), at + 1);
  // Scope.local collection transforms (order/dedup/limit/skip/range/tail) — reshape
  // each list and stay a ListStream, so downstream continues.
  if (LIST_LOCAL_TX.has(step.name) && isLocal(step))
    return continueLowering(listLocalTransform(s, step), at + 1);
  // reverse() on a list reverses element order (no Scope arg — reverse of a list is
  // always the whole collection).
  if (step.name === 'reverse')
    return continueLowering(listReverse(s), at + 1);
  // Scope.local per-element string transforms (toUpper/trim/length/…) over a list.
  if (STRING_LOCAL_TX.has(step.name)) {
    // A string op on a list WITHOUT Scope.local is invalid (a list is not a string) —
    // raise TinkerPop's exact message. WITH Scope.local it applies per element.
    if (!isLocal(step)) throw new Error(`The ${step.name}() step can only take string as argument`);
    return continueLowering(listStringTransform(s, step), at + 1);
  }
  // Scope.local per-list reducers (count/sum/min/max/mean) — reduce each list to a
  // scalar stream, so a trailing filter/transform/reducer continues normally.
  if (['count', 'sum', 'min', 'max', 'mean'].includes(step.name) && isLocal(step)) {
    return continueLowering(lowerListReducer(s, step.name), at + 1);
  }
  // all(P)/any(P): keep the list if every/some element satisfies P (list filter).
  if (step.name === 'all' || step.name === 'any')
    return continueLowering(listAllAny(s, step), at + 1);
  // conjoin(delim): join the incoming list into ONE string (nulls skipped), delimiter a
  // plain string arg → a scalar stream (so a trailing step composes; usually terminal).
  if (step.name === 'conjoin') {
    const c = s.rel.as('c');
    const delim = String(step.args[0] ?? '');
    const joined = q`(SELECT COALESCE(group_concat(value, ${value(delim)}), '') FROM (SELECT value FROM json_each(${c.c.list}) WHERE value IS NOT NULL ORDER BY key))`;
    const rel = s.q.cte(q`SELECT ${joined} AS v${carryFrag(s.carried, c)} FROM ${c}`, ['v', ...carriedCols(s.carried)]);
    return continueLowering(toScalarStream(carryOf(s), rel, undefined), at + 1);
  }
  // set-op family (combine/intersect/difference/disjunct/product) over a list operand.
  if (LIST_OPERAND_OPS.has(step.name)) {
    const c = s.rel.as('c');
    const op = operandList(step.args[0], step.name, s.params);
    const listExpr = setOpExpr(step.name, c.c.list, op);
    const terminal = at + 1 >= steps.length;
    // intersect/difference/disjunct return a Set: frame as a Set only when terminal.
    // With a follower (order(Scope.local)/unfold) the deduped content is treated as a
    // plain list (TinkerPop's order(local) on a set yields a List), matching the suite.
    if (SET_RESULT.has(step.name) && terminal)
      return continueLowering(toResultStream(s.q, q`SELECT json(${listExpr}) AS list FROM ${c}`, { kind: 'jsonbSet' }), at + 1);
    // product yields a list of pair-lists; the others keep the element shape.
    const of = step.name === 'product' ? { kind: 'list' as const, of: { kind: 'scalar' as const } } : s.of;
    return continueLowering(listCte(s, c, listExpr, of), at + 1);
  }
  throw new Error(`${step.name}() on a list value not yet supported`);
}

/** The single Column arg of a select() over a map, if any. */
const columnOf = (step: PStep): 'keys' | 'values' | undefined =>
  (step.args ?? []).map((a: any) => a && typeof a === 'object' && a.column).find((c: any) => c === 'keys' || c === 'values');

/**
 * The map arm of lowerSteps. A MapStream (stream.ts) is a `(mk, mv)` row relation
 * reached only when a follower consumes a group()/groupCount(). select(Column.values)/
 * select(Column.keys) aggregate one column into a single list value (mirroring how
 * fold() builds a list), which unfold()/framing then handles — so
 * group().select(Column.values).unfold() flows map→list→scalar. Map-unfold (→ Map.Entry)
 * and select(Column) with a trailing key defer with a clear message.
 */
export function compileFromMap(s: MapStream, steps: PStep[], at: number): LoweringResult {
  // Terminal is unreachable: a group() only retypes to a MapStream when a follower
  // exists (else it stays the row-folding groupBuffer path).
  if (at >= steps.length) throw new Error('a map value at end of chain should not be a MapStream');
  const step = steps[at];
  if (step.name === 'select') {
    const col = columnOf(step);
    if (!col) throw new Error('select() on a map value requires Column.keys or Column.values');
    const c = s.rel.as('c');
    // Column.values → all values as one list; Column.keys → all keys as one list.
    // COALESCE to '[]' so an empty map still yields one (empty) list, not NULL.
    const [srcCol, of, nested] = col === 'values'
      ? [c.c.mv, mapOfToListOf(s.valOf), s.valOf.kind === 'list']
      : [c.c.mk, mapOfToListOf(s.keyOf), s.keyOf.kind === 'list'];
    const item = nested ? q`json(${srcCol})` : srcCol;
    // A per-element map (valueMap: one map per input element, tagged by an origin ordinal)
    // aggregates one list PER origin; a single global group map has no origin → one list.
    const origins = s.carried.origins;
    if (origins.length) {
      const rel = s.q.cte(
        q`SELECT jsonb(COALESCE(json_group_array(${item}), json('[]'))) AS list${carryFrag(s.carried, c)} FROM ${c} GROUP BY ${list(origins.map((o) => c.c[o]), ', ')}`,
        ['list', ...carriedCols(s.carried)],
      );
      return continueLowering(toListStream(carryOf(s), rel, of), at + 1);
    }
    const rel = s.q.cte(q`SELECT jsonb(COALESCE(json_group_array(${item}), json('[]'))) AS list FROM ${c}`, ['list']);
    return continueLowering(toListStream(carryOf(s), rel, of), at + 1);
  }
  throw new Error(`${step.name}() on a map value not yet supported`);
}
