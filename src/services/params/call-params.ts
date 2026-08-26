import { stepChain, isNested, argValues } from '../../gremlin/frontend.ts';
import type { IRStep } from '../../compiler/ir/strategies.ts';
import { DIRECTORY_SERVICE_NAME } from '../spi/types.ts';
import type { CallSpec, CallParams, InjectionKind, Service, ServiceRegistry } from '../spi/types.ts';
import { nestedTraversalToGremlin } from './traversal-param.ts';

/** Classify a mid-traversal call()'s per-parent INJECTION traversal (the 3rd positional arg) into
 *  an InjectionKind — the DIRECT value read Phase 6b supports: `__.values('k')` (a property value),
 *  `__.id()`, or `__.label()`. Each also lands on the returned foreign row (fprops/fid/flabel), so
 *  the federate rejoin can match a result against the injected value in SQL. Returns null for any
 *  other shape (a computed/transformed scalar, movement, etc.) — the caller fails closed with a
 *  clear deferral, never a silent mis-rejoin. */
export function injectionKindOf(nested: any, params: Record<string, any>): InjectionKind | null {
  const body = stepChain(nested, params);
  if (body.length !== 1) return null;
  const s = body[0];
  if (s.name === 'values' && s.args.length === 1 && typeof s.args[0]?.value === 'string')
    return { kind: 'values', key: s.args[0].value };
  if (s.name === 'id' && s.args.length === 0) return { kind: 'id' };
  if (s.name === 'label' && s.args.length === 0) return { kind: 'label' };
  return null;
}

/** A call() param VALUE that is a nested traversal (`.with('traversal', __.V().out('x'))` or a
 *  map entry), already serialized to a canonical rooted Gremlin string. Distinct from a plain
 *  string so a service that expects a sub-traversal (federate) can tell it apart
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
 *  fails closed inside nestedTraversalToGremlin.
 *
 *  The constant-fold probe (stepChain) may throw on an UNBOUND variable — legitimate for a
 *  federated sub-traversal that references a value injected at apply time (e.g.
 *  `__.V().has('k', xx1)`, where xx1 binds to the per-parent injected value). A `constant(literal)`
 *  never references an unbound var, so a throw simply means "not a constant" → serialize (the
 *  Translator preserves the xxN reference verbatim; apply supplies its binding). */
function resolveValueTraversal(nested: any, params: Record<string, any>): unknown {
  try {
    const body = stepChain(nested, params);
    if (body.length === 1 && body[0].name === 'constant' && body[0].args.length === 1)
      return body[0].args[0].value;
  } catch { /* unbound var → not a constant; fall through to serialize */ }
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

/** Build the CallSpec (service name + resolved constant params + optional mid-traversal injection)
 *  for a `call` IRStep, from its args (string name, optional Map / project-traversal, optional
 *  injection traversal) and folded withArgs.
 *
 *  Arg disambiguation follows the grammar's call() overloads
 *  (call_string / call_string_map / call_string_traversal / call_string_map_traversal). A nested
 *  traversal arg present alongside a Map is TinkerPop's DYNAMIC-PARAMS traversal by default
 *  (project(...).by(constant) → a constant map merged over the static one). It is our per-parent
 *  INJECTION only when it CLASSIFIES as a direct value read (`__.values('k')`/`__.id()`/`__.label()`
 *  — injectionKindOf) — precise so the `--list` 3-arg form (a project-traversal) is untouched and
 *  never captured as an injection (that would both mis-route AND retain a huge cyclic antlr node). */
export function parseCallSpec(step: IRStep, params: Record<string, any>): CallSpec {
  const [name, ...rest] = argValues(step);
  // Bare g.call() ≡ g.call("--list") (the directory). A missing name defaults to it.
  const serviceName = typeof name === 'string' ? name : DIRECTORY_SERVICE_NAME;

  const merged: CallParams = {};

  const mapArg = rest.find((a) => a instanceof Map) as Map<any, any> | undefined;
  const travArg = rest.find((a) => isNested(a)) as { nested: any } | undefined;
  // A nested traversal alongside a Map is an INJECTION only when it is a direct value read; else it
  // is the ordinary dynamic-params traversal (merged below like the lone-traversal form).
  const injectionTraversal = mapArg && travArg && injectionKindOf(travArg.nested, params) ? travArg.nested : undefined;
  if (mapArg) {
    // A map value may itself be a nested sub-traversal (federate's `traversal`) — resolve it
    // the same way a .with() value is (constant fold or serialize), so both param-source forms
    // agree; a plain value passes through. When BOTH a map and a (non-injection) traversal are
    // given, the MAP WINS (TinkerPop's call_string_map_traversal note) — the traversal is ignored
    // as a param source; only an INJECTION traversal is captured separately (above), never merged.
    for (const [k, v] of mapArg) merged[String(k)] = isNested(v) ? resolveValueTraversal(v.nested, params) : v;
  } else if (travArg) {
    Object.assign(merged, constMapFromTraversal(travArg.nested, params));
  }

  // Source 5: .with(k, v) pairs layer on top (with() wins over the call-arg map).
  for (const [k, v] of step.withArgs ?? []) {
    merged[k] = isNested(v) ? resolveValueTraversal(v.nested, params) : v;
  }

  return { serviceName, params: merged, injectionTraversal };
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
