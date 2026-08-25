import { bindsAsParameter, type Expr } from './expr.ts';
import { scan } from './factory.ts';
import { checkAggregateShape, checkJoinShape, checkRecursiveHeader, checkValuesShape } from './structure.ts';
import { checkChannels } from './obligations.ts';
import { recursiveViolation } from './recursive.ts';
import { isRel, type Rel, type RelKind } from './rel.ts';
import { retained, type Binding, type Plan } from './plan.ts';
import { isStmt, type Stmt } from './stmt.ts';
import { exprChildren, exprRels, recursiveStep, refNames, relChildren, relExprs } from './walk.ts';
import { EXCLUDED, sameColumns, sameNames } from './types.ts';

export const DO_BIND_CAP = 100;

/**
 * THE ONE FAILURE A CALLER MAY ANSWER BY DECLINING.
 *
 * Every other violation the checker or the emitter raises is a BUG in whatever built the plan, and
 * must escape (§11 — a `catch` that swallowed them would turn the failure `rel-sweep` exists to see
 * into a silent decline). The bind budget is different: a traversal we could otherwise answer must
 * not become a hard failure because the lowering spells its predicate more expensively, so the cap
 * is a COVERAGE question. A distinct class is what lets `lowerToRel` decline on exactly that and
 * nothing else, without matching on a message.
 */
export class BindBudgetExceeded extends Error {
  constructor(readonly count: number) {
    super(`RelIR: ${count} binds exceeds Durable Objects cap of ${DO_BIND_CAP}`);
    this.name = 'BindBudgetExceeded';
  }
}

/** `bindings` is the PLAN scope (§3.0): every `Ref` resolves against a binding declared EARLIER,
 * which is the same rule for a named CTE and for a statement's retained rows. */
interface Scope {
  readonly cols: ReadonlyMap<string, Rel>;
  readonly inAggregate: boolean;
  readonly inWindow: boolean;
  /**
   * The BARE-COLUMN rule inside an `Aggregate` — which relation is being grouped, which of its
   * columns the `GROUP BY` fixed, and whether we are currently inside an `Agg`'s own arguments.
   *
   * ⚠️ **SQLite ACCEPTS `SELECT k, x FROM t GROUP BY k` and returns `x` from an ARBITRARY row of each
   * group.** Every other engine rejects it; SQLite documents it as a feature. So a lowering that
   * reads an ungrouped column in `aggs` gets a plausible value from whichever row the scan reached
   * first — right arity, right shape, wrong value, and non-deterministic between runs and between
   * runtimes. `test:perturbed` is the only instrument that could see it and only by luck.
   *
   * Present only while checking `aggs`/`having`; a `groupBy` key is not inside the aggregate and is
   * what makes a column legal in the first place.
   */
  readonly grouped?: { readonly rel: string; readonly keys: ReadonlySet<string>; readonly insideAgg: boolean };
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
/** The `excluded` pseudo-relation an `ON CONFLICT` clause reads: the target's own row shape under
 *  the reserved identity, so a `Col` against it checks against real columns like any other. */
const excludedRow = (target: Extract<Rel, { readonly kind: 'scan' }>): Rel =>
  scan({ id: EXCLUDED, table: target.table, alias: 'excluded', channels: target.channels, type: target.type });
const root = (bindings: ReadonlyMap<string, Rel | Stmt> = new Map()): Scope => ({ cols: new Map(), inAggregate: false, inWindow: false, bindings });
/**
 * The binds this node will render, counting a repeated wire PARAMETER ONCE.
 *
 * A user parameter renders as a numbered placeholder deduped BY NAME (`renderStatement`, q.ts), so N
 * uses of one `$x` cost a single bind — hence distinct names, via the Set. A mechanical `'bound'` bind
 * (an oversized collection / decimal tail) has no name and does not dedup, so it is counted by
 * OCCURRENCE: a shared node the `Name` pass inlines twice contributes twice, and counting the DAG once
 * could under-report — the failure that only appears in production.
 *
 * PER NODE. `check` uses it as the per-binding budget guard (each `Stmt` is its own statement); it is
 * NOT summed across a read plan's CTEs — the whole-statement authority is the rendered bind list, which
 * `lowerToRel` renders and counts directly, catching this guard's throw as a decline. So a parameter
 * shared across CTEs is one bind (the render dedups it), never the double-count a naive sum would make. */
export function bindCount(plan: Rel | Stmt): number {
  const paramNames = new Set<string>();
  let mechanical = 0;
  const expr = (e: Expr): void => {
    if (e.kind === 'lit' && bindsAsParameter(e)) {
      if (e.source === 'parameter') paramNames.add(e.name);
      else mechanical++;
    }
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
  return paramNames.size + mechanical;
}

export function check(plan: Rel | Stmt, bindings: ReadonlyMap<string, Rel | Stmt> = new Map()): void {
  // SQLite's recursive-term laws — which nodes may fuse into the term, and where the walk's own
  // reference must land — are `recursiveViolation` (`recursive.ts`). They are shared with the
  // LOWERING, which asks the identical question in order to DECLINE rather than to throw.
  const checkExpr = (e: Expr, scope: Scope): void => {
    if (e.kind === 'col') {
      const bound = scope.cols.get(e.rel);
      if (!bound) throw new Error(`RelIR: no relation '${e.rel}' is in scope for column '${e.name}'`);
      if (!bound.type.cols.some((column) => column.name === e.name)) throw new Error(`RelIR: relation ${e.rel} has no declared column '${e.name}'`);
      const { grouped } = scope;
      if (grouped && !grouped.insideAgg && grouped.rel === e.rel && !grouped.keys.has(e.name))
        throw new Error(`RelIR: '${e.name}' is neither a group key nor inside an Agg — SQLite would return it from an ARBITRARY row of each group rather than rejecting the query`);
      return;
    }
    if (e.kind === 'agg' && !scope.inAggregate) throw new Error('RelIR: Agg is legal only in Aggregate.aggs');
    if (e.kind === 'window-expr' && !scope.inWindow) throw new Error('RelIR: WindowExpr is legal only in Window.specs');
    const child = (x: Expr) => checkExpr(x, scope);
    switch (e.kind) { case 'unary': child(e.arg); break; case 'binary': child(e.left); child(e.right); break; case 'case': e.whens.forEach(([a,b]) => { child(a); child(b); }); if (e.else) child(e.else); break; case 'cast': child(e.arg); break; case 'call': e.args.forEach(child); break;
      // An `Agg`'s ORDER BY terms and its `FILTER (WHERE …)` are expressions in the SAME scope as its
      // arguments, and they were not being walked — so a `Col` naming a relation out of scope inside
      // either one reached the emitter unchecked. `exprChildren` (walk.ts) has always included the order
      // terms; this arm is what makes the CHECK agree with the walk.
      // Inside an `Agg` every input column is legal again — that is what an aggregate IS — so the
      // bare-column rule lifts for its arguments, its ORDER BY terms and its FILTER alike.
      case 'agg': {
        const inside = scope.grouped ? { ...scope, grouped: { ...scope.grouped, insideAgg: true } } : scope;
        const arg = (x: Expr) => checkExpr(x, inside);
        e.args.forEach(arg); (e.orderBy ?? []).forEach((term) => arg(term.expr)); if (e.filter) arg(e.filter);
        break;
      }
      case 'window-expr': e.args.forEach(child); break; case 'json-object': e.entries.forEach(([,x]) => child(x)); break; case 'json-array': e.items.forEach(child); break; case 'scalar': case 'exists': checkRel(e.plan, scope); break; case 'in-list': child(e.expr); e.values.forEach(child); break; case 'in-query': child(e.expr); checkRel(e.plan, scope); break; default: break; }
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
    // An Agg is legal only here, and a groupBy key is NOT inside the aggregate — it is checked in the
    // plain scope, and it is also what FIXES a column so a later bare reference to it is legal.
    // Only a groupBy term that IS a bare column of the input fixes a name: a keyed expression fixes
    // that expression, and a bare `Col` is not the same expression as `lower(col)`.
    aggregate: (node, inner) => {
      const grouped = {
        rel: node.input.id,
        keys: new Set(node.groupBy.flatMap((e) => (e.kind === 'col' && e.rel === node.input.id ? [e.name] : []))),
        insideAgg: false,
      };
      const aggregating = { ...inner, inAggregate: true, grouped };
      return [
        ...node.groupBy.map((e) => [e, inner] as const),
        ...node.aggs.map(([, e]) => [e, aggregating] as const),
        ...(node.having ? [[node.having, aggregating] as const] : []),
      ];
    },
    window: (node, inner) => node.specs.map(([, e]) => [e, { ...inner, inWindow: true }] as const),
  };

  /** Structure that is not channels and not expression placement: arity, duplicate names, and the
   * SQLite laws. Also `Record<RelKind, …>`, for the same reason. */
  const preservingType = (node: Rel & { readonly input: Rel }): void => {
    if (!sameColumns(node.type.cols, node.input.type.cols))
      throw new Error(`RelIR: ${node.kind} type must match its input's`);
  };
  const STRUCTURE: { readonly [K in RelKind]: (node: Extract<Rel, { readonly kind: K }>, scope: Scope) => void } = {
    scan: () => {},
    // These five preserve their input type. Window and Explode also preserve columns for pruning,
    // but legitimately extend their declared type, so the two overlapping sets are not one law.
    filter: preservingType, sort: preservingType, limit: preservingType, distinct: preservingType,
    materialize: preservingType, explode: () => {}, window: () => {},
    aggregate: (node) => checkAggregateShape(node),
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
    values: (node) => checkValuesShape(node),
    project: (node) => {
      const names = node.exprs.map(([name]) => name);
      if (new Set(names).size !== names.length) throw new Error('RelIR: Project declares a duplicate output name');
      if (!sameNames(names, node.type.cols.map((column) => column.name))) throw new Error('RelIR: Project expressions must declare exactly its output columns');
    },
    join: (node) => {
      // Both sides land in ONE `FROM`, and a derived side is introduced under its RelId — so two
      // sides sharing an id emit the same SQL alias twice ("ambiguous column name"). A replicated
      // subplan (what `unroll` produces) must carry its own ids, not be the same node twice. This is a
      // TREE law a factory cannot see, so it stays here; the shape laws (ON/order/width/dup-name) are shared.
      if (node.left.id === node.right.id) throw new Error(`RelIR: a Join's sides must be distinct relations; both are '${node.left.id}'`);
      checkJoinShape(node);
      if (node.join === 'left' && node.type.cols.slice(node.left.type.cols.length).some((column) => !column.nullable))
        throw new Error("RelIR: a left Join's right-side output columns must be nullable");
    },
    union: (node) => {
      if (node.inputs.length < 2) throw new Error('RelIR: Union requires at least two inputs');
      for (const input of node.inputs) if (!sameColumns(input.type.cols, node.type.cols))
        throw new Error('RelIR: Union inputs and output must have identical columns');
    },
    recursive: (node) => {
      checkRecursiveHeader(node);
      // THE SAME ANSWER THE LOWERING DECLINES ON. Here it is a bug in whatever built the plan, so it
      // throws; `recursive.ts` states why one function serves both. A TREE law, so it stays here.
      const violation = recursiveViolation(node);
      if (violation) throw new Error(`RelIR: ${violation}`);
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
          // The incoming row is in scope for this clause and no other, exactly as SQLite scopes it.
          const merging = add(targetScope, excludedRow(s.target));
          s.onConflict.set.forEach(([, expression]) => checkExpr(expression, merging));
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
  if (bindCount(plan) > DO_BIND_CAP) throw new BindBudgetExceeded(bindCount(plan));
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
  checkSnapshots({ bindings, result });
}

/**
 * A RE-EVALUATED CTE IS A DIFFERENT QUESTION ONCE SOMETHING HAS BEEN WRITTEN.
 *
 * A `Rel` binding is a CTE, which every step naming it computes for itself. In a read program that
 * is invisible; in one with effects it is the vertex-drop cascade's whole failure mode — the target
 * relation reads `edges`, the incident-edge delete runs, and the vertex delete then matches nothing.
 * A `snapshot` binding is the answer (§3.0), and this is what makes using it obligatory rather than
 * remembered: **in a program with effects, a plain `Rel` binding read by more than one step must be
 * a snapshot.** Reached through the same step only once, a CTE is still exactly right, so the rule
 * names the hazard and nothing wider.
 *
 * A THROW rather than a decline, and the distinction is the one §11 draws: an unlowered step is
 * coverage we do not have, but a plan whose answer depends on which statement ran first is a bug in
 * whatever built it.
 */
function checkSnapshots({ bindings, result }: Plan): void {
  if (!bindings.some((binding) => isStmt(binding.node))) return;
  const declared = new Map(bindings.map((binding) => [binding.name, binding] as const));
  // A step reads a binding TRANSITIVELY: a CTE naming another CTE puts both in the same statement.
  // The walk stops at a retained binding, whose rows that step reads as a bind rather than recompute.
  const reads = (node: Rel | Stmt): ReadonlySet<string> => {
    const seen = new Set<string>();
    const pending = [...refNames(node)];
    while (pending.length) {
      const name = pending.pop()!;
      const binding = declared.get(name);
      if (!binding || retained(binding) || seen.has(name)) continue;
      seen.add(name);
      pending.push(...refNames(binding.node));
    }
    return seen;
  };
  const readers = new Map<string, number>();
  const step = (node: Rel | Stmt): void => {
    for (const name of reads(node)) readers.set(name, (readers.get(name) ?? 0) + 1);
  };
  for (const binding of bindings) if (retained(binding)) step(binding.node);
  // The trailing read is a step too — unless the result IS a retained binding, which the executor
  // already holds and never re-reads.
  const resultBinding = result.kind === 'ref' ? declared.get(result.name) : undefined;
  if (!(resultBinding && retained(resultBinding))) step(result);
  for (const [name, count] of readers) {
    if (count > 1)
      throw new Error(`RelIR: binding '${name}' is read by ${count} steps of a program with effects; a re-evaluated CTE is a different question after a write, so it must be a snapshot`);
  }
}
