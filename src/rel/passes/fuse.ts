import type { Expr } from '../expr.ts';
import type { Rel } from '../rel.ts';
import { aggregate, distinct, explode, filter, join, limit, materialize, project, recursive, sort, union, window } from '../factory.ts';

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
      case 'project': return project({ id: r.id, input: one(r.input), layout: r.layout, type: r.type, exprs: r.exprs });
      case 'filter': {
        const input = one(r.input);
        if (input.kind !== 'filter') return filter({ id: r.id, input, layout: r.layout, type: r.type, pred: r.pred });
        const pred: Expr = { kind: 'binary', op: 'and', left: input.pred, right: rebind(r.pred, input.id, input.input.id) };
        return filter({ id: r.id, input: input.input, layout: r.layout, type: r.type, pred });
      }
      case 'aggregate': return aggregate({ id: r.id, input: one(r.input), layout: r.layout, type: r.type, groupBy: r.groupBy, aggs: r.aggs, having: r.having });
      case 'sort': return sort({ id: r.id, input: one(r.input), layout: r.layout, type: r.type, terms: r.terms });
      case 'limit': return limit({ id: r.id, input: one(r.input), layout: r.layout, type: r.type, count: r.count, offset: r.offset });
      case 'distinct': return distinct({ id: r.id, input: one(r.input), layout: r.layout, type: r.type, on: r.on });
      case 'window': return window({ id: r.id, input: one(r.input), layout: r.layout, type: r.type, specs: r.specs });
      case 'explode': return explode({ id: r.id, input: one(r.input), layout: r.layout, type: r.type, expr: r.expr, as: r.as });
      case 'materialize': return materialize({ id: r.id, input: one(r.input), layout: r.layout, type: r.type, name: r.name });
      case 'join': return join({ id: r.id, left: one(r.left), right: one(r.right), layout: r.layout, type: r.type, join: r.join, on: r.on });
      case 'union': return union({ id: r.id, inputs: r.inputs.map(one), layout: r.layout, type: r.type, all: r.all });
      case 'recursive': return recursive({ id: r.id, name: r.name, cols: r.cols, seed: one(r.seed), layout: r.layout, type: r.type, step: (self) => one(r.step(self)) });
      default: return r;
    }
  };
  return visit(plan);
}
