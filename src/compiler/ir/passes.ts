import { isNested, stepChain, type Step, type StrategyUse } from '../../gremlin/frontend.ts';
import { PASS_CATEGORIES, type Pass, type PassCategory, type PassContext } from './pass.ts';
import {
    stripTerminal, desugarMatchString, desugarPropertyMap, formRepeatRegions, unrollFixedRepeat, absorbModulators, absorbOptionArms, absorbCallWith, desugarIo,
    canonicalizeConnectives, foldConstantPredicateOperands, rewriteWhereEndLabels,
    verifyStandard, verifyByModulatorArity,
    absorbValueMapWith, collapseFoldCountLocal, dropRedundantOrder,
    injectSubgraphRec, injectPartitionRec, markProductiveBy, isAlwaysProductiveFilterNoOp, verify,
    NO_OP_STRATEGIES, ALWAYS_ON_STRATEGIES, VERIFICATION_STRATEGIES, rejectMsg,
    type IRStep,
} from './strategies.ts';
import { verifyWriteArgs } from './write-args.ts';

// ---------- the Pass pipeline: the concrete PASSES array + the driver ----------
//
// PASSES is one flat, ordered array assembled by concatenating per-category groups in
// PASS_CATEGORIES order — the "register in a Map/array, don't grow a switch" law applied to the
// rewrite layer. `runPasses` folds it over the chain, replacing the inside-out normalize() nesting
// (and, from Stage 2 on, applyStrategies too). Adding a rewrite = append a Pass to the right group.

/**
 * Build the Pass members of one category.
 *
 * Passes are CONSTRUCTED rather than written as object literals so **the category is stated once,
 * by the group**. A literal repeating `category: 'verify'` can disagree with the array it sits in;
 * the ordering test would catch the ordering consequence but not the mislabel itself. Here the
 * group supplies it and the disagreement is unrepresentable.
 *
 * A run whose body is REAL LOGIC (rather than a one-line delegation to an already-named helper) is
 * written as a `function name(...)` declaration, not an arrow. That is not style: an arrow assigned
 * to an object-literal property is anonymous to STATIC analysis, and
 * `textDocument/prepareCallHierarchy` returns nothing for it — measured on this file. A named
 * declaration is what lets a call-hierarchy walk confirm a Pass never reaches ChainFacts or the
 * fast-path layer (the `Never` column of the role table in ../CLAUDE.md). A one-line delegation
 * needs no name of its own: the call to the real helper is what a walk follows anyway.
 *
 * `applies` stays optional and keeps its meaning: absent → always runs.
 */
const group = (
  category: PassCategory,
  members: Array<{
    name: string;
    applies?: (steps: readonly IRStep[], ctx: PassContext) => boolean;
    run: (steps: IRStep[], ctx: PassContext) => IRStep[];
  }>,
): Pass[] => members.map(({ name, applies, run }) =>
  applies ? { name, category, applies, run } : { name, category, run });

// ---------- extract (out-of-band flags; runs first) ----------
const EXTRACT: Pass[] = group('extract', [
  {
    name: 'stripTerminal',
    run: function stripTerminalPass(steps, ctx) {
      const r = stripTerminal(steps);
      ctx.out.discard = r.discard;
      return r.steps as IRStep[];
    },
  },
  // AFTER stripTerminal, and before everything else. Both halves matter:
  //   · after — stripTerminal removes an out-of-band terminal FLAG (discard/none), which is not a
  //     real step, so running second lets the desugar see the chain's true end. It needs that to
  //     decide whether the match() is terminal (and so whether to project the binding map).
  //   · before decoration — it mints pattern bodies as raw `{nested}` args, exactly what the
  //     Subgraph/Partition injectors recurse into. A desugar placed after them would leave a
  //     criterion uninjected: the unfiltered-leak hole this category order exists to prevent.
  {
    name: 'desugarMatchString',
    // Cheap gate: only a `match` step carrying a STRING first argument is the string form.
    applies: (steps) => steps.some((s) => s.name === 'match' && typeof (s.args ?? [])[0]?.value === 'string'),
    run: desugarMatchString,
  },
  // Also before decoration, and for the same reason: a map VALUE may be a nested traversal, and
  // the Subgraph/Partition injectors recurse into `{nested}` ARGS rather than into a Map's values.
  // Independent of desugarMatchString (disjoint step names), so the order between them is free.
  { name: 'desugarPropertyMap', applies: (steps) => steps.some((s) => s.name === 'property'), run: desugarPropertyMap },
]);

// ---------- fold (canonicalize multi-step shapes into carried fields) ----------
// These five target disjoint step names, so their relative order is not load-bearing; kept in the
// historical composition order for review locality. The Stage 3 test pins the ordering that IS
// load-bearing (fold before simplify) as a guard.
const FOLD: Pass[] = group('canonicalize', [
  // These two both need the RAW `{nested}` args (before formRepeatRegions/absorbOptionArms move a
  // body into `.repeatRegion`/`.optionArms`), so both lead the group. Their relative order follows
  // TinkerPop: a where()'s variable LOCATIONS are resolved when the step is CONSTRUCTED
  // (GraphTraversal.where → TraversalHelper.getVariableLocations), i.e. before any strategy runs,
  // whereas ConnectiveStrategy is a strategy. Concretely it matters for
  // `where(__.as("a").out().and().out().as("b"))`: folding the connective first would move the
  // trailing as("b") inside the and()'s last operand, where the end-label rewrite can no longer
  // see it as the body's last step.
  {
    name: 'rewriteWhereEndLabels',
    // Nothing to do without a label to bind or a child body to hold a where(): no as() and no
    // nested arg at the top level means no where() host exists anywhere below either.
    applies: (steps) => steps.some((s) => s.name === 'as' || s.args.some((a) => isNested(a.value))),
    run: (steps, ctx) => rewriteWhereEndLabels(steps, ctx.params),
  },
  // ConnectiveStrategy is the only fold that RESTRUCTURES the chain (infix `.and()`/`.or()` → the
  // step form, moving steps into `{nested}` bodies), so every later fold — and the `simplify` group
  // after it — should see the canonical shape. Its own recursion visits every depth, and each body
  // it mints is `normalize()`d again when compiled as a child, so a by()/repeat cluster inside a
  // folded operand still canonicalizes.
  { name: 'ConnectiveStrategy', run: (steps, ctx) => canonicalizeConnectives(steps, ctx.params) },
  // BEFORE formRepeatRegions and on the FLAT chain: an unrolled `repeat(body).times(n)` becomes
  // ordinary chain steps, so every later pass sees them as if the user had written them out. Placed
  // in canonicalize rather than simplify because it is not a no-op removal — it changes the chain's
  // shape so a body the recursive CTE cannot express becomes one the main chain can.
  { name: 'unrollFixedRepeat', applies: (steps) => steps.some((s) => s.name === 'times'), run: (steps, ctx) => unrollFixedRepeat(steps, ctx.params) },
  { name: 'formRepeatRegions', run: (steps) => formRepeatRegions(steps) },
  // Desugar valueMap().with(WithOptions.tokens) → valueMap(true) BEFORE absorbModulators, so a
  // following by() (e.g. the selective-token form's by(unfold)) folds onto the host once landed.
  { name: 'foldConstantPredicateOperands', run: (steps, ctx) => foldConstantPredicateOperands(steps, ctx.params) },
  { name: 'absorbValueMapWith', run: (steps) => absorbValueMapWith(steps) },
  { name: 'absorbModulators', run: (steps) => absorbModulators(steps) },
  { name: 'absorbOptionArms', run: (steps) => absorbOptionArms(steps) },
  // BEFORE absorbCallWith: desugarIo re-emits io()'s with() steps after the call it mints, for
  // absorbCallWith to fold exactly as it folds a hand-written call()'s.
  { name: 'desugarIo', run: (steps) => desugarIo(steps) },
  { name: 'absorbCallWith', run: (steps) => absorbCallWith(steps) },
]);

// ---------- simplify (provable no-op removals) ----------
// collapseFoldCountLocal MUST precede dropRedundantOrder (it can expose an order().count() the
// latter then drops); absorbModulators (fold) MUST precede dropRedundantOrder so an order().by()
// has its .modulators set and is skipped. Both satisfied by canonicalize < simplify + this intra-group order.
const SIMPLIFY: Pass[] = group('simplify', [
  { name: 'collapseFoldCountLocal', run: (steps) => collapseFoldCountLocal(steps) },
  { name: 'dropRedundantOrder', run: (steps) => dropRedundantOrder(steps) },
  {
    // An existence filter whose body ALWAYS produces a traverser cannot reject anything, so the step
    // is provably inert — the same category of fact as the two above. Removing it here is also what
    // makes `predicateInlining` disable-safe for this whole family: neither the inline path nor the
    // generic gate ever sees the step, so they cannot answer differently. See
    // isAlwaysProductiveFilterNoOp for why this is not a gap in the child-existence gate.
    name: 'isAlwaysProductiveFilterNoOp',
    applies: (steps) => steps.some((s) => ['where', 'filter', 'not', 'and', 'or'].includes(s.name)),
    run: (steps, ctx) => isAlwaysProductiveFilterNoOp(steps, ctx.params) as IRStep[],
  },
]);

// ---------- decoration (external withStrategies; config-gated) ----------
// Each `applies` is a linear scan of ctx.strategies.with (typically 0-2 entries), never the step
// chain — withoutStrategies suppression + the no-op filter are resolved ONCE in runPasses before
// any pass runs, so `applies` here only asks "is this named". Decoration runs on the RAW chain
// (before fold): the injectors recurse into raw `{nested}` args, so a repeat()/choose() body must
// still be an arg, not yet folded into `.repeatRegion`/`.optionArms`. The injected has()/where()/property()
// steps are then folded + simplified like any parsed step (they carry no by()/cluster of their own).
const specNamed = (name: string) => (_steps: readonly IRStep[], ctx: PassContext) =>
  ctx.strategies.with.some((s) => s.name === name);
const specFor = (name: string, ctx: PassContext) => ctx.strategies.with.find((s) => s.name === name)!;

const DECORATION: Pass[] = group('decoration', [
  {
    name: 'SubgraphStrategy', applies: specNamed('SubgraphStrategy'),
    run: (steps, ctx) => injectSubgraphRec(steps, specFor('SubgraphStrategy', ctx), ctx.params) as IRStep[],
  },
  {
    name: 'PartitionStrategy', applies: specNamed('PartitionStrategy'),
    run: (steps, ctx) => injectPartitionRec(steps, specFor('PartitionStrategy', ctx), ctx.params) as IRStep[],
  },
  {
    name: 'ProductiveByStrategy', applies: specNamed('ProductiveByStrategy'),
    run: (steps) => markProductiveBy(steps) as IRStep[],
  },
]);

// ---------- verify (assert legality against ctx.originalChain; never rewrites) ----------
// A verify pass IGNORES its `steps` argument (the live, possibly-decorated chain) and asserts
// against ctx.originalChain — the user's authored chain, neither folded nor injected. This is correct,
// not legacy mimicry: a PartitionStrategy write-stamp (property(key,val) after addV) must not trip
// ReservedKeysVerificationStrategy, and a SubgraphStrategy out()→outE().inV() explosion must not
// change what EdgeLabelVerification sees. verify() throws the spec's canonical message on a
// violation; a passing traversal returns the chain unchanged.
const VERIFY: Pass[] = group('verify', [
  // ALWAYS ON (no `applies`), matching TinkerPop: StandardVerificationStrategy is a standard
  // strategy, not opt-in. Naming it in withStrategies() is therefore a genuine no-op.
  {
    name: 'StandardVerificationStrategy',
    run: function standardVerificationPass(steps, ctx) {
      verifyStandard(ctx.originalChain as IRStep[], ctx.params);
      return steps;
    },
  },
  // Also always on, and for the same reason: a second by() on a one-slot host is invalid Gremlin,
  // not an opt-in strategy. The cheap gate reads ctx.originalChain, NOT the live `steps` — by verify
  // time `absorbModulators` has folded every by() on a BY_HOST into `.modulators`, so a gate that
  // looks for a step NAMED `by` in the live chain is false exactly when the violation exists.
  {
    name: 'byModulatorArity',
    applies: (_steps, ctx) => ctx.originalChain.some((s) => s.name === 'by' || s.args.some((a) => isNested(a.value))),
    run: function byModulatorArityPass(steps, ctx) {
      verifyByModulatorArity(ctx.originalChain as IRStep[], ctx.params);
      return steps;
    },
  },
  // One pass per named verification strategy. `name` is captured per iteration, so each pass's
  // `run` verifies ITS OWN spec — the reason this is a map and not a single pass that loops.
  ...[...VERIFICATION_STRATEGIES].map((name) => ({
    name,
    applies: specNamed(name),
    run: function verificationStrategyPass(steps: IRStep[], ctx: PassContext) {
      verify(specFor(name, ctx), ctx.originalChain as IRStep[]);
      return steps;
    },
  })),
  // A WRITE STEP'S ARGUMENTS, parsed for their errors alone (§6·5). Always on: `property(k, v, m)`
  // with an odd meta run, a merge map keyed `T.key`, an `option()` whose selector is not
  // `Merge.onCreate`/`onMatch` — each is an ERROR whichever spine would have run the traversal, so
  // it belongs above the routing switch and not inside a lowering whose contract is `null`. A
  // `Deferral` ("not learned yet") is swallowed and left to the spines; see `verifyWriteArgs`.
  //
  // Against `ctx.originalChain` for the reason every verify Pass is: an injected PartitionStrategy
  // write stamp is not the user's text, and the desugars that a write parse DOES depend on
  // (`desugarPropertyMap`) are `extract`-category, so they are already applied in that snapshot.
  {
    name: 'writeArguments',
    applies: (_steps, ctx) => ctx.originalChain.some((s) => WRITE_ARG_HOSTS.has(s.name)),
    run: function writeArgumentsPass(steps, ctx) {
      verifyWriteArgs(ctx.originalChain as IRStep[], ctx.params, ctx.sideEffects);
      return steps;
    },
  },
]);

/** The steps whose ARGUMENTS the write parse owns — the cheap gate for the Pass above. */
const WRITE_ARG_HOSTS = new Set(['property', 'mergeV', 'mergeE']);

/** The ordered pipeline. Declaration order across groups fixes cross-category order (extract <
 *  decoration < canonicalize < simplify < verify); the Stage 3 test checks THIS array against
 *  PASS_CATEGORIES so a future append to the wrong group fails loudly. */
export const PASSES: Pass[] = [...EXTRACT, ...DECORATION, ...FOLD, ...SIMPLIFY, ...VERIFY];

/** The empty strategy use — for callers/tests that run only the internal folds. */
export const EMPTY_STRATEGY_USE: StrategyUse = { with: [], without: [] };

const DECORATION_ORDINAL = PASS_CATEGORIES.indexOf('decoration');

/** Canonicalise a chain through the internal FOLD passes only (no external withStrategies) — the
 *  entry point every NESTED sub-chain uses (child bodies, match patterns, write targets, correlated
 *  predicates). A sub-chain carries no withStrategies of its own, so EMPTY_STRATEGY_USE is exactly
 *  right; this is `runPasses` with no strategies, named for the sub-chain intent. */
export function normalize(
  steps: Step[], params: Record<string, any> = {}, sideEffects: Map<string, any> = NO_SIDE_EFFECTS,
): { steps: IRStep[]; discard: boolean } {
  return runPasses(steps, EMPTY_STRATEGY_USE, params, sideEffects);
}

/** No `withSideEffect` declared. One shared value, so a caller that has none allocates nothing and
 *  every empty registry is the same object. */
const NO_SIDE_EFFECTS: Map<string, any> = new Map();

/** A nested `__.…` argument PARSED and normalized into a child body — the one entry point every
 *  child-bearing step reaches for. Child chains cross the same normalization seam as the root; in
 *  particular `order().by()` must arrive as ONE `IRStep` before any shape-aware lowering sees it.
 *
 *  The constant environments travel WITH the body, because normalizing re-runs the whole Pass
 *  pipeline and the write-argument verifier in it resolves a `__.select(k)` against the side-effect
 *  registry. A caller that has none passes none.
 *
 *  `discard` rides out-of-band (a `__.discard()` body is stripped to nothing by the pipeline, and
 *  the caller must still be able to SEE that it discarded), so the terminal step is re-appended.
 *
 *  It lives beside `normalize` rather than with the child seam that grew it: parsing a nested arg
 *  into IR is IR production, and the classifier, both lowering spines and the service SPI all need
 *  it without also needing a lowering. Contrast `rootedSteps` (`rel/lower.ts`), which is
 *  deliberately NOT this — a ROOTED nested body must keep its source, where this strips one. */
export const childSteps = (nested: any, params: Record<string, any>, sideEffects?: Map<string, any>): IRStep[] => {
  const rawSteps = stepChain(nested, params);
  const normalized = normalize(rawSteps, params, sideEffects);
  return normalized.discard ? [...normalized.steps, rawSteps.at(-1)! as IRStep] : normalized.steps;
};

/** Fold PASSES over the chain in category order — the SINGLE pre-lowering rewrite entry, replacing
 *  both the inside-out normalize() nesting AND the applyStrategies if/else ladder.
 *
 *  Strategy resolution (identical semantics to the old applyStrategies :322-339): reject a
 *  withoutStrategies() of an always-on strategy; filter `with` down to the strategies that actually
 *  do something (drop withoutStrategies-suppressed + no-op entries); then require every remaining
 *  named strategy to be claimed by SOME pass's `applies` — the fail-closed catch-all, now a pipeline
 *  invariant instead of a ladder `else throw`. `discard` rides out-of-band on ctx.out. */
export function runPasses(
  steps: Step[], use: StrategyUse, params: Record<string, any> = {}, sideEffects: Map<string, any> = NO_SIDE_EFFECTS,
): { steps: IRStep[]; discard: boolean } {
  for (const name of use.without)
    if (ALWAYS_ON_STRATEGIES.has(name))
      throw new Error(`withoutStrategies(${name}) is not supported: its effect (infix .and()/.or() folding) is unconditionally applied by this compiler and cannot be disabled.`);
  const removed = new Set(use.without);
  const active = use.with.filter((s) => !removed.has(s.name) && !NO_OP_STRATEGIES.has(s.name));
  const ctx: PassContext = { params, sideEffects, strategies: { with: active, without: use.without }, originalChain: [], out: { discard: false } };

  // Fail-closed invariant: every active (non-suppressed, non-no-op) strategy must be claimed by a
  // decoration/verify pass of the same name, else it is a semantic/unknown strategy that would
  // change results if silently ignored (the old ladder's catch-all `else throw`, now an invariant).
  for (const spec of active)
    if (!PASSES.some((p) => (p.category === 'decoration' || p.category === 'verify') && p.name === spec.name))
      throw new Error(rejectMsg(spec.name));

  let chain = steps as IRStep[];
  let lastOrdinal = -1;
  for (const pass of PASSES) {
    const ordinal = PASS_CATEGORIES.indexOf(pass.category);
    // Snapshot the raw pre-decoration chain (extract-only: trailing discard stripped, nothing
    // injected/folded) at the boundary into decoration, unconditionally — every compile crosses it
    // in category order whether or not a decoration pass fires. Verify passes assert against THIS,
    // the user's authored chain, so an injected partition stamp / exploded edge step is invisible.
    if (lastOrdinal < DECORATION_ORDINAL && ordinal >= DECORATION_ORDINAL) ctx.originalChain = chain;
    lastOrdinal = ordinal;
    if (pass.applies && !pass.applies(chain, ctx)) continue;
    chain = pass.run(chain, ctx);
  }
  return { steps: chain, discard: ctx.out.discard };
}
