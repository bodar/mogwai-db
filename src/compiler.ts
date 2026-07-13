import { parseGremlin, stepChain, stepName } from './frontend.ts';
import { normalize } from './strategies.ts';
import { compileRead } from './steps/index.ts';
import { routeWrite } from './steps/write.ts';
import { type Compiled, type WritePlan } from './render.ts';
// Re-export the compile-output contract so handler.ts / tests keep importing it here.
export type { Compiled, WritePlan, Shape, ValueType, MapEntry, ElemShape, GroupKey, GroupVal, PathPos } from './render.ts';

// ---------- compilation orchestrator ----------
//
// The compiler is three stages, each in its own module:
//   1. front-end (frontend.ts)   — parse → Step[] IR
//   2. normalize (strategies.ts) — Seam 3: pure Step[]→Step[] passes so the
//                                   dispatch sees a canonical, peek-free chain
//   3. dispatch  (steps/*.ts)    — Seam 2: prefix fold (buildPrefix) + tail
//                                   (compileTail) for reads; routeWrite for writes
// This file is just the wiring + the strategy fail-closed guard.

/**
 * Traversal-strategy handling. `withStrategies`/`withoutStrategies` parse and chain
 * fine (they count toward the L1 corpus metric), but the compiler does not APPLY
 * strategies. So we split them by whether ignoring one can change the result set:
 *
 * - **Optimization strategies** (below) are, by TinkerPop's own contract, purely
 *   performance rewrites — the result set is identical with them applied, removed,
 *   or absent (the official suite proves it: for each, the `withStrategies(X)` and
 *   `withoutStrategies(X)` scenarios expect the SAME rows). Our SQL does its own
 *   planning, so not applying them is exactly correct — accept as a no-op. This is
 *   correct-by-design, not correct-by-accident: the criterion is "cannot change
 *   output", not "makes a test pass".
 * - **Everything else** fails closed. A PartitionStrategy or SubgraphStrategy that a
 *   client relies on to FILTER reads/writes for logical isolation would otherwise be
 *   silently dropped and return unfiltered data with no error. ProductiveByStrategy,
 *   Connective/Options/verification/OLAP strategies all likewise change semantics.
 *   `withoutStrategies` of these is coupled and stays rejected too: once we DO apply
 *   a default strategy, `withoutStrategies(X)` MUST actively suppress it, and an
 *   accept-and-ignore left over from now would leak. Reject until honoured.
 *
 * Unknown / mixed lists fail closed: every named strategy must be whitelisted, else
 * the whole call is rejected.
 */
const SAFE_OPTIMIZATION_STRATEGIES = new Set([
  'CountStrategy', 'IdentityRemovalStrategy', 'FilterRankingStrategy',
  'LazyBarrierStrategy', 'EarlyLimitStrategy', 'OrderLimitStrategy',
  'AdjacentToIncidentStrategy', 'IncidentToAdjacentStrategy', 'InlineFilterStrategy',
  'PathRetractionStrategy', 'PathProcessorStrategy', 'ByModulatorOptimizationStrategy',
  'RepeatUnrollStrategy', 'MatchAlgorithmStrategy', 'MatchPredicateStrategy',
]);

function checkStrategies(tree: any): void {
  const scan = (node: any) => {
    const m = stepName(node.constructor.name, 'TraversalSourceSelfMethod_');
    if (m === 'withStrategies' || m === 'withoutStrategies') {
      // Identifiers ending in "Strategy" (ANTLR getText() drops whitespace, so
      // `new SubgraphStrategy` → `newSubgraphStrategy` — which is NOT whitelisted,
      // still failing closed). Require ≥1 and ALL whitelisted, else reject.
      const named = node.getText().match(/[A-Za-z_]\w*Strategy(?![A-Za-z])/g) ?? [];
      const allSafe = named.length > 0 && named.every((s: string) => SAFE_OPTIMIZATION_STRATEGIES.has(s));
      if (!allSafe)
        throw new Error(`${m}(...) is not supported: only result-preserving optimization strategies are accepted (as no-ops); semantic strategies (e.g. PartitionStrategy, SubgraphStrategy) would silently ignore the filtering they imply and leak unfiltered data. Rejected to fail closed.`);
    }
    for (let i = 0; i < (node.getChildCount?.() ?? 0); i++) scan(node.getChild(i));
  };
  scan(tree);
}

export function compile(gremlin: string, params: Record<string, any>): Compiled | WritePlan {
  const tree = parseGremlin(gremlin);
  checkStrategies(tree);
  const { steps, discard } = normalize(stepChain(tree, params));
  if (steps.length === 0) throw new Error('empty traversal');

  const plan: Compiled | WritePlan = routeWrite(steps, params) ?? compileRead(steps, params);

  if (discard) {
    // v4 iterate(): execute for effect, return nothing.
    if (plan.kind === 'write') { const inner = plan.run; return { kind: 'write', run: (s) => { inner(s); return []; } }; }
    return { ...plan, shape: { kind: 'discard' } };
  }
  return plan;
}
