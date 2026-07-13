import { stepChain, type Step, type StrategySpec, type StrategyUse } from './frontend.ts';

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
export type PStep = Step & { cluster?: Step[]; bys?: any[][]; options?: Step[] };

const REPEAT_CLUSTER = new Set(['repeat', 'emit', 'times', 'until']);
/** Steps that absorb trailing by() modulators. Alias-compare where()/not() also
 *  host a single by(key) but are detected structurally (see isAliasCompareWhere). */
const BY_HOSTS = new Set(['order', 'select', 'project', 'group', 'groupCount', 'path', 'math']);

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
//  - Everything else (ProductiveBy, Connective, Seed, Options, ElementId, OLAP,
//    unknown) fails CLOSED — a silently dropped semantic strategy would leak
//    unfiltered data. `withoutStrategies` is a safe no-op because we apply NO
//    strategy by default; a `without` of a strategy also named in `with` suppresses
//    it (handled by filtering `with` up front).

const SAFE_OPTIMIZATION_STRATEGIES = new Set([
  'CountStrategy', 'IdentityRemovalStrategy', 'FilterRankingStrategy',
  'LazyBarrierStrategy', 'EarlyLimitStrategy', 'OrderLimitStrategy',
  'AdjacentToIncidentStrategy', 'IncidentToAdjacentStrategy', 'InlineFilterStrategy',
  'PathRetractionStrategy', 'PathProcessorStrategy', 'ByModulatorOptimizationStrategy',
  'RepeatUnrollStrategy', 'MatchAlgorithmStrategy', 'MatchPredicateStrategy',
]);
const VERIFICATION_STRATEGIES = new Set([
  'ReadOnlyStrategy', 'EdgeLabelVerificationStrategy', 'ReservedKeysVerificationStrategy',
]);

/** Steps whose output traverser is a vertex (a partition/subgraph vertex filter is
 *  injected after each). V()/E() are also the source step, at index 0. */
const VERTEX_PRODUCERS = new Set(['V', 'out', 'in', 'both', 'outV', 'inV', 'bothV']);
/** Steps whose output traverser is an edge (a partition edge filter injects after). */
const EDGE_PRODUCERS = new Set(['E', 'outE', 'inE', 'bothE']);
/** Element-producing step names: the V/E sources plus every movement hop. A nested
 *  sub-traversal that reaches any of these produces elements the top-level filter
 *  injection does NOT cover, so a semantic strategy over it must defer (fail-closed). */
const ELEMENT_PRODUCERS = new Set([...VERTEX_PRODUCERS, ...EDGE_PRODUCERS]);
/** Steps whose sub-traversal body a semantic strategy would have to descend into to
 *  stay correct regardless of what it contains (they branch / re-source); not yet
 *  supported, so their mere presence defers. (Movement buried in a where()/by()/map()/
 *  from()/to() body is caught separately by nestedProducesElements.) */
const NESTED_BODY_STEPS = new Set(['repeat', 'union', 'optional', 'choose', 'coalesce', 'flatMap', 'match', 'local']);
/** Edge-traversal steps EdgeLabelVerificationStrategy guards (a bare, unlabelled one
 *  is "a vertex step without any specified edge label"). */
const EDGE_TRAVERSAL_STEPS = new Set(['out', 'in', 'both', 'outE', 'inE', 'bothE', 'to']);
/** Steps ReadOnlyStrategy rejects. */
const MUTATING_STEPS = new Set(['addV', 'addE', 'mergeV', 'mergeE', 'property', 'drop']);

const rejectMsg = (name: string) =>
  `withStrategies(...) is not supported: '${name}' is a semantic or unknown strategy that would change results if ignored ` +
  `(e.g. PartitionStrategy/SubgraphStrategy filtering, ProductiveByStrategy null semantics). Rejected to fail closed.`;

/** A synthetic step (no real parse context of its own — it borrows the strategy's). */
const synth = (name: string, args: any[], ctx: StrategySpec['ctx']): Step => ({ name, args, ctx });

/** Does a nested sub-traversal (at ANY depth) produce elements — i.e. contain a V/E
 *  source or a movement hop? Recurses through wrapper steps (and/or/not/where…) that
 *  carry their own {nested} branches, which stepChain deliberately does not descend
 *  into — so where(__.or(__.out(),…)) is caught, not just a top-level where(__.out()). */
function nestedProducesElements(node: any, params: Record<string, any>): boolean {
  return stepChain(node, params).some((s) =>
    ELEMENT_PRODUCERS.has(s.name) ||
    s.args.some((a) => a && typeof a === 'object' && 'nested' in a && nestedProducesElements(a.nested, params)));
}

/** Fail closed if a semantic strategy would have to reach inside a sub-traversal it
 *  cannot yet filter. Injection only covers the TOP-LEVEL chain's producers; ANY
 *  nested body that produces elements — a where()/by()/map()/from()/to()/option()
 *  criterion (its by() still a separate step pre-normalize), or a branch/re-source
 *  step — would leak unfiltered elements (e.g. group().by(__.out().count()) counting
 *  every edge in the store, or addE().to(__.V(x)) resolving an unreadable endpoint).
 *  Defer rather than under-filter — the exact leak the fail-closed posture prevents. */
function guardNestedBodies(steps: Step[], strategy: string, params: Record<string, any>): void {
  for (const s of steps) {
    if (NESTED_BODY_STEPS.has(s.name))
      throw new Error(`${strategy} with a ${s.name}() sub-traversal is not yet supported (its filter must apply inside the body)`);
    for (const a of s.args)
      if (a && typeof a === 'object' && 'nested' in a && nestedProducesElements(a.nested, params))
        throw new Error(`${strategy} with an element-producing sub-traversal inside ${s.name}() is not yet supported (the produced elements must be filtered too)`);
  }
}

/** SubgraphStrategy(vertices: __.<criterion>) → inject where(criterion) after every
 *  vertex-producing step (TraversalFilterStep semantics). Edge / vertex-property
 *  criteria and edge-landing steps (which need adjacent-vertex filtering) defer. */
function injectSubgraph(steps: Step[], spec: StrategySpec, params: Record<string, any>): Step[] {
  if (spec.config.edges !== undefined)
    throw new Error('SubgraphStrategy(edges) criterion not yet supported (vertex criterion only)');
  if (spec.config.vertexProperties !== undefined)
    throw new Error('SubgraphStrategy(vertexProperties) criterion not yet supported');
  const vCrit = spec.config.vertices;
  if (!(vCrit && typeof vCrit === 'object' && 'nested' in vCrit))
    throw new Error('SubgraphStrategy requires a vertices criterion traversal');
  // An edge-landing step (E/outE/inE/bothE) leaves an edge whose *both* endpoints
  // must satisfy the vertex criterion (checkAdjacentVertices) — endpoint filtering
  // is not implemented, so defer rather than under-filter.
  const edgeStep = steps.find((s) => EDGE_PRODUCERS.has(s.name));
  if (edgeStep)
    throw new Error(`SubgraphStrategy with an edge step (${edgeStep.name}()) not yet supported (adjacent-vertex filtering)`);
  guardNestedBodies(steps, 'SubgraphStrategy', params);
  const out: Step[] = [];
  for (const s of steps) {
    out.push(s);
    if (VERTEX_PRODUCERS.has(s.name)) out.push(synth('where', [vCrit], spec.ctx));
  }
  return out;
}

/** PartitionStrategy → inject has(partitionKey, within(readPartitions)) after every
 *  element-producing step (read visibility) and property(partitionKey, writePartition)
 *  after every addV/addE (write stamping). Read and write partitions are independent
 *  (TinkerPop allows writing to a partition you cannot read). */
function injectPartition(steps: Step[], spec: StrategySpec, params: Record<string, any>): Step[] {
  const key = spec.config.partitionKey;
  if (typeof key !== 'string')
    throw new Error('PartitionStrategy requires a string partitionKey');
  if (spec.config.includeMetaProperties === true)
    throw new Error('PartitionStrategy(includeMetaProperties) not yet supported');
  const merge = steps.find((s) => s.name === 'mergeV' || s.name === 'mergeE');
  if (merge)
    throw new Error(`PartitionStrategy with ${merge.name}() not yet supported (partition-aware upsert)`);
  guardNestedBodies(steps, 'PartitionStrategy', params);
  // readPartitions defaults to EMPTY, and the read filter is injected UNCONDITIONALLY
  // (matching TinkerPop's PartitionStrategy.Builder default + apply()): an omitted
  // readPartitions means "see nothing" (has(key, within([])) → 0 rows), NOT "see
  // everything". Gating on presence would leak all data for a writePartition-only
  // config — the exact failure this module exists to prevent.
  const readRaw = spec.config.readPartitions;
  const readVals: any[] = Array.isArray(readRaw) ? readRaw : readRaw == null ? [] : [readRaw];
  const writeVal = spec.config.writePartition;
  const out: Step[] = [];
  for (const s of steps) {
    out.push(s);
    if (VERTEX_PRODUCERS.has(s.name) || EDGE_PRODUCERS.has(s.name))
      out.push(synth('has', [key, { op: 'within', values: readVals }], spec.ctx));
    if (writeVal !== undefined && (s.name === 'addV' || s.name === 'addE'))
      out.push(synth('property', [key, writeVal], spec.ctx));
  }
  return out;
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
    const reserved = new Set<string>(k == null ? ['id', 'label'] : Array.isArray(k) ? k : [k]);
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
  const removed = new Set(use.without);
  const verifiers: StrategySpec[] = [];
  let out = steps;
  for (const spec of use.with) {
    if (removed.has(spec.name)) continue;                 // withoutStrategies suppresses it
    if (SAFE_OPTIMIZATION_STRATEGIES.has(spec.name)) continue; // result-preserving → no-op
    else if (spec.name === 'SubgraphStrategy') out = injectSubgraph(out, spec, params);
    else if (spec.name === 'PartitionStrategy') out = injectPartition(out, spec, params);
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
  return { steps: foldChooseOptions(foldByModulators(foldRepeatClusters(stripped.steps))), discard: stripped.discard };
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
    if (!BY_HOSTS.has(s.name) && !isAliasCompareWhere(s)) { out.push(s); continue; }
    const bys: any[][] = [];
    let j = i + 1;
    for (; j < steps.length && steps[j].name === 'by'; j++) bys.push(steps[j].args);
    out.push(bys.length ? { ...s, bys } : s);
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
