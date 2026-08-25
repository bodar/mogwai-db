import type { RelNode } from './rel.ts';

// The CONSTRUCTION-TIME structural laws — the ones a node must satisfy the moment it is built, from its
// own fields alone, independent of the scope/tree it later lands in. The factory enforces them at MINT
// time (a malformed node is never constructed) and `check.ts` re-runs them as defense in depth; they live
// here ONCE so the two callers cannot drift with copies that carry identical error strings.
//
// The SCOPE/TREE laws a factory cannot see stay in `check.ts`, next to the walk that has the context: a
// Join's sides being distinct relations, a left Join's right columns being nullable, a Ref agreeing with
// its binding, a SelfRef's legality, and `recursiveViolation`. Each validator takes only the structural
// fields it reads (a `Pick`), so both a `RelInit`-with-id at the factory and a built `RelNode` at the
// checker satisfy it.

/** A join's output width — its sides' columns positionally (left then right), or the left alone for the
 *  existence forms (`semi`/`anti`), which emit no right-side columns. */
export const joinWidth = (j: Pick<RelNode<'join'>, 'left' | 'right' | 'join'>): number =>
  j.left.type.cols.length + (j.join === 'semi' || j.join === 'anti' ? 0 : j.right.type.cols.length);

/** A Join's construction laws: ON presence matches the join kind, only an inner Join pins order, the
 *  declared width is its sides' positional width, and its output names are unique (the emitter names the
 *  output positionally from both sides, so a duplicate would make a `Col` against the join unresolvable). */
export function checkJoinShape(
  j: Pick<RelNode<'join'>, 'left' | 'right' | 'join' | 'on' | 'ordered' | 'type'>,
): void {
  if (j.join === 'cross' && j.on) throw new Error('RelIR: cross join must not have an ON expression');
  if ((j.join === 'inner' || j.join === 'left') && !j.on) throw new Error(`RelIR: ${j.join} join requires an ON expression`);
  if (j.ordered && j.join !== 'inner') throw new Error(`RelIR: only an inner Join may pin its order; ${j.join} may not`);
  const width = joinWidth(j);
  if (j.type.cols.length !== width)
    throw new Error(`RelIR: a ${j.join} Join emits its sides' ${width} columns; its type declares ${j.type.cols.length}`);
  const declared = j.type.cols.map((column) => column.name);
  if (new Set(declared).size !== declared.length) throw new Error('RelIR: a Join declares a duplicate output name');
}

/** An Aggregate emits its group KEYS and then its aggregates; the declared type is the naming authority
 *  (a key that is an expression carries no name of its own), so the declared width and the aggregate
 *  names in their trailing positions must line up. */
export function checkAggregateShape(a: Pick<RelNode<'aggregate'>, 'groupBy' | 'aggs' | 'type'>): void {
  const declared = a.type.cols.map((column) => column.name);
  if (declared.length !== a.groupBy.length + a.aggs.length)
    throw new Error(`RelIR: Aggregate declares ${declared.length} columns but emits ${a.groupBy.length} group keys and ${a.aggs.length} aggregates`);
  if (a.aggs.some(([name], i) => name !== declared[a.groupBy.length + i]))
    throw new Error('RelIR: Aggregate output must be its group keys followed by its aggregates');
}

/** A Values relation needs at least one row and one column, and every row as wide as the declared type
 *  — SQLite has no empty `VALUES` and no empty select list, so neither degenerate shape is constructible. */
export function checkValuesShape(v: Pick<RelNode<'values'>, 'rows' | 'type'>): void {
  if (!v.rows.length) throw new Error('RelIR: Values requires at least one row; an empty relation is a Filter, not an empty VALUES');
  if (!v.type.cols.length) throw new Error('RelIR: Values requires at least one column');
  for (const row of v.rows) if (row.length !== v.type.cols.length)
    throw new Error(`RelIR: Values row has ${row.length} columns; declared type has ${v.type.cols.length}`);
}

/** A Recursive CTE's declared header names must match its output columns exactly. */
export function checkRecursiveHeader(r: Pick<RelNode<'recursive'>, 'cols' | 'type'>): void {
  const output = r.type.cols.map((column) => column.name);
  if (r.cols.length !== output.length || r.cols.some((name, i) => name !== output[i]))
    throw new Error('RelIR: Recursive CTE header must match its output columns');
}
