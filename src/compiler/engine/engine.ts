import { empty, q, value, list, Query, type Expression } from '../../sql/kernel/q.ts';
import { type Elem, elemTable } from '../plan/plan.ts';
import { flattenListArgs, isColumnArg, isOperatorArg, isPopArg, arg, argValues } from '../../gremlin/frontend.ts';
import { type IRStep } from '../ir/strategies.ts';
import { analyzeChain, canCarryEncounter, type ChainFacts } from '../ir/analyze.ts';
import { layoutCols, rootLayout, trackFromV, type LoweringState, type ElementStream, type StepFn } from '../steps/context/context.ts';
import { move, toEdge, toVertex, otherV, reSource } from '../steps/prefix/movement.ts';
import { as, hasLabel, has, hasNot, hasId, where, andOr, dedup, simplePath, cyclicPath } from '../steps/prefix/filter.ts';
import { union, optional, repeat, choose, coalesce, sourceUnion } from '../steps/prefix/branch.ts';
import { seedInject } from '../steps/write/inject.ts';
import { asBranchKind, branchNeedsShapeDispatch, childCtx, isElementChild, isListChild, isScalarChild, labelSelectOf, type ChildCtx } from '../steps/tail/child-shape.ts';
import { match } from '../steps/prefix/match.ts';
import { identity, limit, range, sample, skip, tail } from '../steps/prefix/passthrough.ts';
import { sack } from '../steps/prefix/sack.ts';
import { aggregate, group as groupSE, groupCount as groupCountSE } from '../steps/prefix/sideeffect.ts';
import { type SackSpec } from '../../gremlin/frontend.ts';
import { compileTail, compileFromScalar } from '../steps/tail/projection.ts';
import { compileFromGroup, compileFromProperty } from '../steps/tail/group.ts';
import { compileFromList, compileFromMap, compileFromMapEntry } from '../steps/tail/list.ts';
import { compileFromRecord, selectRecordFromAlias } from '../steps/tail/select.ts';
import { compileFromPath } from '../steps/tail/path.ts';
import { asOnStream, selectOneFromAlias } from '../steps/tail/labelselect.ts';
import { assertStreamColumns, continueLowering, isSuspension, toElementStream, toScalarStream, type LoweringResult, type LoweringSuspension, type Stream } from '../steps/context/stream.ts';
import { type Compiled } from '../../sql/kernel/render.ts';
import { BulkRepeatCountFastPath } from '../steps/tail/bulk.ts';
import { runFastPath, fastPathContext, type FastPathConfig } from '../options/fast-paths.ts';
import type { ServiceRegistry } from '../../services/spi/types.ts';
import { lowerScalarRows } from '../steps/tail/scalar.ts';
import { seedCall, type BarrierPoint, type MidBarrierPoint } from '../steps/tail/call.ts';
import { materializeRootStream } from '../steps/tail/materialize.ts';
import { compileFromVariant } from '../steps/tail/variant.ts';
import { compileFromForeign, landForeignElements, resumeMidBarrier } from '../steps/tail/foreign.ts';
import type { SegmentPlan } from '../segment.ts';
import type { ForeignRow } from '../../services/spi/types.ts';
import type { RequestScope } from '../../scopes.ts';
import type { ElementReadDriver, Engine } from './deps.ts';
import { labelRegime, type LabelCardinality, type LabelRegime } from '../../api.ts';

export { compileTail };

// ---------- the lowering Engine (the dispatch stage's recursive surface, as a dependency object) ----------
//
// The Engine is the compiler's recursive-traversal authority: the PREFIX dispatch table + the
// prefix fold (buildPrefix/lowerElementSteps) + the shaped lowering loop (lowerSteps/lowerStream)
// + source seeding + the root read (compileRead). It was the free-function barrel `steps/index.ts`;
// it is now an OBJECT built per-compile from a RequestScope, holding the ambient dependencies
// (fastPaths/registry/federationDepth) that used to ride LoweringState. It attaches itself to its compile's
// Query (`q.engine`) so every step family reaches lowering + deps through `stream.q.engine` — no
// parameter threading, no dependency on a dispatcher module (which is what dissolved the old
// index⇄child⇄projection import cycle: the families import only the leaf `Engine` interface).
//
// The prefix StepFns (move/where/andOr/union/optional/…) stay FREE functions (they read their one
// dependency, `st.q.engine.fastPaths`, through the stream); the Engine just owns the dispatch table
// and the orchestration. A nested sub-compile (compileReadCompiled, called from list/write) mints a
// FRESH child Engine (fresh Query, SAME app scope) so it inherits registry/fastPaths — fixing the
// latent bug where the old free-function nested compiles dropped them.

/** A sack step in its mutate form (has an Operator arg); the bare read form is a tail
 *  projection, so it must NOT dispatch as a prefix step. */
const isSackMutate = (s: IRStep): boolean => (s.args ?? []).some((a) => isOperatorArg(a.value));

/** A side-effecting group('a')/groupCount('a') (has a string side-effect key); the bare
 *  form is a terminal barrier handled by compileTail, so it must break out of the prefix. */
const isSideEffectGroup = (s: IRStep): boolean => (s.args ?? []).some((a) => typeof a.value === 'string');

/** Every recognized local() body belongs at shape-aware dispatch. The generic child
 * compiler applies `all` cardinality, so row operators and reducers partition by
 * parent without a prefix-local parser. */
const isShapedLocal = (s: IRStep, ctx: ChildCtx): boolean => {
  const nested = (s.args ?? [])[0]?.value?.nested;
  return !!nested && (isElementChild(nested, ctx) || isScalarChild(nested, ctx) || isListChild(nested, ctx));
};

/** otherV() needs each edge step to record its entering vertex — gate that on the
 *  chain naming otherV, so ordinary edge traversals stay index-only (no dead column).
 *  This is chain-global at the root but ALSO re-derived per-scope at lowerElementSteps
 *  over each child scope's own step slice, so it is a local predicate here — NOT a
 *  ChainFact (see ir/analyze.ts's header for why the fromV/trackFromV split stays). */
const chainNeedsFromV = (steps: IRStep[]): boolean => steps.some((s) => s.name === 'otherV');

/** A value-shaped stream (scalar/list/variant) whose current object can be labelled and
 *  whose select("label") reads a path-history alias — as opposed to record/map/group
 *  whose select consumes a field/column and is owned by their own dispatchers. */
// `path` is here because a LINEAR path is row-preserving, so it carries the alias history and can
// bind/read a label like any other value shape (the recursive/grouped layout declines inside
// currentEntry — it is one row per position, not per path).
const isValueShape = (s: Stream): boolean => s.kind === 'scalar' || s.kind === 'list' || s.kind === 'variant' || s.kind === 'property' || s.kind === 'path';

/** select(label…) reading path-history labels (string args), not select(Column). */
const isLabelSelect = (step: IRStep): boolean =>
  step.name === 'select'
  && step.args.some((a) => typeof a.value === 'string')
  && !step.args.some((a) => isColumnArg(a.value));

/** The shape-agnostic label steps: as() binds and select(label) reads a path-history
 *  label. They are dispatched in ONE place (dispatchAlias, at the top of lowerStream);
 *  every per-shape row-consumer just yields the step back to that dispatch. */
const isAliasStep = (step: IRStep): boolean => step.name === 'as' || isLabelSelect(step);

const popOf = (step: IRStep): string =>
  step.args.map((a) => a.value).find(isPopArg)?.pop ?? 'last';

/** Dispatch as()/select(label) over a value-shaped (scalar/list/variant) stream. */
function dispatchAlias(s: Exclude<Stream, { kind: 'result' }>, steps: IRStep[], at: number): LoweringResult {
  const step = steps[at];
  if (step.name === 'as') return continueLowering(asOnStream(s as any, step), at + 1);
  const uniq = [...new Set(argValues(step).filter((a: any): a is string => typeof a === 'string'))];
  const pop = popOf(step);
  return continueLowering(
    uniq.length === 1 ? selectOneFromAlias(s, step, uniq[0], pop) : selectRecordFromAlias(s, step, uniq, pop),
    at + 1,
  );
}

/**
 * The lowering Engine. Constructed per-compile from the REQUEST scope plus the little that a
 * single compile owns (its Query, and — for inject() only — a params override); holds the ambient
 * dependencies + drives the recursive traversal. Attaches itself to its Query so every stream
 * built during this compile reaches it via `stream.q.engine`.
 */
export class LoweringEngine implements Engine {
  readonly q: Query;
  readonly params: Record<string, any>;
  readonly fastPaths: FastPathConfig;
  readonly registry: ServiceRegistry;
  readonly labelCardinality: LabelCardinality;
  readonly labelRegime: LabelRegime;
  readonly federationDepth: number;
  private readonly PREFIX: Map<string, StepFn>;

  /** `own` is what THIS compile owns and a sibling compile must not share — the state a compile
   *  tier would otherwise have held as a third scope:
   *   • `q`     — the fresh CTE namespace to mint into (default: a new one).
   *   • `params` — an override of the request's bound-param table. Only inject() uses it: it seeds
   *     its own source and lowers against an empty table. Absent → the request's.
   *   • `fastPaths` — the collapse-GATED config for this compile's chain (movementCollapse is
   *     per-chain result-safety, see collapseSafeFastPaths); the compile entry points compute it
   *     from the steps. Absent → the request's ungated base (a bare Engine used before its chain
   *     is known re-gates in compileRead-for-a-chain, below). */
  constructor(private readonly request: RequestScope, own: {
    q?: Query;
    params?: Record<string, any>;
    fastPaths?: FastPathConfig;
  } = {}) {
    this.q = own.q ?? new Query();
    this.params = own.params ?? request.params;
    this.fastPaths = own.fastPaths ?? request.fastPaths;
    this.registry = request.registry;
    this.labelCardinality = request.labelCardinality;
    this.labelRegime = labelRegime(request.sourceOptions, request.labelCardinality);
    this.federationDepth = request.federationDepth;
    this.q.engine = this; // ride the Query so families reach us via stream.q.engine
    // The movement/filter/branch/passthrough compilers, keyed by step name. A step absent from
    // this table is where the prefix ends (the tail takes over) — that boundary is also the
    // range/limit-before-vs-after-order() split (passthrough.ts).
    this.PREFIX = new Map<string, StepFn>([
      ['out', move], ['in', move], ['both', move],
      ['outE', toEdge], ['inE', toEdge], ['bothE', toEdge],
      ['outV', toVertex], ['inV', toVertex], ['bothV', toVertex], ['otherV', otherV],
      // MID-TRAVERSAL V()/E() only — seedRooted consumes a source V()/E() before this fold runs.
      ['V', reSource], ['E', reSource],
      ['as', as], ['hasLabel', hasLabel], ['has', has], ['hasNot', hasNot], ['hasId', hasId],
      ['where', where], ['filter', where], ['not', where],
      ['and', andOr], ['or', andOr], ['dedup', dedup],
      ['simplePath', simplePath], ['cyclicPath', cyclicPath],
      ['union', union], ['optional', optional], ['choose', choose],
      ['coalesce', coalesce], ['match', match],
      // The whole folded repeat/emit/times/until cluster dispatches here (strategies
      // anchors it on repeat() when present, else the first cluster step).
      ['repeat', repeat], ['emit', repeat], ['times', repeat], ['until', repeat],
      ['limit', limit], ['range', range], ['skip', skip], ['tail', tail], ['sample', sample],
      ['identity', identity], ['barrier', identity],
      // Only the MUTATE form sack(Operator.x) is a prefix step; bare sack() (read) breaks
      // out to the tail (lowerElementSteps guard below).
      ['sack', sack],
      // aggregate() is a pass-through barrier: it registers a named side-effect and
      // returns the stream unchanged, so the traversal continues. (TinkerPop 4 dropped
      // the lazy store() step; aggregate(Scope.local) replaces it — not in the grammar.)
      ['aggregate', aggregate],
      // The SIDE-EFFECTING group('a')/groupCount('a') (has a string key) is a pass-through
      // barrier too; the bare terminal group()/groupCount() breaks to the tail (guard below).
      ['group', groupSE], ['groupCount', groupCountSE],
    ]);
  }

  /** Mint a FRESH child Engine (fresh Query, SAME request scope) for a nested sub-compile. `steps`, when
   *  given, re-gates movementCollapse for the child's OWN chain (per-chain result-safety); absent
   *  → carry the base fastPaths (a resume closure whose chain is already lowered). */
  private child(params: Record<string, any>, steps?: IRStep[], q?: Query): LoweringEngine {
    const base = this.request.fastPaths;
    return new LoweringEngine(this.request, {
      q, params, fastPaths: steps ? collapseSafeFastPaths(base, analyzeChain(steps)) : base,
    });
  }

  /** Seed the source CTE (c0) from V(...)/E(...) and its optional id list. When the
   *  chain tracks a path, the source element is path position p0 (projected as the
   *  extra `p0` column). */
  private seedSource(first: IRStep, params: Record<string, any>, trackPath: boolean, sackInit?: SackSpec, wantsEncounter = false): ElementStream {
    const query = this.q;
    const elem: Elem = first.name === 'E' ? 'edge' : 'vertex';
    const srcRel = elemTable(elem);
    // The source projection, assembled in layoutCols order (sack, bulk, encounter, path) so the
    // physical SELECT matches the declared column list exactly. withSack() seeds the sack
    // column (a bound Value so a string init escapes safely); every element source seeds a
    // `bulk` multiplicity of 1 — the RLE traverser count SUM(bulk) reads at a reducer, and
    // the substrate a movement collapse (GROUP BY id, SUM(bulk)) later merges convergent walks on.
    // The emission-order `encounter` is seeded (= rowid order) only when the chain demands it.
    const projections: Expression[] = [q`id`];
    const cols: string[] = ['id'];
    if (sackInit) { projections.push(q`${value(sackInit.init)} AS sk`); cols.push('sk'); }
    projections.push(q`1 AS bulk`); cols.push('bulk');
    if (wantsEncounter) { projections.push(q`id AS encounter`); cols.push('encounter'); }
    if (trackPath) { projections.push(q`id AS p0`); cols.push('p0'); }
    const sel = list(projections, ', ');
    // V(1,[2,3]) ≡ V(1,2,3): flatten any Collection id arg (collection literals + bound
    // list params render inline as [..] and parse as arrays).
    const ids = flattenListArgs(argValues(first));
    let body: Expression;
    if (ids.length > 0) {
      // Numeric args match the rowid, string args the user id (uid); the id-relation
      // carries rowids throughout, so a uid match still projects `id` (the rowid).
      const nums = ids.filter((a) => typeof a === 'number');
      const strs = ids.filter((a) => typeof a === 'string');
      const clauses: Expression[] = [];
      if (nums.length) clauses.push(q`id IN (${list(nums.map(value), ',')})`);
      if (strs.length) clauses.push(q`uid IN (${list(strs.map(value), ',')})`);
      if (!clauses.length) throw new Error('V()/E() ids must be numbers or strings');
      body = q`SELECT ${sel} FROM ${srcRel} WHERE ${list(clauses, ' OR ')}`;
    } else {
      body = q`SELECT ${sel} FROM ${srcRel}`;
    }
    const path = trackPath ? { kind: 'cols' as const, cols: [{ col: 'p0', elem }] } : undefined;
    return { kind: 'elements', q: query, params, rel: query.cte(body, cols), elem, traverserLayout: { aliases: new Map(), origins: [], branchOrders: [], path, sack: sackInit ? 'sk' : undefined, bulk: 'bulk', encounter: wantsEncounter ? 'encounter' : undefined } };
  }

  /** Seed the SOURCE of a rooted chain → the initial Stream + the index of the first step after
   *  it. THE one place a source step is recognized: compileRead, buildPrefix and a `union()`
   *  SOURCE arm all come through here, so a source form added once is available to all three.
   *  `V()`/`E()` and `inject()` build their own relation; a `union()` SOURCE lowers each rooted
   *  branch and merges them (branch.ts `sourceUnion` — of ANY shape, hence `Stream` not
   *  `ElementStream`); a `call()` service seeds whatever shape it produces. A BARRIER call()
   *  source suspends into a SegmentPlan, which only compileRead can build — it intercepts that
   *  form before reaching here, so a barrier arriving at this seam is out of position. */
  private seedRooted(steps: IRStep[], params: Record<string, any>, sackInit: SackSpec | undefined, facts: ChainFacts): { stream: Stream; at: number } {
    const first = steps[0];
    if (first.name === 'V' || first.name === 'E')
      return { stream: this.seedSource(first, params, facts.tracksPath, sackInit, facts.demandsEncounter), at: 1 };
    if (first.name === 'union')
      return { stream: sourceUnion(this, first, params, sackInit, facts), at: 1 };
    if (first.name === 'inject')
      return seedInject({ q: this.q, params, traverserLayout: rootLayout() }, steps, sackInit);
    // An anonymous `__.constant(x)` is a legitimate source-shaped child: it has one
    // synthetic start which scalar constant() then replaces.  Keeping that start as a
    // normal ScalarStream (rather than folding the literal here) means every follower,
    // including an `apply` modulation such as concat(__.V().label()), takes the shared
    // scalar dispatcher and keeps the original parameter environment.
    if (first.name === 'constant') {
      const rel = this.q.cte(q`SELECT NULL AS v`, ['v']);
      return { stream: toScalarStream({ q: this.q, params, traverserLayout: rootLayout() }, rel), at: 0 };
    }
    // A `call()` SOURCE inside a rooted arm cannot be a barrier — its rows arrive from an awaited
    // sibling, and only `compileRead` (which owns the segment loop) can suspend for that. Every pure
    // service lowers on the RelIR spine now, so `seedCall` here can only refuse or barrier, and both
    // are errors at this position.
    if (first.name === 'call') {
      seedCall(first, params, this.registry, steps, this.federationDepth);
      throw new Error('a barrier/federated call() source is only supported at the head of a traversal');
    }
    throw new Error(`unsupported source step: ${first.name}`);
  }

  /** Lower a fully ROOTED chain to its relational Stream — the `union()` SOURCE arm compiler.
   *  Same spine as compileRead (seed the source, run the ONE shaped lowering loop) with one
   *  difference: a chain that ENDS on elements returns that element relation rather than running
   *  the root element projection, because a branch merge consumes a relation, not a framed leaf.
   *  `facts` lets the caller impose the OUTER chain's path/encounter demands, which the arm's own
   *  text cannot show. */
  lowerRootedArm(steps: IRStep[], params: Record<string, any>, sackInit?: SackSpec, facts: ChainFacts = analyzeChain(steps)): Stream {
    const seeded = this.seedRooted(steps, params, sackInit, facts);
    // An element seed folds its movement/filter prefix here so a pure element chain can stop
    // before compileTail; every other shape goes straight to the shared loop.
    const lowered = seeded.stream.kind === 'elements'
      ? this.lowerElementSteps(steps, seeded.stream, seeded.at)
      : { stream: seeded.stream as Stream, next: seeded.at };
    if (lowered.next >= steps.length) return lowered.stream;
    const end = this.lowerStepsStrict(lowered.stream, steps, lowered.next);
    if (end.kind === 'result')
      throw new Error(`union() source branch __.${steps.map((s) => s.name + '()').join('.')} not yet supported (it lowers to a terminal result, not a mergeable relation)`);
    return end;
  }

  /**
   * Fold the PREFIX dispatch over `steps` from index `from`, threading ElementStream. Stops at
   * the first step absent from PREFIX (order/projection/write) and reports where. The shared
   * primitive behind buildPrefix/lowerRootedArm (folding from a seeded source) and a branch body
   * (folding from an already-seeded relation — choose()'s arms, see branch.ts). A body reached
   * through the CHILD seam carries no strategies normalization, so a repeat/by cluster inside such
   * an arm defers via its own compiler's guards.
   */
  lowerElementSteps(steps: IRStep[], seedSt: ElementStream, from = 0): { stream: ElementStream; next: number } {
    // trackFromV is per-scope: a chain that lands via otherV() (e.g. an exploded
    // both()→bothE().otherV() injected by SubgraphStrategy's edge criterion) needs each edge
    // step in THIS chain to record its entering vertex. The root sets it in buildPrefix; every
    // OTHER scope (correlated predicate, child count/scalar/element rows, match) folds through
    // here, so deriving it once at this single choke point fixes them all. Ordinary edge
    // chains carry no otherV → stay index-only (no dead fv column).
    let st = (!seedSt.traverserLayout.trackFromV && steps.some((s) => s.name === 'otherV'))
      ? trackFromV(seedSt)
      : seedSt;
    let i = from;
    for (; i < steps.length; i++) {
      const fn = this.PREFIX.get(steps[i].name);
      // A branch (union/choose/coalesce/optional) whose arms are not uniformly ELEMENT can't be an
      // element StepFn — break so the tail shape dispatch picks the list/scalar/variant merge.
      // All-element (incl. mixed node/edge) stays here with the element StepFn and its own defer.
      // The decision is classifyBranchArms' (child-shape.ts) — the ONE canonical arm triage the
      // tail cascades read too, so the fold's `break` and the cascade cannot drift. Option-map
      // choose (choose().option()…) is a tail CASE projector, not a prefix branch, and reports
      // as needing dispatch from there.
      const branchKind = asBranchKind(steps[i].name);
      // The classify context is the CURRENT stream, not the seed: an as() earlier in this very
      // fold has already bound its label, so a branch arm / local() body here classifies against
      // the labels actually visible at this position (V().as('a').local(__.select('a')...)).
      const ctx = childCtx(st);
      if (!fn
        || (branchKind && branchNeedsShapeDispatch(branchKind, steps[i], ctx))
        || (steps[i].name === 'choose' && steps[i].optionArms)
        || (steps[i].name === 'sack' && !isSackMutate(steps[i]))
        || ((steps[i].name === 'group' || steps[i].name === 'groupCount') && !isSideEffectGroup(steps[i]))
        || (steps[i].name === 'local' && isShapedLocal(steps[i], ctx))) break;
      st = fn(steps[i], st);
    }
    return { stream: st, next: i };
  }

  /** Lower a complete element-valued step sequence without materializing it, CROSSING a
   * `select(label)` re-root. This is the shared nested/root seam: branch arms can compose element
   * StepFns and retain their relational stream, while lowerSteps remains the sole outer
   * materializer.
   *
   * lowerElementSteps folds the movement/filter/as()/branch prefix but stops at select() — that is
   * a tail step, not a prefix StepFn. Rather than teach the prefix table a second select
   * implementation, apply the ONE that already exists (selectOneFromAlias, the same code the root
   * tail runs) and keep folding. An element-shaped label re-roots the traverser and the body
   * continues; anything else returns null, so every caller keeps its existing decline.
   *
   * Being the ONE whole-element-body fold is the point: admitting a label re-root here reaches
   * every child position at once — map/local/flatMap, where()/and()/or() existence, by()
   * modulators, branch arms, count children, AND the inline correlated predicate (correlated.ts)
   * — at ANY nesting depth. Both seeds physically carry the parent's alias columns
   * (pushChildScope projects them into each frame; the correlated seed projects them from its
   * LabelScope), so the read the fold makes is always physically there to make. */
  tryLowerElementSteps(steps: IRStep[], seed: ElementStream): ElementStream | null {
    let st = seed;
    let at = 0;
    for (;;) {
      const { stream, next } = this.lowerElementSteps(steps, st, at);
      st = stream;
      if (next === steps.length) return st;
      at = next; // the fold stopped here — only a label re-root can carry the body forward
      const label = labelSelectOf(steps[at]);
      if (label === null) return null;
      const selected = selectOneFromAlias(st, steps[at], label, popOf(steps[at]));
      if (selected.kind !== 'elements') return null;
      st = selected;
      at++;
    }
  }

  /** Seed an ELEMENT source + fold its movement/filter prefix. The write path's entry into the
   *  read spine (a target-id relation); a source whose merge is not element-shaped fails closed
   *  here rather than being silently mis-typed. */
  buildPrefix(steps: IRStep[], params: Record<string, any> = {}, sackInit?: SackSpec, facts: ChainFacts = analyzeChain(steps)): { st: ElementStream; stop: number } {
    const { stream, at } = this.seedRooted(steps, params, sackInit, facts);
    if (stream.kind !== 'elements')
      throw new Error(`${steps[0].name}() as a source produces a ${stream.kind} value, which is not an element prefix`);
    // Gate the otherV() entering-vertex tracking on the chain; local()'s body inherits
    // the flag through its {...st} seed, so an inner edge step records it too.
    const st0 = chainNeedsFromV(steps) ? trackFromV(stream) : stream;
    const lowered = this.lowerElementSteps(steps, st0, at);
    return { st: lowered.stream, stop: lowered.next };
  }

  /**
   * The re-enterable tail dispatcher. Routes a Stream + the remaining steps by shape:
   * an elements stream absorbs any further movement/filter (lowerElementSteps) then runs the
   * element tail; a scalar/list stream runs its own tail. A retype step (fold→list,
   * unfold→elements/scalar) inside those tails builds the next Stream and calls back
   * here — so V().fold().unfold().out() flows elements→list→elements→… each phase with
   * its own ≤1 projection. This is what dissolves the old "one projection per traversal"
   * ceiling structurally (each phase has a fresh accumulator).
   */
  private lowerStream(s: Stream, steps: IRStep[], at: number): LoweringResult {
    assertStreamColumns(s);
    if (s.kind === 'result') throw new Error('a terminal result stream cannot have following steps');
    // as()/select(label) over a value-shaped stream bind/read path-history labels — the
    // single home for these shape-agnostic steps; the shape arms below yield to it.
    if (isValueShape(s) && isAliasStep(steps[at])) return dispatchAlias(s, steps, at);
    if (s.kind === 'elements') {
      const lowered = this.lowerElementSteps(steps, s, at);
      return compileTail(lowered.stream, steps, lowered.next);
    }
    if (s.kind === 'scalar') {
      const { stream, stop } = lowerScalarRows(s, steps, at);
      if (stop === steps.length) return continueLowering(stream, stop);
      // A scalar row-run stops at an alias step; yield it to the top-level dispatch.
      if (isAliasStep(steps[stop])) return continueLowering(stream, stop);
      return compileFromScalar(stream, steps, stop);
    }
    if (s.kind === 'variant') return compileFromVariant(s, steps, at);
    if (s.kind === 'property') return compileFromProperty(s, steps, at);
    if (s.kind === 'map') return compileFromMap(s, steps, at);
    if (s.kind === 'mapEntry') return compileFromMapEntry(s, steps, at);
    if (s.kind === 'record') return compileFromRecord(s, steps, at);
    if (s.kind === 'group') return compileFromGroup(s, steps, at);
    if (s.kind === 'path') return compileFromPath(s, steps, at);
    if (s.kind === 'foreign') return compileFromForeign(s, steps, at);
    return compileFromList(s, steps, at);
  }

  /** Iterative semantic orchestrator. It returns the final Stream and knows nothing
   * about Compiled/GraphBinary framing; root callers cross that boundary explicitly.
   * A mid-chain barrier call() (Phase 6b V().call(federate)) makes a shape handler SUSPEND;
   * lowerSteps RELAYS that suspension up unchanged (it never interprets it — the "no second
   * orchestrator" invariant). Only compileRead (the sole ROOT caller) resumes it; every
   * child-scope / inner-compile caller goes through lowerStepsStrict, which asserts a suspension
   * never escapes (a barrier cannot legally occur inside a child scope — it fails closed earlier). */
  lowerSteps(initial: Stream, steps: IRStep[], from: number): Stream | LoweringSuspension {
    let stream = initial;
    let at = from;
    for (;;) {
      assertStreamColumns(stream);
      if (at >= steps.length && stream.kind !== 'elements') return stream;
      const result = this.lowerStream(stream, steps, at);
      if (isSuspension(result)) return result;
      stream = result.stream;
      at = result.at;
    }
  }

  /** lowerSteps for a scope that structurally cannot host a barrier (any child scope / inner
   * sub-traversal compile). A barrier mid-child already fails closed upstream, so a suspension
   * here is an internal contradiction — throw loudly rather than silently mis-type. */
  lowerStepsStrict(initial: Stream, steps: IRStep[], from: number): Stream {
    const out = this.lowerSteps(initial, steps, from);
    if (isSuspension(out)) throw new Error('a barrier call() is not supported in this scope (child/nested sub-traversal)');
    return out;
  }

  /** Build a SegmentPlan from a source-form BarrierPoint. head=null (a source call() has no local
   *  input rows to drain); apply runs the service at execution time; resume lands the awaited
   *  ForeignRow[] as a fresh foreign root stream and lowers the rest of the chain to a Compiled.
   *  The landed element kind is inferred from the rows (first row's kind; vertex when empty). */
  private segmentFromBarrier(bp: BarrierPoint, params: Record<string, any>): SegmentPlan {
    return {
      kind: 'segment',
      head: null,
      params: bp.params,
      apply: bp.apply,
      resume: (foreign: ForeignRow[]) => {
        // A fresh child engine (fresh Query, same app scope) lowers the resumed chain. Gate
        // collapse on the resumed chain (a foreign source is never V/E → collapse off, matching
        // the pre-object behavior where the resume carry carried no fastPaths).
        const eng = this.child(params, bp.restSteps);
        const carry: LoweringState = { q: eng.q, params, traverserLayout: rootLayout() };
        const elem: Elem = foreign[0]?.kind ?? 'vertex';
        const seed = landForeignElements(carry, foreign, elem);
        return { kind: 'sql', compiled: materializeRootStream(eng.lowerStepsStrict(seed, bp.restSteps, bp.restAt)) };
      },
    };
  }

  /** Build a SegmentPlan from a MID-traversal barrier call() (V().call(federate, …)). Unlike the
   *  source form, `head` is a real Compiled (each parent's id/label/props + ordinal + injected value);
   *  the executor drains it and hands the rows to apply, which runs the sibling once per DISTINCT
   *  injected value (batched) and fans the results back over the sharing parents (stamping each
   *  returned row's `ordinal`). resume then just lands that already-per-parent-fanned pool as a
   *  foreign root and continues restSteps — the fan-out + zero-match filtering happened in apply's
   *  JS (a parent that matched nothing simply contributes no rows → flatMap semantics). path()/as()
   *  that SPANS the call is deferred: the parent's carried alias/path columns are not yet threaded
   *  through the segment boundary, so a parent carrying them fails closed with a clear deferral. */
  private segmentFromMidBarrier(bp: MidBarrierPoint): SegmentPlan {
    if (bp.parent.traverserLayout.aliases.size > 0 || bp.parent.traverserLayout.path)
      throw new Error('path()/as() spanning a mid-traversal federated call() is not yet supported (Phase 6b) — the federated result is a detached reference; select the value before the call or run it at the source position');
    return {
      kind: 'segment',
      head: bp.head,
      params: bp.params,
      apply: bp.apply,
      resume: (foreign: ForeignRow[], headRows: readonly ForeignRow[]) => {
        const eng = this.child(bp.boundParams, bp.restSteps);
        const carry: LoweringState = { q: eng.q, params: bp.boundParams, traverserLayout: rootLayout() };
        const elem = foreign[0]?.kind === 'edge' ? 'edge' : bp.parent.elem;
        // Scatter the batched pool back over the parents by the injected value (flatMap: a parent
        // that matched nothing drops), then continue the chain from the rejoined foreign stream.
        const seed = resumeMidBarrier(carry, foreign, headRows, elem, bp.injection);
        return { kind: 'sql', compiled: materializeRootStream(eng.lowerStepsStrict(seed, bp.restSteps, bp.restAt)) };
      },
    };
  }

  /** A read traversal: prefix fold + shaped lowering loop.
   *  `sackInit` (from withSack()) seeds the carried sack column at the source. */
  compileRead(steps: IRStep[], params: Record<string, any> = this.params, sackInit?: SackSpec): Compiled | SegmentPlan {
    // call() as a SOURCE (g.call(...)): the service seeds the initial Stream (of whatever
    // shape it produces — a list of names, a Property stream), and the generic shaped
    // lowering loop takes over from step 1. A peer of the buildPrefix (V/E/union) path, not
    // inside it, because a call() source is not necessarily element-shaped.
    if (steps[0].name === 'call') {
      // A barrier source (federate): its rows come from an awaited sibling call, so the compile
      // suspends into a SegmentPlan. resume lands the awaited ForeignRow[] as a fresh foreign root
      // stream and finishes lowering the rest of the chain synchronously. A pure service never
      // reaches here — it is a `rel` contribution and `seedCall` refuses with the message that says so.
      return this.segmentFromBarrier(seedCall(steps[0], params, this.registry, steps, this.federationDepth), params);
    }

    // Traverser bulking: a `repeat(...).times(n).count()` (path/as/sack-free) compiles to
    // unrolled GROUP-BY-SUM(bulk) CTEs instead of an enumerate-every-walk recursion, so a
    // dense/deep count (grateful times(8) ≈ 2.5e15 walks) stays tractable. Null → not the
    // bulkable shape; fall through to the normal fold. See steps/tail/bulk.ts.
    const bulked = runFastPath(BulkRepeatCountFastPath, fastPathContext(this.fastPaths), this, steps, params, sackInit);
    if (bulked) return bulked;

    // Whole-chain facts, computed ONCE here (analyze): tracksPath + demandsEncounter feed the
    // source seed, and the movementCollapse gate already read collapseSafe at engine construction
    // (collapseSafeFastPaths). Movement collapse discards per-row identity, so it is mutually
    // exclusive with a live encounter — analyze folds that into collapseSafe && !demandsEncounter.
    const facts = analyzeChain(steps);
    const { stream, at } = this.seedRooted(steps, params, sackInit, facts);
    const lowered = this.lowerSteps(stream, steps, at);
    // A mid-traversal barrier call() (V().call(federate)) suspended the fold — build its SegmentPlan.
    if (isSuspension(lowered)) return this.segmentFromMidBarrier(lowered.point as MidBarrierPoint);
    return materializeRootStream(lowered);
  }

  /** buildPrefix on a FRESH child engine (fresh Query, same request scope). The write path calls this
   *  for each independent target-id relation it materializes in one traversal — each gets its own
   *  WITH and its own engine attached to the returned stream's Query (so a nested movement/filter
   *  reaches deps). Collapse is gated off (a write prefix is not a reducer-terminal read chain). */
  buildPrefixFresh(steps: IRStep[], params: Record<string, any> = {}): { st: ElementStream; stop: number } {
    // A write prefix is not a reducer-terminal read chain, so collapse stays gated off (via
    // child()'s fastPaths). The emission encounter is forced ON, and unconditionally: a write walks
    // these rows one at a time assigning ids as it goes, and those ids are observable, so which row
    // comes first is part of the answer (WRITE_STEPS, ir/analyze.ts). It cannot come from
    // `analyzeChain(steps)` here because `steps` is the PREFIX — the write step that demands it has
    // already been sliced off by the caller. It used to be forced OFF, which was correct only while
    // nothing read it back; `renderDriverRows` (steps/write/write.ts) now does. `canCarryEncounter`
    // is the one exception, and it is a CAPABILITY not a preference: a repeat()/match() prefix
    // cannot thread one, so demanding it there declares a layout column the body never produces.
    return this.child(params, steps).buildPrefix(steps, params, undefined, { ...analyzeChain(steps), demandsEncounter: canCarryEncounter(steps) });
  }

  /** A FRESH child engine (fresh Query, same request scope) — see the interface. An explicit
   *  `fastPaths` overrides the inherited config (used by the bulk-repeat handoff to force
   *  movementCollapse on for its already-collapsed frontier). */
  subEngine(params: Record<string, any> = {}, fastPaths?: FastPathConfig): LoweringEngine {
    if (!fastPaths) return this.child(params);
    return new LoweringEngine(this.request, { params, fastPaths });
  }

  /** A variant engine sharing THIS engine's deps but bound to `q` — for the correlated inline
   *  child's `DerivedQuery`. Reuses this engine's (already collapse-gated) fastPaths. */
  withQuery(q: Query): LoweringEngine {
    return new LoweringEngine(this.request, { q, params: this.params, fastPaths: this.fastPaths });
  }

  /** compileRead narrowed to a synchronous Compiled — for INNER sub-traversal compiles (a
   *  within()/all() operand, a merge match/insert body) that structurally cannot be a barrier
   *  source (only a TOP-LEVEL g.call(barrier) suspends). Mints a FRESH child scope (fresh Query,
   *  SAME request scope) so the nested compile inherits registry/fastPaths/depth/source options. Asserts the invariant
   *  rather than silently mis-typing. */
  compileReadCompiled(steps: IRStep[], params: Record<string, any> = {}, sackInit?: SackSpec): Compiled {
    const plan = this.child(params, steps).compileRead(steps, params, sackInit);
    if (plan.kind === 'segment') throw new Error('a nested sub-traversal cannot be a barrier/federated source');
    return plan;
  }

  /** Re-enter the ordinary read lowering from one materialized write traverser. The write path
   * gives us concrete carried values, while the layout remains the compiler's usual alias/path/
   * bulk schema; binding those values into a fresh source relation is therefore a provisioning
   * change, not a second nested-traversal evaluator. */
  compileReadFromElementDriver(steps: IRStep[], params: Record<string, any>, driver: ElementReadDriver): Compiled {
    if (!steps.length) throw new Error('a write driver needs a non-empty read continuation');
    const eng = this.child(params, steps);
    const source: IRStep = { name: driver.elem === 'edge' ? 'E' : 'V', args: [arg(driver.id)], ctx: steps[0].ctx };
    const seeded = eng.seedSource(source, params, false, undefined, false);
    const cols = layoutCols(driver.traverserLayout);
    for (const col of cols)
      if (!(col in driver.carried)) throw new Error(`write driver is missing carried column '${col}'`);
    const p = seeded.rel.as('wd');
    const carried = cols.map((col) => q`${value(driver.carried[col])} AS ${col}`);
    const rel = eng.q.cte(
      q`SELECT ${p.c.id} AS id${carried.length ? q`, ${list(carried, ', ')}` : empty} FROM ${p}`,
      ['id', ...cols],
    );
    // The loop above checks the DRIVER has a value for every declared role; toElementStream checks
    // the RELATION has the column. Two different questions, both needed — the driver's record and
    // the CTE's column list are built from the same `cols`, so a divergence would be a wiring bug.
    const stream = toElementStream({ ...seeded, traverserLayout: driver.traverserLayout }, rel, driver.elem);
    return materializeRootStream(eng.lowerStepsStrict(stream, steps, 0));
  }
}

/** Whether movement collapse is result-safe for this whole chain (see ChainFacts.collapseSafe).
 *  Exposed so the compile-scope wiring can gate the fastPaths flag once per compilation. Takes
 *  ChainFacts (not steps) so the caller's single analyzeChain() serves both this gate and the seed. */
export function collapseSafeFastPaths(base: FastPathConfig, facts: ChainFacts): FastPathConfig {
  return { ...base, movementCollapse: base.movementCollapse && facts.collapseSafe && !facts.demandsEncounter };
}
