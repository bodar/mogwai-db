# GraphQL front end

**Status: deferred.** GraphQL is a typed, finite field-selection tree, not a traversal language.
It belongs beside the Gremlin front end: translate a whole operation to the shared IR, then use the
same RelIR lowering and framing substrate.

## Mapping and boundary

A selection set maps naturally to `project(...).by(...)`: roots filter elements, fields read values
or move over edges, nested selections become child traversals, aliases become record keys, and
variables are user parameters. Compile the whole tree into one plan. Resolver-per-field execution,
even with batching, is row-at-a-time traversal interpretation and is out of bounds.

GraphQL does not natively express transitive traversal, paths, side effects, sacks, or general
barriers. Aggregation and recursion require deliberately designed extensions; they must not leak in
as accidental Gremlin escape hatches.

## Schema and emission

Reflect the graph schema rather than maintaining a parallel declared model. Labels and property
types determine object and scalar fields; relationship fields are explicit directional graph edges.
Authorization belongs in schema/argument policy before translation, not as post-query filtering.

Translate to `Step[]` or IR data directly only after a small equivalence spike. Either representation
must preserve parameter names/types, source locations for errors, and the compiler's ordinary Pass
pipeline. It must not invent a second bind or shape vocabulary.

## Prerequisites and validation

The first useful slice depends on generic nested `project`/`by` lowering, records/maps, child
cardinality, ordering/slicing, and typed values—shared RelIR work, not GraphQL-only features. Keep
the front end deferred until that path composes.

Use GraphQL HTTP/introspection conformance tests plus differential execution against a reference
GraphQL implementation for the schema surface. New dependencies require explicit approval.

## Research direction

Start with a reflected-schema spike over one label, scalar fields, and one relationship. Establish
whether translation emits `Step[]` directly or canonical Gremlin text by proving both retain source
locations, variable names/types, and the ordinary Pass pipeline; do not decide by convenience.

The first compiler probe is a nested selection expressed as `project(...).by(...)` at depth three,
with filter, order, slice, null/productivity, and a list field. It should call the lowering directly,
not the executor, so a successful fallback cannot be mistaken for support. The resulting gaps belong
to the shared child/record/map/tail substrate in the RelIR plan.

Before a public endpoint, verify three independent contracts: GraphQL-over-HTTP behaviour,
introspection round-trip (`getIntrospectionQuery` → reflected schema), and execution differential
against a naive reference resolver over the same graph. The reference implementation may supply
parse/validation/introspection only with explicit dependency approval; mogwai owns translation.

Keep recursion, aggregation, mutations, subscriptions, federation, and any Gremlin escape hatch out
of the first slice. Each needs an explicit GraphQL surface and its own semantics/authorization review.
