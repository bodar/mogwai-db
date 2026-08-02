import { empty, identifier, list, q, raw, render, value, type Expression } from '../sql/kernel/q.ts';
import { check } from './check.ts';
import type { Expr } from './expr.ts';
import type { Rel } from './rel.ts';
import type { Naming } from './passes/name.ts';
import { recursiveSelf } from './factory.ts';
import type { Stmt } from './stmt.ts';

export interface Emitted { readonly sql: string; readonly binds: readonly any[]; }

const ident = (name: string): Expression => identifier(name);
// A lexical relation id is not an SQL alias. Scans own their source alias; derived relations
// are introduced under their RelId by `from()`.
const relName = (rel: Rel): Expression => ident(rel.kind === 'scan' ? rel.alias : rel.id);

/** Render a checked relational plan through the existing q kernel. */
export function emit(plan: Rel, naming?: Naming): Emitted {
  check(plan);
  const named = new Map((naming?.named ?? []).map((binding) => [binding.rel, binding.name]));
  // RelId is lexical and stable under source-alias changes. Only scans introduce an SQL alias;
  // derived relations are introduced under their RelId by `from()`. Resolve Col qualifiers once
  // from the plan rather than requiring callers to make id and alias accidentally identical.
  const sourceAliases = new Map<string, string>();
  const collectExpr = (e: Expr): void => {
    switch (e.kind) {
      case 'unary': case 'cast': collectExpr(e.arg); break;
      case 'binary': collectExpr(e.left); collectExpr(e.right); break;
      case 'case': e.whens.forEach(([when, then]) => { collectExpr(when); collectExpr(then); }); if (e.else) collectExpr(e.else); break;
      case 'call': case 'agg': case 'window-expr': e.args.forEach(collectExpr); break;
      case 'json-object': e.entries.forEach(([, value]) => collectExpr(value)); break;
      case 'json-array': e.items.forEach(collectExpr); break;
      case 'scalar': case 'exists': collectAliases(e.plan); break;
      case 'in-list': collectExpr(e.expr); e.values.forEach(collectExpr); break;
      case 'in-query': collectExpr(e.expr); collectAliases(e.plan); break;
      default: break;
    }
  };
  const collectAliases = (r: Rel): void => {
    if (r.kind === 'scan') sourceAliases.set(r.id, r.alias);
    switch (r.kind) {
      case 'project': r.exprs.forEach(([, e]) => collectExpr(e)); collectAliases(r.input); break;
      case 'filter': collectExpr(r.pred); collectAliases(r.input); break;
      case 'aggregate': r.groupBy.forEach(collectExpr); r.aggs.forEach(([, e]) => collectExpr(e)); if (r.having) collectExpr(r.having); collectAliases(r.input); break;
      case 'sort': r.terms.forEach((term) => collectExpr(term.expr)); collectAliases(r.input); break;
      case 'limit': if (r.count) collectExpr(r.count); if (r.offset) collectExpr(r.offset); collectAliases(r.input); break;
      case 'distinct': r.on?.forEach(collectExpr); collectAliases(r.input); break;
      case 'window': r.specs.forEach(([, e]) => collectExpr(e)); collectAliases(r.input); break;
      case 'explode': collectExpr(r.expr); collectAliases(r.input); break;
      case 'materialize': collectAliases(r.input); break;
      case 'values': r.rows.forEach((row) => row.forEach(collectExpr)); break;
      case 'join': collectAliases(r.left); collectAliases(r.right); break;
      case 'union': r.inputs.forEach(collectAliases); break;
      case 'recursive': collectAliases(r.seed); collectAliases(r.step(recursiveSelf(r))); break;
      default: break;
    }
  };
  collectAliases(plan);
  const qualifier = (id: string): Expression => ident(sourceAliases.get(id) ?? id);
  const expr = (e: Expr): Expression => {
    switch (e.kind) {
      case 'col': return q`${qualifier(e.rel)}.${ident(e.name)}`;
      case 'lit': return value(e.value);
      case 'param': throw new Error(`RelIR emitter requires parameter binding for '${e.name}'`);
      case 'unary': return e.op === 'not' ? q`NOT (${expr(e.arg)})` : q`-(${expr(e.arg)})`;
      case 'binary': return q`(${expr(e.left)} ${raw(e.op.toUpperCase())} ${expr(e.right)})`;
      case 'case': return q`CASE ${list(e.whens.map(([when, then]) => q`WHEN ${expr(when)} THEN ${expr(then)}`), ' ')}${e.else ? q` ELSE ${expr(e.else)}` : empty} END`;
      case 'cast': return q`CAST(${expr(e.arg)} AS ${raw(e.to.toUpperCase())})`;
      case 'call': return q`${raw(e.fn)}(${e.distinct ? raw('DISTINCT ') : empty}${list(e.args.map(expr))})`;
      case 'agg': return q`${raw(e.fn)}(${e.distinct ? raw('DISTINCT ') : empty}${list(e.args.map(expr))}${e.orderBy?.length ? q` ORDER BY ${list(e.orderBy.map(sort))}` : empty})`;
      case 'window-expr': return q`${raw(e.fn)}(${list(e.args.map(expr))}) OVER (${window(e.spec)})`;
      case 'json-object': return q`${raw(e.binary ? 'jsonb_object' : 'json_object')}(${list(e.entries.flatMap(([key, val]) => [value(key), expr(val)]))})`;
      case 'json-array': return q`${raw(e.binary ? 'jsonb_array' : 'json_array')}(${list(e.items.map(expr))})`;
      case 'scalar': return q`(${relation(e.plan)})`;
      case 'exists': return q`${e.negated ? raw('NOT ') : empty}EXISTS (${relation(e.plan)})`;
      case 'in-list': return q`${expr(e.expr)} IN (${list(e.values.map(expr))})`;
      case 'in-query': return q`${expr(e.expr)} ${e.negated ? raw('NOT ') : empty}IN (${relation(e.plan)})`;
    }
  };
  const sort = (term: { readonly expr: Expr; readonly dir: 'asc' | 'desc'; readonly nulls?: 'first' | 'last' }): Expression =>
    q`${expr(term.expr)} ${raw(term.dir.toUpperCase())}${term.nulls ? q` NULLS ${raw(term.nulls.toUpperCase())}` : empty}`;
  const window = (spec: Extract<Expr, { kind: 'window-expr' }>['spec']): Expression => {
    const frame = spec.frame ? q` ${raw(spec.frame.mode.toUpperCase())} BETWEEN ${bound(spec.frame.start)} AND ${bound(spec.frame.end)}` : empty;
    return q`${spec.partitionBy.length ? q`PARTITION BY ${list(spec.partitionBy.map(expr))}` : empty}${spec.orderBy.length ? q`${spec.partitionBy.length ? raw(' ') : empty}ORDER BY ${list(spec.orderBy.map(sort))}` : empty}${frame}`;
  };
  const bound = (b: import('./types.ts').FrameBound): Expression => b.kind === 'preceding' || b.kind === 'following'
    ? q`${expr(b.count)} ${raw(b.kind.toUpperCase())}`
    : raw(b.kind.replaceAll('-', ' ').toUpperCase());
  const from = (r: Rel): Expression => r.kind === 'scan'
    ? q`${ident(r.table)} ${ident(r.alias)}`
    // A recursive reference is a table source, never a derived relation. SQLite requires it
    // exactly once at the recursive term's top-level FROM; wrapping it emits "circular reference".
    : r.kind === 'self-ref'
      ? q`${ident(r.name)} ${relName(r)}`
      : q`(${relation(r)}) ${relName(r)}`;
  const relation = (r: Rel, inline = false): Expression => {
    const cte = named.get(r);
    if (!inline && cte) return q`SELECT * FROM ${ident(cte)}`;
    switch (r.kind) {
      case 'scan': return q`SELECT ${list(r.type.cols.map((c) => q`${ident(r.alias)}.${ident(c.name)} AS ${ident(c.name)}`))} FROM ${from(r)}`;
      case 'self-ref': return q`SELECT ${list(r.type.cols.map((c) => q`${ident(r.name)}.${ident(c.name)} AS ${ident(c.name)}`))} FROM ${ident(r.name)}`;
      case 'prior-result': throw new Error('RelIR PriorResult emits only inside a write Sequence');
      case 'values': {
        const rows = q`VALUES ${list(r.rows.map((row) => q`(${list(row.map(expr))})`))}`;
        // SQLite calls anonymous VALUES columns column1, column2, … . Re-project them
        // immediately to RelIR's declared schema so downstream Col resolution is truthful.
        return q`SELECT ${list(r.type.cols.map((column, i) => q`${raw(`column${i + 1}`)} AS ${ident(column.name)}`))} FROM (${rows})`;
      }
      case 'project': return q`SELECT ${list(r.exprs.map(([name, e]) => q`${expr(e)} AS ${ident(name)}`))} FROM ${from(r.input)}`;
      case 'filter': return q`SELECT * FROM ${from(r.input)} WHERE ${expr(r.pred)}`;
      case 'aggregate': return q`SELECT ${list([...r.groupBy.map(expr), ...r.aggs.map(([name,e]) => q`${expr(e)} AS ${ident(name)}`)])} FROM ${from(r.input)}${r.groupBy.length ? q` GROUP BY ${list(r.groupBy.map(expr))}` : empty}${r.having ? q` HAVING ${expr(r.having)}` : empty}`;
      case 'sort': return q`SELECT * FROM ${from(r.input)} ORDER BY ${list(r.terms.map(sort))}`;
      case 'limit': return q`SELECT * FROM ${from(r.input)}${r.count ? q` LIMIT ${expr(r.count)}` : empty}${r.offset ? q`${r.count ? raw(' ') : raw(' LIMIT -1 ')}OFFSET ${expr(r.offset)}` : empty}`;
      case 'distinct': return q`SELECT DISTINCT ${r.on?.length ? list(r.on.map(expr)) : raw('*')} FROM ${from(r.input)}`;
      case 'window': return q`SELECT ${relName(r.input)}.*, ${list(r.specs.map(([name,e]) => q`${expr(e)} AS ${ident(name)}`))} FROM ${from(r.input)}`;
      case 'explode': return q`SELECT ${relName(r.input)}.*, je.key AS ${ident(r.as.key ?? 'key')}, je.value AS ${ident(r.as.value)}${r.as.ord ? q`, je.key AS ${ident(r.as.ord)}` : empty} FROM ${from(r.input)}, json_each(${expr(r.expr)}) je`;
      case 'materialize': return relation(r.input);
      case 'join': {
        if (r.join === 'semi' || r.join === 'anti') return q`SELECT ${relName(r.left)}.* FROM ${from(r.left)} WHERE ${r.join === 'anti' ? raw('NOT ') : empty}EXISTS (SELECT 1 FROM ${from(r.right)}${r.on ? q` WHERE ${expr(r.on)}` : empty})`;
        const join = r.join === 'cross' ? raw('CROSS JOIN') : raw(`${r.join.toUpperCase()} JOIN`);
        return q`SELECT * FROM ${from(r.left)} ${join} ${from(r.right)}${r.join === 'cross' ? empty : q` ON ${expr(r.on!)}`}`;
      }
      case 'union': return list(r.inputs.map((input) => q`(${relation(input)})`), r.all ? ' UNION ALL ' : ' UNION ');
      case 'recursive': { const step = r.step(recursiveSelf(r)); return q`WITH RECURSIVE ${ident(r.name)}(${list(r.cols.map(ident))}) AS (${relation(r.seed)} UNION ALL ${relation(step)}) SELECT * FROM ${ident(r.name)}`; }
    }
  };
  const root = relation(plan);
  const bindings = naming?.named.map((binding) => q`${ident(binding.name)} AS (${relation(binding.rel, true)})`) ?? [];
  // A recursive root owns a WITH RECURSIVE clause. Its named dependencies must be peers in that
  // clause; prefixing a second plain WITH would produce invalid SQLite syntax.
  const tree = plan.kind === 'recursive' && bindings.length
    ? (() => {
      const step = plan.step(recursiveSelf(plan));
      const recursive = q`${ident(plan.name)}(${list(plan.cols.map(ident))}) AS (${relation(plan.seed)} UNION ALL ${relation(step)})`;
      return q`WITH RECURSIVE ${list([...bindings, recursive])} SELECT * FROM ${ident(plan.name)}`;
    })()
    : bindings.length ? q`WITH ${list(bindings)} ${root}` : root;
  const out = render(tree);
  return { sql: out.sql, binds: out.binds };
}

/** Render the first executable write wedge. SQLite has no DELETE ... USING: `using` is the
 * RelIR contract that supplies physical table ids, so it lowers to membership in a derived read.
 * Other statement forms wait for their target-scope contract rather than accepting unscoped
 * physical-column expressions. */
export function emitStmt(statement: Stmt): Emitted {
  check(statement);
  if (statement.kind !== 'delete') throw new Error(`RelIR statement emitter does not yet support ${statement.kind}`);
  if (!statement.using) throw new Error('RelIR Delete emission requires a using relation');
  if (statement.where || statement.returning.length) throw new Error('RelIR Delete emission currently supports only using-based membership');
  const using = emit(statement.using);
  const tree = q`DELETE FROM ${ident(statement.table)} WHERE ${ident('id')} IN (SELECT ${ident('id')} FROM (${raw(using.sql)}) ${ident(statement.using.id)})`;
  const out = render(tree);
  return { sql: out.sql, binds: [...using.binds, ...out.binds] };
}
