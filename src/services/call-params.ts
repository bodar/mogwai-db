import { stepChain, isNested } from '../frontend.ts';
import type { PStep } from '../strategies.ts';
import { DIRECTORY_SERVICE_NAME } from './types.ts';
import type { CallSpec, CallParams } from './types.ts';
import { nestedTraversalToGremlin } from './traversal-param.ts';

/** A call() param VALUE that is a nested traversal (`.with('traversal', __.V().out('x'))` or a
 *  map entry), already serialized to a canonical rooted Gremlin string. Distinct from a plain
 *  string so a service that expects a sub-traversal (mogwai.graph.federate) can tell it apart
 *  from a literal string param, and a service that does NOT expect one can reject it rather than
 *  silently mis-reading a serialized traversal as text. Kept generic (any service *could* take a
 *  traversal param) — the resolver never hardcodes a service name. */
export interface TraversalParam { readonly kind: 'traversal'; readonly gremlin: string; }
export const isTraversalParam = (v: unknown): v is TraversalParam =>
  v != null && typeof v === 'object' && (v as any).kind === 'traversal';

/** Resolve a nested traversal used as a param VALUE. `__.constant(literal)` folds to its constant
 *  (Phases 1-5 behavior, unchanged). ANY OTHER nested traversal serializes to a rooted Gremlin
 *  string wrapped as a TraversalParam — the sub-traversal a barrier service (federate) runs
 *  elsewhere. Serialization is verbatim structural (no execution), so a non-source-rooted body
 *  fails closed inside nestedTraversalToGremlin. */
function resolveValueTraversal(nested: any, params: Record<string, any>): unknown {
  const body = stepChain(nested, params);
  if (body.length === 1 && body[0].name === 'constant' && body[0].args.length === 1)
    return body[0].args[0];
  return { kind: 'traversal', gremlin: nestedTraversalToGremlin(nested) } satisfies TraversalParam;
}

// ---------- call() spec + param resolution ----------
//
// The ONE place the five call() param-source forms unify into a single CallParams map,
// so every service reads `ctx.params` oblivious to how a value arrived:
//   1. nothing                          → {}
//   2. a map literal / bound-param Map   → its entries
//   3. a __.project(k).by(__.constant(v)) traversal → a constant map (evaluated at
//        COMPILE time by tree inspection — no traversal execution; every scenario's
//        traversal arg is built from literal constant()s)
//   4. both a map AND a traversal        → the map wins (TinkerPop's own semantics)
//   5. .with(k, v) pairs (folded onto call.withArgs) → merged on top, .with() winning;
//        v is a string/literal or __.constant(x)
//
// A param whose value is a traversal NOT reducible to a compile-time constant fails
// closed (the plan doc's "non-constant per-traverser call params → deferral").

/** Resolve a nested `{nested}` traversal used as a PARAM VALUE (`.with(k, __.constant(x))`)
 *  to its compile-time constant. Only `constant(literal)` is supported. */
function constFromValueTraversal(nested: any, params: Record<string, any>): unknown {
  const body = stepChain(nested, params);
  if (body.length === 1 && body[0].name === 'constant' && body[0].args.length === 1)
    return body[0].args[0];
  throw new Error('call() parameter value traversal must be __.constant(literal) — richer per-traverser params are not yet supported');
}

/** Resolve a nested `{nested}` traversal used as the PARAM MAP
 *  (`call(name, __.project(k1,k2).by(__.constant(v1)).by(__.constant(v2)))`) to a constant
 *  map. Each project field's by() body must be `__.constant(literal)`. */
function constMapFromTraversal(nested: any, params: Record<string, any>): CallParams {
  // stepChain over the nested traversal keeps project + its by() modulators as SIBLING
  // steps (this raw chain is un-normalized, so by() has not been folded onto project).
  const chain = stepChain(nested, params);
  const proj = chain[0];
  if (!proj || proj.name !== 'project' || chain.slice(1).some((s) => s.name !== 'by'))
    throw new Error('call() map traversal must be __.project(...).by(__.constant(...)) — richer forms are not yet supported');
  const keys = proj.args.filter((a): a is string => typeof a === 'string');
  const byBodies = chain.slice(1).map((s) => s.args[0]);
  const out: CallParams = {};
  keys.forEach((k, i) => {
    const by = byBodies[i];
    if (isNested(by)) out[k] = constFromValueTraversal(by.nested, params);
    else if (by !== undefined) out[k] = by; // by(literal) — uncommon but valid
    else throw new Error(`call() map traversal field "${k}" needs a by(__.constant(...))`);
  });
  return out;
}

/** Build the CallSpec (service name + resolved constant params) for a `call` PStep,
 *  from its args (string name, optional Map / project-traversal) and folded withArgs. */
export function parseCallSpec(step: PStep, params: Record<string, any>): CallSpec {
  const [name, ...rest] = step.args;
  // Bare g.call() ≡ g.call("--list") (the directory). A missing name defaults to it.
  const serviceName = typeof name === 'string' ? name : DIRECTORY_SERVICE_NAME;

  const merged: CallParams = {};

  // Source 2/3/4: a Map arg wins over a traversal arg when both are present.
  const mapArg = rest.find((a) => a instanceof Map) as Map<any, any> | undefined;
  const travArg = rest.find((a) => isNested(a)) as { nested: any } | undefined;
  if (mapArg) {
    // A map value may itself be a nested sub-traversal (federate's `traversal`) — resolve it
    // the same way a .with() value is (constant fold or serialize), so both param-source forms
    // agree; a plain value passes through.
    for (const [k, v] of mapArg) merged[String(k)] = isNested(v) ? resolveValueTraversal(v.nested, params) : v;
  } else if (travArg) {
    Object.assign(merged, constMapFromTraversal(travArg.nested, params));
  }

  // Source 5: .with(k, v) pairs layer on top (with() wins over the call-arg map).
  for (const [k, v] of step.withArgs ?? []) {
    merged[k] = isNested(v) ? resolveValueTraversal(v.nested, params) : v;
  }

  return { serviceName, params: merged };
}
