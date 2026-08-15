import type { IRStep } from '../ir/strategies.ts';
import type { Plan, SegmentPlan } from '../segment.ts';
import type { BarrierInput, BarrierResidency, CallSite, CallSpec, ForeignRow, InjectionKind, Service } from '../../services/spi/types.ts';
import { injectionKindOf, parseCallSpec } from '../../services/params/call-params.ts';
import { argValues, isNested, stepChain } from '../../gremlin/frontend.ts';
import { lowerForeignResume, lowerToRel, type Lowering } from './lower.ts';
import { finishLowering } from './spine.ts';
import type { Elem } from '../plan/plan.ts';

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
  readonly apply: (rows: readonly BarrierInput[]) => Promise<ForeignRow[]>;
  /** WHERE this barrier's `apply` runs (§4·3) — carried through to the `SegmentPlan` so the drive
   *  loop can decide whether the Worker may drive it (`'worker'`) or it must stay DO-side (`'do'`). */
  readonly residency: BarrierResidency;
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
    const site: CallSite = {
      params: spec.params, boundParams: request.params, federationDepth: request.federationDepth,
    };
    const contribution = service.resolve(site);
    if (contribution.kind !== 'barrier') continue;   // a `rel` service lowers inline; not a boundary
    return { at, site, spec, apply: contribution.apply, residency: contribution.residency };
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
  const barrier = barrierIn(steps, request);
  if (!barrier) return null;
  return barrier.at === 0 ? sourceSegment(steps, barrier, request) : midSegment(steps, barrier, request);
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
    head,
    params: barrier.site.params,
    apply: barrier.apply,
    residency: barrier.residency,
    resume: (foreign: ForeignRow[], headRows: readonly BarrierInput[]): Plan =>
      resumed(steps, barrier, request, foreign, {
        values: headRows.map((row) => row.injectedValue), injection,
      }),
  };
}

/** A SOURCE barrier: nothing local to drain, so `apply` runs over no rows and the resume is the rest of
 *  the chain over whatever came back. */
function sourceSegment(steps: readonly IRStep[], barrier: Barrier, request: SegmentRequest): SegmentPlan {
  return {
    kind: 'segment',
    head: null,
    params: barrier.site.params,
    apply: barrier.apply,
    residency: barrier.residency,
    resume: (foreign: ForeignRow[]): Plan => resumed(steps, barrier, request, foreign),
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
