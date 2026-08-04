import type { Spine } from '../../sql/kernel/render.ts';
import type { CompileOptions } from './fast-paths.ts';

/**
 * THE DIFFERENTIAL SWITCH — `RelIR on` versus `RelIR off` (§10·4).
 *
 * A traversal the RelIR lowering covers routes there; with the switch off it routes to the legacy
 * spine instead. That makes the whole 2,298-traversal corpus, the L1–L5 ladder AND the census the
 * oracle for every coverage increment, which is strictly stronger than the eleven hand-built
 * families of §5a's gate and costs nothing to run — the instrument already exists, twice over.
 *
 * **It is a HARNESS with an end date, and this module is scheduled for deletion with it.** When
 * coverage reaches 100% and §8's list is empty, the legacy spine goes and the differential's off
 * position goes with it. That is a deliberate, accepted, one-time trade at the point where the
 * thing being compared against is dead code (§10·4·5): nobody may cite "we would lose the
 * differential" as a reason to keep two engines alive.
 *
 * An ENV switch rather than a plumbed parameter, deliberately, and for `test:perturbed`'s reason:
 * the suite under test must not be able to see which position it is in. A `CompileOptions` field
 * exists beside it so an individual test can pin one side without moving the process-wide default —
 * the explicit field wins, exactly as `options.fastPaths` beats the ambient config.
 */
const RELIR_ENV = 'MOGWAI_RELIR';

/** Default ON. A route that is off by default is a route nothing exercises, and an unexercised
 *  second spine is the failure mode §10·4 exists to prevent — not a safety measure. */
const relirEnabled = (): boolean => process.env[RELIR_ENV] !== '0';

/** THE AMBIENT position of the switch — the whole PROCESS's default spine, for a harness or an
 *  instrument that must know which position a RUN is in (§14: L3's two floors). A per-compile
 *  decision goes through `resolveSpine`, where an explicit `options.spine` still wins; this is the
 *  only reader of the env var, so a run cannot disagree with itself about which spine it is. */
export const ambientSpine = (): Spine => (relirEnabled() ? 'rel' : 'legacy');

export const resolveSpine = (options?: CompileOptions): Spine =>
  (options?.spine ?? ambientSpine());
