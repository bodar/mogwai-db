import { isNested, type Step, type StrategyUse } from '../../gremlin/frontend.ts';
import { PASS_CATEGORIES, type Pass, type PassContext } from './pass.ts';
import {
  stripTerminal, foldRepeatClusters, foldByModulators, foldChooseOptions, foldCallWith,
  foldConnectives, foldConstantPredicateOperands, rewriteWhereEndLabels,
  verifyReadOnlyChildren,
  foldValueMapWith, collapseFoldCountLocal, dropRedundantOrder,
  injectSubgraphRec, injectPartitionRec, markProductiveBy, dropNonProductiveOrderBy, verify,
  NO_OP_STRATEGIES, ALWAYS_ON_STRATEGIES, VERIFICATION_STRATEGIES, rejectMsg,
  type PStep,
} from './strategies.ts';

// ---------- the Pass pipeline: the concrete PASSES array + the driver ----------
//
// PASSES is one flat, ordered array assembled by concatenating per-category groups in
// PASS_CATEGORIES order — the "register in a Map/array, don't grow a switch" law applied to the
// rewrite layer. `runPasses` folds it over the chain, replacing the inside-out normalize() nesting
// (and, from Stage 2 on, applyStrategies too). Adding a rewrite = append a Pass to the right group.

// ---------- extract (out-of-band flags; runs first) ----------
const EXTRACT: Pass[] = [
  {
    name: 'stripTerminal', category: 'extract',
    run: (steps, ctx) => {
      const r = stripTerminal(steps);
      ctx.out.discard = r.discard;
      return r.steps as PStep[];
    },
  },
];

// ---------- fold (canonicalize multi-step shapes into carried fields) ----------
// These five target disjoint step names, so their relative order is not load-bearing; kept in the
// historical composition order for review locality. The Stage 3 test pins the ordering that IS
// load-bearing (fold before simplify) as a guard.
const FOLD: Pass[] = [
  // These two both need the RAW `{nested}` args (before foldRepeatClusters/foldChooseOptions move a
  // body into `.cluster`/`.options`), so both lead the group. Their relative order follows
  // TinkerPop: a where()'s variable LOCATIONS are resolved when the step is CONSTRUCTED
  // (GraphTraversal.where → TraversalHelper.getVariableLocations), i.e. before any strategy runs,
  // whereas ConnectiveStrategy is a strategy. Concretely it matters for
  // `where(__.as("a").out().and().out().as("b"))`: folding the connective first would move the
  // trailing as("b") inside the and()'s last operand, where the end-label rewrite can no longer
  // see it as the body's last step.
  {
    name: 'rewriteWhereEndLabels', category: 'fold',
    // Nothing to do without a label to bind or a child body to hold a where(): no as() and no
    // nested arg at the top level means no where() host exists anywhere below either.
    applies: (steps) => steps.some((s) => s.name === 'as' || (s.args ?? []).some(isNested)),
    run: (steps, ctx) => rewriteWhereEndLabels(steps, ctx.params),
  },
  // ConnectiveStrategy is the only fold that RESTRUCTURES the chain (infix `.and()`/`.or()` → the
  // step form, moving steps into `{nested}` bodies), so every later fold — and the `simplify` group
  // after it — should see the canonical shape. Its own recursion visits every depth, and each body
  // it mints is `normalize()`d again when compiled as a child, so a by()/repeat cluster inside a
  // folded operand still canonicalizes.
  { name: 'ConnectiveStrategy', category: 'fold', run: (steps, ctx) => foldConnectives(steps, ctx.params) },
  { name: 'foldRepeatClusters', category: 'fold', run: (steps) => foldRepeatClusters(steps) },
  // Desugar valueMap().with(WithOptions.tokens) → valueMap(true) BEFORE foldByModulators, so a
  // following by() (e.g. the selective-token form's by(unfold)) folds onto the host once landed.
  { name: 'foldConstantPredicateOperands', category: 'fold', run: (steps, ctx) => foldConstantPredicateOperands(steps, ctx.params) },
  { name: 'foldValueMapWith', category: 'fold', run: (steps) => foldValueMapWith(steps) },
  { name: 'foldByModulators', category: 'fold', run: (steps) => foldByModulators(steps) },
  { name: 'foldChooseOptions', category: 'fold', run: (steps) => foldChooseOptions(steps) },
  { name: 'foldCallWith', category: 'fold', run: (steps) => foldCallWith(steps) },
];

// ---------- simplify (provable no-op removals) ----------
// collapseFoldCountLocal MUST precede dropRedundantOrder (it can expose an order().count() the
// latter then drops); foldByModulators (fold) MUST precede dropRedundantOrder so an order().by()
// has its .bys set and is skipped. Both satisfied by fold < simplify + this intra-group order.
const SIMPLIFY: Pass[] = [
  { name: 'collapseFoldCountLocal', category: 'simplify', run: (steps) => collapseFoldCountLocal(steps) },
  { name: 'dropRedundantOrder', category: 'simplify', run: (steps) => dropRedundantOrder(steps) },
];

// ---------- decoration (external withStrategies; config-gated) ----------
// Each `applies` is a linear scan of ctx.strategies.with (typically 0-2 entries), never the step
// chain — withoutStrategies suppression + the no-op filter are resolved ONCE in runPasses before
// any pass runs, so `applies` here only asks "is this named". Decoration runs on the RAW chain
// (before fold): the injectors recurse into raw `{nested}` args, so a repeat()/choose() body must
// still be an arg, not yet folded into `.cluster`/`.options`. The injected has()/where()/property()
// steps are then folded + simplified like any parsed step (they carry no by()/cluster of their own).
const specNamed = (name: string) => (_steps: readonly PStep[], ctx: PassContext) =>
  ctx.strategies.with.some((s) => s.name === name);
const specFor = (name: string, ctx: PassContext) => ctx.strategies.with.find((s) => s.name === name)!;

const DECORATION: Pass[] = [
  {
    name: 'SubgraphStrategy', category: 'decoration', applies: specNamed('SubgraphStrategy'),
    run: (steps, ctx) => injectSubgraphRec(steps, specFor('SubgraphStrategy', ctx), ctx.params) as PStep[],
  },
  {
    name: 'PartitionStrategy', category: 'decoration', applies: specNamed('PartitionStrategy'),
    run: (steps, ctx) => injectPartitionRec(steps, specFor('PartitionStrategy', ctx), ctx.params) as PStep[],
  },
  {
    name: 'ProductiveByStrategy', category: 'decoration', applies: specNamed('ProductiveByStrategy'),
    run: (steps) => markProductiveBy(steps) as PStep[],
  },
  {
    // ALWAYS ON, and declared AFTER ProductiveByStrategy so a marked host is already visible: the
    // non-productive drop is TinkerPop's DEFAULT by() policy, not an opt-in strategy. This is the
    // one place order() learns it — see the long comment on dropNonProductiveOrderBy for why the
    // policy lives in the IR rather than in the four order() lowering paths.
    name: 'nonProductiveByDrop', category: 'decoration',
    applies: (steps) => steps.some((s) => s.name === 'order'),
    run: (steps, ctx) => dropNonProductiveOrderBy(steps, ctx.params) as PStep[],
  },
];

// ---------- verify (assert legality against ctx.originalChain; never rewrites) ----------
// A verify pass IGNORES its `steps` argument (the live, possibly-decorated chain) and asserts
// against ctx.originalChain — the user's authored chain, folded but not injected. This is correct,
// not legacy mimicry: a PartitionStrategy write-stamp (property(key,val) after addV) must not trip
// ReservedKeysVerificationStrategy, and a SubgraphStrategy out()→outE().inV() explosion must not
// change what EdgeLabelVerification sees. verify() throws the spec's canonical message on a
// violation; a passing traversal returns the chain unchanged.
const VERIFY: Pass[] = [
  // ALWAYS ON (no `applies`), matching TinkerPop: StandardVerificationStrategy is a standard
  // strategy, not opt-in. Naming it in withStrategies() is therefore a genuine no-op.
  {
    name: 'readOnlyChildTraversals', category: 'verify' as const,
    run: (steps: PStep[], ctx: PassContext) => { verifyReadOnlyChildren(ctx.originalChain as PStep[], ctx.params); return steps; },
  },
  ...[...VERIFICATION_STRATEGIES].map((name) => ({
  name, category: 'verify' as const,
  applies: specNamed(name),
  run: (steps: PStep[], ctx: PassContext) => { verify(specFor(name, ctx), ctx.originalChain as PStep[]); return steps; },
  })),
];

/** The ordered pipeline. Declaration order across groups fixes cross-category order (extract <
 *  decoration < fold < simplify < verify); the Stage 3 test checks THIS array against
 *  PASS_CATEGORIES so a future append to the wrong group fails loudly. */
export const PASSES: Pass[] = [...EXTRACT, ...DECORATION, ...FOLD, ...SIMPLIFY, ...VERIFY];

/** The empty strategy use — for callers/tests that run only the internal folds. */
export const EMPTY_STRATEGY_USE: StrategyUse = { with: [], without: [] };

const DECORATION_ORDINAL = PASS_CATEGORIES.indexOf('decoration');

/** Canonicalise a chain through the internal FOLD passes only (no external withStrategies) — the
 *  entry point every NESTED sub-chain uses (child bodies, match patterns, write targets, correlated
 *  predicates). A sub-chain carries no withStrategies of its own, so EMPTY_STRATEGY_USE is exactly
 *  right; this is `runPasses` with no strategies, named for the sub-chain intent. */
export function normalize(steps: Step[]): { steps: PStep[]; discard: boolean } {
  return runPasses(steps, EMPTY_STRATEGY_USE);
}

/** Fold PASSES over the chain in category order — the SINGLE pre-lowering rewrite entry, replacing
 *  both the inside-out normalize() nesting AND the applyStrategies if/else ladder.
 *
 *  Strategy resolution (identical semantics to the old applyStrategies :322-339): reject a
 *  withoutStrategies() of an always-on strategy; filter `with` down to the strategies that actually
 *  do something (drop withoutStrategies-suppressed + no-op entries); then require every remaining
 *  named strategy to be claimed by SOME pass's `applies` — the fail-closed catch-all, now a pipeline
 *  invariant instead of a ladder `else throw`. `discard` rides out-of-band on ctx.out. */
export function runPasses(steps: Step[], use: StrategyUse, params: Record<string, any> = {}): { steps: PStep[]; discard: boolean } {
  for (const name of use.without)
    if (ALWAYS_ON_STRATEGIES.has(name))
      throw new Error(`withoutStrategies(${name}) is not supported: its effect (infix .and()/.or() folding) is unconditionally applied by this compiler and cannot be disabled.`);
  const removed = new Set(use.without);
  const active = use.with.filter((s) => !removed.has(s.name) && !NO_OP_STRATEGIES.has(s.name));
  const ctx: PassContext = { params, strategies: { with: active, without: use.without }, originalChain: [], out: { discard: false } };

  // Fail-closed invariant: every active (non-suppressed, non-no-op) strategy must be claimed by a
  // decoration/verify pass of the same name, else it is a semantic/unknown strategy that would
  // change results if silently ignored (the old ladder's catch-all `else throw`, now an invariant).
  for (const spec of active)
    if (!PASSES.some((p) => (p.category === 'decoration' || p.category === 'verify') && p.name === spec.name))
      throw new Error(rejectMsg(spec.name));

  let chain = steps as PStep[];
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
