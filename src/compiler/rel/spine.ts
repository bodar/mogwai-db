import { render } from '../../sql/kernel/q.ts';
import type { Compiled, Program } from '../../sql/kernel/render.ts';
import { emitProgram } from '../../rel/emit.ts';
import { renderProgram } from '../../program.ts';
import type { IRStep } from '../ir/strategies.ts';
import type { LabelRegime } from '../../api.ts';
import type { Service } from '../../services/spi/types.ts';
import type { MergePolicy } from '../../gremlin/frontend.ts';
import { lowerToRel, type Lowering, type RelLowering } from './lower.ts';

/**
 * What the RelIR route needs from the enclosing REQUEST — and the whole of it.
 *
 * This route recurses into nothing — it reads TWO settled values and lowers an algebra. It is named
 * for what it is rather than for the scope object it happens to be built from.
 */
export interface RelRequest {
  /** The services this chain's `call()` steps name, RESOLVED at the DI boundary
   *  (`servicesNamedBy`). Deliberately the resolved map and NOT the `ServiceRegistry`: a registry
   *  is an ambient capability, and `compiler/CLAUDE.md` keeps those in DI rather than threading
   *  them into a lowering. What crosses is the value the dependency produced. */
  readonly services: ReadonlyMap<string, Service>;
  /** Whether the bulk `SUM(bulk)` movement collapse is enabled — a lowering STRATEGY the algebra can
   *  state, which is why it is offered rather than assumed (both positions stay expressible, so the
   *  differential has two forms to compare). */
  readonly collapse: boolean;
  /** Whether the driving property seek (`src/rel/passes/semijoin.ts`, `indexSeek`) may lift a correlated property
   *  `EXISTS` in front of the scan it filters. A physical rewrite over the finished algebra rather
   *  than a lowering choice, which is why it arrives here as a flag and is applied by a pass. */
  readonly propertySeek: boolean;
  readonly ftsSubstringPredicate: boolean;
  /** DETACHED-transfer compile mode (set only by `runForeign()`): the leaf emits a fuller property node
   *  `{t, v, vpid, meta?}` so a landed snapshot carries per-property identity + meta. Off for ordinary
   *  wire framing, so the base plan is unchanged. */
  readonly detached: boolean;
  /** How a `T.label` ENTRY renders (`valueMap(true)`, `elementMap()`) — decided ONLY by an explicit
   *  `with("multilabel")`/`with("singlelabel")`, since storage no longer has a regime to inherit
   *  from (§api.ts). It crosses as its own settled value rather than being re-derived inside the
   *  lowering from a source-options map the algebra has no business reading. */
  readonly labelRegime: LabelRegime;
  /** `withSack(seed[, Operator.x])`'s policy, as the front end extracted it, or `null`. A SOURCE-level declaration
   *  settled before a compile starts, so it crosses as a settled VALUE rather than a step argument —
   *  and it is here rather than being a route GATE because a gate reads identically to a missing
   *  lowering in every counter that tracks coverage (§6·6). */
  readonly sack: MergePolicy | null;
  /** The MERGE POLICY declared with the REDUCER form `withSideEffect(name, seed, Operator.x)`, by
   *  label. It crosses for `sack`'s reason and is a SEPARATE fact from the constant registry: the
   *  front end skips the reducer form when building that map (there is no constant to substitute), so
   *  without this the lowering cannot tell a seeded, operator-merged collection from a fresh one —
   *  and a fact a lowering cannot SEE is one it can neither fold nor decline on. */
  readonly sideEffectPolicies: ReadonlyMap<string, MergePolicy>;
}

/**
 * THE COMPILE SEAM — Gremlin in, `Compiled` out, or `null` when the lowering does not cover the
 * chain (a miss the caller raises as `UnsupportedTraversal`).
 *
 * `lower.ts` answers whether the chain is covered; this module is what makes a covered chain a
 * finished read, and the split matters because the two halves have different rules. Lowering is
 * pure and must never throw for uncovered vocabulary; this side crosses out of the algebra.
 *
 * ## The payload projection lives in the algebra
 *
 * This once did two things: routing AND a vocabulary bridge (`layoutOf`/`LAYOUT_FIELD`, translating
 * the neutral channel core into a `TraverserLayout` so a separate materializer could compose the
 * payload SELECT over RelIR's relation). §6·3 moved that projection into the algebra, so the bridge
 * is gone along with the alias map that only it read — and with it the wall it was: it could declare
 * no translation for the `path` or `origin` roles and THREW, which is what blocked
 * RelIR from carrying a path. The channel core could always hold one; the bridge could not express
 * it. There is no longer such a seam.
 *
 * ## The plan IS the query
 *
 * `emitProgram` hands back the effects and the result as a kernel `Expression`, `WITH` list and all, and
 * one `render` turns that into `{sql, binds}`. Three things fall out, all of them wanted:
 *
 * - **binds stay in ONE `render`.** Composing an `Expression` rather than splicing a rendered string is
 *   what stops a second bind-ordering authority existing.
 * - **CTE-versus-inline stays RelIR's decision** (§4, the `name` pass) rather than leaking into a
 *   framing `Query`'s `c0…cN` namespace where two naming schemes would have to agree.
 * - **the payload projection is not duplicated, because there is only one of it.** `Shape` is the whole
 *   contract crossing this boundary, and `execute.ts`'s byte framers — `(rows, Shape) → Buffer[]`, no SQL
 *   anywhere — are the only per-shape code outside the algebra. That is what makes §5's equivalence gate
 *   mean what it says: the query being compared is the one RelIR produced.
 *
 * There is no opaque escape node and never will be — not as a bridge, not temporarily, not behind a
 * flag.
 */
export function compileViaRel(
  request: RelRequest, steps: IRStep[], params: Record<string, any>, sideEffects: Map<string, any>,
): Compiled | Program | null {
  // ONE fast-path switch reaches the lowering. `movementCollapse` picks the grouped `SUM(bulk)`,
  // which is a lowering STRATEGY the algebra can state, so both positions stay expressible and the
  // per-switch differential has two forms to compare. (The FTS case is the contrast: it selects a
  // physical ACCESS PATH, so the lowering declines rather than implementing a side of it.)
  //
  // **`predicateInlining` USED TO GATE `correlatedChildren` HERE, AND THAT WAS A CONTRACT VIOLATION
  // WAITING FOR A WITNESS.** The reasoning was that the switch picks the correlated `EXISTS` over a
  // materialized child-existence gate and only the first was implemented, so with the switch off a
  // `where()` body should decline "exactly as an unlearned step would". That is fine only while the
  // generic path can answer whatever the correlated child can — and the moment it could not, turning
  // a FAST PATH off removed a SUPPORT capability. `src/compiler/CLAUDE.md` forbids exactly that: a
  // specialized lowering qualifies ONLY if disabling it compiles the same traversal generically, and
  // recognition failure falls through rather than throwing.
  //
  // The witness was `g.E().where(__.outV().group().by('name'))`, found by L5 on a seed CI happened to
  // draw (the seed derives from HEAD, which is why a local run had missed it): with the switch ON the
  // lowering answers 6 rows — correct, since `group()` is a barrier with a HashMap seed and therefore
  // always yields, so every edge passes the `where()` — and with it OFF the traversal was not covered,
  // a `UnsupportedTraversal` refusal. An answer against a refusal is not a result-equivalent pair.
  //
  // So the capability is no longer switched. `predicateInlining` still selects between its two forms,
  // which is what it is for, and L5's own `predicateInlining is equivalent to its generic fallback`
  // case still exercises it.
  const lowered = lowerToRel(steps, loweringOptions(request, params, sideEffects));
  if (!lowered) return null;
  return finishLowering(lowered);
}

/**
 * THE SETTLED VALUES A LOWERING RUNS UNDER, as one object — built here because a traversal has TWO
 * halves whenever a barrier splits it, and both must run under the same ones. A resume that re-derived
 * them (`segment.ts`) could compile the tail of a chain with a different collapse strategy or a
 * different label regime from its head, which is a wrong answer no gate would name.
 */
export function loweringOptions(
  request: RelRequest, params: Record<string, any>, sideEffects: Map<string, any>,
): Lowering {
  return {
    params,
    collapse: request.collapse,
    correlatedChildren: true,
    // NOT a strategy switch — the graph's declared label cardinality is a CAPABILITY, and a creation
    // with no label of its own is a compile-time question only because this value is settled before a
    // compile starts (request-scope DI). Coverage is still not a function of configuration: what the
    // cardinality changes is the ANSWER, not whether there is one.
    labelRegime: request.labelRegime,
    propertySeek: request.propertySeek,
    ftsSubstringPredicate: request.ftsSubstringPredicate,
    detached: request.detached,
    services: request.services,
    sack: request.sack,
    sideEffectPolicies: request.sideEffectPolicies,
    // NOT a strategy switch either — a `withSideEffect(k, <literal>)` is a compile-time CONSTANT the
    // front-end already extracted, and the write parse has always taken it. What used to happen is
    // that this value was not handed to the lowering when one was declared, so the whole
    // `mergeV(__.select(c))` family read as an uncovered gap rather than as a value simply not passed
    // through (§6·6). The REDUCER form (`withSideEffect(k, seed, BiFunction)`) is left unregistered by
    // the front-end, so a `select(k)` over one finds no constant and declines exactly as before.
    sideEffects,
  };
}

/**
 * A LOWERED PLAN, rendered — the half of the route that is about crossing OUT of the algebra rather
 * than about which traversal was covered.
 *
 * Split from the router because there are two ways into it and only one of them starts from a step
 * chain: the ordinary compile above, and a barrier's RESUME (`segment.ts`), which lowers the rest of
 * a chain over rows that arrived on a Promise. Both owe the identical crossing — emit the program,
 * render the result, decide read vs program — and a second copy of it is a second bind-ordering
 * authority, which is the thing §5 exists to keep singular.
 */
export function finishLowering(lowered: RelLowering): Compiled | Program {
  const { effects, result: relational } = emitProgram(lowered.plan);

  // A DISCARD leaves through its own door, and the reason is that there is nothing to read: `drop()`'s
  // result relation is a statement with an empty `RETURNING`, so the whole traversal IS its effects.
  // What travels is the RENDERED program (`renderProgram`) — plain steps the DO runs (`runSteps`), not
  // the live `Plan`, whose `recursive` closure and symbol-branded nodes cannot cross an RPC. The
  // retained-rows transport §6·2 requires rides in those steps' binds rather than being re-derived.
  const isDiscard = lowered.shape.kind === 'discard';
  if (isDiscard || !relational) {
    if (!isDiscard || relational) throw new Error('RelIR spine: a discard shape and a relational result disagree about whether this program yields traversers');
    return { kind: 'program', ...renderProgram(lowered.plan), shape: { kind: 'discard' } };
  }

  const { sql, binds } = render(relational);
  /**
   * THE PLATFORM'S LIMITS ARE NOT CHECKED HERE, AND THAT IS DELIBERATE.
   *
   * This used to decline any program whose statements breached Cloudflare's 100-bind / 100 KB caps.
   * A platform constant compiled into a ROUTING decision makes the compiler wrong the moment the
   * platform changes: if Cloudflare raises the cap, every query between the old number and the new
   * one keeps being refused until we ship a release, for no reason a user can see. The DO enforces
   * its own limits and rejects what it cannot run; duplicating that here buys nothing at runtime and
   * costs a redeploy to un-buy.
   *
   * So the caps live where an assertion belongs — in the build, not in the product. `CfLimitedSql`
   * (`src/cf-limits.ts`) is an `Sql` DECORATOR that makes Bun refuse exactly what a DO refuses, and
   * `mise run test:cf-limits` runs the whole suite behind it; `rel-sweep` and `sql-hygiene` ask
   * `cfLimitViolation` of every corpus plan as CI gates. Those keep the dev/prod divergence visible —
   * which was the real value all along — while production stays governed by the platform itself.
   *
   * What remains keyed to the constants is only ever a STRATEGY, never a refusal: `SET_BIND_LIMIT`
   * chooses an IN-list over a JSON bind. It stays correct if the cap moves — merely conservative —
   * which is the test a platform number has to pass before it may appear in shipping code.
   */
  // A traversal that WROTE frames its rows through exactly this projection — the effects ran first, and
  // the framing read is the program's last step. A write reaches the SAME payload projection a pure read
  // does rather than a write-shaped copy, which is the property §6·3 had to preserve while moving where
  // that projection is built.
  return effects.length
    ? { kind: 'program', ...renderProgram(lowered.plan, { sql, binds }), shape: lowered.shape }
    : { kind: 'read', sql, binds, shape: lowered.shape };
}
