# test — the build discipline

- **A green run is QUIET, and that is a rule, not a default.** `bun test` runs the dots reporter
  (`bunfig.toml` `[test.reporter] dots = true` — the string spelling `reporter = "dots"` is a bunfig
  load error), and a test file may print at most a standing SUMMARY line or two: a number worth
  watching move. Instrument dumps (corpus step frequencies, unmodelled steps, the per-law
  metamorphic census, L3's live progress marks) go through `test/support/output.ts` —
  `summary()` always, `detail()` only under `$MOGWAI_VERBOSE=1`. Measured: `mise run test` printed
  1,364 lines and now prints 110, of which the L3 telemetry report is half. Nothing is hidden from a
  FAILURE — an assertion prints its full diagnosis either way, and L3's complete bucket ranking is in
  `l3-telemetry.summary.json` regardless. Two sources of noise were not ours and are fixed at the
  source rather than filtered: upstream's cucumber steps `console.error` every throw (dropped by
  exactly that call site in `test/support/cucumber.ts`, because our deferred set is a ratcheted
  expected population, not a broken build), and `wrangler dev` narrates every request at its default
  `info` (spawned with `--log-level error`). The server's own per-query log is off by default too —
  `src/router.ts` `silentLogger`, with `$MOGWAI_LOG=1` for the access log.

- **Run `mise run test`, NOT bare `bun test`.** The mise task carries the `depends` that set up
  the environment — `install`, `submodule`, and crucially `check` (`tsc --noEmit`). Bare `bun test`
  skips type-checking and the submodule, so green there can hide broken types. `bun test <file>` is
  fine for a fast inner loop on one already-type-checked file, never as the gate. `mise run L1`..`L5`
  run one level each; `mise run ci` is the full gate.
- **`mise run ci` ALREADY CONTAINS the ladder, the census and the static gates — do not invoke them
  beside it.** `ci` depends on `check`, `lint`, `arch`, `binds`, `deletion`, `rel-sweep`, `test` and
  `build`, and `test` is a bare `bun test` over all 71 files, so **L1–L5 and `test/census` are inside
  it**. A separate `mise run rel-sweep` / `census` / `lint` / `arch` / `binds` after a green `ci` re-runs
  what just passed AND re-pays its own `depends` (submodule, install, `check`). The single-level tasks
  exist for the inner loop — before `ci`, not after it.
  Only four things are genuinely outside: the three ENV-switch runs (`test:legacy-spine`,
  `test:cf-limits`, `test:perturbed` — a different RUN of the same suite, so they cannot be folded in)
  and a post-commit `mise run L5`, whose seed derives from `HEAD`. `test:perturbed` is worth a run only
  when the change touches ORDER; it is an instrument at a known 4, and running it on a change with no
  ordering surface reports nothing.
- **"Did my change slow the build?" is answered by `[test] Finished in`, NOT by CI wall-clock.**
  mise prints a `Finished in` per task and those are the measurement; wall-clock also contains three
  network-bound phases (`submodule` git fetch, `install`, `build`'s `bunx wrangler`) whose cost is
  set by registry latency, not by the diff. Measured on trunk before those were cached: the same 62
  packages against the same lockfile installed in **0.9s on one run and 51.6s on the next**, which
  read as a 50% CI regression that per-phase timings placed entirely outside `test` (79.4–81.5s
  across all four runs). `.github/workflows/ci.yml` caches bun's download cache, which is where
  that swing lived — but the rule stands, because all three phases are still network-bound and the
  cache still misses on a lockfile or submodule-pin bump. To A/B a compiler change
  properly, pin `L5_SEED` as well: the seed derives from `HEAD`, so it otherwise changes under you
  every commit (±10s of legitimate variation, and a different generated corpus).

## The conformance ladder — one folder per level

- **L1** (`test/L1-corpus/`) — 2,298 canonical traversals; parse+chain must stay **100%**.
- **L2** (`test/L2-sql/`) — the compile-to-SQL contract, split by step family.
- **L3** (`test/L3-conformance/`) — the official cucumber suite over GraphBinary, **ratcheted**:
  one committed `l3-state.json` holds TWO floors. The top level is the default/RelIR-on floor and
  `legacySpine` is the legacy floor; each configuration records only its own section, and a legacy run
  never rewrites the prose conformance count. Their scenario-name set difference (not merely the count
  subtraction) is the migration metric. **The two floors GATE ASYMMETRICALLY, on purpose** (RelIR plan
  §6·1): the RelIR floor is a hard ratchet, while the legacy floor may shed any name the RelIR floor
  holds and fails only on a name NO spine holds — the union of the two `passed` sets is the real floor.
  Legacy is a route with an end date; a RelIR increment that costs legacy five scenarios and gains five
  is progress, and the gate must not be the thing that forbids it. Telemetry is always on. Runbook:
  `README-cucumber.md`.
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
  all pass. Add a scenario by dropping it in a `.feature` — no code change. Read by cucumber's REAL
  parser compiled to pickles (`read-features.ts`), so `Background`/`Scenario Outline` work; the
  RUNNER is ours because upstream's `Given('the traversal of')` ignores the docstring and looks the
  scenario NAME up in a pre-generated map, which our names are not in. Each scenario is its own
  `bun test`, so a failure reports under its name with a diff.
- **L5** (`test/L5-properties/`) — property-based, the only level whose inputs nobody wrote down.
  Generates well-typed Gremlin by walking a shape lattice (state = stream shape, transition = step,
  so `count().out()` is unreachable by construction) and asserts the fast-path differential:
  **fast paths on ≡ fast paths off**, over the L1 corpus AND generated traversals, all-six-off and
  one-at-a-time. Self-oracling — `FastPathConfig` declares the generic path the semantic authority,
  so a disagreement is always a defect on the optimized side. Ratcheted like L3 (`known.ts`, one
  entry per ROOT CAUSE with a diagnosis, never per traversal). **A SECOND oracle** (`laws.ts`,
  `metamorphic.test.ts`) checks metamorphic laws — `out(l) ≡ outE(l).inV()`, `dedup()` idempotence,
  `where(b) ⊎ where(¬b)` partitioning — over generated prefixes; it exists because a differential is
  blind to a defect BOTH lowerings share, and it found two such on its first deep run. Seed is pinned
  at 42 today — a deterministic generated corpus that discovers nothing after its first run; the
  intended end state is a ROTATING seed in the ordinary build, printed and gated by the witness
  ratchets so only a NEW signature fails (item 0d — explicitly NOT a scheduled job).
  `mise run L5-random` is the deeper sweep. **L5 is the CEILING instrument** — it measures what composes,
  which is the thing the L3 count structurally cannot. Current state + runbook:
  `L5-properties/README.md`; design rationale + the unbuilt oracles:
  `docs/2026-07-28-property-based-testing-l5.md`.
- Shared reference-graph seeds live in `test/fixtures/`; shared graph-minting helpers
  (`seeded`/`isWrite`) live in `test/support/graph.ts` — used by both L5 and the census, so they
  live in neither.

## The census — not a ladder level

`test/census/` asks the one question no level above can: **did anything CHANGE?** Every L1–L5 test
asserts correctness; a behaviour-preserving refactor's success criterion is a number that does NOT
move, which — with the ladder alone — is indistinguishable from a refactor that quietly turned
fail-closed deferrals into wrong answers. Two committed TSVs record what the engine DOES with all
2,298 corpus traversals (`goldens.tsv` 1,425 executing + a result digest; `deferrals.tsv` 873
throwing + the message). `mise run census`; re-record with `mise run census-record`.

Seven gates: the artifact covers exactly the corpus · no traversal stops executing · **no executing
traversal changes its answer in either pinned spine position** (the regression nothing else can
see) · the legacy position loses nothing the RelIR position holds (the UNION is the floor — a shed
shape is legal and prints; losing the LAST spine fails at gate 2, because the RelIR position carries
the legacy fallback) · no clean deferral becomes a crash · **the
RelIR spine covers at least as much as the baseline** (the `spine` column — the migration's coverage
ratchet, §10·4 of the RelIR build plan) · a coverage floor. The census is spine-differential by
construction, independent of the ambient switch. Runbook + the status vocabulary:
`test/census/README.md`.

**It deliberately does NOT auto-record.** L3 rewrites its state on a clean local run and that is
safe there because its artifact is a monotone floor. The census is a two-way baseline whose most
dangerous transition is *still runs, different answer* — an auto-record would launder exactly the
regression it exists to catch. Re-recording is a command, and a re-record with no reason in the
commit message is indistinguishable from the regression it hides.

**It records 17 `crashed` rows — fail-closed VIOLATIONS that exist today** (10 bun:sqlite bind
rejections, 3 raw `TypeError`s, 2 `RangeError`s, 1 `UNIQUE constraint`, and 1 case of us emitting
syntactically invalid SQL). The gate holds that count from growing; each one should become a clear
deferral or a fix.

## The perturbation instrument — `mise run test:perturbed`

Runs the WHOLE suite with `PRAGMA reverse_unordered_selects = ON`: SQLite reverses every scan whose
order the query did not constrain, and leaves an `ORDER BY` alone. So a result that holds under both
settings is pinned by the SQL we emit; one that holds only under the default is pinned by SQLite's
scan choice — and on a six-vertex fixture that choice is reliably the flattering one, which is why
this class of defect cannot be found by reading or by any assertion in the ladder.

It is an **instrument, not a gate** (the `orphans` standing) and is absent from `ci`, because it is
still red. At first run: 20 failures, **13 of them L3 conformance scenarios** — ~0.8% of the
conformance floor passing by luck, all one defect (`order().fold()`). Three rounds of fixes have
taken the corpus view — the perturbed CENSUS, which names every order-fragile traversal in one place
and is both the best worklist and the only fixed denominator — from 41 to 8. **The suite total is 10**
(measured 2026-08-09; it was 4 on 2026-08-03 and the number DRIFTS, so re-measure rather than trusting
this line): the census's own answer-change gate, a `group().by(T.id)` keying, two child-scope
per-origin reducer assertions, and six that arrived since — four L2 SQL assertions (`select()` at
every arity, `valueMap()`'s map loop, `select(<key>)` over a map, the sack channel), a second sack
coexistence assertion and the element-fold byte differential. A failure here is a real under-specification, never a
flake — the remainder are item 20 in `docs/outstanding-work.md`, and this becomes a gate when they
are cleared. **Baseline it before blaming a diff**: re-run the instrument with the change set aside,
because a pre-existing failure here reads exactly like one the diff caused. It is an ENV switch (`MOGWAI_REVERSE_UNORDERED=1`, read in `src/bun/BunSqlite.ts`)
rather than a parameter precisely so the suite under test cannot know it is being perturbed.

Related: an `ordered` L4 assertion is only worth writing if it survives this. Check before adding one.

## Guardrails

- **Everything tracks tinkerpop `origin/master` — the version split is GONE** (2026-07-26). The
  submodule, the L3 corpus, and the CLIENT itself are all master; `gremlin` resolves to the
  submodule because **package.json declares it as `link:gremlin`**, against the link
  `scripts/init-submodule.sh` registers after building the client — the server must frame with the
  same client the suite tests it against. npm's newest v4 is still 4.0.0-beta.2, ~300 commits behind
  and without the `gremlin/io` export, and it is now UNREACHABLE: a `bun install` with no registered
  link fails rather than falling back to it. That is why `[tasks.install]` depends on `submodule`,
  and why no task is submodule-free any more — the previous npm-dep-plus-relink arrangement let a
  bare `bun install` swap the client out from under whatever ran next.
  The old rule here said "pinning L3 to master breaks it for zero gain" — **measured, and it is
  false**: master is L3 1363/2297 vs beta.2's 1347/2041 (+16 passing, +256 scenarios in scope).
  What master actually needs is two runner details, each of which fails SILENTLY: cucumber 13
  wants a **glob** for features and for `import` step definitions (a bare directory matches
  zero and reads as a total failure), and Bun's built-in `undici` shim lacks
  `Agent.close()`/`destroy()` so every client teardown throws (`test/support/undici-shim.ts`).
- **L3 runs cucumber IN THIS PROCESS and the client talks to a `fetch` HANDLER, not a socket** —
  `test/support/cucumber.ts` (cucumber's programmatic api) + `test/support/in-memory-transport.ts`
  (upstream's own swappable `httpFetch` holder). No port, no server, no child process, and the
  ephemeral-range port collision that took the suite red locally and in CI is gone by construction.
  Two rules that follow:
  - **the cucumber api MUST come from the submodule's copy.** Its support-code registry is
    per-instance, and upstream's step files import the bare specifier, so a copy of ours would read a
    different registry and every step would report `undefined`.
  - **`glv-compat.ts` is loaded by a path RELATIVE to cucumber's cwd.** An absolute path is accepted
    and then silently not loaded, which costs exactly the 10 BIGINT/BIGDECIMAL scenarios.
  `transport.assertUsed()` fails closed if the swap ever misses, because otherwise a miss reads as a
  broken server rather than a broken harness. `conformance.test.ts` keeps a REAL socket on an
  ephemeral port on purpose — it is the one place the TCP path is under test.
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
