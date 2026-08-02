import type { Expr } from './expr.ts';
import { recursiveSelf } from './factory.ts';
import * as make from './factory.ts';
import type { Rel } from './rel.ts';
import type { FrameBound, SortTerm, WindowSpec } from './types.ts';

/** The structure of a node is declared ONCE, here. Every analysis and every rewrite folds over
 * these functions instead of re-deriving the shape of the union, so a new kind is a compile error
 * in one place rather than a silent omission in fifteen. No switch below has a `default` arm: with
 * `noImplicitReturns`, a new kind makes each of these fail to compile, which is the whole contract.
 * A `default` here would restore exactly the fail-open behaviour this module exists to delete. */

/** A recursive term is only reachable through its builder, so enumerating it needs the self-ref. */
export const recursiveStep = (r: Extract<Rel, { readonly kind: 'recursive' }>): Rel => r.step(recursiveSelf(r));

/** Child relations, in declaration order. */
export function relChildren(r: Rel): readonly Rel[] {
  switch (r.kind) {
    case 'scan': case 'values': case 'self-ref': case 'ref': return [];
    case 'project': case 'filter': case 'aggregate': case 'sort': case 'limit':
    case 'distinct': case 'window': case 'explode': case 'materialize': return [r.input];
    case 'join': return [r.left, r.right];
    case 'union': return r.inputs;
    case 'recursive': return [r.seed, recursiveStep(r)];
  }
}

/** Expressions a node owns, in declaration order. Correlated subplans inside them are reached
 * through `exprRels`, never by an analysis re-walking the expression union itself. */
export function relExprs(r: Rel): readonly Expr[] {
  const some = (...maybe: readonly (Expr | undefined)[]): readonly Expr[] => maybe.filter((e): e is Expr => e !== undefined);
  switch (r.kind) {
    case 'scan': case 'self-ref': case 'ref': return [];
    case 'values': return r.rows.flat();
    case 'project': return r.exprs.map(([, e]) => e);
    case 'filter': return [r.pred];
    case 'aggregate': return [...r.groupBy, ...r.aggs.map(([, e]) => e), ...some(r.having)];
    case 'sort': return r.terms.map((term) => term.expr);
    case 'limit': return some(r.count, r.offset);
    case 'distinct': return [];
    case 'window': return r.specs.map(([, e]) => e);
    case 'explode': return [r.expr];
    case 'materialize': return [];
    case 'join': return some(r.on);
    case 'union': case 'recursive': return [];
  }
}

/** An ordered aggregate, a window's partition/order keys and a frame bound all hold expressions.
 * Missing them is not cosmetic: a `Lit` in `partitionBy` is a bind, and `partitionBy` is the field
 * the whole per-origin/global collapse depends on (§3.2). */
const boundExprs = (bound: FrameBound): readonly Expr[] =>
  bound.kind === 'preceding' || bound.kind === 'following' ? [bound.count] : [];
const specExprs = (spec: WindowSpec): readonly Expr[] => [
  ...spec.partitionBy,
  ...spec.orderBy.map((term) => term.expr),
  ...(spec.frame ? [...boundExprs(spec.frame.start), ...boundExprs(spec.frame.end)] : []),
];

/** Sub-expressions, in declaration order. */
export function exprChildren(e: Expr): readonly Expr[] {
  const some = (...maybe: readonly (Expr | undefined)[]): readonly Expr[] => maybe.filter((x): x is Expr => x !== undefined);
  switch (e.kind) {
    case 'col': case 'lit': case 'scalar': case 'exists': return [];
    case 'unary': case 'cast': return [e.arg];
    case 'binary': return [e.left, e.right];
    case 'case': return [...e.whens.flatMap(([when, then]) => [when, then]), ...some(e.else)];
    case 'call': return e.args;
    case 'agg': return [...e.args, ...(e.orderBy ?? []).map((term) => term.expr)];
    case 'window-expr': return [...e.args, ...specExprs(e.spec)];
    case 'json-object': return e.entries.map(([, value]) => value);
    case 'json-array': return e.items;
    case 'in-list': return [e.expr, ...e.values];
    case 'in-query': return [e.expr];
  }
}

/** Relations an expression correlates against — the only way a subplan hangs off an Expr. */
export function exprRels(e: Expr): readonly Rel[] {
  switch (e.kind) {
    case 'col': case 'lit': case 'unary': case 'binary': case 'case': case 'cast':
    case 'call': case 'agg': case 'window-expr': case 'json-object': case 'json-array':
    case 'in-list': return [];
    case 'scalar': case 'exists': case 'in-query': return [e.plan];
  }
}

const mapTerm = (term: SortTerm, f: (e: Expr) => Expr): SortTerm => ({ ...term, expr: f(term.expr) });
const mapBound = (bound: FrameBound, f: (e: Expr) => Expr): FrameBound =>
  bound.kind === 'preceding' || bound.kind === 'following' ? { ...bound, count: f(bound.count) } : bound;
const mapSpec = (spec: WindowSpec, f: (e: Expr) => Expr): WindowSpec => ({
  partitionBy: spec.partitionBy.map(f),
  orderBy: spec.orderBy.map((term) => mapTerm(term, f)),
  frame: spec.frame && { ...spec.frame, start: mapBound(spec.frame.start, f), end: mapBound(spec.frame.end, f) },
});

/** Replace a node's child relations, rebuilding through the kind's factory. Never a spread: a
 * spread keeps an obsolete field and loses the construction brand. */
export function mapRelChildren(r: Rel, f: (child: Rel) => Rel): Rel {
  const { id, channels, type } = r;
  switch (r.kind) {
    case 'scan': case 'values': case 'self-ref': case 'ref': return r;
    case 'project': return make.project({ id, channels, type, input: f(r.input), exprs: r.exprs });
    case 'filter': return make.filter({ id, channels, type, input: f(r.input), pred: r.pred });
    case 'aggregate': return make.aggregate({ id, channels, type, input: f(r.input), groupBy: r.groupBy, aggs: r.aggs, having: r.having });
    case 'sort': return make.sort({ id, channels, type, input: f(r.input), terms: r.terms });
    case 'limit': return make.limit({ id, channels, type, input: f(r.input), count: r.count, offset: r.offset });
    case 'distinct': return make.distinct({ id, channels, type, input: f(r.input) });
    case 'window': return make.window({ id, channels, type, input: f(r.input), specs: r.specs });
    case 'explode': return make.explode({ id, channels, type, input: f(r.input), expr: r.expr, as: r.as });
    case 'materialize': return make.materialize({ id, channels, type, input: f(r.input), name: r.name });
    case 'join': return make.join({ id, channels, type, left: f(r.left), right: f(r.right), join: r.join, on: r.on });
    case 'union': return make.union({ id, channels, type, inputs: r.inputs.map(f), all: r.all });
    case 'recursive': return make.recursive({ id, channels, type, name: r.name, cols: r.cols, seed: f(r.seed), step: (self) => f(r.step(self)) });
  }
}

/** Replace the expressions a node owns, position for position. */
export function mapRelExprs(r: Rel, f: (e: Expr) => Expr): Rel {
  const { id, channels, type } = r;
  const pair = ([name, e]: readonly [string, Expr]) => [name, f(e)] as const;
  switch (r.kind) {
    case 'scan': case 'self-ref': case 'ref': case 'materialize': case 'union': case 'recursive': return r;
    case 'values': return make.values({ id, channels, type, rows: r.rows.map((row) => row.map(f)) });
    case 'project': return make.project({ id, channels, type, input: r.input, exprs: r.exprs.map(pair) });
    case 'filter': return make.filter({ id, channels, type, input: r.input, pred: f(r.pred) });
    case 'aggregate': return make.aggregate({ id, channels, type, input: r.input, groupBy: r.groupBy.map(f), aggs: r.aggs.map(pair), having: r.having && f(r.having) });
    case 'sort': return make.sort({ id, channels, type, input: r.input, terms: r.terms.map((term) => mapTerm(term, f)) });
    case 'limit': return make.limit({ id, channels, type, input: r.input, count: r.count && f(r.count), offset: r.offset && f(r.offset) });
    case 'distinct': return r;
    case 'window': {
      const specs = r.specs.map(([name, spec]) => {
        const mapped = f(spec);
        if (mapped.kind !== 'window-expr') throw new Error('RelIR: a Window spec must stay a WindowExpr');
        return [name, mapped] as const;
      });
      return make.window({ id, channels, type, input: r.input, specs });
    }
    case 'explode': return make.explode({ id, channels, type, input: r.input, expr: f(r.expr), as: r.as });
    case 'join': return make.join({ id, channels, type, left: r.left, right: r.right, join: r.join, on: r.on && f(r.on) });
  }
}

/** Replace sub-expressions, position for position. Correlated subplans are left to `rel`. */
export function mapExprChildren(e: Expr, f: (child: Expr) => Expr, rel: (plan: Rel) => Rel = (plan) => plan): Expr {
  switch (e.kind) {
    case 'col': case 'lit': return e;
    case 'unary': case 'cast': return { ...e, arg: f(e.arg) };
    case 'binary': return { ...e, left: f(e.left), right: f(e.right) };
    case 'case': return { ...e, whens: e.whens.map(([when, then]) => [f(when), f(then)] as const), else: e.else && f(e.else) };
    case 'call': return { ...e, args: e.args.map(f) };
    case 'agg': return { ...e, args: e.args.map(f), orderBy: e.orderBy?.map((term) => mapTerm(term, f)) };
    case 'window-expr': return { ...e, args: e.args.map(f), spec: mapSpec(e.spec, f) };
    case 'json-object': return { ...e, entries: e.entries.map(([key, value]) => [key, f(value)] as const) };
    case 'json-array': return { ...e, items: e.items.map(f) };
    case 'in-list': return { ...e, expr: f(e.expr), values: e.values.map(f) };
    case 'scalar': case 'exists': return { ...e, plan: rel(e.plan) };
    case 'in-query': return { ...e, expr: f(e.expr), plan: rel(e.plan) };
  }
}

/** Bottom-up expression rewrite, including the relations an expression correlates against. */
export function rewriteExpr(e: Expr, f: (node: Expr) => Expr, rel: (plan: Rel) => Rel = (plan) => plan): Expr {
  const go = (node: Expr): Expr => f(mapExprChildren(node, go, rel));
  return go(e);
}

/**
 * Bottom-up relation rewrite that PRESERVES SHARING. The memo is the whole point: the plan is a
 * DAG (§3.4 of the build plan), and a pass that rebuilds per parent occurrence silently turns it
 * into a tree — which defeats `name`, and makes `unroll`'s replicated subplans multiply the SQL
 * text instead of sharing it.
 *
 * The callback receives the node with its children already rewritten AND the original node, so a
 * pass that pre-computed an analysis over the input plan can still key it by the node it analysed.
 */
export function rewrite(plan: Rel, f: (mapped: Rel, original: Rel) => Rel): Rel {
  const memo = new Map<Rel, Rel>();
  const go = (r: Rel): Rel => {
    const seen = memo.get(r);
    if (seen) return seen;
    const out = f(mapRelChildren(r, go), r);
    memo.set(r, out);
    return out;
  };
  return go(plan);
}

/** Visit every relation in the DAG once, plus every relation correlated from an expression. */
export function forEachRel(plan: Rel, visit: (r: Rel) => void): void {
  const seen = new Set<Rel>();
  const go = (r: Rel): void => {
    if (seen.has(r)) return;
    seen.add(r);
    visit(r);
    relExprs(r).forEach((e) => forEachExpr(e, (node) => exprRels(node).forEach(go)));
    relChildren(r).forEach(go);
  };
  go(plan);
}

/** Visit an expression and every sub-expression. Correlated subplans are the caller's business. */
export function forEachExpr(e: Expr, visit: (node: Expr) => void): void {
  visit(e);
  exprChildren(e).forEach((child) => forEachExpr(child, visit));
}
