# Named collections: remaining work

`aggregate("a")` retains a member relation; `cap("a")` is the only reduction point.
Multi-site accumulation, root scope, snapshots, keyed groups, and merge policies have
landed. Do not rebuild a collection at its registration site.

## Open substrate

- **Keyed declared policies.** A seeded `group("a")`/`groupCount("a")` must merge into
  the declared map. This is collection-owned; the element-keyed `select(Column.keys)`
  prerequisite is not.
- **Mixed member shapes.** A collection can contain an element beside another element
  kind or a scalar. Add a member-level tagged union and framing support; stream-level
  branch variants are not a substitute.
- **Direct member re-entry.** `cap("a").unfold()` may bypass a fold only where its next
  consumer cannot observe collection order. Prove each route with the perturbed-order
  test; an ordered consumer must retain the fold.

## Downstream prerequisites, not collection work

- Element-keyed map re-entry (`select(Column.keys)`).
- Local reducers over map and element members.
- A `by(<numeric reducer>)` type authority.
- `path`, `union`, `simplePath`, and sampling support where they occur after a retained
  relation.

## Invariants

- Sites remain separate until the read, then combine with `UNION ALL`.
- A `by()` body stays correlated to its registration site; only reduction moves.
- A whole-relation encoding decision sees members from every site.
- Side effects are root-global. A rooted body may not retain a relation that references
  an outer chain.
- Merge policy combines members; member framing represents them. Keep those concerns
  separate.

Reference anchors: `vendor/tinkerpop/gremlin-core/.../AggregateStep.java`,
`SideEffectBarrierStep.java`, `DefaultTraversalSideEffects.java`, and `BulkSet.java` at
the pinned submodule revision.
