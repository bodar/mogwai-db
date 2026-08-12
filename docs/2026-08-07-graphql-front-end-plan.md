# GraphQL front end

**Status: deferred.** GraphQL is a typed, finite selection tree. It maps naturally to RelIR projection and child relations, but not to traversal recursion, paths, side effects, or arbitrary Gremlin predicates. It is an additional surface, never a replacement for Gremlin.

## Prerequisite substrate

Build the compiler families first: nested `project`/records, property and element maps, child-scope order/slice/dedup, aliases, and map values. These are shared RelIR capabilities; GraphQL should consume them rather than drive bespoke lowerings.

## Shape of the surface

- Reflect the graph schema from storage; do not make a second declarative schema authority.
- Translate a validated selection tree as one plan. Resolver-per-field execution is forbidden because it creates N+1 traversal work.
- Put parsing, validation, reflection-to-IR translation, and HTTP handling in the Worker. Fetch schema from the owning DO; use a versioned compare-and-swap only if measurement shows request-by-request reflection is too costly.
- Variables are user parameters and therefore binds; document literals are typed SQL literals.
- Leave recursion and unrestricted traversal behind explicit non-standard escape hatches.

## Validation and dependency

Use `graphql-js` for parsing, validation, and differential execution; use `graphql-http` for protocol audits. The dependency approval recorded on 2026-08-07 applies when implementation begins; do not add either package early.

This surface benefits from edge plan shipping but does not require it for its compiler substrate.
