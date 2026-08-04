import type { SortTerm, SqlType, WindowSpec } from './types.ts';
import type { Rel } from './rel.ts';

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '=' | '!=' | '<' | '<=' | '>' | '>='
  | 'like' | 'glob' | 'is' | 'is not' | 'and' | 'or' | '||';

export type Expr =
  | { readonly kind: 'col'; readonly rel: import('./types.ts').RelId; readonly name: string }
  | { readonly kind: 'lit'; readonly value: unknown; readonly type: SqlType }
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
export const lit = (value: unknown, type: SqlType = 'any'): Expr => ({ kind: 'lit', value, type });
