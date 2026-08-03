import type { Expr } from './expr.ts';
import { joinWidth } from './factory.ts';
import { checkChannels } from './obligations.ts';
import { isRel, type Rel, type RelKind } from './rel.ts';
import type { Binding, Plan } from './plan.ts';
import { isStmt, type Stmt } from './stmt.ts';
import { exprChildren, exprRels, recursiveStep, relChildren, relExprs } from './walk.ts';

export const DO_BIND_CAP = 100;

/** `bindings` is the PLAN scope (§3.0): every `Ref` resolves against a binding declared EARLIER,
 * which is the same rule for a named CTE and for a statement's retained rows. */
interface Scope {
  readonly cols: ReadonlyMap<string, Rel>;
  readonly inAggregate: boolean;
  readonly inWindow: boolean;
  readonly recursive?: { readonly name: string; readonly self: string; readonly allowed: boolean };
  readonly bindings: ReadonlyMap<string, Rel | Stmt>;
}

/** A `RelId` is how an expression names a relation, so two relations sharing one inside a single
 * scope makes every `Col` against it ambiguous — and the last binding silently wins. Fail closed. */
const add = (scope: Scope, rel: Rel): Scope => {
  const bound = scope.cols.get(rel.id);
  if (bound && bound !== rel) throw new Error(`RelIR: relation id '${rel.id}' names two different relations in one scope`);
  return { ...scope, cols: new Map(scope.cols).set(rel.id, rel) };
};
const root = (bindings: ReadonlyMap<string, Rel | Stmt> = new Map()): Scope => ({ cols: new Map(), inAggregate: false, inWindow: false, bindings });
const sameColumns = (left: Rel['type']['cols'], right: Rel['type']['cols']): boolean =>
  left.length === right.length && left.every((column, i) => {
    const other = right[i];
    return other?.name === column.name && other.type === column.type && other.nullable === column.nullable;
  });
const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name, i) => name === right[i]);
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
      if (s.kind === 'insert') { rel(s.source); s.onConflict?.set.forEach(([, e]) => expr(e)); }
      if (s.kind === 'update') { s.set.forEach(([, e]) => expr(e)); if (s.from) rel(s.from); if (s.where) expr(s.where); }
      if (s.kind === 'delete') { if (s.where) expr(s.where); }
      s.returning.forEach(([, e]) => expr(e));
    };
    stmt(plan);
  } else rel(plan);
  return n;
}

/**
 * THE WHOLE PROGRAM's binds — what the database actually counts.
 *
 * `bindCount` answers for one node, and `check` applies the cap per BINDING, which is the right
 * question for a `Stmt` boundary (each is its own statement). A read plan's bindings are CTEs of ONE
 * statement, so its budget is the SUM — and that is the number DO's 100-parameter cap is measured
 * against. Kept beside `bindCount` rather than derived at a call site, because the two must not
 * disagree about what counts as a bind.
 */
export const planBindCount = ({ bindings, result }: Plan): number =>
  bindings.reduce((total, binding) => total + bindCount(binding.node), 0) + bindCount(result);

export function check(plan: Rel | Stmt, bindings: ReadonlyMap<string, Rel | Stmt> = new Map()): void {
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
    //
    // `Materialize` is deliberately NOT in this set, though it is a unary node like the others: it
    // is the one whose whole purpose is to FORCE a named CTE boundary, which is the derived-table
    // wrapping of the self reference that P1 measured as fatal — `circular reference`, even as the
    // sole reference, because SQLite's rule is positional rather than a count. A fence belongs
    // outside the recursive term, never between it and its own walk.
    if (term.kind === 'project' || term.kind === 'filter' || term.kind === 'sort' || term.kind === 'limit'
      || term.kind === 'distinct' || term.kind === 'window' || term.kind === 'explode')
      return term.input?.kind === 'self-ref' && term.input.name === name;
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
  /** Where each of a node's expressions is EVALUATED. A kind that forgets one is caught by the
   * arity assertion below, and `Record<RelKind, …>` means a new kind must declare its placement
   * before the build passes — the same enforcement the channels obligations have. */
  const EXPR_SCOPE: { readonly [K in RelKind]: (node: Extract<Rel, { readonly kind: K }>, inner: Scope) => readonly (readonly [Expr, Scope])[] } = {
    scan: () => [], 'self-ref': () => [], ref: () => [], union: () => [], recursive: () => [],
    values: (node, inner) => node.rows.flat().map((e) => [e, inner] as const),
    project: (node, inner) => node.exprs.map(([, e]) => [e, inner] as const),
    filter: (node, inner) => [[node.pred, inner]],
    sort: (node, inner) => node.terms.map((term) => [term.expr, inner] as const),
    limit: (node, inner) => [...(node.count ? [[node.count, inner] as const] : []), ...(node.offset ? [[node.offset, inner] as const] : [])],
    distinct: () => [],
    materialize: () => [],
    explode: (node, inner) => [[node.expr, inner]],
    join: (node, inner) => (node.on ? [[node.on, inner]] : []),
    // An Agg is legal only here, and a groupBy key is NOT inside the aggregate.
    aggregate: (node, inner) => [
      ...node.groupBy.map((e) => [e, inner] as const),
      ...node.aggs.map(([, e]) => [e, { ...inner, inAggregate: true }] as const),
      ...(node.having ? [[node.having, { ...inner, inAggregate: true }] as const] : []),
    ],
    window: (node, inner) => node.specs.map(([, e]) => [e, { ...inner, inWindow: true }] as const),
  };

  /** Structure that is not channels and not expression placement: arity, duplicate names, and the
   * SQLite laws. Also `Record<RelKind, …>`, for the same reason. */
  const STRUCTURE: { readonly [K in RelKind]: (node: Extract<Rel, { readonly kind: K }>, scope: Scope) => void } = {
    scan: () => {}, filter: () => {}, sort: () => {}, limit: () => {}, distinct: () => {},
    materialize: () => {}, explode: () => {}, window: () => {},
    aggregate: (node) => {
      const declared = node.type.cols.map((column) => column.name);
      if (declared.length !== node.groupBy.length + node.aggs.length)
        throw new Error(`RelIR: Aggregate declares ${declared.length} columns but emits ${node.groupBy.length} group keys and ${node.aggs.length} aggregates`);
      if (node.aggs.some(([name], i) => name !== declared[node.groupBy.length + i]))
        throw new Error('RelIR: Aggregate output must be its group keys followed by its aggregates');
    },
    'self-ref': (node, scope) => {
      if (!scope.recursive || !scope.recursive.allowed || node.name !== scope.recursive.name)
        throw new Error('RelIR: SelfRef is legal only in its Recursive step');
    },
    // A Ref is the plan's ONE naming mechanism, so it answers to the binding rather than to a
    // second inferred type system: same columns, same nullability, or the reference is a lie.
    ref: (node, scope) => {
      const bound = scope.bindings.get(node.name);
      if (!bound) throw new Error(`RelIR: Ref '${node.name}' is not a Plan binding declared before this point`);
      if (!sameColumns(node.type.cols, bound.type.cols)) throw new Error(`RelIR: Ref '${node.name}' type must match its binding's`);
    },
    values: (node) => {
      if (!node.rows.length) throw new Error('RelIR: Values requires at least one row; an empty relation is a Filter, not an empty VALUES');
      if (!node.type.cols.length) throw new Error('RelIR: Values requires at least one column');
      for (const row of node.rows) if (row.length !== node.type.cols.length)
        throw new Error(`RelIR: Values row has ${row.length} columns; declared type has ${node.type.cols.length}`);
    },
    project: (node) => {
      const names = node.exprs.map(([name]) => name);
      if (new Set(names).size !== names.length) throw new Error('RelIR: Project declares a duplicate output name');
      if (!sameNames(names, node.type.cols.map((column) => column.name))) throw new Error('RelIR: Project expressions must declare exactly its output columns');
    },
    join: (node) => {
      // Both sides land in ONE `FROM`, and a derived side is introduced under its RelId — so two
      // sides sharing an id emit the same SQL alias twice ("ambiguous column name"). A replicated
      // subplan (what `unroll` produces) must carry its own ids, not be the same node twice.
      if (node.left.id === node.right.id) throw new Error(`RelIR: a Join's sides must be distinct relations; both are '${node.left.id}'`);
      const needsOn = node.join === 'inner' || node.join === 'left';
      if ((node.join === 'cross' && node.on) || (needsOn && !node.on))
        throw new Error(`RelIR: ${node.join} join ${node.join === 'cross' ? 'must not' : 'requires'} an ON expression`);
      // The emitter names the join's output positionally from both sides, so the declared width and
      // the uniqueness of those names are what make a `Col` against the join resolvable at all.
      const width = joinWidth(node);
      if (node.type.cols.length !== width)
        throw new Error(`RelIR: a ${node.join} Join emits its sides' ${width} columns; its type declares ${node.type.cols.length}`);
      const declared = node.type.cols.map((column) => column.name);
      if (new Set(declared).size !== declared.length) throw new Error('RelIR: a Join declares a duplicate output name');
    },
    union: (node) => {
      if (node.inputs.length < 2) throw new Error('RelIR: Union requires at least two inputs');
      for (const input of node.inputs) if (!sameColumns(input.type.cols, node.type.cols))
        throw new Error('RelIR: Union inputs and output must have identical columns');
    },
    recursive: (node) => {
      if (!sameNames(node.cols, node.type.cols.map((column) => column.name))) throw new Error('RelIR: Recursive CTE header must match its output columns');
      const step = recursiveStep(node);
      const term = recursiveTerm(step, node.name);
      if (term.selfRefs !== 1) throw new Error(`RelIR: Recursive step must reference '${node.name}' exactly once (found ${term.selfRefs})`);
      if (term.aggregate) throw new Error('RelIR: SQLite forbids aggregate queries in a recursive term');
      if (term.window) throw new Error('RelIR: SQLite forbids window functions in a recursive term');
      if (!topLevelSelf(step, node.name)) throw new Error(`RelIR: Recursive step must reference '${node.name}' at the top level of FROM; run flatten first`);
      if (!sameColumns(node.seed.type.cols, step.type.cols)) throw new Error('RelIR: Recursive seed and step types must be identical');
    },
  };

  const checkRel = (r: Rel, scope: Scope): void => {
    if (!isRel(r)) throw new Error('RelIR: relation was not constructed by a Rel factory');
    checkChannels(r);
    (STRUCTURE[r.kind] as (node: Rel, s: Scope) => void)(r, scope);
    if (r.kind === 'self-ref' || r.kind === 'ref') return;
    if (r.kind === 'recursive') {
      checkRel(r.seed, scope);
      checkRel(recursiveStep(r), { ...scope, recursive: { name: r.name, self: r.id, allowed: true } });
      return;
    }
    relChildren(r).forEach((child) => checkRel(child, scope));
    const inner = relChildren(r).reduce(add, scope);
    const placed = (EXPR_SCOPE[r.kind] as (node: Rel, s: Scope) => readonly (readonly [Expr, Scope])[])(r, inner);
    if (placed.length !== relExprs(r).length)
      throw new Error(`RelIR: ${r.kind} has ${relExprs(r).length} expressions but declares a scope for ${placed.length}`);
    placed.forEach(([expression, where]) => checkExpr(expression, where));
  };
  const checkStmt = (s: Stmt): void => {
    if (!isStmt(s)) throw new Error('RelIR: statement was not constructed by a Stmt factory');
    const assignments = (pairs: readonly (readonly [string, Expr])[], what: string): void => {
      if (!pairs.length && what === 'Update') throw new Error('RelIR: Update requires at least one assignment');
      if (new Set(pairs.map(([name]) => name)).size !== pairs.length) throw new Error(`RelIR: duplicate ${what} name`);
    };
    /** A statement's RESULT is a relation like any other, so `type` IS the RETURNING schema — the
     * separate `returningType` this used to check was the same fact spelled twice. */
    const returning = (scope: Scope): void => {
      const names = s.returning.map(([name]) => name);
      if (new Set(names).size !== names.length) throw new Error('RelIR: duplicate RETURNING name');
      if (!sameNames(names, s.type.cols.map((column) => column.name)))
        throw new Error('RelIR: RETURNING expressions must declare exactly the statement type columns');
      s.returning.forEach(([, expression]) => checkExpr(expression, scope));
    };
    if (s.target.kind !== 'scan') throw new Error('RelIR: statement target must be a Scan');
    const targetScope = add(root(bindings), s.target);
    switch (s.kind) {
      case 'insert': {
        for (const column of s.cols) if (!s.target.type.cols.some((declared) => declared.name === column)) throw new Error(`RelIR: Insert target has no column '${column}'`);
        checkRel(s.source, root(bindings));
        if (s.cols.length !== s.source.type.cols.length) throw new Error(`RelIR: Insert has ${s.cols.length} target columns but source emits ${s.source.type.cols.length}`);
        if (new Set(s.cols).size !== s.cols.length) throw new Error('RelIR: Insert has duplicate target column');
        if (s.onConflict) {
          if (!s.onConflict.target.length) throw new Error('RelIR: Insert conflict target cannot be empty');
          if (new Set(s.onConflict.target).size !== s.onConflict.target.length) throw new Error('RelIR: Insert conflict target has duplicate column');
          assignments(s.onConflict.set, 'conflict update');
          s.onConflict.set.forEach(([, expression]) => checkExpr(expression, targetScope));
        }
        returning(targetScope);
        break;
      }
      case 'update': {
        assignments(s.set, 'Update');
        for (const [column] of s.set) if (!s.target.type.cols.some((declared) => declared.name === column)) throw new Error(`RelIR: Update target has no column '${column}'`);
        if (s.from) checkRel(s.from, root(bindings));
        const scope = s.from ? add(targetScope, s.from) : targetScope;
        s.set.forEach(([, expression]) => checkExpr(expression, scope));
        if (s.where) checkExpr(s.where, scope);
        returning(targetScope);
        break;
      }
      case 'delete': {
        // Nothing delete-specific left: membership in another relation is `InQuery` in `where`, and
        // `checkExpr` already validates a subplan against the scope the target is in.
        if (s.where) checkExpr(s.where, targetScope);
        returning(targetScope);
        break;
      }
    }
  };
  if (!isRel(plan)) {
    if (!isStmt(plan)) throw new Error('RelIR: statement was not constructed by a Stmt factory');
    checkStmt(plan);
  } else checkRel(plan, root(bindings));
  if (bindCount(plan) > DO_BIND_CAP) throw new Error(`RelIR: ${bindCount(plan)} binds exceeds Durable Objects cap of ${DO_BIND_CAP}`);
}

/**
 * The whole program (§3.0). Bindings are checked IN ORDER against the bindings declared before
 * them, so a `Ref` forward-referencing — or self-referencing — fails closed rather than resolving
 * by accident, and the ordering the executor relies on is the same ordering the checker proved.
 */
export function checkPlan({ bindings, result }: Plan): void {
  const scope = new Map<string, Rel | Stmt>();
  const declare = (binding: Binding): void => {
    check(binding.node, scope);
    scope.set(binding.name, binding.node);
  };
  bindings.forEach(declare);
  check(result, scope);
}
