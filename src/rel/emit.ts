import { empty, identifier, list, q, raw, render, value, type Expression } from '../sql/kernel/q.ts';
import { DO_BIND_CAP, checkPlan } from './check.ts';
import type { Expr } from './expr.ts';
import { recursiveSelf } from './factory.ts';
import { explodeColumns } from './obligations.ts';
import type { Binding, Plan } from './plan.ts';
import type { Rel } from './rel.ts';
import { isStmt, type Stmt } from './stmt.ts';
import type { FrameBound, SortTerm, WindowSpec } from './types.ts';

export interface Emitted { readonly sql: string; readonly binds: readonly any[]; }

/**
 * A bind the EXECUTOR fills in: the retained `RETURNING` rows of an earlier statement binding,
 * landed as ONE JSON bind exploded by `json_each` — never a row-count-sized placeholder list,
 * which is the DO 100-parameter wall (§3.6). It travels in `Emitted.binds` in its own position, so
 * `emit` never learns about chunking and the executor never parses SQL to find the slot.
 */
export interface RowsBind { readonly rowsOf: string; }
export const isRowsBind = (bind: unknown): bind is RowsBind =>
  typeof bind === 'object' && bind !== null && typeof (bind as RowsBind).rowsOf === 'string';

/** One executable statement of a `Plan`, in execution order. A `Rel` binding is a CTE and produces
 * no step of its own; a `Stmt` binding is a step whose `RETURNING` rows the executor retains. */
export interface Step { readonly binding?: string; readonly result: boolean; readonly emitted: Emitted; }

/**
 * The emitter is a SELECT BLOCK ASSEMBLER (§5 of the RelIR build plan).
 *
 * RelIR is normalized — one operator per node — while SQL's `SELECT` is a COMPOSITION of operators
 * with fixed slots. Converting between those two shapes is this module's whole job: walk down from a
 * node filling slots, and open a nested `SELECT` only when the slot you need is already occupied.
 * That is why `Project(Filter(Join))` is ONE statement rather than three derived tables, and it is
 * what will delete `TailAcc` — the accumulator that exists only because the legacy lowering has
 * nowhere to fuse. Prior art: Calcite's `RelToSqlConverter`, same algorithm, same reason.
 *
 * The alternative — letting a `fuse` pass collapse a run into a `Select` mega-node — is refused:
 * it would put the SQL surface inside the IR and give every downstream pass two forms of the same
 * thing to handle.
 *
 * It is TOTAL: every node kind has an arm and there is no fallback branch, so a node it cannot
 * render is a compile error rather than a runtime throw.
 */

const ident = (name: string): Expression => identifier(name);
const qualified = (alias: string, name: string): Expression => q`${ident(alias)}.${ident(name)}`;

/** A FROM item: a table, a CTE name, a derived SELECT or a table-valued function, plus its alias. */
interface FromItem { readonly text: Expression; readonly alias: string; }
interface JoinItem { readonly kind: 'inner' | 'left' | 'cross'; readonly item: FromItem; readonly on?: Expression; }

/** How a relation in scope spells each of its columns IN THE BLOCK BEING ASSEMBLED. Fusing a node
 * into the block means its outputs are spelled as the expressions that compute them, not as a
 * derived table's `alias.name` — which is exactly what removes the nesting. */
type Cols = ReadonlyMap<string, Expression>;
type Scope = ReadonlyMap<string, Cols>;

interface Block {
  readonly kind: 'block';
  readonly select: readonly (readonly [string, Expression])[];
  readonly from: FromItem;
  readonly joins: readonly JoinItem[];
  readonly where?: Expression;
  /** Present (even empty) once the block aggregates: `[]` is a whole-relation aggregate, which
   * emits no GROUP BY clause but still occupies the slot. */
  readonly groupBy?: readonly Expression[];
  readonly having?: Expression;
  readonly orderBy?: readonly Expression[];
  readonly limit?: Expression;
  readonly offset?: Expression;
  readonly distinct: boolean;
  /** The select list contains a window function, so nothing may reference it from WHERE, GROUP BY
   * or a table-valued function argument. Monotone until a nested SELECT closes the block. */
  readonly windowed: boolean;
  readonly scope: Scope;
}

/** A set operation or a recursive CTE: a complete SELECT with no free slots to fill. */
interface Closed { readonly kind: 'closed'; readonly body: Expression; }
type Built = Block | Closed;

const EMPTY_SCOPE: Scope = new Map();
const withRel = (scope: Scope, id: string, cols: Cols): Scope => new Map(scope).set(id, cols);
const mergeScopes = (...scopes: readonly Scope[]): Scope => new Map(scopes.flatMap((scope) => [...scope]));
const colsOf = (alias: string, r: Rel): Cols => new Map(r.type.cols.map((column) => [column.name, qualified(alias, column.name)]));
const conjoin = (left: Expression | undefined, right: Expression | undefined): Expression | undefined =>
  left && right ? q`(${left} AND ${right})` : left ?? right;
const concat = (parts: readonly Expression[]): Expression => (parts.length ? list(parts, '') : empty);

/** Slots whose occupancy means a node cannot be fused into this block. */
const tailUsed = (b: Block): boolean => b.orderBy !== undefined || b.limit !== undefined || b.offset !== undefined || b.distinct;
const grouped = (b: Block): boolean => b.groupBy !== undefined;
/** A side of a join may be spliced into the join's own FROM only when it fills nothing else. */
const spliceable = (b: Block): boolean => !grouped(b) && b.having === undefined && !tailUsed(b) && !b.windowed;

interface Side {
  readonly from: FromItem;
  readonly joins: readonly JoinItem[];
  readonly where?: Expression;
  /** The side's columns in its own declared order — the join's positional select list. */
  readonly cols: readonly Expression[];
  readonly scope: Scope;
}

function assembler(bindings: ReadonlyMap<string, Binding>) {

  const expr = (e: Expr, scope: Scope): Expression => {
    const self = (x: Expr): Expression => expr(x, scope);
    switch (e.kind) {
      case 'col': {
        const column = scope.get(e.rel)?.get(e.name);
        if (!column) throw new Error(`RelIR emitter: column '${e.name}' of relation '${e.rel}' is not in scope`);
        return column;
      }
      case 'lit': return value(e.value);
      case 'unary': return e.op === 'not' ? q`NOT (${self(e.arg)})` : q`-(${self(e.arg)})`;
      case 'binary': return q`(${self(e.left)} ${raw(e.op.toUpperCase())} ${self(e.right)})`;
      case 'case': return q`CASE ${list(e.whens.map(([when, then]) => q`WHEN ${self(when)} THEN ${self(then)}`), ' ')}${e.else ? q` ELSE ${self(e.else)}` : empty} END`;
      case 'cast': return q`CAST(${self(e.arg)} AS ${raw(e.to.toUpperCase())})`;
      case 'call': return q`${raw(e.fn)}(${e.distinct ? raw('DISTINCT ') : empty}${list(e.args.map(self))})`;
      case 'agg': return q`${raw(e.fn)}(${e.distinct ? raw('DISTINCT ') : empty}${list(e.args.map(self))}${e.orderBy?.length ? q` ORDER BY ${list(e.orderBy.map((term) => sortTerm(term, scope)))}` : empty})`;
      case 'window-expr': return q`${raw(e.fn)}(${list(e.args.map(self))}) OVER (${windowSpec(e.spec, scope)})`;
      case 'json-object': return q`${raw(e.binary ? 'jsonb_object' : 'json_object')}(${list(e.entries.flatMap(([key, val]) => [value(key), self(val)]))})`;
      case 'json-array': return q`${raw(e.binary ? 'jsonb_array' : 'json_array')}(${list(e.items.map(self))})`;
      case 'scalar': return q`(${renderRel(e.plan, scope)})`;
      case 'exists': return q`${e.negated ? raw('NOT ') : empty}EXISTS (${renderRel(e.plan, scope)})`;
      case 'in-list': return q`${self(e.expr)} IN (${list(e.values.map(self))})`;
      case 'in-query': return q`${self(e.expr)} ${e.negated ? raw('NOT ') : empty}IN (${renderRel(e.plan, scope)})`;
    }
  };

  const sortTerm = (term: SortTerm, scope: Scope): Expression =>
    q`${expr(term.expr, scope)} ${raw(term.dir.toUpperCase())}${term.nulls ? q` NULLS ${raw(term.nulls.toUpperCase())}` : empty}`;
  const frameBound = (bound: FrameBound, scope: Scope): Expression =>
    bound.kind === 'preceding' || bound.kind === 'following'
      ? q`${expr(bound.count, scope)} ${raw(bound.kind.toUpperCase())}`
      : raw(bound.kind.replaceAll('-', ' ').toUpperCase());
  const windowSpec = (spec: WindowSpec, scope: Scope): Expression => {
    const partition = spec.partitionBy.length ? q`PARTITION BY ${list(spec.partitionBy.map((e) => expr(e, scope)))}` : empty;
    const order = spec.orderBy.length ? q`${spec.partitionBy.length ? raw(' ') : empty}ORDER BY ${list(spec.orderBy.map((term) => sortTerm(term, scope)))}` : empty;
    const frame = spec.frame ? q` ${raw(spec.frame.mode.toUpperCase())} BETWEEN ${frameBound(spec.frame.start, scope)} AND ${frameBound(spec.frame.end, scope)}` : empty;
    return q`${partition}${order}${frame}`;
  };

  // ---------- rendering a finished block ----------

  const fromText = (item: FromItem): Expression => q`${item.text} ${ident(item.alias)}`;
  const joinText = (join: JoinItem): Expression => {
    const keyword = join.kind === 'cross' ? raw('CROSS JOIN') : raw(`${join.kind.toUpperCase()} JOIN`);
    return q` ${keyword} ${fromText(join.item)}${join.on ? q` ON ${join.on}` : empty}`;
  };

  const renderBlock = (b: Block): Expression => q`SELECT ${b.distinct ? raw('DISTINCT ') : empty}${
    list(b.select.map(([name, e]) => q`${e} AS ${ident(name)}`))
  } FROM ${fromText(b.from)}${concat(b.joins.map(joinText))}${
    b.where ? q` WHERE ${b.where}` : empty
  }${b.groupBy?.length ? q` GROUP BY ${list(b.groupBy)}` : empty}${
    b.having ? q` HAVING ${b.having}` : empty
  }${b.orderBy?.length ? q` ORDER BY ${list(b.orderBy)}` : empty}${
    b.limit ? q` LIMIT ${b.limit}` : empty
  }${b.offset ? q`${b.limit ? raw(' ') : raw(' LIMIT -1 ')}OFFSET ${b.offset}` : empty}`;

  const renderBuilt = (built: Built): Expression => (built.kind === 'closed' ? built.body : renderBlock(built));
  const renderRel = (r: Rel, outer: Scope): Expression => renderBuilt(build(r, outer));

  // ---------- sources ----------

  /** A relation that can stand in a FROM clause without a wrapping SELECT. A named CTE reference is
   * one of these, which is what makes `... FROM edges e INNER JOIN c2 p ON …` reachable at all. */
  const directSource = (r: Rel, outer: Scope): { item: FromItem; cols: Cols } | undefined => {
    if (r.kind === 'ref') return refSource(r);
    if (r.kind === 'scan') return { item: { text: ident(r.table), alias: r.alias }, cols: colsOf(r.alias, r) };
    // A recursive reference is a table source, never a derived relation: SQLite requires it exactly
    // once at the recursive term's top-level FROM and reports "circular reference" if it is wrapped.
    if (r.kind === 'self-ref') return { item: { text: ident(r.name), alias: r.id }, cols: colsOf(r.id, r) };
    if (r.kind === 'values') {
      const rows = list(r.rows.map((row) => q`(${list(row.map((e) => expr(e, outer)))})`));
      // SQLite names anonymous VALUES columns column1, column2, … . Bind the declared names to those
      // positions here rather than re-projecting, so the row source stays one FROM item.
      return {
        item: { text: q`(VALUES ${rows})`, alias: r.id },
        cols: new Map(r.type.cols.map((column, i) => [column.name, qualified(r.id, `column${i + 1}`)])),
      };
    }
    return undefined;
  };

  /** Any relation as a FROM item — a direct source when it is one, a derived SELECT otherwise. */
  const fromItem = (r: Rel, outer: Scope): { item: FromItem; cols: Cols } =>
    directSource(r, outer) ?? { item: { text: q`(${renderRel(r, outer)})`, alias: r.id }, cols: colsOf(r.id, r) };

  const leaf = (r: Rel, item: FromItem, cols: Cols, outer: Scope): Block => ({
    kind: 'block',
    select: r.type.cols.map((column) => [column.name, cols.get(column.name)!] as const),
    from: item, joins: [], distinct: false, windowed: false,
    scope: withRel(outer, r.id, cols),
  });

  /** The input of a unary node, as a block this node can fill a slot in. `blocked` is that node's
   * own rule about which already-occupied slots force a nested SELECT. */
  const inputBlock = (input: Rel, outer: Scope, blocked: (b: Block) => boolean): Block => {
    const built = build(input, outer);
    if (built.kind === 'block' && !blocked(built)) return built;
    const cols = colsOf(input.id, input);
    return {
      kind: 'block',
      select: input.type.cols.map((column) => [column.name, cols.get(column.name)!] as const),
      from: { text: q`(${renderBuilt(built)})`, alias: input.id },
      joins: [], distinct: false, windowed: false,
      scope: withRel(outer, input.id, cols),
    };
  };

  /** A node's own columns, as the block now spells them. */
  const outMap = (b: Block): Cols => new Map(b.select);

  /**
   * One side of a join, as FROM items this join can carry directly.
   *
   * `taken` is the load-bearing argument. Splicing a side lifts ITS aliases into this join's FROM,
   * and two sides that read the same shared relation lift the same alias twice — measured:
   * `FROM r0 shared INNER JOIN r0 shared` → `ambiguous column name`. A collision is not an error
   * (the sides are genuinely different relations, §9's `c4bce7f` rule is about ONE relation used
   * twice); it just means this side keeps its own SELECT, where its aliases are private again.
   */
  const side = (r: Rel, outer: Scope, mayFuse: boolean, taken: ReadonlySet<string>): Side => {
    const built = build(r, outer);
    const free = (aliases: readonly string[]): boolean => !aliases.some((alias) => taken.has(alias));
    if (built.kind === 'block' && mayFuse && spliceable(built) && free([built.from.alias, ...built.joins.map((join) => join.item.alias)]))
      return { from: built.from, joins: built.joins, where: built.where, cols: built.select.map(([, e]) => e), scope: built.scope };
    const direct = directSource(r, outer);
    const { item, cols } = direct && free([direct.item.alias])
      ? direct
      : { item: { text: q`(${renderBuilt(built)})`, alias: r.id }, cols: colsOf(r.id, r) };
    return { from: item, joins: [], cols: r.type.cols.map((column) => cols.get(column.name)!), scope: withRel(outer, r.id, cols) };
  };
  const sideAliases = (s: Side): readonly string[] => [s.from.alias, ...s.joins.map((join) => join.item.alias)];

  // ---------- the per-kind arms ----------

  /**
   * A `Ref` is a table source either way, and that is the whole point of §3.0 collapsing the two
   * mechanisms: a `Rel` binding is a CTE name, and a `Stmt` binding is its retained rows arriving
   * as one JSON bind. Positional `$[i]` because a statement's result is a RELATION — the binding's
   * declared type is the authority for every column, so there is nothing to infer here.
   */
  const refSource = (r: Extract<Rel, { readonly kind: 'ref' }>): { item: FromItem; cols: Cols } => {
    const bound = bindings.get(r.name);
    if (!bound) throw new Error(`RelIR emitter: Ref '${r.name}' has no Plan binding`);
    if (!isStmt(bound.node)) return { item: { text: ident(r.name), alias: r.id }, cols: colsOf(r.id, r) };
    const rows: RowsBind = { rowsOf: r.name };
    return {
      item: { text: q`json_each(${value(rows)})`, alias: r.id },
      cols: new Map(r.type.cols.map((column, i) => [column.name, q`json_extract(${qualified(r.id, 'value')}, ${value(`$[${i}]`)})`])),
    };
  };

  function build(r: Rel, outer: Scope): Built {
    switch (r.kind) {
      case 'scan': case 'self-ref': case 'values': case 'ref': {
        const source = directSource(r, outer)!;
        return leaf(r, source.item, source.cols, outer);
      }

      case 'project': {
        // A projection may always overwrite the select list, EXCEPT over a DISTINCT: dedup already
        // happened on the old list, and re-spelling it would dedup on different columns.
        const b = inputBlock(r.input, outer, (input) => input.distinct);
        const select = r.exprs.map(([name, e]) => [name, expr(e, b.scope)] as const);
        return { ...b, select, scope: withRel(b.scope, r.id, new Map(select)) };
      }

      case 'filter': {
        // Over an aggregate this IS `HAVING` — one of §3's declared collapses, not a second node.
        const b = inputBlock(r.input, outer, (input) => input.windowed || tailUsed(input) || input.having !== undefined);
        const pred = expr(r.pred, b.scope);
        const placed = grouped(b) ? { having: conjoin(b.having, pred) } : { where: conjoin(b.where, pred) };
        return { ...b, ...placed, scope: withRel(b.scope, r.id, outMap(b)) };
      }

      case 'aggregate': {
        const b = inputBlock(r.input, outer, (input) => input.windowed || grouped(input) || tailUsed(input));
        const groupBy = r.groupBy.map((e) => expr(e, b.scope));
        const keys = r.type.cols.slice(0, groupBy.length).map((column) => column.name);
        const select = [
          ...keys.map((name, i) => [name, groupBy[i]!] as const),
          ...r.aggs.map(([name, e]) => [name, expr(e, b.scope)] as const),
        ];
        return { ...b, select, groupBy, having: r.having ? expr(r.having, b.scope) : undefined, scope: withRel(b.scope, r.id, new Map(select)) };
      }

      case 'sort': {
        const b = inputBlock(r.input, outer, (input) => input.orderBy !== undefined || input.limit !== undefined || input.offset !== undefined || input.distinct);
        return { ...b, orderBy: r.terms.map((term) => sortTerm(term, b.scope)), scope: withRel(b.scope, r.id, outMap(b)) };
      }

      case 'limit': {
        const b = inputBlock(r.input, outer, (input) => input.limit !== undefined || input.offset !== undefined);
        return {
          ...b,
          limit: r.count ? expr(r.count, b.scope) : undefined,
          offset: r.offset ? expr(r.offset, b.scope) : undefined,
          scope: withRel(b.scope, r.id, outMap(b)),
        };
      }

      case 'distinct': {
        const b = inputBlock(r.input, outer, (input) => tailUsed(input));
        return { ...b, distinct: true, scope: withRel(b.scope, r.id, outMap(b)) };
      }

      case 'window': {
        const b = inputBlock(r.input, outer, (input) => tailUsed(input));
        const select = [...b.select, ...r.specs.map(([name, spec]) => [name, expr(spec, b.scope)] as const)];
        return { ...b, select, windowed: true, scope: withRel(b.scope, r.id, new Map(select)) };
      }

      case 'explode': {
        const b = inputBlock(r.input, outer, (input) => input.windowed || grouped(input) || tailUsed(input));
        const item: FromItem = { text: q`json_each(${expr(r.expr, b.scope)})`, alias: r.id };
        // Exactly the columns `explodeColumns` declares, in that order — a member's key, its value,
        // and its ordinal (for a JSON array `json_each.key` IS the index).
        const member = (name: string): readonly [string, Expression] => [name, qualified(r.id, name === r.as.value ? 'value' : 'key')];
        const select = [...b.select, ...explodeColumns(r.as).map(member)];
        return { ...b, joins: [...b.joins, { kind: 'cross', item }], select, scope: withRel(b.scope, r.id, new Map(select)) };
      }

      case 'materialize': {
        const b = inputBlock(r.input, outer, () => false);
        return { ...b, scope: withRel(b.scope, r.id, outMap(b)) };
      }

      case 'join': {
        const left = side(r.left, outer, true, new Set());
        const taken = new Set(sideAliases(left));
        if (r.join === 'semi' || r.join === 'anti') {
          // Adds no columns: an existence test over the right side, correlated against the left.
          const right = side(r.right, left.scope, false, taken);
          const exists = q`${r.join === 'anti' ? raw('NOT ') : empty}EXISTS (SELECT 1 FROM ${fromText(right.from)}${r.on ? q` WHERE ${expr(r.on, right.scope)}` : empty})`;
          const select = r.type.cols.map((column, i) => [column.name, left.cols[i]!] as const);
          return { kind: 'block', select, from: left.from, joins: left.joins, where: conjoin(left.where, exists), distinct: false, windowed: false, scope: withRel(left.scope, r.id, new Map(select)) };
        }
        // Only an inner/cross join may splice its right side: a LEFT join's right-side predicate
        // must stay inside the subquery, or an unmatched row is filtered instead of null-padded.
        const right = side(r.right, outer, r.join === 'inner' || r.join === 'cross', taken);
        const scope = mergeScopes(left.scope, right.scope);
        const on = r.on ? expr(r.on, scope) : undefined;
        const select = r.type.cols.map((column, i) => [column.name, [...left.cols, ...right.cols][i]!] as const);
        return {
          kind: 'block', select,
          from: left.from,
          joins: [...left.joins, { kind: r.join, item: right.from, on }, ...right.joins],
          where: conjoin(left.where, right.where),
          distinct: false, windowed: false,
          scope: withRel(scope, r.id, new Map(select)),
        };
      }

      // SQLite's compound arms are select-CORES: a parenthesised arm is a syntax error, measured
      // (`(SELECT 1) UNION ALL (SELECT 2)` → `near "(": syntax error`), and an arm may not carry
      // its own ORDER BY/LIMIT either — those belong to the compound as a whole. So an arm that
      // fills a tail slot, or is itself a set operation, gets a derived table of its own.
      case 'union': return {
        kind: 'closed',
        body: list(
          r.inputs.map((input) => renderBlock(inputBlock(input, outer, (arm) => arm.orderBy !== undefined || arm.limit !== undefined || arm.offset !== undefined))),
          r.all ? ' UNION ALL ' : ' UNION ',
        ),
      };

      case 'recursive': return { kind: 'closed', body: q`WITH RECURSIVE ${recursiveDefinition(r, outer)} SELECT * FROM ${ident(r.name)}` };
    }
  }

  const recursiveDefinition = (r: Extract<Rel, { readonly kind: 'recursive' }>, outer: Scope): Expression =>
    q`${ident(r.name)}(${list(r.cols.map(ident))}) AS (${renderRel(r.seed, outer)} UNION ALL ${renderRel(r.step(recursiveSelf(r)), outer)})`;

  /** A statement is a scope whose target spells its columns bare: SQLite's UPDATE/DELETE do not
   * alias theirs. Statements share this renderer entirely — no second expression path, and none of
   * the `externalAliases`/`bareColumns` back channels a separate entry point needed. */
  const statement = (s: Stmt): Expression => {
    const target = s.target;
    const scope: Scope = withRel(EMPTY_SCOPE, target.id, new Map(target.type.cols.map((column) => [column.name, ident(column.name)])));
    const returning = (pairs: readonly (readonly [string, Expr])[]): Expression => pairs.length
      ? q` RETURNING ${list(pairs.map(([name, expression]) => q`${expr(expression, scope)} AS ${ident(name)}`))}` : empty;
    switch (s.kind) {
      case 'insert':
        return q`INSERT INTO ${ident(target.table)} (${list(s.cols.map(ident))}) ${renderRel(s.source, EMPTY_SCOPE)}${
          s.onConflict
            ? q` ON CONFLICT (${list(s.onConflict.target.map(ident))}) DO UPDATE SET ${list(s.onConflict.set.map(([name, expression]) => q`${ident(name)} = ${expr(expression, scope)}`))}`
            : empty
        }${returning(s.returning)}`;
      case 'update': {
        const source = s.from && fromItem(s.from, EMPTY_SCOPE);
        const inner = source ? withRel(scope, s.from!.id, source.cols) : scope;
        return q`UPDATE ${ident(target.table)} SET ${list(s.set.map(([name, expression]) => q`${ident(name)} = ${expr(expression, inner)}`))}${
          source ? q` FROM ${fromText(source.item)}` : empty
        }${s.where ? q` WHERE ${expr(s.where, inner)}` : empty}${returning(s.returning)}`;
      }
      case 'delete': {
        // SQLite has no DELETE ... USING, and RelIR needs no equivalent: membership in another
        // relation is `InQuery` in `where`, which the shared expression renderer already emits as
        // `<col> IN (SELECT …)`. There is nothing delete-shaped here at all.
        if (!s.where) throw new Error('RelIR Delete emission requires a where predicate');
        return q`DELETE FROM ${ident(target.table)} WHERE ${expr(s.where, scope)}${returning(s.returning)}`;
      }
    }
  };

  /** A `Rel` binding is a CTE definition; the WITH list grows as bindings are declared, so a step
   * sees exactly the relations declared before it — the ordering `checkPlan` already proved. */
  const withCtes = (ctes: readonly Expression[], body: Expression, recursive = false): Expression =>
    ctes.length ? q`WITH ${recursive ? raw('RECURSIVE ') : empty}${list(ctes)} ${body}` : body;

  const program = (input: Plan): readonly Step[] => {
    const steps: Step[] = [];
    const ctes: Expression[] = [];
    const resultRef = input.result.kind === 'ref' ? input.result.name : undefined;
    // A plan whose RESULT is exactly a statement's rows has nothing left to run: the executor
    // already holds them. Emitting a json_each read of rows it just retained would be a round trip
    // to fetch what it already has.
    const lastStatement = resultRef && isStmt(bindings.get(resultRef)?.node as never) ? resultRef : undefined;
    for (const binding of input.bindings) {
      if (isStmt(binding.node)) {
        steps.push({ binding: binding.name, result: binding.name === lastStatement, emitted: emitted(withCtes(ctes, statement(binding.node))) });
        continue;
      }
      ctes.push(q`${ident(binding.name)} AS (${renderBuilt(build(binding.node, EMPTY_SCOPE))})`);
    }
    if (lastStatement) return steps;
    // A recursive root must share ONE `WITH RECURSIVE` list with the bindings beside it.
    const body = input.result.kind === 'recursive' && ctes.length
      ? q`WITH RECURSIVE ${list([...ctes, recursiveDefinition(input.result, EMPTY_SCOPE)])} SELECT * FROM ${ident(input.result.name)}`
      : withCtes(ctes, renderRel(input.result, EMPTY_SCOPE));
    steps.push({ result: true, emitted: emitted(body) });
    return steps;
  };

  return program;
}

/** The rendered bind list is the authority the DO cap is measured against: `check`'s static count
 * is over IR occurrences, and a fused block can spell one `Lit` more than once. */
const emitted = (tree: Expression): Emitted => {
  const out = render(tree);
  if (out.binds.length > DO_BIND_CAP) throw new Error(`RelIR: ${out.binds.length} rendered binds exceeds Durable Objects cap of ${DO_BIND_CAP}`);
  return { sql: out.sql, binds: out.binds };
};

/**
 * Render a checked PROGRAM (§3.0) to its executable steps, in order. ONE entry point: a write is
 * not a second machine, it is a binding whose node is a statement, and the three-entry-point
 * emitter this replaces (`emit`/`emitStmt`/`emitSequence`, with statement-only back channels) was
 * the drift toward rebuilding write as a special case inside a new layer.
 */
export function emit(program: Plan): readonly Step[] {
  checkPlan(program);
  return assembler(new Map(program.bindings.map((binding) => [binding.name, binding])))(program);
}

/** The single-step case, which every read plan is. A derived convenience over `emit`, deliberately
 * not a second implementation. */
export function emitQuery(program: Plan): Emitted {
  const steps = emit(program);
  const [only] = steps;
  if (steps.length !== 1 || !only) throw new Error(`RelIR: this plan has ${steps.length} executable steps; use emit()`);
  return only.emitted;
}
