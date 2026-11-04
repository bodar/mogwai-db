import { parseGremlin, stepChain, unansweredTerminalMethod, extractStrategies, extractSack, extractSideEffects, extractSourceOptions, sideEffectPolicies as extractSideEffectPolicies } from '../gremlin/frontend.ts';
import { type TypeNode } from '../gremlin/types.ts';
import { paramEnv } from '../gremlin/param-env.ts';
import { runPasses } from './ir/passes.ts';
import { programScopeNames, sideEffectShadowedLabel, unlocatableSubPath, unresolvableWhereKey } from './ir/labels.ts';
import { UNCOMPARABLE_LITERAL, uncarriedLiteral, uncomparableLiteral } from './ir/uncarried-literal.ts';
import { type Executable } from '../sql/kernel/render.ts';
import { type AsyncSegmentPlan, type Plan, type SyncSegmentPlan } from './segment.ts';
import { labelRegime } from '../api.ts';
import { resolveFastPaths, resolveRegistry, resolveFederationDepth, type CompileOptions } from './options/fast-paths.ts';
import { compileViaRel, loweringOptions } from './rel/spine.ts';
import { rankedOrderPlan, segmentPlan } from './rel/segment.ts';
import { createAppScope, createRequestScope } from '../scopes.ts';
import { servicesNamedBy } from '../services/params/call-params.ts';
import { Declines, UnsupportedTraversal } from './unsupported.ts';
import { CompileBudget, CompileBudgetExceeded, JoinWidthExceeded } from '../sql/kernel/budget.ts';
import { eachStepDeep, rawBodies } from './ir/walk.ts';
// Re-export the compile-output contract so execute.ts / tests keep importing it here.
export type { Compiled, Executable, Program, Shape, ValueType, ListOf, MapOf } from '../sql/kernel/render.ts';
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
export function compilePlan(gremlin: string, wireParams: Record<string, any>, options?: CompileOptions, wireParamTypes: Record<string, TypeNode> = {}): Plan {
  try { return compileUnguarded(gremlin, wireParams, options, wireParamTypes); }
  catch (error) { throw tooDeep(error) ?? expansionNamed(error, gremlin, wireParams, wireParamTypes) ?? error; }
}

/**
 * A compile past its WORK BUDGET (`CompileBudget`) says which part of the query expanded, in the user's
 * terms. The meter is charged deep in the emitter, which knows bytes and nodes but not the step the user
 * typed — the query text does. A bounded `repeat()` is the expansion a user can see and change (its body
 * is spelled once per iteration), so the largest `times(n)` at any depth is named; anything else is a
 * nesting whose text compounds per level, and the advice is to split the traversal.
 *
 * A SELECT past SQLite's join width (`JoinWidthExceeded`) is the same expansion seen by a different
 * limit: an unroll inside a per-traverser body fuses one join per iteration into one SELECT, while at the
 * top level each iteration is a step of its own — so that is what it suggests.
 */
function expansionNamed(error: unknown, gremlin: string, wireParams: Record<string, any>, wireParamTypes: Record<string, TypeNode>): CompileBudgetExceeded | JoinWidthExceeded | null {
  if (!(error instanceof CompileBudgetExceeded) && !(error instanceof JoinWidthExceeded)) return null;
  const { most, nested } = largestTimes(gremlin, wireParams, wireParamTypes);
  const loop = `or, for a body without a barrier step (order/limit/range/dedup/aggregate/…), bound it with until(loops().is(${most})), which runs as a loop rather than unrolled`;
  if (error instanceof JoinWidthExceeded) {
    return error.hinted(most > 1
      ? `repeat(…).times(${most}) unrolls into one join per iteration — lower the count, ${nested ? 'move the repeat() out of its child traversal (local/where/map/…) to the top level, where its iterations are not fused into one SELECT, ' : ''}${loop}`
      : 'its steps fuse into one join per step — split it into smaller traversals');
  }
  return error.hinted(most > 1
    ? `repeat(…).times(${most}) unrolls its body ${most} times — lower the count, ${loop}`
    : 'its steps nest so that each level spells the one before it again — split it into smaller traversals');
}

/** The largest `times(n)` at any depth of the query text — 0 when there is none, or the text is unreadable
 *  (the hint is a courtesy: an unreadable query keeps the plain decline) — and whether it sits inside a
 *  child traversal rather than on the root chain. */
function largestTimes(gremlin: string, wireParams: Record<string, any>, wireParamTypes: Record<string, TypeNode>): { readonly most: number; readonly nested: boolean } {
  const params = paramEnv(wireParams, wireParamTypes);
  const count = (s: { readonly name: string; readonly args?: readonly { readonly value?: unknown }[] }): number | undefined => {
    const n = s.name === 'times' ? (s.args ?? [])[0]?.value : undefined;
    return typeof n === 'number' ? n : undefined;
  };
  let most = 0;
  let root: readonly Parameters<typeof count>[0][] = [];
  try {
    const chain = stepChain(parseGremlin(gremlin), params);
    root = chain;
    eachStepDeep(chain, rawBodies(params), (s) => { const n = count(s); if (n !== undefined && n > most) most = n; });
  } catch { /* unreadable: no count to name */ }
  return { most, nested: !root.some((s) => count(s) === most) };
}

/**
 * A compile that ran out of STACK is a decline, never an internal error. Parsing, the Passes, the lowering
 * and the emitter all recurse over the traversal's NESTING, so the depth they reach is a property of the
 * query text (a repeat() unrolled to a large count, child traversals nested hundreds deep) and never of the
 * data — but WHERE it runs out is the runtime's: workerd's V8 stack is several times shallower than Bun's
 * (measured: `repeat(local(out().limit(1))).times(200)` overflows in a Durable Object and compiles on Bun).
 * So the backstop is here, at the one boundary every compile and every resumed segment crosses, rather
 * than as a per-shape depth guess that would decline what one runtime can compile to protect the other.
 */
function tooDeep(error: unknown): UnsupportedTraversal | null {
  if (!(error instanceof RangeError) || !/call stack/i.test(error.message)) return null;
  return UnsupportedTraversal.because('this traversal nests deeper than the compiler can follow — a repeat() unrolled to a large times() or loops() count, or child traversals nested hundreds deep, is the usual cause');
}

function compileUnguarded(gremlin: string, wireParams: Record<string, any>, options: CompileOptions | undefined, wireParamTypes: Record<string, TypeNode>): Plan {
  // THE PARAMETER ENVIRONMENT, built once (`paramEnv`): every parameter carries a type from here on (the
  // wire's where it declared one, the JS value's own otherwise — an untyped Boolean would otherwise be
  // stored, and compared, as 1/0), and a Float lands on its carrier before anything reads it. ONE value,
  // so every nested body re-parsed downstream reads the same types as the root chain.
  const params = paramEnv(wireParams, wireParamTypes);
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
  const { steps, discard } = runPasses(stepChain(tree, params), extractStrategies(tree, params), params, sideEffects);
  if (steps.length === 0) throw new UnsupportedTraversal('a traversal source with no steps');
  // The ONE whole-tree scan of the two namespaces a `Scoping` read resolves past the traverser's own Map
  // (side-effect keys, path labels) — `programScopeNames`. Every scope-key authority below, and the
  // lowering's scope readers that cannot SEE a scope (a keyed writer's side effect, a label bound before
  // a re-rooting step), consult this one answer.
  const scopeNames = programScopeNames(steps, params, [...sideEffects.keys(), ...sideEffectPolicies.keys()]);
  // A `where(P)` operand is a SCOPE KEY, not a value (`unresolvableWhereKey`): a non-String key is the
  // reference's construction-time refusal, raised here; a key the lowering's alias readers cannot
  // resolve as the reference does declines — once, at every depth. After the Passes, so a GQL `match()`'s
  // variables are the `as()` labels its desugar binds; the operand fold leaves every key-holding
  // `where(P)` as written (`foldConstantPredicateOperands`).
  if (unresolvableWhereKey(steps, params, scopeNames) !== null)
    throw new UnsupportedTraversal(gremlin);
  // A path label a SIDE EFFECT shadows is read as the side effect by every `Scoping` step, and every
  // label reader the lowering has reads the alias map instead — so the traversal declines here, once,
  // for all of them (`sideEffectShadowedLabel`).
  if (sideEffectShadowedLabel(scopeNames) !== null)
    throw new UnsupportedTraversal(gremlin);
  // A `from()`/`to()` sub-path the reference may THROW on (an absent or misordered label) declines here,
  // once, for every path-family host (`unlocatableSubPath`) — the lowering's sub-path would answer an
  // empty path instead. The message names the label.
  const unlocatable = unlocatableSubPath(steps, params);
  if (unlocatable !== null)
    throw UnsupportedTraversal.because(`a path()/simplePath()/cyclicPath() sub-path bounded by '${unlocatable}' is not supported: `
      + 'that label may be absent, or out of order, on a traverser reaching the step, so the sub-path cannot be located');
  // A NaN literal VALUE (SQLite stores it as NULL) declines here, once, at every depth (`uncarriedLiteral`).
  if (uncarriedLiteral(steps, params) !== null) throw new UnsupportedTraversal(gremlin);
  // A map- or set-valued EQUALITY operand or merge criterion (stored as JSON text, whose entry order is
  // not canonical) declines here, once, at every depth, naming why (`uncomparableLiteral`).
  if (uncomparableLiteral(steps, params) !== null) throw UnsupportedTraversal.because(UNCOMPARABLE_LITERAL);

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
  // extracted. Everything is a VALUE; nothing ambient crosses. The one piece of per-compile STATE beside
  // them is the decline-reason sink, created ONCE here so every route below (the wire read, each segment
  // head and resume, the ranked-order probe) records into the same one.
  const declines = new Declines();
  const relRequest = {
    declines,
    // The compile's ONE work meter, beside the decline sink and for its reason: every route below — the
    // wire read, each segment head and resume, the ranked-order probe — charges the same one.
    budget: options?.budget ?? new CompileBudget(),
    collapse: request.fastPaths.movementCollapse,
    propertySeek: request.fastPaths.propertySeek,
    ftsSubstringPredicate: request.fastPaths.ftsSubstringPredicate,
    detached: options?.detached ?? false,
    labelRegime: labelRegime(request.sourceOptions),
    services: servicesNamedBy(steps, request.params, request.registry),
    sack: sackInit,
    sideEffectPolicies,
    scopeNames,
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
  // A TERMINAL decline recorded anywhere below wins over whatever else the compile finds, a covered
  // sibling route included — it is checked after every route, and preferred over anything thrown after
  // it was recorded (`underDeclines`).
  return underDeclines(declines, () => {
    const segment = segmentPlan(steps, segmentRequest);
    declines.raiseTerminal();
    if (segment) return resumesUnder(segment, declines);

    const compiled = compileViaRel(relRequest, steps, request.params, sideEffects);
    declines.raiseTerminal();
    // A GLOBAL `order()` whose key SQL has no comparator for (a list/map/path — TinkerPop 4 ORDERABILITY)
    // is a ranked-order BARRIER, asked only now so no chain SQL already answers changes plan. A `discard()`
    // is applied to a single statement, which a segment is not, so it keeps declining.
    const ranked = compiled || discard ? null : rankedOrderPlan(steps, segmentRequest);
    declines.raiseTerminal();
    if (ranked) return resumesUnder(ranked, declines);
    // A DECLINE IS NOW THE ANSWER, not a route change. While two spines existed a `null` here meant
    // "the other one owns this"; with one spine it means the compiler cannot lower this traversal, and
    // saying so plainly is the only honest thing left to do with it. It is an ordinary query failure —
    // returned to the client on the trailer, not logged as an incident (root CLAUDE.md). An advisory
    // reason the lowering recorded rides along as a hint; it never replaces "no lowering covers".
    if (!compiled) throw declines.uncovered(gremlin);
    return { kind: 'sql', compiled: discard ? applyDiscard(compiled) : compiled };
  });
}

/**
 * Run one stretch of the compile under the decline sink. A terminal reason is the decline: it wins over
 * what the stretch returned, and over anything it THREW after the reason was recorded — the throw the
 * reason replaced would have stopped the compile before that later throw could happen.
 */
function underDeclines<T>(declines: Declines, stretch: () => T): T {
  let result: T;
  try { result = stretch(); } catch (error) { throw declines.terminalError() ?? tooDeep(error) ?? error; }
  declines.raiseTerminal();
  return result;
}

/** A segment's RESUMES lower at execute time into the same sink, so each is read under it too — a
 *  terminal reason recorded while planning a resume is that resume's decline, exactly as at compile time. */
function resumesUnder(plan: Plan, declines: Declines): Plan {
  if (plan.kind !== 'segment') return plan;
  if (plan.mode === 'sync') {
    const { resume } = plan;
    const guarded: SyncSegmentPlan['resume'] = (rows) => resumesUnder(underDeclines(declines, () => resume(rows)), declines);
    return { ...plan, resume: guarded };
  }
  const { resume } = plan;
  const guarded: AsyncSegmentPlan['resume'] = (out, rows) => resumesUnder(underDeclines(declines, () => resume(out, rows)), declines);
  return { ...plan, resume: guarded };
}

export { UnsupportedTraversal };

export function compile(gremlin: string, params: Record<string, any>, options?: CompileOptions, paramTypes: Record<string, TypeNode> = {}): Executable {
  const plan = compilePlan(gremlin, params, options, paramTypes);
  if (plan.kind === 'segment')
    throw new Error('a barrier step (a regex predicate, an async call()/io()) compiles to a segment plan that must be DRIVEN against a store — use an Executor (framed/framedAsync), not bare compile()');
  return plan.compiled;
}
