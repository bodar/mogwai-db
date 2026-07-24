import type { StrategyUse } from '../../gremlin/frontend.ts';
import type { PStep } from './strategies.ts';

// ---------- the Pass contract (Layer A + B: rewrite the chain) ----------
//
// ONE shape for every Step[]→Step[] transform the compiler applies before lowering — the
// internal normalization folds (repeat/by/choose/callWith clustering, provable no-op removals)
// AND the external withStrategies application (Subgraph/Partition injection, verification). Both
// were previously two hand-sequenced mechanisms in strategies.ts under a comment apologising that
// they merely "share a name". They share a CONTRACT: a categorized, ordered rewrite. This mirrors
// TinkerPop's own TraversalStrategy category model (Decoration/Optimization/…/Verification applied
// in a fixed topological order), scoped to what a SQL provider does.
//
// `run` is the only verb — a Pass rewrites the chain, or (verify category) asserts and throws. It
// never annotates (that is ChainFacts, ir/analyze.ts) and never selects SQL (that is the fast-path
// layer). Adding a rewrite = add a Pass to the right category group in passes.ts; the old if/else
// ladder (applyStrategies) and inside-out nesting (normalize) both dissolve into declared members.

/** Fixed topological order — lower ordinal runs first. The ordinal is the ONLY thing that fixes
 *  cross-category order; ties within a category are broken by declaration position in that
 *  category's own array (see passes.ts assembly). */
export const PASS_CATEGORIES = ['extract', 'fold', 'decoration', 'simplify', 'verify'] as const;
export type PassCategory = typeof PASS_CATEGORIES[number];
// extract    — stripTerminal: pull out-of-band flags (discard). Runs first.
// fold       — repeat/by/choose/callWith clustering: canonicalize multi-step shapes.
// decoration — Subgraph/Partition/ProductiveBy: inject filters/stamps (external, config-driven).
// simplify   — dropRedundantOrder/collapseFoldCountLocal: provable no-op removals.
// verify     — ReadOnly/EdgeLabel/ReservedKeys: assert legality, throw. Runs LAST.

/** Per-compile state a Pass reads/writes. NOT a DI scope (nothing here is ambient infra shared
 *  across compiles) — a one-shot data bag threaded by value through the fold, exactly as Carry is
 *  for the lowering half. Built once per compilePlan() call. */
export interface PassContext {
  readonly params: Record<string, any>;
  /** Parsed withStrategies/withoutStrategies specs, already filtered: withoutStrategies-suppressed
   *  and no-op strategies are removed before the pipeline runs, so a decoration/verify Pass's
   *  `applies` only ever asks "is this strategy named", never re-litigates suppression. */
  readonly strategies: StrategyUse;
  /** The chain AFTER `fold` but BEFORE any `decoration` pass ran — i.e. the user's own authored
   *  chain, canonicalised but not yet injected. Verify passes assert legality against THIS, never
   *  the live (possibly decoration-injected) `steps`: a PartitionStrategy write-stamp
   *  (property(key,val) after addV) must not trip ReservedKeysVerificationStrategy, and an exploded
   *  out()→outE().inV() must not change what EdgeLabelVerification sees. Written once by the driver
   *  at the fold→decoration boundary; passes never write it. */
  originalChain: readonly PStep[];
  /** Out-of-band results a pass may set. Mutable bag, written only by the `extract` category
   *  (stripTerminal's discard flag → the iterate() "run for effect, return nothing" shape). */
  readonly out: { discard: boolean };
}

export interface Pass {
  readonly name: string;
  readonly category: PassCategory;
  /** Cheap gate: skip `run` when this chain can't contain the pass's trigger. Absent → always
   *  runs. For a decoration/verify Pass this reads ctx.strategies (an O(1)-ish name lookup), NOT
   *  the chain — keeping the pipeline O(passes), not O(passes·rescans). */
  applies?(steps: readonly PStep[], ctx: PassContext): boolean;
  /** The rewrite. Pure w.r.t. `steps`; may read/write ctx.out. A verify-category pass ignores its
   *  `steps` argument (it asserts against ctx.originalChain instead) and returns it unchanged —
   *  verify never rewrites. */
  run(steps: PStep[], ctx: PassContext): PStep[];
}
