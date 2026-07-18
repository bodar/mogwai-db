import { stepChain, isNested, type Step, type StrategySpec, type StrategyUse } from './frontend.ts';

// ---------- normalization passes (Seam 3) ----------
//
// TinkerPop's TraversalStrategy analogue: pure Step[]→Step[] rewrites applied
// once, up front, so the step compilers see a *canonical* chain and never do
// index arithmetic to gather a multi-step cluster. Keeping these as pure
// transforms (rather than inline rewrites scattered through the compiler) means
// each is independently testable and the compiler's dispatch stays a flat loop.
//
// The range/limit-before-vs-after-order() split is NOT a rewrite — it's the
// dispatch stop-boundary: range/limit/skip are prefix (CTE) steps until the
// prefix loop hits order()/a projection (a name absent from the prefix table),
// after which they fall to the tail as ORDER BY/LIMIT modifiers. So it lives in
// the dispatch itself (src/steps/index.ts), not here.

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
export type PStep = Step & { cluster?: Step[]; bys?: any[][]; options?: Step[]; productiveBy?: boolean; from?: string; to?: string };

const REPEAT_CLUSTER = new Set(['repeat', 'emit', 'times', 'until']);
/** Steps that absorb trailing by() modulators. Alias-compare where()/not() also
 *  host a single by(key) but are detected structurally (see isAliasCompareWhere). */
const BY_HOSTS = new Set(['order', 'select', 'project', 'group', 'groupCount', 'path', 'math', 'format', 'sack', 'aggregate', 'dedup']);
/** Path-family steps additionally absorb from()/to() scoping modulators (a Path is scoped
 *  to the positions between two as() labels). `simplePath`/`cyclicPath` are hosts here only
 *  (not general BY_HOSTS) so their by()/from()/to() fold too. `to` also names a movement
 *  step; the fold only fires when it immediately follows a path host, so no collision. */
const PATH_MODULATOR_HOSTS = new Set(['path', 'simplePath', 'cyclicPath']);

// ---------- withStrategies / withoutStrategies application ----------
//
// The REAL TinkerPop TraversalStrategy layer (distinct from the internal
// normalization above, which is only named after it). Every strategy TinkerPop
// implements as a decoration is, for us, a Step[]→Step[] rewrite that emits
// *synthetic steps the ordinary dispatch already compiles* — no new SQL machinery.
// The tree→spec extraction lives in frontend.ts (extractStrategies); this applies
// the specs. Runs BEFORE normalize() so injected has()/where() are canonicalised
// like any other step.
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
const NO_OP_STRATEGIES = new Set([
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
  // ConnectiveStrategy's effect (infix .and()/.or() folding) is unconditionally baked into
  // our compiler (predicate.ts splitInfixConnectors), so requesting it is a no-op; DISABLING
  // it (withoutStrategies) is rejected below — see ALWAYS_ON_STRATEGIES.
  'ConnectiveStrategy',
]);
// Strategies whose effect we apply unconditionally, so withoutStrategies() of them cannot be
// honored (rejecting fail-closed beats silently returning wrong rows — e.g.
// withoutStrategies(ConnectiveStrategy) expects infix .or() to become a no-op filter).
const ALWAYS_ON_STRATEGIES = new Set(['ConnectiveStrategy']);
// NOT no-ops, deliberately absent so they hit the catch-all reject (fail closed): SackStrategy,
// SideEffectStrategy, EventStrategy (need a Java Supplier/listener — unreachable via string, but
// never laundered as safe), ElementIdStrategy (changes generated ids), ReferenceElementStrategy
// (property stripping — harmless only by our framing coincidence, not by contract),
// VertexProgramStrategy (OLAP). Each would change results if silently ignored.
const VERIFICATION_STRATEGIES = new Set([
  'ReadOnlyStrategy', 'EdgeLabelVerificationStrategy', 'ReservedKeysVerificationStrategy',
]);
const PRODUCTIVE_BY_HOSTS = new Set(['group', 'groupCount', 'project', 'select', 'aggregate', 'order', 'path', 'where', 'not', 'dedup']);

/** ProductiveBy is semantic only at by()-consumers. Mark the supported hosts so they
 * choose a LEFT-domain/null policy explicitly; reject any other host rather than
 * pretending a traversal-wide strategy was honoured. */
function markProductiveBy(steps: Step[]): Step[] {
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

const rejectMsg = (name: string) =>
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
function injectSubgraphRec(steps: Step[], spec: StrategySpec, params: Record<string, any>): Step[] {
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
function injectPartitionRec(steps: Step[], spec: StrategySpec, params: Record<string, any>): Step[] {
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
function verify(spec: StrategySpec, steps: Step[]): void {
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

/**
 * Apply the extracted strategy specs to the step chain, returning the rewritten
 * chain (with any injected filters / write stamps). Verification runs against the
 * user's original chain. Order: `withoutStrategies` first suppresses any matching
 * `withStrategies` entry (the only case removal matters, since we apply no default).
 */
export function applyStrategies(steps: Step[], use: StrategyUse, params: Record<string, any> = {}): Step[] {
  // A bare withoutStrategies(X) is a no-op when X is applied only on request (nothing to
  // remove, since we apply no strategy by default) — EXCEPT for an always-on strategy whose
  // effect is unconditionally baked in and cannot be turned off. Reject those fail-closed.
  for (const name of use.without)
    if (ALWAYS_ON_STRATEGIES.has(name))
      throw new Error(`withoutStrategies(${name}) is not supported: its effect (infix .and()/.or() folding) is unconditionally applied by this compiler and cannot be disabled.`);
  const removed = new Set(use.without);
  const verifiers: StrategySpec[] = [];
  let out = steps;
  for (const spec of use.with) {
    if (removed.has(spec.name)) continue;                 // withoutStrategies suppresses it
    if (NO_OP_STRATEGIES.has(spec.name)) continue;        // result-preserving / inert → no-op
    else if (spec.name === 'SubgraphStrategy') out = injectSubgraphRec(out, spec, params);
    else if (spec.name === 'PartitionStrategy') out = injectPartitionRec(out, spec, params);
    else if (spec.name === 'ProductiveByStrategy') out = markProductiveBy(out);
    else if (VERIFICATION_STRATEGIES.has(spec.name)) verifiers.push(spec);
    else throw new Error(rejectMsg(spec.name));
  }
  for (const spec of verifiers) verify(spec, steps);
  return out;
}

/** Run every normalization pass. `discard` rides out-of-band — it's an output
 *  shape (iterate() → return nothing), not a step the compiler dispatches. */
export function normalize(steps: Step[]): { steps: PStep[]; discard: boolean } {
  const stripped = stripTerminal(steps);
  return { steps: dropRedundantOrder(collapseFoldCountLocal(foldChooseOptions(foldByModulators(foldRepeatClusters(stripped.steps))))), discard: stripped.discard };
}

/** `fold().count(Scope.local)` counts the one folded list's size = the number of upstream
 *  elements = `count()`. A provable identity that also unblocks group value children like
 *  by(__.out().order().fold().count(Scope.local)) (then dropRedundantOrder removes the
 *  order). Runs before dropRedundantOrder so the resulting order().count() is caught. */
function collapseFoldCountLocal(steps: PStep[]): PStep[] {
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
function dropRedundantOrder(steps: PStep[]): PStep[] {
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
function stripTerminal(steps: Step[]): { steps: Step[]; discard: boolean } {
  const last = steps[steps.length - 1];
  if (last && (last.name === 'discard' || (last.name === 'none' && last.args.length === 0)))
    return { steps: steps.slice(0, -1), discard: true };
  return { steps, discard: false };
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
function foldRepeatClusters(steps: Step[]): PStep[] {
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
function foldByModulators(steps: PStep[]): PStep[] {
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
function foldChooseOptions(steps: PStep[]): PStep[] {
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
