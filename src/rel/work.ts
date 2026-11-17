import { rowBounds } from './bounds.ts';
import { reSourceCross } from './lineage.ts';
import type { Rel } from './rel.ts';
import type { Expr } from './expr.ts';
import { forEachExpr, forEachRel, freeRelIds, nodeFact, recursiveStep, relChildren, relExprs } from './walk.ts';

/**
 * WHAT ONE EVALUATION OF A CORRELATED PLAN READS — the per-host-row work of a child body left correlated, as
 * compile-time metadata over the closed node set, `rowBounds`' sibling (`src/rel/bounds.ts`). Calcite asks a
 * plan's cost of its metadata the same way (`RelMdMaxRowCount`, `RelMdCumulativeCost`,
 * `vendor/calcite/core/src/main/java/org/apache/calcite/rel/metadata/`), never of the operator that produced it.
 * So a connector choosing between a body's correlated and decorrelated form, or declining it, reads the ALGEBRA
 * the body lowered to — a spelling change in the query cannot flip the decision — and never a step name or a
 * hand-kept list of node kinds.
 *
 * Two independent facts, each a property of the plan's nodes (subplans included, `forEachRel`'s coverage):
 *
 * - `reSources` — some node is the RE-SOURCE CROSS (`reSourceCross`, `src/rel/lineage.ts`, the one recogniser of
 *   GraphStep's mid-traversal cross of the seed with a whole element relation,
 *   `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GraphStep.java`).
 *   Per host row SQLite reads it as a nested loop that stops at the first row its consumer wants
 *   (`src/rel/passes/leading.ts`); decorrelated, it is crossed with EVERY scope row ahead of whatever picks from
 *   it — N × G — and a rest that reads the host after it cannot be held decorrelated at all (`reSourcedBody`,
 *   `src/compiler/rel/lower/scoped.ts`). The element side's own bound does not change that: `V(1)` is a seek
 *   either way, and the decorrelated form still cannot hold a host read after it.
 * - `exhausts` — some node must read ALL of an unbounded input before it yields the row an `EXISTS` (or a
 *   `LIMIT 1`) could stop at, so a FAILING probe reads the input to its end:
 *   - a BARRIER over an unbounded input — a node that reads its input in full (`readsInputInFull`) reads all of
 *     it first;
 *   - a REJECTION of an unbounded input — a filter, or an inner/semi/anti join it drives, may discard every row
 *     it reads. A filter straight over a base table is the index seek itself (an edge or property lookup by its
 *     key), not a rejection of rows already read; a `left`/`cross` join discards nothing.
 *   A `distinct` is NOT a barrier: SQLite streams it through an ephemeral index, emitting each first occurrence
 *   at once, so it does not stop an `EXISTS` from stopping early. A bounded input (`limit(n)`, `V(1)`, the count
 *   bound a walk condition's `count().is(P)` takes, `boundConditionCount`) costs O(n) and exhausts nothing.
 *
 * MEMOISED per node: a node is immutable, so its work is too.
 */
export interface PerHostWork {
  readonly reSources: boolean;
  readonly exhausts: boolean;
}

const unbounded = (r: Rel): boolean => rowBounds(r).max === Infinity;

/**
 * A BARRIER: does this node read its WHOLE input before it yields its first row, however few of its own rows its
 * reader asks for? An aggregate, a sort and a window must see every input row to compute any output row, and a
 * materialization is a CTE SQLite computes in full on first read. The ONE list of blocking kinds: `exhaustsInput`
 * (what a failing probe reads per host row) and `readInFull` (how far a reader's demand reaches) both ask it. A
 * `distinct` is not one — SQLite streams it through an ephemeral index.
 */
export const readsInputInFull = (r: Rel): r is Extract<Rel, { kind: 'aggregate' | 'sort' | 'window' | 'materialize' }> =>
  r.kind === 'aggregate' || r.kind === 'sort' || r.kind === 'window' || r.kind === 'materialize';

/** Does this one node read ALL of an unbounded input before its first row (its inputs aside)? */
const exhaustsInput = (r: Rel): boolean =>
  (readsInputInFull(r) && unbounded(r.input))
  || (r.kind === 'filter' && r.input.kind !== 'scan' && unbounded(r.input))
  || (r.kind === 'join' && r.join !== 'left' && r.join !== 'cross' && unbounded(r.left));

/** The per-host work of a correlated plan — `PerHostWork`. */
export const perHostWork: (plan: Rel) => PerHostWork = nodeFact((plan: Rel): PerHostWork => {
  let reSources = false, exhausts = false;
  forEachRel(plan, (r) => {
    reSources ||= !!reSourceCross(r, 'any');
    exhausts ||= exhaustsInput(r);
  });
  return { reSources, exhausts };
});

/**
 * HOW MUCH OF EACH RELATION ITS READERS DEMAND — the reader-demand fact, compile-time metadata over the closed node
 * set like `rowBounds`, with no statistics. It models SQLite's evaluation, not TinkerPop's pull laziness: a `LIMIT`
 * and an uncorrelated `EXISTS` or scalar subquery stop at the row they need, an `IN (SELECT …)` list is
 * materialised, and a correlated subquery — with everything SQLite flattens into it — is re-run per outer row.
 *
 * A root is read in full unless `rootsInFull` is false (a body whose reader stops early). Below a node read in full,
 * a barrier (`readsInputInFull`) reads its input in full and a `LIMIT` does not; a semi/anti join probes its right
 * side to a first match; anything else passes the demand through. A relation of at most one row (`rowBounds`) is
 * read in full by any reader.
 *
 * Two modes, two questions:
 *
 * - `'spine'` — which relations have EVERY output row read wherever they are read: the rows a magic domain may be
 *   built from without doing work the plan would have skipped (`src/rel/passes/magic.ts`). Only the spine — a
 *   body's own subplans are asked when their host is rewritten — and never into a recursive term. `stopsEarly` is
 *   empty: a walk that skips subplans cannot know a relation is not also read through one.
 * - `'once'` — which relations are read in full OR RE-EVALUATED MORE THAN ONCE, so a consumer choosing between
 *   reading a relation lazily (inlined) and once in full (fenced) can tell the one case laziness is free: a
 *   relation demanded partially and evaluated once. It enters everything:
 *   - a CORRELATED subplan (`freeRelIds` non-empty) is re-run per outer row, so everything it reads counts as read
 *     in full, beneath a `LIMIT` too;
 *   - an UNCORRELATED `EXISTS` or scalar subplan is evaluated once and reads to its first row (in full only when
 *     `rowBounds` caps it at one row);
 *   - an `IN (SELECT …)` subplan is materialised: read in full;
 *   - a recursive TERM is re-run per iteration: read in full (its seed takes the walk's own demand);
 *   - a join side re-read per row of the other side counts as read in full, unless that other side is at most one
 *     row: a semi/anti join's right side is an `EXISTS` correlated to each left row (`src/rel/emit.ts`), any other
 *     join's inner loop is re-scanned per outer row, and an unordered inner/cross join lets SQLite put either side
 *     inside.
 *
 * `full` holds the relations read in full on EVERY path; `stopsEarly` (`'once'` only) the relations demanded
 * partially on every path, each evaluated once. A relation read both ways is in neither, and so is one no walk
 * reached: a consumer takes the CONSERVATIVE answer for anything not in `stopsEarly`.
 */
export interface ReaderDemand {
  readonly full: ReadonlySet<Rel>;
  readonly stopsEarly: ReadonlySet<Rel>;
}

export function readInFull(roots: readonly Rel[], mode: 'spine' | 'once', rootsInFull = true): ReaderDemand {
  const once = mode === 'once';
  const full = new Set<Rel>(), partial = new Set<Rel>(), repeated = new Set<Rel>();
  // `again`: this evaluation of `r` is one of many (per outer row, per iteration), so everything beneath it is read
  // in full whatever stops it — the strongest state, subsuming a single read in full (`'once'` only).
  const visit = (r: Rel, read: boolean, again: boolean): void => {
    const whole = read || again || rowBounds(r).max <= 1;
    const seen = again ? repeated : whole ? full : partial;
    if (seen.has(r)) return;
    seen.add(r);
    if (again) full.add(r);
    if (once) subqueries(r).forEach((e) => visit(e.plan, e.kind === 'in-query', again || freeRelIds(e.plan).size > 0));
    if (readsInputInFull(r)) { visit(r.input, true, again); return; }
    switch (r.kind) {
      case 'limit': visit(r.input, false, again); return;
      case 'join': {
        const perRowOf = (other: Rel): boolean => once && rowBounds(other).max > 1;
        const existence = r.join === 'semi' || r.join === 'anti';
        const leftInside = !existence && r.join !== 'left' && !r.ordered && perRowOf(r.right);
        visit(r.left, whole, again || leftInside);
        visit(r.right, whole && !existence, again || perRowOf(r.left));
        return;
      }
      case 'recursive':
        visit(r.seed, whole, again);
        if (once) visit(recursiveStep(r), true, true);
        return;
      default: relChildren(r).forEach((child) => visit(child, whole, again));
    }
  };
  roots.forEach((root) => visit(root, rootsInFull, false));
  return {
    full: new Set([...full].filter((r) => !partial.has(r))),
    stopsEarly: once ? new Set([...partial].filter((r) => !full.has(r))) : new Set(),
  };
}

type Subquery = Extract<Expr, { kind: 'scalar' | 'exists' | 'in-query' }>;
/** The subqueries a node's own expressions hold — each subplan's own are its nodes' business. */
function subqueries(r: Rel): readonly Subquery[] {
  const out: Subquery[] = [];
  relExprs(r).forEach((e) => forEachExpr(e, (node) => {
    if (node.kind === 'scalar' || node.kind === 'exists' || node.kind === 'in-query') out.push(node);
  }));
  return out;
}
