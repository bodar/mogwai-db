import { stepChain, flattenListArgs, type Step, type Pred } from './frontend.ts';
import { q, list, values, paren, empty, value, raw, jsonExtract, type Expression, type Relation } from './q.ts';
import { normalizeTypeName } from './gremlin-types.ts';
import { type ValueType } from './render.ts';

// ---------- SQL node builders ----------
//
// The bind-safe leaf layer: turn IR fragments (property keys, predicates, label
// filters, directions) into lazyrecords Expression nodes. Bound values live as
// Value tokens in the tree — no `?`+parallel-array splicing. The step compilers
// (compiler.ts) consume these and assemble CTEs; the render()/compiled() seam
// (render.ts) turns finished trees into {sql, binds}.

export const P_OPS: Record<string, string> = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/** `json_extract(col, '$.key')` over an already-materialized JSON blob COLUMN — NOT a
 *  storage table. Post edge-normalization its only callers are the vertex-property META
 *  blob (`p.c.pmeta`) and a materialized record-field props JSON column (`${prefix}_props`,
 *  built by edgePropsAgg/vertexPropsAgg). Element property VALUES are read from the
 *  normalized *_properties tables via scalarProp/hasProp, never here. A string column is a
 *  bind-free fragment → raw text so it renders unquoted; a Relation column arrives typed.
 *  (lazyrecords jsonExtract splices identifier-safe keys literally — harmless for a
 *  compiler-controlled key.) */
export function propExtract(col: Expression | string, key: unknown): { expr: Expression } {
  if (typeof key !== 'string') throw new Error('property key must be a string');
  return { expr: jsonExtract(typeof col === 'string' ? raw(col) : col, key) };
}

/** `<col> IN (SELECT id FROM labels WHERE name IN (?,?))` — the canonical
 *  label-name→id filter as a node. Names ride as bound Value tokens (no splice). */
export function labelIn(col: Expression | string, names: any[]): Expression {
  return q`${col} IN (SELECT id FROM labels WHERE name IN (${values(names)}))`;
}

/** Aggregate a value column into a single JSONB array (the fold()/select(values)
 *  producer). `jsonb(json_group_array(..))` is the universally-valid form — the
 *  native `jsonb_group_array` is unverified on the DO's SQLite 3.47, and `json_each`
 *  reads a JSONB blob transparently, so the wrapper costs nothing at read time.
 *  New JSON columns use JSONB per project policy (see CLAUDE.md). */
export const jsonbGroupArray = (expr: Expression): Expression => q`jsonb(json_group_array(${expr}))`;

/** A JSONB array literal from constant values — inject([a,b,c]) → one list value.
 *  Values ride as bound tokens; an empty list yields `json_array()` → `[]`. */
export const jsonbArrayOf = (xs: readonly any[]): Expression => q`jsonb(json_array(${values(xs)}))`;

/** Optional ` AND e.label IN (…)` appended to a movement JOIN's ON, as a node
 *  (empty text when no labels). Replaces ~7 hand-rolled `?`-splice + bind-push copies. */
export function edgeLabelFilter(names: any[]): Expression {
  return names.length ? q` AND ${labelIn('e.label', names)}` : empty;
}

/**
 * A boolean SQL predicate over a pre-built column Expression, shared by
 * has()/is()/where(). `expr` is a node (json_extract, a column, a subquery); its
 * binds ride as Value tokens. `pred` is a `Pred` {op,values}, a bare literal
 * (→ equality), or `undefined` (existence → IS NOT NULL). The predicate tail
 * (=/in/like/is not null) is appended after `expr` in the q`` template; for
 * between/inside `expr` is shared into both bounds so its binds fall out twice in
 * order — no manual double-splice. TextP → LIKE with a bound pattern; regex/typeOf throw.
 */
// Java's Character.isWhitespace(int) set — the chars String.strip()/trim()/AsString's
// trim family remove. Excludes the non-breaking spaces (U+00A0 NBSP, U+2007 figure,
// U+202F narrow NBSP), which Java also excludes; includes U+3000 ideographic space
// (the suite's fullwidth-space case). SQLite trim(x, set) removes any char in `set`.
// Built from explicit code points so the source carries no literal control/space chars.
export const JAVA_WHITESPACE = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x205f, 0x3000,
].map((c) => String.fromCharCode(c)).join("");

/** Per-element scalar string/cast transforms (map to SQLite scalar functions).
 *  Returns a new value expression wrapping `v`, or null if `name` isn't a
 *  transform. NULL propagates through every function (SQLite semantics), matching
 *  Gremlin's null-in→null-out. A trailing Scope token is a no-op on a scalar
 *  stream (per-element == per-list), so it's simply ignored. Shared by the scalar
 *  tail (renderProjection) and the list-local phase (list.ts, one element at a
 *  time). Deferred: split (list-valued), element/map asString(). */
export function scalarTx(name: string, args: any[], v: Expression): Expression | null {
  const nums = args.filter((a) => typeof a === 'number');
  const strs = args.filter((a) => typeof a === 'string');
  switch (name) {
    // concat: Gremlin concatenates the incoming value with the string args, SKIPPING
    // nulls (concat_ws('')); an all-null result is null, not '' (so bare concat() of a
    // null passes null through). The all-null guard is only live when there is no
    // non-null string arg (a literal arg makes the result non-null regardless of v).
    case 'concat': {
      if (!args.length) return v; // bare concat() = identity (v || nothing)
      const parts = list([v, ...strs.map((a) => value(a))], ', ');
      const body = q`concat_ws('', ${parts})`;
      return strs.length ? body : q`CASE WHEN ${v} IS NULL THEN NULL ELSE ${body} END`;
    }
    case 'length': return q`length(${v})`;
    case 'toUpper': return q`upper(${v})`;
    case 'toLower': return q`lower(${v})`;
    case 'asString': return q`CAST(${v} AS TEXT)`;
    case 'trim': return q`trim(${v}, ${value(JAVA_WHITESPACE)})`;
    case 'lTrim': return q`ltrim(${v}, ${value(JAVA_WHITESPACE)})`;
    case 'rTrim': return q`rtrim(${v}, ${value(JAVA_WHITESPACE)})`;
    // reverse: a string reverses its characters (a correlated recursive CTE — SQLite
    // has no REVERSE builtin); a number/null is returned unchanged (reverse() of a
    // scalar non-string is identity). A list reverses element order — handled in the
    // list phase (list.ts), never here.
    case 'reverse':
      return q`CASE WHEN typeof(${v})='text' THEN (WITH RECURSIVE rev(s,r) AS (SELECT ${v}, '' UNION ALL SELECT substr(s,2), substr(s,1,1)||r FROM rev WHERE s<>'') SELECT r FROM rev WHERE s='') ELSE ${v} END`;
    case 'replace': return q`replace(${v}, ${value(strs[0])}, ${value(strs[1])})`;
    case 'substring': { // 0-based [start, end) → 1-based substr(v, start+1, end-start)
      const [s, e] = nums;
      return e !== undefined ? q`substr(${v}, ${value(s + 1)}, ${value(e - s)})` : q`substr(${v}, ${value(s + 1)})`;
    }
    default: return null;
  }
}

/** hasId(...) args → a single predicate over the external id. A lone P argument
 *  passes through (P.within/without/eq/neq/…); otherwise the bare id args form a
 *  `within` set (nulls dropped — no element has a null id, so they never match). */
export function idPredFromArgs(rawArgs: any[]): any {
  // hasId(1,[2,6]) ≡ hasId(1,2,6): HasIdStep flattens every Collection id arg
  // (collection literals + bound list params parse as arrays). A lone P predicate is
  // NOT an array, so it still passes through the check below.
  const args = flattenListArgs(rawArgs);
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && 'op' in args[0]) return args[0];
  return { op: 'within', values: args.filter((a) => a !== null && a !== undefined) };
}

// GType → SQLite `typeof()` storage class — the LEGACY FALLBACK used only when a value
// carries no stored `vtype` (a NULL-vtype/raw-insert row, or a computed scalar with no
// type tag). `null` = a type SQLite's storage class can't distinguish (boolean/datetime/
// uuid/list/… all collapse to integer/text) → folds to false in the fallback; the stored
// `vtype` column is what recovers those (see typeOfSql mode 2). Keyed by canonical name.
const GTYPE_SQL: Record<string, string | null> = {
  string: 'text',
  int: 'integer', long: 'integer', short: 'integer',
  byte: 'integer', bigint: 'integer',
  double: 'real', float: 'real', bigdecimal: 'real',
  boolean: null, char: null, uuid: null, datetime: null,
  duration: null, list: null, map: null, set: null,
};

// A compile-time scalar `as` tag (ValueType, render.ts) → canonical Gremlin type name,
// for the static-fold typeOf mode. ValueType spells two names differently ('bool',
// 'date'); the rest are already canonical.
const AS_TO_CANONICAL: Record<ValueType, string> = {
  bool: 'boolean', date: 'datetime', byte: 'byte', short: 'short', int: 'int',
  long: 'long', bigint: 'bigint', float: 'float', double: 'double',
};

/** How to resolve the CURRENT scalar's type for a typeOf test:
 *  - `staticAs`  — the value's GraphBinary type is known at compile time (inject literal,
 *                  as*() cast, math→double) → fold to a constant.
 *  - `vtypeExpr` — a per-row stored `vtype` column (values()/properties()/a stored-prop
 *                  EXISTS) → match it, falling back to storage class for NULL-vtype rows.
 *  - neither     — no type info → the legacy storage-class test on the value. */
type TypeCtx = { staticAs?: ValueType; vtypeExpr?: Expression };

/** P.typeOf(GType|"ClassName") → a SQL type test over `expr`, resolved by `ctx` (see
 *  TypeCtx). A recognized non-value GType (vertex/edge/tree/graph/…) can never match a
 *  stored scalar → folds to false; a truly unregistered name raises (spec: "traversal
 *  will raise an error"). */
function typeOfSql(expr: Expression, arg: any, ctx: TypeCtx = {}): Expression {
  const rawName = (arg && typeof arg === 'object' && 'gtype' in arg) ? String(arg.gtype)
    : typeof arg === 'string' ? arg.toLowerCase()
    : (() => { throw new Error('typeOf() requires a GType argument'); })();
  if (rawName === 'null') return q`${expr} is null`;
  const canonical = normalizeTypeName(rawName);
  if (!canonical) {
    // A recognized element/token GType (vertex/edge/vertexproperty/tree/graph/path/binary)
    // is syntactically valid but a stored property scalar is never one → false. Anything
    // else is a bad type name → raise.
    const KNOWN_NON_VALUE = new Set(['vertex', 'edge', 'vertexproperty', 'vproperty', 'property', 'tree', 'graph', 'path', 'binary']);
    if (KNOWN_NON_VALUE.has(rawName)) return q`0`;
    throw new Error(`typeOf(): unregistered type '${rawName}'`);
  }
  // Mode 1 — compile-time known type → constant fold.
  if (ctx.staticAs !== undefined) return AS_TO_CANONICAL[ctx.staticAs] === canonical ? q`1` : q`0`;
  const storage = GTYPE_SQL[canonical];
  const byStorage = storage ? q`typeof(${expr}) = ${value(storage)}` : q`0`;
  // Mode 2 — per-row stored vtype, with a storage-class fallback for legacy NULL rows.
  if (ctx.vtypeExpr) return q`(CASE WHEN ${ctx.vtypeExpr} IS NOT NULL THEN ${ctx.vtypeExpr} = ${value(canonical)} ELSE ${byStorage} END)`;
  // Mode 3 — no type info → legacy storage-class test.
  return byStorage;
}

export function predicateSql(expr: Expression, pred: any, typeCtx: TypeCtx = {}): Expression {
  if (pred === undefined) return q`${expr} is not null`;
  if (pred === null || typeof pred !== 'object' || !('op' in pred)) return q`${expr} = ${value(pred)}`;
  const { op, values: vals } = pred as Pred;
  if (op === 'not') return q`NOT (${predicateSql(expr, vals[0], typeCtx)})`;
  if (op === 'typeOf') return typeOfSql(expr, vals[0], typeCtx);
  if (op in P_OPS) return q`${expr} ${P_OPS[op]} ${value(vals[0])}`;
  // SQLite rejects an empty `IN ()` list, so fold the degenerate sets to their
  // constant truth value: within nothing = never, without nothing = always.
  if (op === 'within') return vals.length ? q`${expr} in (${values(vals)})` : q`0`;
  if (op === 'without') return vals.length ? q`${expr} not in (${values(vals)})` : q`1`;
  // between = [lo, hi) inclusive low; inside = (lo, hi) exclusive low. `expr` is
  // shared into both bounds → its binds fall out twice in order (no double-splice).
  if (op === 'between' || op === 'inside')
    return q`(${expr} ${op === 'inside' ? '>' : '>='} ${value(vals[0])} and ${expr} < ${value(vals[1])})`;
  const lp = likePattern(op, vals[0]);
  if (lp) return q`${expr} ${lp.neg ? 'not like' : 'like'} ${value(lp.pat)} escape ${value('\\')}`;
  throw new Error(`unsupported predicate: P.${op}`);
}

/** TextP → a LIKE pattern (metachars in the user value escaped). null if not a
 *  supported TextP op (regex/typeOf fall through to the caller's throw). */
function likePattern(op: string, value: unknown): { pat: string; neg: boolean } | null {
  const neg = op.startsWith('not');
  const base = neg ? op[3].toLowerCase() + op.slice(4) : op; // notStartingWith → startingWith
  const v = String(value).replace(/[\\%_]/g, (c) => '\\' + c);
  if (base === 'startingWith') return { pat: `${v}%`, neg };
  if (base === 'endingWith') return { pat: `%${v}`, neg };
  if (base === 'containing') return { pat: `%${v}%`, neg };
  return null;
}

/** range(low, high) → SQL [offset, limit]. high < 0 means "no upper bound". */
export function rangeToOffsetLimit(args: any[]): { offset: number; limit: number } {
  const [lo, hi] = args.map(Number);
  if (hi >= 0 && lo > hi) throw new Error(`Not a legal range: [${lo}, ${hi}]`);
  return { offset: lo, limit: hi < 0 ? -1 : hi - lo };
}

/** Whether the current traverser's `id` column is a node id or an edge id. The
 *  id-relation is typed but the type is *static* — known from the step chain, so
 *  no runtime tag is needed. V()/out()/…V() → node; E()/…E() → edge. */
export type Elem = 'node' | 'edge';

/** The (from,to) edge-column pairs a directional step walks: out→src/tgt,
 *  in→tgt/src, both→both. One place so the movement CTE and the correlated
 *  edge-count (edgeCountFrom) can't diverge. */
export const dirsFor = (name: string): [string, string][] =>
  name === 'out' ? [['src', 'tgt']] : name === 'in' ? [['tgt', 'src']] : [['src', 'tgt'], ['tgt', 'src']];

// ---------- nested-traversal by() → correlated scalar (shared with where) ----------

/** SQL exprs for the current traverser's base fields, in terms of the outer row
 *  (aliased `n`). A nested by(__.…) compiles to a scalar expression correlated
 *  on these. Property context carries the json_each expansion's columns. */
export interface ScalarCtx {
  elem: 'node' | 'edge' | 'property';
  idExpr: Expression;        // n.id  (rowid — for correlated joins)
  extIdExpr?: Expression;    // COALESCE(n.uid, n.id) — the outward-facing id for framing
  // Both nodes AND edges now read props via idExpr into their normalized *_properties
  // table (scalarProp/hasProp dispatch on elem) — there is no flat-blob propsExpr.
  labelIdExpr: Expression;   // n.label
  srcExpr?: Expression;      // n.src  (edge)
  tgtExpr?: Expression;      // n.tgt  (edge)
  ownerExpr?: Expression;      // property: owning node id
  ownerPropsExpr?: Expression; // property: owner props (directly readable)
  pkExpr?: Expression;         // property: key column
  pvExpr?: Expression;         // property: value column
}

interface Scalar { expr: Expression }

/** Build a node/edge ScalarCtx from the (aliased) element relation `n` — its
 *  typed columns become the correlated-scalar base exprs. src/tgt exist only on
 *  edges. Shared by where()/filter() (current traverser) and group() over an
 *  element stream. */
export function elemCtx(n: Relation, elem: Elem): ScalarCtx {
  return {
    elem, idExpr: n.c.id, extIdExpr: q`COALESCE(${n.c.uid}, ${n.c.id})`,
    labelIdExpr: n.c.label,
    ...(elem === 'edge' ? { srcExpr: n.c.src, tgtExpr: n.c.tgt } : {}),
  };
}

/** `(SELECT name FROM labels WHERE id=<labelIdExpr>)` — resolve a label id to its
 *  name as a scalar subquery node. */
export const labelNameSub = (labelIdExpr: Expression): Expression => q`(SELECT name FROM labels WHERE id=${labelIdExpr})`;

/** A ScalarCtx correlating on an element identified by `idExpr` (a rowid column, e.g.
 *  an as()-bound alias column `p.a0`, or a recursive-walk row's id). props/label/src/
 *  tgt are read back by correlated subquery. Lets where()/by() sub-traversals re-root
 *  on an aliased traverser (`where(__.as('b').out()…)`) or a synthetic row. */
export function aliasCtx(idExpr: Expression, elem: Elem): ScalarCtx {
  const tbl = elem === 'edge' ? 'edges' : 'nodes';
  const sub = (c: string) => q`(SELECT ${c} FROM ${raw(tbl)} WHERE id=${idExpr})`;
  return {
    elem, idExpr, extIdExpr: sub('COALESCE(uid, id)'), labelIdExpr: sub('label'),
    ...(elem === 'edge' ? { srcExpr: sub('src'), tgtExpr: sub('tgt') } : {}),
  };
}

/** Resolve an endpoint rowid (an edge's `src`/`tgt` column) to the node's
 *  outward-facing external id `(SELECT COALESCE(uid,id) FROM nodes WHERE id=<rowid>)`.
 *  Used ONLY when framing an edge ELEMENT out (materialization → a bounded result
 *  set), never inside the movement/filter CTEs — so this per-row PK lookup can't
 *  touch the index-only edge-scan hot path. Keeps the read path's edge endpoints
 *  identical to the write path's (write.ts nodeExtId), instead of leaking the raw
 *  rowid that diverges from the user-supplied id. */
export const extIdOf = (rowid: Expression): Expression => q`(SELECT COALESCE(uid, id) FROM nodes WHERE id=${rowid})`;

// ---------- W4 property source seam (vertex_properties table vs edge JSONB) ----------
//
// Vertex properties are normalized rows; edge properties are a flat JSONB blob. The
// three access shapes below dispatch on ctx.elem so every call site is elem-agnostic:
//   scalarProp  — ONE value (first-under-multi) for order/group-key/map/by(key).
//   hasProp     — a boolean predicate; nodes use EXISTS so has() matches ANY value.
//   framedProps — the whole element's props as JSON text {…} for wire materialization
//                 (node: {key:[values]} multi; edge: {key:value} flat).
// framedProps/valueMapProps read at the LEAF only (a bounded result set) — never
// inside movement/filter CTEs, so the index-only traversal hot path is untouched.

/** node: the first value under `key` (ORDER BY id — insertion order), as a correlated
 *  scalar. Multi-valued keys collapse to the first, matching TinkerPop's by(key). */
export const nodePropScalar = (nodeIdExpr: Expression, key: string): Expression =>
  q`(SELECT value FROM vertex_properties WHERE node=${nodeIdExpr} AND key=${value(key)} ORDER BY id LIMIT 1)`;

/** node: does ANY value under `key` satisfy `pred` (undefined → the key exists at
 *  all). EXISTS over vertex_properties → multi-property has() semantics. */
export const nodeHasProp = (nodeIdExpr: Expression, key: string, pred: any): Expression => {
  const base = q`SELECT 1 FROM vertex_properties WHERE node=${nodeIdExpr} AND key=${value(key)}`;
  // The row's own `vtype` column is in scope inside the EXISTS, so has('k',typeOf(X))
  // matches the stored canonical type (mode 2) instead of only storage class.
  return pred === undefined ? q`EXISTS(${base})` : q`EXISTS(${base} AND ${predicateSql(raw('value'), pred, { vtypeExpr: raw('vtype') })})`;
};

/** edge: the value under `key` as a correlated scalar. Edge props are single-cardinality
 *  (one row per (edge,key), UNIQUE-enforced), so no ORDER BY / LIMIT dance is needed —
 *  the mirror of nodePropScalar for the normalized edge_properties table. */
export const edgePropScalar = (edgeIdExpr: Expression, key: string): Expression =>
  q`(SELECT value FROM edge_properties WHERE edge=${edgeIdExpr} AND key=${value(key)})`;

/** edge: does `key` satisfy `pred` (undefined → the key exists). EXISTS over
 *  edge_properties — mirror of nodeHasProp. */
export const edgeHasProp = (edgeIdExpr: Expression, key: string, pred: any): Expression => {
  const base = q`SELECT 1 FROM edge_properties WHERE edge=${edgeIdExpr} AND key=${value(key)}`;
  return pred === undefined ? q`EXISTS(${base})` : q`EXISTS(${base} AND ${predicateSql(raw('value'), pred, { vtypeExpr: raw('vtype') })})`;
};

/** edge: all props as flat JSON text `{key:value}` (single-valued per key), correlated
 *  on the edge rowid. Empty → `{}`. Mirror of vertexPropsAgg (which nests `[values]`
 *  for multi-property vertices; edges are single so the value is bare). */
export const edgePropsAgg = (edgeIdExpr: Expression): Expression =>
  q`COALESCE((SELECT json_group_object(key, value) FROM edge_properties WHERE edge=${edgeIdExpr}), '{}')`;

/** edge: valueMap props as `{key:[value]}` (each value wrapped in a 1-list so the
 *  handler frames node + edge valueMaps uniformly). */
export const edgeValueMapProps = (edgeIdExpr: Expression): Expression =>
  q`COALESCE((SELECT json_group_object(key, json_array(value)) FROM edge_properties WHERE edge=${edgeIdExpr}), '{}')`;

/** A single scalar value for `key` on the current element (order/group-key/by(key)):
 *  node → first-under-multi; edge → the single value. Both read their normalized table. */
export const scalarProp = (ctx: ScalarCtx, key: string): Expression =>
  ctx.elem === 'edge' ? edgePropScalar(ctx.idExpr, key) : nodePropScalar(ctx.idExpr, key);

/** A boolean predicate on `key` for the current element (has/where/is): node → ANY-match
 *  EXISTS over vertex_properties; edge → EXISTS over edge_properties. */
export const hasProp = (ctx: ScalarCtx, key: string, pred: any): Expression =>
  ctx.elem === 'edge' ? edgeHasProp(ctx.idExpr, key, pred) : nodeHasProp(ctx.idExpr, key, pred);

/** node: assemble ALL properties as JSON text `{key:[value,…]}` (multi-valued,
 *  insertion-ordered) from vertex_properties, correlated on the node rowid. Empty →
 *  `{}`. JSON text (not JSONB) — computed on the fly, so the handler JSON.parses it. */
export const vertexPropsAgg = (nodeIdExpr: Expression): Expression =>
  q`COALESCE((SELECT json_group_object(key, json(vs)) FROM (SELECT key, json_group_array(value ORDER BY id) AS vs FROM vertex_properties WHERE node=${nodeIdExpr} GROUP BY key ORDER BY MIN(id))), '{}')`;

/** The props expression for framing a whole element out. Node: vertexPropsAgg
 *  ({key:[values]}); edge: edgePropsAgg ({key:value}), both over the rowid. */
export const framedProps = (rel: Relation, elem: Elem): Expression =>
  elem === 'edge' ? edgePropsAgg(rel.c.id) : vertexPropsAgg(rel.c.id);

/** framedProps from a ScalarCtx (group()/element framing): edge → edgePropsAgg on the
 *  ctx rowid; node → vertexPropsAgg on the ctx rowid. */
export const framedPropsCtx = (ctx: ScalarCtx): Expression =>
  ctx.elem === 'edge' ? edgePropsAgg(ctx.idExpr) : vertexPropsAgg(ctx.idExpr);

/** valueMap()'s props: ALWAYS {key:[values]} (values wrapped in a list) for both
 *  runtimes' handler. Node = vertexPropsAgg; edge = wrap each single value in a 1-list. */
export const valueMapProps = (rel: Relation, elem: Elem): Expression =>
  elem === 'edge' ? edgeValueMapProps(rel.c.id) : vertexPropsAgg(rel.c.id);

/**
 * Compile a nested traversal (the node inside by(__.…)/where(__.…)) to a
 * correlated SQL scalar expression. Focused on the proven step set — the L3
 * gate's key/value sub-traversals plus common where idioms:
 *   node ctx:  values(k) | label() | id() | out|in|both([lbl])…count()
 *   edge ctx:  outV|inV()[.values(k)|.label()|.id()] | values(k) | label() | id()
 *   prop ctx:  key() | value() | element()[.values(k)|.label()|.id()]
 * Anything past this throws clearly (never silently mis-executes).
 */
class InlineScalarMiss extends Error {}
const inlineScalarMiss = (): never => { throw new InlineScalarMiss(); };

/** Optional correlated-scalar optimization. Unsupported shapes return null so the
 * caller can use generic child lowering; this helper never defines language support. */
export function tryInlineScalar(inner: Step[], ctx: ScalarCtx): Scalar | null {
  try { return compileInlineScalar(inner, ctx); }
  catch (error) {
    if (error instanceof InlineScalarMiss) return null;
    throw error;
  }
}

function compileInlineScalar(inner: Step[], ctx: ScalarCtx): Scalar {
  let steps = inner;
  // A pointer to the "current NODE" (rowid) for terminal value/label/id reads. Once
  // here the current element is always a node (edge values/label/id return above), so a
  // values() terminal reads vertex_properties via nodePropScalar.
  let nodeId: Expression;
  let directLabelId: Expression | null; // label id readable inline, else null → subquery via nodes

  const head = steps[0]?.name;
  if (!head) return inlineScalarMiss();

  if (ctx.elem === 'property') {
    if (head === 'key') { requireTerminal(steps, 1); return { expr: ctx.pkExpr! }; }
    if (head === 'value') { requireTerminal(steps, 1); return { expr: ctx.pvExpr! }; }
    if (head === 'element') { nodeId = ctx.ownerExpr!; directLabelId = null; steps = steps.slice(1); }
    else return inlineScalarMiss();
  } else if (ctx.elem === 'edge') {
    if (head === 'outV' || head === 'inV') { nodeId = head === 'outV' ? ctx.srcExpr! : ctx.tgtExpr!; directLabelId = null; steps = steps.slice(1); }
    else if (head === 'label') { requireTerminal(steps, 1); return { expr: labelNameSub(ctx.labelIdExpr) }; }
    else if (head === 'id') { requireTerminal(steps, 1); return { expr: ctx.idExpr }; }
    else if (head === 'values') { requireTerminal(steps, 1); return { expr: scalarProp(ctx, steps[0].args[0]) }; }
    // out()/in()/both() are NOT valid on an edge (must go through outV()/inV());
    // routing them to edgeCountFrom here would compare edges.src to the edge's own
    // id and silently mis-count, so let them hit the clear throw below.
    else return inlineScalarMiss();
  } else { // node
    nodeId = ctx.idExpr; directLabelId = ctx.labelIdExpr;
    if (MOVES.has(head)) return edgeAggFrom(steps, ctx.idExpr);
  }

  // Terminal projection on the resolved current node.
  const s = steps[0];
  if (!s) return inlineScalarMiss();
  switch (s.name) {
    case 'values': requireTerminal(steps, 1); return { expr: nodePropScalar(nodeId, s.args[0]) };
    case 'label':  requireTerminal(steps, 1); return { expr: labelNameSub(directLabelId ?? q`(SELECT label FROM nodes WHERE id=${nodeId})`) };
    case 'id':     requireTerminal(steps, 1); return { expr: nodeId };
    // constant(x): a fixed scalar per traverser — the common choose().option() body.
    case 'constant': requireTerminal(steps, 1); return { expr: value(s.args[0]) };
    default: return inlineScalarMiss();
  }
}

/** Vertex→edge/neighbour movement steps (count/EXISTS both key off these). */
const MOVES = new Set(['out', 'in', 'both', 'outE', 'inE', 'bothE']);

/** SQL aggregate for a terminal reducer over a correlated stream. */
const AGG_FN: Record<string, string> = { count: 'COUNT', sum: 'SUM', min: 'MIN', max: 'MAX', mean: 'AVG' };

/** out/in/both/outE/inE/bothE([label]) then either …count() or (E-forms only)
 *  …values(k).<sum|min|max|mean>() → a correlated aggregate over the incident
 *  edges on the outer node. The E-suffixed forms cover the same incident edges
 *  (1:1 with the neighbour hop), so direction is the un-suffixed base. */
function edgeAggFrom(steps: Step[], nodeIdExpr: Expression): Scalar {
  const mv = steps[0];
  const base = mv.name.endsWith('E') ? mv.name.slice(0, -1) : mv.name;
  const dirs = dirsFor(base);
  // Incidence: an incoming edge matches on any of the base directions' `from` cols
  // (both → src OR tgt). A self-loop matches once (acceptable — no weighted loops).
  const incidence = paren(list(dirs.map(([from]) => q`${from}=${nodeIdExpr}`), ' OR '));
  const lbl: Expression = mv.args.length ? q` AND ${labelIn('label', mv.args)}` : empty;

  if (steps[1]?.name === 'count' && steps.length === 2)
    return { expr: q`(SELECT COUNT(*) FROM edges WHERE ${incidence}${lbl})` };

  // …values(k).<reducer>() aggregates an edge property. E-forms only: on a bare
  // out()/in()/both() the value would come from the NEIGHBOUR vertex (a join),
  // which is a separate, unimplemented shape.
  if (mv.name.endsWith('E') && steps[1]?.name === 'values' && steps.length === 3 && steps[2].name in AGG_FN && steps[2].name !== 'count') {
    // Aggregate an edge property over the incident edges — JOIN the normalized
    // edge_properties table (was json_extract of the retired flat blob).
    return { expr: q`(SELECT ${raw(AGG_FN[steps[2].name])}(ep.value) FROM edges JOIN edge_properties ep ON ep.edge=edges.id WHERE ${incidence}${lbl} AND ep.key=${value(steps[1].args[0])})` };
  }
  return inlineScalarMiss();
}

const requireTerminal = (steps: Step[], n: number) => {
  if (steps.length > n) inlineScalarMiss();
};

// ---------- where()/not()/filter(__.…) → a boolean filter predicate ----------

/**
 * Compile a where()/filter() nested traversal into a boolean SQL predicate
 * correlated on the current traverser (for `WHERE [NOT] <pred>`). Supported:
 *   __.<move>.count().is(P)   → correlated count compared (tries tryInlineScalar)
 *   __.values(k)[.is(P)]      → current-property predicate (bare → IS NOT NULL)
 *   __.has(k[,v]) / hasLabel  → current-element predicate
 *   __.<move>([label])        → EXISTS over incident edges (bare "has a neighbour")
 *   __.and(t…) / __.or(t…)    → the branch predicates combined with AND / OR
 * Multi-hop / neighbour-terminal-filter are deferred with clear errors.
 */
/** Optional correlated predicate optimization. Unsupported shapes return null so an
 * element consumer can fall back to generic child-existence lowering. */
export function tryInlinePredicate(
  nested: Step[], ctx: ScalarCtx, params: Record<string, any> = {},
  resolveAlias?: (label: string) => ScalarCtx,
): Expression | null {
  try { return compileInlinePredicate(nested, ctx, params, resolveAlias); }
  catch (error) {
    if (error instanceof Error
        && error.message.includes('not yet supported')
        && (error.message.startsWith('where') || error.message.startsWith('filter'))) return null;
    throw error;
  }
}

function compileInlinePredicate(
  nested: Step[], ctx: ScalarCtx, params: Record<string, any> = {},
  resolveAlias?: (label: string) => ScalarCtx,
): Expression {
  // A leading as('x')/select('x') re-roots the predicate on the aliased traverser:
  // where(__.as('b').out('created').has('name','ripple')) correlates on b's column.
  const h0 = nested[0];
  if (resolveAlias && nested.length > 1 && (h0.name === 'as' || h0.name === 'select')
      && h0.args.length === 1 && typeof h0.args[0] === 'string')
    return compileInlinePredicate(nested.slice(1), resolveAlias(h0.args[0]), params, resolveAlias);

  let body = nested;
  let isPred: any = undefined, hasIs = false;
  if (body[body.length - 1]?.name === 'is') { isPred = body[body.length - 1].args[0]; hasIs = true; body = body.slice(0, -1); }

  const head = body[0]?.name;
  if (!head) throw new Error('empty where()/filter() traversal');

  // and(t…)/or(t…): combine each branch's predicate. (infix .and()/.or() — a
  // multi-step body — is not this shape and falls through to the deferred throw.)
  if ((head === 'and' || head === 'or') && body.length === 1)
    return combineBranchPreds(body[0], ctx, params, head === 'and' ? 'AND' : 'OR', resolveAlias);

  const term = body[body.length - 1]?.name;

  // A reducing scalar (count/sum) compared by is(P). Bare (no is) always yields
  // one value → the traverser always passes, so it's a no-op filter.
  if (term === 'count' || term === 'sum') {
    if (!hasIs) return q`1`;
    const inline = tryInlineScalar(body, ctx);
    if (!inline) throw new Error(`where()/filter() form not yet supported: __.${body.map((s) => s.name + '()').join('.')}`);
    return predicateSql(inline.expr, isPred);
  }

  // Current-element predicates (no movement). ANY-match EXISTS over the element's
  // normalized properties table — vertex_properties / edge_properties (hasProp dispatches).
  if (head === 'values' && body.length === 1) {
    // bare where(__.values(k)) → the key exists at all; .is(P) → any value matches P.
    return hasProp(ctx, body[0].args[0], hasIs ? isPred : undefined);
  }
  if (head === 'has' && body.length === 1) {
    const [key, val] = body[0].args;
    // has(T.label|T.id, v|P): predicate over the label name / external id (mirrors
    // filter.ts has()'s token branch, so choose(__.has(T.label,'person')) etc work).
    if (key && typeof key === 'object' && 'token' in key) {
      const expr: Expression = key.token === 'label' ? labelNameSub(ctx.labelIdExpr)
        : key.token === 'id' ? ctx.extIdExpr!
        : (() => { throw new Error(`has(T.${key.token}) not supported`); })();
      return predicateSql(expr, val);
    }
    if (typeof key === 'string') {
      return hasProp(ctx, key, val);
    }
  }
  if (head === 'hasLabel' && body.length === 1)
    return labelIn(ctx.labelIdExpr, body[0].args);
  if (head === 'hasId' && body.length === 1)
    return predicateSql(ctx.extIdExpr!, idPredFromArgs(body[0].args));

  // where(__.label()[.is(P)]) — predicate on the current element's label name.
  if (head === 'label' && body.length === 1)
    return predicateSql(labelNameSub(ctx.labelIdExpr), hasIs ? isPred : undefined);

  // where(__.not(t)) — negate an inner predicate; a NULL (missing) is kept (NOT COALESCE).
  if (head === 'not' && body.length === 1) {
    const arg = body[0].args.find((a: any) => a && typeof a === 'object' && 'nested' in a);
    if (!arg) throw new Error('not() requires a traversal');
    const inner = compileInlinePredicate(stepChain(arg.nested, params), ctx, params, resolveAlias);
    return q`NOT COALESCE((${inner}), 0)`;
  }

  if (MOVES.has(head))
    // A movement chain → a correlated EXISTS over the path, with an optional terminal
    // filter (has/hasLabel/values.is) on the last node. (count/sum handled above.)
    return compileExistsChain(body, ctx, isPred, hasIs);
  throw new Error(`where()/filter() form not yet supported: __.${body.map((s) => s.name + '()').join('.')}`);
}

/** and(t…)/or(t…): each branch → a filter predicate node, joined by AND/OR
 *  (`((p0) AND (p1))`). Used both as a top-level filter step and inside where(__.and/or). */
export function combineBranchPreds(
  step: Step, ctx: ScalarCtx, params: Record<string, any>, op: 'AND' | 'OR',
  resolveAlias?: (label: string) => ScalarCtx,
): Expression {
  const branches = step.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 2) throw new Error(`${step.name}() needs at least two traversal branches`);
  const parts = branches.map((b) => paren(compileInlinePredicate(stepChain(b.nested, params), ctx, params, resolveAlias)));
  return paren(list(parts, ` ${op} `));
}

/** EXISTS over a single incident-edge movement (out/in/both/outE/inE/bothE),
 *  correlated on the outer node, as a node. "Does this vertex have such a neighbour/edge." */
function compileExists(mv: Step, ctx: ScalarCtx): Expression {
  if (ctx.elem !== 'node') throw new Error(`where(__.${mv.name}()) expects a vertex, not an ${ctx.elem}`);
  const dirs = dirsFor(mv.name.endsWith('E') ? mv.name.slice(0, -1) : mv.name);
  // Alias the subquery's edges `xe`, NOT `e`: when this predicate correlates on an
  // outer row that is ITSELF an `edges e` (e.g. until(__.out()) inside repeat()'s
  // recursive term, where ctx.idExpr is `e.tgt`), a shared `e` would shadow the outer
  // one and silently correlate the EXISTS on itself. `xe` can't collide.
  const labelFilter = mv.args.length ? q` AND ${labelIn('xe.label', mv.args)}` : empty;
  const terms = dirs.map(([from]) =>
    q`EXISTS(SELECT 1 FROM edges xe WHERE xe.${from}=${ctx.idExpr}${labelFilter})`);
  return terms.length === 1 ? terms[0] : paren(list(terms, ' OR '));
}

/**
 * A multi-hop vertex-movement chain → a correlated EXISTS over the path, with an
 * optional terminal filter on the last node. Handles out()/in() chains (single
 * direction per hop) plus a trailing has(k[,v])/hasLabel(l)/values(k)[.is(P)]; a lone
 * bare movement delegates to the leaner edge-only compileExists (which also does
 * both()). Multi-hop both(), edge-typed hops, and unknown terminals defer. Aliases
 * xe{k}/xn{k} can't collide with the outer `n`/`e`/`p`.
 */
function compileExistsChain(body: Step[], ctx: ScalarCtx, isPred: any, hasIs: boolean): Expression {
  if (ctx.elem !== 'node') throw new Error(`where(__.${body[0].name}()) expects a vertex, not an ${ctx.elem}`);

  // A lone bare movement (incl. the outE/inE/bothE edge forms) → the leaner edge-only
  // EXISTS (index-only; both() ok). Must stay ahead of the vertex-chain builder below,
  // which handles only out()/in() hops.
  if (body.length === 1 && !hasIs && MOVES.has(body[0].name)) return compileExists(body[0], ctx);

  const moves: Step[] = [];
  let i = 0;
  for (; i < body.length && ['out', 'in', 'both'].includes(body[i].name); i++) moves.push(body[i]);
  const terminal = body[i];
  if (body[i + 1]) throw new Error(`where()/filter() form not yet supported: __.${body.map((s) => s.name + '()').join('.')}`);
  if (!moves.length) throw new Error(`where()/filter() form not yet supported: __.${body.map((s) => s.name + '()').join('.')}`);
  if (moves.some((m) => m.name === 'both')) throw new Error('where(__.both()…) multi-hop / with a terminal filter not yet supported');

  // Correlated join chain: edges xe0 JOIN nodes xn0 … [JOIN edges xe1 … JOIN nodes xn1 …].
  const parts: Expression[] = [];
  const conds: Expression[] = [];
  let prevId: Expression = ctx.idExpr;
  moves.forEach((m, k) => {
    const [from, to] = dirsFor(m.name)[0];
    const e = `xe${k}`, n = `xn${k}`;
    parts.push(k === 0
      ? q`edges ${e} JOIN nodes ${n} ON ${n}.id=${e}.${to}`
      : q`JOIN edges ${e} ON ${e}.${from}=${prevId} JOIN nodes ${n} ON ${n}.id=${e}.${to}`);
    if (k === 0) conds.push(q`${e}.${from}=${prevId}`);
    if (m.args.length) conds.push(labelIn(`${e}.label`, m.args));
    prevId = q`${n}.id`;
  });
  const last = `xn${moves.length - 1}`;

  if (terminal) {
    // The terminal element is a node (xn{k}); its props → an ANY-match EXISTS over
    // vertex_properties correlated on the joined node's rowid.
    if (terminal.name === 'has' && typeof terminal.args[0] === 'string')
      conds.push(nodeHasProp(raw(`${last}.id`), terminal.args[0], terminal.args[1]));
    else if (terminal.name === 'hasLabel')
      conds.push(labelIn(`${last}.label`, terminal.args));
    else if (terminal.name === 'values' && typeof terminal.args[0] === 'string')
      conds.push(nodeHasProp(raw(`${last}.id`), terminal.args[0], hasIs ? isPred : undefined));
    else throw new Error(`where() chain terminal __.${terminal.name}() not yet supported`);
  } else if (hasIs) {
    throw new Error(`where(__.${moves.map((m) => m.name + '()').join('.')}.is(P)) not yet supported`);
  }
  return q`EXISTS(SELECT 1 FROM ${list(parts, ' ')} WHERE ${list(conds, ' AND ')})`;
}
