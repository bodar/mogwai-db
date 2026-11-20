import { arg, isOrderArg } from '../../gremlin/frontend.ts';
import { countOf, isLocalScope, sliceOf, SLICE_STEPS, type IRStep } from './step.ts';

/**
 * A UNIFORM SHUFFLE CUT TO ONE IS `sample(1)` — `order().by(shuffle).limit(1)` (and `range(0,1)`,
 * `tail(1)`, a parameterised `limit($x)` with `$x = 1`) rewritten to the one step that SAYS "a uniform
 * pick", so every lowering that draws per origin (`reSourcedOnce`'s `drawIndex`) serves it with no lowering
 * of its own.
 *
 * WHY it is the same question: `Order.shuffle` sorts by nothing and answers with `traverserSet.shuffle`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/OrderGlobalStep.java:76`),
 * a uniform permutation; its first member — or, by symmetry, its LAST (`tail(1)`) — is a uniform pick of
 * one traverser, which is what `SampleGlobalStep` draws
 * (`.../step/filter/SampleGlobalStep.java`). A cut of SEVERAL is not: the shuffle emits its picks in
 * shuffled order where `sample(n)` keeps input order, so for `n ≠ 1` order is part of the answer and the
 * chain is left alone. So is `order(local)` (a map over a collection, not a stream) and a by() that is not
 * a sole bare `shuffle` (a key before it orders, and a key after it breaks only the ties).
 *
 * The window is read through `sliceOf`/`countOf` — the one slice authority — so a GValue bound is its
 * value here and the minted `sample(1)` is a constant: reducing it spends no bind, as `unrollFixedRepeat`
 * reduces a counted `until`. TinkerPop's own `OrderLimitStrategy` sits at this same stage.
 *
 * Bulk: a uniform pick from a stream holding a traverser three times picks it with weight 3 — what an
 * un-bulked stream does and what `sample(1)` does. Java's `TraverserSet.shuffle` picks among BULKED
 * entries, a merge artefact not emulated (`docs/feature-support-matrix.md` §17).
 *
 * Labels: an `as()` between the order and the cut, or after the cut, names the same traverser (both steps
 * keep the path entry), so they ride after the minted `sample(1)` in their written order.
 *
 * Runs per chain; every nested body is normalized through the same pipeline when it is lowered
 * (`childSteps`), so the rewrite reaches every depth without a walk of its own.
 */
export function shuffleCutToSample(steps: IRStep[]): IRStep[] {
  let out: IRStep[] | null = null;
  for (let i = 0; i < steps.length; i++) {
    const order = steps[i]!;
    if (!isShuffleOrder(order)) { out?.push(order); continue; }
    let j = i + 1;
    while (j < steps.length && steps[j]!.name === 'as') j++;
    const cut = steps[j];
    if (!cut || !cutsToOne(cut)) { out?.push(order); continue; }
    out ??= steps.slice(0, i);
    out.push({ ...cut, name: 'sample', args: [arg(1, 'int')] }, ...steps.slice(i + 1, j));
    i = j;
  }
  return out ?? steps;
}

/** A GLOBAL `order()` whose sole comparator is a bare `by(shuffle)`. */
const isShuffleOrder = (step: IRStep): boolean => {
  if (step.name !== 'order' || isLocalScope(step)) return false;
  const bys = step.modulators ?? [];
  return bys.length === 1 && bys[0]!.length === 1 && isOrderArg(bys[0]![0]) && bys[0]![0].order === 'shuffle';
};

/** A GLOBAL cut whose window is exactly the first (or, for `tail`, the last) one. A count the slice
 *  authority refuses (an illegal range, a non-long) is left for the lowering to raise as it always has. */
const cutsToOne = (step: IRStep): boolean => {
  if (isLocalScope(step)) return false;
  try {
    if (step.name === 'tail') return countOf(step) === 1;
    if (!SLICE_STEPS.has(step.name)) return false;
    const window = sliceOf(step);
    return window.offset === 0 && window.limit === 1;
  } catch {
    return false;
  }
};
