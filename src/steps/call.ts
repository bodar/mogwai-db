import { type Query } from '../q.ts';
import { type PStep } from '../strategies.ts';
import { type Stream } from './stream.ts';
import { type ElementStream } from './context.ts';
import { type ServiceRegistry, type ServiceCallCtx, type Contribution, type ForeignRow, type CallParams } from '../services/types.ts';
import { type FederationSource } from '../segment.ts';
import { parseCallSpec } from '../services/call-params.ts';
import { type CompileScope } from './child.ts';

// ---------- call() lowering ----------
//
// call() is a new SOURCE (g.call(...) — seedCall, a peer of seedSource/seedUnion) and a
// new mid-traversal SCALAR-producing step (V().call(...) — lowerCall). Both resolve the
// CallSpec, look up the Service in the registry, and hand off to the service's
// Contribution. A 'stream' Contribution (all of Phases 1-5) lowers to SQL inline; a
// 'barrier' Contribution (Phase 6 federated/async) is not yet supported and throws a clear
// deferral. There is NO second movement/projection/materializer here — a service builds a
// Stream through the ordinary q-kernel + stream constructors, and the generic
// lowerSteps/materializeFinal engine takes it from there.

/** A compile SUSPENDED at a barrier call() (Phase 6). Unlike a 'stream' service (which lowers to
 *  SQL synchronously), a barrier's rows arrive from an awaited external call — so instead of a
 *  Stream, seedCall/lowerCall yield this descriptor: the service's `apply` pre-bound to the
 *  resolved params (run at execution time with the per-runtime env) plus enough context to
 *  RESUME lowering once the rows land. The consumer (compileRead, which owns lowerSteps /
 *  materializeFinal / foreign landing) builds the SegmentPlan.resume closure from `restSteps` —
 *  keeping the lowerSteps dependency OUT of call.ts (call.ts is imported by index.ts; importing
 *  lowerSteps back would cycle). `params`/`compileParams` seed the resumed foreign root stream. */
export interface BarrierPoint {
  readonly kind: 'barrier-point';
  readonly serviceName: string;
  readonly params: CallParams;
  readonly apply: (rows: readonly ForeignRow[], source: FederationSource) => Promise<ForeignRow[]>;
  /** The chain steps AFTER this call() — resumed against the landed foreign stream. */
  readonly restSteps: PStep[];
  /** Where restSteps begins in the original chain (the index the resumer lowers from). */
  readonly restAt: number;
  /** The traversal's bound-param table, for the resumed lowering's Carry. */
  readonly compileParams: Record<string, any>;
}

export const isBarrierPoint = (x: unknown): x is BarrierPoint =>
  x != null && typeof x === 'object' && (x as any).kind === 'barrier-point';

/** Resolve the service + take its Contribution. A 'stream' kind is returned for inline lowering;
 *  a 'barrier' kind is returned as-is so the caller (seedCall/lowerCall) can build a BarrierPoint.
 *  Shared by the source and mid-traversal paths. */
function resolveContribution(spec: ReturnType<typeof parseCallSpec>, registry: ServiceRegistry, ctx: ServiceCallCtx): Contribution {
  const service = registry.get(spec.serviceName);
  if (!service) throw new Error(`call(): unknown service '${spec.serviceName}'`);
  return service.resolve(ctx);
}

/** g.call(...) as a SOURCE. A pure 'stream' service builds its initial Stream inline (--list,
 *  tinker.search) — fed straight into lowerSteps/materializeFinal by compileRead. A 'barrier'
 *  service (Phase 6 federate) returns a BarrierPoint instead: its rows arrive from an awaited
 *  sibling call, so it cannot lower synchronously; compileRead surfaces it to the segment
 *  orchestrator, which resumes lowering from `restSteps` once the rows land. */
export function seedCall(first: PStep, query: Query, params: Record<string, any>, registry: ServiceRegistry, steps: PStep[], depth: number): Stream | BarrierPoint {
  const spec = parseCallSpec(first, params);
  const ctx: ServiceCallCtx = { params: spec.params, q: query, compileParams: params, registry };
  const contribution = resolveContribution(spec, registry, ctx);
  if (contribution.kind === 'stream') return contribution.build(ctx);
  return {
    kind: 'barrier-point',
    serviceName: spec.serviceName,
    params: spec.params,
    // depth is this compile's federation depth (request-scoped DI, captured from CompileOptions);
    // the service's apply gets it so a recursive federate calls federateQuery(..., depth+1).
    apply: (rows, env) => contribution.apply(rows, spec.params, env, depth),
    restSteps: steps,
    restAt: 1, // a source call() is steps[0]; the rest begins at 1
    compileParams: params,
  };
}

/** V().call(...) mid-traversal: a per-parent step. The service receives the parent
 *  ElementStream + the current CompileScope and pushes its OWN child scope (via the
 *  child-seam helpers, e.g. scopedMovementCount) so each input vertex gets a multiset-safe
 *  ordinal — exactly like a count()-child. tinker.degree.centrality reduces to a scalar
 *  per input.
 *
 *  Scope is stream-carried, not a lowerSteps parameter (see child.ts). The TAIL dispatch hands
 *  a nominal ROOT_SCOPE, but when call() appears INSIDE a child body (e.g.
 *  where(call(...).is(3))) the parent stream already carries the outer ordinal(s) in
 *  `carried.origins`; the service's pushChildScope reads those and mints a frame NESTED under
 *  them (they are preserved in the seed's carried), so the scoped reducer emits one scalar per
 *  outer origin. The scoped reducer keys on the innermost frame only, so the frames array the
 *  nominal scope carries need not enumerate the outer frames — the nesting rides the carry. */
export function lowerCall(step: PStep, parent: ElementStream, scope: CompileScope): Stream {
  const spec = parseCallSpec(step, parent.params);
  const registry = parent.registry ?? (() => { throw new Error('call(): no service registry in scope'); })();
  const ctx: ServiceCallCtx = {
    params: spec.params,
    q: parent.q,
    compileParams: parent.params,
    registry,
    parent,
    scope,
  };
  const contribution = resolveContribution(spec, registry, ctx);
  // Mid-traversal V().call(barrier) — the segment orchestrator with per-parent ordinal rejoin —
  // is Phase 6b. Until then a barrier mid-traversal fails closed clearly (a 'stream' service
  // lowers inline as before).
  if (contribution.kind === 'barrier')
    throw new Error(`call("${spec.serviceName}"): mid-traversal barrier services are not yet supported (Phase 6b) — use g.call(...) at the source position`);
  return contribution.build(ctx);
}
