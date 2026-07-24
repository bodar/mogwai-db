import { parseGremlin, stepChain, extractStrategies, extractSack, extractSideEffects } from '../gremlin/frontend.ts';
import { type TypeNode } from '../gremlin/types.ts';
import { applyStrategies } from './ir/strategies.ts';
import { runPasses, EMPTY_STRATEGY_USE } from './ir/passes.ts';
import { LoweringEngine, collapseSafeFastPaths } from './engine/engine.ts';
import { analyze } from './ir/analyze.ts';
import { routeWrite } from '../steps/write/write.ts';
import { type Compiled, type WritePlan } from '../sql/kernel/render.ts';
import { type Plan } from './segment.ts';
import { resolveFastPaths, resolveRegistry, resolveFederationDepth, type CompileOptions } from './options/fast-paths.ts';
import { createAppScope, createCompilerScope } from '../scopes.ts';
// Re-export the compile-output contract so execute.ts / tests keep importing it here.
export type { Compiled, WritePlan, Shape, ValueType, ListOf, MapEntry, MapOf, ElemShape, GroupKey, GroupVal, PathPos } from '../sql/kernel/render.ts';
export type { CompileOptions, FastPathConfig } from './options/fast-paths.ts';

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

/** Apply v4 iterate()'s trailing discard: execute for effect, return nothing. Shared by the
 *  sync (Compiled/WritePlan) and segment resume paths — a discard turns any read leaf's shape
 *  into `discard` and empties a write's result. */
function applyDiscard(plan: Compiled | WritePlan): Compiled | WritePlan {
  if (plan.kind === 'write') { const inner = plan.run; return { kind: 'write', run: (s) => { inner(s); return []; } }; }
  return { ...plan, shape: { kind: 'discard' } };
}

/** The full compile as a Plan: the ordinary synchronous case is `{kind:'sql', compiled}`; a
 *  barrier call() at the source suspends into a SegmentPlan the executor resumes after an await
 *  (segment.ts runPlan). Every non-barrier caller keeps using compile() below, whose type never
 *  widened — only execute.ts's orchestrator consumes a Plan. */
export function compilePlan(gremlin: string, params: Record<string, any>, options?: CompileOptions, paramTypes: Record<string, TypeNode> = {}): Plan {
  const tree = parseGremlin(gremlin);
  const rewritten = applyStrategies(stepChain(tree, params, paramTypes), extractStrategies(tree, params), params);
  const { steps, discard } = runPasses(rewritten, EMPTY_STRATEGY_USE, params);
  if (steps.length === 0) throw new Error('empty traversal');

  const sackInit = extractSack(tree, params);
  const sideEffects = extractSideEffects(tree, params);

  // The per-compilation DI scope: an app scope (from options, or a default one for callers that
  // pass loose fields / nothing) plus this compile's collaborators. The lowering Engine (the
  // dependency object that replaced the free-function dispatcher barrel) is built HERE from the
  // scope, with movementCollapse gated to this chain's result-safety, and drives read AND write;
  // it rides its own Query (`scope.q`) so every step family reaches lowering + deps through the
  // stream without any parameter threading. The write path only ever mints fresh child engines
  // off it (buildPrefixFresh / compileReadCompiled), so building it before the write check is safe.
  const app = options?.app ?? createAppScope({ registry: resolveRegistry(options), fastPaths: resolveFastPaths(options) });
  const scope = createCompilerScope(app, { params, federationDepth: resolveFederationDepth(options) });
  const engine = new LoweringEngine(app, scope, collapseSafeFastPaths(scope.fastPaths, analyze(steps)));

  const write = routeWrite(engine, steps, params, sackInit ?? undefined, sideEffects);
  if (write) return { kind: 'sql', compiled: discard ? applyDiscard(write) : write };

  const read = engine.compileRead(steps, scope.params, sackInit ?? undefined);
  if (read.kind === 'segment') {
    // A discard trailing a federated source (g.call(...).iterate()) applies to the RESUMED leaf,
    // so wrap resume rather than the segment itself (which carries no shape).
    if (!discard) return read;
    return { ...read, resume: (foreign, headRows) => {
      const p = read.resume(foreign, headRows);
      return p.kind === 'sql' ? { kind: 'sql', compiled: applyDiscard(p.compiled) } : p;
    } };
  }
  return { kind: 'sql', compiled: discard ? applyDiscard(read) : read };
}

export function compile(gremlin: string, params: Record<string, any>, options?: CompileOptions, paramTypes: Record<string, TypeNode> = {}): Compiled | WritePlan {
  const plan = compilePlan(gremlin, params, options, paramTypes);
  if (plan.kind === 'segment')
    throw new Error('call(): barrier/async services require the segment executor (executeFramed); compile() cannot resolve one synchronously');
  return plan.compiled;
}
