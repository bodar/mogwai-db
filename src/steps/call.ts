import { type Query } from '../q.ts';
import { type PStep } from '../strategies.ts';
import { type Stream } from './stream.ts';
import { type ElementStream } from './context.ts';
import { type ServiceRegistry, type ServiceCallCtx, type Contribution } from '../services/types.ts';
import { parseCallSpec } from '../services/call-params.ts';
import { pushChildScope, type ChildScope, type CompileScope } from './child.ts';

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

/** Resolve the service + take its Contribution, rejecting the not-yet-supported barrier
 *  kind. Shared by the source and mid-traversal paths. */
function resolveContribution(spec: ReturnType<typeof parseCallSpec>, registry: ServiceRegistry, ctx: ServiceCallCtx): Extract<Contribution, { kind: 'stream' }> {
  const service = registry.get(spec.serviceName);
  if (!service) throw new Error(`call(): unknown service '${spec.serviceName}'`);
  const contribution = service.resolve(ctx);
  if (contribution.kind === 'barrier')
    throw new Error(`call("${spec.serviceName}"): barrier/async services are not yet supported (Phase 6)`);
  return contribution;
}

/** g.call(...) as a SOURCE: build the initial Stream from the service. Peer of
 *  seedSource/seedUnion — returns whatever Stream shape the service produces (a
 *  ListStream of names for --list, a PropertyStream for tinker.search), fed straight into
 *  the generic lowerSteps/materializeFinal by compileRead. */
export function seedCall(first: PStep, query: Query, params: Record<string, any>, registry: ServiceRegistry): Stream {
  const spec = parseCallSpec(first, params);
  const ctx: ServiceCallCtx = { params: spec.params, q: query, compileParams: params, registry };
  return resolveContribution(spec, registry, ctx).build(ctx);
}

/** V().call(...) mid-traversal: a per-parent scalar-producing step. Pushes a child scope
 *  (so each input vertex gets a multiset-safe ordinal, exactly like a count()-child) and
 *  hands the pushed seed to the service; the service reduces per ordinal (e.g.
 *  tinker.degree.centrality → a scoped count). */
export function lowerCall(step: PStep, parent: ElementStream, scope: CompileScope): Stream {
  const spec = parseCallSpec(step, parent.params);
  const pushed = pushChildScope(parent, scope);
  const ctx: ServiceCallCtx = {
    params: spec.params,
    q: parent.q,
    compileParams: parent.params,
    registry: parent.registry ?? (() => { throw new Error('call(): no service registry in scope'); })(),
    parent: pushed.seed,
    scope: pushed.scope,
  };
  return resolveContribution(spec, ctx.registry, ctx).build(ctx);
}
