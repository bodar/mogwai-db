import type { Channels } from '../channels.ts';

/** SQLite's storage vocabulary, deliberately distinct from Gremlin's value types. */
export type SqlType = 'int' | 'real' | 'text' | 'blob' | 'json' | 'any';

export interface ColMeta {
  readonly name: string;
  readonly type: SqlType;
  readonly nullable: boolean;
}

export interface RelType { readonly cols: readonly ColMeta[]; }

/** Positional column equality — same name, SQL type, and nullability at each position. The one
 *  definition the checker, the recursive fence, and the channel obligations all compare types with. */
export const sameColumns = (left: RelType['cols'], right: RelType['cols']): boolean =>
  left.length === right.length && left.every((column, i) => {
    const other = right[i];
    return other?.name === column.name && other.type === column.type && other.nullable === column.nullable;
  });

/** Positional name equality — the one definition the column-name comparisons share. */
export const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name, i) => name === right[i]);

/** A lexical relation identity. Expressions name relations, never emitter aliases. */
export type RelId = string & { readonly __relId: unique symbol };
export const relId = (name: string): RelId => name as RelId;

/**
 * SQLite's `excluded` — the row an `ON CONFLICT` update is being asked to merge in.
 *
 * A reserved relation identity rather than a field on `Insert`, because that is what it IS: a
 * relation in scope for exactly one clause, carrying the target's columns. Without it an upsert can
 * only assign CONSTANTS, which is not an upsert — and spelling it as an emitter special case would
 * put a physical name back inside a statement, the thing `Delete.using`'s deletion was about.
 * The minter cannot produce this name (its ids are `<hint><n>`), so a collision is unreachable.
 */
export const EXCLUDED = relId('excluded');

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

/** Every relation carries the proven traverser channels it emits — the NEUTRAL channel core
 * (`src/channels.ts`), never the framing layer's `TraverserLayout`. That is the whole of §2's
 * vocabulary boundary: RelIR needs which columns are channels and each one's role, and nothing
 * about alias shape histories or path element types. */
export interface RelBase {
  readonly channels: Channels;
  readonly type: RelType;
}
