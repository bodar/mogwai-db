import type { Expr } from './expr.ts';
import type { Rel } from './rel.ts';
import type { RelBase } from './types.ts';

type RawStmt = Insert | Update | Delete;
export type StmtTarget = Extract<Rel, { readonly kind: 'scan' }>;

/**
 * A mutation target is a Scan: Scan remains the one physical-schema node, and its lexical id gives
 * target expressions a scope without reintroducing table/column strings in statements.
 *
 * Statements share `RelBase` with relations, so a statement's RESULT is a relation like any other —
 * `type` IS the `RETURNING` schema, and the separate `returningType` field it used to carry is gone
 * with it. The unions stay separate for the rule that makes §3.0 work: **effects are legal only at
 * a `Plan` binding**, so a `Stmt` cannot be a `Join` input, and that is a type-level fact rather
 * than a checker rule.
 */
export interface Insert extends RelBase { readonly kind: 'insert'; readonly target: StmtTarget; readonly cols: readonly string[]; readonly source: Rel; readonly onConflict?: { readonly target: readonly string[]; readonly set: readonly (readonly [string, Expr])[] }; readonly returning: readonly (readonly [string, Expr])[]; }
export interface Update extends RelBase { readonly kind: 'update'; readonly target: StmtTarget; readonly set: readonly (readonly [string, Expr])[]; readonly from?: Rel; readonly where?: Expr; readonly returning: readonly (readonly [string, Expr])[]; }
export interface Delete extends RelBase { readonly kind: 'delete'; readonly target: StmtTarget; readonly where?: Expr; readonly using?: Membership; readonly returning: readonly (readonly [string, Expr])[]; }

/** SQLite has no `DELETE … USING`, so `using` is the RelIR contract that names the rows to remove:
 * membership of `key` in what `rel` emits. `key` is a column BOTH the target and `rel` declare, and
 * it is a field rather than a hardcoded `'id'` because `Scan` is the one physical-schema node
 * (§3.3) — a literal column name in the emitter is a second place the schema leaks into. */
export interface Membership { readonly rel: Rel; readonly key: string; }

const stmtBrand: unique symbol = Symbol('RelIR.Stmt');
type Branded<T> = T extends unknown ? T & { readonly [stmtBrand]: true } : never;

/** A checked construction token. Only the kind-specific functions in stmt-factory.ts mint one. */
export type Stmt = Branded<RawStmt>;
export type StmtKind = RawStmt['kind'];
export type StmtNode<K extends StmtKind> = Extract<RawStmt, { readonly kind: K }>;
export type StmtInit<K extends StmtKind> = Omit<StmtNode<K>, 'kind'>;

/** Factory implementation seam; deliberately not re-exported from a public surface. */
export const brandStmt = <K extends StmtKind>(node: StmtNode<K>): Extract<Stmt, { readonly kind: K }> =>
  Object.freeze({ ...node, [stmtBrand]: true }) as Extract<Stmt, { readonly kind: K }>;

export const isStmt = (value: unknown): value is Stmt =>
  typeof value === 'object' && value !== null && (value as { readonly [stmtBrand]?: unknown })[stmtBrand] === true;
