// ---------- list-value tail: unfold + the list arm of the dispatcher ----------
//
// A ListStream (stream.ts) is a single list value in a one-row relation with a JSONB
// `list` column. This module explodes it (unfold) and routes the list phase of the
// re-enterable tail (compileFromList). The producers live in projection.ts (compileFold)
// and, later, inject-of-a-list / select(Column.values).

import { q, value, raw, list, empty, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { predicateSql, scalarTx, compareKey, inferVtypeSql } from '../../plan/plan.ts';
import { isColumnArg, isNested, stepChain } from '../../../gremlin/frontend.ts';
import { type IRStep } from '../../ir/strategies.ts';
import { loweringStateOf, continueLowering, dispatchShapeTail, toListStream, toMapEntryStream, toMapStream, toPropertyStream, toResultStream, toScalarStream, mapOfToListOf, PROPERTY_PAYLOAD, type ListStream, type LoweringResult, type MapEntryStream, type MapOf, type PropertyStream, type ScalarStream, type MapStream, type ShapeTailFn } from '../context/stream.ts';
import { layoutProjection, layoutCols, type ElementStream } from '../context/context.ts';
import { PER_ROW, STATIC, type Compiled, type ListOf, type ValueType } from '../../../sql/kernel/render.ts';
import { engineOf, type Engine } from '../../engine/deps.ts';
import { firstOf, globalRowOps, lowerGlobalCount } from './barrier.ts';
import { assertsGType, classifyBy, collectionAssert } from './child-shape.ts';
import { isLocalScope, REDUCERS } from '../../ir/step.ts';

/** Does this step carry a Scope.local token (the per-list, not whole-stream, form)? */
const isLocal = isLocalScope;

// ---------- the member seam: one encoding decision, read in one place ----------
//
// A list's members ride in ONE of two physical encodings, uniformly per list (the
// uniformity is the whole point — see the dead end in
// docs/archive/2026-07-25-type-channel-unification.md, where mixing them within a list broke the
// typed readers):
//
//   bare      — the member IS the SQL value. Correct exactly when the SQLite storage class
//               already determines the Gremlin type (string/int/long/double: what
//               plan.ts inferVtypeSql can recover), so carrying a type would be redundant.
//   typed     — the member is a self-describing {t,v} node. Required when the storage class
//               is lossy (datetime/uuid/bigint/bigdecimal/char/duration/boolean/byte/…).
//
// `isTyped` is the single predicate; `memberValue`/`memberNode` are the only two ways to
// read a member. A transform that COMPARES or FILTERS reads the payload (memberValue —
// ORDER BY over a raw `{"t":"int","v":5}` would string-order JSON); a transform that
// REBUILDS the list writes back the whole member (memberNode) so the envelope survives.
// Every op below goes through these, which is what lets a typed list flow through the
// same code as an untyped one instead of failing closed.

const isTyped = (of: ListOf): boolean => of.kind === 'scalar' && !!of.typed;

/** The comparable/filterable PAYLOAD of a member — the underlying SQL value in both
 *  encodings. Use for ORDER BY, predicates, DISTINCT, numeric aggregates.
 *
 *  A `typed` list is self-describing IF the producer wrapped it: a fold whose members are
 *  all storage-class-determined stays BARE (barrier.ts foldMember), uniformly per list. So
 *  unwrap conditionally, discriminating on json_each's own `type` column — an envelope is
 *  the only 'object' member. (NOT json_type() on the value: json_each already EXTRACTED it,
 *  so a bare string is no longer valid JSON text and json_type() errors on it.) A stored
 *  typed collection is always wrapped, so the CASE only bites for computed lists. */
const memberValue = (of: ListOf, member: Expression = q`je.value`, type: Expression = q`je.type`): Expression =>
  isTyped(of)
    ? q`CASE WHEN ${type}='object' THEN ${member} ->> '$.v' ELSE ${member} END`
    : member;

/** The whole member as it must be written back into a rebuilt list — the {t,v} node for a
 *  typed list (so the element keeps its exact type), the bare value otherwise. Wrapped in
 *  `json()` when typed so json_group_array EMBEDS the object instead of re-encoding it as a
 *  JSON string (double-encoding is the corruption the old fail-closed guard existed to
 *  prevent; here it is simply handled). */
const memberNode = (of: ListOf, member: Expression = q`je.value`, type: Expression = q`je.type`): Expression =>
  isTyped(of)
    ? q`CASE WHEN ${type}='object' THEN json(${member}) ELSE ${member} END`
    : member;

/** Retype a list whose members a transform has REWRITTEN (a per-element string transform):
 *  the stored types no longer describe the new values, so the result is a bare list tagged
 *  by whatever the transform statically produces. Mirrors the scalar tail's retype rule. */
const retypedList = (of: ListOf, as?: ValueType): ListOf =>
  of.kind === 'scalar' ? { kind: 'scalar', as, productiveNull: of.productiveNull } : of;

/** A Scope.local reducer over a list value: reduce EACH list (row) to one scalar via a
 *  correlated json_each aggregate. count() counts elements (any list); sum/min/max/mean
 *  reduce the numeric elements (non-numeric filtered out, matching the global reducers).
 *  Terminal — a trailing step defers. */
function lowerListReducer(s: ListStream, name: string): ScalarStream {
  const c = s.rel.as('c');
  // Each list row reduces to one scalar, so the row's carried schema (as() alias
  // history, path, …) rides through unchanged — one reduced value per original
  // traverser. So `as("v")…map(...).sum(Scope.local).as("s")` keeps "v".
  const carry = layoutProjection(s.traverserLayout, c);
  const cols = layoutCols(s.traverserLayout);
  if (name === 'count') {
    const rel = s.q.cte(q`SELECT (SELECT COUNT(*) FROM json_each(${c.c.list}) je) AS v${carry} FROM ${c}`, ['v', ...cols]);
    return toScalarStream(loweringStateOf(s), rel, 'long', { result: 'count' });
  }
  // A stored typed list carries {t,v} nodes; extract each element's payload (`->> '$.v'`)
  // so the numeric typeof guard sees the underlying value (an INTEGER/REAL/TEXT), not the
  // JSON object. A computed (untyped) list holds bare scalars — read je.value directly.
  const elem = memberValue(s.of);
  // Numeric aggregate over the list's numeric elements (typeof guard mirrors wrapReducer);
  // min/max also range over text (TinkerPop 4 Strings are Comparable), sum/mean stay numeric.
  const types = (name === 'min' || name === 'max') ? "('integer', 'real', 'text')" : "('integer', 'real')";
  const agg = (fn: string): Expression => q`(SELECT ${fn}(${elem}) FROM json_each(${c.c.list}) je WHERE typeof(${elem}) in ${types})`;
  if (name === 'mean') {
    const rel = s.q.cte(q`SELECT ${agg('AVG')} AS v, 'real' AS vt${carry} FROM ${c}`, ['v', 'vt', ...cols]);
    return toScalarStream(loweringStateOf(s), rel, undefined, { result: 'number', productiveNull: s.of.kind === 'scalar' && s.of.productiveNull });
  }
  const fn = name === 'sum' ? 'SUM' : name === 'min' ? 'MIN' : 'MAX';
  const rel = s.q.cte(q`SELECT ${agg(fn)} AS v, typeof(${agg(fn)}) AS vt${carry} FROM ${c}`, ['v', 'vt', ...cols]);
  return toScalarStream(loweringStateOf(s), rel, undefined, { result: 'number', productiveNull: s.of.kind === 'scalar' && s.of.productiveNull });
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
export function compileUnfold(s: ListStream): ElementStream | PropertyStream | ScalarStream | ListStream {
  const c = loweringStateOf(s);
  const p = s.rel.as('c');
  const explode = (col: string): Relation => s.q.cte(
    q`SELECT je.value AS ${col}${layoutProjection(s.traverserLayout, p)} FROM ${p}, json_each(${p.c.list}) je ORDER BY je.key`,
    [col, ...layoutCols(s.traverserLayout)],
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
  if (s.of.kind === 'property') {
    const cols = list(PROPERTY_PAYLOAD.map((col) => q`json_extract(je.value, ${value(`$.${col}`)}) AS ${col}`), ', ');
    const rel = s.q.cte(
      q`SELECT ${cols}${layoutProjection(s.traverserLayout, p)} FROM ${p}, json_each(${p.c.list}) je ORDER BY je.key`,
      [...PROPERTY_PAYLOAD, ...layoutCols(s.traverserLayout)],
    );
    return toPropertyStream(c, rel, s.of.elem);
  }
  // A stored TYPED list (of.typed): each element is a self-describing {t,v} node. Explode
  // extracting the payload (`->> '$.v'`) AND the per-element type (`->> '$.t'`) into a
  // vtype-carrying ScalarStream — reusing the P1–P3 typed-scalar spine, so each element
  // frames by its own type (a nested list/map element frames whole via frameStoredValue).
  if (s.of.kind === 'scalar' && s.of.typed) {
    // A bare member (a fold the producer left unwrapped because storage class suffices)
    // recovers its type the same way the write channel would have recorded it.
    const val = memberValue(s.of);
    const vt = q`CASE WHEN je.type='object' THEN je.value ->> '$.t' ELSE ${inferVtypeSql(q`je.value`)} END`;
    const rel = s.q.cte(
      q`SELECT ${val} AS v, ${vt} AS vtype${layoutProjection(s.traverserLayout, p)} FROM ${p}, json_each(${p.c.list}) je ORDER BY je.key`,
      ['v', 'vtype', ...layoutCols(s.traverserLayout)],
    );
    return toScalarStream(c, rel, undefined, { type: PER_ROW('vtype'), result: 'value' });
  }
  const rel = explode('v');
  return toScalarStream(c, rel, s.of.as, { result: 'value', productiveNull: s.of.productiveNull });
}

/** Build a per-row list CTE that PRESERVES the carried schema (origin/aliases). A
 *  per-element list (valueMap().select(Column.*)) carries an origin ordinal, so every
 *  per-row list op must thread it through or the stream-column contract breaks. */
function listCte(s: ListStream, c: Relation, listExpr: Expression, of: ListStream['of'], where: Expression = empty): ListStream {
  const rel = s.q.cte(q`SELECT ${listExpr} AS list${layoutProjection(s.traverserLayout, c)} FROM ${c}${where}`, ['list', ...layoutCols(s.traverserLayout)]);
  return toListStream(loweringStateOf(s), rel, of);
}

/** none(pred): keep each list where NO element satisfies pred (a per-list collection
 *  filter) — stays a list stream. (SQL null semantics: an eq(null)/neq(null) predicate
 *  won't match a null element, so those edge forms may differ from TinkerPop.) */
function listNoneFilter(s: ListStream, pred: any): ListStream {
  const c = s.rel.as('c');
  // A whole-list filter: the list passes through byte-identical, so only the payload
  // read has to know the encoding.
  return listCte(s, c, c.c.list, s.of, q` WHERE NOT EXISTS (SELECT 1 FROM json_each(${c.c.list}) je WHERE ${predicateSql(memberValue(s.of), pred)})`);
}

/** The Scope.local collection transforms that keep a list a list (per-list, not a
 *  whole-stream reduction). Each rebuilds each row's list via a correlated json_each. */
const LIST_LOCAL_TX = new Set(['order', 'dedup', 'limit', 'skip', 'range', 'tail']);

/** The shared global row ops keyed by step name, so a LIST_LOCAL_TX name can compose with its
 *  shared twin instead of replacing it. */
const SHARED_ROW_OPS = new Map(globalRowOps<ListStream>());

/** Scalar string transforms that, on a list, apply to EACH element (Scope.local) —
 *  toUpper(local)/trim(local)/length(local)/… over a folded list. Reuse scalarTx per
 *  element (list.ts is the only per-element caller besides the scalar tail). reverse
 *  is NOT here: on a list it reverses element ORDER (listReverse), not each string. */
// `concat` is deliberately NOT here: TinkerPop ships no ConcatLocalStep, so `concat()` over a
// collection is invalid at every scope (`ConcatStep.map` rejects any non-String receiver outright)
// — it gets its own always-refusing entry below. Having it here made
// `g.inject(["a","b"],"c").concat("d")` answer ['ad','bd','cd'] where the spec demands a throw.
const STRING_LOCAL_TX = new Set(['toUpper', 'toLower', 'trim', 'lTrim', 'rTrim', 'asString', 'length', 'substring', 'replace']);

/** A per-element string transform over a list value (Scope.local): rebuild each row's
 *  list applying scalarTx to every element, preserving position order. Null elements
 *  pass through (SQLite null propagation → the transformed element stays null). */
function listStringTransform(s: ListStream, step: IRStep): ListStream {
  const c = s.rel.as('c');
  // The transform REWRITES each member, so it reads the payload and emits a BARE value —
  // the stored type no longer describes the result. length() yields an int, the rest
  // strings; either way the output list is bare and re-tagged, never a stale {t,v}.
  const elem = scalarTx(step.name, step.args ?? [], memberValue(s.of, q`x.value`, q`x.type`));
  if (!elem) throw new Error(`scalar transform ${step.name}() not supported`);
  const sub = q`(SELECT jsonb(COALESCE(json_group_array(${elem} ORDER BY x.key), json('[]'))) FROM json_each(${c.c.list}) x)`;
  // Untagged, NOT tagged 'string': a uniform tag would force a null member through the
  // string serializer (trim(local) over [.., null] must keep the null a null). The members
  // are bare, so per-value inference at the wire is the right channel.
  return listCte(s, c, sub, retypedList(s.of));
}

/** reverse() on a list value → reverse element order (json_each ordered by position
 *  DESC). Stays a list stream. */
function listReverse(s: ListStream): ListStream {
  const c = s.rel.as('c');
  // Pure reordering — members are written back whole (json(...) keeps a {t,v} node an
  // embedded object rather than re-encoding it as a JSON string).
  const sub = q`(SELECT jsonb(COALESCE(json_group_array(${memberNode(s.of, q`x.value`, q`x.type`)} ORDER BY x.key DESC), json('[]'))) FROM json_each(${c.c.list}) x)`;
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
function listLocalTransform(s: ListStream, step: IRStep): ListStream {
  const c = s.rel.as('c');
  const name = step.name;
  const nums = (step.args ?? []).filter((a: any) => typeof a === 'number') as number[];
  const je = q`json_each(${c.c.list})`;
  // Compare on the payload, carry the whole member. For a bare list these are the same
  // expression, so the untyped SQL is unchanged.
  const xVal = memberValue(s.of, q`x.value`, q`x.type`);
  const xNode = memberNode(s.of, q`x.value`, q`x.type`);
  // Every branch re-aggregates with `json_group_array(value ORDER BY ord)` so the final
  // list order is explicit (never relying on subquery-order-into-aggregate). COALESCE to
  // '[]' keeps an empty result a list, not NULL.
  // The inner `value` column carries the WHOLE member (already json()-wrapped for a typed
  // list by the callers below), so re-aggregation preserves each element's envelope.
  // The inner rows carry `value` AND (for a typed list) the json_each `type` beside it, so
  // re-aggregation can tell an envelope from a bare member and re-embed only the former.
  const rebuild = (rows: Expression): Expression =>
    q`(SELECT jsonb(COALESCE(json_group_array(${memberNode(s.of, raw('value'), raw('vtag'))} ORDER BY ord), json('[]'))) FROM (${rows}))`;
  /** The `type` passthrough a rebuild subquery must select for memberNode to read. */
  const tagCol = isTyped(s.of) ? q`, x.type AS vtag` : empty;
  let sub: Expression;
  if (name === 'order') {
    // Bare order(Scope.local) = ascending by element value. A direction-only
    // by(Order.desc/asc) flips it; a by(key)/by(traversal)/shuffle defers.
    let desc = false;
    for (const byArgs of step.modulators ?? []) {
      const by = classifyBy(byArgs);
      if (by.kind === 'key' || by.kind === 'nested')
        throw new Error('order(Scope.local).by(key/traversal) not yet supported');
      if (by.dir === 'shuffle') throw new Error('order(Scope.local) shuffle not yet supported');
      desc = by.dir === 'desc';
    }
    // Order by the PAYLOAD (ordering raw {t,v} JSON text would sort by the type name),
    // but emit the whole member so the element keeps its type.
    sub = q`(SELECT jsonb(COALESCE(json_group_array(${xNode} ORDER BY ${xVal} ${desc ? 'DESC' : 'ASC'}), json('[]'))) FROM ${je} x)`;
  } else if (name === 'dedup') {
    // First-occurrence order: group by the member, order by earliest position. Grouping on
    // the WHOLE member (payload + type for a typed list) is the same rule root dedup() uses
    // — equal values of different stored types are distinct Gremlin values (a long 5 and a
    // string '5' are two members), so the envelope belongs in the grouping key.
    sub = rebuild(q`SELECT x.value AS value${isTyped(s.of) ? q`, MIN(x.type) AS vtag` : empty}, MIN(x.key) AS ord FROM ${je} x GROUP BY x.value`);
  } else {
    // Positional subset (limit/skip/range/tail): pick rows by original position, then
    // re-aggregate in ascending position order. tail selects the LAST n via DESC LIMIT
    // (avoids a count() subquery that can't correlate two json_each levels deep).
    let lim = -1, off = 0, dir = 'ASC';
    if (name === 'limit') lim = nums[0];
    else if (name === 'skip') off = nums[0];
    else if (name === 'range') { off = nums[0]; lim = nums[1] < 0 ? -1 : nums[1] - nums[0]; }
    else if (name === 'tail') { lim = nums[0] ?? 1; dir = 'DESC'; }
    sub = rebuild(q`SELECT x.value AS value${tagCol}, x.key AS ord FROM ${je} x ORDER BY x.key ${dir} LIMIT ${lim} OFFSET ${off}`);
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

const SET_RESULT = new Set(['intersect', 'difference', 'disjunct', 'merge']);
const jsGtype = (v: any): string => (typeof v === 'number' ? (Number.isInteger(v) ? 'Integer' : 'Double') : typeof v === 'string' ? 'String' : typeof v === 'boolean' ? 'Boolean' : 'Object');

/** Resolve a set-op operand argument to a JSONB list expression, raising TinkerPop's
 *  exact argument errors. Literal array / constant(c).fold() only; a standalone
 *  traversal operand defers. */
function operandList(engine: Engine, arg: any, op: string, params: Record<string, any>): Expression {
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
    const folded = foldedListSubquery(engine, inner, params);
    if (!folded) throw new Error(`${op}() operand traversal must fold a scalar list (values/id/label)`);
    return folded;
  }
  throw new Error(`${op} step can only take an array or an Iterable as an argument, encountered ${jsGtype(arg)}`);
}

/** A standalone read traversal ending in `fold()` → its own scalar list, as a JSONB scalar
 *  subquery. It is independent of the incoming traverser (a fresh `V()`/`E()` root), so it
 *  compiles as a separate read and aggregates its `v` column into one list.
 *
 *  Shared by the set-op operands (above) and the PREDICATE operands (`within(__.V()…fold())`,
 *  operand.ts) — the same "a folded re-sourced read is a list value" fact, so the two cannot
 *  disagree about which traversals qualify. Returns null when the read is not a scalar list,
 *  leaving the caller to raise its own vocabulary-appropriate error. */
export function foldedListSubquery(engine: Engine, inner: IRStep[], params: Record<string, any>): Expression | null {
  const sub = engine.compileReadCompiled(inner, params);
  if (sub.shape.kind === 'jsonbList') return q`(SELECT jsonb(list) FROM (${embedSql(sub)}))`;
  if (sub.shape.kind !== 'list' || sub.shape.elem !== 'scalar') return null;
  return q`(SELECT jsonb(COALESCE(json_group_array(v), json('[]'))) FROM (${embedSql(sub)}))`;
}

/** Embed a fully-rendered Compiled (its own `with … select …`) as an Expression, so it
 *  can nest as a scalar subquery. The SQL has exactly one `?` per bind (every value is
 *  bound, never inlined), so splitting on `?` and re-interleaving `value()` tokens
 *  reconstructs the tree with its binds in order. */
export function embedSql(c: Compiled): Expression {
  const parts = c.sql.split('?');
  let e: Expression = raw(parts[0]);
  for (let i = 0; i < c.binds.length; i++) e = q`${e}${value(c.binds[i])}${raw(parts[i + 1] ?? '')}`;
  return e;
}

/** Build the JSONB-list result of a set-op over the incoming list `self` and `op`.
 *  `selfTyped` says the self side's members are {t,v} nodes: project them to their payloads
 *  first so both sides compare and emit in ONE vocabulary (the operand is always bare). */
function setOpExpr(name: string, self: Expression, op: Expression, selfTyped = false): Expression {
  // Project the self side down to payloads. Members may already be bare (a fold the producer
  // left unwrapped), so discriminate per member rather than unwrapping unconditionally —
  // a blind `->> '$.v'` would turn every bare member into NULL.
  const selfBare = selfTyped
    ? q`(SELECT jsonb(COALESCE(json_group_array(CASE WHEN je.type='object' THEN je.value ->> '$.v' ELSE je.value END ORDER BY je.key), json('[]'))) FROM json_each(${self}) je)`
    : self;
  const se = q`json_each(${selfBare})`, oe = q`json_each(${op})`;
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
      return q`(SELECT jsonb(COALESCE(json_group_array(jsonb(json_array(a.value, b.value)) ORDER BY a.key, b.key), json('[]'))) FROM ${q`json_each(${selfBare})`} a, ${q`json_each(${op})`} b)`;
    // merge = set union: every distinct element of self OR op (UNION dedups, nulls too).
    case 'merge':
      return q`(SELECT jsonb(COALESCE(json_group_array(value), json('[]'))) FROM (SELECT je.value AS value FROM ${se} je UNION SELECT o.value FROM ${oe} o))`;
  }
  throw new Error(`set-op ${name}() not implemented`);
}

/** all(P)/any(P): keep the incoming list iff every / some element satisfies P (a list
 *  filter — the list itself passes through, like none()). `IS TRUE`/`IS NOT TRUE` make
 *  null elements fail a predicate (all([null,x]) drops); an eq/neq(null) predicate is
 *  null-aware so all([null,null], eq(null)) keeps. */
function listAllAny(s: ListStream, step: IRStep): ListStream {
  const c = s.rel.as('c');
  const pred = step.args[0];
  const je = q`json_each(${c.c.list})`;
  const val = memberValue(s.of);
  const isNullEq = pred && typeof pred === 'object' && (pred.op === 'eq' || pred.op === 'neq') && (pred.value === null || pred.value === undefined);
  const elemPred = isNullEq ? (pred.op === 'eq' ? q`${val} IS NULL` : q`${val} IS NOT NULL`) : predicateSql(val, pred);
  const keep = step.name === 'all'
    ? q`NOT EXISTS (SELECT 1 FROM ${je} je WHERE (${elemPred}) IS NOT TRUE)`
    : q`EXISTS (SELECT 1 FROM ${je} je WHERE (${elemPred}) IS TRUE)`;
  return listCte(s, c, c.c.list, s.of, q` WHERE ${keep}`);
}

/** The set-op family names that consume a list operand + retype the stream. */
const LIST_OPERAND_OPS = new Set(['combine', 'intersect', 'difference', 'disjunct', 'product', 'merge']);

/**
 * The list arm of lowerSteps. A non-terminal fold always leaves a follower, so a
 * ListStream here is never terminal (a terminal fold stays the reducer path). unfold()
 * retypes and re-enters; Scope.local reductions/transforms reshape each list; the
 * set-op family reshapes the list (set/list/product) or reduces it (conjoin/all/any).
 */
const LIST_REDUCERS = REDUCERS;

// Scope.local collection transforms (order/dedup/limit/skip/range/tail) — reshape each
// list and stay a ListStream. Without Scope.local it isn't this step → fall to default.
const listLocalTx: ShapeTailFn<ListStream> = (s, step, _steps, at) =>
  isLocal(step) ? continueLowering(listLocalTransform(s, step), at + 1) : null;

// Scope.local per-element string transforms (toUpper/trim/length/…) over a list. A string
// op on a list WITHOUT Scope.local is invalid (a list is not a string) — raise
// TinkerPop's exact message; WITH Scope.local it applies per element.
const listStringTx: ShapeTailFn<ListStream> = (s, step, _steps, at) => {
  if (!isLocal(step)) throw new Error(`The ${step.name}() step can only take string as argument`);
  return continueLowering(listStringTransform(s, step), at + 1);
};

/**
 * Steps whose input contract EXCLUDES a collection at every scope — so a list receiver is a
 * permanent type error, not a capability we have yet to build. Messages are the reference step
 * classes' own (`ConcatStep:74`, `SplitGlobalStep:53`, `AsBoolStep:53`, `AsDateStep:76`,
 * `AsNumberStep:71`), which is what the corpus asserts.
 *
 * The sibling family — `trim`/`toUpper`/`length`/… — is NOT here, because those DO have a
 * `Scope.local` form that maps over the members; `listStringTx` refuses only their global spelling.
 * The line between the two tables is exactly "does TinkerPop ship a `…LocalStep` for it".
 *
 * Two deliberate wording divergences, both one scenario each and both a refusal to state something
 * untrue: the reference names the JVM CLASS of the offending value (`ArrayList`), and we say `list`.
 * That is the observable contract for `Can't parse type ArrayList as number.`, which we therefore do
 * not satisfy — a JVM implementation detail reaching into a language-level assertion.
 */
const LIST_INPUT_REFUSALS: ReadonlyMap<string, string> = new Map([
  ['concat', 'String concat() can only take string as argument, encountered a list'],
  ['split', 'The split() step can only take string as argument, encountered a list'],
  ['asBool', "Can't parse a list as Boolean."],
  ['asDate', "Can't parse a list as OffsetDateTime."],
  ['asNumber', "Can't parse type list as number."],
]);

// Scope.local per-list reducers (count/sum/min/max/mean) — reduce each list to a scalar
// stream, so a trailing filter/transform/reducer continues normally.
const listReducer: ShapeTailFn<ListStream> = (s, step, _steps, at) =>
  isLocal(step) ? continueLowering(lowerListReducer(s, step.name), at + 1) : null;

// count() on a list stream: Scope.local is the per-list LENGTH (listReducer); the GLOBAL form
// counts the list TRAVERSERS (one per fold/aggregate result) via the shared relational barrier —
// so values().fold().count() / is(typeOf(LIST)).count() report 1, not "count() on a list value".
const listCount: ShapeTailFn<ListStream> = (s, step, _steps, at) =>
  isLocal(step) ? continueLowering(lowerListReducer(s, 'count'), at + 1)
                : continueLowering(lowerGlobalCount(s), at + 1);

// is(typeOf(LIST|SET)) on a list value is an identity type-assert — a list IS a list (a set IS a
// set) — so pass the stream through unchanged, matching is(typeOf(MAP)) on a MapStream. The
// stream's own `set` marker decides which token matches; a non-matching token / any other is()
// predicate would filter to empty and has no worked-out list form yet, so it defers (fail closed).
const listIs: ShapeTailFn<ListStream> = (s, step, _steps, at) => {
  const kind = collectionAssert(step);
  if ((kind === 'list' && !s.set) || (kind === 'set' && s.set)) return continueLowering(s, at + 1);
  return null;
};

// conjoin(delim): join the incoming list into ONE string (nulls skipped), delimiter a
// plain string arg → a scalar stream (so a trailing step composes; usually terminal).
const listConjoin: ShapeTailFn<ListStream> = (s, step, _steps, at) => {
  const c = s.rel.as('c');
  const delim = String(step.args[0] ?? '');
  // Joins the PAYLOADS into one string — the result is a string whatever the members were.
  const memberVal = memberValue(s.of, raw('value'), raw('type'));
  const joined = q`(SELECT COALESCE(group_concat(mv, ${value(delim)}), '') FROM (SELECT ${memberVal} AS mv FROM json_each(${c.c.list}) WHERE ${memberVal} IS NOT NULL ORDER BY key))`;
  const rel = s.q.cte(q`SELECT ${joined} AS v${layoutProjection(s.traverserLayout, c)} FROM ${c}`, ['v', ...layoutCols(s.traverserLayout)]);
  return continueLowering(toScalarStream(loweringStateOf(s), rel, undefined, { type: STATIC('string') }), at + 1);
};

// set-op family (combine/intersect/difference/disjunct/product) over a list operand.
const listSetOp: ShapeTailFn<ListStream> = (s, step, steps, at) => {
  const c = s.rel.as('c');
  const op = operandList(engineOf(s), step.args[0], step.name, s.params);
  // A typed incoming list meets a BARE operand (a literal array / constant().fold()), so the
  // two sides' encodings differ. Comparing and emitting on the payload puts both sides in
  // one vocabulary; the result is therefore a bare list, uniformly (mixing a typed member
  // with a bare operand member inside one list is precisely the corruption to avoid).
  const listExpr = setOpExpr(step.name, c.c.list, op, isTyped(s.of));
  const terminal = at + 1 >= steps.length;
  // intersect/difference/disjunct return a Set: frame as a Set only when terminal. With a
  // follower (order(Scope.local)/unfold) the deduped content is treated as a plain list
  // (TinkerPop's order(local) on a set yields a List), matching the suite.
  if (SET_RESULT.has(step.name) && terminal)
    return continueLowering(toResultStream(s.q, q`SELECT json(${listExpr}) AS list FROM ${c}`, { kind: 'jsonbSet' }), at + 1);
  // product yields a list of pair-lists; the others keep the element shape — but a typed
  // list that met a bare operand has been flattened to payloads, so it is bare now.
  const of = step.name === 'product' ? { kind: 'list' as const, of: { kind: 'scalar' as const } }
    : isTyped(s.of) ? retypedList(s.of) : s.of;
  return continueLowering(listCte(s, c, listExpr, of), at + 1);
};

const LIST_DISPATCH = new Map<string, ShapeTailFn<ListStream>>([
  ['unfold', (s, _step, _steps, at) => continueLowering(compileUnfold(s), at + 1)],
  // none(pred): keep each list where NO element satisfies pred (a collection filter).
  ['none', (s, step, _steps, at) => continueLowering(listNoneFilter(s, step.args[0]), at + 1)],
  // reverse() reverses element order (no Scope arg — reverse of a list is the whole list).
  ['reverse', (s, _step, _steps, at) => continueLowering(listReverse(s), at + 1)],
  // all(P)/any(P): keep the list if every/some element satisfies P (list filter).
  ['all', (s, step, _steps, at) => continueLowering(listAllAny(s, step), at + 1)],
  ['any', (s, step, _steps, at) => continueLowering(listAllAny(s, step), at + 1)],
  ['conjoin', listConjoin],
  // Every LIST_LOCAL_TX name is ALSO a shared global row op, so the two must COMPOSE rather than
  // one shadowing the other: the shared op runs first and declines a Scope.local step, leaving
  // `listLocalTx` to slice MEMBERS. Spreading both into the Map instead let the later entry win and
  // stopped 42 corpus traversals executing — see `firstOf`. `order`/`tail` have no shared form, so
  // they stay `listLocalTx` alone.
  ...[...LIST_LOCAL_TX].map((n): [string, ShapeTailFn<ListStream>] => {
    const shared = SHARED_ROW_OPS.get(n);
    return [n, shared ? firstOf(shared, listLocalTx) : listLocalTx];
  }),
  ...[...STRING_LOCAL_TX].map((n): [string, ShapeTailFn<ListStream>] => [n, listStringTx]),
  ...[...LIST_INPUT_REFUSALS].map(([n, message]): [string, ShapeTailFn<ListStream>] => [n, (_s, step) => {
    // `split(Scope.local)` IS a reference step (SplitLocalStep) we have simply not built — so its
    // local spelling keeps the ordinary deferral (decline → fallback) rather than borrowing the
    // global form's permanent type error. Every other name here has no local form at all.
    if (n === 'split' && isLocal(step)) return null;
    throw new Error(message);
  }]),
  ...[...LIST_REDUCERS].map((n): [string, ShapeTailFn<ListStream>] => [n, listReducer]),
  ...[...LIST_OPERAND_OPS].map((n): [string, ShapeTailFn<ListStream>] => [n, listSetOp]),
  // Overrides the LIST_REDUCERS 'count' entry above (Map keeps the last) so a GLOBAL count()
  // counts list traversers instead of falling through to the "not yet supported" throw.
  ['count', listCount],
  ['is', listIs],
]);

export function compileFromList(s: ListStream, steps: IRStep[], at: number): LoweringResult {
  return dispatchShapeTail(LIST_DISPATCH, s, steps, at, () => {
    throw new Error(`${steps[at].name}() on a list value not yet supported`);
  });
}

/** The single Column arg of a select() over a map, if any. */
const columnOf = (step: IRStep): 'keys' | 'values' | undefined =>
  (step.args ?? []).map((a: any) => a && typeof a === 'object' && a.column).find((c: any) => c === 'keys' || c === 'values');

/** order(Scope.local).by(Column.keys|values [, Order]) over a map value — the ONE by()
 *  modulator being a single Column term (± direction). Returns {col, dir} or null (any
 *  other order shape — bare, by(key), by(traversal), multi-term — is not a map-local
 *  Column order and defers). Shared by compileFromMap and compileFromGroup (via the
 *  re-exported isMapLocalOrder) so group/groupCount/valueMap/elementMap/stored maps all
 *  route one implementation. */
export function mapLocalOrder(step: IRStep): { col: 'keys' | 'values'; dir: 'asc' | 'desc' } | null {
  if (step.name !== 'order' || !isLocal(step)) return null;
  const bys = step.modulators ?? [];
  if (bys.length !== 1) return null;
  const byArgs = bys[0];
  const col = byArgs.filter(isColumnArg).map((a) => a.column).find((c) => c === 'keys' || c === 'values') as 'keys' | 'values' | undefined;
  if (!col) return null;
  const { dir } = classifyBy(byArgs); // the shared triage owns the direction scan
  if (dir === 'shuffle') return null; // shuffle-local over a map defers (no worked-out form)
  return { col, dir: dir === 'desc' ? 'desc' : 'asc' };
}
export const isMapLocalOrder = (step: IRStep): boolean => mapLocalOrder(step) !== null;

/** map(__.select(Column)) over a Map.Entry is the 1-to-1 form of a per-entry column
 *  select — unwrap its single-step body to that select() step (else null → deferral). */
function mapOfSelect(step: IRStep, params: Record<string, any>): IRStep | null {
  if (step.name !== 'map') return null;
  const arg = (step.args ?? [])[0];
  if (!isNested(arg)) return null; // the guard narrows, so `.nested` below is rename-safe
  const body = stepChain(arg.nested, params);
  return body.length === 1 && body[0].name === 'select' && columnOf(body[0]) ? body[0] : null;
}

/** Is this an is(typeOf(GType.MAP)) identity assert? (A map value IS a map.) */
const isMapTypeOf = (step: IRStep): boolean => assertsGType(step, 'MAP');

/** Extract one side (key=$[0] / value=$[1]) of a blob pair `je.value`. A scalar side is a
 *  {t,v} node kept as JSON (`->`, framed via frameTypedNode); an element side is a bare rowid
 *  (`->>`, rejoined downstream); a list side is a JSON array kept as JSON. */
const pairSide = (pair: Expression, idx: 0 | 1, of: MapOf): Expression =>
  of.kind === 'elem' ? q`${pair} ->> ${raw(`'$[${idx}]'`)}` : q`${pair} -> ${raw(`'$[${idx}]'`)}`;

/**
 * The map arm of lowerSteps. A MapStream is a whole-map VALUE per row (a JSONB `map` blob of
 * ordered [[keyNode,valNode],…] pairs). is(typeOf(MAP)) is identity; count(Scope.local) is the
 * entry count; select(Column.keys/values) aggregates one side into a list VALUE; unfold()
 * explodes the pairs into a per-entry MapEntryStream; a bare terminal frames each blob as a
 * whole MAP (materializeMapRoot). fold()/where and richer followers defer with a clear message.
 */
const MAP_DISPATCH = new Map<string, ShapeTailFn<MapStream>>([
  // is(typeOf(MAP)) — a map IS a map → identity. Any other is() predicate declines.
  ['is', (s, step, _steps, at) => isMapTypeOf(step) ? continueLowering(s, at + 1) : null],
  // order(Scope.local).by(Column.keys|values [, Order]) — re-sort the pairs array of THIS
  // whole-map blob by one side, in place. A scalar side sorts type-correctly via compareKey
  // (numeric values numerically, strings lexically); an element/list value side has no
  // total order → defer. The result is another MapStream (ordering is a same-shape blob
  // transform); a following unfold() then emits entries in the new order.
  ['order', (s, step, _steps, at) => {
    const localOrder = mapLocalOrder(step);
    if (!localOrder) return null;
    const c = s.rel.as('c');
    const of = localOrder.col === 'values' ? s.valOf : s.keyOf;
    if (of.kind !== 'scalar')
      throw new Error(`order(Scope.local).by(Column.${localOrder.col}) over an element/list map ${localOrder.col === 'values' ? 'value' : 'key'} not yet supported`);
    const idx = localOrder.col === 'values' ? 1 : 0;
    const side = q`je.value -> ${raw(`'$[${idx}]'`)}`; // the {t,v} node on that side
    const sortKey = compareKey(q`${side} ->> '$.v'`, q`${side} ->> '$.t'`);
    const dir = raw(localOrder.dir === 'desc' ? 'DESC' : 'ASC');
    const rel = s.q.cte(
      q`SELECT jsonb(COALESCE((SELECT json_group_array(je.value ORDER BY ${sortKey} ${dir}, je.key) FROM json_each(json(${c.c.map})) je), json('[]'))) AS map${layoutProjection(s.traverserLayout, c)} FROM ${c}`,
      ['map', ...layoutCols(s.traverserLayout)],
    );
    return continueLowering(toMapStream(loweringStateOf(s), rel, s.keyOf, s.valOf), at + 1);
  }],
  // count(Scope.local) → number of entries (map size). A GLOBAL count over a map stream is a
  // different question and declines to the fallback.
  ['count', (s, step, _steps, at) => {
    if (!isLocal(step)) return null;
    const c = s.rel.as('c');
    const rel = s.q.cte(q`SELECT json_array_length(json(${c.c.map})) AS v${layoutProjection(s.traverserLayout, c)} FROM ${c}`, ['v', ...layoutCols(s.traverserLayout)]);
    return continueLowering(toScalarStream(loweringStateOf(s), rel, 'long', { result: 'count' }), at + 1);
  }],
  // unfold() → a per-entry Map.Entry stream (explode the pairs; each side extracted per its shape).
  ['unfold', (s, _step, _steps, at) => {
    const c = s.rel.as('c');
    const je = q`json_each(json(${c.c.map})) je`;
    const rel = s.q.cte(
      q`SELECT ${pairSide(q`je.value`, 0, s.keyOf)} AS mk, ${pairSide(q`je.value`, 1, s.valOf)} AS mv${layoutProjection(s.traverserLayout, c)} FROM ${c}, ${je} ORDER BY je.key`,
      ['mk', 'mv', ...layoutCols(s.traverserLayout)],
    );
    return continueLowering(toMapEntryStream(loweringStateOf(s), rel, s.keyOf, s.valOf), at + 1);
  }],
  // select(Column.keys/values) → aggregate one side of every entry into a single list VALUE.
  ['select', (s, step, _steps, at) => {
    const col = columnOf(step);
    if (!col) throw new Error('select() on a map value requires Column.keys or Column.values');
    const c = s.rel.as('c');
    const [idx, of] = col === 'values' ? [1 as const, s.valOf] : [0 as const, s.keyOf];
    const side = pairSide(q`je.value`, idx, of);
    const rel = s.q.cte(
      q`SELECT jsonb(COALESCE((SELECT json_group_array(${side} ORDER BY je.key) FROM json_each(json(${c.c.map})) je), json('[]'))) AS list${layoutProjection(s.traverserLayout, c)} FROM ${c}`,
      ['list', ...layoutCols(s.traverserLayout)],
    );
    return continueLowering(toListStream(loweringStateOf(s), rel, mapOfToListOf(of)), at + 1);
  }],
]);

export function compileFromMap(s: MapStream, steps: IRStep[], at: number): LoweringResult {
  if (at >= steps.length) throw new Error('a map value at end of chain should not be a MapStream');
  return dispatchShapeTail(MAP_DISPATCH, s, steps, at, (_s, ss, i) => {
    throw new Error(`${ss[i].name}() on a map value not yet supported`);
  });
}

/**
 * The Map.Entry arm of lowerSteps — a `(mk, mv)` row relation unfold() produced from a
 * MapStream. select(Column.keys/values) (or its 1-to-1 map(__.select(…)) form) projects THIS
 * entry's key/value per row; a bare terminal frames each entry as a size-1 MAP.
 */
/** Project THIS entry's key or value per row, from an already-recognized select(Column) step —
 *  reached either directly or through its 1-to-1 `map(__.select(Column))` form. */
function mapEntryColumn(s: MapEntryStream, sel: IRStep, at: number): LoweringResult {
  const col = columnOf(sel);
  if (!col) throw new Error('select() on a map entry requires Column.keys or Column.values');
  const c = s.rel.as('c');
  const [src, of] = col === 'values' ? [c.c.mv, s.valOf] : [c.c.mk, s.keyOf];
  if (of.kind === 'elem') throw new Error('select(Column) of an element key/value on unfolded entries not yet supported');
  if (of.kind === 'list')
    return continueLowering(toListStream(loweringStateOf(s), s.q.cte(q`SELECT json(${src}) AS list${layoutProjection(s.traverserLayout, c)} FROM ${c}`, ['list', ...layoutCols(s.traverserLayout)]), of.of), at + 1);
  // A typed {t,v} scalar side → a typed single-value list is wrong; re-enter as a typed scalar
  // stream (each entry's key/value, its own type via the vtype carried in the {t,v} node).
  const rel = s.q.cte(q`SELECT ${src} ->> '$.v' AS v, ${src} ->> '$.t' AS vtype${layoutProjection(s.traverserLayout, c)} FROM ${c}`, ['v', 'vtype', ...layoutCols(s.traverserLayout)]);
  return continueLowering(toScalarStream(loweringStateOf(s), rel, undefined, { result: 'value', type: PER_ROW('vtype') }), at + 1);
}

const MAP_ENTRY_DISPATCH = new Map<string, ShapeTailFn<MapEntryStream>>([
  // One row per Map.Entry, so the shared row ops and the shared global count all apply directly.
  ...globalRowOps<MapEntryStream>(),
  ['count', (s, _step, _steps, at) => continueLowering(lowerGlobalCount(s), at + 1)],
  ['select', (s, step, _steps, at) => mapEntryColumn(s, step, at)],
  // The 1-to-1 `map(__.select(Column))` spelling of the same projection. `mapOfSelect` unwraps the
  // single-step body; any other map() body declines to the fallback.
  ['map', (s, step, _steps, at) => {
    const sel = mapOfSelect(step, s.params);
    return sel ? mapEntryColumn(s, sel, at) : null;
  }],
]);

export function compileFromMapEntry(s: MapEntryStream, steps: IRStep[], at: number): LoweringResult {
  if (at >= steps.length) throw new Error('a map entry at end of chain should not be a MapEntryStream');
  return dispatchShapeTail(MAP_ENTRY_DISPATCH, s, steps, at, (_s, ss, i) => {
    throw new Error(`${ss[i].name}() on unfolded map entries not yet supported`);
  });
}
