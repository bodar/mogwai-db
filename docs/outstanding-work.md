# Outstanding work

The de-duplicated index of open work across the `docs/` corpus. **Each line sets the scene — what,
why, where to start — not a spec.** The linked doc holds the rationale; the picking agent does the
detailed validation and design. Live per-step capability: `feature-support-matrix.md`.

**Refreshed** 2026-07-31 (channel-preservation Phase 1 closed; item 18 deleted, its two deliberate
non-goals moved to won't-do). Conformance figures below are from the 2026-07-30 sweep against L3
**1598 / 2267** — Phase 1 was a substrate tranche and moved no scenario. The denominator moved twice
on 2026-07-30, both
times to drop scenarios the harness cannot adjudicate rather than gaps of ours — see `tags.ts`,
which now names which of three KINDS each exclusion is, and `runner-skips.test.ts`, which fails if
the vendored runner's own skip set ever diverges from it. Item
numbers are stable IDs — landed items are deleted and their numbers are not reused, because code
comments and other docs cite them.

**The five committed test baselines are inputs to this index, not just gates.** `l3-state.json`
(the ratchet floor), `census/{goldens,deferrals}.tsv` (the two-way behavioural baseline — **0
`crashed` rows** as of `cdaa7b9`, down from 17; the antlr4ng patch of item 0f cleared every one, and
item 0c with them), and the two hand-curated L5 ratchets — `L5-properties/known.ts` and
`capability-baseline.ts`, plus the `knownBroken` entries inside `laws.ts`. A defect parked in any of
them must ALSO appear here; a ratchet entry is tracked, not defended. **L5 derives its ordinary
generated-input seed from `HEAD` and prints the `L5_SEED=<n>` reproduction command**, so each commit
gets new coverage while CI and a local checkout execute the same corpus.

> **Verify an item's premise against the code before picking it — this index has been stale in BOTH
> directions.** The cheapest check is usually a 10-line probe that compiles the traversals the item
> claims are broken and greps the emitted SQL. When an item turns out to be partly landed, rewrite
> the line rather than closing it silently.

**Ordering — floor vs ceiling.** L3 is the floor (scenarios that pass); the ceiling is generic
lowering that composes the full nested grammar at any depth/combination (see
`src/compiler/steps/CLAUDE.md`). P1 raises the ceiling — each item unblocks a *family*; one-off step
impls are matrix-fill, lower. Impact: **High** (correctness / whole-family unblock) · **Medium**
(real feature bucket) · **Low** (narrow, fail-closed, or debt).

---

## P1 — ceiling-raising generic-substrate lifts

0b. **Apply-contract consumers.** `ModulationContract` (`'produce' | 'apply' | 'presence'`) is
   available in `steps/tail/child.ts`; the imperative write path has the analogous
   `ElementReadDriver`, which re-enters the ordinary read compiler with the exact incoming
   element + carried aliases. It now covers `Parameters.java:125,177,178` for nested property
   keys/values, merge-map keys/values, and `AddVertexStep` labels/parameters — including
   `g.V().as('a').out().addV(__.select('a').label()).property(k, __.select('a')…)` and the
   source `constant(...).concat(__.V(...).label())` form. The remaining consumers are
   `ListFunction`/`ConjoinStep`, plus whole-map `MergeStep`/`MergeElementStep`/`MergeEdgeStep`
   bodies (which need a map-shaped, not scalar, driver). *Medium-High — extend the declared
   contract rather than another argument evaluator.*
   The re-sourced scalar child route now owns its own per-origin ordering and first-row
   cardinality, so `g.inject('hello','hi').concat(__.V().order().by('name').values('name'))`
   executes rather than receiving a concat-specific exception.

0e. **Nothing detects a stale `parser/`.** A byte-compare against a fresh generation is the obvious
   check, but note the ref mismatch it would have to resolve — the generate script sources
   `origin/master` (a moving ref) while the submodule pins a gitlink, so a naive comparison against
   the pinned checkout's output is only accidentally green today (the two grammars are currently
   identical). *Medium — measurement integrity.*
   Note this is now a hygiene item only. It was previously written up as the diagnosis of the
   L5-random parser-integrity failure; that diagnosis was **wrong** and the item no longer carries
   it (see 0f).

0f. **We carry a patch against antlr4ng's prediction DFA; it must go upstream.** The L5-random
   parser-integrity failure at high nesting depth has its real root cause: antlr4ng indexes a
   decision's DFA states in `Map<number, DFAState>` keyed on `ATNConfigSet.hashCode()` and never
   consults `ATNConfigSet.equals()` (`DFA.getState`/`addState`). A 32-bit hash is not injective, so
   two structurally different configuration sets are conflated — the simulator gets a state for a
   decision it did not ask about and reports "no viable alternative" on input that parses fine
   alone. Whichever query populates the bucket first wins, permanently, which is why the failure is
   order-dependent, sticky and symmetric. Java's table is `HashMap<DFAState, DFAState>` and resolves
   collisions by equality, so the reference runtime does not reproduce it.
   Evidence, since the earlier stale-`parser/` story was plausible and wrong: it reproduces on a
   freshly generated parser, identically on upstream gremlin-js's own generated parser, and not at
   all on the reference Java runtime given the same `Gremlin.g4`; disabling the hash-keyed lookup
   cures it; the L1 corpus alone collides **19** times and the fix moved **18** corpus traversals
   from failing to executing (banked in the census baseline).
   Fixed here by `patches/antlr4ng@3.0.16.patch` (`bun patch`), which restores the reference
   semantics: bucket per hash, disambiguate with `DFAState.equals`. Cost is ~1.0 → ~1.1 ms/query on
   the L1 corpus; the rejected alternative, `clearDFA()` per parse, was ~20x. Still open: the fix is
   **not upstream** — it is unchanged on antlr4ng `main` and still 3.0.16 on npm, so every antlr4ng
   consumer has it, and any version bump here silently drops our patch (guarded by
   `test/L1-corpus/parser-state.test.ts`, which asserts the mechanism, not just the symptom). The
   upstream-facing change is committed at `patches/upstream/antlr4ng-dfa-state-hash-collision.patch`
   — the `src/dfa/DFA.ts` fix plus a `tests/bugs/` vitest spec, applying to antlr4ng `main`.
   **That PR is now OPEN: [mike-lischke/antlr4ng#109](https://github.com/mike-lischke/antlr4ng/pull/109)**
   ("Resolve hash collisions in the DFA state table", opened 2026-07-30, full CI-equivalent run green
   at 560 passed / 4 skipped). There was no upstream issue; the nearest is #50, the other symptom of
   the same `addState` early return.
   **What is left is not ours to do — the item stays open only as a watch:** until #109 merges and
   ships in a release, keep `patches/antlr4ng@3.0.16.patch` and the `overrides.antlr4ng` pin, because
   a version bump silently drops the local patch. When it does ship, the close-out is: bump, drop the
   local patch, keep `test/L1-corpus/parser-state.test.ts` (it asserts the mechanism, so it guards the
   upstream fix just as well), and delete this item.
   *High while it lasts — we are carrying someone else's correctness bug as a local patch.*

1. **List members frame as bare values, not elements.** `AliasEntry` does not record the member
   shape, so a path/element-list label cannot frame its members as vertices. Blocks
   `g_V_hasXperson_name_markoX_path_asXaX_unionXidentity_identityX_selectXaX_unfold` (which also
   needs `union()` over a path value). *Low-Med.*

2. **Universal child-seam acceptance.** Element, scalar, list, count, branch, `repeat`,
   `as()`/`select(label)` and option-map bodies now compose at every position. Still throwing or
   wrong:
   - child bodies producing **map/group/record** shapes → item 5.
   - `group().by(project(...))` composite keys; non-scalar/non-count nested-group inner keys.
   - **a child-in-child body whose inner child is not element-shaped** —
     `local(__.local(__.out().values('n')))`, `map(__.out().map(…))`. `local` sits in the element-row
     suffix vocabulary but emit recurses into an *element* child for it, so classify must ask the
     same question. Defers rather than crashing today. Orthogonal to labels (reproduces with none).
   - **a label REBOUND inside a `filter()` body** over an outer label of the same name drops rows
     TinkerPop keeps: `g.V().as("a").out().as("b").filter(__.as("a").out("knows")).count()` is 0 for
     us, 1 for TinkerPop. Consistent across both lowerings, so it is a child-seam rebind question,
     not a variable-location one. Pinned as an ON≡OFF equivalence in `branch.exec.test.ts`. *Low-Med.*
   - **`choose().option()` with only `Pick.none` written AND an unproductive choice — a real wrong
     answer.** The CASE's single ELSE claims the unproductive inputs; TinkerPop emits the ELEMENT
     (`Choose.feature g_V_chooseXageX_optionXbetweenX26_30X_nameX_optionXnone_nameX`). Making the
     CASE decline is correct and the arm merge answers it properly — measured **+1/−1**, the loss
     being a `groupCount` over the resulting `VariantStream`. **So it is gated on group/groupCount
     over a VariantStream, not on the option map.** `Pick.any` needs `branch()` (unimplemented).

   Start: `steps/tail/{child-shape,child,scalar-arm}.ts`. Two invariants to preserve: the ONE arm
   triage is `classifyBranchArms` (`child-shape.ts`) with exactly two documented exceptions
   (`scalarArmShape`, the option-map triage); a renderer that cannot carry alias columns must
   DECLINE, not answer. **High.**
   → [carried-schema-and-projection-reentry](./2026-07-14-carried-schema-and-projection-reentry-plan.md),
   [group-value-generic-seam](./2026-07-18-group-value-generic-seam-plan.md)

3. **`repeat()` residuals.** A walk carries loop-invariant alias + origin columns, and its body
   compiles once through the ordinary StepFns into a `(from_id, to_id)` relation the recursive term
   joins — now the extracted **keyed child relation** (`steps/tail/keyed.ts`, shared with
   `until()`/`emit()`); `expandRepeatBody` is now a fast path, not the vocabulary.
   **The trap, pinned by a test:** the gate is NOT "whatever `lowerElementSteps` accepts". A
   per-iteration GLOBAL barrier (`dedup`/`order`/`limit`/`range`/`sample`/`tail`/`group`/`aggregate`/
   `local`) observes the whole frontier at one iteration; the generic StepFns would lower it
   per-origin and silently answer a different question. The gate is the row-local vocabulary
   (`isElementChildStep`).
   - **A barrier body under a fixed `times(n)`** could be UNROLLED into n generic phases (that route
     hosts barriers; `bulk.ts` already unrolls a specialized version for the count case). The natural
     next slice. **Measured as the single biggest L3 mechanism: 41 failing queries** — by barrier
     step: `order` 15, `limit` 7, `local` 5, `dedup` 4, `range` 4, `groupCount` 3, `sample` 2,
     `group` 1. A further 8 fail the adjacent "body must be row-local" gate. **Re-measured 2026-07-30
     and every number is unchanged from the 2026-07-29 telemetry** — nothing since has eroded it, so
     the unroll is still the highest-count generic lift the telemetry names, and `order` alone is over
     a third of it. *Medium.*
   - **The named-loop form `repeat("a", …)`/`loops("a")` cleanly defers.** Its front-end
     representation has the ordinary body channel plus explicit loop-name metadata; support still
     needs named loop counters rather than the anonymous recursive depth column. *Low-Med.*
   - A label bound INSIDE the body (`repeat(__.out().as("b"))`) genuinely rebinds per iteration, so
     it is a fold, not a projection — `as` stays out of the body vocabulary (fails closed). *Low-Med.*
   - `path()`/`simplePath()` + `sack()` bodies stay with the flat expansion (both are per-iteration
     state) — P3 recursive-path tails.
   → [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md) #1,
   [deep-seam-migration-roadmap](./2026-07-18-deep-seam-migration-roadmap.md) #5,
   [path-history-substrate](./2026-07-18-path-history-substrate.md),
   [foldable-carried-column](./2026-07-24-foldable-carried-column-plan.md)

4. **Canonical-emission-order Stage C — residual only.** A bare re-source `V()`/`E()` arm carries no
   `encounter`, so the take-first guards that depend on one still fail closed: `armFansOut`
   (`steps/tail/scalar-arm.ts`) and `positionArmFansOut` (`steps/tail/path.ts`). Minting
   `encounter = new element id` at a re-source is the one missing primitive. `repeat()`/`match()`
   stay deliberately outside (a recursive CTE can't window across iterations — `analyze.ts` returns
   `demandsEncounter: false` by design). There is ONE slot, `TraverserLayout.encounter`; do not re-derive a
   "two encounters" reconciliation. **Low-Med.**
   → [canonical-emission-order](./2026-07-19-canonical-emission-order.md)

4d. **`within()`/`without()` folded-traversal residuals.** Open:
   - a UNION-rooted operand (`within(__.union(__.V(1)…, __.V(4)…).fold())`, ~4 queries). Widening the
     rooted test to admit a union whose arms are all rooted was tried and **REVERTED**: it compiles
     but returns unfiltered rows, so something in the source-union fold's shape does not reach the
     list operand intact — diagnose that before re-widening. A `constant()` arm is additionally not
     seedable as a source-union arm (`unsupported source step: constant`). *Low-Med.*
   - a CORRELATED list operand (members varying per traverser), which the standalone sub-read cannot
     express by construction.
   - **Scoping trap worth keeping:** `json_each` exposes a column named `value` and `hasProp` passes
     the UNQUALIFIED `value` of `vertex_properties` — rendered as `EXISTS (… WHERE je.value = value)`
     both sides bind to json_each, so `within` silently returns everything. Keeping the operand on
     the LEFT of `IN (SELECT …)` evaluates it in the outer scope.

5. **Non-element child bodies.** The seam is shape-agnostic (`applyChildCardinality` +
   `classifyProjectionChildRows`); map and record bodies compile. **Two premises that were FALSE — do
   not rebuild on them:** the element terminal does not need a relational form (`local(__.out())`
   already worked), and `project`/`group`/`path` already HAVE relational forms — they were blocked
   only on having no child PROVIDER, so no tail-boundary rewrite is needed. Still open:
   - **A GROUP child body.** Design is settled: the wire frames `group` as ONE Map from all rows, so
     a scoped group must emit one map PER PARENT — a `MapStream`, which the seam now supports.
     Threading an ORIGIN dimension through `lowerGroup`/`GroupSource` means a per-origin analogue for
     each of its 6+ value modes (`valFold`, `valElement`, `valNestedMap`, `valReducer`, composite
     keys). Demand is near-zero (2 corpus traversals, both group-at-root with a group-shaped KEY), so
     build it when a scenario asks and start with the cheap half: a bare `groupCount()` child body has
     exactly ONE value mode. Only the SCALAR-key half is framable — `frameTypedNode` has no element
     case, so an element-keyed map blob cannot be framed (the standing `materializeMapRoot`
     deferral). *Low-Med.*
   - **A PATH child body** (`local(__.path())`) — needs path tracking INSIDE a child scope, which is
     path-history-substrate territory, not this seam's. *Low-Med.*
   - **`valueMap(true)`/`elementMap` as a child body** — fails closed; zero corpus traversals use
     either as a child body. If one appears, carry the terminal path's `{kind:'valueMap', keys,
     tokens}` flag on `MapStream` — mechanical. Token-ness is SHAPE metadata; a T token is not a
     property value, so do NOT put it in the `{t,v}` tree (`gremlin/types.ts` excludes element/token
     codes deliberately). *Low.*
   - **`ChildShape` is deliberately NOT widened to 'map'.** It is `BranchArmShape` minus null, so
     admitting 'map' would tell the branch triage a map ARM is mergeable when no merge covers a map
     shape — converting a clean deferral into a wrong answer. A map ARM stays unclassifiable.

   **Group failure taxonomy, measured 2026-07-27** (128 corpus traversals mention group; 88 compile).
   Recorded because the label "group" hides unrelated causes — most are NOT group-seam work: 4 =
   `group()`/`groupCount()` over a SCALAR parent (item 5c); 3 = a side-effecting `groupCount("a")` in
   a child scope (P3's `sideEffect`); 3 = a barrier `groupCount` inside a `repeat()` body (item 3's
   unroll); 2 = `group().by(traversal)` needing `fold()`/`sideEffect()` in the key body (item 2);
   ~2 = a bare `groupCount()` child body (above); remainder = a nested group inside a value body,
   `sample()`, one-offs.
   → [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md),
   [carried-schema-and-projection-reentry](./2026-07-14-carried-schema-and-projection-reentry-plan.md)

5c. **PARENT-SHAPE uniformity — the same step works over an element stream but not over a
   scalar/list/path/map one.** The largest remaining ceiling gap by breadth: **67 corpus traversals
   across ~35 steps** (measured 2026-07-27), in five families — `X after a scalar stream` (22, 13
   steps), `X on a list value` (18, 13 steps), `X cannot consume the <MAP> result shape` (14),
   `X on a path value` (7), `Scope.local needs a list producer` (6).

   **It is NOT one substrate fix** — verified by probe, some steps already compose over a scalar
   parent (`groupCount`, `choose`, `coalesce`, `math`) while others do not (`group`, `none`,
   `repeat`, `order().by(traversal)`), so it is per-step dispatch, ~2-3 scenarios each. **Do NOT
   treat the 67 as one item to "fix" — that is floor-chasing.** The honest unit of work is one parent
   shape at a time; the scalar parent is biggest and has the most machinery (`SCALAR_DISPATCH`,
   `lowerScalarRows`, `scalar-arm.ts`). Where a step needs a genuinely different builder over a
   scalar parent (`group()` has no element to project and its default `elementList` value mode does
   not apply) that is real work, not a gate.

   **The "one parent shape at a time" cut is challenged** by a fresh in-process measurement
   ([shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md) §7): 84
   parent-shape failures, not 67 (record/property/variant/map/group parents are the same disease and
   are missing from the tally, and 268 traversals never reached shape dispatch — so 84 is a lower
   bound). Sorted by MECHANISM rather than by parent shape they are ~10 set-drift, ~14
   `ResultStream` residue, ~30 ceiling cells of row-ops copied per shape, ~35 genuinely per-step —
   and the first three cut ACROSS parent shapes. Both cautions above stand (not one substrate fix;
   not one item); the axis does not. Re-file before picking this up.

   **The ~30 row-op cells are now their own item — take item 17 FIRST.** The 2026-07-29 audit measured
   the (shape × row-op) matrix at 55/100 gaps and confirmed `RelationalCardinality` is the named axis
   that makes sharing safe, so that slice is no longer "per-step dispatch" work at all. What is left
   here after item 17 is the ~35 genuinely per-step cases plus the `ResultStream` residue (below).
   → [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md),
   [shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md)

6. **`order().by()` of paths (path natural-order comparability).** Unlocks the Orderability
   conformance cluster. **Medium.**
   → [path-history-substrate](./2026-07-18-path-history-substrate.md)

17. **Share the row-ops — LANDED for the slice/dedup family (`2d7a3f2`, `8bbd3e3`).** The three
   near-verbatim slice builders are one implementation, `reprojectRows` (`tail/barrier.ts`, beside
   `lowerGlobalCount`), and `globalRowOps()` registers limit/skip/range/dedup as dispatch entries so
   each shape takes them with a spread. **Measured over five ops × ten producers: 17/50 gaps →
   4/50**, the survivors being `group`, which declines because `cardinalityOf` reports `wholeResult`.
   New coverage: whole-list slices + dedup on LIST, the full set + count on MAP.ENTRY (was 0/10),
   the slices on PROPERTY, `dedup` on RECORD. Pinned in
   `test/compiler/unified-lowering.exec.test.ts`.
   - **The trap, and it cost 42 corpus traversals — read this before registering anything else into
     a shape table.** `dispatchShapeTail` consults exactly ONE handler per step name, and a shape
     table is a `new Map([...])` where the LAST duplicate key wins. So spreading a shared op into a
     table that ALREADY owns that name REPLACES the incumbent, and a handler that "declines"
     (`return null`) to defer to it instead falls to the FALLBACK THROW. Declining does not fall
     through to a previous registration. Compose with `firstOf` (`tail/barrier.ts`). Two second-order
     lessons: only the CENSUS caught it (the probe measuring the gains tested the global forms and
     was structurally blind to the `Scope.local` ones), and a test written FROM that post-change
     probe asserted the regression as if it were intent — verified against clean trunk afterwards to
     establish it was not.
   - **`Scope.local` is deliberately outside the shared ops** — a local slice addresses a shape's
     MEMBERS, a different question from slicing rows, so each shape keeps its own member builder.
   - Still hand-written per shape and NOT yet shared: `order` (needs a per-shape comparable key, so
     it is not a row-algebraic op), `tail`, and the `mapEntry`/`map` reducers. `order` is the
     valuable one and is genuinely a different problem — do not assume this pattern extends to it.
   **Remaining from the original item:** the ~35 genuinely per-step cases of 5c, and the
   `ResultStream` residue. What follows is the original framing, kept for the 5c cross-reference.

   Measured 2026-07-29. `count()` is the only row-op routed through a shared implementation
   (`lowerGlobalCount`, `barrier.ts`, reading `cardinalityOf`) and it is 9/10; every other op is
   hand-written per shape or absent. `mapEntry` is 0/10. Three near-verbatim slice builders already
   exist — `rowPreserving` (`tail/scalar.ts`), `reselect` (`tail/variant.ts`), `recordSlice`'s global
   branch (`tail/select.ts`) — differing only in the payload column list, which `streamPayloadCols`
   already owns. **This is item 5c re-sorted by MECHANISM** (~30 of its 84 parent-shape failures are
   these copied row-ops), and it cuts ACROSS parent shapes, so it does four unrelated jobs at once
   instead of one shape at a time.
   - ~~**The precondition**~~ — **DONE `f3c4606`.** All eleven shape arms now dispatch through a
     `dispatchShapeTail` Map, so the lift is "add 11 Map entries" rather than "edit 11 sites". The
     precondition's claim was verified before starting and was exactly accurate. Two things
     deliberately stayed OUT of the tables and a row-op registration must not disturb them:
     `compileFromGroup`'s `is()` THROWS rather than declining (a non-MAP `typeOf` over a group is
     not a narrower version of the same question), and `compileFromPath`'s `PATH_LIST_OPS` retype
     stays in the FALLBACK, because registering it per name would duplicate that membership set as
     a second list.
   - **Why it is architectural, not just mechanical:** `cardinalityOf` (`context/stream.ts`) was named
     and has exactly ONE consumer. Spreading row-ops without routing them through it produces
     WRONG ANSWERS, not free coverage — a grouped `PathStream` has one row per *position*. The
     criterion to copy is `applyChildCardinality`, which generalised precisely because it never needs
     an expression denoting the traverser's value.
   - **Precedent, done small (2026-07-30):** the ELEMENT PAYLOAD tuple (`id/label[/src/tgt]/props`)
     was the same pathology one layer down — hand-written at fourteen sites, already drifted at two
     of them, and multi-label had to be threaded through every one. It is now `elementPayload` /
     `elementPayloadObject` (`plan.ts`), derived from a `ScalarCtx` so the correlated positions
     share it with the direct ones. Two things that transfer: the NAME authority already existed
     (`elemColumns`/`recordFieldColumns`/`pathColumns`) and only the EXPRESSION side was missing,
     and it needed none of the `dispatchShapeTail` precondition below — worth checking whether some
     of the row-ops are the same shape of unlock.
   This is the work [shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md) §8
   step 4 sanctions ("name the cardinality axis, **then** share row-ops") — and that sequencing was
   right: `cardinalityOf` now has a real second consumer, and it is what keeps `group` and a grouped
   `PathStream` out of a row slice. **Was High; now Low-Med** — the slice/dedup family is done, and
   what is left (`order` per shape, the 5c per-step residue) is not this mechanism.
   → [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md)

---

## P2 — feature / conformance buckets

7. **`match()` generic patterns.** End variables can hold an
   element, an edge, or a scalar, and a reducer pattern binds per binding. What remains is
   STRUCTURAL rather than shape: a pattern not starting with `as()` (6), 0-root-variable patterns
   (3), `or`/`not`/nested-match patterns, a LIST-shaped end var (`fold()`), and `where(var,P)` on a
   scalar-bound var — the last only became REACHABLE once scalar vars could be bound, and it is a
   downstream alias-compare gap, not a match one. **Medium.**
   → [conformance-structural-bets](./2026-07-12-conformance-structural-bets.md)

7b. ~~**`g.match("MATCH (a:person)-[:knows]->(b:person)")` — the GQL pattern-STRING form.**~~
   **LANDED 2026-07-30. `MatchString.feature` 0/25 → 25/25; L3 1598 → 1623 (+25, −0).** Three pieces:
   a second generated parser (`parser/gql/`, from upstream's `GQL.g4` — so locked decision #2 never
   needed relitigating), a front-end translator (`src/gremlin/gql.ts`, where `math.ts` sits), and one
   `extract`-category Pass. The compiler needed **no** lowering change, as predicted.
   What it needed instead was a dependency nobody had filed: `select(label).by(key)` was declined at
   every CHILD position while composing fine in the main chain. Closing that took three commits and
   fixed a live silent wrong answer on the way (a `by()` dropped over a value-shaped parent). The
   diagnosis was wrong FOUR times in sequence — silent drop → dropped modulator → wrong-kind emit →
   an incidental `ElementStream` signature — which is the most reusable thing in the design doc.
   Residuals, all fail-closed: an undirected edge carrying a VARIABLE; a terminal pattern declaring
   no variables; `__.match("…")` in a nested position.
   → [match-string-frontend-design](./2026-07-28-match-string-frontend-design.md)


7c. **Predicate operands that are TRAVERSALS — narrow tails only.** The four shapes (constant,
   re-sourced, mutating-rejected, correlated) lower. Left:
   - **`within`/`without` over a MULTI-VALUE operand** — not the cheap wiring it looks like:
     `predicateSql` renders each operand as ONE element of a comma list, so a SET-valued operand
     cannot be substituted as an Expression. It needs `expr IN (SELECT …)` /
     `IN (SELECT value FROM json_each(<list>))`, i.e. a scalar-vs-set distinction in the pure SQL
     layer — a new concept there, not a new caller.
   - widening `isReSourced` (`steps/tail/operand.ts`), a narrow proxy for "traverser-independent"
     that tests for a `V`/`E` head and so misses a union of independent branches.
   - the `none()` host; an operand with no scalar to read (a filter body such as
     `__.not(__.identity())`); a scalar-parent `is()` (correlation needs an element ScalarCtx).
   *Low.*

7e. **Correlated predicate fast path — LANDED; one hand-rolled aggregate left.** Verified 2026-07-30,
   and the index was stale in the "still open" direction: the plan's end state is essentially built.
   The predicate compiler now lives in `steps/prefix/predicate.ts` (not `plan.ts`), `incidentExists`
   is **deleted**, and `correlatedExists`/`correlatedReduce` are thin wrappers that compile the body
   through `compileCorrelatedChild` (`steps/tail/correlated.ts`) — the real movement/filter StepFns
   rendered in inline-correlated mode. So the "second movement implementation" premise is now FALSE;
   `predicate.ts`'s own header asserts it, and `until()` routes through the same call (it correlates
   on the recursive-walk row, the one consumer with no materialized fallback).
   The residue, and it is the doc's own open CHECK: **`correlatedReduce`'s E-form aggregate still
   hand-writes an `edgeProperties` join** (`…outE().values(k).<sum|min|max|mean>()` inside
   `where`/`is` — `predicate.ts` ~line 90). Its COUNT sibling already goes through the child; only the
   aggregate does not. Before touching it, grep tests + corpus for that shape and decide whether to
   extend it or let it fail closed — "do NOT silently regress a working shape". Bare `out()`/`in()`
   deliberately stays out (the value would come from the neighbour vertex, a different join).
   *Low — a narrow residue, no longer a cross-layer refactor.*
   → [correlated-child-rendering](./2026-07-17-correlated-child-rendering-plan.md) (its landmark
   paths predate the 2026-07-23 restructure and the 2026-07-29 rename; read it through the rename map
   in [tinkerpop-core-engine-alignment](./2026-07-29-tinkerpop-core-engine-alignment.md))

8. **Graph-algorithms layer (new cluster).** Algorithms as `call()` services + OLAP step names
   (`pageRank`/`connectedComponent`/`peerPressure`/`shortestPath`) as desugar Passes. Nothing built;
   PageRank is the proof-of-concept. Carries 6 open research questions. **Medium.**
   → [graph-algorithms](./2026-07-24-graph-algorithms-plan.md)

9. **Side-effect readback predicates — `where(within/without('x'))`.** The
   `aggregate().where(without('x'))` dedup idiom; no aggregate-readback exists yet. **Medium.**
   → [side-effect-state](./2026-07-13-side-effect-state-plan.md)

10. **`addV` mid-chain + read-tails-after-write.** Gates a write-conformance cluster (e.g.
    `property()` after `addV()`). **Medium.**
    → [compiler-consolidation](./2026-07-16-compiler-consolidation-plan.md) §6,
    [write-args-through-read-spine](./archive/2026-07-16-write-args-through-read-spine.md)

11. **Federation tail:** CF-parity test on the DO harness (Low-Med);
    map-valued injection for mid-traversal federation (Med); import-a-graph (Med/Large);
    federated *traversal* via local scratch (Large); async failure/timeout/retry policy (Low-Med).
    → [call-service-registry](./archive/2026-07-20-call-service-registry-plan.md)

12. **Strategy completion tails** — `SubgraphStrategy(vertexProperties)`, `PartitionStrategy`
    meta-properties + partition-aware upsert (`mergeV`/`mergeE`), nested-body descent. **Medium/Low.**
    → [with-strategies-exploration](./2026-07-13-with-strategies-exploration.md)

13. **`with(...)` / `OptionsStrategy` sugar — remaining hosts.** SELECTIVE token subsets
    `with(tokens, ids|labels)` (a proper subset paired with `by(unfold)` that also flattens the value
    lists — no `valueMap(true)` equivalent; fails closed today), `index().with(WithOptions.indexer,
    WithOptions.map)` (needs item 14), and any other `with()`/OptionsStrategy host. **Low-Medium.**
    → [with-strategies-exploration](./2026-07-13-with-strategies-exploration.md) §0

14. **`index()` step** — unimplemented (`index() on a list value not yet supported`). The default
    (list) indexer turns `[e0,e1,…]` into `[[e0,0],[e1,1],…]`; the `with(WithOptions.indexer, map)`
    variant produces a Map (needs item 13's `with` selector). **Low-Medium.**
    → [seam-reuse-audit](./2026-07-13-seam-reuse-audit.md)

15. **Multi-key `cap('x','y')` + cap-of-group unfold.** **Low-Medium.**
    → [side-effect-state](./2026-07-13-side-effect-state-plan.md)

16. **W4 — multi/meta-property schema rework → `Cardinality.list/set` writes.** Only meta-property
    *typing* is touched today (P3), not the list/set write cluster. **Medium.**
    → [conformance-structural-bets](./2026-07-12-conformance-structural-bets.md) (W4)

19. **Multi-label vertices — LANDED except two narrow tails.** L3 1529 → 1598 across phases A–E
    (`cbaab02`…`7f61f05`); **60 of the 67 in-scope `@MultiLabel` scenarios pass**. Storage, steps,
    predicates, writes, the harness and the map-shape regimes are all in — design of record:
    [multi-label-elements](./2026-07-30-multi-label-elements-plan.md). What is left:
    - ~~A VERTEX ELEMENT on the wire reports ONE label~~ — **LANDED**, with the payload authority
      it needed. The estimate was right that the vertex `label` COLUMN was a scalar pick, and wrong
      about the fix being regime-aware: GraphBinary's `{label}` field IS a list and the client reads
      all of it, so a vertex element carries the whole set UNCONDITIONALLY —
      `with("singlelabel")` governs elementMap()/valueMap() rendering, not the element. What the
      count missed is that the payload tuple was hand-written at **fourteen** sites, and they had
      already drifted (two emitted an edge's endpoints as internal rowids). So the tuple is now ONE
      builder, `elementPayload`/`elementPayloadObject` (`plan.ts`), beside a new fourth position in
      the label seam (PAYLOAD, next to SCALAR/PREDICATE/FAN-OUT). Federation carries both forms
      (`flabel` the scalar the rejoin matches on, `flabels` the payload). **The corpus cannot
      express this assertion** — Gherkin's `v[tux]` compares by id, which is why no scenario caught
      it — so it is pinned by `test/multilabel-wire.test.ts`, which decodes with the client's own
      reader; recorded as a third symptom in the 19b write-up.
    - **`labels()` as a CHILD BODY** — `group().by(__.labels().order().fold())`,
      `order().by(labels()…)`, `dedup().by(labels()…)` (3 scenarios). Not label work: it is the
      ordinary child seam (item 2) meeting a fan-out body.
    - `elementMap()` on EDGES (3 scenarios) is a pre-existing gap unrelated to labels — it needs
      the IN/OUT direction tokens (`tail/projection.ts`).

19b. **No provider can declare a multi-label DEFAULT, so `@MultiLabelDefault` is untestable for
    everyone — a real upstream gap and a good fork contribution.** All three GLVs skip its 10
    scenarios (gremlin-js `Before(… () => 'skipped')`, gremlin-go `~@MultiLabelDefault`,
    gremlin-python `context.ignore`), and gremlin-go says why: *"The GLV suite does not test against
    a graph that defaults to multi-label output."*
    **Verified in `gremlin-core`, and it is not a harness stub** (this index said "a stub, four
    lines" and then "a test-server config gap"; both were wrong).
    `TraversalHelper.isMultilabelEnabled` reads the source-level `with()` option and nothing else —
    `.orElse(false)` — so the reference default is ALWAYS single-label whatever a graph's declared
    `LabelCardinality` is, and no knob exists. `tinkergraph-multilabel.properties` therefore gets a
    graph that STORES many labels and RENDERS one. `@MultiLabelDefault` describes a provider the
    reference cannot be configured into being; its `@SingleLabelDefault` twins are not skipped.
    **We are apparently that provider** — our `labelRegime` falls back to the declared cardinality,
    so we answer all 10 today and cannot be asked. That fallback is a deliberate divergence from the
    reference, recorded as such at `labelRegime` (`src/api.ts`).
    **A SECOND symptom makes the declaration unsatisfiable, not merely untestable.** Three scenarios
    carry NO label-default tag, use no `with()`, and assert a BARE string `T.label`:
    `g_VX1X_elementMap_orderXlocalX_byXkeys_{asc,desc}Xunfold` (`map/Order.feature`) and
    `g_V_hasXname_markoX_elementMap_mergeXV_hasXname_lopX_elementMapX` (`map/Merge.feature`).
    Untagged means every provider runs them, so a provider declaring a blanket multi-label default
    forfeits all three by construction, and their `@SingleLabelDefault` twins do not exist. **This is
    also why we do NOT declare a blanket multi-label default**: `labelRegime` derives it from the
    graph's cardinality, which satisfies those three AND the `@MultiLabelDefault` scenarios on
    multi-label graphs. The two that expect a set on the single-label MODERN graph are the ones we
    deliberately do not match — recorded in `test/L4-addendum/multilabel-default.feature`.
    The write-up (both symptoms, suggested shape, the smaller alternative, and the caveat that
    upstream might instead decide the scenarios should be deleted) is
    `docs/upstream-patches/03-multilabel-default-untestable.md`. Raise it as an ISSUE first — it is a
    `gremlin-core` API addition, not a patch. Precedent: `apache/tinkerpop#3511` came from here and
    merged. *Medium — 10 scenarios back for every provider, not just ours.*
    Meanwhile `tags.ts` scopes both label-default tags out and `runner-skips.test.ts` fails if the
    runner's skip set changes, so a fix upstream surfaces here instead of silently keeping scenarios
    out of scope.

---

## P3 — narrow / fail-closed matrix-fill (correct-by-design today)

Each fails closed (clear error, never mis-executes). Do only when a concrete scenario demands it.

- **`hasNot(key)` is not implemented** — `step not implemented: hasNot()`. A one-step gap in a common
  vocabulary; `not(__.has(key))` is the equivalent and is verified to give the same rows, which is
  also the route the MATCH-string desugar (7b) takes for GQL's `{k: null}`. *Low.*
- **`match()` cannot seed a CYCLE** — root detection is "a start var never used as an end", and a
  cyclic pattern has none, so `g.V().match(as('a').out().as('b'), as('b').out().as('a'))` reports an
  unbound start. Pre-binding the seed outside (`g.V().as('a').match(…)`) takes the supported
  ZERO-ROOT path and answers correctly, which is what 7b's desugar does uniformly — so this is only
  a gap for hand-written Gremlin. *Low.*
- **Recursive-path tails** — `cyclicPath`/`until`/`emit(pred)` with path, edge-inclusive bodies,
  mixed linear+repeat, recursive-regime `from()`/`to()`, multiple `by()`s (round-robin needs a known
  length; a recursive path's is dynamic). Also `order()` before a movement/branch while a path is
  live (a fresh emission encounter would collide with the path's positional ordering).
  · **A path-REGIME change inside a child body emits malformed SQL — the one fail-closed VIOLATION
    in this cluster, so take it first.** `g.V(1).simplePath().project('a').by(__.repeat(__.in('knows')).times(2))`
    → `near "FROM": syntax error`. The child's `repeat()` retypes the carried path from linear
    `cols` (p0, p1, …) to its own recursive `array` accumulator; the parent still DECLARES the
    position columns, and the cardinality rejoin projects the parent's declared schema off the
    CHILD relation, so `rel.c.p0` is `undefined` and splices an empty string —
    `c7(…, p0) as (SELECT …, b0.bulk, FROM c6 b0)`. **Do not "fix" it by declining at the repeat:
    measured, the same condition holds for `local(__.repeat(…))` and `where(__.repeat(…))` under a
    `simplePath()` and BOTH execute correctly today** (their rejoins do not project the parent's
    positions off the child), so a guard there regresses two working shapes. The fix is for a child
    body to restore the parent's path regime across the rejoin. Banked with the full diagnosis in
    `capability-baseline.ts`; found by the L5 capability ratchet after its HEAD-derived seed
    rotated, which is that design working as intended. *Med — a fail-closed violation.*
  *Low-Med.*
  → [path-history-substrate](./2026-07-18-path-history-substrate.md)
- **Group re-entry matrix-fill** — element/property-valued inner keys+values, composite `project()`
  keys, `elementMap()` followers, `keys→SET`, `as()`/`order()` on a group. `steps/tail/group.ts` is
  where the child seam most often bottoms out — extend it (item 2), don't dedup. *Low.*
  · **Productivity is not the aggregate.** An unreduced value traversal that yields nothing FILTERS
    the traverser (the key vanishes); `fold()` always yields, so its key survives with `[]`.
    TinkerPop pins both halves on one graph (`Group.feature`
    `g_V_hasXperson_name_withinXvadas_peterXX_group_by_byXout_foldX` vs its `…_byXout_orderX` twin).
    So "implicit-collect ≡ fold" is TRUE for the aggregate and FALSE for productivity.
  → [group-value-generic-seam](./2026-07-18-group-value-generic-seam-plan.md),
  [p3-reenterable-shapes](./archive/2026-07-16-p3-reenterable-shapes-plan.md)
- **Mixed-shape branch corners** — each is an independent wall, not a family: node+edge in one branch
  (the element lowerer's mixed-element-kind defer); `path()` through a mixed-shape branch (all four
  mixed-shape lowerers throw). *Low.*
  → [p4-dynamic-variant](./archive/2026-07-16-p4-dynamic-variant-plan.md)
- **Branch forms no merge covers** — a WRITE branch (`g.union(__.addV('person')…)`; the merges are
  read merges), and a branch whose shape is map/group/record/path. Throws naming the shape. *Low.*
- **A re-source `V()`/`E()` after `path()`/`sack()`/`otherV()`** — the carried fork through the CROSS
  JOIN is undefined. *Low.*
- **Write fail-closed walls** — `addE`/`mergeE` endpoint traversals past a movement/branch (need the
  bare rowid, not the framed external id), map-valued merge drivers, nested keys/values. *Low.*
  → [writes-through-read-spine](./archive/2026-07-17-writes-through-read-spine-plan.md)
- **`has(k, eq(collectionLiteral))` + meta-property typing** — two remaining typed-value tails. *Low.*
  → [full-fidelity-typed-collections](./archive/2026-07-17-full-fidelity-typed-collections-plan.md),
  [typed-merge-values](./archive/2026-07-17-typed-merge-values-plan.md)
- **`sideEffect(__.…)` + `withSideEffect(...)`** and **`branch()`** — distinct families, no consumer
  yet. *Low.*
  → [side-effect-state](./2026-07-13-side-effect-state-plan.md),
  [per-traverser-branching](./archive/2026-07-13-per-traverser-branching.md)
- **Foldable-sack residuals** — fan-out `by(__.trav)` in a repeat sack body, mutate `sack(op)` in a
  branch arm, `withSack()` at a `union()` source, mixed sack+element `until`/`emit`, sack over an
  edge-step repeat body, `sack(BiFunction)`/T-token/inject-const gaps. *Low.*
  → [foldable-carried-column](./2026-07-24-foldable-carried-column-plan.md)
- **`repeat`/`match` emission order** — recursive-CTE can't window across iterations. *Low.*
  → [canonical-emission-order](./2026-07-19-canonical-emission-order.md)
- **L3 ratchet hygiene — REWRITTEN 2026-07-30, and its original instruction was wrong on both
  halves.** It said "descope OLAP/GraphComputer + `io` source in `tags.ts`". GraphComputer is
  already descoped, and descoping it *permanently* is the wrong instinct — 4 of its 6 scenarios are
  the OLAP step names P2·8 plans to serve, so that exclusion should NARROW when item 8 lands, not
  harden. The `io` SOURCE (`io(...).read()`, 6 scenarios, in scope and failing) we actively WANT:
  loading a GraphSON/kryo file into a graph is a real capability, unlike `io().write()`, which needs
  a filesystem a Durable Object does not have. **Do not descope either.** `tags.ts` now states which
  of its three exclusion KINDS each tag belongs to, and `runner-skips.test.ts` gates the one kind
  that depends on someone else's code. *Low — the remaining hygiene is keeping those three kinds
  honest.*

---

## Product / operations (not compiler features)

- **Real Cloudflare deploy** (only `--dry-run` wired; code is CF-ready). *Medium.*
- **Bearer-token auth per graph** (no auth surface yet). *Medium.*
- **Untyped GraphSON v4 response encoder** — makes the shipped `/docs` panel usable; ~½–1 day.
  *Medium.* → [graphson-untyped-scope](./2026-07-13-graphson-untyped-scope.md)
- **Multi-request `g.tx()` session state** (needs DO session state). *Low-Med.*
- **Per-request implicit transaction** (likely moot — DO single-threading). *Low.*
- **Typed GraphSON (`types=true`)** — gated on a type-faithful JSON consumer. *Low.*

All → [phased-roadmap](./2026-07-11-phased-roadmap-plan.md) unless noted.

---

## Internal debt / give-backs (Low)

- **LSP refactoring tooling — four scripts landed (`8c33450`), four items remain.**
  `docs/2026-07-30-lsp-tooling-plan.md` is the continuation plan, written against that commit with
  every number measured. Highest value is wiring `scripts/arch-check.ts` into `ci` — it is written,
  run, and adversarially verified (it catches an injected `analyzeChain` call from a Pass, exit 1),
  so only the `mise` task remains. Also open: a `lint` task for the three unused-code tsconfig flags
  (46 real errors to clear first; generated `parser/` cannot be exempted at config level — the plan
  records all four mechanisms measured and the one untested option), plus a dead-export sweep and
  `moveToFile`.

**There is no TODO/FIXME/XXX/HACK anywhere in `src/compiler/`, `src/sql/` or `src/execute.ts`**
(verified 2026-07-29; the one repo-wide hit is `src/serializers.ts`, an upstream-TinkerPop note). Debt
here is encoded as typed `throw` deferrals and in-code prose, so grep for markers finds nothing and
proves nothing — read the deferral clusters instead.

- **`is(typeOf(GType.X))` is decoded independently at 5 sites** (`tail/{list,scalar,group,path}.ts`,
  `tail/projection.ts`) — each re-writes `pred.op === 'typeOf'` → `gtypeName` → uppercase-compare.
  **They disagree on the same input:** the `group` arm THROWS on a non-MAP typeOf where `path`
  correctly returns an empty relation. One pure classifier (`typeOfAssert`) beside `classifyBy`, then
  5 readers; no SQL moves. Prerequisite for registering `is` into item 17's tables.
- **`classifyBy` says "no host should re-scan byArgs inline" — 4 hosts still do**
  (`tail/list.ts:520`, `tail/select.ts:581`, `tail/group.ts:869,898`). Each hand-rolls
  `by.find(a => 'order' in a)?.order`, the exact scan the classifier retired, and each silently sorts
  by IDENTITY on an unrecognized arg. Was 5 — `tail/projection.ts`'s copy inside `MODIFIERS['order']`
  has since gone, so this is a shrinking list. `isOrderArg` is already imported at `list.ts`.
- **`NUMERIC_REDUCERS` re-declared despite `ir/step.ts` being the named base** (`tail/projection.ts`,
  and `BULK_REDUCERS` in `tail/bulk.ts`) — 8 consumers follow the "export BASES only, derive with a
  named difference" rule; these 2 hand-write the member list, so a new reducer lands in 10 places and
  misses 2. Two imports.
- **`lowerGlobalNumericReducer` bypasses its own extracted policy helper** — `numericReducerAggregate`
  (`tail/barrier.ts`) is documented as the one shared reducer policy and owns the eligible-storage-class
  `CASE WHEN typeof(...)` guard; the root barrier 60 lines below re-derives sum/mean/min/max inline with
  a `WHERE typeof(...)`. **Not a pure transposition** — `WHERE` and `CASE WHEN` differ on
  empty/all-ineligible input (no row vs a NULL row), which interacts with `productiveNull`. Latent
  divergence the L5 metamorphic oracle would attribute to the wrong layer.
- **Ten independent `LIMIT ${limit ?? -1} OFFSET ${offset}` derivations** — PARTLY subsumed by item
  17 as predicted: the shared `SLICE_SUFFIX` (`tail/barrier.ts`) is now the one derivation for every
  GLOBAL slice, routed through `rangeToOffsetLimit`. What remains is the `Scope.local` half —
  `recordSlice`'s local branch and `listLocalTx` still hand-derive offset/limit from `step.args`,
  each with its own `Not a legal range` validation, because a local slice indexes MEMBERS and its
  bounds interact with the shape's own length (`tail` needs `fields.length`). Deliberately left: a
  shared local derivation needs a "member count" authority that does not exist yet.
- **The `ResultStream` residue is the one worthwhile `Shape` retirement** — six orphan `Shape` kinds
  serving `ResultStream` across 13 `toResultStream` call sites, and ~14 of item 5c's parent-shape
  failures. [shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md) §9 says
  retiring *that* is finishing a migration (unlike merging `Stream` into `Shape`, which it refutes).
  Zero corpus demand, so it is a give-back, not a feature.
- **The remaining `as any` reads are a live rename-safety hole** — each is a field read a future LSP
  rename yields `undefined` for, silently and invisibly to `tsc`. **Re-scoped 2026-07-30: the two
  files this item used to name (`tail/path.ts`, `tail/scalar-arm.ts`) are now clean.** 35 `as any`
  remain in `src/`, but most are benign row/bind casts; the rename-unsafe FIELD READS are the ones to
  convert — `(s as any).modulators` (`prefix/sack.ts:46`), `(s as any).productiveBy`
  (`prefix/sideeffect.ts:152`, `prefix/filter.ts:205-206`), `(arg as any).nested`
  (`tail/list.ts:532`), `(a as any).nested` (`ir/strategies.ts:856`), `(pred as any).values`
  (`ir/strategies.ts:471,474`) and `(nestedPrefix[0] as any).args` (`tail/group.ts:290,398`).
  Convert to a cast that NAMES a real type as encountered; it is the only defence against defect class
  1 of the 2026-07-29 rename sweep.
- **§6 vocabulary-set derivation** — reducers and movement families remain: `{count,sum,min,max,mean}` still appears verbatim at
  6 sites and ~10 movement spellings persist. One family per commit, gated on byte-identical
  `test/L2-sql/` snapshots. **Do not fix a membership bug inside a rename** — `POSITION_MOVEMENTS`
  missing `otherV` (item 0's path defect) must land with a test FIRST, or the fix arrives disguised as
  a rename. → [tinkerpop-core-engine-alignment](./2026-07-29-tinkerpop-core-engine-alignment.md) §6
- **`feature-support-matrix.md`'s legend over-promises** — generate the capability ratchet's per-step
  shape strip (`test/L5-properties/capability.test.ts`) into the matrix so its ✅ claim matches item 5c.
- **Deterministic variant/record slicing shipped UNPINNED** — `variantSlice` now passes
  `orderByEncounter: true` (`tail/variant.ts`), so `g.V().values('x').limit(2)` picks a deterministic
  window; the instruction to pin each newly-deterministic result in an L4 `.feature` was not done, so
  a user-visible semantic is live but unspecified.
- **L5's known-bad state is scattered across THREE hand-curated artifacts in two languages** —
  `known.ts` (`KNOWN`, fast-path divergences), `capability-baseline.ts` (`KNOWN_RAW_WITNESSES`, raw
  failures from generated compositions) and the `knownBroken` entries buried inside `laws.ts`
  (metamorphic violations — the highest-severity class, and the easiest of the three to miss because it
  is not a file of its own). Each has exactly ONE reader. **The cost is measured, not hypothetical:**
  the 2026-07-29 refresh found the now-landed L5 discovery gap only by running `L5-random` by hand,
  and the skill that refreshes this index had never looked at any of the three. The obvious target is
  one committed file per the `l3-state.json` precedent. **The HEAD-derived seed raises the stakes
  here** — it makes these three consulted on every build rather than on a manual run, so their
  matchers become the build's gate and an entry without a diagnosis silences a finding every run.
  **But do not do this as a naive merge — the three differ on properties that are load-bearing:**
  - **Hand-authored vs generated.** `l3-state.json` and the census TSVs are machine-written
    (`census.ts` `writeFileSync`); all three L5 lists are hand-curated *because* each entry must carry
    a prose diagnosis, and both file headers say an entry without one is "a silenced test, not a
    tracked finding". A generated JSON cannot hold that, and the discipline is the point.
  - **They are keyed differently and deliberately.** `known.ts` matches on an exact query OR a
    `family` RegExp over the divergence's own message (because a generator rediscovers one root cause
    in a new chain every run); `capability-baseline.ts` is an exact query→message Map;
    `laws.ts.knownBroken` keys on a PREFIX RegExp, per-law, because those two defects are about the
    state the prefix leaves live rather than the law's shape. One schema must keep all three.
  - **`laws.ts` entries arguably belong beside their law**, not in a central file — the diagnosis is
    only meaningful against the specific identity it breaks.
  So the honest shape is probably ONE file with a tagged union (`kind: 'divergence' | 'raw-witness' |
  'law-break'`) and a shared stale-entry check, keeping the per-kind matcher — not one flat list. Both
  existing stale-entry checks (`staleEntries`, and `capability.test.ts`'s `seenKnown` diff) should
  become one. **Low (maintainability), but it is the reason a P1 defect went unseen — so do it before
  the next refresh, not after.**
- **`write.ts` row-at-a-time nested read** (`steps/write/write.ts`) — imperative surface; could
  materialize once via the child seam + a batch form. **Re-measured 2026-07-30: there is no
  hand-rolled SQL left in the merge region**, so this is purely the execution-model question (`run`
  interleaves reads with INSERTs and reads back what it wrote, so a set-based form must decide
  match-vs-create for the whole driver set before writing). Both set-based routes are already
  verified; what is missing is the decision, not the rendering.
  → [writes-through-read-spine](./archive/2026-07-17-writes-through-read-spine-plan.md),
  [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md) #5
- **Review-fix duplication residue (C1/C2/C3 + D)** — property-list framing / tie-break / `PARTITION
  BY ordinal` dups; the `execute.ts` pre-parsed-`pmeta` divergence is latent-correctness. Status
  unconfirmed — treat as open. → [review-fix-plan](./2026-07-22-review-fix-plan.md)
- **Upstream `q`-kernel surface to lazyrecords**.
  → [q-kernel-sql-builder](./2026-07-12-q-kernel-sql-builder.md)
- **Land the TinkerPop fork's upstream payloads.** The submodule tracks `origin/master` and the fork
  exists at `danielbodart/tinkerpop`; what remains is landing four fixes, each verified against
  source:
  1. **`toNumeric` cannot produce a BigInteger** — branch `fix-cucumber-bigint-numeric-parsing` is
     written, self-verified and pushed; captures the `d[…].<suffix>` type tag and dispatches on it
     (mirroring gremlin-dotnet's `NumericParsers`). **Not yet opened as a PR.** See the won't-do
     entry below for why our own framing is already right.
  2. **The generated cucumber `gremlin.js` references an undefined `uuid`** (16 uses, no import, not
     in deps) — every UUID scenario dies, costing us `g_injectXUUIDXXX`. The generator IS in-tree
     (`gremlin-js/gremlin-javascript/scripts/groovy/generate.groovy`) and the output is TRACKED, so
     the fix touches the template's import block, the `uuid` devDependency, and the regenerated file.
     **Patch ready**: `docs/upstream-patches/01-cucumber-uuid-import.patch`.
  3. **The cucumber port is hard-coded** (`test/helper.js`, docker-compose) — the intermittent CI
     conflict with our own conformance host, which must own that port because the client offers no
     way to configure it. **Patch ready**:
     `docs/upstream-patches/02-cucumber-port-env-override.patch` (`GREMLIN_SERVER_PORT` /
     `GREMLIN_SERVER_AUTH_PORT`, byte-identical when unset).
  4. **Bun's `undici` shim lacks `Agent.close()`/`destroy()`** — a BUN bug, not TinkerPop's. Worked
     around in `test/support/undici-shim.ts`; worth reporting to Bun. Do NOT "fix" it by making the
     client call `close?.()` — that would silently skip real connection-pool teardown.

  The fork is also the intended home for the **non-conformant-client UUID/ISO-date shim** (a JS
  client cannot send a UUID's type, so sniff the obvious string shapes — **opt-in**, never default:
  a string that merely looks like a uuid is not one).
  → [typed-merge-values](./archive/2026-07-17-typed-merge-values-plan.md)

---

## Superseded / won't-do (do NOT relitigate)

- **ansi SQL builders / CTE-recipe templates** → replaced by the `q` kernel.
- **Self-tuning `nodes.props` indexes / flat `edges.props` blob** → replaced by normalized
  `*_properties` tables + static covering indexes.
- **"L3 count has duplicate names → miscount"** → *not a bug*; distinct scenarios normalize to the
  same name across feature files. See `test/CLAUDE.md`.
- **`tree()`** → parked (JS GLV stubs `DataType.TREE`, zero conformance value).
- **Two-`union` merge / `optional` fast-path cleanup** → keep the fast path.
- **BulkSet "wire dead-end"** → corrected; wire bulking landed and is live.
- **Cross-DO federation via `ATTACH` coordinator** → rejected; per-request `call(federate)` landed
  instead (open tail in P2·11).
- **Client-side partition → DO routing** → out of scope; server-side soft filtering is the path.
- **Platform walls** — regex UDFs, `typeOf` over some stored props, bigdecimal, lambdas →
  architectural limits, fail-closed by design.
  **OLAP/GraphComputer was on this list and should NOT have been** (corrected 2026-07-30; it
  contradicted P2·8, which plans exactly this). `graph-algorithms` verified that GraphComputer is
  not removed in TinkerPop 4 and that the v4 LANGUAGE carries the four OLAP step names with no
  execution surface — "that gap is exactly what we fill" with an OLTP compile-to-SQL execution. The
  genuine wall is much narrower: a `VertexProgram` execution surface (2 `@WithVertexProgramStrategy`
  scenarios). The four step scenarios come back as a give-back when item 8 lands.
  → [graph-algorithms](./2026-07-24-graph-algorithms-plan.md)
- **Child-scope split-seed + 4-consumer migration** → superseded by the smaller carried-cols fix.
- **Channel-preservation Phase 1 (was P1·18)** → **LANDED 2026-07-31**, and the whole plan closed
  with it: `66cb779` the merge authority with the rigid check as a POLICY · `65e0fe8` one arm-merge
  algorithm with three payloads · `e1aa251` `appendCte`'s `cols` override deleted and `match()`'s
  binding-table drop named · `3657344` every construction route asserting its own carried contract ·
  `264e32f` the role-policy table `Record<keyof TraverserLayout, …>` keeps total. Design of record:
  [channel-preservation](./archive/2026-07-28-channel-preservation-refactoring-plan.md).
  **Two DELIBERATE non-goals — do not re-file either as unfinished work.** `finishElementMerge`
  (`prefix/branch.ts`) is not folded into `mergeArmRelation`: it keeps the arm's encounter in its
  declared `layoutCols` slot rather than renaming it to `arm_encounter`, and it is the only merge
  that pads a ragged `path`, so folding it changes element-merge SQL for no correctness gain
  (revisit only if a THIRD spelling appears). And `bulk` is lost through `match()`, so a reducer
  after one counts ROWS rather than traversers — declared at `layoutOverAliases` and probed for a
  live wrong answer, of which there is none (`movementCollapse` does not fire ahead of a `match()`;
  collapse-on ≡ collapse-off on `g.V().both().both().match(…).select("a").count()`).
  **Two measurement corrections worth not repeating:** the "113 hand-written layout spreads" figure
  counted `...layoutCols(...)` expansions — the single-source-of-truth column list, i.e. the
  OPPOSITE of the defect — and `assertStreamColumns` always did check declared layout-role columns
  (`streamColumns` is `streamPayloadCols` + `layoutCols`); the hole was the construction sites that
  skipped it. **The method that found the one real defect transfers: add the assertion, read the
  failures, then prefer DELETING the escape hatch over keeping the assertion.**
- **Phase 6's IR shape annotation** → killed on its own pre-committed criterion (56.8% `unknown`
  against a 10% ceiling). Lowering remains the sole owner of shape interpretation.
- **"`asNumber(GType.BIGINT)` of a small value should downcast on the wire"** → **our framing is
  already correct; the blocker is a vendored-harness defect.** TinkerPop's
  `NumberSerializationStrategy` magnitude-dispatches only for `typeof item === 'number'`; for
  `bigint` it is unconditional, and `data/BigInt.feature` expects `d[456].n` — the declared type
  PRESERVED, not narrowed. The real cause is gremlin-js's `feature-steps.js`
  `toNumeric` (`parseFloat` never throws, so its `BigInt` branch is unreachable). A blanket downcast
  would REGRESS the 5 sibling scenarios that pass today. Fix it in the fork's harness (debt item
  above), not in our serializer; net L3 gain likely ≤0 if "fixed" our side.

Sources: [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md),
[lazyrecords-cutover](./archive/2026-07-11-lazyrecords-cutover-plan.md),
[phased-roadmap](./2026-07-11-phased-roadmap-plan.md),
[path-tracking-prior-art](./2026-07-12-path-tracking-prior-art.md),
[seam-reuse-audit](./2026-07-13-seam-reuse-audit.md),
[traverser-bulking](./archive/2026-07-14-traverser-bulking.md),
[cross-do-federation-prior-art](./2026-07-13-cross-do-federation-prior-art.md),
[child-scope-path-split](./archive/2026-07-18-child-scope-path-split.md).

---

## Research / vision (reference — no build items)

- **[agent-memory-vision](./2026-07-17-agent-memory-vision.md)** — sibling `mogwai-memory` repo;
  separate-repo, exploratory.
- **[graph-algorithms](./2026-07-24-graph-algorithms-plan.md)** — build spec for P2·8.
- **[conformance-structural-bets](./2026-07-12-conformance-structural-bets.md)** — strategic unlock map;
  live tails are indexed in P1–P3.
- **[cross-do-federation-prior-art](./2026-07-13-cross-do-federation-prior-art.md)** — federation prior-art.
- **[path-tracking-prior-art](./2026-07-12-path-tracking-prior-art.md)** — path prior-art for P3 tails.
- **[wire-and-storage-facts](./2026-07-25-wire-and-storage-facts.md)** — Map.Entry framing + MapStream
  model. Durable reference, not a plan.
- **[channel-preservation](./archive/2026-07-28-channel-preservation-refactoring-plan.md)** — CLOSED
  and archived 2026-07-31. Read it for the constitution a vocabulary migration passes (§"Constitution
  for a vocabulary migration") — that part is reusable and is what the ScalarType, cardinality and
  Phase 1 tranches were each measured against. Phase 6's IR-shape annotation is a committed negative
  result (56.8% ⊤ vs 10% ceiling); the two deliberate non-goals are in won't-do.
- **[correlated-child-rendering](./2026-07-17-correlated-child-rendering-plan.md)** — design-of-record
  for P2·7e, **now essentially BUILT** (verified 2026-07-30; only the E-form aggregate residue is
  left). Keep it for the spike (EXPLAIN + timings) that would be expensive to re-derive and for the
  layering argument its "why the hand-roll exists" section records. **All its landmark paths predate
  the 2026-07-23 restructure and the 2026-07-29 rename** — read it through the rename map.
- **[scalartype-refactoring-pattern](./2026-07-28-scalartype-refactoring-pattern.md)** — vocabulary-cleanup
  template; live targets are `AliasShape` member shape (item 1) and front-end tagged-token accessors.
- **[tinkerpop-core-engine-alignment](./2026-07-29-tinkerpop-core-engine-alignment.md)** — naming authority
  and rename map. The open `ir/rewrites.ts`/`ir/strategies.ts` partition needs a shared-helper home.
