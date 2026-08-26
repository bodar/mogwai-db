import type { IRStep } from '../ir/strategies.ts';
import type { AsyncSegmentPlan, Plan, SegmentPlan } from '../segment.ts';
import type { BarrierInput, BarrierOutput, BarrierRelation, BarrierResidency, CallSite, CallSpec, DecorateSpec, ForeignRow, InjectionKind, PairSpec, PathSpec, Service } from '../../services/spi/types.ts';
import { injectionKindOf, parseCallSpec } from '../../services/params/call-params.ts';
import { contentDemand } from '../ir/content-demand.ts';
import { argValues, isNested, stepChain } from '../../gremlin/frontend.ts';
import { lowerForeignResume, lowerPairResume, lowerPathResume, lowerToRel, type Lowering, type RelLowering } from './lower.ts';
import { decorateGraph } from './decorate.ts';
import { BaseGraph, type GraphSource } from './source.ts';
import { finishLowering } from './spine.ts';
import { buildRegexSegment, regexBarrierIn } from './regex.ts';
import { buildReverseSegment, reverseBarrierIn } from './reverse.ts';
import { buildSplitSegment, splitBarrierIn } from './split.ts';
import type { Elem } from '../elem.ts';

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
    // The local tail AFTER this barrier is a fact ABOUT this call site — the same category as
    // `federationDepth` (known once, at plan time, from where the call sits in the chain), not a
    // per-execution value and not a user param. So its content demand travels on `CallSite.tailDemand`,
    // the structure that means "facts about this call site" — a service that shapes its fetch (federate's
    // endpoint hop) reads it; one that does not ignores it. It is NOT threaded through `params` (a user
    // channel) nor captured incidentally by the `apply` closure.
    const site: CallSite = {
      params: spec.params, boundParams: request.params, federationDepth: request.federationDepth,
      tailDemand: contentDemand(steps, at + 1),
    };
    const contribution = service.resolve(site);
    if (contribution.kind !== 'barrier') continue;   // a `rel` service lowers inline; not a boundary
    return { at, site, spec, apply: contribution.apply, applySync: contribution.applySync, residency: contribution.residency, decorate: contribution.decorate, path: contribution.path, pairs: contribution.pairs };
  }
  return null;
}

/**
 * THE INJECTION a mid-traversal call declares — the per-parent value its sub-traversal is run against,
 * as `T.value` stands in for.
 *
 * An injection is only ever a DIRECT value read (`__.values(k)`, `__.id()`, `__.label()`), and
 * `parseCallSpec` captures the traversal only when it classifies as one. So a nested traversal supplied
 * in the injection slot that does NOT classify is an ERROR rather than a decline: silently running with
 * no injection would batch the sibling once and hand every parent the whole pool, which is a different
 * question with a plausible answer.
 */
function injectionOf(step: IRStep, barrier: Barrier, params: Record<string, any>): InjectionKind | undefined {
  const injection = barrier.spec.injectionTraversal
    ? injectionKindOf(barrier.spec.injectionTraversal, params) ?? undefined
    : undefined;
  const rest = argValues(step).slice(1);
  const supplied = rest.some((argument: any) => argument instanceof Map) && rest.some(isNested);
  if (supplied && !injection)
    throw new Error(`call("${barrier.spec.serviceName}"): injection must be a direct value read — __.values(key), __.id(), or __.label()`);
  return injection;
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
  const earliest = Math.min(callAt, regexAt, revAt, splitAt);
  if (earliest === Infinity) return null;
  if (earliest === splitAt) return buildSplitSegment(steps, split!.at, split!.separator, request.lowering);
  if (earliest === revAt) return buildReverseSegment(steps, reverseAt!, request.lowering);
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
  const injection = injectionOf(steps[barrier.at]!, barrier, request.params);
  // With no injection the sub-traversal is a constant, and the head exists only to COUNT the parents —
  // `id()` is the cheapest one-row-per-traverser read, and its value is never matched on.
  const call = steps[barrier.at]!;
  // The injection READ is the user's own one-step body, taken verbatim rather than re-synthesized from
  // the classification — `injectionKindOf` already parsed it, and re-minting a `values(k)` step would be
  // a second spelling of the same read for the classifier to drift from.
  const read: IRStep = injection && barrier.spec.injectionTraversal
    ? stepChain(barrier.spec.injectionTraversal, request.params)[0]! as IRStep
    : { name: 'id', args: [], ctx: call.ctx };
  const lowered = lowerToRel([...steps.slice(0, barrier.at), read], request.lowering);
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
      resumed(steps, barrier, request, out as ForeignRow[], {
        values: headRows.map((row) => row.injectedValue), injection,
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
    resume: (out: BarrierOutput): Plan => resumed(steps, barrier, request, out as ForeignRow[]),
  };
}

/** The half of both forms that is the same: land what came back, continue the chain, and refuse
 *  clearly if the rest of it needs something a detached element does not have. */
function resumed(
  steps: readonly IRStep[], barrier: Barrier, request: SegmentRequest, foreign: ForeignRow[],
  rejoin?: { readonly values: readonly unknown[]; readonly injection: InjectionKind | undefined },
): Plan {
  // The landed element KIND comes from the rows themselves — a sibling traversal ends vertex or edge
  // (`raw()` fails closed on anything else), and an EMPTY pool has no kind to read. Vertex is the
  // arbitrary-but-total answer there, and it is unobservable: a zero-row relation frames as no
  // traversers whichever tuple it declares.
  const elem: Elem = foreign[0]?.kind ?? 'vertex';
  const lowered = lowerForeignResume(foreign, elem, steps, barrier.at + 1, request.lowering, rejoin);
  // A RESUME CANNOT DECLINE — there is no other route to hand the traversal to, and the rows have
  // already been fetched. So an unsupported step after a barrier is an ERROR naming the step, not a
  // silent different answer: a detached element has no live adjacency, and the fix is to push the step
  // into the sub-traversal the barrier runs on the far side.
  if (!lowered) {
    const next = steps[barrier.at + 1];
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
