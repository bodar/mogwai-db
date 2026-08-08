import type { Spine } from '../../sql/kernel/render.ts';
import type { CompileOptions } from './fast-paths.ts';

/**
 * THE SPINE SWITCH — three positions, and the third measures something the first two cannot.
 *
 * A traversal the RelIR lowering covers routes there; anything else falls through to the legacy
 * spine WHOLE. That makes the whole 2,298-traversal corpus, the L1–L5 ladder AND the census the
 * oracle for every coverage increment, which is strictly stronger than the eleven hand-built
 * families of §5a's gate and costs nothing to run — the instrument already exists, twice over.
 *
 * | position | env | RelIR tried? | legacy reachable? | answers |
 * |---|---|---|---|---|
 * | `rel`      | (default) | yes | **yes** — fallback | the DIFFERENTIAL, and production |
 * | `legacy`   | `0`       | no  | yes                | the DIFFERENTIAL's other side |
 * | `rel-only` | `only`    | yes | **no** — throws    | **the CUT** — what deleting legacy costs |
 *
 * ⚠️ **`rel` and `legacy` measure the DIFFERENTIAL, never the CUT, and the distinction has no
 * proxy** (plan §6·1). BOTH may fall back to legacy, so the `legacySpine` L3 floor proves only
 * *routed ≥ all-legacy* — it cannot say what is lost by deleting the route, because every run that
 * produced it still had the route. `rel-only` is the position that can: a RelIR decline FAILS
 * instead of falling through, so an L3 run against it counts exactly the scenarios legacy is still
 * answering. It is plan §Phase 3's leading item and the countdown to Phase 4.
 *
 * It is Phase 1's rule generalized from `routeWrite` to the whole legacy route — **"MEASURE BY
 * TURNING THE ROUTE OFF, NEVER BY READING THE CODE"** — whose first run refuted the prose it
 * replaced (`labels()`, a READ, was holding the entire label-write family).
 *
 * ⚠️ Read its output through §6·6: it measures the ROUTE, so a shape the algebra EXPRESSES but
 * nothing HANDS it reads identically to a missing lowering. A scenario it names is a QUESTION —
 * "why did nothing offer this to RelIR" — before it is a missing lowering.
 *
 * **All three are a HARNESS with an end date, and this module is scheduled for deletion with them.**
 * The end date is NOT coverage reaching 100% — that was the old exit criterion and §8 measures why
 * it was the wrong one. The spine goes when the import graph into `steps/` is severed and `repeat()`
 * works (§6·1); whatever legacy still answered that day becomes a clear deferral. The differential
 * is cut PER PHASE with the code it compares, not kept whole until the last commit: nobody may cite
 * "we would lose the differential" as a reason to keep a route whose code is already deleted.
 *
 * An ENV switch rather than a plumbed parameter, deliberately, and for `test:perturbed`'s reason:
 * the suite under test must not be able to see which position it is in. A `CompileOptions` field
 * exists beside it so an individual test can pin one position without moving the process-wide
 * default — the explicit field wins, exactly as `options.fastPaths` beats the ambient config.
 */
const RELIR_ENV = 'MOGWAI_RELIR';

/**
 * WHICH POSITION the switch is in — the three-valued fact, distinct from `Spine`.
 *
 * `Spine` names which lowering PRODUCED a compile and stays two-valued for that reason; a plan is
 * never produced "by rel-only", it is produced by RelIR or the compile raised. Keeping them apart is
 * what lets `Compiled.spine` stay a compile FACT while this stays a route POLICY.
 */
export type SpinePosition = Spine | 'rel-only';

/** Default ON. A route that is off by default is a route nothing exercises, and an unexercised
 *  second spine is the failure mode §6·1 exists to prevent — not a safety measure. An unrecognized
 *  value reads as the default rather than throwing: this is a measurement knob, and a typo that
 *  silently ran the DEFAULT position is visible in the printed label every consumer already emits. */
const positionOf = (raw: string | undefined): SpinePosition =>
  raw === '0' ? 'legacy' : raw === 'only' ? 'rel-only' : 'rel';

/** THE AMBIENT position of the switch — the whole PROCESS's default, for a harness or an instrument
 *  that must know which position a RUN is in (L3's two floors, and its third un-floored run). A
 *  per-compile decision goes through `resolveSpine`, where an explicit `options.spine` still wins;
 *  this is the only reader of the env var, so a run cannot disagree with itself about where it is. */
export const ambientPosition = (): SpinePosition => positionOf(process.env[RELIR_ENV]);

/** The ambient position as a SPINE — `rel-only` is RelIR, it just has nowhere to fall back to. The
 *  differential's two-sided consumers (`relirOff`, L3's floor selection) want this, not the position. */
export const ambientSpine = (): Spine => (ambientPosition() === 'legacy' ? 'legacy' : 'rel');

export const resolveSpine = (options?: CompileOptions): SpinePosition =>
  (options?.spine ?? ambientPosition());

/** May the router fall through to legacy when RelIR declines? False only under `rel-only`. */
export const legacyReachable = (position: SpinePosition): boolean => position !== 'rel-only';

/**
 * The `rel-only` refusal — RelIR declined and the measurement position forbids the fallback.
 *
 * A distinct class rather than a message match, for §6·5's reason: the question a catch site asks is
 * WHO OWES THE ANSWER. This one is owed by nobody — it is the harness reporting that legacy is still
 * carrying this traversal, so no decline handler may swallow it as "not learned yet".
 */
export class LegacyRouteRequired extends Error {
  constructor() {
    super('RelIR declined and MOGWAI_RELIR=only forbids the legacy fallback — this traversal is still '
      + 'carried by the legacy route (run `mise run rel-blockers` for the step that stops it)');
    this.name = 'LegacyRouteRequired';
  }
}
