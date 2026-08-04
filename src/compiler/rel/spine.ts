import { render } from '../../sql/kernel/q.ts';
import type { Compiled, Program } from '../../sql/kernel/render.ts';
import { emitProgram } from '../../rel/emit.ts';
import { cfLimitViolation } from '../../cf-limits.ts';
import type { Engine } from '../engine/deps.ts';
import type { IRStep } from '../ir/strategies.ts';
import { lowerToRel } from './lower.ts';

/**
 * THE ROUTING SEAM — Gremlin in, `Compiled` out, or `null` for "the legacy spine owns this".
 *
 * `lower.ts` answers whether the chain is covered; this module is what makes a covered chain a
 * finished read, and the split matters because the two halves have different rules. Lowering is
 * pure and must never throw for uncovered vocabulary; this side crosses out of the algebra.
 *
 * ## THIS FILE IS SCAFFOLDING, and now it is ONLY a router (§10·4)
 *
 * It used to be two things: a router AND a vocabulary bridge (`layoutOf`/`LAYOUT_FIELD`, translating
 * the neutral channel core into legacy's `TraverserLayout` so that legacy's materializer could compose
 * the payload SELECT over RelIR's relation). §10·10 moved that projection into the algebra, so the
 * bridge is gone along with the alias map that only it read — and with it the wall it was: it could
 * declare no translation for the `path`, `origin` or `branchOrder` roles and THREW, which is what
 * blocked RelIR from carrying a path. The channel core could always hold one; the seam could not
 * express it. There is no longer a seam.
 *
 * What remains has one job — choose between two spines — so it dies with the second one. The name is
 * the harness's rather than the thing's, kept until the deletion lands because renaming scaffolding is
 * churn.
 *
 * ## The plan IS the query
 *
 * `emitProgram` hands back the effects and the result as a kernel `Expression`, `WITH` list and all, and
 * one `render` turns that into `{sql, binds}`. Three things fall out, all of them wanted:
 *
 * - **binds stay in ONE `render`.** Composing an `Expression` rather than splicing a rendered string is
 *   what stops a second bind-ordering authority existing.
 * - **CTE-versus-inline stays RelIR's decision** (§4.6, the `name` pass) rather than leaking into a
 *   framing `Query`'s `c0…cN` namespace where two naming schemes would have to agree.
 * - **the payload projection is not duplicated, because there is only one of it.** `Shape` is the whole
 *   contract crossing this boundary, and `execute.ts`'s byte framers — `(rows, Shape) → Buffer[]`, no SQL
 *   anywhere — are the only per-shape code outside the algebra. That is what makes §5a's equivalence gate
 *   mean what it says: the query being compared is the one RelIR produced.
 *
 * Nothing legacy enters a `Rel`, and nothing RelIR-shaped enters legacy. There is no opaque escape node
 * and never will be (§10·4: "not as a bridge, not temporarily, not behind a flag").
 */
export function compileViaRel(engine: Engine, steps: IRStep[], params: Record<string, any>): Compiled | Program | null {
  // TWO fast-path switches reach the lowering, and for the same reason: each selects between two
  // lowering STRATEGIES that the algebra can state, rather than between two physical access paths
  // (which is the FTS case, where RelIR declines instead). `movementCollapse` picks the grouped
  // `SUM(bulk)`; `predicateInlining` picks the correlated `EXISTS` over the materialized
  // child-existence gate, and RelIR implements only the first of that pair — so with the switch off
  // a `where()` body declines exactly as an unlearned step would. Both positions therefore stay
  // live and L5's differential still has two forms to compare.
  const lowered = lowerToRel(steps, {
    params,
    collapse: engine.fastPaths.movementCollapse,
    correlatedChildren: engine.fastPaths.predicateInlining,
    // NOT a strategy switch — the graph's declared label cardinality is a CAPABILITY, and a creation
    // with no label of its own is a compile-time question only because this value is settled before a
    // compile starts (request-scope DI). Coverage is still not a function of configuration: what the
    // cardinality changes is the ANSWER, not whether there is one.
    labelCardinality: engine.labelCardinality,
  });
  if (!lowered) return null;

  // The platform budget is asked PER STATEMENT here for the same reason it is inside `lowerToRel`:
  // each step is its own query, so each meets the 100-bind and 100 KB walls on its own.
  const { effects, result: relational } = emitProgram(lowered.plan);
  if (effects.some((step) => cfLimitViolation(step.emitted.sql, step.emitted.binds))) return null;

  // A DISCARD leaves through its own door, and the reason is that there is nothing to read: `drop()`'s
  // result relation is a statement with an empty `RETURNING`, so the whole traversal IS its effects.
  // What travels is the `Plan` itself — the executor runs it (`runProgram`), and the retained-rows
  // transport §10·5 requires rides with it rather than being re-derived at the edge.
  const isDiscard = lowered.shape.kind === 'discard';
  if (isDiscard || !relational) {
    if (!isDiscard || relational) throw new Error('RelIR spine: a discard shape and a relational result disagree about whether this program yields traversers');
    return { kind: 'program', program: lowered.plan, shape: { kind: 'discard' }, spine: 'rel' };
  }

  const { sql, binds } = render(relational);
  // THE LAST BUDGET CHECK IS THE PLATFORM'S OWN, MEASURED ON WHAT A DURABLE OBJECT ACTUALLY GETS.
  //
  // `lowerToRel` owns the BIND decision and renders to take it, so this is a backstop for the one thing
  // that decision cannot see: the 100 KB statement-TEXT cap, which §3.6 gives the plan and nothing else
  // enforced. It comes from `cfLimitViolation` — the one authority for what the platform refuses —
  // because a second constant here would be a second chance to disagree with it.
  //
  // A DECLINE and not a throw: legacy answers these today, and a plan we cannot ship is coverage we do
  // not have. If it ever fires, the census's per-query spine ratchet is what reports it.
  if (cfLimitViolation(sql, binds)) return null;
  // A traversal that WROTE frames its rows through exactly this projection — the effects ran first, and
  // the framing read is the program's last step. A write reaches the SAME payload projection a pure read
  // does rather than a write-shaped copy, which is the property §10·10 had to preserve while moving where
  // that projection is built.
  return effects.length
    ? { kind: 'program', program: lowered.plan, tail: { sql, binds }, shape: lowered.shape, spine: 'rel' }
    : { kind: 'read', sql, binds, shape: lowered.shape, spine: 'rel' };
}
