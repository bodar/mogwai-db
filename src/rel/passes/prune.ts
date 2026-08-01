import { layoutCols } from '../../compiler/steps/context/context.ts';
import type { Expr } from '../expr.ts';
import type { Rel } from '../rel.ts';

const refs = (expr: Expr, relation: import('../types.ts').RelId, out: Set<string>): void => {
  if (expr.kind === 'col') { if (expr.rel === relation) out.add(expr.name); return; }
  switch (expr.kind) {
    case 'unary': refs(expr.arg, relation, out); break;
    case 'binary': refs(expr.left, relation, out); refs(expr.right, relation, out); break;
    case 'case': expr.whens.forEach(([a,b]) => { refs(a,relation,out); refs(b,relation,out); }); if (expr.else) refs(expr.else,relation,out); break;
    case 'cast': refs(expr.arg,relation,out); break;
    case 'call': case 'agg': case 'window-expr': expr.args.forEach((arg) => refs(arg,relation,out)); break;
    case 'json-object': expr.entries.forEach(([,value]) => refs(value,relation,out)); break;
    case 'json-array': expr.items.forEach((value) => refs(value,relation,out)); break;
    case 'in-list': refs(expr.expr,relation,out); expr.values.forEach((value) => refs(value,relation,out)); break;
    case 'in-query': refs(expr.expr,relation,out); break;
    default: break;
  }
};

/** Remove unobserved Project outputs while preserving every carried traverser channel. */
export function prune(plan: Rel, required: readonly string[] = plan.type.cols.map((col) => col.name)): Rel {
  const visit = (r: Rel, need: ReadonlySet<string>): Rel => {
    switch (r.kind) {
      case 'project': {
        const keep = new Set([...need, ...layoutCols(r.layout)]);
        const exprs = r.exprs.filter(([name]) => keep.has(name));
        const inputNeed = new Set(layoutCols(r.input.layout));
        exprs.forEach(([, expr]) => refs(expr, r.input.id, inputNeed));
        const input = visit(r.input, inputNeed);
        return { ...r, input, exprs, type: { cols: r.type.cols.filter((col) => keep.has(col.name)) } };
      }
      case 'filter': return { ...r, input: visit(r.input, new Set([...need, ...layoutCols(r.input.layout)])) };
      case 'sort': case 'limit': case 'distinct': case 'window': case 'explode': case 'materialize': return { ...r, input: visit(r.input, new Set([...need, ...layoutCols(r.input.layout)])) };
      default: return r;
    }
  };
  return visit(plan, new Set(required));
}
