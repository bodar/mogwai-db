import type { IRStep } from '../ir/strategies.ts';
import type { AsyncSegmentPlan, Plan, SegmentPlan } from '../segment.ts';
import type { BarrierInput, BarrierOutput, BarrierRelation, BarrierResidency, CallSite, CallSpec, DecorateSpec, ForeignRow, PairSpec, PathSpec, Service } from '../../services/spi/types.ts';
import { isTraversalParam, parseCallSpec } from '../../services/params/call-params.ts';
import { contentDemand, pushableTailPrefix } from '../ir/content-demand.ts';
import { FEDERATE_SERVICE } from '../ir/injection.ts';
import { labelsBoundBefore, preBarrierSelectRead } from '../ir/labels.ts';
import { reducerOf } from '../ir/reducers.ts';
import { isLocalScope } from '../ir/step.ts';
import { arg, isNested } from '../../gremlin/frontend.ts';
import { minter } from './build.ts';
import { landForeignRows } from './foreign.ts';
import { lowerForeignResume, lowerPairResume, lowerPathResume, lowerReduceCombine, lowerScalarResume, lowerToRel, lowerTypedNodeStream, type Lowering, type RelLowering } from './lower.ts';
import { unifiedBoundGraph, type MergedGraph } from './boundgraph.ts';
import { BRANCH_HOSTS } from './lower/branch.ts';
import { rootedSteps } from './lower/reduction.ts';
import { LOCAL_GRAPH } from './lower/chain.ts';
import { decorateGraph } from './decorate.ts';
import { BaseGraph, withExtraBindings, type GraphSource } from './source.ts';
import { finishLowering } from './spine.ts';
import { buildRegexSegment, regexBarrierIn } from './regex.ts';
import { buildReverseSegment, reverseBarrierIn } from './reverse.ts';
import { buildSplitSegment, splitBarrierIn } from './split.ts';
import { buildOrderDedupSegment, buildOrderGlobalSegment, orderDedupBarrierIn, orderGlobalBarrierIn } from './order-dedup-local.ts';
import { asStringBarrierIn, buildAsStringSegment } from './asstring-barrier.ts';
import type { Elem } from '../elem.ts';
import type { FrameNode, ValueNode } from '../../gremlin/types.ts';

// ---------- barrier call() — the segment boundary, on the RelIR route ----------
//
// Every other step in this package lowers to SQL. A BARRIER service cannot: its rows come from
// outside SQLite — a sibling graph over RPC, an object-store document — so they arrive on a Promise,
// and a compiled plan is one statement that cannot await. The model is therefore a plan of SEGMENTS
// glued by service boundaries, driven by the executor (`execute.ts`'s `drive`):
//
//   [ SQL head ] -> drain -> (await apply) -> land the rows -> [ SQL resume ] -> …
//
// The async gap happens ONLY between segments, never inside one — which is also what the DO runtime
// forces, since a SQLite cursor cannot cross an await. "Compile to SQL, never interpret" holds within
// every segment; a barrier is an opaque async transform BETWEEN compiled stages, not a row-at-a-time
// interpreter.
//
// **This module decides only WHERE the boundary is; the algebra on both sides is the ordinary fold.**
// The head is a plain compile of the prefix, and the resume is `lowerForeignResume` — the same tail
// vocabulary, seeded from a landed relation instead of a scan. Nothing here builds SQL.

/** A resolved barrier at a chain position: the service's `apply`, plus where the rest of the chain
 *  begins. `null` from the finder means no barrier — the overwhelmingly common case, and the reason
 *  this is asked before the route rather than discovered inside it. */
interface Barrier {
  readonly at: number;
  readonly site: CallSite;
  readonly spec: CallSpec;
  readonly apply: (rows: readonly BarrierInput[]) => Promise<BarrierOutput>;
  /** The synchronous core of `apply` (the OLAP barriers), letting the SYNC drive run it with no await.
   *  Absent for federate/io (real I/O). See `services/spi/types.ts`. */
  readonly applySync?: (rows: readonly BarrierInput[]) => BarrierOutput;
  /** WHERE this barrier's `apply` runs (§4·3) — carried through to the `SegmentPlan` so the drive
   *  loop can decide whether the Worker may drive it (`'worker'`) or it must stay DO-side (`'do'`). */
  readonly residency: BarrierResidency;
  /** Present iff this is a DECORATE barrier (an OLAP algorithm): `apply` returns a `(id → value)`
   *  relation and the resume keeps the LIVE element stream, reading the value as a synthetic property
   *  under `decorate.key`. Absent for `federate`/`io` (detached `ForeignRow[]` + `lowerForeignResume`). */
  readonly decorate?: DecorateSpec;
  /** Present iff this is a PATH barrier (weighted shortestPath): `apply` returns a `(run, round)` handle
   *  into `barrier_state` and the resume reconstructs the shortest PATHS from it, REPLACING the stream
   *  (unlike `decorate`, which passes elements through). */
  readonly path?: PathSpec;
  /** Present iff this is a PAIR barrier (node-similarity): `apply` returns a `(run, round)` handle into
   *  `barrier_state` (scope = node1, id = node2, channel 0 = score) and the resume frames each pair as a
   *  MAP — a stream of `{key1, key2, valueKey}` maps, a new output shape. */
  readonly pairs?: PairSpec;
  /** Where the LOCAL suffix resumes: `at + 1`, PLUS any tail steps a pushdown pushed to the sibling
   *  (win 2a). The resume lowers from here; `site.pushdown` (if present) carries the synthesized sibling
   *  Gremlin `apply` runs and whether it `reduces` (a scalar result). */
  readonly suffixFrom: number;
}

/** What a segment needs from the enclosing request — the same settled values the RelIR route takes,
 *  plus the hop depth a barrier's `apply` closure captures at resolve time. */
export interface SegmentRequest {
  readonly services: ReadonlyMap<string, Service>;
  readonly params: Record<string, any>;
  readonly federationDepth: number;
  /** The lowering options the RESUMED chain compiles under — the same object the route hands
   *  `lowerToRel`, so the two halves of one traversal cannot disagree about collapse, the label
   *  regime or which services are resolved. */
  readonly lowering: Lowering;
}

/**
 * THE FIRST BARRIER in the chain, or `null`.
 *
 * A service's `resolve` may THROW (it validates its own params — `io()` rejects a GraphML path), and
 * that throw is the ANSWER rather than a decline (§6·5): the user asked for something the service
 * refuses, and swallowing it would hand the traversal on as if it were merely uncovered.
 */
/** The pushdown inferred for the ARG-LESS federate form, or `null`. Only fires when the barrier is
 *  federate AND the user gave NO `traversal` arg (an explicit arg means they drew the boundary — no
 *  inference).
 *
 *  **Pushdown finds the boundary, then the pushed prefix IS the sub-traversal — treated identically to an
 *  explicit `traversal` arg.** `pushableTailPrefix` finds the longest remote-safe prefix; its steps become
 *  the sibling query, synthesized from their OWN source text (`ctx.getText()` per step — a bound `$x` stays
 *  a param the sibling resolves — re-rooted at `g`; no un-parser, locked decision). The prefix's steps are
 *  ALSO where a pre-barrier alias is read, so the arg-less MID form needs no separate branch: every
 *  downstream reader sees the same label fact whether the body was explicit or inferred.
 *
 *  THE BREAK POINT for an injection is AT the marker step: a marker is a per-parent FILTER on the sibling,
 *  so anything AFTER it (a reducer, a `values`) is LOCAL processing of the scattered result — exactly the
 *  explicit form's split (its `traversal` ends at the marker; the reducer is the local tail). So a
 *  marker-bearing prefix ends right after the marker, `reduces:false`. Without a marker the whole prefix
 *  pushes (source form), reducer included. `null` when nothing pushes (an empty prefix). */
function inferredPushdown(
  steps: readonly IRStep[], at: number, spec: CallSpec, params: Record<string, any>,
): { siblingGremlin: string; prefixLength: number; reduces: boolean; injectionLabel?: string } | null {
  if (spec.serviceName !== FEDERATE_SERVICE || spec.params.traversal != null) return null;
  const prefix = pushableTailPrefix(steps, at, params);
  if (prefix.length === 0) return null;
  const prefixLength = prefix.length;
  const pushed = steps.slice(at + 1, at + 1 + prefixLength);
  const siblingGremlin = 'g.' + pushed.map((s) => s.ctx.getText()).join('.');
  // A source-rooted sibling query (the first pushed step is the tail's `.V()`/`.E()` re-source) — the
  // same shape the explicit `traversal` arg must have. A tail that does not re-source cannot be pushed as
  // a source query, so it declines to push (stays local) rather than synthesize an unrooted `g.…`.
  if (!siblingGremlin.startsWith('g.V(') && !siblingGremlin.startsWith('g.E(')) return null;
  return {
    siblingGremlin, prefixLength, reduces: prefix.reduces,
    ...(prefix.injectionLabel ? { injectionLabel: prefix.injectionLabel } : {}),
  };
}

/** The standard injection spelling in an explicit federate sub-traversal. The binding is intentionally
 * read from the outer chain: `select()` passes the scoped value through unchanged
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectStep.java:66-89`). */
function explicitInjectionLabel(steps: readonly IRStep[], at: number, spec: CallSpec, params: Record<string, any>): string | undefined {
  const traversal = spec.params.traversal;
  if (!isTraversalParam(traversal)) return undefined;
  return preBarrierSelectRead(traversal.steps, labelsBoundBefore(steps, at, params), params) ?? undefined;
}

/** The MID-TRAVERSAL REDUCTION pushdown, or `null`. Fires when: this is a federate barrier NOT at the
 *  source (a mid-traversal `V().call(…)`), it carries an INJECTION (so results scatter per parent), and
 *  the local tail is EXACTLY one bare reducer that SPLITS (`reducers.ts`). Then the sibling computes a
 *  per-parent PARTIAL (`group().by().by(<partial>())`, keyed by origin for the marker route or by the
 *  ordinary map key for mapValues) and the resume COMBINES per parent
 *  — the same answer as the element scatter + local reduce, only a `(key→partial)` map crosses. Mean
 *  (`partial:null`, reduce-first to two partials) is a follow-up — declines here for now. */
function inferredReduce(
  steps: readonly IRStep[], at: number, spec: CallSpec, injectionLabel: string | undefined, suffixFrom: number,
): NonNullable<CallSite['mapValues']>['reduce'] | undefined {
  if (spec.serviceName !== FEDERATE_SERVICE || at === 0 || !injectionLabel) return undefined;
  // Pushdown has already moved the remote V()/E() prefix to the sibling. Only the remaining LOCAL
  // suffix decides whether this is a per-parent reduction.
  const tail = steps.slice(suffixFrom);
  const only = tail.length === 1 ? tail[0]! : undefined;
  if (!only || only.args.length !== 0 || isLocalScope(only)) return undefined;
  const reducer = reducerOf(only.name);
  if (!reducer || reducer.partial == null || reducer.combine == null) return undefined; // mean/unsplittable → follow-up
  return { partial: reducer.partial, combine: reducer.combine, empty: reducer.empty };
}

function barrierIn(steps: readonly IRStep[], request: SegmentRequest): Barrier | null {
  for (let at = 0; at < steps.length; at++) {
    const step = steps[at]!;
    if (step.name !== 'call') continue;
    const spec = parseCallSpec(step, request.params);
    // AN UNREGISTERED NAME IS AN ERROR, not a decline — the user named something that does not exist,
    // and no other route is going to answer it (§6·5: two facts wear one `null`, and this is the
    // permanent one). Raised here rather than inside the fold because the fold's contract is `null`
    // and a name that resolves to nothing is a question about the traversal's own text.
    const service = request.services.get(spec.serviceName);
    if (!service) throw new Error(`call(): unknown service '${spec.serviceName}'`);
    // PUSHDOWN (win 2a): the ARG-LESS federate form (`call(federate,{graph}).V()…`, no `traversal` arg)
    // INFERS what runs on the sibling. `pushableTailPrefix` finds the longest remote-safe prefix of the
    // tail; the sibling Gremlin is that prefix's OWN SOURCE TEXT (`ctx.getText()` per step — no un-parser,
    // per the locked decision), re-rooted at `g`. When the user gave an explicit `traversal`, they drew
    // the boundary and nothing is inferred (`pushdown` stays undefined). The LOCAL demand + resume then
    // run over the SUFFIX, not the whole tail.
    const pushdown = inferredPushdown(steps, at, spec, request.params);
    const suffixFrom = at + 1 + (pushdown?.prefixLength ?? 0);
    // Fold either form's pre-barrier alias onto an effective spec so every downstream reader sees the
    // same mapValues injection fact.
    const injectionLabel = pushdown?.injectionLabel ?? explicitInjectionLabel(steps, at, spec, request.params);
    const effectiveSpec: CallSpec = injectionLabel
        ? { ...spec, injectionLabel }
        : spec;
    // MID-TRAVERSAL REDUCTION (monoid transport optimization): a mid federate whose tail is a bare reducer
    // pushes the reduction as a per-parent grouped PARTIAL; the resume combines per parent.
    const reduce = inferredReduce(steps, at, effectiveSpec, injectionLabel, suffixFrom);
    // The local tail (after any pushed prefix) is a fact ABOUT this call site — the same category as
    // `federationDepth`. It travels on `CallSite.tailDemand`/`CallSite.pushdown`, the structure that means
    // "facts about this call site", NOT through `params` (a user channel) or the `apply` closure.
    const site: CallSite = {
      params: spec.params, boundParams: request.params, federationDepth: request.federationDepth,
      mapValues: injectionLabel ? { param: freshMapValuesParam(request.params), label: injectionLabel, ...(reduce ? { reduce } : {}) } : undefined,
      tailDemand: contentDemand(steps, suffixFrom),
      pushdown: pushdown ? { siblingGremlin: pushdown.siblingGremlin, suffixFrom, reduces: pushdown.reduces } : undefined,
    };
    const contribution = service.resolve(site);
    if (contribution.kind !== 'barrier') continue;   // a `rel` service lowers inline; not a boundary
    // Carry the EFFECTIVE spec (with the arg-less injection folded in) so `midSegment`/`injectionOf` read
    // the injection identically for both forms.
    return { at, site, spec: effectiveSpec, apply: contribution.apply, applySync: contribution.applySync, residency: contribution.residency, decorate: contribution.decorate, path: contribution.path, pairs: contribution.pairs, suffixFrom };
  }
  return null;
}

/**
 * A federate barrier NESTED in a branch arm (`union`/`choose`/`optional`/`coalesce`), or `null`.
 *
 * Consulted ONLY when no top-level barrier fires (a top-level `call()` always resolves first), so it
 * opens the multi-graph merge without disturbing any single-spine case. It reuses `barrierIn` VERBATIM
 * on each arm's OWN body — the finder was always position-agnostic, it just had never been called from a
 * second place — so a federate call inside an arm resolves its pushdown/injection exactly as it would at
 * the top level.
 *
 * Phase-scoped, fail closed on the rest: the arm's barrier must be a SOURCE-form federate at arm-local
 * position 0 (`barrier.at === 0`, no injection), so its `apply` runs over no input and its rows land as
 * an ordinary bound graph the arm then reads. A richer arm (a mid-form injection, a non-federate
 * barrier) is not matched here; its `call` step then declines in the ordinary fold and the traversal
 * raises `UnsupportedTraversal` rather than answering a different question.
 */
function nestedBarrierIn(
  steps: readonly IRStep[], request: SegmentRequest,
): { readonly branchAt: number; readonly armIndex: number; readonly barrier: Barrier } | null {
  for (let at = 0; at < steps.length; at++) {
    const step = steps[at]!;
    if (!BRANCH_HOSTS.has(step.name)) continue;
    const argVals = step.args.map((a) => a.value);
    for (let armIndex = 0; armIndex < argVals.length; armIndex++) {
      const v = argVals[armIndex]!;
      if (!isNested(v)) continue;
      const body = rootedSteps((v as { readonly nested: unknown }).nested, request.params);
      if (!body?.length) continue;
      // Only pay `barrierIn` (which resolves services, and THROWS on an unknown one) for an arm that
      // actually holds a `call()` — the overwhelming majority of branch arms hold none, and this keeps a
      // barrier-free `union(out(), in())` on its ordinary path untouched.
      if (!body.some((s) => s.name === 'call')) continue;
      const barrier = barrierIn(body, request);
      // Source-form federate at arm-local position 0: no local head, no per-parent injection. Anything
      // else stays for a later phase (and fails closed via the arm's own decline in the fold).
      if (!barrier || barrier.at !== 0) continue;
      if (barrier.spec.serviceName !== FEDERATE_SERVICE || barrier.spec.injectionLabel || barrier.site.mapValues) continue;
      // A federate arm the user WANTS merged: the post-merge tail must be safe, else FAIL CLOSED
      // (return null → the arm's call declines in the fold → `UnsupportedTraversal`), never misjoin.
      const mode = postMergeTail(steps, at);
      if (mode === 'unsafe') return null;
      // A post-merge ELEMENT read rejoins the graph-tagged unified relation, which holds only the FEDERATE
      // arms' landed CTEs — a BASE arm's elements (`$local`) have no landed relation to rejoin, so a mixed
      // base+federate merge with an element tail fails closed (Phase 3b: the base graph in the union).
      // `count`/`dedup` over such a mix are fine (no rejoin), so this gate is specific to `elements`.
      if (mode === 'elements' && !allArmsFederate(step, request.params)) return null;
      return { branchAt: at, armIndex, barrier };
    }
  }
  return null;
}

/** Is EVERY arm of a branch a federate-derived element source — either an un-landed federate `call()` or
 *  an already-landed marker (`landedSource`)? A BASE arm (a bare `V()`/`E()` reading the local graph) is
 *  NOT, and it has no landed relation for the unified post-merge rejoin, so an element-read merge that
 *  includes one fails closed. A non-element arm shape declines too (only element arms merge here). */
function allArmsFederate(branchStep: IRStep, params: Record<string, any>): boolean {
  return branchStep.args.every((a) => {
    if (!isNested(a.value)) return false;
    const body = rootedSteps((a.value as { readonly nested: unknown }).nested, params);
    const head = body?.[0];
    return !!head && (head.name === 'call' || head.landedSource != null);
  });
}

/** Cardinality/slice steps — consume a merged element stream touching neither element payload nor
 *  identity. `count` is the one terminal that reduces it to a scalar (so the merged elements never
 *  materialize against ONE graph's rows). */
const CARDINALITY_STEPS: ReadonlySet<string> = new Set(['count', 'limit', 'range', 'skip']);
/** Identity-collapsing steps admitted in Phase 2 — served correctly by the `graph` discriminator that
 *  `nestedBranchSegment` stamps. `dedup` first; `group`/`groupCount` by(id) are a follow-up. */
const IDENTITY_STEPS: ReadonlySet<string> = new Set(['dedup']);
/** Post-merge reads served by `unifiedBoundGraph`'s INPUT-CARRYING methods (Phase 3): `values(k)` and a
 *  bare element return (an empty suffix) rejoin the graph-tagged unified relation by `(graph, id)`;
 *  slice rides along untouched. `hasLabel`/`has`/movement need the id-only rejoin and stay unsafe. */
const ELEMENT_READ_STEPS: ReadonlySet<string> = new Set(['values', 'limit', 'range', 'skip']);

/** How the tail AFTER a nested-branch federate merge (`steps` from `branchAt + 1`) may consume the
 *  merged multi-graph element stream:
 *   - `cardinality` — pure count/slice ending in `count()`: correct with NO discriminator (Phase 1).
 *   - `identity` — adds `dedup`: correct once every arm carries the `graph` discriminator (Phase 2).
 *   - `elements` — materializes the merged elements (`values(k)`, a bare element return, slice): correct
 *     once every arm is tagged AND the post-merge source is the graph-tagged `unifiedBoundGraph` (Phase 3).
 *   - `unsafe` — a `hasLabel`/`has`/movement read (needs the id-only rejoin), or anything unrecognized.
 *     FAIL CLOSED: never misjoin against one graph.
 *  A tail ENDING IN `count()` reduces to a scalar (no materialization); otherwise the merged elements
 *  ARE the result (materialized) or read by `values`. */
function postMergeTail(steps: readonly IRStep[], branchAt: number): 'cardinality' | 'identity' | 'elements' | 'unsafe' {
  const suffix = steps.slice(branchAt + 1);
  const demand = contentDemand(steps, branchAt + 1);
  if (suffix.some((s) => s.name === 'count')) {
    if (demand.reachesElements || demand.reachesAdjacency) return 'unsafe'; // an element read before the count
    const hasDedup = suffix.some((s) => IDENTITY_STEPS.has(s.name));
    const allowed = suffix.every((s) => CARDINALITY_STEPS.has(s.name) || (hasDedup && IDENTITY_STEPS.has(s.name)));
    if (!allowed) return 'unsafe';
    return hasDedup ? 'identity' : 'cardinality';
  }
  // No count → the merged ELEMENTS are the result (materialized) or read by `values`. Movement needs the
  // id-only rejoin `unifiedBoundGraph` does not implement, so it stays unsafe.
  if (demand.reachesAdjacency) return 'unsafe';
  return suffix.every((s) => ELEMENT_READ_STEPS.has(s.name)) ? 'elements' : 'unsafe';
}

/**
 * A branch (`union` …) whose arm holds a source-form federate barrier: run that ONE arm's sibling call,
 * LAND its rows as a bound graph, REWRITE the arm to read the landed relation, and RE-PLAN the whole
 * traversal. The re-plan finds the NEXT un-landed arm (a second sibling graph) as its own segment, so N
 * arms land as N bound graphs before the branch's SQL merges them — the linear trampoline driving each
 * sibling RPC in turn. Bindings accumulate on the source via `withExtraBindings`, exactly as
 * `decorateSegment` stacks `decorateGraph` layers, so the arm compiles as an ordinary effects-free
 * `V()`/`E()` read and the union/merge machinery needs no change (its arms never see provenance).
 */
function nestedBranchSegment(
  steps: readonly IRStep[],
  found: { readonly branchAt: number; readonly armIndex: number; readonly barrier: Barrier },
  request: SegmentRequest,
): SegmentPlan {
  const { branchAt, armIndex, barrier } = found;
  const branchStep = steps[branchAt]!;
  const armArg = branchStep.args[armIndex]!;
  const armBody = rootedSteps((armArg.value as { readonly nested: unknown }).nested, request.params)!;
  // A per-arm salt so two arms' landings (each with its own fresh minter restarting at 0) cannot mint
  // the same `bgv0`/`bge0` binding name and collide when both CTEs coexist in the merged plan.
  const salt = `n${branchAt}a${armIndex}`;
  const callCtx = armBody[barrier.at]!.ctx;
  // When the post-merge tail needs per-graph IDENTITY (`dedup`) or MATERIALIZES the merged elements
  // (`values`/bare return — Phase 3), every arm must carry a `graph` tag so the merged stream keeps its
  // per-graph identity — this arm its own sibling graph name, the others `$local` for the base graph or
  // their own name when they land. A pure cardinality tail (count only) needs no tag.
  const mode = postMergeTail(steps, branchAt);
  const tagged = mode === 'identity' || mode === 'elements';
  const graphName = String(barrier.spec.params.graph);
  return {
    kind: 'segment',
    mode: 'async',
    head: null,
    params: barrier.site.params,
    apply: barrier.apply,
    applySync: barrier.applySync,
    residency: barrier.residency,
    resume: (out: BarrierOutput): Plan => {
      if (!Array.isArray(out))
        throw new Error(`federate inside a ${branchStep.name} arm produced a non-element result — only an element sub-traversal is supported in an arm yet; move a reducer/value terminal to the top-level tail`);
      const foreign = out as ForeignRow[];
      const elem: Elem = foreign[0]?.kind ?? 'vertex';
      const fresh = minter();
      const { vertexBinding, edgeBinding, streamElem, bindings } = landForeignRows(foreign, elem, fresh, null, salt);
      // The arm becomes a marker `V()`/`E()` reading the landed relation, followed by whatever LOCAL
      // suffix the arm had after any pushed prefix (`barrier.suffixFrom`).
      const marker: IRStep = { name: streamElem === 'edge' ? 'E' : 'V', args: [], ctx: callCtx, landedSource: { vertexBinding, edgeBinding }, ...(tagged ? { graphTag: graphName } : {}) };
      const newBody: IRStep[] = [marker, ...armBody.slice(barrier.suffixFrom)];
      const rewrittenBranch: IRStep = {
        ...branchStep,
        args: branchStep.args.map((a, i) => (i === armIndex ? { ...a, value: { nested: newBody } } : tagged ? stampLocalArm(a, request.params) : a)),
      };
      const rewrittenSteps = steps.map((s, i) => (i === branchAt ? rewrittenBranch : s));
      // A POST-MERGE ELEMENT READ (`values`/bare return) rejoins the graph-tagged UNIFIED relation, so the
      // post-merge source is a `unifiedBoundGraph` over ALL arms landed so far (accumulated across
      // segments on `lowering.mergedGraphs`). Otherwise the per-arm CTEs just ride on the source as
      // bindings (`withExtraBindings`) — the arms read their own markers and the tail never rejoins.
      const lowering: Lowering = mode === 'elements'
        ? (() => {
            const merged: MergedGraph[] = [...(request.lowering.mergedGraphs ?? []), { graph: graphName, vertexBinding, edgeBinding, bindings }];
            return { ...request.lowering, source: unifiedBoundGraph(merged), mergedGraphs: merged };
          })()
        : { ...request.lowering, source: withExtraBindings(request.lowering.source ?? BaseGraph, bindings) };
      return planOf(rewrittenSteps, { ...request, lowering });
    },
  };
}

/** Stamp the `$local` graph tag on a SIBLING arm of an identity-sensitive merge that reads the BASE
 *  graph (a bare `V()`/`E()`, not yet a landed marker or a federate call). A federate-call arm is left
 *  alone — it stamps its OWN sibling-graph name when its segment lands it — and an already-tagged marker
 *  or a non-element arm is left unchanged. Idempotent, so it survives the re-plan across N arms. */
function stampLocalArm<T extends { readonly value: unknown }>(arg: T, params: Record<string, any>): T {
  if (!isNested(arg.value)) return arg;
  const body = rootedSteps((arg.value as { readonly nested: unknown }).nested, params);
  const head = body?.[0];
  if (!head || head.name === 'call' || head.landedSource || head.graphTag != null) return arg;
  if (head.name !== 'V' && head.name !== 'E') return arg;
  return { ...arg, value: { nested: [{ ...head, graphTag: LOCAL_GRAPH }, ...body.slice(1)] } };
}

/**
 * THE INJECTION a mid-traversal call declares — the pre-barrier alias value its sibling reads.
 */

/** Pick an ordinary sibling variable that cannot shadow a user binding carried into the pushed tail. */
function freshMapValuesParam(params: Record<string, any>): string {
  // `map` itself is a Gremlin GType token, not a VariableContext, so use an ordinary identifier
  // that cannot be parsed as a grammar keyword.
  let param = 'injectedMap';
  while (Object.hasOwn(params, param)) param += '_';
  return param;
}

/**
 * Plan a traversal containing a barrier `call()` as a SEGMENT, or `null` if it contains none.
 *
 * Two forms, and the difference is entirely in the HEAD. A SOURCE barrier (`g.call(…)`, and the `io()`
 * step the IR normalizes into one) has no local input, so `head` is null and `apply` runs over nothing.
 * A MID-traversal barrier (`V().call(federate, …)`) runs once per parent, so the head is a compile of
 * the prefix ending in the INJECTION READ — one row per parent, carrying the one value the service
 * consumes.
 *
 * **The head projects the injected VALUE, not the parent element**, and that is the substrate
 * difference from the route this replaces. A barrier reads exactly one field of its input
 * (`BarrierInput`), so materializing each parent's id, label set and property bag to reach it was work
 * whose only consumer threw it away. What the resume needs from the parents is equally narrow: the
 * values to match on, and how many there are.
 */
export function segmentPlan(steps: readonly IRStep[], request: SegmentRequest): SegmentPlan | null {
  const call = barrierIn(steps, request);
  const regex = regexBarrierIn(steps);
  const reverseAt = reverseBarrierIn(steps);
  const split = splitBarrierIn(steps);
  const orderDedup = orderDedupBarrierIn(steps);
  const orderGlobal = orderGlobalBarrierIn(steps);
  const asStr = asStringBarrierIn(steps, request.lowering);
  // The EARLIEST boundary wins: a segment's head is the prefix BEFORE it, so a later barrier belongs to
  // that head's resumed tail, not to this segment. A value-transform boundary (a regex `has()`, a
  // `reverse()`, a `split()`) is asked here rather than discovered in the fold, for the same reason as a
  // barrier `call()` (§6·5). Each is a distinct step, so their positions never tie. A declined
  // value-transform barrier (e.g. a non-scalar `reverse()`/`split()` head) returns `null` so the fold
  // lowers the step its own way.
  const callAt = call ? call.at : Infinity;
  const regexAt = regex ? regex.at : Infinity;
  const revAt = reverseAt ?? Infinity;
  const splitAt = split ? split.at : Infinity;
  const odAt = orderDedup ? orderDedup.at : Infinity;
  const ogAt = orderGlobal ? orderGlobal.at : Infinity;
  const asStrAt = asStr ? asStr.at : Infinity;
  const earliest = Math.min(callAt, regexAt, revAt, splitAt, odAt, ogAt, asStrAt);
  if (earliest === Infinity) {
    // No barrier on the top-level spine — look for a federate barrier NESTED in a branch arm (the
    // multi-graph merge, `union(federate(A)…, federate(B)…)`). Only reached here, so a top-level
    // barrier always wins and the single-spine cases are untouched.
    const nested = nestedBarrierIn(steps, request);
    return nested ? nestedBranchSegment(steps, nested, request) : null;
  }
  if (earliest === splitAt) return buildSplitSegment(steps, split!.at, split!.separator, request.lowering);
  if (earliest === revAt) return buildReverseSegment(steps, reverseAt!, request.lowering);
  // order/dedup(Scope.local) over a NESTED scalar list — declines (→ inline fold) for a scalar/flat-list or
  // element-membered head.
  if (earliest === odAt) return buildOrderDedupSegment(steps, orderDedup!.at, orderDedup!.op, request.lowering);
  // A GLOBAL bare order() over a LIST stream — declines (→ inline SQL fold) for a scalar/element head, so a
  // scalar `values().order()` stays in SQL untouched.
  if (earliest === ogAt) return buildOrderGlobalSegment(steps, orderGlobal!.at, request.lowering);
  if (earliest === asStrAt) return buildAsStringSegment(steps, asStr!.at, request.lowering);
  if (earliest === regexAt) return buildRegexSegment(steps, regex!, request.lowering, (tail) => planOf(tail, request));
  // A DECORATE barrier (an OLAP algorithm) keeps the LIVE element stream — it does not land detached
  // rows — so it takes its own resume, not the source/mid foreign one.
  if (call!.decorate) return decorateSegment(steps, call!, request);
  // A PATH barrier (weighted shortestPath) REPLACES the stream with reconstructed paths.
  if (call!.path) return pathSegment(steps, call!, request);
  // A PAIR barrier (node-similarity) PRODUCES a stream of scored-pair maps — a source-form global compute.
  if (call!.pairs) return pairSegment(steps, call!, request);
  return call!.at === 0 ? sourceSegment(steps, call!, request) : midSegment(steps, call!, request);
}

/** A resumed chain to its `Plan` — another segment if the tail STILL holds a barrier (a second regex,
 *  a chained OLAP `call()` such as `pageRank().connectedComponent()`), else the SQL compile. A resume
 *  CANNOT decline: the prior barrier has already run, so a tail the lowering cannot cover RAISES rather
 *  than returning a silent different answer. Shared by the regex resume (which re-injects
 *  `within(<survivors>)`) and the decorate resume (which re-reads through a `decorateGraph` stack). */
function planOf(steps: readonly IRStep[], request: SegmentRequest): Plan {
  const segment = segmentPlan(steps, request);
  if (segment) return segment;
  const lowered = lowerToRel(steps, request.lowering);
  if (!lowered) throw new Error('barrier resume: no lowering covers the traversal after the barrier — push the unsupported step into the sub-traversal the service runs, or file it as a resume gap');
  return { kind: 'sql', compiled: finishLowering(lowered) };
}

/** A MID-traversal barrier: the prefix plus the injection read is the head, and the pool comes back to
 *  be scattered over the parents by the value each one asked with. A prefix this route cannot lower
 *  declines WHOLE — there is no half-segment, and the parents must come from the same algebra the
 *  resume continues in. */
function midSegment(steps: readonly IRStep[], barrier: Barrier, request: SegmentRequest): SegmentPlan | null {
  // With no injection the sub-traversal is a constant, and the head exists only to COUNT the parents —
  // `id()` is the cheapest one-row-per-traverser read, and its value is never matched on.
  const call = steps[barrier.at]!;
  // The injection READ is the user's own body, taken verbatim rather than re-synthesized from
  // the classification — `injectionKindOf` already parsed it, and re-minting a `values(k)` step would be
  // a second spelling of the same read for the classifier to drift from.
  const read: readonly IRStep[] = barrier.spec.injectionLabel
    ? [{ name: 'select', args: [arg(barrier.spec.injectionLabel)], ctx: call.ctx }]
    : [{ name: 'id', args: [], ctx: call.ctx }];
  const lowered = lowerToRel([...steps.slice(0, barrier.at), ...read], request.lowering);
  if (!lowered) return null;
  const head = finishLowering(lowered);
  // A head is ONE statement the executor drains before the await. A program (a write in the prefix)
  // would be a second execution boundary inside the head, which the segment loop has nowhere to run.
  if (head.kind !== 'read') return null;
  return {
    kind: 'segment',
    mode: 'async',
    head,
    params: barrier.site.params,
    apply: barrier.apply,
    applySync: barrier.applySync,
    residency: barrier.residency,
    resume: (out: BarrierOutput, headRows: readonly BarrierInput[]): Plan =>
      resumed(steps, barrier, request, out, {
        parentCount: headRows.length, injected: barrier.spec.injectionLabel !== undefined,
      }),
  };
}

/** Is the prefix a BARE source (`V()`/`E()` alone)? TinkerPop pushes such a `GraphStep` past the OLAP
 *  step, so it is NOT a preceding traversal-vertex-program — no `HaltedTraversersCount` initial rank. Any
 *  richer prefix (a filter/movement) IS a preceding program, so its per-vertex traverser count seeds the
 *  algorithm (`VertexProgramStep.previousTraversalVertexProgram`). */
const bareSource = (prefix: readonly IRStep[]): boolean =>
  prefix.length === 1 && (prefix[0]!.name === 'V' || prefix[0]!.name === 'E');

/** A DECORATE barrier (an OLAP algorithm — `pageRank`/`connectedComponent`/`peerPressure`). The compute
 *  is GLOBAL and reads the store inside `apply`; the prefix is re-lowered LIVE inside
 *  `lowerDecorateResume`, which threads the awaited `(id → value)` relation as a synthetic property under
 *  `decorate.key` and keeps the element stream flowing.
 *
 *  When the barrier declares `seedFromInput` and the prefix is NOT a bare source, the head projects the
 *  incoming element id per traverser (uncollapsed, so multiplicity survives as row count) — the barrier's
 *  view of its input, which pageRank reads as its initial rank. A bare source keeps `head` null. */
/** `<prefix>.id()` compiled with collapse OFF — one row per incoming traverser (a collapsed `SUM(bulk)`
 *  would hide the multiplicity an initial rank / a source set needs), as a `read` head or null if it does
 *  not compile to one. The shared input head of every barrier that seeds from its incoming vertices
 *  (`decorateSegment`'s `seedFromInput`, `pathSegment`'s always-on source set). */
function idHead(steps: readonly IRStep[], at: number, lowering: Lowering) {
  const lowered = lowerToRel([...steps.slice(0, at), { name: 'id', args: [], ctx: steps[at]!.ctx } as IRStep], { ...lowering, collapse: false });
  const compiled = lowered && finishLowering(lowered);
  return compiled && compiled.kind === 'read' ? compiled : null;
}

function decorateSegment(steps: readonly IRStep[], barrier: Barrier, request: SegmentRequest): SegmentPlan {
  const { channels, seedFromInput } = barrier.decorate!;
  const prefix = steps.slice(0, barrier.at);
  // The input head: `<prefix>.id()` with collapse OFF, so each incoming traverser is one row (a
  // collapsed `SUM(bulk)` would hide the multiplicity the initial rank needs). A `read` (value) head —
  // `readSegmentHead` turns each row into `{injectedValue: id}`.
  const inputHead = seedFromInput && !bareSource(prefix)
    ? idHead(steps, barrier.at, request.lowering)
    : null;
  return {
    kind: 'segment',
    mode: 'async',
    head: inputHead,
    params: barrier.site.params,
    apply: barrier.apply,
    applySync: barrier.applySync,
    residency: barrier.residency,
    resume: (out: BarrierOutput): Plan => {
      // A decorate barrier's own `apply` returns a relation, never `ForeignRow[]` — a foreign result
      // here is a service-authoring bug, not a user error.
      if (Array.isArray(out))
        throw new Error(`call("${barrier.spec.serviceName}"): a decorate barrier must return an (id → value) relation, not detached rows`);
      const relation = out as BarrierRelation;
      // The chain WITHOUT the algorithm's own call() step — the live prefix plus the tail — re-planned
      // over a `decorateGraph` STACKED on the current source. Re-planning (not lowering straight to SQL)
      // is what makes a SECOND barrier in the tail — `pageRank().connectedComponent()` — its own segment:
      // `planOf` finds it, its head reads THROUGH this decoration, and its resume stacks another layer,
      // so both scores land on the final stream. When the tail holds no further barrier `planOf` lowers
      // it to one SQL statement, exactly as the single-decorate case always did. The source self-declares
      // its landed CTE (`decorateGraph.bindings`, collected at `lowered()`), so nothing threads a binding
      // by hand and a stack's several CTEs coexist under their `run`-derived names.
      const chainSteps = [...steps.slice(0, barrier.at), ...steps.slice(barrier.at + 1)];
      // One decorateGraph LAYER per channel the algorithm wrote (GDS CompositeNodeValue): a single-scalar
      // barrier stacks one, HITS stacks hub over auth. Each layer reads its own `(run, round, channel)`
      // cell and delegates other keys down the stack, so every decorated key composes on the live stream.
      const source = channels.reduce<GraphSource>(
        (base, ch) => decorateGraph(base, relation.run, relation.round, ch.channel, ch.key, ch.vtype),
        request.lowering.source ?? BaseGraph,
      );
      return planOf(chainSteps, { ...request, lowering: { ...request.lowering, source } });
    },
  };
}

/** The shell BOTH relation-handle barriers share — a `(run, round)` producer whose resume re-lowers the
 *  tail off the landed state. `apply` returns a handle, never rows (an `Array.isArray(out)` is a
 *  service-authoring bug); `resume` re-lowers via `relower` and refuses clearly if the tail needs
 *  something this route cannot frame. Only `head`, the barrier noun, and the resume lowering differ —
 *  `pathSegment` seeds from its source ids, `pairSegment` is a global source form. */
function relationHandleSegment(
  steps: readonly IRStep[], barrier: Barrier,
  head: AsyncSegmentPlan['head'], noun: string,
  relower: (run: number, round: number) => RelLowering | null,
): SegmentPlan {
  return {
    kind: 'segment',
    mode: 'async',
    head,
    params: barrier.site.params,
    apply: barrier.apply,
    applySync: barrier.applySync,
    residency: barrier.residency,
    resume: (out: BarrierOutput): Plan => {
      if (Array.isArray(out))
        throw new Error(`call("${barrier.spec.serviceName}"): a ${noun} barrier must return a (run, round) relation handle, not detached rows`);
      const relation = out as BarrierRelation;
      const resumed = relower(relation.run, relation.round);
      if (!resumed) {
        const next = steps[barrier.at + 1];
        throw new Error(
          next
            ? `${next.name}() is not supported after ${barrier.spec.serviceName} yet`
            : `${barrier.spec.serviceName} produced a result this route cannot frame`,
        );
      }
      return { kind: 'sql', compiled: finishLowering(resumed) };
    },
  };
}

/** A PATH barrier (weighted shortestPath). The head projects the SOURCE ids — the incoming traverser
 *  vertices the search runs from (always, unlike decorate's optional `seedFromInput`), one row per
 *  source, collapse off. `apply` relaxes the weighted shortest distance from those sources into
 *  `barrier_state` and returns the `(run, round)` handle; `lowerPathResume` reconstructs the paths and
 *  continues the tail, REPLACING the stream. */
function pathSegment(steps: readonly IRStep[], barrier: Barrier, request: SegmentRequest): SegmentPlan {
  return relationHandleSegment(
    steps, barrier, idHead(steps, barrier.at, request.lowering), 'path',
    (run, round) => lowerPathResume(run, round, barrier.path!, steps, barrier.at, request.lowering),
  );
}

/** A PAIR barrier (node-similarity). GLOBAL, source-form: `apply` runs over no input, computes the scored
 *  pairs into `barrier_state`, and returns the `(run, round)` handle; `lowerPairResume` frames each pair as
 *  a MAP (a stream of maps — the new output shape). */
function pairSegment(steps: readonly IRStep[], barrier: Barrier, request: SegmentRequest): SegmentPlan {
  return relationHandleSegment(
    steps, barrier, null, 'pair',
    (run, round) => lowerPairResume(run, round, barrier.pairs!, steps, barrier.at, request.lowering),
  );
}

/** A SOURCE barrier: nothing local to drain, so `apply` runs over no rows and the resume is the rest of
 *  the chain over whatever came back. */
function sourceSegment(steps: readonly IRStep[], barrier: Barrier, request: SegmentRequest): SegmentPlan {
  return {
    kind: 'segment',
    mode: 'async',
    head: null,
    params: barrier.site.params,
    apply: barrier.apply,
    applySync: barrier.applySync,
    residency: barrier.residency,
    resume: (out: BarrierOutput): Plan => resumed(steps, barrier, request, out),
  };
}

/** The half of both forms that is the same: land what came back, continue the chain, and refuse
 *  clearly if the rest of it needs something a detached element does not have. A PUSHED-DOWN REDUCER
 *  returns a `barrier-scalar` instead of rows — the reduction already ran on the sibling and its typed
 *  value is the whole result, so frame it directly (`lowerScalarResume`), no tail to continue. */
function resumed(
  steps: readonly IRStep[], barrier: Barrier, request: SegmentRequest, out: BarrierOutput,
  rejoin?: { readonly parentCount: number; readonly injected: boolean },
): Plan {
  if (!Array.isArray(out) && 'kind' in out && out.kind === 'barrier-scalar') {
    // MID-TRAVERSAL REDUCTION combine: the sibling returned a `(key→partial)` map (a `t:'map'` ValueNode).
    // COMBINE it per parent with the monoid — explode the map, LEFT JOIN each parent to its key, apply the
    // combine + identity — yielding the same per-parent answer as the element scatter + local reduce.
    if (barrier.site.mapValues?.reduce && rejoin)
      return { kind: 'sql', compiled: finishLowering(lowerReduceCombine(out.value, rejoin.parentCount, barrier.site.mapValues.reduce, steps, barrier.suffixFrom, request.lowering)) };
    // A source-form scalar (a pushed prefix ending in a reducer): frame the value directly, no tail.
    return { kind: 'sql', compiled: finishLowering(lowerScalarResume(out.value)) };
  }
  // A pushed-down VALUE STREAM (a prefix ending in `values(k)`/`unfold()`/`fold()`/`cap('a')`): the whole
  // tail ran on the sibling and N typed nodes crossed back, so each re-emits as its own traverser. The
  // prefix is MAXIMAL, so there is no local suffix to continue — a pure per-member framing, the scalar
  // resume one cardinality up. In the MID form (a `V().call(federate, <constant sub>)`, `rejoin` present)
  // the sibling ran ONCE and each of the P parents re-emits the whole pool — a CROSS scatter (P×N), the
  // value-stream analogue of the element rejoin's no-injection cross. A mid form only reaches here when the
  // sub-traversal is CONSTANT: an injected value terminal caps the pushable prefix AT the marker, so
  // anything after it (a `values`) is LOCAL and comes back through the element rejoin instead.
  if (!Array.isArray(out) && 'kind' in out && out.kind === 'barrier-values')
    return { kind: 'sql', compiled: finishLowering(lowerTypedNodeStream(out.values, rejoin?.parentCount)) };
  if (!Array.isArray(out) && 'kind' in out && out.kind === 'barrier-map') {
    const elem = mapValueElem(out.value);
    const lowered = lowerForeignResume([], elem, steps, barrier.suffixFrom, request.lowering, {
      parentCount: rejoin?.parentCount ?? 0, mapValues: out.value,
    });
    if (!lowered) throw new Error('federate: mapValues result cannot resume the local traversal');
    return { kind: 'sql', compiled: finishLowering(lowered) };
  }
  const foreign = out as ForeignRow[];
  // The landed element KIND comes from the rows themselves — a sibling traversal ends vertex or edge
  // (`runForeign()` fails closed on anything else), and an EMPTY pool has no kind to read. Vertex is the
  // arbitrary-but-total answer there, and it is unobservable: a zero-row relation frames as no
  // traversers whichever tuple it declares.
  const elem: Elem = foreign[0]?.kind ?? 'vertex';
  // Resume from the SUFFIX — after any prefix a pushdown pushed to the sibling (win 2a), else `at + 1`.
  const lowered = lowerForeignResume(foreign, elem, steps, barrier.suffixFrom, request.lowering, rejoin);
  // A RESUME CANNOT DECLINE — there is no other route to hand the traversal to, and the rows have
  // already been fetched. So an unsupported step after a barrier is an ERROR naming the step, not a
  // silent different answer: a detached element has no live adjacency, and the fix is to push the step
  // into the sub-traversal the barrier runs on the far side.
  if (!lowered) {
    const next = steps[barrier.suffixFrom];
    throw new Error(
      next
        ? `${next.name}() is not supported after a barrier call() — its results are DETACHED references `
          + '(id/label/values read the landed snapshot; movement and property steps need live adjacency), '
          + 'so push that step into the sub-traversal the service runs instead'
        : 'a barrier call() produced a result this route cannot frame',
    );
  }
  return { kind: 'sql', compiled: finishLowering(lowered) };
}

/** Validate the existing typed map transport while retaining its data for relational landing. */
function mapValueElem(map: Extract<ValueNode, { readonly t: 'map' }>): Elem {
  let elem: Elem | undefined;
  for (const pair of map.v as readonly [ValueNode, FrameNode][]) {
    const key = pair[0]; const value = pair[1];
    if ((typeof key.v !== 'string' && typeof key.v !== 'number') || !isTaggedFrame(value) || value.t !== 'list' || !Array.isArray(value.v))
      throw new Error('federate: mapValues result must map a scalar parent key to an element list');
    for (const node of value.v as readonly FrameNode[]) {
      if (!isTaggedFrame(node)) throw new Error('federate: mapValues list contains a non-element result');
      if (node.t === 'vertex') {
        if (elem && elem !== 'vertex') throw new Error('federate: mapValues result mixes element kinds');
        elem = 'vertex';
      } else if (node.t === 'edge') {
        if (elem && elem !== 'edge') throw new Error('federate: mapValues result mixes element kinds');
        elem = 'edge';
      } else throw new Error('federate: mapValues list contains a non-element result');
    }
  }
  return elem ?? 'vertex';
}

type TaggedFrame = Extract<FrameNode, { readonly t: string; readonly v: unknown }>;
const isTaggedFrame = (node: FrameNode): node is TaggedFrame =>
  node !== null && typeof node === 'object' && !Array.isArray(node) && 't' in node && 'v' in node;
