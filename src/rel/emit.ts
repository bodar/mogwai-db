import { empty, identifier, list, q, raw, render, textLiteral, value, type Expression } from '../sql/kernel/q.ts';
import { BindBudgetExceeded, DO_BIND_CAP, checkPlan } from './check.ts';
import type { Expr } from './expr.ts';
import { recursiveSelf } from './factory.ts';
import { explodeColumns } from './obligations.ts';
import { retained, type Binding, type Plan } from './plan.ts';
import type { Rel } from './rel.ts';
import { isStmt, type Stmt } from './stmt.ts';
import { EXCLUDED, type FrameBound, type SortTerm, type WindowSpec } from './types.ts';

export interface Emitted { readonly sql: string; readonly binds: readonly any[]; }

/**
 * A bind the EXECUTOR fills in: the retained rows of an earlier binding — a statement's `RETURNING`
 * or a `snapshot` relation's SELECT — landed as ONE JSON bind exploded by `json_each`, never a
 * row-count-sized placeholder list, which is the DO 100-parameter wall (§3.6). It travels in
 * `Emitted.binds` in its own position, so `emit` never learns about chunking and the executor never
 * parses SQL to find the slot.
 */
export interface RowsBind { readonly rowsOf: string; }
export const isRowsBind = (bind: unknown): bind is RowsBind =>
  typeof bind === 'object' && bind !== null && typeof (bind as RowsBind).rowsOf === 'string';

/** One executable statement of a `Plan`, in execution order. A plain `Rel` binding is a CTE and
 * produces no step of its own; a `Stmt` binding and a `snapshot` `Rel` binding are each a step whose
 * rows the executor retains. */
export interface Step { readonly binding?: string; readonly result: boolean; readonly emitted: Emitted; }

/**
 * The emitter is a SELECT BLOCK ASSEMBLER (§5 of the RelIR build plan).
 *
 * RelIR is normalized — one operator per node — while SQL's `SELECT` is a COMPOSITION of operators
 * with fixed slots. Converting between those two shapes is this module's whole job: walk down from a
 * node filling slots, and open a nested `SELECT` only when the slot you need is already occupied.
 * That is why `Project(Filter(Join))` is ONE statement rather than three derived tables, and it is
 * what will delete `TailAcc` — the accumulator that exists only because the legacy lowering has
 * nowhere to fuse.
 *
 * Prior art, same algorithm and same reason —
 * `vendor/calcite/core/src/main/java/org/apache/calcite/rel/rel2sql/SqlImplementor.java:2167`
 * (`needNewSubQuery`, the slot-occupied test itself, over a `Set<Clause>` where we carry a block)
 * and `…/rel/rel2sql/RelToSqlConverter.java:135` (the per-node visitors that fill the slots).
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
      case 'lit':
        switch (e.source) {
          case 'bound': return value(e.value);
          case 'compiler-text': return textLiteral(e.value);
          case 'compiler-int': return raw(String(e.value));
          // A REAL literal must carry a decimal point or exponent, else SQLite reads an integer-valued
          // double (`2.0`) back as INTEGER `2` and loses the storage class the type declared.
          case 'compiler-real': { const s = String(e.value); return raw(/[.eE]/.test(s) ? s : `${s}.0`); }
          case 'compiler-null': return raw('NULL');
        }
      case 'unary': return e.op === 'not' ? q`NOT (${self(e.arg)})` : q`-(${self(e.arg)})`;
      case 'binary': return q`(${self(e.left)} ${raw(e.op.toUpperCase())} ${self(e.right)})`;
      case 'case': return q`CASE ${list(e.whens.map(([when, then]) => q`WHEN ${self(when)} THEN ${self(then)}`), ' ')}${e.else ? q` ELSE ${self(e.else)}` : empty} END`;
      case 'cast': return q`CAST(${self(e.arg)} AS ${raw(e.to.toUpperCase())})`;
      case 'call': return q`${raw(e.fn)}(${e.distinct ? raw('DISTINCT ') : empty}${list(e.args.map(self))})`;
      // An `Agg` with no arguments means "over all rows", and SQL spells that `count(*)` — not
      // `count()`, which is SQLite LENIENCY rather than syntax. Emitting the lenient form would be
      // the exact species `src/cf-limits.ts` exists to catch: valid on the dev runtime, unproven on
      // the one we ship to. The star is a SPELLING, so it belongs here and not as a node field.
      // `FILTER (WHERE …)` follows the closing paren, not the argument list — it qualifies WHICH ROWS the
      // aggregate takes, while the group stays whatever `GROUP BY` decided (see `Agg.filter`).
      case 'agg': return q`${raw(e.fn)}(${e.distinct ? raw('DISTINCT ') : empty}${e.args.length ? list(e.args.map(self)) : raw('*')}${e.orderBy?.length ? q` ORDER BY ${list(e.orderBy.map((term) => sortTerm(term, scope)))}` : empty})${e.filter ? q` FILTER (WHERE ${self(e.filter)})` : empty}`;
      case 'window-expr': return q`${raw(e.fn)}(${list(e.args.map(self))}) OVER (${windowSpec(e.spec, scope)})`;
      // A json object's KEYS are compile-time strings in the node, not `Expr`s — so they render as
      // LITERALS, never as binds. `value(key)` here spent one of the platform's 100 parameters per
      // key: a `{t,v}` member node cost two and one `as()` cost two, which is a plan the seam declines
      // for a constant the compiler itself wrote. Legacy always inlined them; this is the two spines
      // agreeing on the cheap spelling rather than RelIR paying for the same SQL.
      case 'json-object': return q`${raw(e.binary ? 'jsonb_object' : 'json_object')}(${list(e.entries.flatMap(([key, val]) => [textLiteral(key), self(val)]))})`;
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
   * mechanisms: a re-derivable `Rel` binding is a CTE name, and a RETAINED one — a `Stmt`, or a
   * relation the plan marked `snapshot` — is its rows arriving as one JSON bind. Positional `$[i]`
   * because a retained result is a RELATION: the binding's declared type is the authority for every
   * column, so there is nothing to infer here.
   */
  const refSource = (r: Extract<Rel, { readonly kind: 'ref' }>): { item: FromItem; cols: Cols } => {
    const bound = bindings.get(r.name);
    if (!bound) throw new Error(`RelIR emitter: Ref '${r.name}' has no Plan binding`);
    if (!retained(bound)) return { item: { text: ident(r.name), alias: r.id }, cols: colsOf(r.id, r) };
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
        // A projection may overwrite the select list except over DISTINCT, or over a whole-relation
        // aggregate: replacing the latter with constants would erase the aggregate's one-row shape.
        // This deliberately takes Calcite's safe superset instead of recursively proving which input
        // fields an arbitrary Expr reads; see SqlImplementor.java:2223-2241 (`fieldsUsed.isEmpty()`).
        const b = inputBlock(r.input, outer, (input) => input.distinct || (grouped(input) && input.groupBy?.length === 0));
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
        // A WINDOWED input closes the block for the same reason a `Filter` does (§11's fence): an
        // `ORDER BY` cannot name a select alias, so fusing re-inlines the expression that computes
        // its subject — and where the subject is a minted position that expression is a whole
        // `ROW_NUMBER()` over a correlated compare key. Measured on
        // `g.V().order().by("age").range(1,3).values("name")`: the key spelled THREE times and 30
        // binds against legacy's 5, so a second `order()` in one chain would approach the DO cap and
        // fail closed where legacy answers. Naming the column costs one nested SELECT.
        const b = inputBlock(r.input, outer, (input) => input.orderBy !== undefined || input.limit !== undefined || input.offset !== undefined || input.distinct || input.windowed);
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
        // A WINDOWED input closes the block, and this is a LEGALITY rule rather than a preference: a
        // window's own `OVER (…)` clause may never reference a window function, so a spec that reads a
        // column its input computed with one has no legal spelling in the same SELECT. SQLite says so
        // outright — `misuse of window function row_number()` — and it says it for the shape RelIR
        // produces whenever a step MINTS an emission order and a later window ranks by it
        // (`dedup().by(k)` after `order()`, the cumulative-bulk slice). Refusing here is total; the
        // alternative was a `Materialize` fence at each such site, i.e. remembering the rule N times.
        const b = inputBlock(r.input, outer, (input) => tailUsed(input) || input.windowed);
        const select = [...b.select, ...r.specs.map(([name, spec]) => [name, expr(spec, b.scope)] as const)];
        return { ...b, select, windowed: true, scope: withRel(b.scope, r.id, new Map(select)) };
      }

      case 'explode': {
        // Exactly the columns `explodeColumns` declares — a member's key, its value, and its ordinal
        // (for a JSON array `json_each.key` IS the index).
        const memberCol = (name: string): readonly [string, Expression] =>
          [name, qualified(r.id, name === r.as.value ? 'value' : name === r.as.type ? 'type' : 'key')];
        // SOURCE-LESS: `json_each(<outer expression>)` is the whole FROM, and the expression resolves
        // in the OUTER scope because there is no input block to resolve it against. That is what makes
        // a per-member computation a CORRELATED subquery — the shape every list member op takes.
        if (!r.input) {
          const item: FromItem = { text: q`json_each(${expr(r.expr, outer)})`, alias: r.id };
          const select = explodeColumns(r.as).map(memberCol);
          return { kind: 'block', select, from: item, joins: [], distinct: false, windowed: false, scope: withRel(outer, r.id, new Map(select)) };
        }
        const b = inputBlock(r.input, outer, (input) => input.windowed || grouped(input) || tailUsed(input));
        const item: FromItem = { text: q`json_each(${expr(r.expr, b.scope)})`, alias: r.id };
        const select = [...b.select, ...explodeColumns(r.as).map(memberCol)];
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

  /**
   * `INSERT … SELECT … ON CONFLICT` NEEDS A `WHERE` IN THE SELECT, and SQLite says so: with a
   * values-from-SELECT upsert its parser cannot tell the conflict clause's `ON` from a join's, and
   * the documented disambiguator is a WHERE. `true` is the one that changes no rows, and it is
   * spelled INLINE rather than bound — a parameter spent on a compiler constant is a parameter the
   * platform's cap does not get back (`OnlyDataSpendsAParameter`).
   *
   * In the emitter because it is a fact about SQL's SURFACE, not about the algebra: an `Insert` with
   * a conflict clause means the same thing whatever its source's shape, and making every caller
   * remember to bolt a vacuous filter on would be the block assembler's job leaking upward.
   */
  const upsertSource = (r: Rel): Expression => {
    const built = build(r, EMPTY_SCOPE);
    if (built.kind === 'closed') return q`SELECT * FROM (${built.body}) ${ident(r.id)} WHERE ${raw('true')}`;
    return renderBuilt(built.where ? built : { ...built, where: raw('true') });
  };

  /**
   * A statement is a scope whose target spells its columns TABLE-QUALIFIED. SQLite's UPDATE/DELETE
   * do not alias their target, so the table name is the only qualifier available — and a qualifier
   * is not optional: a correlated subquery in the `WHERE` that scans a table with a same-named
   * column captures the bare name, so `node = node` reads as the INNER relation's column and is
   * trivially true. That produced a `property()` cascade deleting every element's rows because ONE
   * of them had a `single` declaration — caught by an L4 pin, invisible to the checker (both names
   * resolve) and invisible to SQLite (both are legal).
   *
   * Statements share this renderer entirely — no second expression path, and none of the
   * `externalAliases`/`bareColumns` back channels a separate entry point needed.
   */
  const statement = (s: Stmt): Expression => {
    const target = s.target;
    const scope: Scope = withRel(EMPTY_SCOPE, target.id, new Map(target.type.cols.map((column) => [column.name, qualified(target.table, column.name)])));
    // `excluded` is in scope for the conflict clause ALONE, which is SQLite's own rule — and it is
    // what makes an upsert able to assign the incoming row rather than only a constant.
    const merging: Scope = withRel(scope, EXCLUDED, new Map(target.type.cols.map((column) => [column.name, qualified('excluded', column.name)])));
    const returning = (pairs: readonly (readonly [string, Expr])[]): Expression => pairs.length
      ? q` RETURNING ${list(pairs.map(([name, expression]) => q`${expr(expression, scope)} AS ${ident(name)}`))}` : empty;
    switch (s.kind) {
      case 'insert':
        return q`INSERT INTO ${ident(target.table)} (${list(s.cols.map(ident))}) ${s.onConflict ? upsertSource(s.source) : renderRel(s.source, EMPTY_SCOPE)}${
          s.onConflict
            ? q` ON CONFLICT (${list(s.onConflict.target.map(ident))}) DO UPDATE SET ${list(s.onConflict.set.map(([name, expression]) => q`${ident(name)} = ${expr(expression, merging)}`))}`
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

  /**
   * THE PROGRAM, IN ITS TWO HALVES — the steps that RUN, and the relation that is left.
   *
   * One walk, because there is one program: a retained binding (a `Stmt`, or a relation the plan
   * snapshotted) is a step, a plain `Rel` binding is a CTE the steps after it see, and whatever the
   * result relation is renders over the CTE list that reached it. `emit` finishes the job by
   * rendering `result`; `emitRelational` hands that expression to the framing layer instead of
   * rendering it. Splitting them into two near-copies of this walk is what let the CTE-versus-step
   * rule be stated twice — and the recursive-root case, which only one of them had.
   *
   * `result` is ABSENT when the plan's result is exactly a retained binding's rows: the executor
   * already holds them, and emitting a `json_each` read of rows it just retained would be a round
   * trip to fetch what it already has. That is a `drop()`'s shape — its result is its last statement.
   */
  const parts = (input: Plan): { readonly effects: readonly Step[]; readonly result?: Expression } => {
    const effects: Step[] = [];
    const ctes: Expression[] = [];
    const resultBinding = input.result.kind === 'ref' ? bindings.get(input.result.name) : undefined;
    const lastRetained = resultBinding && retained(resultBinding) ? resultBinding.name : undefined;
    for (const binding of input.bindings) {
      // A SNAPSHOT is the same STEP as a statement — run it, keep its rows — and only the body
      // differs. That is what makes "the value at this point" one concept: the executor cannot tell
      // the two apart, and neither can a later `Ref`.
      const retain = (body: Expression): void => {
        effects.push({ binding: binding.name, result: binding.name === lastRetained, emitted: renderStep(withCtes(ctes, body)) });
      };
      // `isStmt` first because it NARROWS the union `retained` only answers a question about, so the
      // CTE arm below has a `Rel`.
      if (isStmt(binding.node)) { retain(statement(binding.node)); continue; }
      if (binding.snapshot) { retain(renderRel(binding.node, EMPTY_SCOPE)); continue; }
      ctes.push(q`${ident(binding.name)} AS (${renderBuilt(build(binding.node, EMPTY_SCOPE))})`);
    }
    if (lastRetained) return { effects };
    // A recursive root must share ONE `WITH RECURSIVE` list with the bindings beside it.
    const result = input.result.kind === 'recursive' && ctes.length
      ? q`WITH RECURSIVE ${list([...ctes, recursiveDefinition(input.result, EMPTY_SCOPE)])} SELECT * FROM ${ident(input.result.name)}`
      : withCtes(ctes, renderRel(input.result, EMPTY_SCOPE));
    return { effects, result };
  };

  return { parts };
}

/** The rendered bind list is the authority the DO cap is measured against: `check`'s static count
 * is over IR occurrences, and a fused block can spell one `Lit` more than once. */
const renderStep = (tree: Expression): Emitted => {
  const out = render(tree);
  if (out.binds.length > DO_BIND_CAP) throw new BindBudgetExceeded(out.binds.length);
  return { sql: out.sql, binds: out.binds };
};

/**
 * Render a checked PROGRAM (§3.0) to its executable steps, in order. ONE entry point: a write is
 * not a second machine, it is a binding whose node is a statement, and the three-entry-point
 * emitter this replaces (`emit`/`emitStmt`/`emitSequence`, with statement-only back channels) was
 * the drift toward rebuilding write as a special case inside a new layer.
 */
export function emit(program: Plan): readonly Step[] {
  const { effects, result } = emitProgram(program);
  return result ? [...effects, { result: true, emitted: renderStep(result) }] : effects;
}

/**
 * A CHECKED PROGRAM SPLIT INTO WHAT RUNS AND WHAT IS LEFT — the entry point for a caller that must
 * put something of its own BETWEEN the two.
 *
 * The framing layer is that caller once a write produces traversers: `property()` hands back the
 * elements it mutated, so the framing query has to run AFTER the effects and read their retained
 * rows. Handing back an `Expression` rather than a rendered string is what keeps bind ordering in
 * one `render` (the same reason `emitRelational` does), and handing the effects back separately is
 * what stops the framing layer needing a write vocabulary to run them.
 */
export function emitProgram(program: Plan): { readonly effects: readonly Step[]; readonly result?: Expression } {
  checkPlan(program);
  return assembler(new Map(program.bindings.map((binding) => [binding.name, binding]))).parts(program);
}

/**
 * A checked READ program as ONE kernel `Expression`, for a caller that composes it into a larger
 * `q` tree instead of executing it. RelIR's output contract is a relation, and shape is resolved
 * above it (§2).
 *
 * Read plans only, and the THROW is the point: a caller that composes this into a `SELECT` has no
 * way to run the effects, so a program with them would silently lose its writes. A caller that CAN
 * run them asks `emitProgram` instead and gets the same expression beside its steps.
 */
export function emitRelational(program: Plan): Expression {
  const { effects, result } = emitProgram(program);
  if (effects.length) throw new Error(`RelIR: this plan has ${effects.length} execution step(s); a caller that composes its result must run them — use emitProgram()`);
  if (!result) throw new Error('RelIR: this plan has no relational result');
  return result;
}

/** The single-step case, which every read plan is. A derived convenience over `emit`, deliberately
 * not a second implementation. */
export function emitQuery(program: Plan): Emitted {
  const steps = emit(program);
  const [only] = steps;
  if (steps.length !== 1 || !only) throw new Error(`RelIR: this plan has ${steps.length} executable steps; use emit()`);
  return only.emitted;
}
