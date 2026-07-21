import { parseGremlin, stepChain, extractStrategies, extractSack, extractSideEffects } from './frontend.ts';
import { type TypeNode } from './gremlin-types.ts';
import { applyStrategies, normalize } from './strategies.ts';
import { compileRead } from './steps/index.ts';
import { routeWrite } from './steps/write.ts';
import { type Compiled, type WritePlan } from './render.ts';
import { resolveFastPaths, resolveRegistry, type CompileOptions } from './fast-paths.ts';
// Re-export the compile-output contract so execute.ts / tests keep importing it here.
export type { Compiled, WritePlan, Shape, ValueType, ListOf, MapEntry, MapOf, ElemShape, GroupKey, GroupVal, PathPos } from './render.ts';
export type { CompileOptions, FastPathConfig } from './fast-paths.ts';

// ---------- compilation orchestrator ----------
//
// The compiler is three stages, each in its own module:
//   1. front-end (frontend.ts)   — parse → Step[] IR
//   2. normalize (strategies.ts) — Seam 3: pure Step[]→Step[] passes so the
//                                   dispatch sees a canonical, peek-free chain
//   3. dispatch  (steps/*.ts)    — Seam 2: prefix fold (buildPrefix) + tail
//                                   (compileTail) for reads; routeWrite for writes
// This file is just the wiring. Traversal-strategy handling — parsing the
// withStrategies/withoutStrategies specs and applying them as step rewrites /
// verification checks / fail-closed rejections — lives in strategies.ts
// (extractStrategies front-end + applyStrategies). See that module's header.

export function compile(gremlin: string, params: Record<string, any>, options?: CompileOptions, paramTypes: Record<string, TypeNode> = {}): Compiled | WritePlan {
  const tree = parseGremlin(gremlin);
  const rewritten = applyStrategies(stepChain(tree, params, paramTypes), extractStrategies(tree, params), params);
  const { steps, discard } = normalize(rewritten);
  if (steps.length === 0) throw new Error('empty traversal');

  const sackInit = extractSack(tree, params);
  const sideEffects = extractSideEffects(tree, params);
  const plan: Compiled | WritePlan = routeWrite(steps, params, sackInit ?? undefined, sideEffects)
    ?? compileRead(steps, params, sackInit ?? undefined, resolveFastPaths(options), resolveRegistry(options));

  if (discard) {
    // v4 iterate(): execute for effect, return nothing.
    if (plan.kind === 'write') { const inner = plan.run; return { kind: 'write', run: (s) => { inner(s); return []; } }; }
    return { ...plan, shape: { kind: 'discard' } };
  }
  return plan;
}
