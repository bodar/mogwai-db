import type { Expr } from './expr.ts';
import type { Rel } from './rel.ts';

export type Stmt = Insert | Update | Delete | Sequence;
export interface Insert { readonly kind: 'insert'; readonly table: string; readonly cols: readonly string[]; readonly source: Rel; readonly onConflict?: { readonly target: readonly string[]; readonly set: readonly (readonly [string, Expr])[] }; readonly returning: readonly (readonly [string, Expr])[]; }
export interface Update { readonly kind: 'update'; readonly table: string; readonly set: readonly (readonly [string, Expr])[]; readonly from?: Rel; readonly where?: Expr; readonly returning: readonly (readonly [string, Expr])[]; }
export interface Delete { readonly kind: 'delete'; readonly table: string; readonly where?: Expr; readonly using?: Rel; readonly returning: readonly (readonly [string, Expr])[]; }
export interface Sequence { readonly kind: 'sequence'; readonly steps: readonly Stmt[]; }
