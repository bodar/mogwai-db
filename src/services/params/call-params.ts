import { stepChain, isNested, argValues } from '../../gremlin/frontend.ts';
import type { IRStep } from '../../compiler/ir/strategies.ts';
import { DIRECTORY_SERVICE_NAME } from '../spi/types.ts';
import type { CallSpec, CallParams, Service, ServiceRegistry } from '../spi/types.ts';

/** A call() param VALUE that is a nested sub-traversal (`.with('traversal', __.V().out('x'))` or a
 *  map entry) — the sub-traversal a barrier/OLAP service runs (federate's `traversal`, an OLAP
 *  `edges` scope, shortestPath's `target`). Carried as PARSED `IRStep[]`, NOT a serialized Gremlin
 *  string: every consumer reads STEPS (federate reads the `parent` marker; OLAP reads `{direction,
 *  labels}`), and the ONLY place it becomes a string is federate's RPC edge (`ex.raw` crosses to
 *  another DO) — synthesized there from the steps' own source text (each `IRStep` keeps its `ctx`,
 *  so `ctx.getText()` reconstructs it verbatim). Distinct `kind` so a service that expects a
 *  sub-traversal can tell it apart from a literal param, and one that does NOT can reject it. Kept
 *  generic (any service *could* take one) — the resolver never hardcodes a service name.
 *
 *  Dropping the eager AST→string→AST round-trip: federate used to serialize every sub-traversal to a
 *  string and OLAP re-parsed it straight back (`parseAnonBodyIR`), a round-trip born only from
 *  federate being built first. See the memory `federate-subtraversal-as-steps`. */
export interface TraversalParam { readonly kind: 'traversal'; readonly steps: readonly IRStep[]; }
export const isTraversalParam = (v: unknown): v is TraversalParam =>
  v != null && typeof v === 'object' && (v as any).kind === 'traversal';

/** Resolve a nested traversal used as a param VALUE. `__.constant(literal)` folds to its constant
 *  (unchanged). ANY OTHER nested traversal resolves to its `IRStep[]` wrapped as a TraversalParam —
 *  the sub-traversal a barrier/OLAP service runs. `stepChain` runs the front-end's normal AST→steps
 *  lowering; a bound param in the body (`has('age', gt(x))`) resolves against `params` here, and no
 *  federate/OLAP sub-traversal carries a COMPILE-unbound var (the old `xxN`/`T.value` injection that
 *  did is gone — the `parent` marker replaced it), so `stepChain` does not throw. A constant probe
 *  runs first (a `constant(literal)` never references a var, so its `stepChain` is safe too). */
function resolveValueTraversal(nested: any, params: Record<string, any>): unknown {
  const body = stepChain(nested, params);
  if (body.length === 1 && body[0].name === 'constant' && body[0].args.length === 1)
    return body[0].args[0].value;
  return { kind: 'traversal', steps: body as IRStep[] } satisfies TraversalParam;
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
    return body[0].args[0].value;
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
  const keys = argValues(proj).filter((a): a is string => typeof a === 'string');
  const byBodies = chain.slice(1).map((s) => s.args[0]?.value);
  const out: CallParams = {};
  keys.forEach((k, i) => {
    const by = byBodies[i];
    if (isNested(by)) out[k] = constFromValueTraversal(by.nested, params);
    else if (by !== undefined) out[k] = by; // by(literal) — uncommon but valid
    else throw new Error(`call() map traversal field "${k}" needs a by(__.constant(...))`);
  });
  return out;
}

/** Build the CallSpec (service name + resolved constant params)
 *  for a `call` IRStep, from its args (string name, optional Map / project-traversal) and folded withArgs.
 *
 *  Arg disambiguation follows the grammar's call() overloads
 *  (call_string / call_string_map / call_string_traversal / call_string_map_traversal). A lone nested
 *  traversal arg is TinkerPop's DYNAMIC-PARAMS traversal (`project(...).by(constant)` → a constant map).
 */
export function parseCallSpec(step: IRStep, params: Record<string, any>): CallSpec {
  const [name, ...rest] = argValues(step);
  // Bare g.call() ≡ g.call("--list") (the directory). A missing name defaults to it.
  const serviceName = typeof name === 'string' ? name : DIRECTORY_SERVICE_NAME;

  const merged: CallParams = {};

  const mapArg = rest.find((a) => a instanceof Map) as Map<any, any> | undefined;
  const travArg = rest.find((a) => isNested(a)) as { nested: any } | undefined;
  // The injection READ comes from the `parent` marker inside the `traversal` sub-body — walk its AST
  // NOW, before `resolveValueTraversal` serializes it to a string (the marker rides along verbatim to the
  // sibling). The `traversal` may arrive as a map entry OR a `.with("traversal", …)` pair; check both.
  if (mapArg) {
    // A map value may itself be a nested sub-traversal (federate's `traversal`) — resolve it
    // the same way a .with() value is (constant fold or serialize), so both param-source forms
    // agree; a plain value passes through. A lone (non-map) traversal is the dynamic-params form.
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

// ---------- resolving the services a chain names, at the DI boundary ----------
//
// **THE REGISTRY IS A DEPENDENCY AND MUST NOT REACH A LOWERING.** `compiler/CLAUDE.md` draws the
// line: ambient capabilities (registry, fastPaths, federationDepth) are DI, held by scope; a
// lowering receives settled VALUES. `ChainCtx` obeys it today — every field on it is a settled
// value (`collapse`, `ordered`, `tracksPath`, `labelCardinality`, `sideEffects`), and
// `labelCardinality`'s own comment says why it qualifies: it is request-scope DI settled BEFORE a
// compile starts, so what crosses is the value the dependency produced, never the dependency.
//
// A `ServiceRegistry` is the other kind — an object you ask `.get(name)`. Threading it would put an
// ambient capability into per-chain state. So the boundary resolves instead, and what crosses is
// the services THIS chain names: the same category as `sideEffects`, a constant environment
// resolved once and read as data.
//
// The split is by what each half needs. Name → `Service` needs only the registry and nothing from
// the lowering, so it happens here. `Service.resolve(site)` needs the `CallSite` — params, and for
// a mid-traversal call its parent position — which is per-position and known only inside the fold,
// so that stays there.
//
// An unregistered name resolves to nothing rather than throwing: the lowering then declines and
// the compiler raises `unknown service`, which is its message to own.

/** Every service name this chain's `call()` steps refer to, resolved against the registry. Uses
 *  `parseCallSpec` rather than re-reading `args[0]`, so the bare-`g.call()`-means-`--list` default
 *  cannot be spelled twice. */
export function servicesNamedBy(
  steps: readonly IRStep[], params: Record<string, any>, registry: ServiceRegistry,
): ReadonlyMap<string, Service> {
  const found = new Map<string, Service>();
  const visit = (chain: readonly IRStep[]): void => {
    for (const step of chain) {
      if (step.name === 'call') {
        const { serviceName } = parseCallSpec(step, params);
        const service = found.has(serviceName) ? undefined : registry.get(serviceName);
        if (service) found.set(serviceName, service);
      }
      // An `option()` arm and a `repeat()` region are already NORMALIZED sub-chains, so they recurse
      // directly; a nested ARGUMENT is still a raw parse tree and needs one `stepChain`.
      visit([...(step.optionArms ?? []), ...(step.repeatRegion ?? [])] as IRStep[]);
      for (const nested of nestedArgs(step)) {
        // `stepChain`, deliberately not `childSteps`: this is a NAME scan, and re-running the whole
        // Pass pipeline over every nested body can legitimately RAISE (a `where(__.as(l))` start
        // variable the body's own scope never bound), which would turn a registry lookup into a
        // compile error. A `call`'s name is in its first argument before any pass touches it.
        try { visit(stepChain(nested, params) as IRStep[]); } catch { /* an unparseable body names nothing */ }
      }
    }
  };
  visit(steps);
  return found;
}

/**
 * EVERY nested traversal a step carries in its ARGUMENTS — positional args, `by()` modulators and
 * `with()` values — reached through Maps and lists as well as directly.
 *
 * **This walk is §6·6's lesson stated one layer up, and its absence cost a real decline.** Scanning
 * only the top-level chain meant `where(__.call(dc).is(3))` and `group().by(__.call(dc))` reached a
 * lowering that had never been HANDED the service, so the fold declined and every counter read it as
 * a gap in what the algebra can EXPRESS. It was measuring what had been handed over, not what the
 * algebra can express — the same defect, in the same function, that `rel-blockers` once had.
 */
function* nestedArgs(step: IRStep): Generator<any> {
  const walk = function* (value: unknown): Generator<any> {
    if (isNested(value)) { yield value.nested; return; }
    if (Array.isArray(value)) { for (const item of value) yield* walk(item); return; }
    if (value instanceof Map) for (const [key, item] of value) { yield* walk(key); yield* walk(item); }
  };
  for (const arg of step.args ?? []) yield* walk(arg.value);
  for (const by of step.modulators ?? []) yield* walk(by);
  for (const [, value] of step.withArgs ?? []) yield* walk(value);
}
