# test — the build discipline

- **Run `mise run test`, NOT bare `bun test`.** The mise task carries the `depends` that set up
  the environment — `install`, `submodule`, and crucially `check` (`tsc --noEmit`). Bare `bun test`
  skips type-checking and the submodule, so green there can hide broken types. `bun test <file>` is
  fine for a fast inner loop on one already-type-checked file, never as the gate. `mise run L1`..`L4`
  run one level each; `mise run ci` is the full gate.

## The conformance ladder — one folder per level

- **L1** (`test/L1-corpus/`) — 2,298 canonical traversals; parse+chain must stay **100%**.
- **L2** (`test/L2-sql/`) — the compile-to-SQL contract, split by step family.
- **L3** (`test/L3-conformance/`) — the official cucumber suite over GraphBinary, **ratcheted**:
  one committed `l3-state.json` is the floor; a run fails on any regression or a count below it.
  Telemetry (delta + gap summary) is always on. Runbook: `README-cucumber.md`.
  - **L3 is the floor, not the goal.** The count measures documented scenarios that pass; it does
    NOT measure how much of the grammar composes. The goal is the *ceiling* — generic lowering that
    composes the full nested Gremlin grammar at any valid depth/combination. A one-off fix that
    passes exactly the scenario L3 names raises the floor by one; extending the generic seam raises
    the ceiling and the floor follows for free. So read a rising L3 count as a *side effect* of the
    right work, never as the target — and don't chase a scenario with a special-case (see the
    seam directive in `src/compiler/steps/CLAUDE.md`).
  - **`passed[]` legitimately contains repeated names — this is NOT a ratchet bug (we have
    diagnosed it twice; do not "fix" it a third time).** TinkerPop ships distinct scenarios that
    normalize to the same name (e.g. the `g_V_bothE_properties_dedup_hasKeyXweightX_hasValueXltX0d3XX_value`
    and `g_V_both_properties_dedup_hasKeyXageX_hasValueXgtX30XX_value` pairs each appear twice —
    different feature/graph fixtures, same generated name). So `passing` counts scenarios, not
    unique names: `len(passed) > len(set(passed))` is expected and the count is correct.
- **L4** (`test/L4-addendum/`) — our Gherkin addendum for gaps the official corpus misses; gate =
  all pass. Add a scenario by dropping it in a `.feature` — no code change.
- Shared reference-graph seeds live in `test/fixtures/`.

## Guardrails

- **Version split — do not collapse.** Parser + corpus track tinkerpop `origin/master` (a
  forward-compatible superset); L3 conformance tracks the pinned beta.2 checkout (matches the
  `gremlin` npm wire). Pinning L3 to master breaks it for zero gain.
- **Every new step lands with** L2 SQL snapshots + its cucumber tag in `tags.ts`, L1 still 100%.
- **SQL snapshots assert semantic equivalence, NOT byte-identity.** A refactor that moves the SQL
  string but means the same thing (same result set + plan shape) is fine — update the snapshot,
  don't chase byte-for-byte output.
