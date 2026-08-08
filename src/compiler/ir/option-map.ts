import { argValues, isNested, isPickArg } from '../../gremlin/frontend.ts';
import type { IRStep } from './step.ts';

/**
 * THE OPTION-MAP `choose()` DECODE — `choose(<key>).option(k, body)…`, read once for both spines.
 *
 * A total decode of one step's arguments, which is what `ir/step.ts` already holds for `sliceOf` and
 * the `typeOf` assert family (§6·4's kernel rule, and the reason Phase 0 moved those). It lives in
 * its own leaf rather than beside them for one reason: it needs a body NORMALIZER, and the two spines
 * cannot share one — legacy calls `childSteps` bare, while RelIR must go through the child seam
 * because normalizing re-runs the Pass pipeline and can legitimately RAISE where its contract is
 * `null` (§6·6). So the normalizer is a parameter, exactly as `math`'s ops record is.
 *
 * ## The two IMPLICIT arms, which are the whole difficulty
 *
 * Neither is written down, and both change what the merge is:
 *
 * - **no `Pick.none`** (or no `Pick.unproductive`) → an input the written arms do not claim emits the
 *   TRAVERSER itself. TinkerPop's `ChooseStep` private constructor installs identity traversals for
 *   BOTH tokens (`gremlin-core/.../branch/ChooseStep.java:65-81`), so the pass-through is the
 *   reference's default rather than an inference. A consumer derives it from which arms it BUILT
 *   rather than from which tokens were written — that is one statement instead of two that can drift,
 *   and it stays right when a `discard` body claims an arm and then drops its rows.
 * - **a `__.discard()` body** drops its rows, so it contributes NO arm even though one is written.
 *
 * ## Why `none` and `unproductive` may never be conflated
 *
 * `Pick.none` claims a productive choice that matched no key; `Pick.unproductive` claims a choice
 * that produced NOTHING. `TraversalProduct` is explicit that a productive null is a value, so the two
 * are distinguishable only where the producer reports productivity SEPARATELY from the value — which
 * is what `ChildValue.present` carries and what legacy computes as its modulation `present` column.
 * A consumer without that signal must decline the forms that need it, never guess from a NULL.
 */

/** Which arm an `option()` key selects. */
export type OptionPick = 'key' | 'none' | 'unproductive';

export interface OptionArm {
  /** The matched value, or `undefined` for the two `Pick` arms. */
  readonly key: unknown;
  readonly nested: unknown;
  readonly pick: OptionPick;
  /** A `__.discard()` body: those rows are dropped, so this option contributes no merge arm. */
  readonly discard: boolean;
}

/** Normalize a nested argument to a body, or `null` where normalizing RAISES. Each spine supplies its
 *  own — see the module note for why this cannot be one shared call. */
export type BodyOf = (nested: unknown) => readonly IRStep[] | null;

/**
 * Read an option-map choose's arms in declaration order, or `null` for a form outside the vocabulary
 * (`Pick.any`, a bodyless option, no keyed option at all, or a body that will not normalize).
 *
 * FIRST WINS per `Pick` token: TinkerPop takes the first `Pick.none`/`Pick.unproductive` and ignores
 * later duplicates, which is what makes the corpus's trailing `option(Pick.none, __.fail())`
 * unreachable rather than a wall.
 */
export function optionArms(step: IRStep, body: BodyOf): OptionArm[] | null {
  const out: OptionArm[] = [];
  const seen = new Set<OptionPick>();
  for (const opt of step.optionArms ?? []) {
    const bodyArg = argValues(opt).find(isNested);
    if (!bodyArg) return null;
    const keyArg = argValues(opt).find((x: unknown) => x !== bodyArg);
    const token = isPickArg(keyArg) ? keyArg.pick : undefined;
    if (token !== undefined && token !== 'none' && token !== 'unproductive') return null; // Pick.any
    const pick: OptionPick = keyArg === undefined ? 'none' : token ?? 'key';
    if (pick !== 'key') {
      if (seen.has(pick)) continue; // first wins
      seen.add(pick);
    }
    const steps = body(bodyArg.nested);
    if (!steps) return null;
    out.push({
      key: pick === 'key' ? keyArg : undefined,
      nested: bodyArg.nested,
      pick,
      discard: steps.length === 1 && steps[0]!.name === 'discard',
    });
  }
  return out.some((arm) => arm.pick === 'key') ? out : null;
}
