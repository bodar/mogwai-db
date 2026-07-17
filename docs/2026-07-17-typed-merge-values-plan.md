# Typed merge values — honor the wire type channel deeply (2026-07-17)

**Status:** plan, executing. Closes the `feature-support-matrix` mergeV/mergeE limitation
"merge prop VALUES are JS-type-inferred (uuid/datetime/long may mistype)" and the
consolidation §6.1 deferred follow-on (a) "typed merge VALUES".

## The bug

`property()` writes are typed from the truth channel; merge writes are not:

```
g.V(1).property('gid', UUID('…'))   → stored vtype 'uuid'    (via Step.argTypes)
g.mergeV([gid: UUID('…')])          → stored vtype 'string'  (JS-inferred via singleProps)
```

Same value, different stored type. The merge MATCH is unaffected (value-equality is
vtype-agnostic, TEXT=TEXT); only the stored vtype on create/onMatch is wrong, surfacing on
typed reads (`has('gid', typeOf(UUID))`) and GraphBinary framing. Pre-existing; 0 corpus
consumers (merge corpus uses only int/string values), so no ratchet move — a
correctness/principle fix, per [[legality-not-corpus-defines-support]].

## Design principle (the project's posture)

Honor the type where it is present on the wire; infer from the JS value only where the
client dropped it. A JS client loses uuid/datetime/long **at serialization** (JS can't
distinguish UUID from string) — no server can recover it. A typed client (Java/Python/…)
serializes the true GraphBinary DataType per value. So: capture the wire truth deeply →
when a client is fixed (or an upstream JS-client PR lands), it **just works**.

## Wire vs storage depth (the one honest floor)

- **Wire capture: recurse all the way down.** Cheap (read DataType bytes, reuse client
  scalar deserializers, hand-roll map/list/set iteration). Produces a full `TypeNode` tree.
- **Storage honoring: scalar property VALUES only.** A collection prop value stores as one
  JSONB blob with a single `vtype` (list/map/set) — JSON has no uuid/datetime type, so
  collection ELEMENT types collapse at storage regardless of wire depth. Typing collection
  elements (**S2**) is a separate substrate change (per-element type tags + read-framing)
  with zero reachable consumers today — deferred; the deep wire capture is the foundation
  it will consume without re-touching the wire.

## Three channels → one typed `MergeSpec`

| Channel | Source of truth | Where |
|---|---|---|
| Inline literal `[gid: UUID(x)]` | parser subtype (computed in `walkArgs`, today discarded by `argOf`/`mapLiteral`) | `frontend.ts` |
| Bound map from typed client | GraphBinary per-entry DataType (today `decodeMapWithValueTypes` reads one level, delegates deeper to `anySerializer` which drops inner types) | `wire.ts` |
| Nested `[gid: __.constant(UUID(x))]` | `nestedScalarValue.vtype` (computed, dropped by `resolveMergeSpec.rv`) | `write.ts` |

## Representation — `TypeNode`

Non-breaking widening (scalars stay bare strings; `gremlinTypeOf` already falls through to
JS inference for containers, so only merge reads the tree):

```ts
type TypeNode = CanonicalType | { t: 'map'; entries: Record<string, TypeNode|null> }
                              | { t: 'list'|'set'; items: (TypeNode|null)[] };
```

- `paramTypes: Record<string, string>` → `Record<string, TypeNode>`.
- `Step.argTypes?: (string|null)[]` → `(TypeNode|null)[]`.
- All existing argTypes consumers unaffected: scalar arg → string (as now); container arg →
  object, `gremlinTypeOf` sees an unrecognized name → JS-infers `list`/`map`/`set` (same
  result as the old flat string).

## Build stages (each: green tsc + bun test + L3 hold, commit)

1. **Wire + type foundation (behavior-preserving).** `TypeNode` in `gremlin-types.ts`;
   recursive `decodeTyped` in `wire.ts` (replaces `decodeMapWithValueTypes`); widen
   `paramTypes`/`Step.argTypes`/`walkArgs` types across router/manager/executeQuery/compile/
   stepChain/worker. No consumer reads the tree yet → identical behavior.
2. **Literal map deep types.** `walkArgs` map-literal case builds a deep `TypeNode` (recurse
   the parse tree) instead of the flat `'map'`. Still no consumer → identical behavior.
3. **Merge consumes types.** `normalizeMergeMap(raw, typeNode, …)` → `MergeSpec` carries
   per-prop vtype; `resolveMergeSpec` threads it (nested via `nestedScalarValue.vtype`,
   literal/bound via the tree); `singleProps`/`insertVertex`/`applyVertexProperty`/
   `insertEdgeProperty` honor it. Tests: inline `[gid: UUID(x)]`→uuid, `[n: 5L]`→long,
   nested `[gid: __.constant(UUID(x))]`→uuid; bound-map via a wire-level test.

## Follow-ons (documented, not this pass)

- **Upstream JS-client PR** (UPSTREAM-first): teach gremlin-js GraphBinary to preserve value
  types (typed `UUID`/`Instant` wrappers, or a type-preserving MapSerializer). Then the JS
  client stops dropping types and our infer-fallback goes quiet automatically.
- **Non-conformant-client shim** (opt-in `CompileOptions`/`withStrategies` switch): a regex
  UUID matcher (uuid is an obvious string shape) restoring the type when the wire said
  `string`; optionally auto-enabled on detecting a JS client (by client name/version if the
  handshake carries it).
- **S2 — typed collection elements**: per-element type tags in the JSONB storage format +
  read-framing. Big, JSON-round-trip-heavy, zero consumers today.
