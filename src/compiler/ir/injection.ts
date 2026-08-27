// ---------- mid-traversal federate value injection (the `parent` marker) ----------
//
// A mid-traversal V().call("federate", …) injects each parent's scalar into the sibling sub-traversal.
// The user marks the injection point with a SELF-DELIMITING marker CALL in a PREDICATE OPERAND position:
//
//   __.V().has('sku', __.call('parent', __.values('sku')))
//
// The marker is `call("parent", <read>)` where `<read>` is a DIRECT value read of the parent traverser
// (`__.values('k')` / `__.id()` / `__.label()`). It carries BOTH facts in one place: WHERE to inject
// (its operand position) and WHAT to read from the parent (its read body). It is expressible by every
// unmodified GLV (a `call()` is the sanctioned extension point — locked decision #4/the GLV constraint)
// and is self-delimiting: nobody writes `call("parent", …)` for any other reason, so it is unambiguous
// with NO surrounding `traversal` arg to delimit it — which is exactly what makes the ARG-LESS form
// (win 2a) possible. It REPLACED the older `T.value` token, which was collision-free only because the
// explicit `traversal` arg drew the boundary that said "markers live here"; remove the arg and `T.value`
// (a legitimate by()/order() property token) becomes ambiguous. The marker's read is also more explicit
// — it NAMES `values`/`id`/`label` rather than relying on a separate positional `__.values('k')` arg.
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
// This module is a dependency-free leaf (string constants + pure predicates over an ALREADY-PARSED
// body, never `stepChain` itself) so both the compiler (strategies.ts) and the service (federate.ts)
// import it without a cycle. A caller with a nested operand runs `stepChain` first, then asks here.

/** The reserved params key under which a federate hop supplies the DISTINCT injected values for the
 *  sibling compile to bind against a `parent` marker operand. Underscore-prefixed so it can never
 *  collide with a user bound-param name. (An internal reserved key, never user-facing — not a service
 *  name, so it keeps its prefix.) */
export const INJECT_VALUES_KEY = '_mogwai_inject';

/** The injection MARKER service name — `call("parent", <read>)`. A leaf constant so both the recognizer
 *  (strategies.ts) and the classifier (call-params.ts) name it without importing a service impl. It has
 *  NO registered service: it is a compile-time marker the `substituteInjectionMarker` Pass consumes and
 *  the sibling never sees a `call("parent")` reach a registry (it is rewritten to `within(...)` first),
 *  and a `parent` marker with no injected values supplied stays inert / fails closed. */
export const PARENT_MARKER = 'parent';

/** The federate service name — a leaf constant so the segment planner can recognize a federate barrier
 *  (to infer pushdown for the arg-less form) without importing the service impl. */
export const FEDERATE_SERVICE = 'federate';

/** The reserved params key under which a `.with("subgraph", true)` federate hop supplies the DISTINCT
 *  endpoint ids to fetch as a SECOND sibling hop (`g.V(_mogwai_endpoints)`). A plain bound-collection id
 *  seek — the sibling's `elementScan` explodes it as ONE `json_each` bind for ANY size, so the id set
 *  never enters the sibling's statement text (the data-not-in-text rule applied across the wire, not
 *  just local SQL). Kept DISTINCT from `INJECT_VALUES_KEY`: that is a `within(...)` marker substitution;
 *  this is a bare `V(<ids>)` id lookup — different mechanism, so a different reserved key. */
export const ENDPOINT_IDS_KEY = '_mogwai_endpoints';

/** True iff a PARSED nested-operand body is the `parent` marker — a single `call("parent", …)` step.
 *  The caller runs `stepChain` on a `{nested}` operand first (this module stays a leaf, no parser), then
 *  asks here. Used ONLY at a predicate-operand position (has/is/within value): a nested body elsewhere is
 *  an ordinary filter/by traversal. `body[0].args[0]` is the service-name arg (the string `'parent'`);
 *  the read, if any, is `body[0].args[1]` (a nested `__.values('k')`/`__.id()`/`__.label()`). */
export const isParentMarkerBody = (body: readonly { name: string; args: readonly { value: unknown }[] }[]): boolean =>
  body.length === 1 && body[0]!.name === 'call' && body[0]!.args[0]?.value === PARENT_MARKER;

/** The injected distinct-value array from a params map, or null when this compile is not a federate
 *  hop carrying an injection (so the marker, if present, stays inert / fails closed at the caller). */
export const injectedValues = (params: Record<string, unknown>): unknown[] | null => {
  const v = params[INJECT_VALUES_KEY];
  return Array.isArray(v) ? v : null;
};
