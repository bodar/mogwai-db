import { render } from './render.ts';
import { type Pred } from './frontend.ts';
import { type Expression } from '@bodar/lazyrecords/sql/template/Expression.ts';
import { text as sqlText } from '@bodar/lazyrecords/sql/template/Text.ts';
import { expression, and, parens } from '@bodar/lazyrecords/sql/template/Compound.ts';
import { value } from '@bodar/lazyrecords/sql/template/Value.ts';
import { jsonExtract } from '@bodar/lazyrecords/sql/sqlite/jsonExtract.ts';
import { comparison, type ComparisonOperator } from '@bodar/lazyrecords/sql/ansi/ComparisonExpression.ts';
import { isNotNull } from '@bodar/lazyrecords/sql/ansi/NullExpression.ts';
import { like, notLike } from '@bodar/lazyrecords/sql/ansi/LikeExpression.ts';
import { inExpression, notIn } from '@bodar/lazyrecords/sql/ansi/InExpression.ts';

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
export function propExtract(col: string, key: unknown): { expr: Expression; indexKey: string | null } {
  if (typeof key !== 'string') throw new Error('property key must be a string');
  const node = jsonExtract(sqlText(col), key);
  return { expr: node, indexKey: node.indexKey };
}

/** `<col> IN (SELECT id FROM labels WHERE name IN (?,?))` — the canonical
 *  label-name→id filter. Names ride as bound Value tokens (node-built, no splice). */
export function labelIn(col: string, names: any[]): { sql: string; binds: any[] } {
  return render(expression(sqlText(`${col} IN (SELECT id FROM labels WHERE name IN`), parens(names.map(value)), sqlText(')')));
}

/** Optional ` AND e.label IN (…)` appended to a movement JOIN's ON. Empty when
 *  no labels. Replaces ~7 hand-rolled `?`-splice + manual bind-push copies. */
export function edgeLabelFilter(names: any[]): { sql: string; binds: any[] } {
  if (!names.length) return { sql: '', binds: [] };
  const r = labelIn('e.label', names);
  return { sql: ` AND ${r.sql}`, binds: r.binds };
}

/**
 * A boolean SQL predicate over a pre-built column Expression, shared by
 * has()/is()/where(). `expr` is a node (json_extract, a column, a subquery); its
 * binds ride as Value tokens. `pred` is a `Pred` {op,values}, a bare literal
 * (→ equality), or `undefined` (existence → IS NOT NULL). The predicate tail
 * (comparison/in/like/isNotNull) is placed after `expr` via expression(); for
 * between/inside `expr` is shared into both bounds so its binds fall out twice in
 * order — no manual double-splice. TextP → LIKE with a bound pattern; regex/typeOf throw.
 */
export function predicateSql(expr: Expression, pred: any): Expression {
  if (pred === undefined) return expression(expr, isNotNull());
  if (pred === null || typeof pred !== 'object' || !('op' in pred))
    return expression(expr, comparison('=', pred));
  const { op, values } = pred as Pred;
  if (op in P_OPS) return expression(expr, comparison(P_OPS[op] as ComparisonOperator, values[0]));
  if (op === 'within') return expression(expr, inExpression(values));
  if (op === 'without') return expression(expr, notIn(values));
  // between = [lo, hi) inclusive low; inside = (lo, hi) exclusive low.
  if (op === 'between' || op === 'inside')
    return and(expression(expr, comparison(op === 'inside' ? '>' : '>=', values[0])),
               expression(expr, comparison('<', values[1])));
  const lp = likePattern(op, values[0]);
  if (lp) return expression(expr, lp.neg ? notLike(lp.pat, '\\') : like(lp.pat, '\\'));
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
