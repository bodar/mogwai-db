import type { Step, StrategyUse } from '../../gremlin/frontend.ts';
import { PASS_CATEGORIES, type Pass, type PassContext } from './pass.ts';
import {
  stripTerminal, foldRepeatClusters, foldByModulators, foldChooseOptions, foldCallWith,
  collapseFoldCountLocal, dropRedundantOrder,
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
  { name: 'foldRepeatClusters', category: 'fold', run: (steps) => foldRepeatClusters(steps) },
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

/** The ordered pipeline. Declaration order across groups fixes cross-category order; the Stage 3
 *  test checks THIS array against PASS_CATEGORIES so a future append to the wrong group fails
 *  loudly. (Decoration + verify groups arrive in Stage 2, when applyStrategies folds in here.) */
export const PASSES: Pass[] = [...EXTRACT, ...FOLD, ...SIMPLIFY];

/** The empty strategy use — for callers/tests that run only the internal folds. */
export const EMPTY_STRATEGY_USE: StrategyUse = { with: [], without: [] };

/** Canonicalise a chain through the internal FOLD passes only (no external withStrategies) — the
 *  entry point every NESTED sub-chain uses (child bodies, match patterns, write targets, correlated
 *  predicates). A sub-chain carries no withStrategies of its own, so EMPTY_STRATEGY_USE is exactly
 *  right; this is `runPasses` with no strategies, named for the sub-chain intent. */
export function normalize(steps: Step[]): { steps: PStep[]; discard: boolean } {
  return runPasses(steps, EMPTY_STRATEGY_USE);
}

/** Fold PASSES over the chain in category order. Replaces the old inside-out normalize() nesting;
 *  it does NOT yet apply external withStrategies (that is still applyStrategies, called before this
 *  in compiler.ts — Stage 2 folds it in). `discard` rides out-of-band on ctx.out (iterate()). */
export function runPasses(steps: Step[], use: StrategyUse, params: Record<string, any> = {}): { steps: PStep[]; discard: boolean } {
  const ctx: PassContext = { params, strategies: use, originalChain: [], out: { discard: false } };
  let chain = steps as PStep[];
  let lastCategory = -1;
  for (const pass of PASSES) {
    const cat = PASS_CATEGORIES.indexOf(pass.category);
    // Snapshot the folded-but-undecorated chain at the fold→decoration boundary, unconditionally
    // (verify passes assert against it). No decoration/verify passes exist until Stage 2, but the
    // boundary is fixed by category order now so the driver need not change when they arrive.
    if (lastCategory < PASS_CATEGORIES.indexOf('decoration') && cat >= PASS_CATEGORIES.indexOf('decoration'))
      ctx.originalChain = chain;
    lastCategory = cat;
    if (pass.applies && !pass.applies(chain, ctx)) continue;
    chain = pass.run(chain, ctx);
  }
  return { steps: chain, discard: ctx.out.discard };
}
