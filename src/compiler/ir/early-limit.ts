import { isDirectionArg, isNested, stepChain, type Step } from '../../gremlin/frontend.ts';
import { isLocalScope, SLICE_STEPS, type IRStep } from './step.ts';

/**
 * TINKERPOP'S `EarlyLimitStrategy` — a slice moved left, exactly as the reference moves it.
 *
 * `EarlyLimitStrategy` is a DEFAULT optimization (`TraversalStrategies.java:277`) that moves every
 * `RangeGlobalStepContract` (`limit`/`range`/`skip` — NOT `tail`, a `TailGlobalStepContract`) LEFT past each
 * step that is a `SideEffectStep` or a `MapStep` with an always-bound result, to just after the last step
 * before it that is neither
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/EarlyLimitStrategy.java`
 * `apply`/`isMapStepMovable`; the always-bound classes are
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/util/StepOutputArityPredictor.java`'s
 * `STEP_CLASSES_WITH_DEFINITELY_SINGULAR_ARITY_BEHAVIOR` — `DEFINITELY_SINGULAR` only, so a `MAY_BE_SINGULAR`
 * or unlisted step stops it).
 *
 * The move is observable TWICE, and both are why it is applied over every movable run rather than only
 * where it matters for one of them:
 *  - over a SIDE EFFECT it decides what is written: `g.V().property('x',1).limit(1)` is
 *    `g.V().limit(1).property('x',1)` in the reference, so `x` lands on ONE vertex;
 *  - it decides where equal traversers MERGE. The strategy is a prior of `LazyBarrierStrategy`
 *    (`…/strategy/optimization/LazyBarrierStrategy.java:62-71`), which places no `NoOpBarrierStep` after a
 *    flat-map whose next step is a `Barrier` — and a moved `RangeGlobalStep` IS one (`FilteringBarrier`,
 *    `…/step/filter/RangeGlobalStepContract.java:38`). So `g.V().both().both().id().limit(9)` merges NOTHING
 *    after the second `both()` — it is `…both().limit(9).id()` — while `….id().fold()` merges there.
 *    `bulkingPositions` (`ir/bulk.ts`) reads the moved chain, so the two can never disagree.
 *
 * A KEYED `groupCount('a')`/`group('a')`/`tree('a')`/`subgraph('a')` is NOT crossed: at the pin those are
 * `SideEffectBarrierStep`s (`…/step/sideEffect/SideEffectBarrierStep.java` — an `AbstractStep` and a
 * `LocalBarrier`, neither a `SideEffectStep` nor a `MapStep`), so the strategy takes one as its
 * `insertAfter`, and its `processAllStarts` reads the whole input before the slice sees anything:
 * `g.V().groupCount('a').by(label).limit(1).cap('a')` counts all six (`GroupCount.feature`
 * `g_V_groupCountXaX_selectXaX_countXlocalX` pins that barrier behaviour).
 *
 * What it moves past is EXACTLY what the strategy moves past (`movable`): crossing a step the strategy
 * stops at would cut side effects the reference performs, and stopping short of one it crosses would put a
 * `NoOpBarrierStep` merge where the reference has none. The one step it knowingly stops at short of the
 * strategy is a MODULATED `path()` (a `PathStep`, always bound to the predictor, though a `by()` may be
 * unproductive) — harmless to the merge, since a `path()` switches `LazyBarrierStrategy` off — and a slice
 * it does not move that still trails a side effect is the lowering's to decline (`ProgramWrites.truncated`,
 * `rel/write.ts`).
 *
 * Two refusals, each the strategy's own:
 *  - a run reaching the chain's START is not moved — the strategy inserts after the last step that is
 *    neither kind, and with none (`insertAfter == null`, a child body `__.property(…).limit(1)`) it
 *    leaves the slice where it is;
 *  - a slice under `withoutStrategies(EarlyLimitStrategy)` (`earlyLimitSuppressed`) is not moved.
 * (A slice moved next to an earlier one is merged with it by the strategy — `moveRangeStep` — which two
 * adjacent slices already mean; no `SideEffectStep` that is also `SideEffectCapable` exists at the pin, so
 * its `merge = false` case cannot arise from the steps crossed here.)
 *
 * And one of ours: a slice is never inserted inside a write CLUSTER — between an `addV`/`addE`/merge and
 * the `property`/`from`/`to`/`option` modulators the lowering folds into it — since that would turn a
 * creation parameter into a separate step. `GraphTraversal.property` folds a property into an
 * `AddVertexStep`/`AddEdgeStep` (`dsl/graph/GraphTraversal.java:4020-4058`), so the reference moves the
 * slice past the whole creation; a run that would split one is left alone (and declined downstream).
 */
export function earlyLimit(steps: IRStep[]): IRStep[] {
  let out = steps;
  for (let at = 0; at < out.length; at++) {
    const slice = out[at]!;
    if (!SLICE_STEPS.has(slice.name) || isLocalScope(slice) || slice.earlyLimitSuppressed) continue;
    let start = at;
    while (start > 0 && movable(out, start - 1)) start--;
    // Nothing crossed; or the run reached the chain's start (no `insertAfter`).
    if (start === at || start === 0) continue;
    if (CLUSTER_MEMBERS.has(out[start]!.name) && inCluster(out, start - 1)) continue;
    // …nor taken OUT from between a write and a modulator-named step after it, which would then fold into
    // that write: `addV('x').limit(1).property('n', …)` is an `AddPropertyStep` read AFTER the creation
    // (folding happens when the traversal is BUILT), and `addV('x').property('n', …)` a creation parameter.
    const after = out[at + 1];
    if (after && CLUSTER_MEMBERS.has(after.name) && inCluster(out, at - 1)) continue;
    out = [...out.slice(0, start), slice, ...out.slice(start, at), ...out.slice(at + 1)];
  }
  return out;
}

/** The reference's `SideEffectStep`s as spelled here — `AddPropertyStep`, `AddLabelStep`, `DropLabelsStep`,
 *  `TraversalSideEffectStep`, `FailStep` — and the two creations, `AddVertexStep`/`AddEdgeStep` (always-bound
 *  maps with an effect). */
const SIDE_EFFECTS: ReadonlySet<string> = new Set(['property', 'addLabel', 'dropLabel', 'dropLabels', 'sideEffect', 'fail', 'addV', 'addE']);

/** The always-bound `MapStep`s crossed (`StepOutputArityPredictor`'s `DEFINITELY_SINGULAR` list, each a
 *  `MapStep`): `IdStep`, `LabelStep`, `ConstantStep`, `PropertyKeyStep`, `PropertyValueStep`, `PathStep`,
 *  `ElementMapStep`, `PropertyMapStep`, `MathStep`, `ProjectStep`, `EdgeOtherVertexStep` — plus `as()`, a
 *  label on the step before, and `identity()`, which `IdentityRemovalStrategy` removes. NOT `inV`/`outV`:
 *  an `EdgeVertexStep` is a `FlatMapStep` (`…/step/map/EdgeVertexStep.java`), and `MAY_BE_SINGULAR` besides. */
const ONE_TO_ONE: ReadonlySet<string> = new Set([
  'as', 'identity', 'id', 'label', 'constant', 'key', 'value', 'path', 'elementMap', 'valueMap', 'propertyMap', 'math', 'project', 'otherV',
]);
/** The LOCAL forms that are always-bound `ScalarMapStep`s: `CountLocalStep`, `OrderLocalStep`, `SampleLocalStep`. */
const ONE_TO_ONE_LOCAL: ReadonlySet<string> = new Set(['count', 'order', 'sample']);
/** The `ReducingBarrierStep`s, which the predictor counts as `DEFINITELY_SINGULAR` inside a `map()` body. */
const REDUCING: ReadonlySet<string> = new Set(['count', 'sum', 'min', 'max', 'mean', 'fold', 'group', 'groupCount', 'tree']);
const CLUSTER_HEADS: ReadonlySet<string> = new Set(['addV', 'addE', 'mergeV', 'mergeE']);
const CLUSTER_MEMBERS: ReadonlySet<string> = new Set(['property', 'from', 'to', 'option']);
/** Is `chain[at]` a write's cluster — its head, or a modulator-named step reaching one leftwards? */
function inCluster(chain: readonly IRStep[], at: number): boolean {
  let head = at;
  while (head >= 0 && CLUSTER_MEMBERS.has(chain[head]!.name)) head--;
  return head >= 0 && CLUSTER_HEADS.has(chain[head]!.name);
}

/** Is `step` an always-bound one-to-one map by the predictor (`getStepOutputArity`) — a member of
 *  `DEFINITELY_SINGULAR`, a `ReducingBarrierStep` where `reducing`, or a `map()` whose body is itself
 *  always bound (`getOutputArityBehaviorForTraversalMapStep`)? An unlisted step is `MULTI`. */
function definitelySingular(step: Step, reducing: boolean): boolean {
  if (isLocalScope(step as IRStep)) return ONE_TO_ONE_LOCAL.has(step.name);
  if (reducing && REDUCING.has(step.name)) return true;
  if (step.name === 'constant') return !(step.args ?? []).some((a) => isNested(a.value));
  if (step.name === 'sack') return !(step.args ?? []).length;
  if (step.name === 'map') return mapBodyAlwaysBound(step);
  return ONE_TO_ONE.has(step.name);
}

/** `map(body)` — a `TraversalMapStep`, always bound iff every step of its body is (the predictor's arity
 *  over the child, `StepOutputArityPredictor.java`'s `getOutputArity(Traversal)`). Unreadable is not. */
function mapBodyAlwaysBound(step: Step): boolean {
  const args = step.args ?? [];
  if (args.length !== 1 || !isNested(args[0]!.value)) return false;
  let body: readonly Step[];
  try { body = stepChain(args[0]!.value.nested, {}); } catch { return false; }
  return body.length > 0 && body.every((s) => s.name === 'by' || definitelySingular(s, true));
}

/** Can the slice cross `chain[index]`? Never the chain's source (a `GraphStep`, `InjectStep` or
 *  `AddVertexStartStep`, none a `MapStep`), never a `to(Direction)` movement, and never a modulated
 *  `path()` (its `by()`s may be unproductive, so not always bound). */
function movable(chain: readonly IRStep[], index: number): boolean {
  const step = chain[index]!;
  // A step `inlineIdentityHostBody` spliced out of a `local`/`map`/`flatMap` is, to the strategy, still
  // its host — a `LocalStep` (an `AbstractStep`) or a `TraversalFlatMapStep`, never crossed
  // (`g.V().local(__.sideEffect(…)).limit(1)` runs the body for two starts in the reference, not one), or
  // a `TraversalMapStep`, crossed only when its body is always bound: of the bodies the splice takes,
  // the all-`identity()` one. The host's name rides on the body's LAST step; its body is the run of
  // unmarked spliced steps before it.
  if (step.perTraverser) {
    if (step.splicedHost !== 'map' || step.name !== 'identity') return false;
    for (let i = index - 1; i >= 0 && chain[i]!.perTraverser && !chain[i]!.splicedHost; i--)
      if (chain[i]!.name !== 'identity' && chain[i]!.name !== 'by') return false;
    return true;
  }
  if (index === 0 && (step.name === 'addV' || step.name === 'addE')) return false;
  if (step.name === 'to' || step.name === 'from') return step.args.length === 1 && !isDirectionArg(step.args[0]!.value);
  if (step.name === 'path') return !step.modulators?.length && step.from === undefined && step.to === undefined;
  return SIDE_EFFECTS.has(step.name) || definitelySingular(step, false);
}
