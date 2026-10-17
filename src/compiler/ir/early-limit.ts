import { isDirectionArg, isNested } from '../../gremlin/frontend.ts';
import { isLocalScope, SLICE_STEPS, type IRStep } from './step.ts';

/**
 * TINKERPOP'S `EarlyLimitStrategy`, for the windows where it changes WHAT HAPPENS — a slice moved left past
 * a side effect.
 *
 * `EarlyLimitStrategy` is a DEFAULT optimization (`TraversalStrategies.java:277`) that moves every
 * `RangeGlobalStepContract` (`limit`/`range`/`skip`) LEFT past each step that is a `SideEffectStep` or a
 * `MapStep` with an always-bound result, to just after the last step before it that is neither
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/EarlyLimitStrategy.java`
 * `apply`/`isMapStepMovable`; the always-bound classes are
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/util/StepOutputArityPredictor.java`'s
 * `STEP_CLASSES_WITH_DEFINITELY_SINGULAR_ARITY_BEHAVIOR`, plus `EdgeVertexStep` for a one-sided direction).
 * Over a run of PURE one-to-one steps the move changes nothing observable, which is why it is otherwise a
 * no-op here. Over a SIDE EFFECT it is the answer: `g.V().property('x',1).limit(1)` is
 * `g.V().limit(1).property('x',1)` in the reference, so `x` lands on ONE vertex — where a plan that writes
 * for every traverser and then slices writes all six. So this rewrite moves a slice exactly as the strategy
 * does, and only where the run it crosses holds a `SideEffectStep` (`SIDE_EFFECTS`): moving it past pure
 * steps would only perturb plans.
 *
 * A KEYED `groupCount('a')`/`group('a')`/`tree('a')`/`subgraph('a')` is NOT crossed: at the pin those are
 * `SideEffectBarrierStep`s (`…/step/sideEffect/SideEffectBarrierStep.java` — an `AbstractStep` and a
 * `LocalBarrier`, neither a `SideEffectStep` nor a `MapStep`), so the strategy takes one as its
 * `insertAfter`, and its `processAllStarts` reads the whole input before the slice sees anything:
 * `g.V().groupCount('a').by(label).limit(1).cap('a')` counts all six (`GroupCount.feature`
 * `g_V_groupCountXaX_selectXaX_countXlocalX` pins that barrier behaviour).
 *
 * What it moves past is a SUBSET of what the strategy moves past (`movable`), never more — crossing a step
 * the strategy stops at would cut side effects the reference performs. A slice it does not move and that
 * still trails a side effect is the lowering's to decline (`ProgramWrites.truncated`, `rel/write.ts`).
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
    let start = at, effect = false;
    while (start > 0 && movable(out[start - 1]!, start - 1)) {
      effect ||= SIDE_EFFECTS.has(out[start - 1]!.name);
      start--;
    }
    // Nothing crossed but pure steps; or the run reached the chain's start (no `insertAfter`).
    if (start === at || !effect || start === 0) continue;
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
 *  `TraversalSideEffectStep` — and the two creations, `AddVertexStep`/`AddEdgeStep` (always-bound maps with
 *  an effect). */
const SIDE_EFFECTS: ReadonlySet<string> = new Set(['property', 'addLabel', 'dropLabel', 'dropLabels', 'sideEffect', 'addV', 'addE']);

/** The always-bound `MapStep`s crossed (`StepOutputArityPredictor`): `IdentityStep`, `IdStep`, `LabelStep`,
 *  `ConstantStep`, `PropertyKeyStep`, `PropertyValueStep`, `PathStep`, `ElementMapStep`, `PropertyMapStep`,
 *  `MathStep`, and `EdgeVertexStep` one-sided (`inV`/`outV`) or `EdgeOtherVertexStep` — plus `as()`, which
 *  is a label on the step before, not a step. */
const ONE_TO_ONE: ReadonlySet<string> = new Set([
  'as', 'identity', 'id', 'label', 'constant', 'key', 'value', 'path', 'elementMap', 'valueMap', 'propertyMap', 'math', 'inV', 'outV', 'otherV',
]);
const CLUSTER_HEADS: ReadonlySet<string> = new Set(['addV', 'addE', 'mergeV', 'mergeE']);
const CLUSTER_MEMBERS: ReadonlySet<string> = new Set(['property', 'from', 'to', 'option']);
/** Is `chain[at]` a write's cluster — its head, or a modulator-named step reaching one leftwards? */
function inCluster(chain: readonly IRStep[], at: number): boolean {
  let head = at;
  while (head >= 0 && CLUSTER_MEMBERS.has(chain[head]!.name)) head--;
  return head >= 0 && CLUSTER_HEADS.has(chain[head]!.name);
}

/** Can the slice cross `step` (at `index` of its chain)? Never the chain's source (a `GraphStep`,
 *  `InjectStep` or `AddVertexStartStep`, none a `MapStep`), never a `to(Direction)` movement, and
 *  never a modulated `path()` (its `by()`s may be unproductive, so not always bound). */
function movable(step: IRStep, index: number): boolean {
  if (index === 0 && (step.name === 'addV' || step.name === 'addE')) return false;
  if (step.name === 'to' || step.name === 'from') return step.args.length === 1 && !isDirectionArg(step.args[0]!.value);
  if (step.name === 'path') return !step.modulators?.length && step.from === undefined && step.to === undefined;
  if (step.name === 'constant') return !step.args.some((a) => isNested(a.value));
  return SIDE_EFFECTS.has(step.name) || ONE_TO_ONE.has(step.name);
}
