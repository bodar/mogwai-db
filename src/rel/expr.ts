import type { SortTerm, SqlType, WindowSpec } from './types.ts';
import type { Rel } from './rel.ts';

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '=' | '!=' | '<' | '<=' | '>' | '>='
  | 'like' | 'glob' | 'is' | 'is not' | 'and' | 'or' | '||';

export type Expr =
  | { readonly kind: 'col'; readonly rel: import('./types.ts').RelId; readonly name: string }
  | { readonly kind: 'lit'; readonly value: unknown; readonly type: SqlType; readonly source: 'bound' }
  | { readonly kind: 'lit'; readonly value: unknown; readonly type: SqlType; readonly source: 'parameter'; readonly name: string }
  | { readonly kind: 'lit'; readonly value: string; readonly type: 'text'; readonly source: 'compiler-text' }
  | { readonly kind: 'lit'; readonly value: number; readonly type: 'int'; readonly source: 'compiler-int' }
  | { readonly kind: 'lit'; readonly value: number; readonly type: 'real'; readonly source: 'compiler-real' }
  | { readonly kind: 'lit'; readonly value: null; readonly type: SqlType; readonly source: 'compiler-null' }
  | { readonly kind: 'unary'; readonly op: 'not' | 'neg'; readonly arg: Expr }
  | { readonly kind: 'binary'; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr }
  | { readonly kind: 'case'; readonly whens: readonly (readonly [Expr, Expr])[]; readonly else?: Expr }
  | { readonly kind: 'cast'; readonly arg: Expr; readonly to: SqlType }
  | { readonly kind: 'call'; readonly fn: string; readonly args: readonly Expr[]; readonly distinct?: boolean }
  /**
   * `filter` is SQL's `FILTER (WHERE …)` — the rows of the group this aggregate does NOT take, with the
   * GROUP still determined by all of them. It is a field rather than a derived form because neither
   * existing node can express it: `Aggregate.groupBy` decides the groups from its input's rows, and a
   * `Filter` before it removes a row from the GROUP as well as from the aggregate. The difference is
   * observable — TinkerPop's `group().by(k).by(v)` keeps a key whose every value was unproductive and
   * gives it an EMPTY list, so filtering the rows would delete the key instead (reference:
   * `sideEffect/Group.feature`'s `g_V_group_byXnameX_byXageX`, where `ripple` and `lop` map to `[]`).
   * SQLite has had the clause since 3.30; the DO's is 3.47.
   */
  | { readonly kind: 'agg'; readonly fn: AggFn; readonly args: readonly Expr[]; readonly distinct?: boolean; readonly orderBy?: readonly SortTerm[]; readonly filter?: Expr }
  | { readonly kind: 'window-expr'; readonly fn: WindowFn; readonly args: readonly Expr[]; readonly spec: WindowSpec }
  | { readonly kind: 'json-object'; readonly entries: readonly (readonly [string, Expr])[]; readonly binary: boolean }
  | { readonly kind: 'json-array'; readonly items: readonly Expr[]; readonly binary: boolean }
  | { readonly kind: 'scalar'; readonly plan: Rel }
  | { readonly kind: 'exists'; readonly plan: Rel; readonly negated: boolean }
  | { readonly kind: 'in-list'; readonly expr: Expr; readonly values: readonly Expr[] }
  | { readonly kind: 'in-query'; readonly expr: Expr; readonly plan: Rel; readonly negated: boolean };

/**
 * SQLite's aggregate functions, as the algebra names them. A NAME rather than a node kind, so adding one
 * is not a §3.2 closure question — `Agg` already expresses "a reduction over a group, optionally ordered",
 * and `json_group_object` is the KEYED half of the pair `json_group_array` was already the ordered half of.
 * Its one caller is the element payload's property bag (`compiler/rel/element.ts`), which has no other
 * faithful spelling: assembling an object out of `group_concat` text would make the compiler responsible
 * for JSON escaping that SQLite already does correctly.
 */
export type AggFn = 'count' | 'sum' | 'min' | 'max' | 'avg' | 'total' | 'group_concat'
  | 'json_group_array' | 'jsonb_group_array' | 'json_group_object' | 'jsonb_group_object';
export type WindowFn = 'row_number' | 'rank' | 'dense_rank' | 'count' | 'sum' | 'min' | 'max' | 'lag' | 'lead';

export const col = (rel: import('./types.ts').RelId, name: string): Expr => ({ kind: 'col', rel, name });
/** A value supplied by the query or store: always a bound parameter. */
export const lit = (value: unknown, type: SqlType = 'any'): Expr => ({ kind: 'lit', value, type, source: 'bound' });

/** A USER PARAMETER — a wire GValue the client sent in the `bindings`/`parameters` map (`$x`). This is
 * the ONLY free-standing bind the design keeps by intent: it is the user's strongest signal that a value
 * is variable, and the 100-parameter budget exists precisely to carry it
 * (docs/archive/2026-08-05-parameters-are-the-only-binds.md). A parsed literal is NOT this — it is a constant,
 * inlined (see the `compiler-*` sources). `'bound'` remains the MECHANICAL bind (a collection JSON, the
 * decimal tail — the `oversized` category), distinct from a parameter but rendered the same way.
 *
 * `name` is the wire-parameter name (TinkerPop's `GValue.name`), carried so REPEATED uses of one `$x`
 * collapse to a single placeholder + a single bind at render (`src/sql/kernel/q.ts`) — the budget is
 * for PARAMETERS, not their uses. Two `param()`s with the same name are the same logical parameter (the
 * client guarantees same-name ⇒ same-value); a mechanical `'bound'` bind has no name and never dedups. */
export const param = (value: unknown, name: string, type: SqlType = 'any'): Expr => ({ kind: 'lit', value, type, source: 'parameter', name });

/** Does this `Lit` render as a DO bind parameter (a `?`), rather than inline SQL text? A user PARAMETER
 * and a mechanical `'bound'` bind (an oversized collection / decimal tail) both do; a compiler-authored
 * constant (`compiler-*`) renders as an escaped literal and spends none of the 100-parameter budget. The
 * one authority both the emitter switch and the bind-budget counter read, so the counted budget cannot
 * drift from what actually renders — which is the whole of "the 100-bind cap is a parameter budget". */
export const bindsAsParameter = (e: Extract<Expr, { kind: 'lit' }>): boolean =>
  e.source === 'bound' || e.source === 'parameter';

/** A compiler-authored string token, rendered as an escaped SQL literal rather than consuming a DO bind.
 * This is deliberately string-only: data stays in `lit`, and the narrow type prevents a caller from
 * smuggling an arbitrary value into statement text. */
export const compilerText = (value: string): Expr => ({ kind: 'lit', value, type: 'text', source: 'compiler-text' });

/** A compiler-authored SQL integer token. Query/store numbers must use `lit()` and remain binds. */
export const compilerInt = (value: number): Expr => {
  if (!Number.isSafeInteger(value)) throw new Error(`RelIR compiler integer must be a safe integer: ${value}`);
  return { kind: 'lit', value, type: 'int', source: 'compiler-int' };
};

/** A compiler-authored SQL real (floating) token — a held numeric constant whose declared canonical
 * type is `float`/`double`/`bigdecimal` (or a fractional value of any type). Rendered as a literal that
 * carries an explicit REAL storage class (a decimal point or exponent), so an integer-valued double
 * inlines as `2.0` rather than the INTEGER `2` a bare spelling would produce. Query/store numbers must
 * use `lit()` and remain binds.
 *
 * `±Infinity` is admitted (the emit spells it `9e999`/`-9e999`, a SQLite overflow literal) — a
 * non-finite CONSTANT inlines rather than binding (`compiler/rel/const.ts`). `NaN` is refused, because
 * SQLite has no NaN at all and `constLit` renders it as `9e999 - 9e999` (a binary) rather than through
 * this constructor — a `compilerReal(NaN)` would be a caller error, so it stays a throw. */
export const compilerReal = (value: number): Expr => {
  if (Number.isNaN(value)) throw new Error(`RelIR compiler real cannot be NaN (SQLite has no NaN): ${value}`);
  return { kind: 'lit', value, type: 'real', source: 'compiler-real' };
};

/** SQL NULL selected by the compiler itself. A null supplied by the query/store stays a bound `lit`. */
export const compilerNull = (type: SqlType = 'any'): Expr => ({ kind: 'lit', value: null, type, source: 'compiler-null' });
