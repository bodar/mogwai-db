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

/** A base table OR a generated CTE. `${rel}` renders the FROM form (`nodes`, or
 *  `nodes n` when aliased); `rel.c.x` renders `qualifier.x`. `.as()` rebinds the
 *  column qualifier — the one trick that makes columns follow the alias. */
export class Relation {
  /** The FROM-clause form: `name` unaliased, `name alias` aliased. */
  readonly from: Text;
  /** Columns, qualified by alias (if any) else the table name. */
  readonly c: Record<string, Text>;
  constructor(readonly name: string, readonly cols: readonly string[], readonly alias?: string) {
    const qualifier = alias ?? name;
    this.from = raw(alias ? `${quote(name)} ${quote(alias)}` : quote(name));
    this.c = Object.fromEntries(cols.map((col) => [col, colRef(qualifier, col)]));
  }
  as(alias: string): Relation { return new Relation(this.name, this.cols, alias); }
}

/** Declare a base table once: `relation('nodes', ['id','props',…])`. */
export const relation = (name: string, cols: readonly string[]): Relation => new Relation(name, cols);

/** A hole in a `q\`\`` template: a Relation renders its FROM form; any other node
 *  embeds as-is (its binds fall out); a number/string splices raw. Bind a value
 *  by wrapping it in `value(x)`. */
type Hole = Expression | Relation | string | number;
const node = (h: Hole): Expression => {
  if (h instanceof Relation) return h.from;
  if (typeof h === 'string' || typeof h === 'number') return raw(String(h));
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

  /** Assemble `WITH [RECURSIVE] … <tail>` as one tree and render to {sql, binds}. */
  render(tail: Expression): { sql: string; binds: any[] } {
    const heads = this.ctes.map((c) =>
      q`${raw(c.name)}${c.cols ? raw(`(${c.cols.join(', ')})`) : empty} as (${c.body})`);
    const recursive = this.ctes.some((c) => c.recursive) ? raw('recursive ') : empty;
    const tree = q`with ${recursive}${list(heads)} ${tail}`;
    const { text, args } = statement(tree);
    return { sql: text, binds: args };
  }
}
