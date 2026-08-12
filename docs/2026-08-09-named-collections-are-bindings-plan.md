# Named collections: remaining work

`aggregate("a")` retains a member relation; `cap("a")` is the only reduction point.
Multi-site accumulation, root scope, snapshots, keyed groups, and merge policies have
landed. Do not rebuild a collection at its registration site.

This is a relational distinction, not an implementation preference. A registration is one site in
the traversal; reduction there loses the relation needed to merge another site, preserve a `by()`
body's correlation, or observe a later mutation boundary. A named collection is therefore a
`Binding` with member relations; a `cap` consumes those relations once.

## Model

- Sites remain distinct in chain order and combine with `UNION ALL` at the read. Multiset behaviour
  is preserved until an explicit reducer chooses otherwise.
- A relation binding marked `snapshot` records the value at that point. This is required because a
  CTE is recomputed by a later statement and may otherwise see mutations it must not.
- Keyed grouping retains `(key, contribution)` member rows. It does not retain a prebuilt map:
  multiple sites then merge per key with the same reduction machinery.
- A declared side-effect policy is a seeded left fold. It specifies how members combine, not how
  they are framed. Keep merge policy and member representation separate.
- Side effects are root-global. A rooted body may register/read them, but its retained relation may
  not capture an outer correlated row.

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

- A `by()` body stays correlated to its registration site; only reduction moves.
- A whole-relation encoding decision sees members from every site.
- Merge policy combines members; member framing represents them. Keep those concerns
  separate.
- A direct `cap().unfold()` cancellation is an optimization, never a licence to discard ordering.
  The member relation has an encounter channel, but only an ordered reduction establishes list order.

Reference anchors: `vendor/tinkerpop/gremlin-core/.../AggregateStep.java`,
`SideEffectBarrierStep.java`, `DefaultTraversalSideEffects.java`, and `BulkSet.java` at
the pinned submodule revision.
