import { barrierLayout, layoutCols, mergeLayouts } from '../compiler/steps/context/context.ts';
import type { Expr } from './expr.ts';
import { isRel, type Rel } from './rel.ts';
import { isStmt, type Stmt } from './stmt.ts';
import { recursiveSelf } from './factory.ts';

const DO_BIND_CAP = 100;

interface Scope { readonly cols: ReadonlyMap<string, ReadonlySet<string>>; readonly inAggregate: boolean; readonly inWindow: boolean; readonly recursive?: { readonly name: string; readonly self: string; readonly allowed: boolean }; }

const add = (scope: Scope, rel: Rel): Scope => ({ ...scope, cols: new Map(scope.cols).set(rel.id, new Set(rel.type.cols.map((c) => c.name))) });
const root = (): Scope => ({ cols: new Map(), inAggregate: false, inWindow: false });
const sameColumns = (left: Rel['type']['cols'], right: Rel['type']['cols']): boolean =>
  left.length === right.length && left.every((column, i) => {
    const other = right[i];
    return other?.name === column.name && other.type === column.type && other.nullable === column.nullable;
  });
const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name, i) => name === right[i]);
const layoutSnapshot = (layout: import('../compiler/steps/context/context.ts').TraverserLayout): unknown => ({
  ...layout,
  aliases: [...layout.aliases].map(([label, entry]) => [label, {
    ...entry,
    shapes: [...entry.shapes].sort(),
  }]),
});
const sameLayout = (left: import('../compiler/steps/context/context.ts').TraverserLayout, right: import('../compiler/steps/context/context.ts').TraverserLayout): boolean =>
  JSON.stringify(layoutSnapshot(left)) === JSON.stringify(layoutSnapshot(right));

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
        rel(r.step(recursiveSelf(r)));
        break;
      }
      case 'distinct': case 'materialize': rel(r.input); break;
      default: break;
    }
  };
  if (!isRel(plan)) {
    if (!isStmt(plan)) throw new Error('RelIR: statement was not constructed by a Stmt factory');
    const stmt = (s: Stmt): void => {
      if (s.kind === 'sequence') { s.steps.forEach(stmt); return; }
      if (s.kind === 'insert') { rel(s.source); s.onConflict?.set.forEach(([, e]) => expr(e)); }
      if (s.kind === 'update') { s.set.forEach(([, e]) => expr(e)); if (s.from) rel(s.from); if (s.where) expr(s.where); }
      if (s.kind === 'delete') { if (s.using) rel(s.using); if (s.where) expr(s.where); }
      s.returning.forEach(([, e]) => expr(e));
    };
    stmt(plan);
  } else rel(plan);
  return n;
}

export function check(plan: Rel | Stmt): void {
  /** SQLite's recursive-term law is positional, not merely a reference count. */
  const recursiveTerm = (term: Rel, name: string): { selfRefs: number; aggregate: boolean; window: boolean } => {
    let selfRefs = 0;
    let aggregate = false;
    let window = false;
    const expression = (e: Expr): void => {
      if (e.kind === 'agg') aggregate = true;
      if (e.kind === 'window-expr') window = true;
      switch (e.kind) {
        case 'unary': expression(e.arg); break;
        case 'binary': expression(e.left); expression(e.right); break;
        case 'case': e.whens.forEach(([a, b]) => { expression(a); expression(b); }); if (e.else) expression(e.else); break;
        case 'cast': expression(e.arg); break;
        case 'call': case 'agg': case 'window-expr': e.args.forEach(expression); break;
        case 'json-object': e.entries.forEach(([, value]) => expression(value)); break;
        case 'json-array': e.items.forEach(expression); break;
        case 'scalar': case 'exists': relation(e.plan); break;
        case 'in-list': expression(e.expr); e.values.forEach(expression); break;
        case 'in-query': expression(e.expr); relation(e.plan); break;
        default: break;
      }
    };
    const relation = (r: Rel): void => {
      if (r.kind === 'self-ref') { if (r.name === name) selfRefs++; return; }
      switch (r.kind) {
        case 'project': r.exprs.forEach(([, e]) => expression(e)); relation(r.input); break;
        case 'filter': expression(r.pred); relation(r.input); break;
        case 'aggregate': aggregate = true; r.groupBy.forEach(expression); r.aggs.forEach(([,e]) => expression(e)); if (r.having) expression(r.having); relation(r.input); break;
        case 'sort': r.terms.forEach((t) => expression(t.expr)); relation(r.input); break;
        case 'limit': if (r.count) expression(r.count); if (r.offset) expression(r.offset); relation(r.input); break;
        case 'window': window = true; r.specs.forEach(([,e]) => expression(e)); relation(r.input); break;
        case 'explode': expression(r.expr); relation(r.input); break;
        case 'distinct': case 'materialize': relation(r.input); break;
        case 'join': if (r.on) expression(r.on); relation(r.left); relation(r.right); break;
        case 'union': r.inputs.forEach(relation); break;
        case 'recursive': relation(r.seed); relation(r.step(recursiveSelf(r))); break;
        default: break;
      }
    };
    relation(term);
    return { selfRefs, aggregate, window };
  };
  const topLevelSelf = (term: Rel, name: string): boolean => {
    if (term.kind === 'self-ref') return term.name === name;
    // The emitter can place a direct source at the recursive term's FROM, but it may not
    // unwrap a derived unary chain. `flatten` is the pass that makes broader bodies legal.
    if (term.kind === 'project' || term.kind === 'filter' || term.kind === 'sort' || term.kind === 'limit'
      || term.kind === 'distinct' || term.kind === 'window' || term.kind === 'explode' || term.kind === 'materialize')
      return term.input.kind === 'self-ref' && term.input.name === name;
    return term.kind === 'join'
      && ((term.left.kind === 'self-ref' && term.left.name === name) || (term.right.kind === 'self-ref' && term.right.name === name));
  };
  const checkExpr = (e: Expr, scope: Scope): void => {
    if (e.kind === 'col') { const cols = scope.cols.get(e.rel); if (!cols?.has(e.name)) throw new Error(`RelIR: relation ${e.rel} has no declared column '${e.name}'`); return; }
    if (e.kind === 'agg' && !scope.inAggregate) throw new Error('RelIR: Agg is legal only in Aggregate.aggs');
    if (e.kind === 'window-expr' && !scope.inWindow) throw new Error('RelIR: WindowExpr is legal only in Window.specs');
    const child = (x: Expr) => checkExpr(x, scope);
    switch (e.kind) { case 'unary': child(e.arg); break; case 'binary': child(e.left); child(e.right); break; case 'case': e.whens.forEach(([a,b]) => { child(a); child(b); }); if (e.else) child(e.else); break; case 'cast': child(e.arg); break; case 'call': case 'agg': case 'window-expr': e.args.forEach(child); break; case 'json-object': e.entries.forEach(([,x]) => child(x)); break; case 'json-array': e.items.forEach(child); break; case 'scalar': case 'exists': checkRel(e.plan, scope); break; case 'in-list': child(e.expr); e.values.forEach(child); break; case 'in-query': child(e.expr); checkRel(e.plan, scope); break; default: break; }
  };
  const checkRel = (r: Rel, scope: Scope = root()): void => {
    if (!isRel(r)) throw new Error('RelIR: relation was not constructed by a Rel factory');
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
      case 'values':
        r.rows.forEach((row) => {
          if (row.length !== r.type.cols.length) throw new Error(`RelIR: Values row has ${row.length} columns; declared type has ${r.type.cols.length}`);
          row.forEach((e) => checkExpr(e, scope));
        });
        break;
      case 'project': {
        checkRel(r.input, scope);
        r.exprs.forEach(([, e]) => checkExpr(e, add(scope, r.input)));
        const names = r.exprs.map(([name]) => name);
        if (new Set(names).size !== names.length) throw new Error('RelIR: Project declares a duplicate output name');
        if (!sameNames(names, r.type.cols.map((column) => column.name))) throw new Error('RelIR: Project expressions must declare exactly its output columns');
        for (const col of layoutCols(r.layout)) if (!r.type.cols.some((c) => c.name === col)) throw new Error(`RelIR: Project does not declare layout column '${col}'`);
        break;
      }
      case 'filter': preserve(r.input); checkExpr(r.pred, add(scope, r.input)); break;
      case 'aggregate':
        checkRel(r.input, scope);
        r.groupBy.forEach((e) => checkExpr(e, add(scope, r.input)));
        r.aggs.forEach(([,e]) => checkExpr(e, { ...add(scope, r.input), inAggregate: true }));
        if (r.having) checkExpr(r.having, here);
        if (!r.groupBy.length && !sameLayout(barrierLayout(r.input.layout), r.layout))
          throw new Error('RelIR: whole-relation Aggregate must apply the barrier layout contract');
        break;
      case 'sort': preserve(r.input); r.terms.forEach((t) => checkExpr(t.expr, add(scope, r.input))); break;
      case 'limit': preserve(r.input); if (r.count) checkExpr(r.count, add(scope,r.input)); if (r.offset) checkExpr(r.offset, add(scope,r.input)); break;
      case 'distinct':
        preserve(r.input);
        r.on?.forEach((e) => checkExpr(e, add(scope, r.input)));
        break;
      case 'materialize': preserve(r.input); break;
      case 'window': {
        preserve(r.input);
        r.specs.forEach(([,e]) => checkExpr(e, { ...add(scope,r.input), inWindow:true }));
        const expected = [...r.input.type.cols.map((column) => column.name), ...r.specs.map(([name]) => name)];
        if (!sameNames(expected, r.type.cols.map((column) => column.name))) throw new Error('RelIR: Window output must be input columns followed by its specs');
        break;
      }
      case 'explode': preserve(r.input); checkExpr(r.expr, add(scope,r.input)); break;
      case 'join':
        checkRel(r.left, scope); checkRel(r.right, scope);
        const needsOn = r.join === 'inner' || r.join === 'left';
        if ((r.join === 'cross' && r.on) || (needsOn && !r.on)) throw new Error(`RelIR: ${r.join} join ${r.join === 'cross' ? 'must not' : 'requires'} an ON expression`);
        if (r.on) checkExpr(r.on, add(add(scope,r.left),r.right));
        break;
      case 'union': {
        if (r.inputs.length < 2) throw new Error('RelIR: Union requires at least two inputs');
        r.inputs.forEach((input) => checkRel(input,scope));
        for (const input of r.inputs) if (!sameColumns(input.type.cols, r.type.cols)) throw new Error('RelIR: Union inputs and output must have identical columns');
        const expected = mergeLayouts(r.inputs[0]!.layout, r.inputs.slice(1).map((input) => input.layout), { rigid: 'peer' });
        if (!sameLayout(expected, r.layout)) throw new Error('RelIR: Union output layout must merge its inputs');
        break;
      }
      case 'recursive': {
        if (!sameNames(r.cols, r.type.cols.map((column) => column.name))) throw new Error('RelIR: Recursive CTE header must match its output columns');
        checkRel(r.seed, scope);
        const step = r.step(recursiveSelf(r));
        const term = recursiveTerm(step, r.name);
        if (term.selfRefs !== 1) throw new Error(`RelIR: Recursive step must reference '${r.name}' exactly once (found ${term.selfRefs})`);
        if (term.aggregate) throw new Error('RelIR: SQLite forbids aggregate queries in a recursive term');
        if (term.window) throw new Error('RelIR: SQLite forbids window functions in a recursive term');
        if (!topLevelSelf(step, r.name)) throw new Error(`RelIR: Recursive step must reference '${r.name}' at the top level of FROM; run flatten first`);
        checkRel(step, { ...scope, recursive: { name:r.name, self:r.id, allowed:true } });
        if (JSON.stringify(r.seed.type.cols) !== JSON.stringify(step.type.cols)) throw new Error('RelIR: Recursive seed and step layouts/types must be identical');
        break;
      }
      default: break;
    }
  };
  const checkStmt = (s: Stmt): void => {
    if (!isStmt(s)) throw new Error('RelIR: statement was not constructed by a Stmt factory');
    const assignments = (pairs: readonly (readonly [string, Expr])[], what: string): void => {
      if (!pairs.length && what === 'Update') throw new Error('RelIR: Update requires at least one assignment');
      if (new Set(pairs.map(([name]) => name)).size !== pairs.length) throw new Error(`RelIR: duplicate ${what} name`);
    };
    const returning = (pairs: readonly (readonly [string, Expr])[], scope: Scope): void => {
      if (new Set(pairs.map(([name]) => name)).size !== pairs.length) throw new Error('RelIR: duplicate RETURNING name');
      pairs.forEach(([, expression]) => checkExpr(expression, scope));
    };
    switch (s.kind) {
      case 'insert':
        if (s.target.kind !== 'scan') throw new Error('RelIR: statement target must be a Scan');
        for (const column of s.cols) if (!s.target.type.cols.some((declared) => declared.name === column)) throw new Error(`RelIR: Insert target has no column '${column}'`);
        checkRel(s.source);
        const insertScope = add(root(), s.target);
        if (s.cols.length !== s.source.type.cols.length) throw new Error(`RelIR: Insert has ${s.cols.length} target columns but source emits ${s.source.type.cols.length}`);
        if (new Set(s.cols).size !== s.cols.length) throw new Error('RelIR: Insert has duplicate target column');
        if (s.onConflict) {
          if (!s.onConflict.target.length) throw new Error('RelIR: Insert conflict target cannot be empty');
          if (new Set(s.onConflict.target).size !== s.onConflict.target.length) throw new Error('RelIR: Insert conflict target has duplicate column');
          assignments(s.onConflict.set, 'conflict update');
          s.onConflict.set.forEach(([, expression]) => checkExpr(expression, insertScope));
        }
        returning(s.returning, insertScope);
        break;
      case 'update':
        if (s.target.kind !== 'scan') throw new Error('RelIR: statement target must be a Scan');
        assignments(s.set, 'Update');
        for (const [column] of s.set) if (!s.target.type.cols.some((declared) => declared.name === column)) throw new Error(`RelIR: Update target has no column '${column}'`);
        if (s.from) checkRel(s.from);
        const updateScope = s.from ? add(add(root(), s.target), s.from) : add(root(), s.target);
        s.set.forEach(([, expression]) => checkExpr(expression, updateScope));
        if (s.where) checkExpr(s.where, updateScope);
        returning(s.returning, add(root(), s.target));
        break;
      case 'delete':
        if (s.target.kind !== 'scan') throw new Error('RelIR: statement target must be a Scan');
        if (s.using) {
          checkRel(s.using);
          if (!s.using.type.cols.some((column) => column.name === 'id'))
            throw new Error('RelIR: Delete.using must emit an id column');
        }
        if (s.where) checkExpr(s.where, add(root(), s.target));
        returning(s.returning, add(root(), s.target));
        break;
      case 'sequence':
        if (!s.steps.length) throw new Error('RelIR: Sequence requires at least one statement');
        s.steps.forEach(checkStmt);
        break;
    }
  };
  if (!isRel(plan)) {
    if (!isStmt(plan)) throw new Error('RelIR: statement was not constructed by a Stmt factory');
    checkStmt(plan);
  } else checkRel(plan);
  if (bindCount(plan) > DO_BIND_CAP) throw new Error(`RelIR: ${bindCount(plan)} binds exceeds Durable Objects cap of ${DO_BIND_CAP}`);
}
