import { stepChain, isNested, type Step, type StrategySpec } from '../../gremlin/frontend.ts';

// ---------- pass BODIES: the concrete Step[]→Step[] rewrites (Seam 3) ----------
//
// This module holds the concrete rewrite functions + the strategy-classification Sets. The
// ORCHESTRATION — the categorized, ordered pipeline that sequences them (folds AND external
// withStrategies) with a fail-closed reject invariant — lives in ir/passes.ts, which wraps each
// function below as a Pass. There is no longer an internal/external seam here (the two used to be
// separate mechanisms in this file "sharing a name"); both are Passes, differing only by category.
//
// The folds are pure Step[]→Step[] rewrites applied once, up front, so the step compilers see a
// *canonical* chain and never do index arithmetic to gather a multi-step cluster. Keeping them as
// pure, independently testable transforms is what lets the dispatch stay a flat loop.
//
// The range/limit-before-vs-after-order() split is NOT a rewrite — it's the dispatch stop-boundary:
// range/limit/skip are prefix (CTE) steps until the prefix loop hits order()/a projection (a name
// absent from the prefix table), after which they fall to the tail as ORDER BY/LIMIT modifiers. So
// it lives in the dispatch itself, not here.

/**
 * A Step optionally carrying folded modulator data, so no step compiler ever
 * peeks at sibling steps:
 *  - `cluster` — the repeat/emit/times/until run (`foldRepeatClusters`).
 *  - `bys` — the trailing by() modulator arg-lists absorbed onto a host step
 *    (`foldByModulators`): order/select/project/group's by(), and the single
 *    by(key) an alias-compare where()/not() carries.
 * The compilers read these fields instead of re-scanning, so the whole read
 * dispatch is a peek-free fold over the step list.
 */
export type PStep = Step & { cluster?: Step[]; bys?: any[][]; options?: Step[]; productiveBy?: boolean; from?: string; to?: string; withArgs?: [string, any][] };

const REPEAT_CLUSTER = new Set(['repeat', 'emit', 'times', 'until']);
/** Steps that absorb trailing by() modulators. Alias-compare where()/not() also
 *  host a single by(key) but are detected structurally (see isAliasCompareWhere). */
const BY_HOSTS = new Set(['order', 'select', 'project', 'group', 'groupCount', 'path', 'math', 'format', 'sack', 'aggregate', 'dedup']);
/** Path-family steps additionally absorb from()/to() scoping modulators (a Path is scoped
 *  to the positions between two as() labels). `simplePath`/`cyclicPath` are hosts here only
 *  (not general BY_HOSTS) so their by()/from()/to() fold too. `to` also names a movement
 *  step; the fold only fires when it immediately follows a path host, so no collision. */
const PATH_MODULATOR_HOSTS = new Set(['path', 'simplePath', 'cyclicPath']);

// ---------- withStrategies / withoutStrategies: the decoration + verify bodies ----------
//
// The external TinkerPop TraversalStrategy layer. Every strategy TinkerPop implements as a
// decoration is, for us, a Step[]→Step[] rewrite that emits *synthetic steps the ordinary dispatch
// already compiles* — no new SQL machinery. The tree→spec extraction lives in frontend.ts
// (extractStrategies); the injectors/verifiers below are wrapped as decoration/verify Passes in
// ir/passes.ts. Decoration runs on the RAW chain (before the folds), so injected has()/where() are
// then canonicalised like any parsed step; verification asserts against the user's original chain.
//
// Split by whether ignoring a strategy could change the result set:
//  - Optimization strategies (below) are result-preserving by TinkerPop's own
//    contract (the suite proves it: withStrategies(X)/withoutStrategies(X) expect
//    identical rows). Our SQL does its own planning, so accepting them as NO-OPS is
//    correct-by-design.
//  - Semantic strategies (Subgraph/Partition) are honoured by *injecting the filter
//    they imply* into the chain.
//  - Verification strategies assert legality and throw the spec's exact message.
//  - ProductiveBy marks supported by()-consumers with an explicit null-productivity
//    policy; unsupported consumers fail closed.
//  - Everything else (Connective, Seed, Options, ElementId, OLAP, unknown) fails
//    CLOSED — a silently dropped semantic strategy would leak
//    unfiltered data. `withoutStrategies` is a safe no-op because we apply NO
//    strategy by default; a `without` of a strategy also named in `with` suppresses
//    it (handled by filtering `with` up front).

// The complete strategy taxonomy. Every strategy TinkerPop ships is classified into ONE
// handling: no-op / inject / verify / reject. "Unlisted → reject" (the catch-all) is the
// fail-closed backstop, but every KNOWN strategy is placed explicitly so its classification
// is a reviewable decision, not an accident of omission.
//
// NO-OP — result-preserving on our SQL-compiled OLTP engine (proven identical with/without
// by TinkerPop's own suite for the optimization set; inert-by-construction for the rest):
export const NO_OP_STRATEGIES = new Set([
  // Optimization strategies: SQLite's planner + our covering indexes do this work.
  'CountStrategy', 'IdentityRemovalStrategy', 'FilterRankingStrategy',
  'LazyBarrierStrategy', 'EarlyLimitStrategy', 'OrderLimitStrategy',
  'AdjacentToIncidentStrategy', 'IncidentToAdjacentStrategy', 'InlineFilterStrategy',
  'PathRetractionStrategy', 'PathProcessorStrategy', 'ByModulatorOptimizationStrategy',
  'RepeatUnrollStrategy', 'MatchAlgorithmStrategy', 'MatchPredicateStrategy',
  // GValue/requirement planning: subsumed by our q-kernel bound-value model (locked
  // decision #1 — no bytecode) and the absence of a traverser-requirement scheduler.
  'GValueReductionStrategy', 'ProviderGValueReductionStrategy', 'RequirementsStrategy',
  // OLAP/GraphComputer-only: inert without .withComputer(), which this project never
  // supports. (VertexProgramStrategy is NOT here — naming it explicitly requests OLAP, so
  // it must reject; ComputerVerification/VertexProgramRestriction only guard OLAP configs.)
  'GraphFilterStrategy', 'ComputerFinalizationStrategy', 'MessagePassingReductionStrategy',
  'ComputerVerificationStrategy', 'VertexProgramRestrictionStrategy', 'HaltedTraverserStrategy',
  // Lambda ban: our string grammar (locked decision #2/#5) has no lambda production, so the
  // condition these verify can never occur — a true no-op, not a skipped check.
  'LambdaRestrictionStrategy', 'StandardVerificationStrategy',
  // Metadata-only; we consult no provider hints. CAVEAT: OptionsStrategy/ProfileStrategy/
  // SeedStrategy stop being no-ops the day with()/profile()/coin()-sample() land — revisit then.
  'OptionsStrategy', 'ProfileStrategy', 'SeedStrategy',
  // ConnectiveStrategy's effect (infix .and()/.or() folding) is unconditionally applied as the
  // `fold` Pass of the same name (foldConnectives, this file), so REQUESTING it is a genuine
  // no-op; DISABLING it (withoutStrategies) is rejected — see ALWAYS_ON_STRATEGIES. Until
  // 2026-07-27 this claim was false: the fold lived inside the predicateInlining fast path, so it
  // applied only in a child body and only while that flag was on.
  'ConnectiveStrategy',
]);
// Strategies whose effect we apply unconditionally, so withoutStrategies() of them cannot be
// honored (rejecting fail-closed beats silently returning wrong rows — e.g.
// withoutStrategies(ConnectiveStrategy) expects infix .or() to become a no-op filter).
export const ALWAYS_ON_STRATEGIES = new Set(['ConnectiveStrategy']);
// NOT no-ops, deliberately absent so they hit the catch-all reject (fail closed): SackStrategy,
// SideEffectStrategy, EventStrategy (need a Java Supplier/listener — unreachable via string, but
// never laundered as safe), ElementIdStrategy (changes generated ids), ReferenceElementStrategy
// (property stripping — harmless only by our framing coincidence, not by contract),
// VertexProgramStrategy (OLAP). Each would change results if silently ignored.
export const VERIFICATION_STRATEGIES = new Set([
  'ReadOnlyStrategy', 'EdgeLabelVerificationStrategy', 'ReservedKeysVerificationStrategy',
]);
const PRODUCTIVE_BY_HOSTS = new Set(['group', 'groupCount', 'project', 'select', 'aggregate', 'order', 'path', 'where', 'not', 'dedup']);

/** ProductiveBy is semantic only at by()-consumers. Mark the supported hosts so they
 * choose a LEFT-domain/null policy explicitly; reject any other host rather than
 * pretending a traversal-wide strategy was honoured. */
export function markProductiveBy(steps: Step[]): Step[] {
  let host: string | undefined;
  for (const s of steps) {
    if (BY_HOSTS.has(s.name) || isAliasCompareWhere(s)) host = s.name;
    else if (s.name === 'by') {
      if (!host || !PRODUCTIVE_BY_HOSTS.has(host))
        throw new Error(`ProductiveByStrategy with ${host ?? 'unattached'} by() is not yet supported`);
    } else host = undefined;
  }
  return steps.map((s) => PRODUCTIVE_BY_HOSTS.has(s.name) || isAliasCompareWhere(s) || s.name === 'local'
    ? { ...s, productiveBy: true }
    : s);
}

// ---------- non-productive by() → an explicit drop in the IR ----------
//
// TinkerPop's DEFAULT by()-modulator is NON-PRODUCTIVE: a traverser for which the modulator yields
// nothing is DROPPED, not carried with a null. `ProductiveByStrategy` opts into the other policy
// (keep it, null sorts first) — which is why the strategy exists at all.
//
// WHERE THAT POLICY BELONGS. `productiveBy` is read at ~8 lowering sites today (group, select, path,
// dedup, aggregate…), each choosing its own JOIN-vs-LEFT-JOIN or its own WHERE. `order()` simply
// forgot, and `g.V().order().by('age')` kept the two ageless software vertices where TinkerPop
// returns four rows. Adding a ninth site would have been the small fix and the wrong one: it grows
// the same duplicated policy by one more copy, and the next order() lowering path (there are four
// already — the acc fold, the re-enter retype, the by(traversal) seam, the dedup window) would have
// to remember it independently.
//
// So express it once, in the IR, where it is *derivable*: for a by(KEY) over an element, "unproductive"
// means exactly "the property is absent", and dropping those traversers is exactly what `has(KEY)`
// already does. `order().by('age')` becomes `has('age').order().by('age')` — the same answer, built
// from a step that is already thoroughly tested, and every one of the four lowering paths inherits it
// because they all read the rewritten chain.
//
// THE RULE THIS ESTABLISHES, so the next by()-host doesn't have to guess:
//   • where unproductive means DROP → express it here as an injected filter; the lowering stays
//     ignorant of productivity.
//   • where unproductive means KEEP-WITH-NULL (group's null key, select's absent field, path's
//     unproductive position) → the lowering owns it, because a pre-filter cannot express "keep".
// order() is the first kind. Its ProductiveBy half needed no work: nulls already sort first, so the
// strategy-on case was already correct and only the default drop was missing.
//
// Runs in `decoration` (not `simplify`) for one reason: it reuses `recurseInject`, so a nested
// `repeat(__.order().by('age'))` gets the identical treatment, and pre-fold the chain is a flat
// `order` + `by` pair rather than a `.bys` cluster. Declared AFTER ProductiveByStrategy in the
// decoration array so a marked host is already visible here.

/** by() args → the property key it projects, or null when productivity is not a key question:
 *  a bare/direction-only by() (always productive), a `T.token` by() (every element has a label and
 *  an id), or a by(traversal) (its productivity is the traversal's, a different question this does
 *  not answer — and deliberately does not guess at). */
function byKey(args: readonly any[]): string | null {
  const first = args[0];
  return typeof first === 'string' ? first : null;
}

/**
 * Inject the non-productive drop for every key-projecting `by()` on a NON-productiveBy `order()`.
 *
 * Multi-term orders inject one `has()` per key, which is the same rule applied per comparator: every
 * comparator is evaluated for every traverser, so a traverser missing any one of the keys has nothing
 * to compare on and drops. Applying it per-key rather than only to the single-by() case keeps this
 * arity-blind — there is no special case to get wrong.
 */
export function dropNonProductiveOrderBy(steps: Step[], params: Record<string, any>): Step[] {
  return recurseInject(steps, params, (level) => {
    const out: Step[] = [];
    for (let i = 0; i < level.length; i++) {
      const s = level[i];
      // ProductiveByStrategy marked this host → the other policy applies; leave it to the lowering.
      if (s.name !== 'order' || (s as PStep).productiveBy) { out.push(s); continue; }
      // Pre-fold, the by()s are the steps immediately following their host.
      const keys: string[] = [];
      for (let j = i + 1; j < level.length && level[j].name === 'by'; j++) {
        const k = byKey(level[j].args);
        if (k !== null) keys.push(k);
      }
      for (const k of keys) out.push({ name: 'has', args: [k] } as Step);
      out.push(s);
    }
    return out;
  });
}

/** Steps whose output traverser is a vertex (a partition/subgraph vertex filter is
 *  injected after each). V()/E() are also the source step, at index 0. Includes otherV
 *  (an edge→endpoint landing) — TinkerPop's SubgraphStrategy filters EdgeOtherVertexStep
 *  too, so omitting it silently skipped the criterion after bothE().otherV(). */
const VERTEX_PRODUCERS = new Set(['V', 'out', 'in', 'both', 'outV', 'inV', 'bothV', 'otherV']);
/** Steps whose output traverser is an edge (a partition edge filter injects after). */
const EDGE_PRODUCERS = new Set(['E', 'outE', 'inE', 'bothE']);
/** Movement explosion (SubgraphStrategy edge criterion only). To filter the traversed
 *  EDGE, a vertex→vertex hop must first land on the edge: out→outE.inV, in→inE.outV,
 *  both→bothE.otherV — the same rewrite TinkerPop performs when an edgeCriterion is set.
 *  (otherV needs the entering-vertex context; see the trackFromV note in steps/child.ts.) */
const EXPLODE_EDGE: Record<string, string> = { out: 'outE', in: 'inE', both: 'bothE' };
const EXPLODE_FARV: Record<string, string> = { out: 'inV', in: 'outV', both: 'otherV' };
/** Edge-traversal steps EdgeLabelVerificationStrategy guards (a bare, unlabelled one
 *  is "a vertex step without any specified edge label"). */
const EDGE_TRAVERSAL_STEPS = new Set(['out', 'in', 'both', 'outE', 'inE', 'bothE', 'to']);
/** The mutating-step vocabulary — the one source of truth for "this traversal writes":
 *  ReadOnlyStrategy rejects any of these, and SubgraphStrategy defers over them (a write's
 *  endpoints aren't a post-hoc read filter). Add a new write step here, not in two places. */
const MUTATING_STEPS = new Set(['addV', 'addE', 'mergeV', 'mergeE', 'property', 'drop']);

export const rejectMsg = (name: string) =>
  `withStrategies(...) is not supported: '${name}' is a semantic or unknown strategy that would change results if ignored ` +
  `(e.g. PartitionStrategy/SubgraphStrategy filtering, ProductiveByStrategy null semantics). Rejected to fail closed.`;

/** A synthetic step (no real parse context of its own — it borrows the strategy's). */
const synth = (name: string, args: any[], ctx: StrategySpec['ctx']): Step => ({ name, args, ctx });

/** Wrap an already-lowered Step[] as a nested-traversal arg (the substrate: stepChain is
 *  idempotent on a Step[], so the synthetic body flows through every consumer verbatim). */
const nestedArg = (steps: Step[]): any => ({ nested: steps });

/** Does any step in the tree (at ANY nesting depth) satisfy `pred`? Recurses through every
 *  {nested} arg — the generalization of the old nestedProducesElements walk, now used to
 *  scan for movement/otherV/writes across sub-traversal bodies too. */
function someStepDeep(steps: Step[], params: Record<string, any>, pred: (s: Step) => boolean): boolean {
  return steps.some((s) =>
    pred(s) || s.args.some((a) => isNested(a) && someStepDeep(stepChain(a.nested, params), params, pred)));
}

/** Apply a per-chain injection rule at EVERY nesting depth. Postorder: each step's nested
 *  bodies are rewritten first (recursing, re-wrapped as `{nested: Step[]}`), THEN the rule
 *  runs on the current chain. This mirrors TinkerPop's strategy model — apply() runs once
 *  per traversal, recursing into every child traversal — so a filter lands on movement
 *  wherever it lives (local()/repeat()/union()/where(...) bodies included), with no
 *  fail-closed hole. The rule's OWN injected filters are added after the map, so the
 *  strategy never re-filters its own criterion bodies (TinkerPop's hidden-marker rule). */
function recurseInject(steps: Step[], params: Record<string, any>, applyLevel: (s: Step[]) => Step[]): Step[] {
  const withRewrittenChildren = steps.map((s) => ({
    ...s,
    args: s.args.map((a) => isNested(a)
      ? nestedArg(recurseInject(stepChain(a.nested, params), params, applyLevel))
      : a),
  }));
  return applyLevel(withRewrittenChildren);
}

/**
 * SubgraphStrategy: a rewritable-Step[] view over the whole traversal tree. Injects
 * `where(vertexCriterion)` after every vertex producer and `where(edgeCriterion)` after
 * every edge producer; enforces checkAdjacentVertices (a visible edge needs BOTH endpoints
 * in the subgraph) by testing inV+outV against the vertex criterion (the near endpoint is
 * already filtered upstream, so re-checking it is a redundant no-op — but check-both is
 * exactly correct AND avoids otherV's entering-vertex context, which a post-hoc filter over
 * a user's edge lacks). When an edge criterion is set, out/in/both are exploded to
 * outE.inV / inE.outV / bothE.otherV so the traversed edge itself can be filtered. Recurses
 * into nested bodies; criterion bodies are used verbatim (never re-subgraphed).
 */
export function injectSubgraphRec(steps: Step[], spec: StrategySpec, params: Record<string, any>): Step[] {
  if (spec.config.vertexProperties !== undefined)
    throw new Error('SubgraphStrategy(vertexProperties) criterion not yet supported');
  const vArg = spec.config.vertices;
  const eArg = spec.config.edges;
  if (vArg !== undefined && !isNested(vArg))
    throw new Error('SubgraphStrategy requires a vertices criterion traversal');
  if (eArg !== undefined && !isNested(eArg))
    throw new Error('SubgraphStrategy requires an edges criterion traversal');
  if (vArg === undefined && eArg === undefined)
    throw new Error('SubgraphStrategy requires a vertices or edges criterion');
  if (someStepDeep(steps, params, (s) => MUTATING_STEPS.has(s.name)))
    throw new Error('SubgraphStrategy over a mutating traversal (addV/addE/mergeV/mergeE/property/drop) is not yet supported');
  // Resolve criterion bodies ONCE; reused by reference at every injection site and never
  // fed back through recurseInject (the strategy never subgraph-filters its own criteria).
  const vCrit: Step[] | null = vArg ? stepChain(vArg.nested, params) : null;
  const eCrit: Step[] | null = eArg ? stepChain(eArg.nested, params) : null;
  // checkAdjacentVertices (default true): when a traverser lands ON an edge, require BOTH
  // its endpoints in the subgraph. Setting it false keeps an edge whose endpoint falls
  // outside the vertex criterion visible — so honour it, or we over-filter (mis-execute).
  const checkAdj = spec.config.checkAdjacentVertices !== false;
  const whereOf = (body: Step[]): Step => synth('where', [nestedArg(body)], spec.ctx);
  const vFilter = (): Step => whereOf(vCrit!);
  const adjacency = (): Step[] => [
    whereOf([synth('inV', [], spec.ctx), ...vCrit!]),
    whereOf([synth('outV', [], spec.ctx), ...vCrit!]),
  ];

  const applyLevel = (level: Step[]): Step[] => {
    const out: Step[] = [];
    for (const s of level) {
      // Movement explosion (edge criterion only): land on the edge, filter it, land on the
      // far endpoint, filter it. The NEAR endpoint was filtered by the previous producer.
      if (eCrit && s.name in EXPLODE_EDGE) {
        out.push(synth(EXPLODE_EDGE[s.name], s.args, s.ctx));
        out.push(whereOf(eCrit));
        out.push(synth(EXPLODE_FARV[s.name], [], s.ctx));
        if (vCrit) out.push(vFilter());
        continue;
      }
      out.push(s);
      if (VERTEX_PRODUCERS.has(s.name)) {
        if (vCrit) out.push(vFilter());
      } else if (EDGE_PRODUCERS.has(s.name)) {
        // A user-written edge-landing step (traverser stays on the edge): filter the edge,
        // then (unless checkAdjacentVertices:false) require both endpoints in the subgraph.
        if (eCrit) out.push(whereOf(eCrit));
        if (vCrit && checkAdj) out.push(...adjacency());
      }
    }
    return out;
  };
  return recurseInject(steps, params, applyLevel);
}

/** PartitionStrategy → inject has(partitionKey, within(readPartitions)) after every
 *  element-producing step (read visibility) and property(partitionKey, writePartition)
 *  after every addV/addE (write stamping), at every nesting depth. Read and write
 *  partitions are independent (TinkerPop allows writing to a partition you cannot read). */
export function injectPartitionRec(steps: Step[], spec: StrategySpec, params: Record<string, any>): Step[] {
  const key = spec.config.partitionKey;
  if (typeof key !== 'string')
    throw new Error('PartitionStrategy requires a string partitionKey');
  if (spec.config.includeMetaProperties === true)
    throw new Error('PartitionStrategy(includeMetaProperties) not yet supported');
  if (someStepDeep(steps, params, (s) => s.name === 'mergeV' || s.name === 'mergeE'))
    throw new Error('PartitionStrategy with mergeV()/mergeE() not yet supported (partition-aware upsert)');
  // readPartitions defaults to EMPTY, and the read filter is injected UNCONDITIONALLY
  // (matching TinkerPop's PartitionStrategy.Builder default + apply()): an omitted
  // readPartitions means "see nothing" (has(key, within([])) → 0 rows), NOT "see
  // everything". Gating on presence would leak all data for a writePartition-only
  // config — the exact failure this module exists to prevent.
  const readRaw = spec.config.readPartitions;
  const readVals: any[] = Array.isArray(readRaw) ? readRaw : readRaw == null ? [] : [readRaw];
  const writeVal = spec.config.writePartition;
  const applyLevel = (level: Step[]): Step[] => {
    const out: Step[] = [];
    for (const s of level) {
      out.push(s);
      if (VERTEX_PRODUCERS.has(s.name) || EDGE_PRODUCERS.has(s.name))
        out.push(synth('has', [key, { op: 'within', values: readVals }], spec.ctx));
      if (writeVal !== undefined && (s.name === 'addV' || s.name === 'addE'))
        out.push(synth('property', [key, writeVal], spec.ctx));
    }
    return out;
  };
  return recurseInject(steps, params, applyLevel);
}

/** Verification strategies assert legality against the user's (pre-injection) chain
 *  and throw the spec's canonical message; a passing traversal is a no-op. */
export function verify(spec: StrategySpec, steps: Step[]): void {
  if (spec.name === 'ReadOnlyStrategy') {
    const m = steps.find((s) => MUTATING_STEPS.has(s.name));
    if (m) throw new Error(`The provided traversal has a mutating step and thus is not read only: ${m.name}`);
  } else if (spec.name === 'EdgeLabelVerificationStrategy') {
    if (spec.config.throwException !== true) return; // default warns only → no-op
    const bad = steps.find((s) => {
      if (!EDGE_TRAVERSAL_STEPS.has(s.name)) return false;
      if (s.args.some((a) => typeof a === 'string')) return false; // has an edge label → fine
      // `to` is a vertex step ONLY in the to(Direction[,labels]) form; the addE endpoint
      // modulators to(__.V(...))/to('alias') are NOT vertex steps → never flag them.
      if (s.name === 'to') return s.args.some((a) => a && typeof a === 'object' && 'direction' in a);
      return true;
    });
    if (bad) throw new Error(`The provided traversal contains a vertex step without any specified edge label: ${bad.name}()`);
  } else if (spec.name === 'ReservedKeysVerificationStrategy') {
    if (spec.config.throwException !== true) return; // default warns only → no-op
    const k = spec.config.keys;
    // keys is canonically a SET literal ({a,b}) → a JS Set; also accept a list or a bare
    // scalar for leniency. (Before set-literal parsing landed, {a} arrived as a bare scalar.)
    const reserved = new Set<string>(k == null ? ['id', 'label'] : k instanceof Set ? [...k] as string[] : Array.isArray(k) ? k : [k]);
    for (const s of steps)
      if (s.name === 'property' && typeof s.args[0] === 'string' && reserved.has(s.args[0]))
        throw new Error(`The provided traversal is setting a property key to a reserved word: ${s.args[0]}`);
  }
}

// Strategy application (withoutStrategies suppression, no-op filtering, decoration injection,
// verification, and the fail-closed reject) now lives in the unified Pass pipeline — see
// ir/passes.ts (DECORATION + VERIFY groups + runPasses). This module keeps the concrete
// inject/verify/fold BODIES + the classification Sets those passes wrap; it no longer owns the
// orchestration.

/** Absorb every `with(key, value)` step immediately following a `call` onto that call's
 *  `withArgs`, mirroring foldByModulators — so the call() compiler reads its modulators
 *  without peeking at siblings. `value` may be a string/literal OR a `{nested}` traversal
 *  (`__.constant(...)`); both are carried verbatim and resolved to a constant later
 *  (call-params.ts). A `with()` NOT preceded by a call() is left untouched (it is not a
 *  supported step elsewhere, so it will fail closed at dispatch if it ever appears). */
export function foldCallWith(steps: PStep[]): PStep[] {
  const out: PStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.name !== 'call') { out.push(s); continue; }
    const withArgs: [string, any][] = [];
    let j = i + 1;
    for (; j < steps.length && steps[j].name === 'with'; j++) {
      const [k, v] = steps[j].args;
      if (typeof k !== 'string') throw new Error('call().with() key must be a string');
      withArgs.push([k, v]);
    }
    out.push(withArgs.length ? { ...s, withArgs } : s);
    i = j - 1;
  }
  return out;
}


// The OptionsStrategy tokens key + selector values. The JS GLV resolves WithOptions.tokens to the
// STRING '~tinkerpop.valueMap.tokens' and WithOptions.all/.ids/.labels to the INTEGER bitmask
// 15/1/2 before it serializes the query, so the wire form is with('~…tokens'[, 15]); a query typed
// straight at our server may instead carry the {withOption} enum the frontend captures. Both are
// recognised here. `all` (15) selects id+label = valueMap(true); a proper subset (ids/labels/…)
// has no valueMap(true) equivalent yet.
const VALUEMAP_TOKENS_KEY = '~tinkerpop.valueMap.tokens';
const WITH_ALL = 15;
const isTokensArg = (a: any): boolean =>
  a === VALUEMAP_TOKENS_KEY || (a && typeof a === 'object' && a.withOption === 'tokens');
const isAllArg = (a: any): boolean =>
  a === WITH_ALL || (a && typeof a === 'object' && a.withOption === 'all');

// ---------- constant predicate operands ----------
//
// TinkerPop lets a predicate's right-hand OPERAND be a traversal, evaluated per traverser, and
// compares against its first result: `is(__.constant(29))`, `has("age", P.gt(__.constant(29)))`,
// `where(P.gt(__.constant(29)))`, `hasKey(__.constant("age"))`. A traversal that does not read the
// traverser at all — a bare `constant(x)` — IS its value, so folding it to the literal here makes
// every one of those forms lower through the ordinary predicate path, at every host at once.
//
// A Pass rather than per-host handling because the operand grammar is host-independent: `values`
// inside a P nests identically wherever the P appears, and `normalize()` runs the pipeline over
// every nested body (childSteps → normalize), so this reaches any depth for free.
//
// Only a bare constant folds. A genuinely per-traverser operand (`has("name",
// __.V(1).out("knows").values("name"))`) is left in place and fails closed at render (predicateSql
// rejects a traversal operand with a clear deferral) — never silently dropped or mis-bound.

/** The literal a nested traversal is worth, or `undefined` when it is not a bare constant. A
 *  parse needing params we do not have (a nested normalize runs param-free) simply declines. */
function constantOperand(nested: any, params: Record<string, any>): { value: any } | undefined {
  let body: Step[];
  try { body = stepChain(nested, params); } catch { return undefined; }
  if (body.length !== 1 || body[0].name !== 'constant') return undefined;
  const args = body[0].args ?? [];
  if (args.length !== 1) return undefined;
  const v = args[0];
  // Primitives only: a nested/objecty constant arg is not a comparable literal, and `undefined`
  // means the parse resolved a placeholder we could not see.
  if (v === null) return { value: null };
  return ['string', 'number', 'boolean', 'bigint'].includes(typeof v) ? { value: v } : undefined;
}

/** Steps whose args are VALUES to compare against, never traversal predicates — so a nested
 *  traversal in one of these slots is an operand. `where`/`filter`/`not`/`and`/`or` are absent on
 *  purpose: a nested traversal there is a PREDICATE BODY (`where(__.out())`), and folding it would
 *  turn a filter into a comparison. Their P-wrapped operands still fold, via `values` below. */
const VALUE_OPERAND_SLOTS: Record<string, (args: readonly any[]) => readonly number[]> = {
  is: () => [0],
  hasKey: (a) => a.map((_, i) => i),
  hasValue: (a) => a.map((_, i) => i),
  hasId: (a) => a.map((_, i) => i),
  hasLabel: (a) => a.map((_, i) => i),
  // has(key, X) → slot 1; has(label, key, X) → slot 2. has(key) alone has no operand.
  has: (a) => (a.length === 2 ? [1] : a.length === 3 ? [2] : []),
};

/** Fold constants inside a predicate object's `values`, recursively (P.not(P.gt(…)) nests). */
function foldPredOperands(pred: any, params: Record<string, any>): any {
  if (!pred || typeof pred !== 'object' || !('op' in pred) || !Array.isArray((pred as any).values)) return pred;
  return {
    ...pred,
    values: (pred as any).values.map((v: any) => {
      if (isNested(v)) { const c = constantOperand(v.nested, params); return c ? c.value : v; }
      return foldPredOperands(v, params);
    }),
  };
}

export function foldConstantPredicateOperands(steps: PStep[], params: Record<string, any>): PStep[] {
  return steps.map((s) => {
    const slots = VALUE_OPERAND_SLOTS[s.name]?.(s.args ?? []) ?? [];
    let changed = false;
    const args = (s.args ?? []).map((a: any, i: number) => {
      if (slots.includes(i) && isNested(a)) {
        const c = constantOperand(a.nested, params);
        if (c) { changed = true; return c.value; }
        return a;
      }
      const folded = foldPredOperands(a, params);
      if (folded !== a) changed = true;
      return folded;
    });
    return changed ? { ...s, args } : s;
  });
}

/** Hosts BEYOND the predicate operands whose nested args are evaluated for a VALUE rather than
 *  run as a traversal body: the `V(ids)`/`E(ids)` id argument and `property()`'s arguments. Only
 *  the read-only verification uses these — the constant fold stays on the operand slots, where a
 *  literal is unambiguously equivalent. */
const READONLY_CHILD_HOSTS: Record<string, (args: readonly any[]) => readonly number[]> = {
  V: (a) => a.map((_, i) => i),
  E: (a) => a.map((_, i) => i),
  property: (a) => a.map((_, i) => i),
};

/** Every nested traversal sitting in a VALUE-argument slot of `s` — the operand slots shared with
 *  the constant fold, plus the id/property hosts above, plus operands nested inside a P. */
function valueArgTraversals(s: Step): any[] {
  const slots = [
    ...(VALUE_OPERAND_SLOTS[s.name]?.(s.args ?? []) ?? []),
    ...(READONLY_CHILD_HOSTS[s.name]?.(s.args ?? []) ?? []),
  ];
  const out: any[] = [];
  (s.args ?? []).forEach((a: any, i: number) => {
    if (slots.includes(i) && isNested(a)) out.push(a.nested);
    // …and operands wrapped in a predicate: has("name", P.eq(__.addV(…))).
    const preds: any[] = a && typeof a === 'object' && 'op' in a && Array.isArray(a.values) ? [a] : [];
    while (preds.length) {
      const pr = preds.pop();
      for (const v of pr.values) {
        if (isNested(v)) out.push(v.nested);
        else if (v && typeof v === 'object' && 'op' in v && Array.isArray(v.values)) preds.push(v);
      }
    }
  });
  return out;
}

/** StandardVerificationStrategy's read-only child rule: a child traversal evaluated for a VALUE
 *  must not mutate. TinkerPop rejects `has("name", __.addV("x").values("name"))`,
 *  `is(P.gt(__.addV("x").values("age")))`, `V(__.addV("x").id())`, `property(__.addV("t")…)` and
 *  friends with a message containing "mutating step" (StandardVerificationStrategy.feature).
 *
 *  Deliberately scoped to VALUE-argument positions, NOT "every child traversal": a write is
 *  perfectly legal in a branch/side-effect body (`union(__.addV("person"), …)`,
 *  `choose(p, __.addV(…), …)`), and rejecting those would break working write traversals. The
 *  rule is about arguments that must resolve to a value, which is why it shares
 *  VALUE_OPERAND_SLOTS with the constant fold — one declaration of "this slot holds a value".
 *
 *  ALWAYS ON, like TinkerPop's: it is a standard strategy, not opt-in, so the Pass carries no
 *  `applies` gate. Naming it in withStrategies() stays a no-op (it is already applied). */
export function verifyReadOnlyChildren(steps: PStep[], params: Record<string, any>): void {
  const scan = (chain: Step[]) => {
    for (const s of chain) {
      for (const nested of valueArgTraversals(s)) {
        let body: Step[];
        try { body = stepChain(nested, params); } catch { continue; }
        const m = body.find((x) => MUTATING_STEPS.has(x.name))
          ?? (someStepDeep(body, params, (x) => MUTATING_STEPS.has(x.name)) ? { name: 'a nested write' } as Step : undefined);
        if (m) throw new Error(`The child traversal of ${s.name}() contains a mutating step (${m.name}) and thus is not read only: a mutating step is not allowed in a value-argument child traversal`);
      }
      // recurse into every OTHER nested body so a bad operand nested deep still trips
      for (const a of s.args ?? []) {
        if (!isNested(a)) continue;
        try { scan(stepChain(a.nested, params)); } catch { /* unparseable without params — skip */ }
      }
    }
  };
  scan(steps as Step[]);
}

/** Desugar `valueMap().with(WithOptions.tokens)` onto the valueMap step. The tokens option with no
 *  selector (or the all selector) is exactly `valueMap(true)`: include the id+label tokens, which
 *  the valueMap projector already reads off a `true` arg. So append the `true` flag and drop the
 *  with(). SELECTIVE token subsets (with(tokens, ids|labels|…), which pick a proper token subset and
 *  pair with a by(unfold) that also flattens the value lists) have no valueMap(true) equivalent yet,
 *  so they are LEFT in place to fail closed at dispatch — never silently widened to all-tokens. A
 *  with() on any other host is untouched (call().with() folds in foldCallWith; every other with()
 *  falls through to its clear "cannot consume" deferral). */
export function foldValueMapWith(steps: PStep[]): PStep[] {
  const out: PStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const w = steps[i + 1];
    const wargs: any[] = s.name === 'valueMap' && w?.name === 'with' ? (w.args ?? []) : [];
    // Desugar only the all-tokens forms: with(tokens) or with(tokens, all).
    const allTokens = wargs.length >= 1 && isTokensArg(wargs[0])
      && (wargs.length === 1 || (wargs.length === 2 && isAllArg(wargs[1])));
    if (!allTokens) { out.push(s); continue; }
    out.push(s.args.includes(true) ? s : { ...s, args: [true, ...s.args] });
    i += 1; // consume the with()
  }
  return out;
}

/** `fold().count(Scope.local)` counts the one folded list's size = the number of upstream
 *  elements = `count()`. A provable identity that also unblocks group value children like
 *  by(__.out().order().fold().count(Scope.local)) (then dropRedundantOrder removes the
 *  order). Runs before dropRedundantOrder so the resulting order().count() is caught. */
export function collapseFoldCountLocal(steps: PStep[]): PStep[] {
  const out: PStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const next = steps[i + 1];
    if (s.name === 'fold' && !s.bys && next?.name === 'count'
      && next.args.some((a: any) => a && typeof a === 'object' && a.scope === 'local')) {
      out.push({ ...next, args: next.args.filter((a: any) => !(a && typeof a === 'object' && a.scope === 'local')) });
      i++; // consume both fold and count(Scope.local)
      continue;
    }
    out.push(s);
  }
  return out;
}

/** Reducers whose result is independent of input order. */
const ORDER_INSENSITIVE_REDUCERS = new Set(['count', 'sum', 'min', 'max', 'mean']);

/** Drop a keyless `order()` immediately before an order-insensitive reducer: it is a
 *  provable no-op (count/sum/min/max/mean ignore order, and a keyless order filters
 *  nothing — unlike order().by(key), which may drop missing-key traversers, so that form
 *  is left intact). Runs after foldByModulators so an order carrying a by() has its `.bys`
 *  set and is skipped. Unblocks group value children like by(__.out().order().count())
 *  and is a general optimization for root chains too. */
export function dropRedundantOrder(steps: PStep[]): PStep[] {
  const out: PStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.name === 'order' && !s.bys && ORDER_INSENSITIVE_REDUCERS.has(steps[i + 1]?.name)) continue;
    out.push(s);
  }
  return out;
}

/** v4 iterate() appends a trailing discard() (or bare none()): execute, return
 *  nothing. Pop the marker and flag it. A `none(pred)` with a predicate is NOT the
 *  discard marker — it's the NoneStep collection filter (kept for compilation). */
export function stripTerminal(steps: Step[]): { steps: Step[]; discard: boolean } {
  const last = steps[steps.length - 1];
  if (last && (last.name === 'discard' || (last.name === 'none' && last.args.length === 0)))
    return { steps: steps.slice(0, -1), discard: true };
  return { steps, discard: false };
}

// ---------- ConnectiveStrategy: infix .and()/.or() → the step form ----------
//
// `has(a).and().has(b)` ≡ `and(__.has(a), __.has(b))`. TinkerPop does this in ConnectiveStrategy
// (a DECORATION strategy — one apply() per traversal, recursing into every child), and the two
// spellings must be indistinguishable downstream. Ours is a `fold` Pass because that is what the
// category means here: canonicalize a multi-step shape so no compiler does index arithmetic.
//
// It used to live inside the predicateInlining FAST PATH (predicate.ts splitInfixConnectors), which
// was wrong three ways and measurably so: the infix form only worked in a CHILD BODY (top-level
// `g.V().has(x).and().has(y)` threw `and() needs at least two traversal branches`), it vanished when
// the fast-path flag was flipped off (6 corpus traversals — so the flag's declared
// enabled≡disabled contract was false), and NO_OP_STRATEGIES already claimed the effect was
// "unconditionally baked into our compiler", which it was not. As a Pass it is unconditional and
// flag-independent, so all three statements become true at once.
//
// Precedence: OR binds looser than AND, so split on OR first and let each segment recurse (an
// inner AND folds inside it). Empty operand → throw, never a silent drop.

/** A BARE connective — the infix `.and()`/`.or()` with no traversal args. The step FORM
 *  `and(__.a, __.b)` carries nested args and is already canonical, so it is left alone. */
const isBareConnective = (s: Step, name: 'and' | 'or'): boolean => s.name === name && !s.args.some(isNested);

/** Steps a connective's LEFT operand must NOT absorb — mirroring TinkerPop's
 *  `ConnectiveStrategy.legalCurrentStep`, which excludes GraphStep/StartStep so that
 *  `g.V().has(a).or().has(b)` folds to `g.V().or(…)` rather than swallowing the source.
 *  Ours is the same idea in IR terms: a SOURCE or a WRITE step anchors the chain and stays
 *  outside the fold. (A child body has none of these, which is why the old child-only
 *  implementation never needed the rule.) */
const CONNECTIVE_ANCHORS = new Set(['V', 'E', 'inject', 'call', 'addV', 'addE', 'mergeV', 'mergeE']);

/** How far the leading ANCHOR run extends — the steps held out of the fold and re-prepended.
 *
 *  It absorbs trailing `as()` steps, and that is a real semantic difference from TinkerPop rather
 *  than a convenience: in TinkerPop a label is not a step at all (`g.V().as("a")` labels the
 *  GraphStep), so its backward walk stops at `V()` with the label still attached to it. In OUR IR
 *  `as` IS a step that labels whatever precedes it, so an `as` sitting on an anchor has to travel
 *  with the anchor — otherwise `g.V().as("a").out("knows").and().out("created")` would fold the
 *  bind INTO the filter branch, where it is confined, and a later `select("a")` would read a label
 *  that is no longer bound on the outer traverser. An `as` further along (`out().as("a").and()…`)
 *  is absorbed with ITS step, which is what TinkerPop does too. */
function anchorRunLength(steps: Step[]): number {
  let a = 0;
  // `a > 0` so a body that merely STARTS with as() (a child body: `__.as("b").out()`) keeps it
  // inside the fold — there is no anchor there for the label to belong to.
  while (a < steps.length && (CONNECTIVE_ANCHORS.has(steps[a].name) || (a > 0 && steps[a].name === 'as'))) a++;
  return a;
}

/** Split `steps` on the bare connective of the LOOSEST precedence present. Returns the operator,
 *  the segments between its connectors, and the first connective step (whose parse context the
 *  synthetic step borrows, so an error still points at the user's own `.and()`/`.or()`). Null when
 *  there is no bare connective. */
function splitOnConnective(steps: Step[]): { name: 'and' | 'or'; segments: Step[][]; at: Step } | null {
  const name: 'and' | 'or' | null = steps.some((s) => isBareConnective(s, 'or')) ? 'or'
    : steps.some((s) => isBareConnective(s, 'and')) ? 'and' : null;
  if (name === null) return null;
  const segments: Step[][] = [[]];
  let at: Step | null = null;
  for (const s of steps) {
    if (isBareConnective(s, name)) { at ??= s; segments.push([]); }
    else segments[segments.length - 1].push(s);
  }
  return { name, segments, at: at! };
}

/** One chain level: fold its bare connectives into the step form. The leading anchor run
 *  (source/write steps) is held out and re-prepended, so the fold never swallows `V()`. */
function foldConnectivesLevel(steps: Step[]): Step[] {
  if (!steps.some((s) => isBareConnective(s, 'and') || isBareConnective(s, 'or'))) return steps;
  const a = anchorRunLength(steps);
  const anchors = steps.slice(0, a);
  const split = splitOnConnective(steps.slice(a));
  if (!split) return steps;
  if (split.segments.some((seg) => seg.length === 0))
    throw new Error('malformed infix .and()/.or() connector (empty operand)');
  // Each segment may still hold a higher-precedence connective — recurse before wrapping.
  const args = split.segments.map((seg) => nestedArg(foldConnectivesLevel(seg)));
  return [...anchors, synth(split.name, args, split.at.ctx)];
}

/** ConnectiveStrategy, at EVERY nesting depth (postorder) — so a connective inside a
 *  `where()`/`choose()`/`until()` body folds by the same rule as one at the root, with no
 *  per-position vocabulary.
 *
 *  It does NOT use `recurseInject`, and the difference matters: that helper rebuilds EVERY nested
 *  arg as a `{nested: Step[]}`, which is fine for a decoration pass (gated on a strategy the user
 *  named) but not for an unconditional one. A `{nested}` arg may still be a raw PARSE TREE, and one
 *  consumer needs it to stay that way — `services/params/traversal-param.ts` un-parses a
 *  `call().with("traversal", __.V())` sub-traversal back to a Gremlin string via the client's
 *  TranslateVisitor, which requires `tree.accept`. Rewriting untouched args to Step[] broke every
 *  federate param with `tree.accept is not a function`. So this recursion is IDENTITY-PRESERVING:
 *  an arg (and a whole level) the fold does not change is returned by reference, and only a branch
 *  that genuinely folded is rebuilt. */
export function foldConnectives(steps: Step[], params: Record<string, any>): PStep[] {
  let anyChild = false;
  const mapped = steps.map((s) => {
    let changed = false;
    const args = s.args.map((a) => {
      if (!isNested(a)) return a;
      const inner = stepChain(a.nested, params);
      const folded = foldConnectives(inner, params);
      if (folded === inner) return a; // untouched → keep the ORIGINAL arg, parse tree intact
      changed = true;
      return nestedArg(folded);
    });
    if (!changed) return s;
    anyChild = true;
    return { ...s, args };
  });
  return foldConnectivesLevel(anyChild ? mapped : steps) as PStep[];
}

/**
 * Gather each contiguous repeat/emit/times/until run into ONE step carrying the
 * cluster. The modulators can sit either side of repeat(); the run stops at the
 * first REPEATED step name so a second repeat-loop isn't swallowed — it folds as
 * its own cluster, correctly chained on this one's output. The folded step is
 * anchored on repeat() when present (so it dispatches to the branch compiler),
 * else on the first cluster step (so a stray emit()/times()/until() without
 * repeat() still reaches its "without repeat()" throw). Validation and SQL build
 * stay in the branch compiler — this pass only removes the index arithmetic.
 */
export function foldRepeatClusters(steps: Step[]): PStep[] {
  const out: PStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (!REPEAT_CLUSTER.has(steps[i].name)) { out.push(steps[i]); continue; }
    const cluster: Step[] = [];
    const seen = new Set<string>();
    let j = i;
    while (j < steps.length && REPEAT_CLUSTER.has(steps[j].name) && !seen.has(steps[j].name)) {
      seen.add(steps[j].name); cluster.push(steps[j]); j++;
    }
    const anchor = cluster.find((s) => s.name === 'repeat') ?? cluster[0];
    out.push({ ...anchor, cluster });
    i = j - 1;
  }
  return out;
}

/** An alias-compare where("a", P)/where(P)/not(P) — its arg0 is a label string or
 *  a Pred, NOT a nested traversal. Only these host a by(key) modulator (a
 *  where(__.trav) is modulated by nothing, so a trailing by() there stays a stray
 *  step and reaches its "by() only supported as an order()/select() modulator"
 *  throw — never silently absorbed). */
function isAliasCompareWhere(s: Step): boolean {
  if (s.name !== 'where' && s.name !== 'not') return false;
  const a = s.args[0];
  return typeof a === 'string' || (a != null && typeof a === 'object' && 'op' in a);
}

/** Absorb each host step's trailing contiguous by() steps into `host.bys`. The
 *  order()/select()/project()/group() modulators and an alias-compare where()'s
 *  single by(key) all become a field on their host, so the tail dispatch reads
 *  `.bys` and never looks at the next step. by() validation (token/traversal
 *  modulators still unsupported) stays in the compilers that read `.bys`. */
export function foldByModulators(steps: PStep[]): PStep[] {
  const out: PStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const pathHost = PATH_MODULATOR_HOSTS.has(s.name);
    if (!BY_HOSTS.has(s.name) && !pathHost && !isAliasCompareWhere(s)) { out.push(s); continue; }
    const bys: any[][] = [];
    let from: string | undefined, to: string | undefined;
    let j = i + 1;
    for (; j < steps.length; j++) {
      const m = steps[j];
      if (m.name === 'by') { bys.push(m.args); continue; }
      // from()/to() are path-scoping modulators only on a path-family host.
      if (pathHost && m.name === 'from' && typeof m.args[0] === 'string') { from = m.args[0]; continue; }
      if (pathHost && m.name === 'to' && typeof m.args[0] === 'string') { to = m.args[0]; continue; }
      break;
    }
    const folded = bys.length || from !== undefined || to !== undefined
      ? { ...s, ...(bys.length ? { bys } : {}), ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) }
      : s;
    out.push(folded);
    i = j - 1;
  }
  return out;
}

/** Absorb each choose()'s trailing contiguous option() steps into `choose.options`
 *  — the option-map form choose(choiceFn).option(key, traversal)…. A choose with no
 *  trailing option() is the predicate form (untouched → the prefix branch compiler).
 *  The compiler reads `.options` and never scans siblings. */
export function foldChooseOptions(steps: PStep[]): PStep[] {
  const out: PStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.name !== 'choose') { out.push(s); continue; }
    const options: Step[] = [];
    let j = i + 1;
    for (; j < steps.length && steps[j].name === 'option'; j++) options.push(steps[j]);
    out.push(options.length ? { ...s, options } : s);
    i = j - 1;
  }
  return out;
}

// ---------- WhereEndStep: a label on a where()-body's last step is a CONSTRAINT ----------

/** PURE. The string labels an `as()` step binds (`as('a','b')` binds both). */
const asLabelsOf = (s: Step): string[] =>
  s.name === 'as' ? (s.args ?? []).filter((a: any): a is string => typeof a === 'string') : [];

/** PURE. The labels a `match()` step binds — the `as(start)`/`as(end)` wrapping each of its pattern
 *  arguments. A step's OWN `as()` is not the only way a label enters scope, and match() is the case
 *  that matters here: it binds inside its arguments, so a chain that reads `where(__.as('c')…)`
 *  after a match() sees a label this pass would otherwise call unbound and throw on — even though
 *  the lowering carries the column perfectly well. Syntactic and shape-free, exactly like
 *  `asLabelsOf`: the pattern body is re-read with the same `stepChain` primitive every other scanner
 *  in this file uses, and a FILTER argument (`not(…)`/`where(…)`, which binds nothing — see
 *  prefix/match.ts) contributes no label because it does not open with `as()`. */
const matchLabelsOf = (s: Step, params: Record<string, any>): string[] => {
  if (s.name !== 'match') return [];
  const out: string[] = [];
  for (const a of s.args ?? []) {
    if (!isNested(a)) continue;
    const chain = stepChain((a as any).nested, params);
    if (chain[0]?.name !== 'as') continue;
    out.push(...asLabelsOf(chain[0]));
    if (chain.length > 1) out.push(...asLabelsOf(chain[chain.length - 1]));
  }
  return out;
};

/** The connective hosts TinkerPop's `WhereTraversalStep.configureStartAndEndSteps` recurses
 *  THROUGH when locating a where()-body's start and end: a ConnectiveStep (`and`/`or`) or a
 *  `not`. Their children are each configured in turn, so `where(__.and(__.as('a').out().as('b'),
 *  …))` gives every branch its own start/end treatment. Nothing else recurses — an ordinary
 *  nested body inside the where() is a traversal in its own right, and reaches this rewrite as
 *  its OWN where() host rather than as part of this one. */
const WHERE_CONNECTIVES = new Set(['and', 'or', 'not']);

/** The match() argument heads that are FILTERS: they constrain the binding table and bind nothing,
 *  so their labels are variable REFERENCES and take the where()-style variable-location rewrite.
 *
 *  ONE definition, used by both halves — this pass (which rewrites the labels) and match()'s
 *  lowering (which routes the argument to the `where` StepFn). An argument treated as a filter by
 *  one and a pattern by the other would silently mis-execute, so they cannot be separate lists.
 *
 *  The conjunctions are deliberately absent: in match() position `and`/`or` are pattern GROUPS that
 *  BIND their nested ends (the official corpus asserts `c`/`d` come back in the binding map for
 *  `match(…, and(as("a").out("created").as("c"), …))`), so rewriting their labels to constraints
 *  would answer a narrower question. `not()` binds nothing, and a two-arg `where("a", P.neq("c"))`
 *  only compares two already-bound variables. */
export const MATCH_FILTER_HEADS = new Set(['where', 'filter', 'not']);

/**
 * TinkerPop routes `where(traversal)` by VARIABLE LOCATION (`GraphTraversal.where` →
 * `TraversalHelper.getVariableLocations`): a label on the body's FIRST step is a `WhereStartStep`
 * (re-root the predicate on what the label holds) and a label on its LAST step is a
 * `WhereEndStep` — an equality CONSTRAINT that the object reached must BE what the label already
 * holds. Only a label in the MIDDLE is an ordinary bind.
 *
 * So `where(__.as("a").out("knows").as("b"))` asks "does a know b", NOT "does a know somebody",
 * and reading that trailing `as()` as a bind silently answers the weaker question. This rewrites
 * the end label into a form both lowerings already implement — `__.X.as('b')` → `__.X.where(
 * P.eq('b'))`, filter.ts's alias-compare — rather than teaching either one a new constraint.
 * Doing it as a Pass is what keeps the inline fast path and the materialized child-existence gate
 * answering identically: neither ever sees the end-label shape.
 *
 * SCOPED to a label bound earlier in the ENCLOSING chain — TinkerPop's own notion of a scope key,
 * and syntactic, so a Pass can see it. A label bound nowhere is left alone: TinkerPop errors on it
 * (the path lookup fails), while we keep the project-wide drop-not-throw reading of an unbound
 * label rather than introducing a new throw here.
 *
 * The START half rides along for the same reason — see rewriteStartLabel.
 */
function rewriteWhereVariables(body: Step[], bound: ReadonlySet<string>, params: Record<string, any>): Step[] {
  if (!body.length) return body;
  const last = body[body.length - 1];
  // Recurse THROUGH a connective: each branch carries its own start/end, exactly as upstream's
  // configureStartAndEndSteps walks the ConnectiveStep/NotStep children.
  if (WHERE_CONNECTIVES.has(last.name) && (last.args ?? []).some(isNested)) {
    const rebuilt = { ...last, args: last.args.map((a: any) => (isNested(a)
      ? nestedArg(rewriteWhereVariables(stepChain(a.nested, params), bound, params))
      : a)) };
    return [...body.slice(0, -1), rebuilt];
  }
  body = rewriteStartLabel(body, bound);
  return rewriteEndLabel(body, bound);
}

/** START: a lone `as('a')` on the body's FIRST step re-roots the predicate on what `a` holds
 *  (`StartStep.isVariableStartStep`, which requires exactly one label). `select('a')` IS that
 *  re-root and BOTH lowerings already implement it — the inline compiler re-roots its ScalarCtx,
 *  and the generic gate crosses it through the engine's one element-body fold. Rewriting to it
 *  here is what keeps the two agreeing; before, only the inline path re-rooted and the generic
 *  gate read the leading `as()` as a bind, so the same traversal answered two different things
 *  depending on a fast-path flag. */
function rewriteStartLabel(body: Step[], bound: ReadonlySet<string>): Step[] {
  const [head] = body;
  if (body.length < 2 || head.name !== 'as') return body;
  const labels = asLabelsOf(head);
  if (labels.length !== 1) return body;
  // A start variable the enclosing chain never bound is the one case TinkerPop hard-errors on
  // (WhereStartStep's path lookup fails), and it is the ONLY place this rule throws. It has to:
  // the re-root is now expressed solely as `select(label)`, so leaving an unbound `as()` here
  // would silently degrade the scope variable into a bind — the same class of wrong answer the
  // end-label rule exists to prevent, and previously it only threw when the fast path happened
  // to be on.
  if (!bound.has(labels[0]))
    throw new Error(`where(__.as("${labels[0]}")): no such label — as("${labels[0]}") was not seen`);
  return [{ ...head, name: 'select' }, ...body.slice(1)];
}

/** END: see rewriteWhereVariables. */
function rewriteEndLabel(body: Step[], bound: ReadonlySet<string>): Step[] {
  const last = body[body.length - 1];
  const labels = asLabelsOf(last).filter((l) => bound.has(l));
  if (!labels.length) return body;
  // The constraint is one `where(P.eq(label))` per end label (`as('a','b')` on the last step
  // constrains BOTH). Any label the enclosing chain never bound stays a bind: drop only the ones
  // consumed, and keep the as() itself when some remain.
  const rest = asLabelsOf(last).filter((l) => !bound.has(l));
  const head = rest.length ? [...body.slice(0, -1), { ...last, args: rest }] : body.slice(0, -1);
  if (!head.length) return body; // nothing to constrain against — leave the bind alone
  return [...head, ...labels.map((l) => synth('where', [{ op: 'eq', values: [l] }], last.ctx))];
}

/** Apply the end-label rewrite to every `where(traversal)` host in the tree, threading the labels
 *  bound BEFORE each host. Walks left to right so an `as()` types only the where()s that follow
 *  it, and descends into every nested body with the labels visible where that body sits — so the
 *  rule holds at any nesting depth, not just on the root chain. */
export function rewriteWhereEndLabels(steps: PStep[], params: Record<string, any>): PStep[] {
  // IDENTITY-PRESERVING: an arg is rebuilt ONLY when the rewrite actually changed something below
  // it. `nestedArg` swaps a raw parse tree for a Step[], which every ordinary consumer accepts
  // (stepChain is idempotent on a Step[]) — but call()'s param path serializes a nested traversal
  // back to canonical Gremlin and needs what it was handed. Rebuilding unconditionally imposes a
  // whole-tree side effect for a rewrite that fires on almost nothing.
  const walk = (chain: Step[], outer: ReadonlySet<string>): Step[] | null => {
    const bound = new Set(outer);
    let chainChanged = false;
    const out = chain.map((s) => {
      const isWhereHost = s.name === 'where';
      let stepChanged = false;
      // A match()'s pattern arguments share ONE scope: the conjunction is solved together, so a
      // `where(__.as('b')…)` argument may read a variable a SIBLING argument binds, regardless of
      // the order they were written in. Every other host binds strictly left-to-right (line below),
      // so seed match's own labels before descending rather than widening the general rule.
      const inner = s.name === 'match' ? new Set([...bound, ...matchLabelsOf(s, params)]) : bound;
      const args = (s.args ?? []).map((a: any) => {
        if (!isNested(a)) return a;
        const body = stepChain(a.nested, params);
        // The variable-location rewrite first (it reads the labels visible at the HOST), then the
        // ordinary descent, so a nested where() inside the rewritten body is still visited.
        //
        // A match() FILTER argument gets the same treatment as a where() body, and for the same
        // reason: its labels are variable REFERENCES, not binds. `match(…, not(as('a').out('created')
        // .as('b')))` asks "is this (a,b) pair NOT created-connected", so both labels must
        // canonicalize to select('a')/where(P.eq('b')) exactly as they do under where(). Left as
        // binds they re-bind the columns to whatever the body walked to — an existence check that is
        // always true, and negated, one that drops every row. A match PATTERN argument is untouched:
        // there a trailing as() really does bind, which is why this keys on the filter heads.
        const isFilterArg = s.name === 'match' && MATCH_FILTER_HEADS.has(body[0]?.name ?? '');
        const scoped = isWhereHost || isFilterArg ? rewriteWhereVariables(body, inner, params) : body;
        const walked = walk(scoped, inner);
        if (scoped === body && walked === null) return a;
        stepChanged = true;
        return nestedArg(walked ?? scoped);
      });
      // …then this step's own binds become visible to everything after it.
      for (const l of asLabelsOf(s)) bound.add(l);
      for (const l of matchLabelsOf(s, params)) bound.add(l);
      if (!stepChanged) return s;
      chainChanged = true;
      return { ...s, args };
    });
    return chainChanged ? out : null;
  };
  return (walk(steps, new Set()) ?? steps) as PStep[];
}
