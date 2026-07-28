# test — the build discipline

- **Run `mise run test`, NOT bare `bun test`.** The mise task carries the `depends` that set up
  the environment — `install`, `submodule`, and crucially `check` (`tsc --noEmit`). Bare `bun test`
  skips type-checking and the submodule, so green there can hide broken types. `bun test <file>` is
  fine for a fast inner loop on one already-type-checked file, never as the gate. `mise run L1`..`L5`
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
- **L5** (`test/L5-properties/`) — property-based, the only level whose inputs nobody wrote down.
  Generates well-typed Gremlin by walking a shape lattice (state = stream shape, transition = step,
  so `count().out()` is unreachable by construction) and asserts the fast-path differential:
  **fast paths on ≡ fast paths off**, over the L1 corpus AND generated traversals, all-six-off and
  one-at-a-time. Self-oracling — `FastPathConfig` declares the generic path the semantic authority,
  so a disagreement is always a defect on the optimized side. Ratcheted like L3 (`known.ts`, one
  entry per ROOT CAUSE with a diagnosis, never per traversal). **A SECOND oracle** (`laws.ts`,
  `metamorphic.test.ts`) checks metamorphic laws — `out(l) ≡ outE(l).inV()`, `dedup()` idempotence,
  `where(b) ⊎ where(¬b)` partitioning — over generated prefixes; it exists because a differential is
  blind to a defect BOTH lowerings share, and it found two such on its first deep run. Fixed seed in CI;
  `mise run L5-random` explores. **L5 is the CEILING instrument** — it measures what composes,
  which is the thing the L3 count structurally cannot. Current state + runbook:
  `L5-properties/README.md`; design rationale + the unbuilt oracles:
  `docs/2026-07-28-property-based-testing-l5.md`.
- Shared reference-graph seeds live in `test/fixtures/`.

## Guardrails

- **Everything tracks tinkerpop `origin/master` — the version split is GONE** (2026-07-26). The
  submodule, the L3 corpus, and the CLIENT itself are all master; `gremlin` resolves to the
  submodule via `bun link` (`scripts/init-submodule.sh` builds + links it), because the server
  must frame with the same client the suite tests it against. npm's newest v4 is still
  4.0.0-beta.2, ~300 commits behind and without the `gremlin/io` export.
  The old rule here said "pinning L3 to master breaks it for zero gain" — **measured, and it is
  false**: master is L3 1363/2297 vs beta.2's 1347/2041 (+16 passing, +256 scenarios in scope).
  What master actually needs is two runner details, each of which fails SILENTLY: cucumber 13
  wants a **glob** for features and for `--import` step definitions (a bare directory matches
  zero and reads as a total failure), and Bun's built-in `undici` shim lacks
  `Agent.close()`/`destroy()` so every client teardown throws (`test/support/undici-shim.ts`).
- **Every new step lands with** L2 SQL snapshots + its cucumber tag in `tags.ts`, L1 still 100%.
- **A new fast path lands with its L5 differential, not just a non-empty `equivalentWhen`.** The
  registry test only checks that the field is a non-empty string; L5 is what checks the claim. Six
  switches shipped before L5 existed and the generic path had never been executed under test — which
  is how `predicateInlining` came to be not disable-safe (see `L5-properties/known.ts`).
- **Anything L5 finds gets promoted into an L4 `.feature` once fixed.** Exploration is how the
  ceiling gets measured; L4 is how it becomes floor. A finding that stays only in `known.ts` is
  tracked, not defended.
- **SQL snapshots assert semantic equivalence, NOT byte-identity.** A refactor that moves the SQL
  string but means the same thing (same result set + plan shape) is fine — update the snapshot,
  don't chase byte-for-byte output.
