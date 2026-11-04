import { isNested, isPickArg } from '../../gremlin/frontend.ts';
import type { IRStep } from './step.ts';
import type { TypeNode } from '../../gremlin/types.ts';

/**
 * THE KEYED-OPTION DECODE — `choose(<key>).option(k, body)…` and `branch(<key>).option(k, body)…`, read once.
 *
 * A total decode of one step's arguments, which is what `ir/step.ts` already holds for `sliceOf` and
 * the `typeOf` assert family (§6·4's kernel rule, and the reason Phase 0 moved those). It lives in
 * its own leaf rather than beside them for one reason: it needs a body NORMALIZER, supplied as a
 * parameter — normalizing re-runs the Pass pipeline and can legitimately RAISE where the lowering's
 * contract is `null` (§6·6). So the normalizer is a parameter, exactly as `math`'s ops record is.
 *
 * ## The two IMPLICIT arms, which are the whole difficulty
 *
 * Neither is written down, and both change what the merge is:
 *
 * - **no `Pick.none`** (or no `Pick.unproductive`) on a `choose()` → an input the written arms do not
 *   claim emits the TRAVERSER itself. TinkerPop's `ChooseStep` private constructor installs identity
 *   traversals for BOTH tokens (`gremlin-core/.../branch/ChooseStep.java:65-81`), so the pass-through is
 *   the reference's default rather than an inference. A consumer derives it from which arms it BUILT
 *   rather than from which tokens were written — that is one statement instead of two that can drift,
 *   and it stays right when a `discard` body claims an arm and then drops its rows. A `branch()`
 *   installs no default (`MatchPolicy.implicitPassThrough`).
 * - **a `__.discard()` body** drops its rows, so it contributes NO arm even though one is written.
 *
 * ## Why `none` and `unproductive` may never be conflated
 *
 * `Pick.none` claims a productive choice that matched no key; `Pick.unproductive` claims a choice
 * that produced NOTHING. `TraversalProduct` is explicit that a productive null is a value, so the two
 * are distinguishable only where the producer reports productivity SEPARATELY from the value — which
 * is what `ChildValue.present` carries. A consumer without that signal must decline the forms that
 * need it, never guess from a NULL.
 */

/** Which arm an `option()` key selects. `any` is `branch()`'s alone — `ChooseStep.addChildOption` refuses
 *  it (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/ChooseStep.java:107-108`). */
export type OptionPick = 'key' | 'none' | 'unproductive' | 'any';

/**
 * HOW A KEYED-OPTION STEP ROUTES A TRAVERSER — the one axis `choose()` and `branch()` differ on, and the
 * whole of it. Both are `BranchStep`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java:162-220`):
 * a choice is computed once per start, every option whose key admits it is collected (`pickBranches`),
 * `Pick.none` takes a start no key admitted — and an UNPRODUCTIVE one where no `Pick.unproductive` is
 * written, because `pickBranches(Pick.unproductive)` finds no list and falls to `Pick.none` — and
 * `Pick.any` takes EVERY start, unproductive ones included (`choice != Pick.any` holds for them).
 * `ChooseStep` changes exactly three things, and each is a field here:
 *
 * - `pick` — `'first'`: `ChooseStep.pickBranches` keeps `subList(0, 1)` (`ChooseStep.java:139-142`), so the
 *   first admitting option wins, and a REPEATED `Pick` token keeps its first spelling
 *   (`ChooseStep.java:112-122`). `'all'`: every admitting option runs, a repeated key or token included.
 * - `implicitPassThrough` — `ChooseStep`'s constructor installs identity traversals for `Pick.none` and
 *   `Pick.unproductive` (`ChooseStep.java:65-81`); a bare `BranchStep` installs nothing, so a start no
 *   option claims is DROPPED.
 * - `any` — whether `Pick.any` and a TRAVERSAL key are admitted at all. `ChooseStep` raises on both
 *   (`ChooseStep.java:107-108,124-129`); `verifyChooseOptionKeys` (`ir/strategies.ts`) raises the reference
 *   text before the lowering, so this decode never meets them on a `choose()`.
 */
export interface MatchPolicy {
  readonly pick: 'first' | 'all';
  readonly implicitPassThrough: boolean;
  readonly any: boolean;
}
export const CHOOSE_MATCH: MatchPolicy = { pick: 'first', implicitPassThrough: true, any: false };
export const BRANCH_MATCH: MatchPolicy = { pick: 'all', implicitPassThrough: false, any: true };

export interface OptionArm {
  /** The matched value, or `undefined` for the `Pick` arms. A TRAVERSAL key (`branch()` only) is its
   *  `{nested}` argument — it admits a choice it PRODUCES from (`TraversalUtil.test`, called by
   *  `BranchStep.pickBranches`). */
  readonly key: unknown;
  /** The key's declared type — a `9007199254740992.0d` key is a Double, which the comparison reads. */
  readonly keyType: TypeNode | null;
  readonly nested: unknown;
  readonly pick: OptionPick;
  /** A `__.discard()` body: those rows are dropped, so this option contributes no merge arm. */
  readonly discard: boolean;
}

/** Normalize a nested argument to a body, or `null` where normalizing RAISES. The caller supplies it
 *  — see the module note for why the normalizer is a parameter. */
export type BodyOf = (nested: unknown) => readonly IRStep[] | null;

/**
 * Read a keyed-option step's arms in declaration order under its `MatchPolicy`, or `null` for a form
 * outside the vocabulary (a bodyless option, a `choose()` with no keyed option, a `Pick.any` or a
 * traversal key the policy refuses, or a body that will not normalize).
 *
 * The BODY is the option's LAST argument — `option(key, body)`, or `option(body)` for `Pick.any`. Taking
 * the first nested argument would read a traversal KEY as the body.
 *
 * Under `'first'`, FIRST WINS per `Pick` token: TinkerPop takes the first `Pick.none`/`Pick.unproductive`
 * and ignores later duplicates, which is what makes the corpus's trailing `option(Pick.none, __.fail())`
 * unreachable rather than a wall. Under `'all'` every spelling is an arm.
 */
export function optionArms(step: IRStep, body: BodyOf, policy: MatchPolicy = CHOOSE_MATCH): OptionArm[] | null {
  const out: OptionArm[] = [];
  const seen = new Set<OptionPick>();
  for (const opt of step.optionArms ?? []) {
    const bodyArg = opt.args[opt.args.length - 1]?.value;
    if (!bodyArg || !isNested(bodyArg)) return null;
    const keyEntry = opt.args.length > 1 ? opt.args[0] : undefined;
    const keyArg = keyEntry?.value;
    // A one-argument `option(body)` IS `Pick.any` (`GraphTraversal.option(Traversal)`, `GraphTraversal.java:4979-4982`).
    const token = keyEntry === undefined ? 'any' : isPickArg(keyArg) ? keyArg.pick : undefined;
    if (token !== undefined && token !== 'none' && token !== 'unproductive' && token !== 'any') return null;
    if ((token === 'any' || isNested(keyArg)) && !policy.any) return null;
    const pick: OptionPick = token ?? 'key';
    if (pick !== 'key' && policy.pick === 'first') {
      if (seen.has(pick)) continue; // first wins
      seen.add(pick);
    }
    const steps = body(bodyArg.nested);
    if (!steps) return null;
    out.push({
      key: pick === 'key' ? keyArg : undefined,
      keyType: pick === 'key' ? keyEntry?.type ?? null : null,
      nested: bodyArg.nested,
      pick,
      discard: steps.length === 1 && steps[0]!.name === 'discard',
    });
  }
  return policy.pick === 'all' ? (out.length ? out : null) : out.some((arm) => arm.pick === 'key') ? out : null;
}
