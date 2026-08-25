import type { Expr } from './expr.ts';
import { brandRel, type Rel, type RelInit, type RelKind, type RelNode, type Table } from './rel.ts';
import type { RelId, SortTerm } from './types.ts';
import { checkAggregateShape, checkJoinShape, checkRecursiveHeader, checkValuesShape } from './structure.ts';
import { freeze } from './util.ts';

type Node<K extends RelKind> = Extract<Rel, { readonly kind: K }>;
type Init<K extends RelKind> = RelInit<K>;
type WithId<K extends RelKind> = Init<K> & { readonly id: RelId };
const named = (pairs: readonly (readonly [string, Expr])[]): void => {
  if (new Set(pairs.map(([name]) => name)).size !== pairs.length) throw new Error('RelIR: duplicate output name');
};
const outputNames = (pairs: readonly (readonly [string, Expr])[], type: { readonly cols: readonly { readonly name: string }[] }, kind: string): void => {
  named(pairs);
  const actual = pairs.map(([name]) => name);
  const declared = type.cols.map((column) => column.name);
  if (actual.length !== declared.length || actual.some((name, i) => name !== declared[i]))
    throw new Error(`RelIR: ${kind} expressions must declare exactly its output columns`);
};
const node = <K extends RelKind>(kind: K, init: WithId<K>): Node<K> => {
  const { id, ...rest } = init;
  return brandRel({ kind, id, ...rest } as RelNode<K>);
};

/** One stateless constructor per relational shape. Named arguments preserve the schema at call
 * sites; the factory is a contract, not a positional shorthand. */
export const scan = (init: WithId<'scan'>): Node<'scan'> => node('scan', init);

export const values = (init: WithId<'values'>): Node<'values'> => {
  // An empty relation is `Filter(false)` over something, which says what it means; `Values([])` would
  // render to `SELECT  FROM (VALUES )` — invalid SQL that only failed at the database. The shape laws
  // (non-empty rows/cols, uniform row width) live in structure.ts, shared with the checker.
  checkValuesShape(init);
  return node('values', { ...init, rows: freeze(init.rows.map((row) => freeze([...row]))) });
};
/** A reference to a `Plan` binding (§3.0) — a named CTE when the binding is a `Rel`, an earlier
 * statement's retained `RETURNING` rows when it is a `Stmt`. The one naming mechanism, so it
 * replaces both `PriorResult` and the `Naming` side-table. */
export const ref = (init: WithId<'ref'>): Node<'ref'> => node('ref', init);
export const project = (init: WithId<'project'>): Node<'project'> => {
  outputNames(init.exprs, init.type, 'Project');
  return node('project', { ...init, exprs: freeze(init.exprs.map((pair) => freeze([...pair] as [string, Expr]))) });
};
export const filter = (init: WithId<'filter'>): Node<'filter'> => node('filter', init);
/** A grouped relation emits its group KEYS and then its aggregates, and the emitter has to spell
 * every output column by name — so the declared type is the naming authority for keys that are
 * expressions, not just the aggregates that already carry one. */
export const aggregate = (init: WithId<'aggregate'>): Node<'aggregate'> => {
  named(init.aggs);
  checkAggregateShape(init);
  return node('aggregate', init);
};
export const sort = (init: WithId<'sort'>): Node<'sort'> => node('sort', { ...init, terms: freeze([...init.terms] as SortTerm[]) });
export const limit = (init: WithId<'limit'>): Node<'limit'> => node('limit', init);
/** Whole-row `SELECT DISTINCT`, and deliberately nothing else. A KEYED dedup (`dedup(by(x))`, which
 * must keep the whole traverser) is `Window(row_number PARTITION BY x)` then `Filter(rn = 1)` — the
 * job §3.2 gives `partitionBy`. The `on` field this node used to carry conflated the two: it emitted
 * a projection of the keys while its declared type still promised the full row, so a consumer of a
 * dropped column failed at execution with the checker's blessing. */
export const distinct = (init: WithId<'distinct'>): Node<'distinct'> => node('distinct', init);
export const window = (init: WithId<'window'>): Node<'window'> => {
  named(init.specs);
  const expected = [...init.input.type.cols.map((column) => column.name), ...init.specs.map(([name]) => name)];
  const actual = init.type.cols.map((column) => column.name);
  if (expected.length !== actual.length || expected.some((name, i) => name !== actual[i]))
    throw new Error('RelIR: Window output must be input columns followed by its specs');
  return node('window', init);
};
export const explode = (init: WithId<'explode'>): Node<'explode'> => node('explode', init);
export const materialize = (init: WithId<'materialize'>): Node<'materialize'> => node('materialize', init);
/** A join's output is its sides' columns POSITIONALLY — left then right, or the left alone for the
 * existence forms. The declared type supplies the names, because two sides routinely carry the same
 * one and `Col{rel, name}` cannot say which it meant; a duplicate is a construction error rather
 * than a silent last-write-wins, for the same reason two relations may not share a `RelId`. The width,
 * ON, order and duplicate-name laws live in structure.ts, shared with the checker (`joinWidth` too). */
export const join = (init: WithId<'join'>): Node<'join'> => {
  checkJoinShape(init);
  return node('join', init);
};
export const union = (init: WithId<'union'>): Node<'union'> => {
  if (init.inputs.length < 2) throw new Error('RelIR: Union requires at least two inputs');
  return node('union', init);
};
export const recursive = (init: WithId<'recursive'>): Node<'recursive'> => {
  checkRecursiveHeader(init);
  let built: Rel | undefined;
  return node('recursive', { ...init, step: (self) => built ??= init.step(self) });
};

/** Internal-only recursive callback argument. */
export const recursiveSelf = (recursive: Node<'recursive'>): Node<'self-ref'> =>
  brandRel({ kind: 'self-ref', id: recursive.id, name: recursive.name, channels: recursive.channels, type: recursive.type });

export type { Table };
