import type { Expr } from './expr.ts';
import { brandStmt, type Stmt, type StmtInit, type StmtKind, type StmtNode } from './stmt.ts';
import { freeze } from './util.ts';

type Node<K extends StmtKind> = Extract<Stmt, { readonly kind: K }>;
type Init<K extends StmtKind> = StmtInit<K>;
const names = (pairs: readonly (readonly [string, Expr])[], what: string): void => {
  if (new Set(pairs.map(([name]) => name)).size !== pairs.length) throw new Error(`RelIR: duplicate ${what} name`);
};
const node = <K extends StmtKind>(kind: K, init: Init<K>): Node<K> =>
  brandStmt({ kind, ...init } as StmtNode<K>);

/** One stateless constructor per write shape. Named arguments preserve the SQL contract at call
 * sites; statements use the same branded boundary as relations. */
export const insert = (init: Init<'insert'>): Node<'insert'> => {
  if (!init.cols.length) throw new Error('RelIR: Insert requires at least one target column');
  if (new Set(init.cols).size !== init.cols.length) throw new Error('RelIR: Insert has duplicate target column');
  if (init.onConflict) {
    if (!init.onConflict.target.length) throw new Error('RelIR: Insert conflict target cannot be empty');
    if (new Set(init.onConflict.target).size !== init.onConflict.target.length) throw new Error('RelIR: Insert conflict target has duplicate column');
    names(init.onConflict.set, 'conflict update');
  }
  names(init.returning, 'RETURNING');
  return node('insert', { ...init, cols: freeze([...init.cols]), returning: freeze(init.returning.map((pair) => freeze([...pair] as [string, Expr]))), onConflict: init.onConflict && { ...init.onConflict, target: freeze([...init.onConflict.target]), set: freeze(init.onConflict.set.map((pair) => freeze([...pair] as [string, Expr]))) } });
};
export const update = (init: Init<'update'>): Node<'update'> => {
  if (!init.set.length) throw new Error('RelIR: Update requires at least one assignment');
  names(init.set, 'Update assignment');
  names(init.returning, 'RETURNING');
  return node('update', { ...init, set: freeze(init.set.map((pair) => freeze([...pair] as [string, Expr]))), returning: freeze(init.returning.map((pair) => freeze([...pair] as [string, Expr]))) });
};
export const remove = (init: Init<'delete'>): Node<'delete'> => {
  names(init.returning, 'RETURNING');
  return node('delete', { ...init, returning: freeze(init.returning.map((pair) => freeze([...pair] as [string, Expr]))) });
};
