import { parseGremlin, stepChain, unansweredTerminalMethod, extractStrategies, extractSack, extractSideEffects, extractSourceOptions, sideEffectPolicies as extractSideEffectPolicies } from '../gremlin/frontend.ts';
import { type TypeNode } from '../gremlin/types.ts';
import { runPasses } from './ir/passes.ts';
import { sideEffectShadowedLabel, unlocatableSubPath, unresolvableWhereKey } from './ir/labels.ts';
import { perTraverserMutableFold } from './ir/fold-seed.ts';
import { ambiguousEntryBind, erasedPathEntry } from './ir/strategies.ts';
import { sackFoldsNaN } from './ir/sack-nan.ts';
import { uncarriedLiteral } from './ir/uncarried-literal.ts';
import { type Executable } from '../sql/kernel/render.ts';
import { type Plan } from './segment.ts';
import { labelRegime } from '../api.ts';
import { resolveFastPaths, resolveRegistry, resolveFederationDepth, type CompileOptions } from './options/fast-paths.ts';
import { compileViaRel, loweringOptions } from './rel/spine.ts';
import { rankedOrderPlan, segmentPlan } from './rel/segment.ts';
import { createAppScope, createRequestScope } from '../scopes.ts';
import { servicesNamedBy } from '../services/params/call-params.ts';
import { UnsupportedTraversal } from './unsupported.ts';
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
  // A terminal method the step walk cannot see (`next()`, `toSet()`, …) asks a different question than
  // the stream does — decline rather than answer the stream for it (`unansweredTerminalMethod`).
  if (unansweredTerminalMethod(tree) !== null) throw new UnsupportedTraversal(gremlin);
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
  if (steps.length === 0) throw new UnsupportedTraversal('a traversal source with no steps');
  // A `where(P)` operand is a SCOPE KEY, not a value (`unresolvableWhereKey`): a non-String key is the
  // reference's construction-time refusal, raised here; a key the lowering's alias readers cannot
  // resolve as the reference does declines — once, at every depth. After the Passes, so a GQL `match()`'s
  // variables are the `as()` labels its desugar binds; the operand fold leaves every key-holding
  // `where(P)` as written (`foldConstantPredicateOperands`).
  if (unresolvableWhereKey(steps, params, [...sideEffects.keys(), ...sideEffectPolicies.keys()]) !== null)
    throw new UnsupportedTraversal(gremlin);
  // A path label a SIDE EFFECT shadows is read as the side effect by every `Scoping` step, and every
  // label reader the lowering has reads the alias map instead — so the traversal declines here, once,
  // for all of them (`sideEffectShadowedLabel`).
  if (sideEffectShadowedLabel(steps, params, [...sideEffects.keys(), ...sideEffectPolicies.keys()]) !== null)
    throw new UnsupportedTraversal(gremlin);
  // A `from()`/`to()` sub-path the reference may THROW on (an absent or misordered label) declines here,
  // once, for every path-family host (`unlocatableSubPath`) — the lowering's sub-path would answer an
  // empty path instead.
  if (unlocatableSubPath(steps, params) !== null) throw new UnsupportedTraversal(gremlin);
  // A `fold(<list/map seed>, Operator)` that may run once PER PARENT TRAVERSER declines here, once, for
  // every host at every depth (`perTraverserMutableFold`) — the reference aliases that one seed object
  // across parents and `addAll` mutates it, where every lowering folds into a fresh accumulator.
  if (perTraverserMutableFold(steps, params) !== null) throw new UnsupportedTraversal(gremlin);
  // A path reader over a spliced `map`/`flatMap` identity host, whose erased path entry the read would miss
  // (`erasedPathEntry`), and a re-bind of a label only SOME traversers' current entry holds
  // (`ambiguousEntryBind`) decline here, once, at every depth — both are path-entry facts no single
  // lowering position owns.
  if (erasedPathEntry(steps, params) !== null || ambiguousEntryBind(steps, params)) throw new UnsupportedTraversal(gremlin);
  // A NaN literal the sack may fold declines here, once, for every host (`sackFoldsNaN`) — SQLite stores
  // NaN as NULL, and the fold would answer for a NULL operand where the reference computes with NaN.
  if (sackFoldsNaN(steps, params, sackInit)) throw new UnsupportedTraversal(gremlin);
  // A literal VALUE no carrier keeps — a NaN (SQLite stores it as NULL) or a negative-scale BigDecimal
  // (plain decimal text cannot spell its scale) — declines here, once, at every depth (`uncarriedLiteral`).
  if (uncarriedLiteral(steps, params) !== null) throw new UnsupportedTraversal(gremlin);

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
  const segmentRequest = {
    services: relRequest.services, params: request.params, federationDepth: request.federationDepth,
    lowering: loweringOptions(relRequest, request.params, sideEffects),
  };
  const segment = segmentPlan(steps, segmentRequest);
  if (segment) return segment;

  const compiled = compileViaRel(relRequest, steps, request.params, sideEffects);
  // A GLOBAL `order()` whose key SQL has no comparator for (a list/map/path — TinkerPop 4 ORDERABILITY)
  // is a ranked-order BARRIER, asked only now so no chain SQL already answers changes plan. A `discard()`
  // is applied to a single statement, which a segment is not, so it keeps declining.
  const ranked = compiled || discard ? null : rankedOrderPlan(steps, segmentRequest);
  if (ranked) return ranked;
  // A DECLINE IS NOW THE ANSWER, not a route change. While two spines existed a `null` here meant
  // "the other one owns this"; with one spine it means the compiler cannot lower this traversal, and
  // saying so plainly is the only honest thing left to do with it. It is an ordinary query failure —
  // returned to the client on the trailer, not logged as an incident (root CLAUDE.md).
  if (!compiled) throw new UnsupportedTraversal(gremlin);
  return { kind: 'sql', compiled: discard ? applyDiscard(compiled) : compiled };
}

export { UnsupportedTraversal };

export function compile(gremlin: string, params: Record<string, any>, options?: CompileOptions, paramTypes: Record<string, TypeNode> = {}): Executable {
  const plan = compilePlan(gremlin, params, options, paramTypes);
  if (plan.kind === 'segment')
    throw new Error('a barrier step (a regex predicate, an async call()/io()) compiles to a segment plan that must be DRIVEN against a store — use an Executor (framed/framedAsync), not bare compile()');
  return plan.compiled;
}
