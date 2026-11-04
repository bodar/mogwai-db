// ---------- q: a template-first SQL kernel for the compiler ----------
//
// The compiler builds ALL of its SQL through this kernel — no ansi builder layer,
// no hand-rolled {sql,binds}. This is the ONE module that touches lazyrecords
// directly (its bind-safe core: Text/Value/Sql/Compound/jsonExtract); every
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

import { text as raw, empty, Text } from '@bodar/lazyrecords/sql/template/Text.ts';
import { value, Value } from '@bodar/lazyrecords/sql/template/Value.ts';
import { Identifier } from '@bodar/lazyrecords/sql/template/Identifier.ts';
import { sql, type Sql } from '@bodar/lazyrecords/sql/template/Sql.ts';
import { Compound, list as lrList } from '@bodar/lazyrecords/sql/template/Compound.ts';
import { type Expression } from '@bodar/lazyrecords/sql/template/Expression.ts';
import { UnsupportedTraversal } from '../../compiler/unsupported.ts';
import type { CompileBudget } from './budget.ts';

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

/** A bound value carrying a REUSE KEY: two `KeyedValue`s sharing a key render as ONE placeholder + ONE
 *  bind, so a value used at many sites is bound once. The kernel does not interpret the key — the
 *  caller supplies it (the compiler passes a wire parameter's name, `GValue.name`, so N uses of one
 *  `$x` cost one of the DO's 100-bind budget — docs/archive/2026-08-05-parameters-are-the-only-binds.md). A
 *  plain `value()` has no key and never dedups: a mechanical/oversized bind is always its own slot. */
export class KeyedValue extends Value {
  constructor(value: unknown, readonly key: string) { super(value); }
}

/** A bound value tagged with a reuse key, so occurrences sharing the key collapse to one bind.
 *  `undefined` → null, matching lazyrecords' `value()`. */
export const keyedValue = (v: unknown, key: string): Expression => new KeyedValue(v === undefined ? null : v, key);

/**
 * THE TREE'S TOKENS IN RENDER ORDER, in ONE linear walk — exactly the visit lazyrecords' `Compound`
 * iterator makes (`start`, the members joined by `separator`, `end`; `empty` never emitted), done with
 * an explicit stack instead of nested `yield*`.
 *
 * ⚠️ **Not a style choice: the nested generators are QUADRATIC in nesting depth.** A token a `Compound`
 * at depth d yields is re-yielded through d generator frames, so a plan whose relations NEST (a bounded
 * repeat's phases, each a derived table over the last) paid O(tokens × depth) — three times over, since
 * the render walked the tree separately for the repeated-key check, the text and the binds. Measured:
 * `repeat(out().order().by('name')).times(40)` spent 1.44s of a 1.60s compile in those walks, and the
 * compile of `times(n)` grew ~5× per doubling of n. One stack walk is O(tokens).
 */
function tokens(tree: Sql, budget?: CompileBudget): (Text | Identifier | Value)[] {
  const out: (Text | Identifier | Value)[] = [];
  // THE RENDERED-BYTES CHARGE (`CompileBudget`): exact, and counted AS the text is laid out, so a statement
  // past the budget stops here rather than after its whole text is joined. A placeholder counts as its `?`.
  let bytes = 0;
  const push = (token: Text | Identifier | Value): void => {
    out.push(token);
    if (budget && (bytes += token instanceof Text ? token.text.length : 1) > budget.limit) budget.charge(bytes);
  };
  const stack: { node: Compound; members: Iterator<Expression>; first: boolean }[] = [];
  const enter = (node: Compound): void => {
    if (node.start !== empty) push(node.start);
    stack.push({ node, members: node.expressions[Symbol.iterator](), first: true });
  };
  enter(tree);
  while (stack.length) {
    const top = stack[stack.length - 1]!;
    const next = top.members.next();
    if (next.done) {
      stack.pop();
      if (top.node.end !== empty) push(top.node.end);
      continue;
    }
    if (top.first) top.first = false;
    else if (top.node.separator !== empty) push(top.node.separator);
    const e = next.value;
    if (e instanceof Text || e instanceof Identifier || e instanceof Value) push(e);
    else if (e instanceof Compound) enter(e);
  }
  budget?.charge(bytes);
  return out;
}

/** Does any reuse key appear more than once? Only then is it worth switching the statement to numbered
 *  placeholders; the common no-repeat case keeps the anonymous-`?` render byte-for-byte, so no existing
 *  SQL (or snapshot) moves. */
function hasRepeatedKey(toks: readonly (Text | Identifier | Value)[]): boolean {
  const seen = new Set<string>();
  for (const e of toks) {
    if (!(e instanceof KeyedValue)) continue;
    if (seen.has(e.key)) return true;
    seen.add(e.key);
  }
  return false;
}

/**
 * Render a finished `Sql` tree to `{sql, binds}`, DEDUPING values that share a reuse key.
 *
 * When some key appears more than once, the whole statement switches to NUMBERED placeholders
 * (`?1, ?2, …`): the first appearance of a distinct key — and each keyless value by position — takes
 * the next ordinal and contributes one bind; a repeat of that key re-emits its ordinal and contributes
 * NONE. SQLite binds exactly `sqlite3_bind_parameter_count` values, which is that deduped count, so N
 * uses of one keyed value (a `$x` parameter) cost ONE of the 100 (verified on bun:sqlite and on a
 * Durable Object, `test/cf-probe`). With no repeat the statement keeps lazyrecords' anonymous-`?`
 * spelling (`statement/ordinalPlaceholder`), so the overwhelmingly common case is byte-identical.
 */
function renderStatement(tree: Sql, budget?: CompileBudget): { sql: string; binds: any[] } {
  const toks = tokens(tree, budget);
  const numbered = hasRepeatedKey(toks);
  const ordinals = new Map<string, number>();
  const binds: any[] = [];
  let next = 0;
  const text = toks.map((e) => {
    if (e instanceof Text) return e.text;
    // Our kernel emits identifiers as `raw(quote(...))` Text, never lazyrecords `Identifier` nodes, so
    // this arm is a defensive fallback; `quote` is the kernel's own identifier authority all the same.
    if (e instanceof Identifier) return quote(e.identifier);
    if (!numbered) { binds.push(e.value); return '?'; }
    if (e instanceof KeyedValue) {
      const seen = ordinals.get(e.key);
      if (seen !== undefined) return `?${seen}`;
      ordinals.set(e.key, ++next);
      binds.push(e.value);
      return `?${next}`;
    }
    binds.push(e.value);
    return `?${++next}`;
  }).join('');
  return { sql: text, binds };
}

/** Per-needle memo of `spells`: a `Compound` is immutable once built, so its answer never changes. */
const spelled = new Map<string, WeakMap<Compound, boolean>>();

/**
 * Would `tree`'s RENDERED text contain `needle` within one literal token? The answer `render(tree).sql
 * .includes(needle)` gives for a needle that never straddles two tokens (a compiler sentinel inside one
 * text literal) — without rendering.
 *
 * ⚠️ **Memoised per `Compound` because a nested plan SHARES its subtrees.** The emitter asks this of a
 * block whose FROM is the derived table of the block below it, and so on down, so rendering each
 * question re-rendered every relation beneath it: O(depth²) text, measured as most of a 3.4s compile for
 * `repeat(out().order().by('name')).times(400)`. A subtree already answered is answered again in O(1),
 * so a chain of such questions costs O(tokens) in all. An explicit stack, like `tokens`, because a
 * nesting this deep overflows a recursive walk.
 */
export function spells(tree: Expression, needle: string): boolean {
  if (tree instanceof Text) return tree.text.includes(needle);
  if (!(tree instanceof Compound)) return false;
  let memo = spelled.get(needle);
  if (!memo) spelled.set(needle, memo = new WeakMap());
  const known = memo;
  const stack: { node: Compound; members: Iterator<Expression>; found: boolean }[] = [];
  const enter = (node: Compound): boolean | undefined => {
    const answer = known.get(node);
    if (answer !== undefined) return answer;
    stack.push({ node, members: node.expressions[Symbol.iterator](), found: node.start.text.includes(needle) || node.end.text.includes(needle) });
    return undefined;
  };
  const root = enter(tree);
  if (root !== undefined) return root;
  let last = false;
  while (stack.length) {
    const top = stack[stack.length - 1]!;
    const next = top.found ? { done: true as const, value: undefined } : top.members.next();
    if (next.done) {
      stack.pop();
      known.set(top.node, top.found);
      last = top.found;
      if (stack.length && top.found) stack[stack.length - 1]!.found = true;
      continue;
    }
    const e = next.value;
    if (e instanceof Text) { if (e.text.includes(needle)) top.found = true; }
    else if (e instanceof Compound) { const answer = enter(e); if (answer) top.found = true; }
  }
  return last;
}

/** Render a standalone node (a fragment or a whole tree) to `{sql, binds}` — the
 *  boundary for the few spots that need SQL text without the `Query` CTE machinery
 *  (e.g. a merge run-closure's match query). Binds fall out of the tree. A STATEMENT a compile ships is
 *  rendered with that compile's `budget`, which charges its bytes (`CompileBudget`); a fragment rendered
 *  only to be read (the emitter's qualifier scan) is not a statement and passes none. */
export function render(node: Expression, budget?: CompileBudget): { sql: string; binds: any[] } {
  return renderStatement(sql(node), budget);
}

/** The minimal seam a rendered statement runs against — `GraphStore.query` satisfies it. Structural,
 *  so the kernel depends on no concrete store. */
export interface Queryable { query<T = any>(sql: string, binds?: readonly unknown[]): T[]; }

/** Render a statement and run it. The way a runtime module (a drain, a set write, an OLAP round)
 *  issues SQL built through `q`: its binds come from the `value()` holes in text order, so no call
 *  site keeps a positional bind array in step with a string it concatenated. */
export function execute<T = any>(store: Queryable, node: Expression): T[] {
  const { sql: text, binds } = render(node);
  return store.query<T>(text, binds);
}

/** Identifier-shaped name → spliced raw; else double-quoted. SQL keyword legality is
 * position-dependent (`key` is a legal column name here), so a context-neutral renderer must not
 * blanket-quote a keyword table. */
const SAFE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quote = (n: string) => SAFE.test(n) ? n : `"${n.replace(/"/g, '""')}"`;

/** A compiler-controlled SQL identifier, quoted only when SQLite requires it. This is the
 * kernel's single identifier spelling authority; callers never concatenate names themselves. */
export const identifier = (name: string): Text => raw(quote(name));

/**
 * A COMPILE-TIME string literal — single-quoted, `''`-escaped, and NOT a bind.
 *
 * For text the COMPILER chose, never for data. The distinction is a platform one rather than a
 * stylistic one: a Durable Object caps a statement at 100 BOUND PARAMETERS, so spending one on a
 * constant the compiler wrote is spending a scarce resource on nothing — and it is what made one
 * `as()` cost four binds instead of one (`jsonb_object(?, ?, ?, p.id)`
 * versus `jsonb_object('k', ?, 'v', p.id)`), which at four labels in a chain is the difference
 * between a plan the platform cap admits and one it rejects.
 *
 * A value from the QUERY or the STORE is `value()` and must stay one: inlining data would make the
 * statement text a function of the data, which defeats both the statement cache and the 100 KB text
 * cap. Keeping the two spellings distinct is what keeps a bind count meaningful.
 *
 * TOTAL over every JS string: one the statement text cannot carry FAITHFULLY DECLINES here, the one
 * authority every inlined string passes through, rather than reaching SQLite as a raw error or a
 * different value. Two such strings exist. A NUL (U+0000) ends the statement text at `sqlite3_prepare`
 * (`'ma` + "unrecognized token"); `char(0)` could spell it, but SQLite's own text functions stop at a NUL
 * (`length('a'||char(0)||'b')` is 1, the reference's `"a\u0000b".length()` is 3), so a spelled NUL would
 * trade the error for a wrong answer. A LONE SURROGATE has no UTF-8 encoding: the statement text carries
 * U+FFFD in its place, which then EQUALS a stored U+FFFD the reference's string does not. (A string that
 * crosses as a BIND or inside JSON text is not checked: a lone surrogate there degrades to U+FFFD or `''`,
 * and a NUL there reaches SQLite's C-string text functions as is — accepted divergences.)
 */
export const textLiteral = (text: string): Text => {
  if (UNSAYABLE.test(text))
    throw UnsupportedTraversal.because(`the string constant ${JSON.stringify(text)} holds a NUL or an unpaired surrogate, which SQL statement text cannot carry`);
  return raw(`'${text.replace(/'/g, "''")}'`);
};
/** A NUL, or a UTF-16 surrogate not in a well-formed pair — what `textLiteral` declines. */
const UNSAYABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

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
    if (this.ctes.length === 0) return renderStatement(q`${tail}`);
    const heads = this.ctes.map((c) =>
      q`${raw(c.name)}${c.cols ? raw(`(${c.cols.join(', ')})`) : empty} as (${c.body})`);
    const recursive = this.ctes.some((c) => c.recursive) ? raw('recursive ') : empty;
    const tree = q`with ${recursive}${list(heads)} ${tail}`;
    return renderStatement(tree);
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
 *  an outer row" are separable; the correlated inline child is the two composed.
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
