# Outstanding work

This is an index, not a backlog or a conformance report. The feature matrix records
per-step support; closed work belongs in git history or `docs/archive/`.

## Compounding substrate

- **RelIR completion.** Finish the algebra passes and generic lowering needed for nested
  child bodies, row operations, recursion, paths, and branch arms. These are shared
  mechanisms, not step-by-step projects. Start with
  [the RelIR build plan](./2026-08-01-relir-build-plan.md).
- **Value carriage and framing.** Preserve exact scalar types through JSON-backed
  collections, member variants, maps, aliases, paths, and format adapters. This also
  covers meta-property value typing. The rules are the RelIR plan §6·7; the live gaps
  are its §10. See [the RelIR build plan](./2026-08-01-relir-build-plan.md).
- **Set-based writes.** Replace the remaining row-at-a-time write driver with relational
  `Insert`/`Update`/`Delete` programs, then add the read tails and write forms that depend
  on it. See [the RelIR plan](./2026-08-01-relir-build-plan.md).
- **Retained relations.** The remaining named-collection work is keyed seeds, mixed
  member shapes, and safe direct member re-entry; its downstream gaps are owned by their
  respective substrates. See
  [named collections](./2026-08-09-named-collections-are-bindings-plan.md).
- **Encounter and order.** Establish the missing encounter/rejoin authority for fan-out
  child bodies and the consumers that need deterministic order.

## Product capabilities

- **Graph capabilities:** `tree`, `match`, graph algorithms, and the remaining
  strategy/options forms. Pick a family only after identifying the substrate it needs.
- **Services and graph movement:** federation tails, bulk materialization, and IO formats.
- **Operations:** a real Cloudflare deployment, graph authentication, transaction/session
  semantics, and GraphSON response encoding.
- **Query-plan performance.** The join-order fence and source seek made filtered lookups
  plan-stable without stats (RelIR plan §1 P4). Two follow-ons remain, both optimizations
  now rather than correctness fixes: a `PRAGMA optimize` schedule to gather the stats DO
  allows but cannot bound (after a bulk load / `io().read()`, on the DO alarm or after N
  writes; never per request), and a plan-stability gate — `accessPaths` over a
  few-thousand-vertex fixture, run with and without stats and asserting they agree, as the
  regression guard for the fence and seek.

## Maintenance

- Keep the `antlr4ng` patch live until upstreamed; regenerate and compare `parser/` when
  updating TinkerPop.
- Keep the existing architecture, bind-budget, type-check, and conformance gates green.
  Do not add a second build or test tool.
- Keep the feature-support matrix accurate as capabilities land.
