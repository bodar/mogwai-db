import type { Expr } from './expr.ts';
import type { Rel } from './rel.ts';
import { forEachRel } from './walk.ts';

/**
 * MAY THIS VALUE CARRY SQLITE'S JSON SUBTYPE — the invisible tag that makes `json_array(x)` nest `x` as
 * JSON rather than quote it as a string.
 *
 * The tag lives only inside one SELECT: an expression the emitter fuses into its reader keeps it, while
 * a column read back off a relation SQLite actually materializes or runs as a co-routine has lost it
 * (https://sqlite.org/c3ref/value_subtype.html — subtypes do not survive storage). So a boundary the
 * emitter ADDS for performance (`fenced` in `emit.ts`) may only carry values this answers `false` for,
 * or a nested element would frame as a quoted string. Conservative by construction: anything it cannot
 * see through answers `true`.
 *
 * `outer` answers for a column of a relation the walk does not define (an enclosing block's, read by a
 * correlated subquery).
 */
export function mayCarryJsonSubtype(e: Expr, outer: (rel: string, name: string) => boolean): boolean {
  const defs = new Map<string, Rel>();
  const memo = new Map<string, boolean>();
  const index = (plan: Rel): void => forEachRel(plan, (node) => { defs.set(node.id, node); });
  const expr = (x: Expr): boolean => {
    switch (x.kind) {
      case 'lit': case 'unary': case 'binary': case 'cast': case 'exists': case 'in-list': case 'in-query': return false;
      case 'col': {
        const def = defs.get(x.rel);
        return def ? column(def, x.name) : outer(x.rel, x.name);
      }
      case 'case': return x.whens.some(([, then]) => expr(then)) || (x.else !== undefined && expr(x.else));
      case 'call':
        if (x.fn.startsWith('jsonb')) return false;
        if (x.fn.startsWith('json')) return true;
        return x.args.some(expr);
      case 'agg': return x.fn === 'json_group_array' || x.fn === 'json_group_object' || ((x.fn === 'min' || x.fn === 'max') && x.args.some(expr));
      case 'window-expr': return x.fn !== 'row_number' && x.fn !== 'rank' && x.fn !== 'dense_rank' && x.fn !== 'count' && x.args.some(expr);
      case 'json-object': case 'json-array': return !x.binary;
      case 'scalar': index(x.plan); return x.plan.type.cols.length > 0 && column(x.plan, x.plan.type.cols[0]!.name);
    }
  };
  const column = (r: Rel, name: string): boolean => {
    const key = `${r.id}\0${name}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    memo.set(key, true); // a cycle cannot arise in a DAG, but stay conservative if it did
    const out = derive(r, name);
    memo.set(key, out);
    return out;
  };
  const at = (r: Rel, name: string): number => r.type.cols.findIndex((c) => c.name === name);
  const derive = (r: Rel, name: string): boolean => {
    switch (r.kind) {
      case 'scan': return false;
      // A retained binding arrives through `json_extract`, a CTE through whatever its body spells.
      case 'ref': return true;
      // A recursive CTE is always materialized, so its columns have lost any subtype already.
      case 'recursive': case 'self-ref': return false;
      case 'values': { const i = at(r, name); return r.rows.some((row) => row[i] !== undefined && expr(row[i]!)); }
      case 'project': { const found = r.exprs.find(([n]) => n === name); return found ? expr(found[1]) : true; }
      case 'aggregate': {
        const agg = r.aggs.find(([n]) => n === name);
        if (agg) return expr(agg[1]);
        const i = at(r, name);
        return i >= 0 && i < r.groupBy.length ? expr(r.groupBy[i]!) : true;
      }
      case 'window': { const spec = r.specs.find(([n]) => n === name); return spec ? expr(spec[1]) : column(r.input, name); }
      case 'filter': case 'sort': case 'limit': case 'distinct': case 'materialize': return column(r.input, name);
      case 'explode':
        if (name === r.as.value) return true;
        if (name === r.as.key || name === r.as.ord || name === r.as.type) return false;
        return r.input ? column(r.input, name) : true;
      case 'join': {
        const i = at(r, name);
        const left = r.left.type.cols.length;
        if (i < 0) return true;
        return i < left ? column(r.left, r.left.type.cols[i]!.name) : column(r.right, r.right.type.cols[i - left]!.name);
      }
      case 'union': { const i = at(r, name); return i < 0 || r.inputs.some((input) => column(input, input.type.cols[i]!.name)); }
    }
  };
  return expr(e);
}
