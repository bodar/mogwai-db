import { flattenListArgs, gtypeName, isNested, type Pred } from '../../gremlin/frontend.ts';
import { q, list, values, empty, value, raw, jsonExtract, type Expression, type Relation } from '../../sql/kernel/q.ts';
import type { FastPath } from '../options/fast-paths.ts';
import { normalizeTypeName, BigDecimal, Duration } from '../../gremlin/types.ts';
import { nodes, edges, labels, vertexLabels } from '../../sql/schema.ts';
import type { LabelRegime } from '../../api.ts';
import { type ElemShape, type ScalarType, type ValueType } from '../../sql/kernel/render.ts';

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
 *  label-name→id filter as a node. Names ride as bound Value tokens (no splice).
 *  `col` is a label-ID column, so this is the EDGE form; a vertex's labels live in
 *  `vertex_labels` and go through `vertexLabelIn`. */
export function labelIn(col: Expression | string, names: any[]): Expression {
  return q`${col} IN (SELECT id FROM labels WHERE name IN (${values(names)}))`;
}

// ---------- the vertex label seam (multi-label) ----------
//
// A vertex carries a SET of labels in `vertex_labels`; an edge carries exactly one, inline
// on `edges.label` (TinkerPop fixes edge label cardinality at ONE). Everything that reads a
// label goes through one of the four builders below, and the split between them is the
// load-bearing distinction:
//
//   SCALAR position  (label(), by(T.label), order/group keys) → labelNameFor /
//                     vertexLabelName. These PICK one label.
//   PREDICATE        (hasLabel, has(T.label,…), the 3-arg has overload) → labelMatchFor /
//                     vertexLabelIn. These match ANY label.
//   PAYLOAD          (an ELEMENT on the wire, and elementMap()/valueMap(true)'s T.label token)
//                     → labelPayloadFor / labelTokenFor. These carry ALL of them.
//   FAN-OUT          (labels(), one row per label) → the ONLY place allowed to join
//                     vertex_labels into a relation.
//
// The trap this exists to prevent: every scalar site used to read `l.name` off a
// `JOIN labels l ON l.id = n.label`. Re-pointing those joins at `vertex_labels` would
// silently MULTIPLY the row — N labels, N copies of the vertex — and would pass every
// single-label test, because under LabelCardinality.ONE the join yields exactly one row.
// So a scalar position must never join; it correlates and picks.

/** The label NAME of a vertex, as a scalar. Deterministic pick (lowest label id) so a
 *  multi-label vertex still yields a stable `label()`/`T.label`, which is what
 *  `Element.label()` promises — "an arbitrary label when multiple exist". Never joins. */
export const vertexLabelName = (nodeIdExpr: Expression): Expression =>
  q`(SELECT ${labels.c.name} FROM ${vertexLabels} JOIN ${labels} ON ${labels.c.id}=${vertexLabels.c.label} WHERE ${vertexLabels.c.node}=${nodeIdExpr} ORDER BY ${vertexLabels.c.label} LIMIT 1)`;

/** ALL of a vertex's labels as a JSON array of names, ordered like `vertexLabelName`'s pick so the
 *  two agree on which label comes first. The multi-label rendering of `T.label` in
 *  elementMap()/valueMap(true); it is a scalar subquery, so it still never multiplies the row. */
export const vertexLabelNames = (nodeIdExpr: Expression): Expression =>
  q`(SELECT json_group_array(${labels.c.name}) FROM ${vertexLabels} JOIN ${labels} ON ${labels.c.id}=${vertexLabels.c.label} WHERE ${vertexLabels.c.node}=${nodeIdExpr} ORDER BY ${vertexLabels.c.label})`;

/** `vertexLabelNames` made TOTAL: a vertex with no labels at all (LabelCardinality.ZERO_OR_MORE)
 *  has no `vertex_labels` rows, and `json_group_array` over no rows is NULL, not `[]`. */
export const vertexLabelsJson = (nodeIdExpr: Expression): Expression =>
  q`COALESCE(${vertexLabelNames(nodeIdExpr)}, json_array())`;

/** The `T.label` expression for a map shape under `regime`, plus an EDGE's single-label form
 *  (an edge carries exactly one, so a set of one is still framed as a set when asked). */
export const labelTokenFor = (n: Relation, elem: Elem, regime: LabelRegime): Expression =>
  regime === 'single' ? labelNameFor(n, elem)
  : elem === 'edge' ? q`json_array(${labelNameSub(n.c.label)})`
  : vertexLabelsJson(n.c.id);

/** The label field of an ELEMENT payload: a JSON array of every name for a vertex, the bare name
 *  for an edge (TinkerPop fixes edge label cardinality at ONE).
 *
 *  The PAYLOAD position, and the one that was missing — a vertex element used to be filed under
 *  SCALAR, so `g.V()` over a multi-label vertex framed one label where the graph held several.
 *  GraphBinary's `{label}` field IS a list and the client reads the whole thing
 *  (`VertexSerializer.deserializeValue` keeps `labels` and derives `.label` from `labels[0]`), so
 *  this is UNCONDITIONAL — there is no `LabelRegime` here. `with("singlelabel")` governs how
 *  elementMap()/valueMap(true) RENDER a `T.label` entry, which is `labelTokenFor`'s job; it says
 *  nothing about what a vertex element carries. */
export const labelPayloadFor = (n: Relation, elem: Elem): Expression =>
  elem === 'edge' ? labelNameSub(n.c.label) : vertexLabelsJson(n.c.id);

/** ANY of a vertex's labels is in `names`. Written as `<id> IN (SELECT node …)` so it seeks
 *  `vl_label(label, node)` and reads the node ids straight off the index. Correct under both
 *  regimes: under ONE the set is a singleton, so this is exactly the old `n.label IN (…)`. */
export const vertexLabelIn = (nodeIdExpr: Expression, names: any[]): Expression =>
  q`${nodeIdExpr} IN (SELECT ${vertexLabels.c.node} FROM ${vertexLabels} WHERE ${labelIn(vertexLabels.c.label, names)})`;

/** The scalar label name of the element held in `n` (which must be `elemTable(elem)`). The
 *  ONE spelling for every one-row-per-element position. */
export const labelNameFor = (n: Relation, elem: Elem): Expression =>
  elem === 'edge' ? labelNameSub(n.c.label) : vertexLabelName(n.c.id);

/** ANY-label membership for the element held in `n`. The ONE spelling for hasLabel(). */
export const labelMatchFor = (n: Relation, elem: Elem, names: any[]): Expression =>
  elem === 'edge' ? labelIn(n.c.label, names) : vertexLabelIn(n.c.id, names);

/** `has(T.label, P)` — SOME label of the element satisfies `P`.
 *
 *  Existential UNIFORMLY, with no special case for a negated predicate, because that is what
 *  upstream specifies. `Has.feature` spells it out on the scenario itself: "Because label
 *  predicates match if ANY label satisfies them, has(T.label, without('animal')) matches every
 *  vertex that carries some label other than 'animal' — which is all of them. To exclude vertices
 *  labeled 'animal', use not(hasLabel('animal')) instead." So `without` here does NOT mean "carries
 *  no such label"; reading it that way is the tempting wrong answer.
 *
 *  An edge has exactly one label, where ∃ over a singleton is just the compare, so it keeps the
 *  cheaper inline form. */
export const labelPredicateFor = (n: Relation, elem: Elem, pred: any): Expression =>
  elem === 'edge'
    ? predicateSql(labelNameSub(n.c.label), pred)
    : q`EXISTS (SELECT 1 FROM ${vertexLabels} JOIN ${labels} ON ${labels.c.id}=${vertexLabels.c.label} WHERE ${vertexLabels.c.node}=${n.c.id} AND ${predicateSql(labels.c.name, pred)})`;

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
      // A traversal argument is semantically a per-traverser child value, not a string
      // literal — `TraversalUtil.apply(traverser, child)`, whose value this pure SQL leaf
      // has no child relation to compute. The CALLER resolves it (lowerConcatScalar,
      // steps/tail/mapscalar.ts) and substitutes the resulting Expression into `args`,
      // exactly as operandSql's Expression operands arrive pre-built. A raw `nested` tag
      // still here means no caller resolved it (the list-local per-member phase, which has
      // no parent traverser to correlate against), so fail closed rather than silently
      // dropping the argument — which is what used to return the receiver unchanged.
      if (args.some(isNested)) throw new Error('concat() traversal arguments not yet supported');
      if (!args.length) return v; // bare concat() = identity (v || nothing)
      // ConcatStep's two constructors are mutually exclusive (the grammar splits a mixed
      // call into two steps), so the operands are uniformly string literals or uniformly
      // resolved child values; `value()` forwards an Expression untouched and binds a
      // literal, so both ride one path. Order is `args` order, matching ConcatStep.map().
      const parts = list([v, ...args.map((a) => value(a))], ', ');
      const body = q`concat_ws('', ${parts})`;
      // concat_ws skips NULLs, so an all-null concat must yield NULL, not ''. A non-null
      // literal string makes the result non-null regardless of `v`, so no guard is needed.
      // Otherwise TinkerPop returns null exactly when the traverser AND every child AND
      // every string arg is null (ConcatStep.map's three isNull* flags) — so the guard tests
      // that every operand IS NULL, never that the concatenation is empty (an operand of ''
      // is a non-null contribution and must yield '', not NULL).
      if (strs.length) return body;
      const allNull = list([v, ...args.map((a) => value(a))].map((e) => q`${e} IS NULL`), ' AND ');
      return q`CASE WHEN ${allNull} THEN NULL ELSE ${body} END`;
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

// A compile-time scalar `as` tag (ValueType, render.ts) → canonical Gremlin type name, for
// the static-fold typeOf mode. The one vocabulary correspondence lives in gremlin/types.ts.

/** How an arbitrary SQL expression's scalar type is known to the planner. This is
 * deliberately separate from render.ts's ScalarType: a stream's per-row case names
 * a relation column, while this per-row case carries the expression currently in
 * scope (which may be an alias or a computed subexpression). */
export type TypeCtx =
  | { kind: 'static'; type: ValueType }
  | { kind: 'perRow'; expr: Expression }
  | { kind: 'unknown' };

export const TYPE_STATIC = (type: ValueType): TypeCtx => ({ kind: 'static', type });
export const TYPE_PER_ROW = (expr: Expression): TypeCtx => ({ kind: 'perRow', expr });
export const TYPE_UNKNOWN: TypeCtx = { kind: 'unknown' };

/** Bridge a stream-level type channel into the planner's expression-level vocabulary.
 * `ScalarType.perRow` names a relation column; TypeCtx.perRow carries that column's
 * expression in the current SQL scope. Keeping the conversion here prevents every
 * predicate consumer from reimplementing the boundary. */
export const typeCtxOf = (type: ScalarType, column: (name: string) => Expression): TypeCtx =>
  type.kind === 'static' ? TYPE_STATIC(type.type)
    : type.kind === 'perRow' ? TYPE_PER_ROW(column(type.column))
      : TYPE_UNKNOWN;

/** P.typeOf(GType|"ClassName") → a SQL type test over `expr`, resolved by `ctx` (see
 *  TypeCtx). A recognized non-value GType (vertex/edge/tree/graph/…) can never match a
 *  stored scalar → folds to false; a truly unregistered name raises (spec: "traversal
 *  will raise an error"). */
function typeOfSql(expr: Expression, arg: any, ctx: TypeCtx = TYPE_UNKNOWN): Expression {
  const rawName = gtypeName(arg)?.toLowerCase()
    ?? (() => { throw new Error('typeOf() requires a GType argument'); })();
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
  if (ctx.kind === 'static') return ctx.type === canonical ? q`1` : q`0`;
  const storage = GTYPE_SQL[canonical];
  const byStorage = storage ? q`typeof(${expr}) = ${value(storage)}` : q`0`;
  // Mode 2 — per-row stored vtype, with a storage-class fallback for legacy NULL rows.
  if (ctx.kind === 'perRow') return q`(CASE WHEN ${ctx.expr} IS NOT NULL THEN ${ctx.expr} = ${value(canonical)} ELSE ${byStorage} END)`;
  // Mode 3 — no type info → legacy storage-class test.
  return byStorage;
}

// ---------- vtype-aware compare/sort key (option b) ----------
//
// A stored value's SQLite storage class varies by type: int/double/small-long ride as
// INTEGER/REAL (native, index-friendly), but the exact tail — long>2^53, bigint,
// bigdecimal, duration — rides as TEXT (see storedScalar; the DO can't bind a big int64
// numerically). Plain SQL comparison then orders those TEXT rows LEXICALLY ("10…" before
// "9…") and, in a mixed key, after every numeric row (storage-class rank) — silently
// wrong. Since a property key isn't statically typed, we can't pick "CAST or not" at
// compile time — but the per-row `vtype` column tells us at run time. `compareKey` turns
// (value, vtype) into a correctly-ordered SQLite value: numeric types cast to a numeric
// storage class, strings/uuid/char stay TEXT (lexical = correct for those). CAST(v AS
// INTEGER) is EXACT for the whole int family + long (a long is int64 by definition) +
// datetime + normal durations; float/double are exact via REAL; bigdecimal and >int64
// bigint are ordered via REAL/INTEGER = exact within f64/int64, approximate beyond (the
// irreducible-in-pure-SQL residue, same wall regex hits — a post-SQL JS sort is the future
// escape). Applied only where ORDER/range comparison happens (never in the equality/value
// extraction path), and only inside the per-element correlated EXISTS / the ORDER BY scan
// — neither uses a leading value-index range, so no index seek is lost.
// The type-name IN-lists are fixed CONSTANTS (not user input), so splice them as SQL
// literals rather than binds — otherwise every range predicate would carry ~20 wasted
// type-name parameters. No injection surface (hardcoded vocabulary).
const CMP_INT_IN = raw(`('byte','short','int','long','bigint','datetime','duration')`);
const CMP_REAL_IN = raw(`('float','double','bigdecimal')`);
export function compareKey(valueExpr: Expression, vtypeExpr: Expression): Expression {
  return q`(CASE WHEN ${vtypeExpr} IN ${CMP_INT_IN} THEN CAST(${valueExpr} AS INTEGER) WHEN ${vtypeExpr} IN ${CMP_REAL_IN} THEN CAST(${valueExpr} AS REAL) ELSE ${valueExpr} END)`;
}

/** The comparison form of a predicate BOUND (the literal side of gt/lt/between/…). Unlike
 *  the stored column, a bound's type is known at COMPILE time, so it needs no runtime CASE
 *  (which would splice the bind three times) — just one cast matching the column's numeric
 *  family: a bigint / Duration (total-nanos) → INTEGER, a BigDecimal → REAL, a plain
 *  number/string binds raw (a JS number is ≤2^53 by construction — a bigger literal parses
 *  as a bigint). Compared against the column's compareKey, numeric families line up. */
export function compareBound(v: any): Expression {
  if (typeof v === 'bigint' || v instanceof Duration) return q`CAST(${value(v)} AS INTEGER)`;
  if (v instanceof BigDecimal) return q`CAST(${value(v)} AS REAL)`;
  // operandSql, not value: this is the OTHER literal-rendering path a predicate operand can take
  // (the vtype-aware range compare), so it needs the same traversal-operand guard. Missing it here
  // let `has("age", P.gt(__.<traversal>))` compile and only fail at bind time.
  return operandSql(v);
}

/** node: the vtype-aware sort key for `key` (order().by(key)/min/max), correlated. Same
 *  first-under-multi row as nodePropScalar, but its value is the compareKey so ordering
 *  is numeric for numeric types regardless of TEXT-vs-numeric storage class. */
export const nodePropSortKey = (nodeIdExpr: Expression, key: string): Expression =>
  q`(SELECT ${compareKey(raw('value'), raw('vtype'))} FROM vertex_properties WHERE node=${nodeIdExpr} AND key=${value(key)} ORDER BY id LIMIT 1)`;
export const edgePropSortKey = (edgeIdExpr: Expression, key: string): Expression =>
  q`(SELECT ${compareKey(raw('value'), raw('vtype'))} FROM edge_properties WHERE edge=${edgeIdExpr} AND key=${value(key)})`;

/** The vtype-aware sort key for `key` on the current element — the order()/min/max twin of
 *  scalarProp. Property (meta) elem falls back to the raw scalar (meta ordering is niche
 *  and its values carry no vtype column). */
export const scalarPropSortKey = (ctx: ScalarCtx, key: string): Expression =>
  ctx.elem === 'property' ? scalarProp(ctx, key)
  : ctx.elem === 'edge' ? edgePropSortKey(ctx.idExpr, key)
  : nodePropSortKey(ctx.idExpr, key);

/** A predicate OPERAND as SQL. A bare `constant(x)` operand was already folded to its literal by
 *  the foldConstantPredicateOperands pass, so a traversal still here is one that reads the
 *  traverser (`has("name", __.V(1).out("knows").values("name"))` — TinkerPop compares against its
 *  first result). That needs a correlated per-traverser value, which this pure SQL layer cannot
 *  build, so it DEFERS clearly. Without this it fell through to `value()` and the object reached
 *  SQLite as a bind, surfacing as "Binding expected string, TypedArray, …" — an opaque driver error
 *  a user cannot act on. An Expression operand passes through untouched (value() forwards nodes),
 *  which is the seam a future correlated operand plugs into. */
function operandSql(v: any): Expression {
  if (isNested(v))
    throw new Error('a traversal as a predicate operand is not yet supported unless it is a constant() — a per-traverser operand needs a correlated value');
  return value(v);
}

export function predicateSql(expr: Expression, pred: any, typeCtx: TypeCtx = TYPE_UNKNOWN): Expression {
  if (pred === undefined) return q`${expr} is not null`;
  if (pred === null || typeof pred !== 'object' || !('op' in pred)) return q`${expr} = ${operandSql(pred)}`;
  const { op, values: vals } = pred as Pred;
  if (op === 'not') return q`NOT (${predicateSql(expr, vals[0], typeCtx)})`;
  // Infix-composed predicates — `P.gt(20).and(P.lt(30))`, `TextP.startingWith('m').or(…)`. Both
  // operands test the SAME expression, so this is a plain boolean combination of the two rendered
  // predicates, and it nests to any depth because each operand recurses through here. The front-end
  // (parseComposedPredicate) is what turns the grammar's infix production into these ops; before it
  // existed the connective was lost and the second operand silently dropped.
  if (op === 'and' || op === 'or')
    return q`(${predicateSql(expr, vals[0], typeCtx)} ${raw(op.toUpperCase())} ${predicateSql(expr, vals[1], typeCtx)})`;
  if (op === 'typeOf') return typeOfSql(expr, vals[0], typeCtx);
  // Ordering comparisons (gt/gte/lt/lte, between/inside) go through the vtype-aware
  // compareKey (column) + compareBound (literal) so a TEXT-stored big long / bigdecimal /
  // duration orders NUMERICALLY, not lexically. Only when a per-row vtype is in scope
  // (has/is over a stored prop); without it (computed scalar) the value is already a native
  // JS type → raw compare, byte-identical to before. Equality (eq/neq/within/without)
  // stays a RAW compare: canonical text is exact (a big int / decimal matches itself) and
  // it keeps the value-index usable for the common eq case.
  const RANGE = new Set(['gt', 'gte', 'lt', 'lte']);
  const col = () => compareKey(expr, (typeCtx as Extract<TypeCtx, { kind: 'perRow' }>).expr);
  if (op in P_OPS) return RANGE.has(op) && typeCtx.kind === 'perRow'
    ? q`${col()} ${P_OPS[op]} ${compareBound(vals[0])}`
    : q`${expr} ${P_OPS[op]} ${operandSql(vals[0])}`;
  // SQLite rejects an empty `IN ()` list, so fold the degenerate sets to their
  // constant truth value: within nothing = never, without nothing = always.
  if (op === 'within') return vals.length ? q`${expr} in (${list(vals.map(operandSql), ', ')})` : q`0`;
  if (op === 'without') return vals.length ? q`${expr} not in (${list(vals.map(operandSql), ', ')})` : q`1`;
  // within/without whose operand is ONE list-valued traversal (`within(__.V()…fold())`) rather
  // than a vararg set. The members are only known at run time, so membership is a json_each
  // scan of the operand list, not an IN-list. Minted by the operand layer (steps/tail/operand.ts)
  // once it has resolved the traversal to a JSONB list; `within` above stays the vararg form.
  if (op === 'withinList' || op === 'withoutList') {
    // `expr IN (SELECT …)`, NOT `EXISTS (… WHERE je.value = expr)`. json_each exposes a column
    // literally named `value`, and hosts like hasProp hand us the UNQUALIFIED `value` column of
    // vertex_properties — inside the subquery that binds to json_each's own `value`, making the
    // test `je.value = je.value` and every row match. Keeping the operand on the left evaluates
    // it in the outer scope, where it means what the caller intended.
    const members = q`(SELECT je.value FROM json_each(${operandSql(vals[0])}) je)`;
    return op === 'withinList' ? q`${expr} IN ${members}` : q`${expr} NOT IN ${members}`;
  }
  // between = [lo, hi) inclusive low; inside = (lo, hi) exclusive low. With a stored vtype
  // both bounds and the column go through the numeric-aware compare; otherwise raw.
  if (op === 'between' || op === 'inside') {
    const lowOp = op === 'inside' ? '>' : '>=';
    if (typeCtx.kind !== 'perRow') return q`(${expr} ${lowOp} ${operandSql(vals[0])} and ${expr} < ${operandSql(vals[1])})`;
    return q`(${col()} ${lowOp} ${compareBound(vals[0])} and ${col()} < ${compareBound(vals[1])})`;
  }
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

// ---------- FTS-backed substring predicate (ftsSubstringPredicate fast path) ----------
//
// A POSITIVE substring predicate (containing/startingWith/endingWith) with a >= 3-char
// literal term over a STORED property routes through the property_fts trigram index instead
// of a base-table LIKE scan. The generic LIKE (nodeHasProp/edgeHasProp fall-through) stays
// the semantic authority + equivalence fallback (ftsSubstringPredicate:false, or a term
// too short / a computed-scalar context). See docs/archive/2026-07-20-call-service-registry-plan.md
// "Substring rule (final)". NEGATED ops (not*) stay on LIKE: the trigram index finds values
// that MATCH, not the "exists a value that does NOT match" the ANY-match negation needs.

const TRIGRAM_FLOOR = 3;

/** Whether an FTS rewrite applies to this predicate: a positive containing/startingWith/
 *  endingWith with a string literal term of >= 3 chars. Returns the pieces the EXISTS needs:
 *  the MATCH phrase (FTS query syntax — a literal phrase, internal `"` doubled) that
 *  prefilters via the index, and the LIKE pattern that confirms position for the anchored
 *  ops. null → not eligible (caller uses the generic LIKE). */
function ftsSubstringMatch(pred: any): { matchPhrase: string; likePat: string } | null {
  if (!pred || typeof pred !== 'object' || !('op' in pred)) return null;
  const op = (pred as Pred).op;
  if (op !== 'containing' && op !== 'startingWith' && op !== 'endingWith') return null;
  const term = (pred as Pred).values[0];
  if (typeof term !== 'string' || term.length < TRIGRAM_FLOOR) return null;
  const lp = likePattern(op, term)!;   // never null for these three ops
  // The MATCH arg is FTS query syntax (AND/OR/*/"/^ are operators), so wrap the term as a
  // literal phrase and double any internal `"`. It still substring-matches on a trigram index
  // even when the term is an operator word. Do NOT reuse LIKE's %/_/\ escaping here.
  return { matchPhrase: `"${term.replace(/"/g, '""')}"`, likePat: lp.pat };
}

/** An FTS-backed ANY-match EXISTS for a stored-property substring predicate: the owning
 *  element has a property `key` whose VALUE (kind='value') matches. MATCH is the index
 *  prefilter; the LIKE re-confirms position (so startingWith 'mar' excludes 'embarko'). */
function ftsSubstringExists(ownerElem: 'node' | 'edge', ownerIdExpr: Expression, key: string, m: { matchPhrase: string; likePat: string }): Expression {
  return q`EXISTS(SELECT 1 FROM property_fts WHERE owner_elem=${value(ownerElem)} AND owner=${ownerIdExpr} AND pk=${value(key)} AND kind=${value('value')} AND text MATCH ${value(m.matchPhrase)} AND text LIKE ${value(m.likePat)} escape ${value('\\')})`;
}

/** The ftsSubstringPredicate fast path. Recognition (ftsSubstringMatch: a >=3-char positive
 *  substring op) and the enable flag are consolidated here in appliesWhen — the boolean no longer
 *  threads through hasProp/nodeHasProp/edgeHasProp. tryLower emits the property_fts trigram EXISTS
 *  (result-equivalent to the generic LIKE, which stays the fallback + semantic authority). Fires at
 *  the has() choke point (the one site with a fastPaths config in scope); every other has-prop
 *  caller uses the generic LIKE. */
export const FtsSubstringFastPath: FastPath<[ScalarCtx, string, any], Expression> = {
  name: 'ftsSubstringPredicate',
  equivalentWhen: 'test/L5-properties/differential.test.ts — the fast-path differential; has(k, >=3-char substring) via property_fts vs. the LIKE fallback, both sides generated either side of the 3-char boundary',
  appliesWhen: (ctx, scalarCtx, _key, pred) =>
    ctx.enabled.ftsSubstringPredicate && (scalarCtx.elem === 'vertex' || scalarCtx.elem === 'edge') && ftsSubstringMatch(pred) !== null,
  tryLower: (_ctx, scalarCtx, key, pred) =>
    ftsSubstringExists(sqlElem(scalarCtx.elem as Elem), scalarCtx.idExpr, key, ftsSubstringMatch(pred)!),
};

/** range(low, high) → SQL [offset, limit]. high < 0 means "no upper bound". */
export function rangeToOffsetLimit(args: any[]): { offset: number; limit: number } {
  const [lo, hi] = args.map(Number);
  if (hi >= 0 && lo > hi) throw new Error(`Not a legal range: [${lo}, ${hi}]`);
  return { offset: lo, limit: hi < 0 ? -1 : hi - lo };
}

/** Whether the current traverser's `id` column is a node id or an edge id. The
 *  id-relation is typed but the type is *static* — known from the step chain, so
 *  no runtime tag is needed. V()/out()/…V() → node; E()/…E() → edge. */
export type Elem = 'vertex' | 'edge';

/** The persisted `property_fts.owner_elem` spelling. The ONE place a compiler ElemKind becomes
 *  the 'node' string, because that column holds real rows in a real Durable Object: renaming its
 *  VALUES is a silent data-compatibility break (pre-existing rows say 'node', new code would
 *  query 'vertex', and every TextP predicate would return [] with no error). Pinned by
 *  test/fts-index.test.ts. The `nodes` TABLE and `vertex_properties.node` COLUMN are the same
 *  rule at the schema level and likewise keep their names. */
export const sqlElem = (e: Elem): 'node' | 'edge' => (e === 'edge' ? 'edge' : 'node');

/** The (from,to) edge-column pairs a directional step walks: out→src/tgt,
 *  in→tgt/src, both→both. One place so the movement CTE and the correlated
 *  edge-count (edgeCountFrom) can't diverge. */
/** An edge's endpoint COLUMNS. Named because movement indexes `edges.c[dir]` dynamically,
 *  and `Relation` now types its column map — so a bare `string` here would be an implicit
 *  `any` read of a column that may not exist. */
export type EdgeEnd = 'src' | 'tgt';

/** The base table for an element kind — the ONE spelling of `elem === 'edge' ? edges : nodes`,
 *  which was written out at 17 sites. Returns the LOOSE `Relation` deliberately: callers branch
 *  on `elem` at runtime to reach the edge-only `src`/`tgt`, and a union of the two column maps
 *  cannot express that. `elemRel` (context.ts) is the ElementStream-shaped wrapper over this. */
export const elemTable = (elem: Elem): Relation => elem === 'edge' ? edges : nodes;

export const dirsFor = (name: string): [EdgeEnd, EdgeEnd][] =>
  name === 'out' ? [['src', 'tgt']] : name === 'in' ? [['tgt', 'src']] : [['src', 'tgt'], ['tgt', 'src']];

// ---------- nested-traversal by() → correlated scalar (shared with where) ----------

/** SQL exprs for the current traverser's base fields, in terms of the outer row
 *  (aliased `n`). A nested by(__.…) compiles to a scalar expression correlated
 *  on these. Property context carries the json_each expansion's columns. */
export interface ScalarCtx {
  elem: Elem | 'property';
  idExpr: Expression;        // n.id  (rowid — for correlated joins)
  extIdExpr?: Expression;    // COALESCE(n.uid, n.id) — the outward-facing id for framing
  // Both nodes AND edges now read props via idExpr into their normalized *_properties
  // table (scalarProp/hasProp dispatch on elem) — there is no flat-blob propsExpr.
  /** The element's label NAME as a scalar (a vertex PICKS one of its set). */
  labelNameExpr: Expression;
  /** The element's label as a wire PAYLOAD — ALL of them (see `labelPayloadFor`). */
  labelPayloadExpr: Expression;
  /** ANY-label membership test — hasLabel/has(T.label) semantics under multi-label. */
  labelMatch: (names: any[]) => Expression;
  srcExpr?: Expression;      // n.src  (edge)
  tgtExpr?: Expression;      // n.tgt  (edge)
  ownerExpr?: Expression;      // property: owning node id
  ownerPropsExpr?: Expression; // property: owner props (directly readable)
  pkExpr?: Expression;         // property: key column (a VertexProperty's T.label)
  pvExpr?: Expression;         // property: value column
  metaExpr?: Expression;       // property: the JSONB meta-property bag (by(String) → propExtract)
  // The repeat-loop counter, present ONLY inside an until() predicate (the recursive
  // walk's depth). Lets loops().is(P) lower as a leaf predicate that composes with the
  // element predicates through the same infix/and/or machinery — e.g.
  // until(__.has('name','x').or().loops().is(3)).
  loopsExpr?: Expression;
}

/** Build a node/edge ScalarCtx from the (aliased) element relation `n` — its
 *  typed columns become the correlated-scalar base exprs. src/tgt exist only on
 *  edges. Shared by where()/filter() (current traverser) and group() over an
 *  element stream. */
export function elemCtx(n: Relation, elem: Elem): ScalarCtx {
  return {
    elem, idExpr: n.c.id, extIdExpr: q`COALESCE(${n.c.uid}, ${n.c.id})`,
    labelNameExpr: labelNameFor(n, elem), labelPayloadExpr: labelPayloadFor(n, elem),
    labelMatch: (names) => labelMatchFor(n, elem, names),
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
    elem, idExpr,
    extIdExpr: sub('COALESCE(uid, id)'),
    labelNameExpr: elem === 'edge' ? labelNameSub(sub('label')) : vertexLabelName(idExpr),
    labelPayloadExpr: elem === 'edge' ? labelNameSub(sub('label')) : vertexLabelsJson(idExpr),
    labelMatch: (names) => elem === 'edge' ? labelIn(sub('label'), names) : vertexLabelIn(idExpr, names),
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

// ---------- the element payload seam ----------
//
// An element on the wire is a FIXED tuple — id, label, (src, tgt for an edge), props — and it was
// spelled out by hand at fourteen sites. They had already drifted: two of them emitted an edge's
// endpoints as INTERNAL rowids where the other twelve resolve them to external ids. Multi-label
// then had to be threaded through every one of them, which is the point at which a copied row-op
// stops being a style question. So the tuple gets ONE authority.
//
// `elemColumns`/`recordFieldColumns`/`pathColumns` (steps/context/stream.ts) NAME these columns;
// these build them, in the same order. Everything is derived from a `ScalarCtx` rather than a
// Relation so the correlated positions (an as()-bound alias, a recursive walk row, a group key)
// share it with the direct ones — `elemCtx(n, elem)` is the Relation adapter.

const payloadCol = (prefix: string, name: string): string => prefix ? `${prefix}_${name}` : name;

/** `expr AS name, …` for one element. `prefix` gives `e0_id`-style names ('' → bare `id`); `rid`
 *  prepends the INTERNAL rowid that a re-enterable record/group field carries so a later
 *  `select(Column.values)`/`unfold()` can rejoin even when the external id is a string uid. */
export function elementPayload(ctx: ScalarCtx, elem: ElemShape, prefix = '', rid = false): Expression {
  const as = (e: Expression, name: string) => q`${e} AS ${payloadCol(prefix, name)}`;
  if (elem === 'property')
    return list([as(ctx.ownerExpr!, 'owner'), as(ctx.pkExpr!, 'pk'), as(ctx.pvExpr!, 'pv')], ', ');
  return list([
    ...(rid ? [as(ctx.idExpr, 'rid')] : []),
    as(ctx.extIdExpr ?? ctx.idExpr, 'id'),
    as(ctx.labelPayloadExpr, 'label'),
    // Endpoints as EXTERNAL ids, so the read path's edge endpoints match the write path's.
    ...(elem === 'edge' ? [as(extIdOf(ctx.srcExpr!), 'src'), as(extIdOf(ctx.tgtExpr!), 'tgt')] : []),
    as(framedPropsCtx(ctx), 'props'),
  ], ', ');
}

/** The same payload as a `json_object(…)` — the form a materialized list member or a Map.Entry
 *  key/value carries, where the element rides inside a JSON value rather than as columns. */
export function elementPayloadObject(ctx: ScalarCtx, elem: Elem): Expression {
  return q`json_object(${list([
    q`'id', ${ctx.extIdExpr ?? ctx.idExpr}`,
    // A VERTEX's label payload is a JSON array, and `json()` pins SQLite's JSON SUBTYPE on it so
    // json_object NESTS it rather than quoting it as a string — the column form has no subtype to
    // carry, so the two producers hand the framer an array and a JSON string respectively, and
    // `labelsOf` takes both. Without the explicit json() this rides on the subtype surviving
    // COALESCE, which is not a guarantee worth depending on.
    elem === 'edge' ? q`'label', ${ctx.labelPayloadExpr}` : q`'label', json(${ctx.labelPayloadExpr})`,
    ...(elem === 'edge' ? [q`'src', ${extIdOf(ctx.srcExpr!)}`, q`'tgt', ${extIdOf(ctx.tgtExpr!)}`] : []),
    q`'props', json(${framedPropsCtx(ctx)})`,
  ], ', ')})`;
}

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
/** A stored property value projected for a READ (values() flatMap): a collection (vtype
 *  list/map/set) is a JSONB blob → `json()` it to TEXT so the framer can JSON.parse the
 *  self-describing {t,v} tree; a scalar passes through raw (keeps its SQLite storage class /
 *  exact-tail TEXT). Used at the materializing values() projector. The scalarProp paths
 *  below (by(key)/order/group-key) keep the raw column: a collection used AS a comparison /
 *  sort / group KEY is a degenerate out-of-family shape, unchanged by this feature. */
export const storedValueExpr = (valExpr: Expression, vtypeExpr: Expression): Expression =>
  q`CASE WHEN ${vtypeExpr} IN ('list','map','set') THEN json(${valExpr}) ELSE ${valExpr} END`;

/** Wrap a stored property (value, vtype) as a self-describing {t,v} JSON node for
 *  WHOLE-ELEMENT framing (valueMap/vertex/edge/properties): the aggregated props carry each
 *  value's type so the framer frames it EXACTLY (execute.ts frameTypedNode) instead of the
 *  client's serializers re-inferring it from the JS value (the #5 bug). A collection nests
 *  via json() (embedded, not double-encoded); a scalar rides as its raw storage value. */
export const propNodeExpr = (valExpr: Expression, vtypeExpr: Expression): Expression =>
  q`json_object('t', ${vtypeExpr}, 'v', ${storedValueExpr(valExpr, vtypeExpr)})`;

/** Infer a canonical gremlin type from a value's SQLite storage class, mirroring the JS
 *  value-inference the client would otherwise apply (execute.ts anySerializer): text→string,
 *  real→double, integer→int if it fits a 32-bit range else long, null→null. Used to tag a
 *  computed scalar (a group key/value) that carries no stored vtype, so a map VALUE built from
 *  it self-describes as a {t,v} node (mapstream-blob-model) instead of being re-inferred later. */
export const inferVtypeSql = (valExpr: Expression): Expression =>
  q`CASE typeof(${valExpr})
      WHEN 'text' THEN 'string' WHEN 'real' THEN 'double' WHEN 'null' THEN NULL
      WHEN 'integer' THEN (CASE WHEN ${valExpr} BETWEEN -2147483648 AND 2147483647 THEN 'int' ELSE 'long' END)
      ELSE 'string' END`;

/** Build a self-describing {t,v} node for a scalar, from the BEST type channel available:
 *  `vtypeExpr` (a per-row stored-vtype column — the exact type the write channel recorded),
 *  else `staticType` (statically known, e.g. a count is always 'long'), else inferred from
 *  storage class. The one place a group/valueMap/folded scalar side is tagged for the uniform
 *  typed blob encoding. A per-row column beats a static tag because it is the truth channel
 *  rather than a compile-time approximation; today no call site supplies both. */
export const typedScalarNode = (
  valExpr: Expression,
  opts?: { staticType?: string; vtypeExpr?: Expression },
): Expression =>
  propNodeExpr(
    valExpr,
    opts?.vtypeExpr ?? (opts?.staticType ? value(opts.staticType) : inferVtypeSql(valExpr)),
  );

export const nodePropScalar = (nodeIdExpr: Expression, key: string): Expression =>
  q`(SELECT value FROM vertex_properties WHERE node=${nodeIdExpr} AND key=${value(key)} ORDER BY id LIMIT 1)`;

/** The stored type paired with nodePropScalar's first-under-multi value. Keep this as
 * a sibling subquery rather than inferring from SQLite's lossy storage class. */
export const nodePropType = (nodeIdExpr: Expression, key: string): Expression =>
  q`(SELECT vtype FROM vertex_properties WHERE node=${nodeIdExpr} AND key=${value(key)} ORDER BY id LIMIT 1)`;

/** node: does ANY value under `key` satisfy `pred` (undefined → the key exists at
 *  all). EXISTS over vertex_properties → multi-property has() semantics. The generic LIKE
 *  path is the semantic authority; the ftsSubstringPredicate fast path (FtsSubstringFastPath)
 *  is applied one level up, at the has() choke point, and only replaces this when it fires. */
export const nodeHasProp = (nodeIdExpr: Expression, key: string, pred: any): Expression => {
  const base = q`SELECT 1 FROM vertex_properties WHERE node=${nodeIdExpr} AND key=${value(key)}`;
  // The row's own `vtype` column is in scope inside the EXISTS, so has('k',typeOf(X))
  // matches the stored canonical type (mode 2) instead of only storage class.
  return pred === undefined ? q`EXISTS(${base})` : q`EXISTS(${base} AND ${predicateSql(raw('value'), pred, TYPE_PER_ROW(raw('vtype')))})`;
};

/** edge: the value under `key` as a correlated scalar. Edge props are single-cardinality
 *  (one row per (edge,key), UNIQUE-enforced), so no ORDER BY / LIMIT dance is needed —
 *  the mirror of nodePropScalar for the normalized edge_properties table. */
export const edgePropScalar = (edgeIdExpr: Expression, key: string): Expression =>
  q`(SELECT value FROM edge_properties WHERE edge=${edgeIdExpr} AND key=${value(key)})`;

/** The stored type paired with edgePropScalar's single-cardinality value. */
export const edgePropType = (edgeIdExpr: Expression, key: string): Expression =>
  q`(SELECT vtype FROM edge_properties WHERE edge=${edgeIdExpr} AND key=${value(key)})`;

/** edge: does `key` satisfy `pred` (undefined → the key exists). EXISTS over
 *  edge_properties — mirror of nodeHasProp. */
export const edgeHasProp = (edgeIdExpr: Expression, key: string, pred: any): Expression => {
  const base = q`SELECT 1 FROM edge_properties WHERE edge=${edgeIdExpr} AND key=${value(key)}`;
  return pred === undefined ? q`EXISTS(${base})` : q`EXISTS(${base} AND ${predicateSql(raw('value'), pred, TYPE_PER_ROW(raw('vtype')))})`;
};

/** edge: all props as flat JSON text `{key:value}` (single-valued per key), correlated
 *  on the edge rowid. Empty → `{}`. Mirror of vertexPropsAgg (which nests `[values]`
 *  for multi-property vertices; edges are single so the value is bare). */
export const edgePropsAgg = (edgeIdExpr: Expression): Expression =>
  q`COALESCE((SELECT json_group_object(key, ${propNodeExpr(raw('value'), raw('vtype'))}) FROM edge_properties WHERE edge=${edgeIdExpr}), '{}')`;

/** edge: valueMap props as `{key:[value]}` (each value wrapped in a 1-list so the
 *  handler frames node + edge valueMaps uniformly). */
export const edgeValueMapProps = (edgeIdExpr: Expression): Expression =>
  q`COALESCE((SELECT json_group_object(key, json_array(${propNodeExpr(raw('value'), raw('vtype'))})) FROM edge_properties WHERE edge=${edgeIdExpr}), '{}')`;

/** A single scalar value for `key` on the current element (order/group-key/by(key)):
 *  node → first-under-multi; edge → the single value. Both read their normalized table. */
export const scalarProp = (ctx: ScalarCtx, key: string): Expression =>
  ctx.elem === 'property' ? propExtract(ctx.metaExpr!, key).expr  // a VertexProperty's by(String) reads its meta-property
  : ctx.elem === 'edge' ? edgePropScalar(ctx.idExpr, key)
  : nodePropScalar(ctx.idExpr, key);

/** A boolean predicate on `key` for the current element (has/where/is): node → ANY-match
 *  EXISTS over vertex_properties; edge → EXISTS over edge_properties. */
export const hasProp = (ctx: ScalarCtx, key: string, pred: any): Expression =>
  ctx.elem === 'edge' ? edgeHasProp(ctx.idExpr, key, pred) : nodeHasProp(ctx.idExpr, key, pred);

/** node: assemble ALL properties as JSON text `{key:[value,…]}` (multi-valued,
 *  insertion-ordered) from vertex_properties, correlated on the node rowid. Empty →
 *  `{}`. JSON text (not JSONB) — computed on the fly, so the handler JSON.parses it. */
export const vertexPropsAgg = (nodeIdExpr: Expression): Expression =>
  q`COALESCE((SELECT json_group_object(key, json(vs)) FROM (SELECT key, json_group_array(${propNodeExpr(raw('value'), raw('vtype'))} ORDER BY id) AS vs FROM vertex_properties WHERE node=${nodeIdExpr} GROUP BY key ORDER BY MIN(id))), '{}')`;

/** The props expression for framing a whole element out. Node: vertexPropsAgg
 *  ({key:[values]}); edge: edgePropsAgg ({key:value}), both over the rowid. */
export const framedProps = (rel: Relation, elem: Elem): Expression =>
  elem === 'edge' ? edgePropsAgg(rel.c.id) : vertexPropsAgg(rel.c.id);

/** framedProps from a ScalarCtx (group()/element framing): edge → edgePropsAgg on the
 *  ctx rowid; node → vertexPropsAgg on the ctx rowid. */
export const framedPropsCtx = (ctx: ScalarCtx): Expression =>
  ctx.elem === 'edge' ? edgePropsAgg(ctx.idExpr) : vertexPropsAgg(ctx.idExpr);

/** valueMap()'s props: ALWAYS {key:[values]} (values wrapped in a list) for both
 *  runtimes' handler. Node = vertexPropsAgg; edge = wrap each single value in a 1-list.
 *  Values are self-describing {t,v} nodes (propNodeExpr) so whole-element framing (§5)
 *  frames each by its exact type. */
export const valueMapProps = (rel: Relation, elem: Elem): Expression =>
  elem === 'edge' ? edgeValueMapProps(rel.c.id) : vertexPropsAgg(rel.c.id);

// A stored value with the {t,v} envelope STRIPPED to a plain value, for the untyped
// `select(Column.values)` re-entry (below): a scalar → raw; a list/set → a JSON array of
// its elements' bare payloads (`-> '$.v'` preserves each element's JSON type, `json(…)`
// re-embeds so it nests as an array, not a double-encoded string). One level deep — the
// realistic shape (a list-of-scalars property value); deeper nesting or a map value falls
// through as the typed tree (deferred, matching the typed-element-through-select(values)
// scope — astronomically rare as a single stored property value). `v`/`vt` MUST be qualified
// column refs (e.g. `p.value`) — a bare `value` inside the inner `json_each` would shadow to
// json_each's own `value` column and iterate nothing.
const bareStoredValueExpr = (v: Expression, vt: Expression): Expression =>
  q`CASE WHEN ${vt} IN ('list','set')
    THEN json((SELECT json_group_array(e.value -> '$.v' ORDER BY e.key) FROM json_each(${v}) e))
    ELSE ${storedValueExpr(v, vt)} END`;

/** valueMap props with BARE values (no {t,v} envelope) for the `select(Column.values)`
 *  RE-ENTRY (group.ts lowerValueMap), which feeds the UNTYPED list substrate (set-ops/
 *  order/conjoin). A scalar rides raw; a list/set value round-trips as a real nested JSON
 *  array (not the typed tree, and not a double-encoded string). The TERMINAL valueMap
 *  framing uses the TYPED valueMapProps above; only this re-entry drops element types. */
export const bareValueMapProps = (rel: Relation, elem: Elem): Expression =>
  elem === 'edge'
    ? q`COALESCE((SELECT json_group_object(p.key, json_array(${bareStoredValueExpr(raw('p.value'), raw('p.vtype'))})) FROM edge_properties p WHERE p.edge=${rel.c.id}), '{}')`
    : q`COALESCE((SELECT json_group_object(key, json(vs)) FROM (SELECT p.key AS key, json_group_array(${bareStoredValueExpr(raw('p.value'), raw('p.vtype'))} ORDER BY p.id) AS vs FROM vertex_properties p WHERE p.node=${rel.c.id} GROUP BY p.key ORDER BY MIN(p.id))), '{}')`;
