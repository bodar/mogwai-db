import type { Expr } from '../expr.ts';
import type { Rel } from '../rel.ts';

const rebind = (expr: Expr, from: import('../types.ts').RelId, to: import('../types.ts').RelId): Expr => {
  switch (expr.kind) {
    case 'col': return expr.rel === from ? { ...expr, rel: to } : expr;
    case 'unary': return { ...expr, arg: rebind(expr.arg, from, to) };
    case 'binary': return { ...expr, left: rebind(expr.left, from, to), right: rebind(expr.right, from, to) };
    case 'case': return { ...expr, whens: expr.whens.map(([a,b]) => [rebind(a,from,to), rebind(b,from,to)] as const), else: expr.else && rebind(expr.else,from,to) };
    case 'cast': return { ...expr, arg: rebind(expr.arg,from,to) };
    case 'call': case 'agg': case 'window-expr': return { ...expr, args: expr.args.map((x) => rebind(x,from,to)) };
    case 'json-object': return { ...expr, entries: expr.entries.map(([k,v]) => [k,rebind(v,from,to)] as const) };
    case 'json-array': return { ...expr, items: expr.items.map((x) => rebind(x,from,to)) };
    case 'in-list': return { ...expr, expr: rebind(expr.expr,from,to), values: expr.values.map((x) => rebind(x,from,to)) };
    case 'in-query': return { ...expr, expr: rebind(expr.expr,from,to) };
    default: return expr;
  }
};

/** Structural fusion with no cost model: adjacent filters become one predicate. */
export function fuse(plan: Rel): Rel {
  const visit = (r: Rel): Rel => {
    const one = (input: Rel): Rel => visit(input);
    switch (r.kind) {
      case 'project': return { ...r, input: one(r.input) };
      case 'filter': {
        const input = one(r.input);
        if (input.kind !== 'filter') return { ...r, input };
        const pred: Expr = { kind: 'binary', op: 'and', left: input.pred, right: rebind(r.pred, input.id, input.input.id) };
        return { ...r, input: input.input, pred };
      }
      case 'aggregate': return { ...r, input: one(r.input) };
      case 'sort': return { ...r, input: one(r.input) };
      case 'limit': return { ...r, input: one(r.input) };
      case 'distinct': return { ...r, input: one(r.input) };
      case 'window': return { ...r, input: one(r.input) };
      case 'explode': return { ...r, input: one(r.input) };
      case 'materialize': return { ...r, input: one(r.input) };
      case 'join': return { ...r, left: one(r.left), right: one(r.right) };
      case 'union': return { ...r, inputs: r.inputs.map(one) };
      case 'recursive': return { ...r, seed: one(r.seed), step: (self) => one(r.step(self)) };
      default: return r;
    }
  };
  return visit(plan);
}
