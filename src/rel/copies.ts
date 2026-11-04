import type { Expr } from './expr.ts';
import { isAbort } from './raise.ts';
import type { Rel } from './rel.ts';
import { exprChildren, exprRels, nodeFact, relChildren, relExprs, relsBeneath } from './walk.ts';

/**
 * WHAT IT COSTS TO SPELL A RELATION MORE THAN ONCE — two node facts, for the consumers that name one
 * relation at two places (a per-direction `both()`, a branch's arms over one frontier).
 *
 * SQLite has no LATERAL and expands every reference to a derived table or CTE into its own copy of the
 * definition. A self-contained relation reached twice becomes ONE named CTE (`name`,
 * `src/rel/passes/name.ts`), which SQLite materializes once because it is read more than once. A
 * CORRELATED one cannot move out to a CTE, so the emitter spells it at every reference and SQLite
 * evaluates every copy on its own (measured: even an `AS MATERIALIZED` CTE written inside a correlated
 * subquery is re-evaluated per reference). Two costs follow:
 *
 * - TEXT (`doubledReads`) — a chain of k nodes that each read their input twice is 2^k copies of the first.
 * - THE ANSWER (`draws`) — a copy of a random draw draws again. Two copies of
 *   `out().order().by(shuffle).limit(1)` pick two different vertices, so a both() over it read the out-arm
 *   of one pick and the in-arm of another (`g.V(1).local(out().order().by(shuffle).limit(1).both().count())`
 *   answered 5, which no single out-neighbour of v1 has).
 */

/**
 * DOES EVALUATING THIS RELATION DRAW — is there a `RANDOM()` anywhere in it: in its own expressions, in a
 * subplan they correlate, or beneath it (`order().by(shuffle)`, `sample()`'s collation, any `RANDOM()`).
 * Two evaluations of a relation that draws are two different relations, so it may be READ twice only
 * when it is evaluated once.
 *
 * A raise or deferral arm's `random()` is not a draw: it is only there so SQLite cannot hoist the arm out
 * of its CASE (`raiseInRow`, `src/rel/raise.ts`), and an arm that is evaluated aborts the statement, so
 * its value never reaches an answer. The whole arm is skipped (`isAbort`). Counting it would decline a
 * valid query through `name`.
 *
 * Memoized per node (`nodeFact`), on relations and expressions alike, so it is O(DAG).
 */
export const draws: (r: Rel) => boolean = nodeFact((r: Rel): boolean =>
  relExprs(r).some(exprDraws) || relChildren(r).some(draws));
const exprDraws: (e: Expr) => boolean = nodeFact((e: Expr): boolean => {
  if (isAbort(e)) return false;
  if (e.kind === 'call' && e.fn.toUpperCase() === 'RANDOM') return true;
  return exprChildren(e).some(exprDraws) || exprRels(e).some(draws);
});

/**
 * HOW MANY DOUBLED READS LIE BENEATH THIS RELATION — the most nodes, along any one path from `r` to a
 * leaf, that each read two non-base inputs. So 2^`doubledReads(r)` bounds how many copies of any one
 * relation beneath `r` SQLite spells when it prepares `r`.
 *
 * Naming a relation twice copies everything beneath it, and a chain of k operators that each read their
 * input twice is 2^k copies of the first (the `both()` UNION ALL wall: `g.V().both()×16` refused,
 * `local(both()×8.count())` 46 KB). A consumer about to read an input twice bounds this fact first
 * (`hopJoin`, `src/compiler/rel/lower/movement.ts`), which caps the text at a CONSTANT factor of the plan.
 *
 * - A `Scan`/`Values` is 0.
 * - A single-input node is the max over its input and the subplans its expressions correlate.
 * - A join or union is that max PLUS ONE when two or more of its inputs are not base reads
 *   (`isBaseRead`). A copy of a base read is one more scan of the same index, a constant that cannot
 *   compound, so only a non-base pair counts. Two DIFFERENT non-base inputs count too: over-counting
 *   costs only the faster form, never an answer or text.
 * - A `Ref`, a `SelfRef` and a `Recursive` are UNBOUNDED: each can stand for an arbitrarily deep
 *   definition this fact cannot see. So is any node kind not named here, because UNDER-counting is the
 *   dangerous direction — it re-enables 2^k.
 * - A relation that DRAWS (`draws`) is UNBOUNDED too: a second copy is not a copy at all, so a consumer
 *   that would spell it twice must read it once.
 *
 * Memoized per node (`nodeFact`), so a fold that re-asks it after every step pays only for the nodes
 * built since: O(DAG) in total.
 */
export const doubledReads: (r: Rel) => number = nodeFact((r: Rel): number => {
  if (draws(r)) return Infinity;
  switch (r.kind) {
    case 'scan': case 'values':
    case 'project': case 'filter': case 'aggregate': case 'sort': case 'limit': case 'window':
    case 'distinct': case 'materialize': case 'explode':
      return beneathMax(r, 0);
    case 'join': case 'union':
      return beneathMax(r, relChildren(r).filter((input) => !isBaseRead(input)).length >= 2 ? 1 : 0);
    default: return Infinity;
  }
});
/** The most `doubledReads` beneath `r` — over its children and the subplans its expressions correlate
 *  (`relsBeneath`) — plus what `r` itself adds. */
const beneathMax = (r: Rel, adds: number): number =>
  relsBeneath(r).reduce((most, beneath) => Math.max(most, doubledReads(beneath) + adds), adds);

/**
 * IS A COPY OF THIS RELATION ONE MORE INDEX SCAN? — a base-table read: a `Scan` or `Values` under nothing
 * but row-wise `Project`/`Filter`, whose expressions correlate only against relations of the same kind.
 * `doubledReads` counts a join's or union's inputs by it. A `Ref` (a named CTE), a `SelfRef` and every
 * multi-input or barrier node answer NO: each can stand for an arbitrarily deep definition.
 */
const isBaseRead: (r: Rel) => boolean = nodeFact((r: Rel): boolean => {
  if (r.kind === 'scan' || r.kind === 'values') return true;
  if (r.kind !== 'project' && r.kind !== 'filter') return false;
  return isBaseRead(r.input) && relExprs(r).every(exprIsBaseRead);
});
const exprIsBaseRead = (e: Expr): boolean => exprRels(e).every(isBaseRead) && exprChildren(e).every(exprIsBaseRead);
