import { stepChain, isNested, argValues, type Step } from '../../gremlin/frontend.ts';
import type { IRStep } from '../../compiler/ir/strategies.ts';
import { DIRECTORY_SERVICE_NAME } from '../spi/types.ts';
import type { CallSpec, CallParams, InjectionKind, Service, ServiceRegistry } from '../spi/types.ts';
import { isParentMarkerBody, PARENT_MARKER } from '../../compiler/ir/injection.ts';

/** Classify a mid-traversal call()'s per-parent INJECTION READ into an InjectionKind — the DIRECT value
 *  read the `parent` marker supports: `__.values('k')` (a property value), `__.id()`, or `__.label()`;
 *  an explicit trailing `.fold()` turns one of those reads into a LIST injection.
 *  Each also lands on the returned foreign row (fprops/fid/flabel), so the federate rejoin can match a
 *  result against the injected value in SQL. Returns null for any other shape (a computed/transformed
 *  scalar, movement, etc.) — the caller fails closed with a clear deferral, never a silent mis-rejoin.
 *  `nested` is the marker's READ body (`call('parent', <read>)`'s second arg), NOT the whole marker. */
export function injectionKindOf(nested: any, params: Record<string, any>): InjectionKind | null {
  const body = stepChain(nested, params);
  const fold = body.length === 2 && body[1]?.name === 'fold' && body[1].args.length === 0;
  if (body.length !== (fold ? 2 : 1)) return null;
  const s = body[0]!;
  if (s.name === 'values' && s.args.length === 1 && typeof s.args[0]?.value === 'string')
    return { kind: 'values', key: s.args[0].value, ...(fold ? { fold: true } : {}) };
  if (s.name === 'id' && s.args.length === 0) return { kind: 'id', ...(fold ? { fold: true } : {}) };
  if (s.name === 'label' && s.args.length === 0) return { kind: 'label', ...(fold ? { fold: true } : {}) };
  return null;
}

/** The READ body of the `parent` injection marker found inside a sub-traversal, or null if the traversal
 *  carries no marker. A mid-traversal federate marks its per-parent injection with `call('parent', <read>)`
 *  in a PREDICATE OPERAND position (`has('sku', __.call('parent', __.values('sku')))`); this walks the
 *  traversal's steps and their nested-operand args to find that marker and hand back its `<read>` body
 *  (the marker call's SECOND arg), which `injectionKindOf` then classifies. Only ONE marker is expected;
 *  the FIRST found wins (multi-marker is not a form we mint). Reuses `isParentMarkerBody` (the leaf
 *  predicate) so the recognizer is one definition, not two.
 *
 *  A `parent` marker with NO read arg (a bare `call('parent')`) THROWS here — fail closed at detection,
 *  where the error is precise, rather than silently returning "no injection" (which would batch the sibling
 *  once and hand every parent the whole pool — a different question with a plausible answer). The read's
 *  SHAPE (must be `values`/`id`/`label`) is validated downstream by `injectionKindOf`. */
export function parentMarkerReadIn(traversal: any, params: Record<string, any>): any {
  // Every operand value that could HOLD a marker: a nested traversal directly, OR a PREDICATE operand
  // (`within(marker)`, `eq(marker)`, …) whose members are themselves operand values. The explicit
  // membership form `has(k, within(__.call('parent', …)))` puts the marker inside a `within`, so the
  // walk must descend through predicate operands, not only nested traversals.
  const markerValues = function* (value: unknown): Generator<{ nested: any }> {
    if (isNested(value)) { yield value as { nested: any }; return; }
    const pred = value as { operands?: readonly { value: unknown }[] } | null;
    if (pred?.operands) for (const o of pred.operands) yield* markerValues(o.value);
  };
  const walk = (steps: readonly Step[]): any => {
    for (const s of steps) {
      for (const a of s.args ?? []) {
        for (const nestedVal of markerValues(a.value)) {
          const body = stepChain(nestedVal.nested, params);
          if (isParentMarkerBody(body)) {
            const read = body[0]!.args[1]?.value;   // the marker call's read arg (a nested __.values/id/label)
            if (!isNested(read))
              throw new Error(`call("${PARENT_MARKER}"): the injection marker needs a read — call("${PARENT_MARKER}", __.values(key)) / __.id() / __.label()`);
            return (read as { nested: any }).nested;
          }
          const found = walk(body);                 // a marker could sit in a deeper nested body
          if (found !== undefined) return found;
        }
      }
    }
    return undefined;
  };
  const found = walk(stepChain(traversal, params));
  return found === undefined ? null : found;
}

/** The index (within `steps`) of the TOP-LEVEL step whose operand holds a `parent` marker, or -1. Unlike
 *  `parentMarkerReadIn` (which recurses into nested bodies to CLASSIFY the read), this looks only at each
 *  step's OWN operand args — it answers "which pushed step is the injection filter", so arg-less pushdown
 *  can END the sibling prefix there (a trailing reducer over a scattered result is not a global push — it
 *  scatters + reduces LOCALLY, exactly as the explicit form does). Reuses `isParentMarkerBody`. */
export function parentMarkerStepIndex(steps: readonly Step[], params: Record<string, any>): number {
  const holdsMarker = (value: unknown): boolean => {
    if (isNested(value)) return isParentMarkerBody(stepChain((value as { nested: any }).nested, params));
    const pred = value as { operands?: readonly { value: unknown }[] } | null;
    return pred?.operands != null && pred.operands.some((o) => holdsMarker(o.value));
  };
  return steps.findIndex((s) => (s.args ?? []).some((a) => holdsMarker(a.value)));
}

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

/** Build the CallSpec (service name + resolved constant params + optional mid-traversal injection)
 *  for a `call` IRStep, from its args (string name, optional Map / project-traversal) and folded withArgs.
 *
 *  Arg disambiguation follows the grammar's call() overloads
 *  (call_string / call_string_map / call_string_traversal / call_string_map_traversal). A lone nested
 *  traversal arg is TinkerPop's DYNAMIC-PARAMS traversal (`project(...).by(constant)` → a constant map).
 *
 *  The per-parent INJECTION is NOT a positional arg any more — it is the `parent` MARKER
 *  (`call('parent', <read>)`) the user writes INSIDE the `traversal` sub-body, in a predicate operand
 *  (`has('sku', __.call('parent', __.values('sku')))`). `injectionTraversal` is that marker's READ body,
 *  extracted from the traversal AST BEFORE it is serialized to a string (`parentMarkerReadIn`). Keeping it
 *  the read body (not the whole marker) means `injectionKindOf(spec.injectionTraversal)` downstream is
 *  unchanged — it classifies a `values`/`id`/`label` body exactly as before. */
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
  const withTraversal = (step.withArgs ?? []).find(([k]) => k === 'traversal')?.[1];
  const rawTraversal = mapArg?.get('traversal') ?? withTraversal;
  const traversalValue = isNested(rawTraversal) ? (rawTraversal as { nested: any }).nested : undefined;
  const injectionTraversal = traversalValue ? parentMarkerReadIn(traversalValue, params) ?? undefined : undefined;
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
