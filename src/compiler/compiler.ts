import { parseGremlin, stepChain, extractStrategies, extractSack, extractSideEffects, extractSourceOptions, sideEffectPolicies as extractSideEffectPolicies } from '../gremlin/frontend.ts';
import { type TypeNode } from '../gremlin/types.ts';
import { runPasses } from './ir/passes.ts';
import { type Executable } from '../sql/kernel/render.ts';
import { type Plan } from './segment.ts';
import { labelRegime } from '../api.ts';
import { resolveFastPaths, resolveRegistry, resolveFederationDepth, type CompileOptions } from './options/fast-paths.ts';
import { compileViaRel, loweringOptions } from './rel/spine.ts';
import { segmentPlan } from './rel/segment.ts';
import { createAppScope, createRequestScope } from '../scopes.ts';
import { servicesNamedBy } from '../services/params/call-params.ts';
// Re-export the compile-output contract so execute.ts / tests keep importing it here.
export type { Compiled, Executable, Program, Shape, ValueType, ListOf, MapEntry, MapOf, ElemShape, GroupKey, GroupVal, PathPos } from '../sql/kernel/render.ts';
export { staticTypeOf, perRowColumnOf, perRowColumn, hasTypedMembers, memberTypeOf, withMemberType, isPerRow, SCALAR_MEMBERS, TYPED_MEMBERS, PER_ROW, PER_ROW_ENVELOPE, STATIC, UNKNOWN } from '../sql/kernel/render.ts';
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
//   3. lower     (rel/lower.ts)  — fold the Step[] into the RelIR algebra (src/rel/), then emit SQL
// This file is just the wiring. Traversal-strategy handling — parsing the withStrategies/
// withoutStrategies specs (extractStrategies front-end) and applying them as decoration/verify
// Passes with a fail-closed reject invariant — lives in the Pass pipeline (ir/passes.ts); the
// concrete inject/verify/fold bodies + classification Sets stay in ir/strategies.ts.

/** Apply v4 iterate()'s trailing discard: execute for effect, return nothing. Shared by the
 *  sync (Compiled/Program) and segment resume paths — a discard turns any read or write leaf's
 *  shape into `discard`, so the program still runs its effects but frames no traversers. */
function applyDiscard(plan: Executable): Executable {
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
  // The reducer form's LABELS, which `extractSideEffects` deliberately leaves out of the constant
  // registry — a settled value the lowering declines on, exactly as `sackInit` is (§6·6: a fact the
  // route drops is indistinguishable from a lowering that cannot express it, in every counter).
  const sideEffectPolicies = extractSideEffectPolicies(tree, params);
  const { steps, discard } = runPasses(stepChain(tree, params, paramTypes), extractStrategies(tree, params), params, sideEffects);
  if (steps.length === 0) throw new Error('empty traversal');

  // The DI scopes: an app scope (from options, or a default one for callers that pass loose fields /
  // nothing) and the REQUEST scope this traversal fixes — its bound params, its federation hop depth,
  // its `g.with(...)` source options, all inherited by every nested sub-compile.
  const app = options?.app ?? createAppScope({ registry: resolveRegistry(options), fastPaths: resolveFastPaths(options) });
  const request = createRequestScope(app, {
    params, federationDepth: resolveFederationDepth(options), sourceOptions: extractSourceOptions(tree, params),
  });

  // WHAT THE LOWERING GETS FROM THE REQUEST, and the whole of it: two strategy switches, the label
  // regime the source options declared, the services this chain names (resolved HERE — the registry is
  // an ambient capability and stops at this boundary), and the two settled policies the front end
  // extracted. Everything is a VALUE; nothing ambient crosses.
  const relRequest = {
    collapse: request.fastPaths.movementCollapse,
    propertySeek: request.fastPaths.propertySeek,
    ftsSubstringPredicate: request.fastPaths.ftsSubstringPredicate,
    detached: options?.detached ?? false,
    labelRegime: labelRegime(request.sourceOptions),
    services: servicesNamedBy(steps, request.params, request.registry),
    sack: sackInit,
    sideEffectPolicies,
  } as const;

  // A BARRIER `call()` IS ASKED FIRST, because it is not a lowering question. Its rows arrive on a
  // Promise, so the traversal is a PLAN OF SEGMENTS rather than one statement, and `lowerToRel` would
  // decline it — correctly, since there is nothing to lower at compile time — which would read as
  // uncovered vocabulary. What the algebra cannot express and what the executor has not yet fetched
  // are different facts, and only this one has a boundary to build.
  const segment = segmentPlan(steps, {
    services: relRequest.services, params: request.params, federationDepth: request.federationDepth,
    lowering: loweringOptions(relRequest, request.params, sideEffects),
  });
  if (segment) return segment;

  const compiled = compileViaRel(relRequest, steps, request.params, sideEffects);
  // A DECLINE IS NOW THE ANSWER, not a route change. While two spines existed a `null` here meant
  // "the other one owns this"; with one spine it means the compiler cannot lower this traversal, and
  // saying so plainly is the only honest thing left to do with it. It is an ordinary query failure —
  // returned to the client on the trailer, not logged as an incident (root CLAUDE.md).
  if (!compiled) throw new UnsupportedTraversal(gremlin);
  return { kind: 'sql', compiled: discard ? applyDiscard(compiled) : compiled };
}

/**
 * A traversal the compiler cannot lower to SQL — a step, or a COMBINATION of steps, that has no
 * lowering yet.
 *
 * Its own class rather than a bare `Error` so a caller can tell an unsupported query from a broken
 * one: this is the user's traversal being outside what we compile, which is a deferral, while
 * anything else escaping a compile is a defect. Same distinction the Pass tier draws with `Deferral`.
 */
export class UnsupportedTraversal extends Error {
  constructor(readonly gremlin: string) {
    super(`this traversal is not supported yet: no lowering covers ${gremlin}`);
    this.name = 'UnsupportedTraversal';
  }
}

export function compile(gremlin: string, params: Record<string, any>, options?: CompileOptions, paramTypes: Record<string, TypeNode> = {}): Executable {
  const plan = compilePlan(gremlin, params, options, paramTypes);
  if (plan.kind === 'segment')
    throw new Error('a barrier step (a regex predicate, an async call()/io()) compiles to a segment plan that must be DRIVEN against a store — use an Executor (framed/framedAsync), not bare compile()');
  return plan.compiled;
}
