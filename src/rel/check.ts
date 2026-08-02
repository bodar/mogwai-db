import { barrierLayout, layoutCols, mergeLayouts } from '../compiler/steps/context/context.ts';
import type { Expr } from './expr.ts';
import { isRel, type Rel } from './rel.ts';
import { isStmt, type Stmt } from './stmt.ts';
import { recursiveSelf } from './factory.ts';
import { exprChildren, exprRels, relChildren, relExprs } from './walk.ts';

const DO_BIND_CAP = 100;

interface Scope { readonly cols: ReadonlyMap<string, Rel>; readonly inAggregate: boolean; readonly inWindow: boolean; readonly recursive?: { readonly name: string; readonly self: string; readonly allowed: boolean }; readonly prior?: readonly import('./types.ts').RelType[]; }

/** A `RelId` is how an expression names a relation, so two relations sharing one inside a single
 * scope makes every `Col` against it ambiguous — and the last binding silently wins. Fail closed. */
const add = (scope: Scope, rel: Rel): Scope => {
  const bound = scope.cols.get(rel.id);
  if (bound && bound !== rel) throw new Error(`RelIR: relation id '${rel.id}' names two different relations in one scope`);
  return { ...scope, cols: new Map(scope.cols).set(rel.id, rel) };
};
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

/** Occurrences, not distinct nodes: a shared node the `Name` pass decides to inline contributes
 * its binds twice, so counting the DAG once could under-report — and under-reporting is the failure
 * that only appears in production. Over-reporting a shared-and-named node merely fails closed. */
export function bindCount(plan: Rel | Stmt): number {
  let n = 0;
  const expr = (e: Expr): void => {
    if (e.kind === 'lit') n++;
    exprRels(e).forEach(rel);
    exprChildren(e).forEach(expr);
  };
  const rel = (r: Rel): void => {
    relExprs(r).forEach(expr);
    relChildren(r).forEach(rel);
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
      exprRels(e).forEach(relation);
      exprChildren(e).forEach(expression);
    };
    const relation = (r: Rel): void => {
      if (r.kind === 'self-ref') { if (r.name === name) selfRefs++; return; }
      if (r.kind === 'aggregate') aggregate = true;
      if (r.kind === 'window') window = true;
      relExprs(r).forEach(expression);
      relChildren(r).forEach(relation);
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
    if (e.kind === 'col') {
      const bound = scope.cols.get(e.rel);
      if (!bound) throw new Error(`RelIR: no relation '${e.rel}' is in scope for column '${e.name}'`);
      if (!bound.type.cols.some((column) => column.name === e.name)) throw new Error(`RelIR: relation ${e.rel} has no declared column '${e.name}'`);
      return;
    }
    if (e.kind === 'agg' && !scope.inAggregate) throw new Error('RelIR: Agg is legal only in Aggregate.aggs');
    if (e.kind === 'window-expr' && !scope.inWindow) throw new Error('RelIR: WindowExpr is legal only in Window.specs');
    const child = (x: Expr) => checkExpr(x, scope);
    switch (e.kind) { case 'unary': child(e.arg); break; case 'binary': child(e.left); child(e.right); break; case 'case': e.whens.forEach(([a,b]) => { child(a); child(b); }); if (e.else) child(e.else); break; case 'cast': child(e.arg); break; case 'call': case 'agg': case 'window-expr': e.args.forEach(child); break; case 'json-object': e.entries.forEach(([,x]) => child(x)); break; case 'json-array': e.items.forEach(child); break; case 'scalar': case 'exists': checkRel(e.plan, scope); break; case 'in-list': child(e.expr); e.values.forEach(child); break; case 'in-query': child(e.expr); checkRel(e.plan, scope); break; default: break; }
  };
  const checkRel = (r: Rel, scope: Scope = root()): void => {
    if (!isRel(r)) throw new Error('RelIR: relation was not constructed by a Rel factory');
    if (r.kind === 'self-ref') { if (!scope.recursive || !scope.recursive.allowed || r.name !== scope.recursive.name) throw new Error('RelIR: SelfRef is legal only in its Recursive step'); return; }
    if (r.kind === 'prior-result') {
      const prior = scope.prior?.[r.step];
      if (!prior) throw new Error(`RelIR: PriorResult step ${r.step} is not an earlier Sequence result`);
      if (!sameColumns(r.type.cols, prior.cols)) throw new Error(`RelIR: PriorResult step ${r.step} type must match that step's returningType`);
      return;
    }
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
      case 'distinct': preserve(r.input); break;
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
        // Both sides land in ONE `FROM`, and a derived side is introduced under its RelId — so two
        // sides sharing an id emit the same SQL alias twice ("ambiguous column name"). A replicated
        // subplan (what `unroll` produces) must carry its own ids, not be the same node twice.
        if (r.left.id === r.right.id) throw new Error(`RelIR: a Join's sides must be distinct relations; both are '${r.left.id}'`);
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
  const checkStmt = (s: Stmt, prior: readonly import('./types.ts').RelType[] = []): void => {
    if (!isStmt(s)) throw new Error('RelIR: statement was not constructed by a Stmt factory');
    const assignments = (pairs: readonly (readonly [string, Expr])[], what: string): void => {
      if (!pairs.length && what === 'Update') throw new Error('RelIR: Update requires at least one assignment');
      if (new Set(pairs.map(([name]) => name)).size !== pairs.length) throw new Error(`RelIR: duplicate ${what} name`);
    };
    const returning = (pairs: readonly (readonly [string, Expr])[], scope: Scope): void => {
      if (new Set(pairs.map(([name]) => name)).size !== pairs.length) throw new Error('RelIR: duplicate RETURNING name');
      pairs.forEach(([, expression]) => checkExpr(expression, scope));
    };
    const returningType = (s: Exclude<Stmt, Extract<Stmt, { readonly kind: 'sequence' }>>): void => {
      const names = s.returning.map(([name]) => name);
      if (!sameNames(names, s.returningType.cols.map((column) => column.name)))
        throw new Error('RelIR: RETURNING expressions must declare exactly returningType columns');
    };
    switch (s.kind) {
      case 'insert':
        if (s.target.kind !== 'scan') throw new Error('RelIR: statement target must be a Scan');
        for (const column of s.cols) if (!s.target.type.cols.some((declared) => declared.name === column)) throw new Error(`RelIR: Insert target has no column '${column}'`);
        checkRel(s.source, { ...root(), prior });
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
        returningType(s);
        break;
      case 'update':
        if (s.target.kind !== 'scan') throw new Error('RelIR: statement target must be a Scan');
        assignments(s.set, 'Update');
        for (const [column] of s.set) if (!s.target.type.cols.some((declared) => declared.name === column)) throw new Error(`RelIR: Update target has no column '${column}'`);
        if (s.from) checkRel(s.from, { ...root(), prior });
        const updateScope = s.from ? add(add(root(), s.target), s.from) : add(root(), s.target);
        s.set.forEach(([, expression]) => checkExpr(expression, updateScope));
        if (s.where) checkExpr(s.where, updateScope);
        returning(s.returning, add(root(), s.target));
        returningType(s);
        break;
      case 'delete':
        if (s.target.kind !== 'scan') throw new Error('RelIR: statement target must be a Scan');
        if (s.using) {
          checkRel(s.using, { ...root(), prior });
          if (!s.using.type.cols.some((column) => column.name === 'id'))
            throw new Error('RelIR: Delete.using must emit an id column');
        }
        if (s.where) checkExpr(s.where, add(root(), s.target));
        returning(s.returning, add(root(), s.target));
        returningType(s);
        break;
      case 'sequence':
        if (!s.steps.length) throw new Error('RelIR: Sequence requires at least one statement');
        {
          const results: import('./types.ts').RelType[] = [];
          for (const step of s.steps) {
            if (step.kind === 'sequence') throw new Error('RelIR: Sequence cannot contain a nested Sequence');
            checkStmt(step, results);
            results.push(step.returningType);
          }
        }
        break;
    }
  };
  if (!isRel(plan)) {
    if (!isStmt(plan)) throw new Error('RelIR: statement was not constructed by a Stmt factory');
    checkStmt(plan);
  } else checkRel(plan);
  if (bindCount(plan) > DO_BIND_CAP) throw new Error(`RelIR: ${bindCount(plan)} binds exceeds Durable Objects cap of ${DO_BIND_CAP}`);
}
