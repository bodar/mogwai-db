import { isNested } from '../../../gremlin/frontend.ts';
import { type Query } from '../../../sql/kernel/q.ts';
import { type IRStep } from '../../ir/strategies.ts';
import { type Stream, type LoweringResult, continueLowering, suspendLowering } from '../context/stream.ts';
import { type ElementStream } from '../context/context.ts';
import { type ServiceRegistry, type CallSite, type Contribution, type ForeignRow, type CallParams, type InjectionKind } from '../../../services/spi/types.ts';
import { parseCallSpec, injectionKindOf } from '../../../services/params/call-params.ts';
import { type ChildFrame, type ChildFrameStack } from './child-shape.ts';
import { buildCallHead } from './call-head.ts';
import { type Compiled } from '../../../sql/kernel/render.ts';
import { engineOf } from '../../engine/deps.ts';

// ---------- call() lowering ----------
//
// call() is a new SOURCE (g.call(...) — seedCall, a peer of seedSource/sourceUnion under
// the engine's one source dispatch, seedRooted) and a
// new mid-traversal SCALAR-producing step (V().call(...) — lowerCall). Both resolve the
// CallSpec, look up the Service in the registry, and hand off to the service's
// Contribution. A 'stream' Contribution (all of Phases 1-5) lowers to SQL inline; a
// 'barrier' Contribution (Phase 6 federated/async) is not yet supported and throws a clear
// deferral. There is NO second movement/projection/materializer here — a service builds a
// Stream through the ordinary q-kernel + stream constructors, and the generic
// lowerSteps/materializeRootStream engine takes it from there.

/** A compile SUSPENDED at a barrier call() (Phase 6). Unlike a 'stream' service (which lowers to
 *  SQL synchronously), a barrier's rows arrive from an awaited external call — so instead of a
 *  Stream, seedCall/lowerCall yield this descriptor: the service's `apply` (already closed over
 *  this call's params + hop depth, run at execution time) plus enough context to
 *  RESUME lowering once the rows land. The consumer (compileRead, which owns lowerSteps /
 *  materializeRootStream / foreign landing) builds the SegmentPlan.resume closure from `restSteps` —
 *  keeping the lowerSteps dependency OUT of call.ts (call.ts is imported by index.ts; importing
 *  lowerSteps back would cycle). `params`/`boundParams` seed the resumed foreign root stream. */
export interface BarrierPoint {
  readonly kind: 'barrier-point';
  readonly serviceName: string;
  readonly params: CallParams;
  readonly apply: (rows: readonly ForeignRow[]) => Promise<ForeignRow[]>;
  /** The chain steps AFTER this call() — resumed against the landed foreign stream. */
  readonly restSteps: IRStep[];
  /** Where restSteps begins in the original chain (the index the resumer lowers from). */
  readonly restAt: number;
  /** The traversal's bound-param table, for the resumed lowering's LoweringState. */
  readonly boundParams: Record<string, any>;
}

export const isBarrierPoint = (x: unknown): x is BarrierPoint =>
  x != null && typeof x === 'object' && (x as any).kind === 'barrier-point';

/** A compile SUSPENDED at a MID-TRAVERSAL barrier call() (Phase 6b) — the V().call(federate) twin
 *  of BarrierPoint. Unlike the source form (head=null, resume lands a fresh root), this carries:
 *  - `head` — a COMPLETE Compiled projecting each parent's (id, label, props[, src, tgt], o, injVal);
 *    the executor drains it before the await and hands the rows to `apply`.
 *  - `injection` — the injected scalar's classification (values(k)/id()/label()), so resume knows
 *    which landed column to value-match on for the rejoin.
 *  - `frame` — the pushed child frame (its `domain` is the preserved parent, carrying path/as); resume
 *    JOINs landed foreign rows back onto it by the injected value.
 *  bubbled up through lowerSteps (as a LoweringSuspension) to compileRead, which builds the SegmentPlan. */
export interface MidBarrierPoint {
  readonly kind: 'mid-barrier-point';
  readonly serviceName: string;
  readonly params: CallParams;
  readonly head: Compiled;
  readonly apply: (rows: readonly ForeignRow[]) => Promise<ForeignRow[]>;
  readonly injection?: InjectionKind;
  readonly frame: ChildFrame;
  readonly parent: ElementStream;
  /** The chain steps AFTER this call() — resumed against the rejoined foreign stream. */
  readonly restSteps: IRStep[];
  readonly restAt: number;
  readonly boundParams: Record<string, any>;
}

export const isMidBarrierPoint = (x: unknown): x is MidBarrierPoint =>
  x != null && typeof x === 'object' && (x as any).kind === 'mid-barrier-point';

/** Resolve the service + take its Contribution. A 'stream' kind is returned for inline lowering;
 *  a 'barrier' kind is returned as-is so the caller (seedCall/lowerCall) can build a BarrierPoint.
 *  Shared by the source and mid-traversal paths. */
function resolveContribution(spec: ReturnType<typeof parseCallSpec>, registry: ServiceRegistry, ctx: CallSite): Contribution {
  const service = registry.get(spec.serviceName);
  if (!service) throw new Error(`call(): unknown service '${spec.serviceName}'`);
  return service.resolve(ctx);
}

/** g.call(...) as a SOURCE. A pure 'stream' service builds its initial Stream inline (--list,
 *  tinker.search) — fed straight into lowerSteps/materializeRootStream by compileRead. A 'barrier'
 *  service (Phase 6 federate) returns a BarrierPoint instead: its rows arrive from an awaited
 *  sibling call, so it cannot lower synchronously; compileRead surfaces it to the segment
 *  orchestrator, which resumes lowering from `restSteps` once the rows land. */
export function seedCall(first: IRStep, query: Query, params: Record<string, any>, registry: ServiceRegistry, steps: IRStep[], depth: number): Stream | BarrierPoint {
  const spec = parseCallSpec(first, params);
  // depth is this compile's federation depth (request-scoped DI, captured from CompileOptions) —
  // on the ctx, so the service's apply closure captures it and a recursive federate hops at depth+1.
  const ctx: CallSite = { params: spec.params, q: query, boundParams: params, federationDepth: depth };
  const contribution = resolveContribution(spec, registry, ctx);
  if (contribution.kind === 'stream') return contribution.build(ctx);
  return {
    kind: 'barrier-point',
    serviceName: spec.serviceName,
    params: spec.params,
    apply: contribution.apply,
    restSteps: steps,
    restAt: 1, // a source call() is steps[0]; the rest begins at 1
    boundParams: params,
  };
}

/** V().call(...) mid-traversal: a per-parent step. The service receives the parent
 *  ElementStream + the current ChildFrameStack and pushes its OWN child scope (via the
 *  child-seam helpers, e.g. scopedMovementCount) so each input vertex gets a multiset-safe
 *  ordinal — exactly like a count()-child. tinker.degree.centrality reduces to a scalar
 *  per input.
 *
 *  Scope is stream-carried, not a lowerSteps parameter (see child.ts). The tail dispatch hands
 *  a nominal ROOT_SCOPE, but when call() appears INSIDE a child body (e.g.
 *  where(call(...).is(3))) the parent stream already carries the outer ordinal(s) in
 *  `carried.origins`; the service's pushChildScope reads those and mints a frame NESTED under
 *  them (they are preserved in the seed's carried), so the scoped reducer emits one scalar per
 *  outer origin. The scoped reducer keys on the innermost frame only, so the frames array the
 *  nominal scope carries need not enumerate the outer frames — the nesting rides the carry.
 *
 *  A 'barrier' contribution (mid-traversal federate) SUSPENDS: it builds the per-parent head
 *  (buildCallHead) and returns a MidBarrierPoint wrapped as a LoweringSuspension, which lowerSteps
 *  relays to compileRead. `steps`/`stop` are the caller's chain + cursor so restSteps/restAt name
 *  what resumes after the call(). */
export function lowerCall(step: IRStep, parent: ElementStream, scope: ChildFrameStack, steps: IRStep[], stop: number): LoweringResult {
  const spec = parseCallSpec(step, parent.params);
  const registry = engineOf(parent).registry;
  const ctx: CallSite = {
    params: spec.params,
    q: parent.q,
    boundParams: parent.params,
    federationDepth: engineOf(parent).federationDepth,
    parent,
    scope,
  };
  const contribution = resolveContribution(spec, registry, ctx);
  if (contribution.kind === 'stream') return continueLowering(contribution.build(ctx), stop + 1);

  // A mid-traversal barrier (federate): build the per-parent head + suspend. The head projects
  // (id, label, props[, src, tgt], o, injVal); apply (already closed over this compile's federation
  // depth, via the ctx) runs the sibling once per distinct injected value; resume rejoins by that value.
  const injection = spec.injectionTraversal ? injectionKindOf(spec.injectionTraversal, parent.params) ?? undefined : undefined;
  // Fail closed on an UNSUPPORTED injection attempt: a 3rd-arg nested traversal was given alongside
  // the params map (the injection slot), but it did not classify as a direct value read. parseCallSpec
  // only captures a CLASSIFYING traversal as spec.injectionTraversal (to avoid retaining a cyclic
  // node), so detect the unsupported case from the raw args here — never silently degrade to a
  // no-injection (Cartesian) run, which would answer a different question.
  const rawArgs = step.args.slice(1);
  const hasMap = rawArgs.some((a: any) => a instanceof Map);
  const thirdTrav = hasMap && rawArgs.some(isNested);
  if (thirdTrav && !injection)
    throw new Error(`call("${spec.serviceName}"): injection must be a direct value read — __.values(key), __.id(), or __.label()`);
  const { head, frame } = buildCallHead(parent, scope, spec.injectionTraversal);
  const apply = contribution.apply;
  const point: MidBarrierPoint = {
    kind: 'mid-barrier-point',
    serviceName: spec.serviceName,
    params: spec.params,
    head, apply, injection, frame, parent,
    restSteps: steps,
    restAt: stop + 1,
    boundParams: parent.params,
  };
  return suspendLowering(point);
}
