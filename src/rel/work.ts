import { rowBounds } from './bounds.ts';
import { reSourceCross } from './lineage.ts';
import type { Rel } from './rel.ts';
import { forEachRel, nodeFact } from './walk.ts';

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
 *   - a BARRIER over an unbounded input — an aggregate, sort or window reads all of it first;
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

/** Does this one node read ALL of an unbounded input before its first row (its inputs aside)? */
const exhaustsInput = (r: Rel): boolean =>
  ((r.kind === 'aggregate' || r.kind === 'sort' || r.kind === 'window') && unbounded(r.input))
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
