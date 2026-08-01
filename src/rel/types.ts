import type { TraverserLayout } from '../compiler/steps/context/context.ts';

/** SQLite's storage vocabulary, deliberately distinct from Gremlin's value types. */
export type SqlType = 'int' | 'real' | 'text' | 'blob' | 'json' | 'any';

export interface ColMeta {
  readonly name: string;
  readonly type: SqlType;
  readonly nullable: boolean;
}

export interface RelType { readonly cols: readonly ColMeta[]; }

/** A lexical relation identity. Expressions name relations, never emitter aliases. */
export type RelId = string & { readonly __relId: unique symbol };
export const relId = (name: string): RelId => name as RelId;

export interface SortTerm {
  readonly expr: import('./expr.ts').Expr;
  readonly dir: 'asc' | 'desc';
  readonly nulls?: 'first' | 'last';
}

export interface WindowSpec {
  readonly partitionBy: readonly import('./expr.ts').Expr[];
  readonly orderBy: readonly SortTerm[];
  readonly frame?: { readonly start: FrameBound; readonly end: FrameBound; readonly mode: 'rows' | 'range' };
}

export type FrameBound =
  | { readonly kind: 'unbounded-preceding' | 'current-row' | 'unbounded-following' }
  | { readonly kind: 'preceding' | 'following'; readonly count: import('./expr.ts').Expr };

/** Every relation carries the proven traverser channels it emits. */
export interface RelBase {
  readonly layout: TraverserLayout;
  readonly type: RelType;
}
