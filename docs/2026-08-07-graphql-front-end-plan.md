# A GraphQL front end — design and build plan

**Status: proposed.** GraphQL is a typed, finite selection language over a schema. This plan does
not ask whether it exposes every Gremlin traversal: recursion, paths, sacks, arbitrary barriers, and
arbitrary predicates are not ordinary GraphQL features and are not gaps in this plan.

The question is narrower: what does a normal GraphQL client expect that mogwai does not yet provide,
and how do we implement it without a resolver-per-field interpreter?

## Ordinary GraphQL requirements

A useful baseline needs all of the following:

| Surface | What mogwai needs |
|---|---|
| Schema and validation | a graph-reflected SDL, GraphQL parse/validation, and introspection |
| Root fields and scalar fields | label/property projection with GraphQL scalar coercion |
| Nested object and list fields | correlated child projection; lists of records at any finite depth |
| Arguments | schema-defined filtering, ordering, and cursor/offset pagination per field |
| Selection semantics | aliases, fragments, interfaces/unions where reflected, `__typename`, field merging |
| Result semantics | nullable/non-null propagation, field error paths, and GraphQL-shaped response envelopes |
| Variables | GraphQL coercion followed by ordinary named parameter binds |
| HTTP | GraphQL-over-HTTP request decoding, media negotiation, GET/POST, and error status rules |
| Mutations | typed input objects, ordered writes, and selection of retained write results |

These are the scope. Aggregation, recursive graph walks, subscriptions, Apollo Federation, custom
SDL mappings, and any Gremlin escape hatch are product extensions to decide separately.

## Selection lowering

A selection set is structurally a nested record projection: for each parent, compute selected scalar
fields and child selections; a to-many child then becomes a list of child records. `project(...).by(...)`
is the existing Gremlin-level representation, but GraphQL must compile the whole operation to one plan.
Resolver-per-field execution, even with a DataLoader, is row-at-a-time interpretation and violates the
project's compile-to-SQL boundary.

The first shared engine probe is a depth-three selection with scalar fields, one relationship list,
filter/order/pagination on that list, aliases, and variables. Run it through RelIR lowering directly:
executor success cannot establish that the shared lowering supports it.

| GraphQL requirement | Shared substrate |
|---|---|
| object/scalar selection | typed property and record projection |
| to-many object field | a list with record members, ordered per parent |
| nested field arguments | child filter/order/range/limit plus a correct parent rejoin |
| aliases/fragments | record keying, selection merge, and type-condition filter |
| mutation selection | set-based write bindings and retained `RETURNING` rows |

The hard representation requirement is a list of records. It belongs in the common payload/framing
vocabulary, not in a GraphQL-only JSON encoder.

## Schema reflection

The stored graph has labels, typed properties, and edges but no declared GraphQL SDL. Reflect it per
graph:

```
labels + vertex_labels       → object types and currently inhabited labels
vertex_properties            → fields and GraphQL scalar candidates
edges + endpoint labels      → directional relationship fields and return types
edge_properties              → relationship metadata where surfaced
```

Reflection must decide and document names, collisions, absent-property nullability, multi-label
elements, and property type conflicts. Do not pretend an observed value distribution establishes a
permanent non-null or scalar guarantee. Start conservative; a user SDL/mapping override is a separate
later feature.

Translation depends on this schema, unlike normal compilation. Start with a schema fetch per request
for correctness. If measurement justifies caching, use a schema/write version compare-and-swap: execute
only when the compiled-against version still holds, otherwise return the new schema and retry. A TTL
is not a correctness protocol.

## Placement and representation

GraphQL parsing, validation, schema-driven translation, and ordinary compilation belong in the Worker;
the Durable Object owns graph storage and plan execution. This follows the compile-at-the-edge boundary:
translation is elastic work, while graph reads/writes remain graph-local.

The front end stops at the existing IR boundary. It must not construct RelIR or SQL: those layers would
duplicate element identity, labels, property typing, payload shape, and framing authority.

Whether translation emits canonical Gremlin text or `Step[]` directly is an explicit spike:

- Text uses the established parser entry point and gives grammar validation by construction.
- `Step[]` avoids a second lexical type encoding for GraphQL literals, but needs a structural validity
  check and a render/parse equivalence test.

Choose only after proving nested selections preserve source locations, argument names/types, parameter
provenance, and the ordinary compiler Pass pipeline. Explain belongs in a namespaced GraphQL
`extensions` entry, never an ad-hoc top-level request parameter.

## Variables and errors

GraphQL variables are user-declared values, therefore named parameters and SQL binds. Document literals
are compiler-held constants and remain typed SQL literals. This preserves the parameter budget and
statement-cache contract without GraphQL-specific bind rules.

GraphQL validation failures occur before execution. Resolver/lowering failures become field errors with
the standard `errors[].path` and null propagation dictated by the selected field's nullability. Do not
turn a GraphQL error into an HTTP transport crash or a silent partial Gremlin result.

## Validation and dependencies

Three independent checks are required:

1. GraphQL-over-HTTP compliance, including media types and request/error behaviour.
2. Introspection round-trip: `getIntrospectionQuery()` → endpoint → `buildClientSchema()` against the
   reflected schema.
3. Differential execution against a naive reference resolver over the same graph, generated from the
   reflected schema. This detects null propagation, aliases, fragments, field order, and error paths.

`graphql`/graphql-js is the authoritative parser, validator, type system, and introspection library;
mogwai owns graph reflection and translation. Add it, and an HTTP audit package if selected, only with
the explicit dependency approval required by the project rules.

## Delivery order

1. Finish the shared nested-record/list and child-tail substrate with direct lowering tests.
2. Build reflected schema plus introspection, with conservative type/nullability rules.
3. Spike text versus `Step[]`, then translate a read-only baseline selection set in the Worker.
4. Add HTTP, introspection, and reference-differential test suites before widening the query surface.
5. Add schema-directed mutations after set-based writes and retained result selection are complete.

Measure deep-selection statement text and bind counts against the Durable Object limits, and measure
schema reflection/translation as Worker and DO occupancy. Do not add non-standard graph extensions
until the ordinary surface is complete.
