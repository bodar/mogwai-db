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
// key below holding per-parent `(corrId, value)` pairs. The sibling's SOURCE LOWERING (`lowerChain`,
// `lower.ts`) explodes those pairs as ONE `json_each` bind and JOINS its value cell to the host `has()`
// property, projecting the correlation cell (`corrId`) as an `origin` channel — Calcite `Correlate`, so a
// returned element carries the id of every parent it matched and the rejoin correlates by that id, NEVER
// by re-matching the value. One batched sibling hop over the pooled parent values (a SPARQL bound-join),
// with no inline values baked into statement text.
//
// This module is a dependency-free leaf (string constants + pure predicates over an ALREADY-PARSED
// body, never `stepChain` itself) so both the compiler (strategies.ts) and the service (federate.ts)
// import it without a cycle. A caller with a nested operand runs `stepChain` first, then asks here.

/** The reserved params key under which a federate hop supplies injected correlation/value pairs for the
 *  sibling compile to bind against a `parent` marker operand. Underscore-prefixed so it can never
 *  collide with a user bound-param name. (An internal reserved key, never user-facing — not a service
 *  name, so it keeps its prefix.) */
export const INJECT_VALUES_KEY = '_mogwai_inject';

/** An internal marker on the sibling request for federate's grouped reduction transport.  Its GROUP
 * key is the injected correlation channel, which is not a Gremlin property and therefore must be
 * selected by the RelIR lowering rather than by the synthesized Gremlin text. */
export const INJECT_REDUCE_KEY = '_mogwai_inject_reduce';

/** True only for the sibling half of federate's corrId-keyed reduction pushdown. */
export const injectedReduction = (params: Record<string, unknown>): boolean =>
  params[INJECT_REDUCE_KEY] === true;

/** The injection MARKER service name — `call("parent", <read>)`. A leaf constant so both the recognizer
 *  (`call-params.ts`) and the sibling SOURCE LOWERING (`lower.ts`, which builds the correlated
 *  `(corrId, value)`-pairs join at the marker) name it without importing a service impl. It has NO
 *  registered service: it is a compile-time marker the lowering consumes, so the sibling never sees a
 *  `call("parent")` reach a registry — the marker `has()` becomes the correlated join, not an operand
 *  rewrite. A `parent` marker with no injected pairs supplied stays inert / fails closed. */
export const PARENT_MARKER = 'parent';

/** The federate service name — a leaf constant so the segment planner can recognize a federate barrier
 *  (to infer pushdown for the arg-less form) without importing the service impl. */
export const FEDERATE_SERVICE = 'federate';

/** The reserved params key under which a `.with("subgraph", true)` federate hop supplies the DISTINCT
 *  endpoint ids to fetch as a SECOND sibling hop (`g.V(_mogwai_endpoints)`). A plain bound-collection id
 *  seek — the sibling's `elementScan` explodes it as ONE `json_each` bind for ANY size, so the id set
 *  never enters the sibling's statement text (the data-not-in-text rule applied across the wire, not
 *  just local SQL). Kept DISTINCT from `INJECT_VALUES_KEY`: that carries per-parent `(corrId, value)`
 *  pairs the sibling correlates on; this is a bare `V(<ids>)` id lookup — different mechanism, so a
 *  different reserved key. */
export const ENDPOINT_IDS_KEY = '_mogwai_endpoints';

/** True iff a PARSED nested-operand body is the `parent` marker — a single `call("parent", …)` step.
 *  The caller runs `stepChain` on a `{nested}` operand first (this module stays a leaf, no parser), then
 *  asks here. Used ONLY at a predicate-operand position (has/is/within value): a nested body elsewhere is
 *  an ordinary filter/by traversal. `body[0].args[0]` is the service-name arg (the string `'parent'`);
 *  the read, if any, is `body[0].args[1]` (a nested `__.values('k')`/`__.id()`/`__.label()`). */
export const isParentMarkerBody = (body: readonly { name: string; args: readonly { value: unknown }[] }[]): boolean =>
  body.length === 1 && body[0]!.name === 'call' && body[0]!.args[0]?.value === PARENT_MARKER;

/** The per-parent correlation id, as a VALID IDENTIFIER (`c0`, `c1`, …) — the same identifier shape every
 *  other bound name in the system uses, never a bare number dressed as a string. `corrKey(n)` mints it;
 *  `corrOrdinal(key)` reads the ordinal back. */
export const CORR_PREFIX = 'c';
export const corrKey = (ordinal: number): string => `${CORR_PREFIX}${ordinal}`;
export const corrOrdinal = (key: string): number => Number(key.slice(CORR_PREFIX.length));

/** The injected per-parent correlation/value pairs from a params map. The pairs cross as ONE `json_each`
 *  bind of any size — a MAP `{corrKey: value}` keyed by the correlation IDENTIFIER (the shape the
 *  correlation IS: "bindings keyed by correlation id"). `json_each` over that object yields `key`=corrKey,
 *  `value`=value directly. `corrId` here is the numeric ordinal read back off the identifier key. Returns
 *  null when the injection is absent or is not that map shape; a `Map` (from the wire) and a plain object
 *  are both accepted. */
export const injectedPairs = (params: Record<string, unknown>): { readonly corrId: number; readonly value: unknown }[] | null => {
  const v = params[INJECT_VALUES_KEY];
  const entries = v instanceof Map ? [...v.entries()]
    : v != null && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v as Record<string, unknown>)
      : null;
  if (!entries) return null;
  const pairs = entries.map(([k, value]) => ({ corrId: corrOrdinal(String(k)), value }));
  return pairs.every((p) => Number.isInteger(p.corrId)) ? pairs : null;
};
