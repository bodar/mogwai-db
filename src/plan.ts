import { stepChain, type Step, type Pred } from './frontend.ts';
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
/** hasId(...) args → a single predicate over the external id. A lone P argument
 *  passes through (P.within/without/eq/neq/…); otherwise the bare id args form a
 *  `within` set (nulls dropped — no element has a null id, so they never match). */
export function idPredFromArgs(args: any[]): any {
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
export function compileFilterPredicate(nested: Step[], ctx: ScalarCtx, params: Record<string, any> = {}): { expr: Expression; indexKeys: string[] } {
  const indexKeys: string[] = [];
  let body = nested;
  let isPred: any = undefined, hasIs = false;
  if (body[body.length - 1]?.name === 'is') { isPred = body[body.length - 1].args[0]; hasIs = true; body = body.slice(0, -1); }

  const head = body[0]?.name;
  if (!head) throw new Error('empty where()/filter() traversal');

  // and(t…)/or(t…): combine each branch's predicate. (infix .and()/.or() — a
  // multi-step body — is not this shape and falls through to the deferred throw.)
  if ((head === 'and' || head === 'or') && body.length === 1)
    return combineBranchPreds(body[0], ctx, params, head === 'and' ? 'AND' : 'OR');

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
  if (head === 'has' && body.length === 1 && typeof body[0].args[0] === 'string') {
    const pe = propExtract(ctx.propsExpr, body[0].args[0]);
    if (pe.indexKey && ctx.elem === 'node') indexKeys.push(pe.indexKey);
    return { expr: predicateSql(pe.expr, body[0].args[1]), indexKeys };
  }
  if (head === 'hasLabel' && body.length === 1)
    return { expr: labelIn(ctx.labelIdExpr, body[0].args), indexKeys };
  if (head === 'hasId' && body.length === 1)
    return { expr: predicateSql(ctx.extIdExpr!, idPredFromArgs(body[0].args)), indexKeys };

  if (MOVES.has(head) && body.length === 1) {
    // where(__.out().is(P)) would mean "has a neighbour satisfying P" — the bare
    // EXISTS ignores P, so reject rather than silently drop it.
    if (hasIs) throw new Error(`where(__.${head}().is(P)) not yet supported`);
    return { expr: compileExists(body[0], ctx), indexKeys };
  }
  throw new Error(`where()/filter() form not yet supported: __.${body.map((s) => s.name + '()').join('.')}`);
}

/** and(t…)/or(t…): each branch → a filter predicate node, joined by AND/OR
 *  (`((p0) AND (p1))`). Used both as a top-level filter step and inside where(__.and/or). */
export function combineBranchPreds(step: Step, ctx: ScalarCtx, params: Record<string, any>, op: 'AND' | 'OR'): { expr: Expression; indexKeys: string[] } {
  const branches = step.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 2) throw new Error(`${step.name}() needs at least two traversal branches`);
  const indexKeys: string[] = [];
  const parts = branches.map((b) => {
    const p = compileFilterPredicate(stepChain(b.nested, params), ctx, params);
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
  const terms = dirs.map(([from]) =>
    q`EXISTS(SELECT 1 FROM edges e WHERE e.${from}=${ctx.idExpr}${edgeLabelFilter(mv.args)})`);
  return terms.length === 1 ? terms[0] : paren(list(terms, ' OR '));
}
