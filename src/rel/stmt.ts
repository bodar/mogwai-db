import type { Expr } from './expr.ts';
import type { Rel } from './rel.ts';
import type { RelType } from './types.ts';

type RawStmt = Insert | Update | Delete | Sequence;
export type StmtTarget = Extract<Rel, { readonly kind: 'scan' }>;

/** A mutation target is a Scan: Scan remains the one physical-schema node, and its lexical id
 * gives target expressions a scope without reintroducing table/column strings in statements. */
export interface Insert { readonly kind: 'insert'; readonly target: StmtTarget; readonly cols: readonly string[]; readonly source: Rel; readonly onConflict?: { readonly target: readonly string[]; readonly set: readonly (readonly [string, Expr])[] }; readonly returning: readonly (readonly [string, Expr])[]; readonly returningType: RelType; }
export interface Update { readonly kind: 'update'; readonly target: StmtTarget; readonly set: readonly (readonly [string, Expr])[]; readonly from?: Rel; readonly where?: Expr; readonly returning: readonly (readonly [string, Expr])[]; readonly returningType: RelType; }
export interface Delete { readonly kind: 'delete'; readonly target: StmtTarget; readonly where?: Expr; readonly using?: Rel; readonly returning: readonly (readonly [string, Expr])[]; readonly returningType: RelType; }
export interface Sequence { readonly kind: 'sequence'; readonly steps: readonly Stmt[]; }

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
