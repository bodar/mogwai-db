import { parseGremlin, stepChain, extractStrategies, extractSack, extractSideEffects, extractSourceOptions } from '../gremlin/frontend.ts';
import { type TypeNode } from '../gremlin/types.ts';
import { runPasses } from './ir/passes.ts';
import { LoweringEngine, collapseSafeFastPaths } from './engine/engine.ts';
import { analyzeChain } from './ir/analyze.ts';
import { routeWrite } from './steps/write/write.ts';
import { type Executable } from '../sql/kernel/render.ts';
import { type Plan } from './segment.ts';
import { resolveFastPaths, resolveRegistry, resolveFederationDepth, type CompileOptions } from './options/fast-paths.ts';
import { resolveSpine } from './options/spine.ts';
import { compileViaRel } from './rel/spine.ts';
import { createAppScope, createRequestScope } from '../scopes.ts';
import { servicesNamedBy } from '../services/params/call-params.ts';
// Re-export the compile-output contract so execute.ts / tests keep importing it here.
export type { Compiled, Executable, Program, WritePlan, WriteResult, Shape, ValueType, ListOf, MapEntry, MapOf, ElemShape, GroupKey, GroupVal, PathPos } from '../sql/kernel/render.ts';
export { staticTypeOf, perRowColumnOf, PER_ROW, STATIC, UNKNOWN } from '../sql/kernel/render.ts';
export type { ScalarType } from '../sql/kernel/render.ts';
export type { CompileOptions, FastPathConfig } from './options/fast-paths.ts';

// ---------- compilation orchestrator ----------
//
// The compiler is three stages, each in its own module:
//   1. front-end (frontend.ts)   — parse → Step[] IR
//   2. rewrite   (ir/passes.ts)  — ONE categorized, ordered Pass pipeline (runPasses) —
//                                   internal folds AND external withStrategies decoration/
//                                   verification — so the dispatch sees a canonical, peek-free,
//                                   policy-honoured chain. Chain-global facts come from ir/analyze.ts.
//   3. dispatch  (steps/*.ts)    — prefix fold (buildPrefix) + tail
//                                   (compileTail) for reads; routeWrite for writes
// This file is just the wiring. Traversal-strategy handling — parsing the withStrategies/
// withoutStrategies specs (extractStrategies front-end) and applying them as decoration/verify
// Passes with a fail-closed reject invariant — lives in the Pass pipeline (ir/passes.ts); the
// concrete inject/verify/fold bodies + classification Sets stay in ir/strategies.ts.

/** Apply v4 iterate()'s trailing discard: execute for effect, return nothing. Shared by the
 *  sync (Compiled/WritePlan) and segment resume paths — a discard turns any read leaf's shape
 *  into `discard` and empties a write's result. */
function applyDiscard(plan: Executable): Executable {
  if (plan.kind === 'write') { const inner = plan.run; return { kind: 'write', run: (s) => { inner(s); return []; } }; }
  return { ...plan, shape: { kind: 'discard' } };
}

/** The full compile as a Plan: the ordinary synchronous case is `{kind:'sql', compiled}`; a
 *  barrier call() at the source suspends into a SegmentPlan the executor resumes after an await
 *  (segment.ts runPlan). Every non-barrier caller keeps using compile() below, whose type never
 *  widened — only execute.ts's orchestrator consumes a Plan. */
export function compilePlan(gremlin: string, params: Record<string, any>, options?: CompileOptions, paramTypes: Record<string, TypeNode> = {}): Plan {
  const tree = parseGremlin(gremlin);
  const sackInit = extractSack(tree, params);
  // BEFORE `runPasses`, because a `verify` Pass parses the write steps' arguments and a
  // `__.select(k)` key or value IS a `withSideEffect` constant — verifying without the registry
  // would refuse a traversal for a fact this compile already holds (§6·5).
  const sideEffects = extractSideEffects(tree, params);
  const { steps, discard } = runPasses(stepChain(tree, params, paramTypes), extractStrategies(tree, params), params, sideEffects);
  if (steps.length === 0) throw new Error('empty traversal');

  // The DI scopes: an app scope (from options, or a default one for callers that pass loose
  // fields / nothing), the REQUEST scope this traversal fixes (its bound params, its federation
  // hop depth, its g.with(...) source options — all inherited by every nested sub-compile), and
  // this compile's own Query. The lowering Engine (the
  // dependency object that replaced the free-function dispatcher barrel) is built HERE from the
  // scope, with movementCollapse gated to this chain's result-safety, and drives read AND write;
  // it rides its own Query (`scope.q`) so every step family reaches lowering + deps through the
  // stream without any parameter threading. The write path only ever mints fresh child engines
  // off it (buildPrefixFresh / compileReadCompiled), so building it before the write check is safe.
  const app = options?.app ?? createAppScope({ registry: resolveRegistry(options), fastPaths: resolveFastPaths(options) });
  const request = createRequestScope(app, {
    params, federationDepth: resolveFederationDepth(options), sourceOptions: extractSourceOptions(tree, params),
  });
  const engine = new LoweringEngine(request, { fastPaths: collapseSafeFastPaths(request.fastPaths, analyzeChain(steps)) });

  // THE SPINE ROUTE (§6·1). A chain the RelIR lowering covers end-to-end compiles there; anything
  // else — a step it has not learned, a write it cannot express, a sack — falls through to the legacy
  // spine WHOLE. Never mixed inside one traversal, which is what keeps RelIR a real algebra rather
  // than a wrapper around opaque SQL. `MOGWAI_RELIR=0` (or `options.spine`) is the differential's
  // off position, and it and this branch are both deleted when the legacy spine is.
  //
  // **`withSideEffect` USED TO BE A ROUTE-LEVEL REFUSAL HERE, AND THAT MADE A HAND-OVER LOOK LIKE A
  // GAP.** `sideEffects.size === 0` meant a traversal declaring one was never OFFERED to the lowering,
  // so `mergeV(__.select(c))` and `property(k, __.select(c))` counted as uncovered vocabulary when what
  // was actually missing is that the seam had not been handed a map the front-end already held (§6·6).
  // Coverage must measure what the algebra can EXPRESS, never what the router remembered to ask.
  // The steps that genuinely need a named-collection substrate (`aggregate`/`store`/`cap`, and the
  // reducer form of `withSideEffect`, which the front-end leaves unregistered) decline inside the
  // lowering like any other unlearned step — which is where a decline belongs.
  //
  // **THERE IS NO ROUTE-LEVEL GATE LEFT.** The last one was `!sackInit` — a traversal declaring a
  // `withSack()` was never OFFERED to this route, whatever else was in it — and it is gone with the
  // sack lowering (plan §10 Phase 2). The seed now travels as a settled VALUE like
  // `labelCardinality`: `src/compiler/rel/sack.ts` mints the channel `src/channels.ts` already
  // modelled, and a seed or a merge operator that route cannot express declines INSIDE the lowering
  // like any other unlearned step. That is the whole content of §6·6's lesson at the routing switch:
  // a gate here reads identically to a missing lowering in every counter the migration owns.
  if (resolveSpine(options) === 'rel') {
    const viaRel = compileViaRel(
      {
        collapse: engine.fastPaths.movementCollapse,
        propertySeek: engine.fastPaths.propertySeek,
        labelCardinality: engine.labelCardinality,
        // The registry is an app-scope DEPENDENCY and stops here: this is the boundary that holds
        // it, so it resolves the names and hands the lowering the settled services.
        services: servicesNamedBy(steps, request.params, engine.registry),
        sack: sackInit,
      },
      steps, request.params, sideEffects,
    );
    if (viaRel) return { kind: 'sql', compiled: discard ? applyDiscard(viaRel) : viaRel };
  }

  const write = routeWrite(engine, steps, params, sackInit ?? undefined, sideEffects);
  if (write) return { kind: 'sql', compiled: discard ? applyDiscard(write) : write };

  const read = engine.compileRead(steps, request.params, sackInit ?? undefined);
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

export function compile(gremlin: string, params: Record<string, any>, options?: CompileOptions, paramTypes: Record<string, TypeNode> = {}): Executable {
  const plan = compilePlan(gremlin, params, options, paramTypes);
  if (plan.kind === 'segment')
    throw new Error('call(): barrier/async services require the segment executor (executeFramed); compile() cannot resolve one synchronously');
  return plan.compiled;
}
