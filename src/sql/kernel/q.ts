// ---------- q: a template-first SQL kernel for the compiler ----------
//
// The compiler builds ALL of its SQL through this kernel — no ansi builder layer,
// no hand-rolled {sql,binds}. This is the ONE module that touches lazyrecords
// directly (its bind-safe core: Text/Value/Sql/statement/jsonExtract); every
// other module builds SQL via the exports here. Template-first: `q\`…\``
// interpolations default to RAW identifiers/text and only bound VALUES are wrapped
// (`value(x)`) — the flip of the usual bind-by-default tag, right for an
// identifier-heavy compiler where table/column names dominate and real binds are few.
//
// The pieces that kill the compiler's noise:
//   • Relation — a base table OR a generated CTE, indistinguishable at the use
//     site: `${rel}` renders its FROM form, `rel.c.x` a qualified column.
//   • Query    — a per-query context that MINTS CTE names (you never see c0/c1)
//     and gives recursive CTEs a typed `self` handle (no stringly-typed name).
//   • q / list / values / paren / empty / raw — the template + compound helpers.
//   • render(node) — the node → {sql, binds} boundary for standalone (non-CTE) SQL.

import { text as raw, empty, type Text } from '@bodar/lazyrecords/sql/template/Text.ts';
import { value } from '@bodar/lazyrecords/sql/template/Value.ts';
import { sql, type Sql } from '@bodar/lazyrecords/sql/template/Sql.ts';
import { list as lrList } from '@bodar/lazyrecords/sql/template/Compound.ts';
import { statement } from '@bodar/lazyrecords/sql/statement/ordinalPlaceholder.ts';
import { type Expression } from '@bodar/lazyrecords/sql/template/Expression.ts';

// Re-export the node types so no other module imports them from lazyrecords.
export type { Expression, Sql };
export { value, empty };
/** A bind-free SQL fragment as a node (unquoted, verbatim). ONLY for text the
 *  compiler controls (column refs, operators) — never user data; wrap values in
 *  `value(x)`. Prefer bare-string interpolation in `q\`\``; use `raw` when an API
 *  needs a Text node directly (e.g. jsonExtract's column). */
export { raw };
export { jsonExtract } from '@bodar/lazyrecords/sql/sqlite/jsonExtract.ts';

/** Join `parts` with a raw separator string (identifier-safe SQL, not a bound
 *  value): `list(conds, ' AND ')`. The separator is spliced RAW — it's SQL text,
 *  never user data. Omit `sep` for the lazyrecords default (', '). Re-exported here
 *  so step modules build every compound through the kernel, not raw lazyrecords. */
export const list = (parts: readonly Expression[], sep?: string): Expression =>
  sep === undefined ? lrList(parts) : lrList(parts, raw(sep));

/** A bound comma-list `?, ?, …` from raw JS values (each wrapped as a Value token)
 *  — the plural of `value`, for IN-lists / VALUES rows: `id IN (${values(ids)})`. */
export const values = (xs: readonly any[]): Expression => list(xs.map(value), ', ');

/** Parenthesise an expression: `(<e>)`. */
export const paren = (e: Expression): Expression => q`(${e})`;

/** Render a standalone node (a fragment or a whole tree) to `{sql, binds}` — the
 *  boundary for the few spots that need SQL text without the `Query` CTE machinery
 *  (e.g. a merge run-closure's match query). Binds fall out of the tree. */
export function render(node: Expression): { sql: string; binds: any[] } {
  const { text, args } = statement(sql(node));
  return { sql: text, binds: args };
}

/** Identifier-shaped name → spliced raw; else double-quoted (render-time safe
 *  quoting, à la SQLAlchemy/jOOQ — quote only when unsafe). */
const SAFE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quote = (n: string) => SAFE.test(n) ? n : `"${n.replace(/"/g, '""')}"`;

/** A column reference `qualifier.name`, each part safe-quoted. A Text (no binds). */
const colRef = (qualifier: string, name: string): Text => raw(`${quote(qualifier)}.${quote(name)}`);

/** `rel.c` with an UNDECLARED column made a throw rather than `undefined`.
 *
 *  `relation()` catches this in the TYPE for a base table, but a `derived()`/`cte()` relation is
 *  `Relation<string>` — its column list is computed at runtime, so `rel.c[name]` type-checks for
 *  every string and a name the relation does not carry read as `undefined`. A `q` hole of
 *  `undefined` used to splice NOTHING, so the mistake surfaced as malformed SQL at the database
 *  (`SELECT r.v AS v,  FROM c8 r`) rather than at the site that made it. Measured: that is exactly
 *  how a child-scope rejoin projecting an ordinal a global barrier had already dropped escaped every
 *  compile-time instrument — the compiler's own assertions all passed and SQLite raised the error.
 *
 *  A Proxy, not a per-read check, because the whole point is that the ~1,600 existing `rel.c.x`
 *  sites gain the guard without being touched. Only STRING keys are guarded — symbol lookups
 *  (`Symbol.toPrimitive`, inspection hooks) must stay silent — and inherited `Object.prototype`
 *  names still resolve normally, so `in`/`Object.keys` behave as before. */
const guardColumns = <K extends string>(cols: Record<string, Text>, qualifier: string, declared: readonly K[]): Record<K, Text> =>
  new Proxy(cols, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !(prop in target))
        throw new Error(`relation ${qualifier} has no column '${prop}' (declares: ${declared.join(', ') || '<none>'})`);
      return Reflect.get(target, prop, receiver);
    },
  }) as Record<K, Text>;

/** A base table OR a generated CTE. `${rel}` renders the FROM form (`nodes`, or
 *  `nodes n` when aliased); `rel.c.x` renders `qualifier.x`. `.as()` rebinds the
 *  column qualifier — the one trick that makes columns follow the alias. */
export class Relation<K extends string = string> {
  /** The FROM-clause form: `name` unaliased, `name alias` aliased. */
  readonly from: Expression;
  /** Columns, qualified by alias (if any) else the table name. */
  readonly c: Record<K, Text>;
  constructor(readonly name: string, readonly cols: readonly K[], readonly alias?: string, readonly body?: Expression) {
    const qualifier = alias ?? name;
    this.from = body
      ? q`(${body}) ${raw(quote(qualifier))}`
      : raw(alias ? `${quote(name)} ${quote(alias)}` : quote(name));
    this.c = guardColumns(Object.fromEntries(cols.map((col) => [col, colRef(qualifier, col)])), qualifier, cols);
  }
  as(alias: string): Relation<K> { return new Relation<K>(this.name, this.cols, alias, this.body); }
}

/** Declare a base table once: `relation('nodes', ['id','props',…])`.
 *
 *  The column list is captured in the TYPE, so `nodes.c.lable` and — the case this was
 *  introduced for — a column that has been REMOVED from the schema are compile errors
 *  rather than an `undefined` spliced into a `q` template. `derived()` stays deliberately
 *  loose (`Relation<string>`): its column lists are computed at runtime, so there is
 *  nothing to check against. */
export const relation = <const K extends string>(name: string, cols: readonly K[]): Relation<K> =>
  new Relation(name, cols);

/** A typed derived table: a required subquery boundary without a separately named CTE. */
export const derived = (body: Expression, cols: readonly string[], alias: string): Relation =>
  new Relation(alias, cols, alias, body);

/** A hole in a `q\`\`` template: a Relation renders its FROM form; any other node
 *  embeds as-is (its binds fall out); a number/string splices raw. Bind a value
 *  by wrapping it in `value(x)`. */
type Hole = Expression | Relation | string | number;
const node = (h: Hole): Expression => {
  if (h instanceof Relation) return h.from;
  if (typeof h === 'string' || typeof h === 'number') return raw(String(h));
  // `Hole` excludes undefined, so a nullish one is always a caller bug — and one that renders as
  // an EMPTY string, i.e. malformed SQL discovered by the database instead of by the compiler.
  // `empty` is the deliberate way to splice nothing. (The column guard above catches the common
  // source; this is the backstop for every other hole.)
  if (h === undefined || h === null) throw new Error('a q`` template hole is undefined — use `empty` to splice nothing');
  return h;
};

/** The template. Interpolations default to raw identifiers/fragments; wrap a
 *  bound value in `value(x)`. Returns a Sql node (composable, renders once). */
export function q(strings: TemplateStringsArray, ...holes: Hole[]): Sql {
  const parts: Expression[] = [];
  strings.forEach((s, i) => {
    if (s) parts.push(raw(s));
    if (i < holes.length) parts.push(node(holes[i]));
  });
  return sql(...parts);
}

interface Cte { name: string; body: Expression; cols?: readonly string[]; recursive: boolean; }

/** A per-query context. Mints CTE names (c0, c1, …) so the compiler never writes
 *  a number, and hands back a Relation you reference downstream exactly like a
 *  base table. `recursiveCte` passes a typed `self` so a walk can reference its
 *  own columns without a stringly-typed name. */
export class Query {
  private ctes: Cte[] = [];
  private n = 0;
  private fresh() { return `c${this.n++}`; }

  /** The lowering engine for THIS compile — the recursive-traversal authority + ambient
   *  compile dependencies (fastPaths/registry/federationDepth). Attached once per compile by the
   *  compile-scope container (see steps/engine.ts); the step families reach lowering + deps
   *  through it (`stream.q.engine`) so those dependencies never ride LoweringState. Typed as the leaf
   *  `Engine` interface (steps/deps.ts, a type-only import — no runtime cycle: q.ts stays a
   *  leaf). Optional so a bare `new Query()` (tests, the SQL kernel in isolation) is still valid;
   *  a lowering call on an engine-less Query is a wiring bug and throws where it is read. */
  engine?: import('../../compiler/engine/deps.ts').Engine;

  /** Append a plain CTE; returns its Relation handle. `cols` names the projection
   *  (so `rel.c.x` is typed) — omit for a single implicit `id`. */
  cte(body: Expression, cols: readonly string[] = ['id']): Relation {
    const name = this.fresh();
    this.ctes.push({ name, body, cols, recursive: false });
    return new Relation(name, cols);
  }

  /** Append a recursive CTE. `build` receives the CTE's own Relation (`self`), so
   *  `self.c.depth` / `${self}` reference it type-safely; the column list is the
   *  header SQLite requires anyway, so no proxy and no lost types. */
  recursiveCte(cols: readonly string[], build: (self: Relation) => Expression): Relation {
    const name = this.fresh();
    const self = new Relation(name, cols);
    this.ctes.push({ name, body: build(self), cols, recursive: true });
    return self;
  }

  /** Assemble `WITH [RECURSIVE] … <tail>` as one tree and render to {sql, binds}.
   *  With no CTEs, render the bare tail — an empty `with ` prefix is malformed SQL
   *  (the only zero-CTE read is a constant source like `g.inject()`). */
  render(tail: Expression): { sql: string; binds: any[] } {
    if (this.ctes.length === 0) { const { text, args } = statement(q`${tail}`); return { sql: text, binds: args }; }
    const heads = this.ctes.map((c) =>
      q`${raw(c.name)}${c.cols ? raw(`(${c.cols.join(', ')})`) : empty} as (${c.body})`);
    const recursive = this.ctes.some((c) => c.recursive) ? raw('recursive ') : empty;
    const tree = q`with ${recursive}${list(heads)} ${tail}`;
    const { text, args } = statement(tree);
    return { sql: text, binds: args };
  }
}

/** A `Query` that NESTS instead of naming: `cte()` returns a `derived()` subquery
 *  (`x0,x1,…`, a namespace distinct from the outer's `c*`) rather than registering a
 *  shared CTE, so a fold that builds through the kernel renders as ONE nested-derived
 *  expression instead of a chain of `WITH` heads. The kernel's own preference for
 *  `derived` over a named CTE (see `src/sql/CLAUDE.md`) as a whole-query mode — which is
 *  what makes it a `Query` subclass here rather than a per-site choice at each `derived`
 *  call.
 *
 *  It is NOT inherently correlated: correlation comes from whatever the CALLER seeds the
 *  fold with (an expression referencing an outer row). "Nest, don't name" and "seed from
 *  an outer row" are separable; the correlated inline child (`steps/tail/correlated.ts`)
 *  is the two composed.
 *
 *  Nesting means there is no shared `WITH` to hang a recursive term on, and no standalone
 *  render — both fail closed rather than emitting something malformed. A caller that wants
 *  a domain-specific deferral message should check before it gets here. */
export class DerivedQuery extends Query {
  private k = 0;
  /** Mint the next alias in THIS query's nesting namespace. Public so a caller's SEED
   *  relation draws from the same counter as the fold's — one owner for the namespace. */
  alias(): string { return `x${this.k++}`; }
  override cte(body: Expression, cols: readonly string[] = ['id']): Relation {
    return derived(body, cols, this.alias());
  }
  // Signatures MATCH the base deliberately (rather than the arity-0 form TS would also
  // accept): these are reachable calls that must fail with a clear message, not shapes a
  // caller is prevented from writing.
  override recursiveCte(_cols: readonly string[], _build: (self: Relation) => Expression): never {
    throw new Error('a nested-derived Query has no shared WITH and cannot host a recursive CTE');
  }
  override render(_tail: Expression): never {
    throw new Error('a nested-derived Query is never rendered standalone');
  }
}
