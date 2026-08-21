// ---------- mid-traversal federate value injection (Phase 6b) ----------
//
// A mid-traversal V().call("mogwai.graph.federate", …, __.values('k')) injects each parent's scalar
// into the sibling sub-traversal. The user marks the injection point with the SHIPPED GLV enum token
// `T.value` in a PREDICATE OPERAND position — `__.V().has('sku', T.value)` — which the stock JS/other
// GLVs serialize verbatim (no custom binding, no raw string). `T.value` is otherwise meaningless as a
// has()/is() value operand (it is only ever legitimately a by()/order() modulator — a DIFFERENT IR
// field), so recognizing it there is collision-free.
//
// The sibling receives the sub-traversal as an ordinary query PLUS a params entry under the reserved
// key below holding the DISTINCT injected values. A Pass (`substituteInjectionMarker`, strategies.ts)
// rewrites the marker operand to a `within([...], INJECT_VALUES_KEY)` — ONE named-collection operand,
// so it lowers to a single `json_each` bind (`predicate.ts` `jsonEachInSet`), the same data-sized-set
// re-injection the regex/split barriers use. One batched sibling hop over the distinct set (a SPARQL
// bound-join), the injected values crossing as one bind of any size rather than inline literals baked
// into the statement text. No string surgery: apply just supplies a params value, and N marker sites
// share ONE bind via the kernel's reuse-key dedup (they name the same key).
//
// This module is a dependency-free leaf (a string constant + two pure predicates) so both the compiler
// (filter.ts) and the service (federate.ts) import it without a cycle.

/** The reserved params key under which a federate hop supplies the DISTINCT injected values for the
 *  sibling compile to bind against a `T.value` marker operand. Underscore-prefixed + mogwai-namespaced
 *  so it can never collide with a user bound-param name. */
export const INJECT_VALUES_KEY = '_mogwai_inject';

/** True iff `operand` is the `T.value` injection marker (the parsed `{token:'value'}` shape) — used
 *  ONLY at a predicate-operand position (has/is/within value), never a by()/order() modulator. */
export const isInjectionMarker = (operand: unknown): boolean =>
  operand != null && typeof operand === 'object' && (operand as { token?: string }).token === 'value';

/** The injected distinct-value array from a params map, or null when this compile is not a federate
 *  hop carrying an injection (so the marker, if present, stays inert / fails closed at the caller). */
export const injectedValues = (params: Record<string, unknown>): unknown[] | null => {
  const v = params[INJECT_VALUES_KEY];
  return Array.isArray(v) ? v : null;
};
