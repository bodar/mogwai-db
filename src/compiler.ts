import { parseGremlin, stepChain, stepName } from './frontend.ts';
import { normalize } from './strategies.ts';
import { compileRead } from './steps/index.ts';
import { routeWrite } from './steps/write.ts';
import { type Compiled, type WritePlan } from './render.ts';
// Re-export the compile-output contract so handler.ts / tests keep importing it here.
export type { Compiled, WritePlan, Shape, MapEntry, ElemShape, GroupKey, GroupVal } from './render.ts';

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
 * Fail closed on traversal-strategy application. `withStrategies`/`withoutStrategies`
 * parse and chain fine (so they count toward the L1 "we understand the language"
 * corpus metric), but the compiler does not yet APPLY them. A PartitionStrategy or
 * SubgraphStrategy — which a client relies on to FILTER reads/writes for logical
 * isolation — would otherwise be silently dropped and return unfiltered data with
 * no error. Reject at execution until the compiler honours them, rather than leak.
 */
function rejectUnsupportedStrategies(tree: any): void {
  const scan = (node: any) => {
    const m = stepName(node.constructor.name, 'TraversalSourceSelfMethod_');
    if (m === 'withStrategies' || m === 'withoutStrategies')
      throw new Error(`${m}(...) is not supported: traversal strategies (e.g. PartitionStrategy, SubgraphStrategy) are not yet applied by the compiler, so accepting them would silently ignore the filtering they imply and leak unfiltered data. Rejected to fail closed.`);
    for (let i = 0; i < (node.getChildCount?.() ?? 0); i++) scan(node.getChild(i));
  };
  scan(tree);
}

export function compile(gremlin: string, params: Record<string, any>): Compiled | WritePlan {
  const tree = parseGremlin(gremlin);
  rejectUnsupportedStrategies(tree);
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
