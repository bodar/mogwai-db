import { layoutCols } from '../compiler/steps/context/context.ts';
import type { Expr } from './expr.ts';
import type { Rel } from './rel.ts';
import type { Stmt } from './stmt.ts';

const DO_BIND_CAP = 100;

interface Scope { readonly cols: ReadonlyMap<string, ReadonlySet<string>>; readonly inAggregate: boolean; readonly inWindow: boolean; readonly recursive?: { readonly name: string; readonly self: string; readonly allowed: boolean }; }

const add = (scope: Scope, rel: Rel): Scope => ({ ...scope, cols: new Map(scope.cols).set(rel.id, new Set(rel.type.cols.map((c) => c.name))) });
const root = (): Scope => ({ cols: new Map(), inAggregate: false, inWindow: false });

export function bindCount(plan: Rel | Stmt): number {
  let n = 0;
  const expr = (e: Expr): void => {
    if (e.kind === 'lit') { n++; return; }
    switch (e.kind) {
      case 'unary': expr(e.arg); break;
      case 'binary': expr(e.left); expr(e.right); break;
      case 'case': e.whens.forEach(([when, then]) => { expr(when); expr(then); }); if (e.else) expr(e.else); break;
      case 'cast': expr(e.arg); break;
      case 'call': case 'agg': case 'window-expr': e.args.forEach(expr); break;
      case 'json-object': e.entries.forEach(([, value]) => expr(value)); break;
      case 'json-array': e.items.forEach(expr); break;
      case 'scalar': case 'exists': rel(e.plan); break;
      case 'in-list': expr(e.expr); e.values.forEach(expr); break;
      case 'in-query': expr(e.expr); rel(e.plan); break;
      default: break;
    }
  };
  const rel = (r: Rel): void => {
    switch (r.kind) {
      case 'values': r.rows.flat().forEach(expr); break;
      case 'project': r.exprs.forEach(([, e]) => expr(e)); rel(r.input); break;
      case 'filter': expr(r.pred); rel(r.input); break;
      case 'aggregate': r.groupBy.forEach(expr); r.aggs.forEach(([, e]) => expr(e)); if (r.having) expr(r.having); rel(r.input); break;
      case 'sort': r.terms.forEach((t) => expr(t.expr)); rel(r.input); break;
      case 'limit': if (r.count) expr(r.count); if (r.offset) expr(r.offset); rel(r.input); break;
      case 'window': r.specs.forEach(([, e]) => expr(e)); rel(r.input); break;
      case 'explode': expr(r.expr); rel(r.input); break;
      case 'join': if (r.on) expr(r.on); rel(r.left); rel(r.right); break;
      case 'union': r.inputs.forEach(rel); break;
      case 'recursive': {
        rel(r.seed);
        const self = { ...r, kind: 'self-ref' as const, name: r.name } as Rel;
        rel(r.step(self));
        break;
      }
      case 'distinct': case 'materialize': rel(r.input); break;
      default: break;
    }
  };
  if ('kind' in plan && ['insert', 'update', 'delete', 'sequence'].includes(plan.kind)) {
    const stmt = (s: Stmt): void => { if (s.kind === 'sequence') s.steps.forEach(stmt); else { if (s.kind === 'insert') rel(s.source); if (s.kind === 'update' && s.from) rel(s.from); if (s.kind === 'delete' && s.using) rel(s.using); s.returning.forEach(([, e]) => expr(e)); } };
    stmt(plan as Stmt);
  } else rel(plan as Rel);
  return n;
}

export function check(plan: Rel | Stmt): void {
  const checkExpr = (e: Expr, scope: Scope): void => {
    if (e.kind === 'col') { const cols = scope.cols.get(e.rel); if (!cols?.has(e.name)) throw new Error(`RelIR: relation ${e.rel} has no declared column '${e.name}'`); return; }
    if (e.kind === 'agg' && !scope.inAggregate) throw new Error('RelIR: Agg is legal only in Aggregate.aggs');
    if (e.kind === 'window-expr' && !scope.inWindow) throw new Error('RelIR: WindowExpr is legal only in Window.specs');
    const child = (x: Expr) => checkExpr(x, scope);
    switch (e.kind) { case 'unary': child(e.arg); break; case 'binary': child(e.left); child(e.right); break; case 'case': e.whens.forEach(([a,b]) => { child(a); child(b); }); if (e.else) child(e.else); break; case 'cast': child(e.arg); break; case 'call': case 'agg': case 'window-expr': e.args.forEach(child); break; case 'json-object': e.entries.forEach(([,x]) => child(x)); break; case 'json-array': e.items.forEach(child); break; case 'scalar': case 'exists': checkRel(e.plan, scope); break; case 'in-list': child(e.expr); e.values.forEach(child); break; case 'in-query': child(e.expr); checkRel(e.plan, scope); break; default: break; }
  };
  const checkRel = (r: Rel, scope: Scope = root()): void => {
    if (r.kind === 'self-ref') { if (!scope.recursive || !scope.recursive.allowed || r.name !== scope.recursive.name) throw new Error('RelIR: SelfRef is legal only in its Recursive step'); return; }
    const here = add(scope, r);
    const preserve = (input: Rel) => {
      checkRel(input, scope);
      const output = new Set(r.type.cols.map((c) => c.name));
      const inputLayout = layoutCols(input.layout);
      const outputLayout = layoutCols(r.layout);
      if (inputLayout.join('\0') !== outputLayout.join('\0')) throw new Error(`RelIR: ${r.kind} changed its traverser layout`);
      for (const col of inputLayout) if (!output.has(col)) throw new Error(`RelIR: ${r.kind} dropped layout column '${col}'`);
    };
    switch (r.kind) {
      case 'values': r.rows.forEach((row) => row.forEach((e) => checkExpr(e, scope))); break;
      case 'project': checkRel(r.input, scope); r.exprs.forEach(([, e]) => checkExpr(e, add(scope, r.input))); for (const col of layoutCols(r.layout)) if (!r.type.cols.some((c) => c.name === col)) throw new Error(`RelIR: Project does not declare layout column '${col}'`); break;
      case 'filter': preserve(r.input); checkExpr(r.pred, add(scope, r.input)); break;
      case 'aggregate': checkRel(r.input, scope); r.groupBy.forEach((e) => checkExpr(e, add(scope, r.input))); r.aggs.forEach(([,e]) => checkExpr(e, { ...add(scope, r.input), inAggregate: true })); if (r.having) checkExpr(r.having, here); break;
      case 'sort': preserve(r.input); r.terms.forEach((t) => checkExpr(t.expr, add(scope, r.input))); break;
      case 'limit': preserve(r.input); if (r.count) checkExpr(r.count, add(scope,r.input)); if (r.offset) checkExpr(r.offset, add(scope,r.input)); break;
      case 'distinct': case 'materialize': preserve(r.input); break;
      case 'window': preserve(r.input); r.specs.forEach(([,e]) => checkExpr(e, { ...add(scope,r.input), inWindow:true })); break;
      case 'explode': preserve(r.input); checkExpr(r.expr, add(scope,r.input)); break;
      case 'join': checkRel(r.left, scope); checkRel(r.right, scope); if (r.on) checkExpr(r.on, add(add(scope,r.left),r.right)); break;
      case 'union': r.inputs.forEach((input) => checkRel(input,scope)); break;
      case 'recursive': { checkRel(r.seed, scope); const step = r.step({ ...r, kind: 'self-ref', name:r.name } as Rel); checkRel(step, { ...scope, recursive: { name:r.name, self:r.id, allowed:true } }); if (JSON.stringify(r.seed.type.cols) !== JSON.stringify(step.type.cols)) throw new Error('RelIR: Recursive seed and step layouts/types must be identical'); break; }
      default: break;
    }
  };
  if ('kind' in plan && ['insert','update','delete','sequence'].includes(plan.kind)) { /* statement checking lands with Phase 2 */ } else checkRel(plan as Rel);
  if (bindCount(plan) > DO_BIND_CAP) throw new Error(`RelIR: ${bindCount(plan)} binds exceeds Durable Objects cap of ${DO_BIND_CAP}`);
}
