# Outstanding work

The de-duplicated index of open work across the `docs/` corpus. **Each line sets the scene — what,
why, where to start — not a spec.** The linked doc holds the rationale; the picking agent does the
detailed validation and design. Live per-step capability: `feature-support-matrix.md`.

**Refreshed** 2026-07-31 (second pass — the error-assertion sweep below is new, and it found the
largest unindexed defect class in this refresh). Conformance figures below are measured against
**L3 1623 / 2267** (`l3-state.json`, this run; 1621 unique — the name-collision gap is expected, see
won't-do). The denominator moved twice
on 2026-07-30, both
times to drop scenarios the harness cannot adjudicate rather than gaps of ours — see `tags.ts`,
which now names which of three KINDS each exclusion is, and `runner-skips.test.ts`, which fails if
the vendored runner's own skip set ever diverges from it. Item
numbers are stable IDs — landed items are deleted and their numbers are not reused, because code
comments and other docs cite them. **A deleted number must have no live citations left** — item 0
was deleted with four still standing (item 22b).

**The committed test baselines are inputs to this index, not just gates.** `l3-state.json`
(the ratchet floor), `census/{goldens,deferrals}.tsv` (the two-way behavioural baseline — **0
`crashed` rows** as of `cdaa7b9`, down from 17; the antlr4ng patch of item 0f cleared every one, and
item 0c with them), and the hand-curated L5 ratchets — `L5-properties/known.ts` (**empty, and that is
the intended state**) and `capability-baseline.ts` (2 entries, **one of them now stale — item 22c**).
The `knownBroken` list inside `laws.ts` is a **declared type with zero entries**: the field exists at
`laws.ts:47` and nothing populates it, so the "three artifacts" framing in the debt section is now
two-and-a-type, and `L5-properties/README.md:29` still claims two entries that are not there. A
defect parked in any baseline must ALSO appear here; a ratchet entry is tracked, not defended.
**L5 derives its ordinary generated-input seed from `HEAD` and prints the `L5_SEED=<n>` reproduction
command**, so each commit gets new coverage while CI and a local checkout execute the same corpus.

**The L3 telemetry's deferral buckets are NOT the whole failure set — read `scenarios[].firstFailingStep`
too.** The buckets rank traversals that THREW; they are blind to a scenario that failed because we
returned rows where the spec demands an error. That blind spot hid 60 scenarios (item 22).

**L5 found nothing this refresh, and that is a finding about the instrument.** `mise run L5-random`
plus five fixed seeds (5, 11, 27, 91, 143 at `L5_RUNS=3000`) were **35 pass / 0 fail, every run** — no
divergence, no law break, no new raw witness. So the generated-input oracles are saturated at the
current generator depth, and every defect below came from the L3 telemetry, the committed baselines or
a code audit instead. Two consequences worth acting on rather than re-deriving: the lattice still
covers 54 of the corpus's 131 step names (`table.test.ts` prints the gap), so **growing the generator
is now higher value than running it more**; and all six runs printed *"2 known raw witness(es) not
drawn by this seed"* — six seeds, neither witness ever drawn, which is item 22c.

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

**Ranked entry point (2026-07-31).** Item numbers are stable IDs, not an ordering — read this line for
priority. Correctness first, because two of these break the fail-closed rule: **27** (`Scope.local`
slices emit `LIMIT NaN`) → **22** (33 scenarios where we answer a question the spec says to refuse, 24
of them one merge guard) → **26** (nine of eleven root materializers discard emission order, which
gates 4, 20 and 21) → **2** (the child seam) → **17**'s `tail`/`sample` cells and **28** (flag the
seventh fast path) as the cheap ceiling lifts → **29** (barrier role policy, which makes 17 deferral
sites answerable) → **3**'s `times(n)` unroll, still the biggest single L3 mechanism at 41 queries.

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

   **The whole deferral surface re-clustered by root cause, 2026-07-31** — 258 typed deferral throws
   of 488 `throw` sites, with L3 traversals lost beside each, ranked by "one lift, most sites cleared":
   **D carried-state × barrier 17 sites → item 29's one policy table** · **C's
   `path() through a mixed-shape X` sub-cluster 8 of branch triage's 20 sites → one
   path-position-over-a-variant-merge lift** · **F `by()`/modulator vocabulary 42 sites / 21 scenarios,
   the highest site count in the codebase → ~24 collapse into a shared "resolve a by() to a
   sort/projection Expression over any stream" seam** (`classifyBy` is the one decode but its `ByClass`
   has no `'column'` arm, so every host re-decides what it accepts — the residue is genuine, `by(T.x)`
   on shapes with no token) · **A shape-tail ceiling 14 sites but 85 scenarios**, the highest
   scenarios-per-site ratio here at 6:1, because each is an unbounded fallback throw covering every
   unregistered step name — that is item 17's matrix. Then E repeat-body 26/66 (item 3), G write 31/92
   (items 10 + P3-write), K label/`select(Pop.*)` 17/11 (~6 share item 1's `AliasEntry` root), B
   child-seam 13/32 (items 2/5).

   **The ~30 row-op cells are now their own item — take item 17 FIRST.** The 2026-07-29 audit measured
   the (shape × row-op) matrix at 55/100 gaps and confirmed `RelationalCardinality` is the named axis
   that makes sharing safe, so that slice is no longer "per-step dispatch" work at all. What is left
   here after item 17 is the ~35 genuinely per-step cases plus the `ResultStream` residue (below).
   → [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md),
   [shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md)

6. **`order().by()` of paths (path natural-order comparability).** Unlocks the Orderability
   conformance cluster. **Medium.**
   → [path-history-substrate](./2026-07-18-path-history-substrate.md)

20. **Results that are ordered only because SQLite scanned the convenient way.** Corpus — the
   perturbed census, the useful number because it is a fixed 2,298-traversal denominator: **41 → 8**.
   Suite: 20 at first run, **18 now**, and read that one with care — the suite total barely moves
   because most of its entries are order-sensitive ASSERTIONS in `test/compiler/`, and two are L5
   tests whose generated corpus rotates with the HEAD-derived seed, so they come and go. Found by `mise run test:perturbed` (`82d011b`), which runs the
   suite under `PRAGMA reverse_unordered_selects`; see `test/CLAUDE.md`. A failure there is never a
   flake — it is a result the emitted SQL does not actually determine. Three distinct mechanisms,
   and they are separate items of work:
   - ~~**`order().fold()` — the whole 13-scenario L3 block**~~ — **LANDED `9acd2f8`**, one line in
     `computeDemandsEncounter`: `fold` now demands an encounter behind an explicit `order()`, not
     only behind a fan-out. The slice path is deliberately untouched (the new condition names `fold`
     alone), so `<movement>.order().by(key).limit()` keeps movementCollapse and `collapseSafe`'s
     `sawOrder` gate still agrees with the demand pass. Nothing else was needed because `order()`
     already re-mints the encounter as `ROW_NUMBER() OVER (ORDER BY <sortkey>, <prior encounter>)`.
     L3 is 1623 by default AND 1623 perturbed. **The transferable lesson: "an upstream `order()`
     satisfies this consumer" is true for a consumer reading the ordered relation in the SAME query
     and false across a relation boundary — check which before reusing that reasoning for any other
     aggregate.**
   - ~~**`aggregate()…cap()` member order**~~ — **LANDED `d00e7ea`**, 33 of the corpus's 41. The
     order channel now lives in the shared `jsonbGroupArray` (`plan.ts`), which takes an optional
     `order` so a caller passing nothing is ASSERTING there is none; and
     `COLLECTING_CONSUMERS = {fold, aggregate}` in `analyze.ts` differs from the slice consumers on
     both clauses, so they cannot share a rule. **The trap to remember: a child ORDINAL is not an
     order channel** — `pushChildScope` mints it with `ROW_NUMBER() OVER ()`, an empty window, so it
     numbers in scan order and reverses with it. Order on the parent domain's `encounter`.
   - ~~**`local(aggregate(…))` — the Scope.local collection, ~17**~~ — **LANDED `cca0d02`**, and the
     premise above was wrong in a useful way: it is NOT a separate lowering. It reaches the same
     `aggregate` StepFn inside a child scope, and the reason the previous fix missed it is that
     `computeDemandsEncounter` walks the chain **FLAT** — an `aggregate` inside a `local()` body is
     not there to be seen, so no encounter was seeded for it to order by. Adding `cap` to
     `COLLECTING_CONSUMERS` fixes it at the one step that can never be hidden in a body.
     **The general lesson: any chain-global demand computed by a flat scan is blind to child
     bodies.** Before adding a step to that scan, ask whether the same step can appear nested, and if
     so anchor on a top-level consumer instead of descending.
   - **A GROUP VALUE body's barrier runs in the wrong SCOPE — a live silent wrong answer, and the
     one entry here that is not an ordering fix.** `g.V().group().by(T.label).by(__.values('name').
     order().by(Order.desc).fold())` returns `person: [marko, vadas, josh, peter]` — vertex-id order.
     Ascending gives the same. The identical `order().by(Order.desc).fold()` at ROOT is correct
     (`[vadas, peter, marko, josh]`), so the modulator is not mis-lowered; it is lowered in a scope
     where it cannot do anything.
     Read the SQL and it is unambiguous: the value body compiles into a PER-ORIGIN child scope, one
     origin per input vertex, so `c3` re-mints `encounter = ROW_NUMBER() OVER (PARTITION BY o0 ORDER
     BY <sortkey> DESC, …)` — correctly, but each vertex has exactly ONE name, so every partition has
     one row and the sort is a no-op. The group's list is then built `ORDER BY gp.o0, gf.encounter`,
     i.e. by PARENT SCAN ORDER, which is also why it is perturbation-fragile.
     **The reference splits the value traversal**: `GroupStep` takes the LAST barrier as the group's
     REDUCER and everything before it as a per-traverser pre-traversal — so `values('name')` is
     per-traverser and `order().fold()` applies to the group's whole collection. We run all of it
     per-origin. Fixing it is the group-value barrier scope, i.e. item 5's group-child-body ground,
     not an ordering patch — **do not try to fix this by changing the ORDER BY.**
     *Med — silent, and the corpus cannot see it: both scenarios assert `unordered`.*
   - **`aggregate('x').by(__.out().order().by('name'))`** — the by(traversal) arm with a FAN-OUT
     child body. The outer collection is ordered now, but the child's `first`-per-parent pick reads
     the child rows in scan order. Child-internal; adjacent to the child-scoped fold below. *Low-Med.*
   - **Three WRITE traversals** whose nested read driver consumes rows in scan order
     (`addV(…).property(k, __.values(…))`, two `addE` forms). This is the row-at-a-time `write.ts`
     surface already filed under internal debt — worth noting the perturbation makes its
     order-dependence visible. *Low.*
   - `g.V().repeat(__.both()).times(3).range(5,11)` is EXPECTED: `computeDemandsEncounter` returns
     false at a `repeat`/`match` boundary by design (item 4). Not a defect; do not "fix" it here.
   - **A RECORD stream carries no `encounter`**, so `recordSlice`'s `orderByEncounter` is inert and a
     record slice picks an arbitrary window. The projection CTE's declared column list drops the
     channel. This is `TraverserLayout` role preservation across a shape transition — the
     channel-preservation ground the closed Phase 1 covered for merges, applied to projections.
     *Med.*
   - The remaining ~15 are in `test/compiler/`, `test/L2-sql/` and the census. Each needs reading
     to decide whether the ASSERTION is over-strong or the traversal genuinely under-determined —
     **do not bulk-relax them**, since the `order().fold()` block looked exactly like test-side
     fragility and was a real defect. The perturbed CENSUS is the most useful of the 15: it names
     every order-fragile corpus traversal in one place, which is a ready-made worklist.
   **Clearing all three makes `test:perturbed` a gate**, which is the point of filing it as one item.

21. **`union()` emits arm-major GLOBALLY; the reference is arm-major PER TRAVERSER.** Verified in
   `vendor/tinkerpop/gremlin-core` — `BranchStep.standardAlgorithm` calls
   `applyCurrentTraverser(this.starts.next())` for ONE traverser and then drains each option for it,
   so `g.V().hasLabel('software').order().by('name').union(__.values('name'), __.identity())` is
   `lop, v[lop], ripple, v[ripple]` upstream and `lop, ripple, v[lop], v[ripple]` here. Our
   `arm_idx, arm_encounter` re-mint (`prefix/branch.ts`, `tail/variant.ts`) orders by arm FIRST
   across the whole stream rather than within each origin.
   **`emission-order.feature`'s comment "union emits arm 0 fully before arm 1 (TinkerPop's contract)"
   is right for its own scenario and over-general** — that scenario is `g.V(4)`, a single traverser,
   where the two readings coincide. Every `union` scenario in the corpus asserts *unordered*, which
   is why nothing catches it. Before fixing, check whether the re-mint should partition by the input
   origin; that is a one-clause change to a `ROW_NUMBER() OVER`, but it moves emission order for every
   branch shape, so it needs the census as the instrument. *Med — a real divergence, currently
   invisible to every gate.*

28. **`expandRepeatBody` is a SEVENTH specialized lowering and the only one the differential cannot
   see.** `branch.ts:875-887` picks between three recursive-term body renderings — the generic keyed
   relation (`tail/keyed.ts`), `singleMove` (`branch.ts:766`) and `expandRepeatBody`
   (`branch.ts:602-652`) — and the gate `flatOk || sackCol || trackArray ? null : keyedChildRelation(…)`
   (`branch.ts:800`) means the flat expansion **always wins** where it recognises the body. Its own
   header calls it *"a private movement/filter mini-compiler: its own direction table, its own edge
   aliases, its own has() handling — a second implementation of what the StepFns already do"*, kept as
   the frontier-lazy fast path. But it is **not a `FastPath` object**: no `FastPathConfig` flag, no
   `equivalentWhen`, no `runFastPath`. The six real ones (`plan.ts:488`, `branch.ts:297`,
   `predicate.ts:140`, `movement.ts:22`, `scalar-arm.ts:257`, `bulk.ts:258`) all carry
   `equivalentWhen: 'test/L5-properties/differential.test.ts …'`; this one is invisible to L5, on the
   highest-risk seam there is — a hand-rolled direction table inside a recursive CTE.
   Adding `repeatBodyExpansion` to `FastPathConfig` (`options/fast-paths.ts:7-29`) and gating `flatOk`
   makes every body where both routes apply (`out()`, `out().has(k,v)`) differential-testable.
   **Do this BEFORE item 3's `times(n)` unroll** — it is the instrument that would catch a repeat-body
   regression the way the census caught item 17's 42-traversal loss, and item 3 is the biggest L3
   mechanism (41 queries). *Medium-High — instrument integrity on the seam with the most to lose.*

29. **The barrier side of the carried-role contract has no policy table, so Phase 1's totality
   guarantee is half a guarantee.** `LAYOUT_ROLE_POLICY`
   (`context/context.ts:288-298`) is a `Record<keyof TraverserLayout, …>` whose stated point is that
   *"adding a role to `TraverserLayout` fails the build until its policy is declared here"* — but it
   covers ARM MERGE only. `dropLayoutAtBarrier` (`context/context.ts:617-628`) hand-constructs a fresh
   literal with four fields, and every other role in `TraverserLayout` is optional, so **a role added
   tomorrow compiles clean and is silently dropped at all 15 barrier sites** — the exact
   "carried field dropped at a barrier" class the shape doc measured at 33% of defects. Same hole at
   `branch.ts:1114` and at the ~9 `traverserLayout: { aliases: new Map(), origins: [] }` seed literals.
   A `BARRIER_ROLE_POLICY` beside the merge table, with `dropLayoutAtBarrier` derived from it, also
   makes the **17 `carried-state × barrier` deferral sites** answerable in one place (they all say some
   form of *"X after `as()`/`path()`/`sack()` not yet supported"* and each declines because no rule
   says what the barrier does to that role). **This is NOT one of Phase 1's two deliberate non-goals** —
   those were `finishElementMerge` and `bulk`-through-`match()`, both on the merge side. *Medium.*

26. **The root materialization boundary DROPS emission order for 9 of the 11 shapes — so every
   ordering item above only reaches the wire on scalar results.** Verified 2026-07-31:
   `materializeScalarRoot` (`tail/materialize.ts:37`) is the **only** root materializer that emits
   `ORDER BY <traverserLayout.encounter>`; grep the file and there is exactly one such clause across
   eleven `materialize*Root` functions. List, variant, property, record, mapEntry, path, group, map
   and foreign roots all project `SELECT <cols> FROM <rel>` bare — **even when the final CTE
   physically declares an `encounter` column**. Measured under `reverse_unordered_selects`:
   `g.V().order().by('name').values('name')` is stable, while `…order().by('name').properties()`,
   `…order().by('name').local(__.out().fold())` and
   `g.V().hasLabel('software').order().by('name').union(__.values('name'),__.identity())` all FLIP.
   The union case is the sharpest: `mergeArmRelation` computes
   `ROW_NUMBER() OVER (… ORDER BY arm_idx, arm_encounter)` into `encounter` *precisely* to establish
   arm-major order, and the root throws it away.
   **This reframes items 4, 20 and 21.** Item 20 names `recordSlice`'s *inert* `orderByEncounter` (an
   ABSENT encounter); this is the opposite and larger mechanism — a PRESENT encounter discarded at the
   boundary, for nine shapes at once. Item 21 (`union` emission order) cannot even be measured until
   the root determines order. The lift is one `orderByEncounter(stream, rel)` applied inside
   `materializeStream` (`materialize.ts:244-258`), guarded on `traverserLayout.encounter` — mechanical,
   and it is a precondition for making `test:perturbed` a gate. **High.**

27. **Seven fail-closed VIOLATIONS: `Scope.local` slices emit malformed SQL.** Reproduced directly
   this refresh — these do not defer, they emit broken SQL:
   `g.V().limit(Scope.local,1)` and `g.V().range(Scope.local,0,1)` → **`no such column: NaN`**;
   the same on a variant stream (`g.V().union(…).limit(Scope.local,1)`); and
   `g.V().project('n').by('name').skip(Scope.local,1)` → **`near "FROM": syntax error`**.
   Cause: three slice builders read `Number(s.args[0])` off the `{scope:'local'}` TOKEN and splice the
   `NaN` into `LIMIT`, never reaching `globalRowOps`' `isLocalScope` decline
   (`tail/barrier.ts:14-15,141-143`) — `projection.ts:104-106` (`TAIL_MODIFIERS`),
   `variant.ts:172-177` (`variantSlice`), `select.ts:654-671` (`recordSlice`'s local branch, which
   produces an empty column list). Adjacent wrong MESSAGE, same root: `g.V().union(…).dedup(Scope.local)`
   reports *"dedup(label) not yet supported"* — the scope token read as a label argument
   (`variant.ts:182`). **Item 17 already built the guard; these three call sites bypass it.** **High —
   the fail-closed rule is the one invariant this project does not trade.**

22. **Validation the spec MANDATES and we do not perform — 33 scenarios, and they are silent wrong
   answers on the write path.** Measured this refresh from `l3-telemetry.summary.json`
   `scenarios[].firstFailingStep`: **60 failing scenarios fail AT the error-assertion step**
   (`Then the traversal will raise an error…`), and 33 of them fail because we **returned a result**
   where the spec requires a throw. This is the fail-closed rule inverted — we do not mis-answer a
   question we declined, we answer one we should have refused. Four families:
   - **`option(onCreate|onMatch)` may not override a key already bound by the `merge()` argument —
     24 scenarios, all `mergeV`/`mergeE`, and we perform the write.** `g.mergeV([(T.label):'a']).
     option(Merge.onCreate,[(T.label):'b'])` must raise *"option(onCreate) cannot override values from
     merge() argument"*; we return `Vertex{id:1, label:'b'}`. Same for the `Direction.OUT`/`IN`, `T.id`
     and `T.label` overrides on `mergeE`, their `withSideEffect` dynamic twins, and the hidden-key
     (`~id`/`~label`) prohibitions in the merge map, `onCreate` and `onMatch` alike
     (`MergeVertex.feature`, `MergeEdge.feature`). One shared check over the merge argument vs each
     option map, at the point the option map is resolved — the whole family is one guard. **High.**
   - **A string step in `Scope.local` over a LIST must raise, not pass the list through** — 6
     (`asString`, `asString(local)`, `lTrim/rTrim/trim(local)`, `concat` over a `List`). We return
     the list unchanged.
   - **`groupCount()` accepts two `by()` modulators** — 2. The `aggregate`/`dedup` siblings already
     reject it (with our own wording, item 23); `groupCount` does not reject it at all.
   - `g.V(1).property(Cardinality.single,'friend',__.out('knows').values('name'))` — 1.
   Start at the merge family: it is 24 of the 33, is one guard, and is the only one that WRITES.
   → `MergeVertex.feature` / `MergeEdge.feature`, `steps/write/`

22b. **Item 0 was deleted from this index while four live citations still point at it — and the
   defect it named is FIXED, so all four now describe trunk wrongly.** `POSITION_MOVEMENTS`
   (`steps/tail/path.ts:49`) **does** include `OTHER_V` today, and
   `test/L4-addendum/where-under-otherv-context.feature` is its test — so the §6 debt bullet's
   instruction ("must land with a test FIRST") is discharged. Still asserting the old, wrong story:
   `src/compiler/ir/step.ts:38` ("a real open bug for `POSITION_MOVEMENTS`"),
   `test/compiler/step-vocabulary.exec.test.ts:11` ("a KNOWN BUG … pinned here as-is on purpose" —
   and its `COLLAPSE_MOVES / POSITION_MOVEMENTS: the nine, no otherV` test now asserts a locally
   rebuilt set, NOT the real `POSITION_MOVEMENTS`, so the name misdescribes what is checked),
   `test/L5-properties/README.md:29`, and this file's own §6 bullet.
   `docs/2026-07-28-property-based-testing-l5.md` lists four defects against the same dead number and
   **all four probe clean at HEAD**. *Low as code, Medium as integrity — the index's stable-ID promise
   is only worth something if a deletion sweeps its citations.*

22c. **The capability ratchet cannot tell "fixed" from "not drawn", so a stale entry sits forever.**
   `capability.test.ts` computes `stale` only over witnesses the seed actually DREW, and reports it as
   a `console.log`, never a failure — every run this refresh printed *"2 known raw witness(es) not
   drawn by this seed"*. Re-run directly, entry 1 of `KNOWN_RAW_WITNESSES`
   (`g.V(1).where(__.identity()).has('age').hasId(2).repeat(__.both('created').in('created')).times(1).dedup()`,
   banked as `no such column: edges.label`) now **executes cleanly** — it is fixed, and the ratchet
   never noticed. Entry 2 (the path-regime syntax error) reproduces, minimal repro confirmed:
   `g.V(1).simplePath().project('a').by(__.repeat(__.in('knows')).times(2))` → `near "FROM": syntax
   error` (P3 recursive-path tails). The list is TWO fixed strings; re-running both unconditionally
   costs nothing and turns the stale check into a real one. Entry 1 also carries **no diagnosis**,
   which its own file header forbids. *Low — but it is the ratchet-rots-silently mechanism, and this
   index exists because of it.*

23. **27 scenarios where we DO reject and only our WORDING differs — and several are deferrals
   mis-phrased as permanent gaps.** The other half of item 22's 60. We correctly refuse
   `g.V().aggregate('x').by('name').by('age')`, but say *"aggregate() with more than one by()
   modulator not yet supported"* where the spec asserts *"Aggregate step can only have one by
   modulator"*. **The wording is the cheap part; the conceptual defect is "not yet supported".**
   Two `by()`s on `aggregate` is invalid Gremlin forever, not a gap we might close — spelling it as a
   deferral puts it in the deferral telemetry that RANKS THIS INDEX, so permanent validation errors
   are inflating the gap buckets we prioritise from. Split the message vocabulary: a spec violation
   gets the spec's text, a genuine gap keeps "not yet supported".
   **Not all 27 are free — check the REASON before adopting the text.** Where we reject for the same
   reason it is a rename (`aggregate`/`dedup` two-`by()`, `emit`/`until`/`times` without `repeat`,
   `mergeE` missing `outV` → *"Out Vertex not specified"*, `addE` endpoints, `ReadOnlyStrategy`).
   Where we reject for a DIFFERENT reason it is a real gap that merely coincides — `choose().option()`
   expects *"Traversal is not allowed as a Pick token"* and we say *"choose().option() not yet
   supported"*; `asBool()`/`asDate()`/`asNumber()` over a list expect *"Can't parse…"* and we defer on
   the list shape. Those stay in their own items. *Medium — cheap, and it cleans the instrument.*

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
     **That decision is sound and its EXECUTION is broken in three places — see item 27**, where the
     local branch splices `NaN` into `LIMIT` instead of declining.
   - Still hand-written per shape and NOT yet shared: `order` (needs a per-shape comparable key, so
     it is not a row-algebraic op), `tail`, and the `mapEntry`/`map` reducers. `order` is the
     valuable one and is genuinely a different problem — do not assume this pattern extends to it.
   - **Re-measured 2026-07-31 at 15 ops × 10 producers = 150 cells, 86 gaps, and the item's own
     figure VERIFIED: item 17's five ops are 50 cells with exactly 4 gaps, all `group`.** Two
     corrections and one addition:
     - The CAUSAL claim above is wrong. Those four `group` cells do not reach `reprojectRows` and
       decline on `cardinalityOf` — `globalRowOps` is **not registered into `GROUP_DISPATCH` at all**,
       so they fall to the fallback throw (`group.ts:692`). The outcome is the same; the mechanism a
       reader would go looking for is not there.
     - `variant.ts:165-188` still **re-declares** `limit`/`skip`/`range`/`dedup` verbatim, including
       three error strings byte-identical to `barrier.ts:150-153`, minus the `isLocalScope` guard. So
       "the three slice builders are one implementation" is true of `reprojectRows` and not yet true
       of the variant table — and that omission IS item 27's defect.
     - **`tail` and `sample` are 19 of the 82 remaining cells and fall to ONE mechanical lift of the
       mechanism this item already built** — `tail(n)` over a `perRow` relation is
       `ORDER BY encounter DESC LIMIT n`, `sample(n)` is `ORDER BY RANDOM() LIMIT n`; two
       `SLICE_SUFFIX` entries (`barrier.ts:90-97`) plus a reverse flag on `reprojectRows`. Note
       **`tail()` does not exist on the ELEMENT stream at all** (`g.V().tail(2)` →
       `step not implemented: tail()`) though `filter/Tail.feature` carries 22 scenarios, and
       `sample()` exists nowhere. This is the cheapest remaining ceiling lift in the matrix.
     The other 63 gaps split: 42 current-object aggregates (`fold`/`sum`/`max`/`aggregate`/`groupCount`
     — ARCHITECTURAL, they need the "expression denoting the traverser's value" authority that would
     generalise `foldMember`, `barrier.ts:186`), 7 `order` (architectural, as stated), 6 `is` (now
     mechanical — `typeOfAssert` unblocked it), 5 `unfold` (shape-interpreting, correctly per-shape
     forever). **`lowerScalarRows` (`scalar.ts:640-730`) is the one shape tail that never got the
     `dispatchShapeTail` transposition** — an if-chain, not a Map, despite `f3c4606` claiming all
     eleven. It owns the only global `tail` implementation, so it is the reference any shared `tail`
     lift must read first.
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
   → [match-string-frontend-design](./archive/2026-07-28-match-string-frontend-design.md)


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
   hand-writes an `edgeProperties.as('xep')` join** (`…outE().values(k).<sum|min|max|mean>()` inside
   `where`/`is` — `prefix/predicate.ts:95-97`, re-confirmed 2026-07-31). Its COUNT sibling
   (`:81-84`) already goes through `compileCorrelatedChild`; only the aggregate does not. Before touching it, grep tests + corpus for that shape and decide whether to
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
    [multi-label-elements](./2026-07-30-multi-label-elements-plan.md), whose **header is stale**: it
    still says "Phase E is the remainder and is BLOCKED", which the map-shape regimes landing refutes.
    Fix the header when next in that doc. What is left:
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

24. **`tree()` — 12 scenarios, the largest unimplemented-step bucket, and it was parked on a false
    premise.** The won't-do entry said the JS GLV stubs `DataType.TREE`; it does not — the vendored
    client ships a full `TreeSerializer.js` with both directions and a wire-format comment citing the
    Java serializer as authoritative, so the result is decodable end to end. What is missing is ours:
    `step not implemented: tree()`. `tree()` is a path-history consumer (it folds the traversers'
    paths into a nested map), so scope it against P3's recursive-path tails and item 6 before
    estimating — the wire half is free, the path half is not. **Medium.**

25. **Unimplemented-step matrix-fill, with this refresh's L3 counts.** Ranked, all fail closed today:
    `subgraph()` 6 · `branch()` 5 (also P3, its own family) · `discard()` 4 · `sideEffect()` 4
    (P3) · `sample()` 3 at global position · `index()` 2 (item 14) · `with()` 2 (item 13) ·
    `asString()` 2 · `fail()` 2 · `hasNot()` 1 (P3). Separately, **`select(Pop.mixed).by(…)` is 5
    scenarios** and is not a missing step but an unimplemented `Pop` mode. Counted from
    `l3-telemetry.summary.json` buckets this refresh. *Low each — matrix-fill, listed so the counts
    are not re-derived every sweep.*

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

- ~~**LSP refactoring tooling — four scripts landed (`8c33450`), four items remain**~~ — **ALL FOUR
  LANDED.** `mise.toml` has `[tasks.arch]`, `[tasks.lint]` and `[tasks.orphans]`, and
  `[tasks.ci] depends = ["check","lint","arch","test","build"]`; the lint backlog went 76 → 0
  (`3181430`/`fda7a27`/`0635cab`); the dead-export sweep is `scripts/orphans.ts`; `moveToFile` split
  into a landed `scripts/move.ts` plus a measured-blocked SYMBOL move.
  `docs/2026-07-30-lsp-tooling-plan.md` self-reports all four resolved. **What is left is smaller and
  is four policy calls, not code:**
  - **Four module-boundary decisions `mise run orphans` surfaces but cannot settle** — `alias.ts`'s
    symmetric accessor vocabulary (only `entryTypeTag`/`nodeEntry`/`elemEntry` are used),
    `isMidBarrierPoint` (`tail/call.ts`), `SCALAR_ROW_STEPS` (`tail/scalar.ts` — check it against the
    "vocabulary declared twice" hazard first) and the 86 `local-only` exports. Each is a policy call
    about what a module's public surface IS; decide the policy once rather than drifting into it one
    sweep at a time. → plan §3b.
  - **`compile()` — the named public entry — is exercised only by tests**, while production goes
    through `compilePlan`. Left standing deliberately: a finding about the API surface, not dead code.
  - **No tool can move a SYMBOL between files** — `tsc --lsp` advertises no `refactor.*` code-action
    kind (measured), so relocating a symbol across the `src/gremlin/` ↔ compiler boundary (locked
    decision 5) is hand work. The real question is whether `tsserver` is worth losing "the same
    TypeScript `mise run check` uses". *Low-Med.* → plan §4.
  - **`parser/` as a separately-built package** is the one config route never tested for exempting
    generated code from the three unused-code flags (tsc would consume `.d.ts`, so `skipLibCheck`
    covers it) — it would move them out of `scripts/lint.ts` into `tsconfig.json`, at the cost of
    reintroducing a build step into a build-free project. Needs a human call. → plan §2.

**There is no TODO/FIXME/XXX/HACK anywhere in `src/compiler/`, `src/sql/` or `src/execute.ts`**
(verified 2026-07-29; the one repo-wide hit is `src/serializers.ts`, an upstream-TinkerPop note). Debt
here is encoded as typed `throw` deferrals and in-code prose, so grep for markers finds nothing and
proves nothing — read the deferral clusters instead.

- ~~**`is(typeOf(GType.X))` is decoded independently at 5 sites**~~ — **LANDED `fe0e257`.**
  `typeOfAssert` (`tail/child-shape.ts`, beside `classifyBy`) is the one decode, total over three
  outcomes (`gtype`/`opaque`/`none`) so a reader must say what it does with each; `assertsGType` and
  `collectionAssert` are DERIVED readings, not second decoders. `gtypeName` is now unused in all five
  files — none decodes a GType any more. No SQL moved.
  **The recorded disagreement was kept, deliberately.** `group` still throws on a non-MAP assert where
  `path` returns an empty relation: what a non-matching assert MEANS is per-arm policy, and both
  answers are defensible (a filter that matched nothing vs an arm with no lowering for the claimed
  shape). Separating the decode from the policy is what stops them drifting further; each site now
  names its twin. **Do not "finish" this by picking one.**
  Also landed on the way: `isPred` (`gremlin/frontend.ts`), the narrowing guard beside the tagged-arg
  guards, so reading `.op`/`.values` off an `any[]` arg goes through a guard instead of an open-coded
  typeof chain. The `is` registration into item 17's tables is now unblocked.
- ~~**`classifyBy` says "no host should re-scan byArgs inline" — 4 hosts still do**~~ — **LANDED
  `d5d0b85`**, five of them counting `list.ts`'s `order(Scope.local)` loop. Behaviour-identical:
  `by.find(a => 'order' in a)` IS `isOrderArg` plus a null check, which is what `classifyBy().dir`
  already does. `propertyOrder` (`tail/group.ts`) gave up four hand-rolled scans (token, nested,
  string-key, direction) for one call, and its duplicated shuffle deferral collapsed to one.
  **The residue is one deliberate non-goal:** `mapLocalOrder`'s `by(Column.keys|values)` scan stays
  hand-written (on the `isColumnArg` guard) because `ByClass` has NO `'column'` arm. Adding one is not
  a cleanup — a `{column}` by() classifies as `{kind:'none'}` today, so every one of the 25 consumers
  currently reads `by(Column.keys)` as a BARE by(), and a new arm silently reclassifies all of them.
  Measure before widening.
- ~~**`NUMERIC_REDUCERS` re-declared despite `ir/step.ts` being the named base**~~ — **LANDED
  `1e86fa0`**, and it was seven sites, not two. `NUMERIC_REDUCER_NAMES` (`ir/step.ts`) is now the one
  member list; membership is byte-identical everywhere, which is why the L2 snapshots did not move.
  **The part worth carrying forward is what deleting a set REVEALED**, twice:
  - `NumericReducer`/`ScalarReducer` lived in `tail/barrier.ts` while the SET lived in `ir/step.ts` —
    two independent spellings of four names with nothing making them agree. The type is now DERIVED
    from the set's member list (`(typeof NAMES)[number]`) and cannot drift. This is the
    `ScalarType` pattern applied to a step-name vocabulary; `barrier.ts` re-exports so no importer
    moved. **The same question is open for every other name set in `ir/step.ts`** — none has a
    derived member type yet, and the movement families are the obvious next.
  - `BULK_REDUCERS` was `REDUCERS` verbatim, and its two readers wanted DIFFERENT halves — the local
    set hid that behind `&& term.name !== 'count'`, i.e. `NUMERIC_REDUCERS` spelled as a subtraction.
    A duplicate set does not merely duplicate; it lets a reader express its real membership as a
    correction to the wrong base.
- ~~**`lowerGlobalNumericReducer` bypasses its own extracted policy helper**~~ — **LANDED `109ed6a`,
  and it was hiding a live wrong answer, not just debt.** The index's stated caution ("`WHERE` and
  `CASE WHEN` differ on empty/all-ineligible input — no row vs a NULL row") was **wrong**: a bare
  aggregate with no GROUP BY returns exactly one row either way, so the two forms are equivalent for
  min/max/mean. The real divergence was that the global `sum` arm carried **no eligibility guard at
  all** — `g.V().values('name').sum()` returned a fabricated **0** (SQLite coerces text to 0 inside
  SUM) where min/max/mean over the same stream all reported nothing eligible.
  Routing through the policy makes an all-ineligible `sum()` agree with the same `sum()` over an
  EMPTY stream. A MIXED stream was always right (each text value contributes 0) and is pinned as
  such, because that is what a careless guard breaks. No census row moved, so no corpus traversal
  sums a non-numeric value — which is exactly why this survived: **the L2 test asserting "mean/sum
  numeric only" only ever checked the SQL, never the result.** Worth generalising: a test that pins
  a policy's TEXT does not pin its behaviour, and every reducer/guard assertion in `test/L2-sql/`
  is that shape.
- **Ten independent `LIMIT ${limit ?? -1} OFFSET ${offset}` derivations** — PARTLY subsumed by item
  17 as predicted: the shared `SLICE_SUFFIX` (`tail/barrier.ts`) is now the one derivation for every
  GLOBAL slice, routed through `rangeToOffsetLimit`. What remains is the `Scope.local` half —
  `recordSlice`'s local branch and `listLocalTx` still hand-derive offset/limit from `step.args`,
  each with its own `Not a legal range` validation, because a local slice indexes MEMBERS and its
  bounds interact with the shape's own length (`tail` needs `fields.length`). Deliberately left: a
  shared local derivation needs a "member count" authority that does not exist yet.
  **The remaining count is UNDERCOUNTED — three more survive beyond the two named**
  (re-measured 2026-07-31): `projection.ts:714,1116,1143` (the element `TailMods` derivation),
  `scalar.ts:669,708` (`lowerScalarRows`' if-chain) and `variant.ts:172-177`. The first and last are
  the source of item 27's malformed SQL, so this bullet and that item are the same code — fix them
  together, and note that the "member count authority" gap is the REASON to decline, not a reason to
  compute `NaN`.
- **The `ResultStream` residue is the one worthwhile `Shape` retirement** — six orphan `Shape` kinds
  serving `ResultStream` across 13 `toResultStream` call sites, and ~14 of item 5c's parent-shape
  failures. [shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md) §9 says
  retiring *that* is finishing a migration (unlike merging `Stream` into `Shape`, which it refutes).
  Zero corpus demand, so it is a give-back, not a feature.
- **The remaining `as any` reads are a live rename-safety hole** — each is a field read a future LSP
  rename yields `undefined` for, silently and invisibly to `tsc`. **Re-measured 2026-07-31: `cb8eabf`
  cleared all seven sites this item used to name, and every one of those paths now greps zero.** The
  count is **26** in `src/`, down from 35, and most are benign row/bind casts. The rename-unsafe FIELD
  READS that remain have simply relocated — `(s as any).productiveBy` (`tail/projection.ts:91`),
  `(a as any).nested` (`tail/child-shape.ts:214,239`, already behind an `isNested` filter that
  narrows) and `(pred as any).values` (`tail/operand.ts:162,164,178,179,191`, exactly the shape the
  `isPred` guard was built for in `ir/strategies.ts`). Convert to a cast that NAMES a real type as
  encountered; it is the only defence against defect class 1 of the 2026-07-29 rename sweep. **The
  pattern worth noting: this item has now been "cleared" once and refilled from elsewhere, so treat it
  as a standing sweep, not a task with an end.**
- **§6 vocabulary-set derivation — three of its four counts have moved; ~4 movement lists left.**
  Re-measured 2026-07-31: the reducer list is now ONE site (`NUMERIC_REDUCER_NAMES`,
  `ir/step.ts:69`), `{path,simplePath,cyclicPath}` is one (`PATH_FAMILY`, `ir/step.ts:66`), and the
  movement BASES landed (`unionOf`/`VERTEX_MOVES`/`EDGE_MOVES`/`ENDPOINT_MOVES`/`OTHER_V`,
  `ir/step.ts:47-62`). What actually remains is **~4 hand-spelled movement lists** that do not yet
  derive from those bases: `ir/analyze.ts:60`, `tail/child-shape.ts:293`, `ir/strategies.ts:210`,
  `tail/bulk.ts:178`. One family per commit, gated on byte-identical `test/L2-sql/` snapshots.
  **The old caution here — "`POSITION_MOVEMENTS` missing `otherV` must land with a test FIRST" — is
  DISCHARGED**, not pending: `POSITION_MOVEMENTS` includes `OTHER_V` (`tail/path.ts:49`) and
  `test/L4-addendum/where-under-otherv-context.feature` is the test. The rule it illustrates still
  holds: do not fix a membership bug inside a rename. See item 22b for the citations that never caught
  up. → [tinkerpop-core-engine-alignment](./2026-07-29-tinkerpop-core-engine-alignment.md) §6
- **`feature-support-matrix.md`'s legend over-promises, and one of its claims is now false.** Two
  separate defects. (a) Generate the capability ratchet's per-step shape strip
  (`test/L5-properties/capability.test.ts`) into the matrix so its ✅ claim matches item 5c. (b) The
  matrix states **"There are currently NO 🐞 rows — no form is known to mis-execute"** (line 19), which
  is untrue: items 2 (`choose().option(Pick.none)`, the filter-body label rebind), 20 (the group-value
  barrier scope) and 21 (`union` emission order) each name a live wrong answer, and item 22 adds 33
  more. The legend points readers at `known.ts` for the diagnoses, and `known.ts` is EMPTY — so the
  mark has no source of truth. Either wire 🐞 to this index's wrong-answer items or say plainly that
  the matrix does not track them.
- ~~**Deterministic variant/record slicing shipped UNPINNED**~~ — **HALF LANDED `82d011b`, and the
  other half turned out not to be true.** The VARIANT slice is genuinely deterministic and is now
  pinned as three `ordered` scenarios in `variant-rowops.feature`. The RECORD slice is **not**:
  measured, a record stream carries no `encounter` column at all (the projection CTE's column list
  drops it), so `recordSlice`'s `orderByEncounter` is INERT and
  `g.V().project('n').by('name').limit(2)` picks a different pair under perturbation. Deliberately
  left unpinned — see the new item below. Also closed a harness gap on the way: L4 could express
  `v[marko].id` but not `v[marko]`, so no addendum scenario could assert an ELEMENT result at all;
  `canon` now compares a decoded element by id, which is upstream's own rule.
- **L5's known-bad state is scattered across THREE hand-curated artifacts in two languages** —
  `known.ts` (`KNOWN`, fast-path divergences), `capability-baseline.ts` (`KNOWN_RAW_WITNESSES`, raw
  failures from generated compositions) and the `knownBroken` entries buried inside `laws.ts`
  (metamorphic violations — the highest-severity class, and the easiest of the three to miss because it
  is not a file of its own). Each has exactly ONE reader.
  **Re-measured 2026-07-31 and two of the three are now empty, which sharpens the item rather than
  closing it:** `KNOWN` is empty (intended), and `laws.ts` has the `knownBroken` **field declaration at
  line 47 and zero entries** — so it is a type, not a list. `README.md:29` still advertises "two
  diagnosed contexts carried as `knownBroken` … both open in `docs/outstanding-work.md` item 0"; both
  the entries and item 0 are gone, and all four defects that README names probe clean at HEAD. Fix the
  README as part of this. Only `capability-baseline.ts` holds live entries (2, one stale — item 22c). **The cost is measured, not hypothetical:**
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
- **The anchor rule is enforced by a script, not by the type system.** `mise run arch` statically
  checks the REACHABILITY half (no Pass reaches `ChainFacts` or the fast-path layer) by walking LSP
  call hierarchy, which is the enforceable part; the bright line itself — *a Pass may CONSULT shape, it
  may never CONSTRUCT it* — is still not expressible in a type, so a Pass that constructs shape is
  caught by a build step rather than by the compiler. This is the shape doc's §8 step-5 "independently"
  ask, and it is a real gap, not a restatement of the gate.
  → [shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md) §8
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
- ~~**`tree()`** → parked (JS GLV stubs `DataType.TREE`, zero conformance value)~~ → **PREMISE FALSE,
  moved to P2·24 (2026-07-31).** The vendored client has a complete bidirectional `TreeSerializer.js`
  (serialize + async deserialize, doc-commented *"authoritative from Java TreeSerializer"*), and
  `tree()` is the **largest single unimplemented-step bucket in L3 at 12 scenarios**. Neither half of
  the parking reason survives.
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
