import { stepChain, flattenListArgs, type Step, type Pred } from './frontend.ts';
import { q, list, values, paren, empty, value, raw, jsonExtract, type Expression, type Relation } from './q.ts';

// ---------- SQL node builders ----------
//
// The bind-safe leaf layer: turn IR fragments (property keys, predicates, label
// filters, directions) into lazyrecords Expression nodes. Bound values live as
// Value tokens in the tree — no `?`+parallel-array splicing. The step compilers
// (compiler.ts) consume these and assemble CTEs; the render()/compiled() seam
// (render.ts) turns finished trees into {sql, binds}.

export const P_OPS: Record<string, string> = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/** `json_extract(col, '$.key')` for a property key. The lazyrecords jsonExtract
 *  node owns the literal-vs-bound path splice (a safe identifier key is spliced
 *  literally so an expression index on that exact path engages; exotic keys bind)
 *  and reports the spliced key via `.indexKey`. The column is a bind-free fragment
 *  (`n.props`) wrapped as raw text() so it renders unquoted — index-eligible. */
export function propExtract(col: Expression | string, key: unknown): { expr: Expression; indexKey: string | null } {
  if (typeof key !== 'string') throw new Error('property key must be a string');
  // A string column is a bind-free fragment (`n.props`) → raw text so the literal
  // json path renders unquoted (index-eligible); a Relation column arrives typed.
  const node = jsonExtract(typeof col === 'string' ? raw(col) : col, key);
  return { expr: node, indexKey: node.indexKey };
}

/** `<col> IN (SELECT id FROM labels WHERE name IN (?,?))` — the canonical
 *  label-name→id filter as a node. Names ride as bound Value tokens (no splice). */
export function labelIn(col: Expression | string, names: any[]): Expression {
  return q`${col} IN (SELECT id FROM labels WHERE name IN (${values(names)}))`;
}

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
/** Per-element scalar string/cast transforms (map to SQLite scalar functions).
 *  Returns a new value expression wrapping `v`, or null if `name` isn't a
 *  transform. NULL propagates through every function (SQLite semantics), matching
 *  Gremlin's null-in→null-out. A trailing Scope token is a no-op on a scalar
 *  stream (per-element == per-list), so it's simply ignored. Deferred: reverse
 *  (no SQLite builtin), split (list-valued), trim family (Unicode-whitespace). */
export function scalarTx(name: string, args: any[], v: Expression): Expression | null {
  const nums = args.filter((a) => typeof a === 'number');
  const strs = args.filter((a) => typeof a === 'string');
  switch (name) {
    case 'concat': return strs.length ? q`${v}${list(strs.map((a) => q` || ${value(a)}`), '')}` : v;
    case 'length': return q`length(${v})`;
    case 'toUpper': return q`upper(${v})`;
    case 'toLower': return q`lower(${v})`;
    case 'asString': return q`CAST(${v} AS TEXT)`;
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

// GType → SQLite `typeof()` category. `null` = a recognized Gremlin type we don't
// distinctly represent in JSON storage (boolean is stored as int, char/uuid/etc.
// never occur), so it can never match → folds to constant false. `undefined` =
// not a registered type name → the caller raises (matches the spec's error case).
const GTYPE_SQL: Record<string, string | null> = {
  string: 'text',
  int: 'integer', integer: 'integer', long: 'integer', short: 'integer',
  byte: 'integer', bigint: 'integer', biginteger: 'integer',
  double: 'real', float: 'real', bigdecimal: 'real',
  boolean: null, char: null, binary: null, uuid: null, datetime: null,
  duration: null, tree: null, edge: null, vertex: null, vertexproperty: null,
  vproperty: null, property: null, list: null, map: null, set: null, path: null,
  graph: null,
};

/** P.typeOf(GType|"ClassName") → a SQL type test over `expr`. `null` type folds
 *  to false; unknown/unregistered names raise (spec: "traversal will raise an error"). */
function typeOfSql(expr: Expression, arg: any): Expression {
  const name = (arg && typeof arg === 'object' && 'gtype' in arg) ? String(arg.gtype)
    : typeof arg === 'string' ? arg.toLowerCase()
    : (() => { throw new Error('typeOf() requires a GType argument'); })();
  if (name === 'null') return q`${expr} is null`;
  if (!(name in GTYPE_SQL)) throw new Error(`typeOf(): unregistered type '${name}'`);
  const sqlType = GTYPE_SQL[name];
  return sqlType === null ? q`0` : q`typeof(${expr}) = ${value(sqlType)}`;
}

export function predicateSql(expr: Expression, pred: any): Expression {
  if (pred === undefined) return q`${expr} is not null`;
  if (pred === null || typeof pred !== 'object' || !('op' in pred)) return q`${expr} = ${value(pred)}`;
  const { op, values: vals } = pred as Pred;
  if (op === 'not') return q`NOT (${predicateSql(expr, vals[0])})`;
  if (op === 'typeOf') return typeOfSql(expr, vals[0]);
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
  propsExpr: Expression;     // n.props   (base row, directly readable)
  labelIdExpr: Expression;   // n.label
  srcExpr?: Expression;      // n.src  (edge)
  tgtExpr?: Expression;      // n.tgt  (edge)
  ownerExpr?: Expression;      // property: owning node id
  ownerPropsExpr?: Expression; // property: owner props (directly readable)
  pkExpr?: Expression;         // property: key column
  pvExpr?: Expression;         // property: value column
}

interface Scalar { expr: Expression; indexKey: string | null }

/** Build a node/edge ScalarCtx from the (aliased) element relation `n` — its
 *  typed columns become the correlated-scalar base exprs. src/tgt exist only on
 *  edges. Shared by where()/filter() (current traverser) and group() over an
 *  element stream. */
export function elemCtx(n: Relation, elem: Elem): ScalarCtx {
  return {
    elem, idExpr: n.c.id, extIdExpr: q`COALESCE(${n.c.uid}, ${n.c.id})`,
    propsExpr: n.c.props, labelIdExpr: n.c.label,
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
    elem, idExpr, extIdExpr: sub('COALESCE(uid, id)'), propsExpr: sub('props'), labelIdExpr: sub('label'),
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

/** json_extract of a property on a node identified by `nodeId`. `directProps`,
 *  when set, is a props column already in scope (base row) → read it inline;
 *  otherwise correlate a subquery into nodes. */
export function propAt(nodeId: Expression | string, directProps: Expression | string | null, key: unknown): Scalar {
  if (directProps) return propExtract(directProps, key);
  // Correlated subquery: keep the json_extract node as a child so any exotic-key
  // bind stays a Value token (nodeId is a bind-free fragment / typed column).
  const pe = propExtract('props', key);
  return { expr: q`(SELECT ${pe.expr} FROM nodes WHERE id=${nodeId})`, indexKey: null };
}

/**
 * Compile a nested traversal (the node inside by(__.…)/where(__.…)) to a
 * correlated SQL scalar expression. Focused on the proven step set — the L3
 * gate's key/value sub-traversals plus common where idioms:
 *   node ctx:  values(k) | label() | id() | out|in|both([lbl])…count()
 *   edge ctx:  outV|inV()[.values(k)|.label()|.id()] | values(k) | label() | id()
 *   prop ctx:  key() | value() | element()[.values(k)|.label()|.id()]
 * Anything past this throws clearly (never silently mis-executes).
 */
export function compileNestedScalar(inner: Step[], ctx: ScalarCtx): Scalar {
  let steps = inner;
  // A pointer to the "current node" for terminal value/label/id reads.
  let nodeId: Expression;
  let directProps: Expression | null;   // props readable inline (base row), else null → subquery
  let directLabelId: Expression | null; // label id readable inline, else null → subquery via nodes

  const head = steps[0]?.name;
  if (!head) throw new Error('empty nested traversal');

  if (ctx.elem === 'property') {
    if (head === 'key') { requireTerminal(steps, 1); return { expr: ctx.pkExpr!, indexKey: null }; }
    if (head === 'value') { requireTerminal(steps, 1); return { expr: ctx.pvExpr!, indexKey: null }; }
    if (head === 'element') { nodeId = ctx.ownerExpr!; directProps = ctx.ownerPropsExpr!; directLabelId = null; steps = steps.slice(1); }
    else throw new Error(`by(__.${head}()) over a property not yet supported`);
  } else if (ctx.elem === 'edge') {
    if (head === 'outV' || head === 'inV') { nodeId = head === 'outV' ? ctx.srcExpr! : ctx.tgtExpr!; directProps = null; directLabelId = null; steps = steps.slice(1); }
    else if (head === 'label') { requireTerminal(steps, 1); return { expr: labelNameSub(ctx.labelIdExpr), indexKey: null }; }
    else if (head === 'id') { requireTerminal(steps, 1); return { expr: ctx.idExpr, indexKey: null }; }
    else if (head === 'values') { requireTerminal(steps, 1); return propAt(ctx.idExpr, ctx.propsExpr, steps[0].args[0]); }
    // out()/in()/both() are NOT valid on an edge (must go through outV()/inV());
    // routing them to edgeCountFrom here would compare edges.src to the edge's own
    // id and silently mis-count, so let them hit the clear throw below.
    else throw new Error(`by(__.${head}()) over an edge not yet supported`);
  } else { // node
    nodeId = ctx.idExpr; directProps = ctx.propsExpr; directLabelId = ctx.labelIdExpr;
    if (MOVES.has(head)) return edgeAggFrom(steps, ctx.idExpr);
  }

  // Terminal projection on the resolved current node.
  const s = steps[0];
  if (!s) throw new Error('nested traversal resolves to no projection');
  switch (s.name) {
    case 'values': requireTerminal(steps, 1); return propAt(nodeId, directProps, s.args[0]);
    case 'label':  requireTerminal(steps, 1); return { expr: labelNameSub(directLabelId ?? q`(SELECT label FROM nodes WHERE id=${nodeId})`), indexKey: null };
    case 'id':     requireTerminal(steps, 1); return { expr: nodeId, indexKey: null };
    // constant(x): a fixed scalar per traverser — the common choose().option() body.
    case 'constant': requireTerminal(steps, 1); return { expr: value(s.args[0]), indexKey: null };
    default: throw new Error(`by(__.${s.name}()) not yet supported`);
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
    return { expr: q`(SELECT COUNT(*) FROM edges WHERE ${incidence}${lbl})`, indexKey: null };

  // …values(k).<reducer>() aggregates an edge property. E-forms only: on a bare
  // out()/in()/both() the value would come from the NEIGHBOUR vertex (a join),
  // which is a separate, unimplemented shape.
  if (mv.name.endsWith('E') && steps[1]?.name === 'values' && steps.length === 3 && steps[2].name in AGG_FN && steps[2].name !== 'count') {
    const pe = propExtract('props', steps[1].args[0]);
    return { expr: q`(SELECT ${AGG_FN[steps[2].name]}(${pe.expr}) FROM edges WHERE ${incidence}${lbl})`, indexKey: null };
  }
  throw new Error(`by(__.${mv.name}(…)) only supports a terminal count() or values(k).sum/min/max/mean() for now`);
}

const requireTerminal = (steps: Step[], n: number) => {
  if (steps.length > n) throw new Error(`step not implemented in nested traversal: ${steps[n].name}()`);
};

// ---------- where()/not()/filter(__.…) → a boolean filter predicate ----------

/**
 * Compile a where()/filter() nested traversal into a boolean SQL predicate
 * correlated on the current traverser (for `WHERE [NOT] <pred>`). Supported:
 *   __.<move>.count().is(P)   → correlated count compared (reuses compileNestedScalar)
 *   __.values(k)[.is(P)]      → current-property predicate (bare → IS NOT NULL)
 *   __.has(k[,v]) / hasLabel  → current-element predicate
 *   __.<move>([label])        → EXISTS over incident edges (bare "has a neighbour")
 *   __.and(t…) / __.or(t…)    → the branch predicates combined with AND / OR
 * Multi-hop / neighbour-terminal-filter are deferred with clear errors.
 */
export function compileFilterPredicate(
  nested: Step[], ctx: ScalarCtx, params: Record<string, any> = {},
  resolveAlias?: (label: string) => ScalarCtx,
): { expr: Expression; indexKeys: string[] } {
  const indexKeys: string[] = [];

  // A leading as('x')/select('x') re-roots the predicate on the aliased traverser:
  // where(__.as('b').out('created').has('name','ripple')) correlates on b's column.
  const h0 = nested[0];
  if (resolveAlias && nested.length > 1 && (h0.name === 'as' || h0.name === 'select')
      && h0.args.length === 1 && typeof h0.args[0] === 'string')
    return compileFilterPredicate(nested.slice(1), resolveAlias(h0.args[0]), params, resolveAlias);

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
    if (!hasIs) return { expr: q`1`, indexKeys };
    return { expr: predicateSql(compileNestedScalar(body, ctx).expr, isPred), indexKeys };
  }

  // Current-element predicates (no movement).
  if (head === 'values' && body.length === 1) {
    const pe = propExtract(ctx.propsExpr, body[0].args[0]);
    if (pe.indexKey && ctx.elem === 'node') indexKeys.push(pe.indexKey);
    return { expr: predicateSql(pe.expr, hasIs ? isPred : undefined), indexKeys }; // bare where(__.values(k)) → exists → IS NOT NULL
  }
  if (head === 'has' && body.length === 1) {
    const [key, val] = body[0].args;
    // has(T.label|T.id, v|P): predicate over the label name / external id (mirrors
    // filter.ts has()'s token branch, so choose(__.has(T.label,'person')) etc work).
    if (key && typeof key === 'object' && 'token' in key) {
      const expr: Expression = key.token === 'label' ? labelNameSub(ctx.labelIdExpr)
        : key.token === 'id' ? ctx.extIdExpr!
        : (() => { throw new Error(`has(T.${key.token}) not supported`); })();
      return { expr: predicateSql(expr, val), indexKeys };
    }
    if (typeof key === 'string') {
      const pe = propExtract(ctx.propsExpr, key);
      if (pe.indexKey && ctx.elem === 'node') indexKeys.push(pe.indexKey);
      return { expr: predicateSql(pe.expr, val), indexKeys };
    }
  }
  if (head === 'hasLabel' && body.length === 1)
    return { expr: labelIn(ctx.labelIdExpr, body[0].args), indexKeys };
  if (head === 'hasId' && body.length === 1)
    return { expr: predicateSql(ctx.extIdExpr!, idPredFromArgs(body[0].args)), indexKeys };

  // where(__.label()[.is(P)]) — predicate on the current element's label name.
  if (head === 'label' && body.length === 1)
    return { expr: predicateSql(labelNameSub(ctx.labelIdExpr), hasIs ? isPred : undefined), indexKeys };

  // where(__.not(t)) — negate an inner predicate; a NULL (missing) is kept (NOT COALESCE).
  if (head === 'not' && body.length === 1) {
    const arg = body[0].args.find((a: any) => a && typeof a === 'object' && 'nested' in a);
    if (!arg) throw new Error('not() requires a traversal');
    const inner = compileFilterPredicate(stepChain(arg.nested, params), ctx, params, resolveAlias);
    indexKeys.push(...inner.indexKeys);
    return { expr: q`NOT COALESCE((${inner.expr}), 0)`, indexKeys };
  }

  if (MOVES.has(head))
    // A movement chain → a correlated EXISTS over the path, with an optional terminal
    // filter (has/hasLabel/values.is) on the last node. (count/sum handled above.)
    return { expr: compileExistsChain(body, ctx, isPred, hasIs), indexKeys };
  throw new Error(`where()/filter() form not yet supported: __.${body.map((s) => s.name + '()').join('.')}`);
}

/** and(t…)/or(t…): each branch → a filter predicate node, joined by AND/OR
 *  (`((p0) AND (p1))`). Used both as a top-level filter step and inside where(__.and/or). */
export function combineBranchPreds(
  step: Step, ctx: ScalarCtx, params: Record<string, any>, op: 'AND' | 'OR',
  resolveAlias?: (label: string) => ScalarCtx,
): { expr: Expression; indexKeys: string[] } {
  const branches = step.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 2) throw new Error(`${step.name}() needs at least two traversal branches`);
  const indexKeys: string[] = [];
  const parts = branches.map((b) => {
    const p = compileFilterPredicate(stepChain(b.nested, params), ctx, params, resolveAlias);
    indexKeys.push(...p.indexKeys);
    return paren(p.expr);
  });
  return { expr: paren(list(parts, ` ${op} `)), indexKeys };
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
    if (terminal.name === 'has' && typeof terminal.args[0] === 'string')
      conds.push(predicateSql(propExtract(`${last}.props`, terminal.args[0]).expr, terminal.args[1]));
    else if (terminal.name === 'hasLabel')
      conds.push(labelIn(`${last}.label`, terminal.args));
    else if (terminal.name === 'values' && typeof terminal.args[0] === 'string')
      conds.push(predicateSql(propExtract(`${last}.props`, terminal.args[0]).expr, hasIs ? isPred : undefined));
    else throw new Error(`where() chain terminal __.${terminal.name}() not yet supported`);
  } else if (hasIs) {
    throw new Error(`where(__.${moves.map((m) => m.name + '()').join('.')}.is(P)) not yet supported`);
  }
  return q`EXISTS(SELECT 1 FROM ${list(parts, ' ')} WHERE ${list(conds, ' AND ')})`;
}
