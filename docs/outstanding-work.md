# Outstanding work

The de-duplicated index of open work across the `docs/` corpus. **Each item sets the scene — what,
why, where to start — not a spec.** The linked doc holds the rationale; the picking agent does the
validation and design. Live per-step capability: `feature-support-matrix.md`.

**Refreshed** 2026-07-31 · **L3 1647 / 2267** (`l3-state.json`; fewer UNIQUE names than that — the
collision is expected, see won't-do) · census **0 `crashed`** · `known.ts` empty (intended) ·
`capability-baseline.ts` 2 entries, one stale (22c).

Item numbers are stable IDs; landed items are DELETED and their numbers not reused, because code
cites them. **A deletion must sweep its citations** — item 0 was deleted with four left standing (22b).

> **Verify an item's premise before picking it — this index has been stale in BOTH directions.** A
> 10-line probe that compiles the traversal and greps the SQL is usually enough. If it is partly
> landed, rewrite the line; don't close it silently.

**Two instrument facts that shaped this refresh.** (1) The L3 telemetry's deferral buckets only rank
traversals that THREW — they are blind to a scenario that failed because we returned rows where the
spec demands an error. Read `scenarios[].firstFailingStep` too; that blind spot hid 60 scenarios
(item 22). (2) **L5 found nothing**: `L5-random` plus five fixed seeds (5/11/27/91/143 at
`L5_RUNS=3000`) were 35 pass / 0 fail every run. The generated oracles are saturated at the current
generator depth — the lattice covers 54 of the corpus's 131 step names — so **growing the generator
now beats running it**.

**Ordering — floor vs ceiling.** L3 is the floor; the ceiling is generic lowering that composes the
full nested grammar at any depth (`src/compiler/steps/CLAUDE.md`). P1 raises the ceiling — each item
unblocks a *family*; one-off step impls are matrix-fill, lower.

---

## P1 — ceiling-raising generic-substrate lifts

**Ranked entry point.** Numbers are IDs, not an order. **21**'s T3 (needs a hand-derived L4 pin
first; T1+T2 landed) → **2** →
**17**'s `tail`/`sample` + **28** → **29** → **3**'s `times(n)` unroll. Both fail-closed
VIOLATIONS landed 2026-07-31 — item 27's seven `Scope.local` slices (one argument decode,
`sliceOf`) and item 22's 24 write-path non-validations (`steps/write/validate.ts`). So did the
root-materialization ordering gap (was 26): `rootOrder` (`tail/materialize.ts`) is now the one
place the wire's row order is decided, all eleven roots ask it, and two L4 scenarios pin it under
`test:perturbed`. **That is what makes 21 measurable at all**, and it stops masking 20's worklist
downstream of the root — the perturbed census moved 324 → 321 emission-order changes, the honest
size of the corpus's exposure to a defect that was large in SHAPES and small in traversals.

22. **Validation the spec MANDATES and we do not perform — the write family LANDED; 9 scenarios of
   three unrelated causes are left.** 60 L3 scenarios fail AT the error-assertion step because we
   returned a result where a throw is required. The 24 write ones went in one change (2026-07-31,
   L3 1623 → 1647): `steps/write/validate.ts` holds TinkerPop's `ElementHelper` identifier rules and
   is reached from the four storage waists; a `MergeRole` on `MergeSpec` lets one check cover all
   three maps; `validateNoOverrides` runs statically AND in the create branch. The remainder is not
   one family — **6 = a string step in `Scope.local` over a LIST passes the list through** (the same
   missing "member count" authority as item 17's `tail`), **2 = `groupCount()` taking two `by()`s**
   (a modulator-arity rule, item 23's ground), **1 = `property(single,k,traversal)`**. *Low each.*

2. **Universal child-seam acceptance.** Element, scalar, list, count, branch, `repeat`,
   `as()`/`select(label)` and option-map bodies compose everywhere. **Two of the four things this item
   called wrong answers were the REFERENCE's answers** — probed 2026-07-31 against the vendored
   `gremlin-core` and now pinned in L4 (`child-body-labels.feature`, `nested-branch-arms.feature`)
   with the file and line each was read from, so they cannot be re-filed:
   - a label rebound inside `filter()` is NOT a dropped row. TinkerPop routes by variable location in
     `where()` and only where() (`WhereTraversalStep.configureStartAndEndSteps` installs a
     `WhereStartStep`); `filter()` builds a plain `TraversalFilterStep`, so a leading `as("a")` is an
     ordinary rebind and `filter(__.as("a").out("knows"))` ≡ `filter(__.out("knows"))`. The two hosts
     MUST disagree, which `src/compiler/steps/CLAUDE.md` already said.
   - `choose().option(Pick.none, …)` with an unproductive choice takes the none arm and we do too
     (`pickBranches` falls back to `Pick.none` whenever nothing matched). The only-`Pick.none` spelling
     the item named DEFERS with a clear message rather than answering, so nothing in that family
     mis-executes.
   **What is genuinely open, all of it fail-closed:** map/group/record child bodies (→ 5);
   `group().by(project(…))` composite keys; a child-in-child body whose inner child is not
   element-shaped (`local(__.local(__.out().values('n')))`); and the only-`Pick.none` option-map
   deferral above.
   Start `steps/tail/{child-shape,child,scalar-arm}.ts`. **Two invariants:** the ONE arm triage is
   `classifyBranchArms` (two documented exceptions); a renderer that cannot carry alias columns must
   DECLINE, not answer. **Medium** (was High — the wrong-answer half evaporated on measurement).
   → [carried-schema-and-projection-reentry](./2026-07-14-carried-schema-and-projection-reentry-plan.md),
   [group-value-generic-seam](./2026-07-18-group-value-generic-seam-plan.md)

17. **Share the row-ops — slice/dedup family LANDED; `tail`+`sample` are the cheap remainder.**
   `reprojectRows` + `globalRowOps()` (`tail/barrier.ts`) took those five ops from 17/50 gaps to 4/50.
   Re-measured at 15 ops × 10 producers = **150 cells, 86 gaps**, of which **`tail`+`sample` are 19 and
   fall to ONE lift of the mechanism already built** — `tail` is the one window `sliceOf` (`ir/step.ts`)
   deliberately does NOT decode, because "the last n" is an offset only once something supplies the member
   COUNT; supply that and `tail` joins `SLICE_STEPS` and `limitOffset` renders it. `select.ts`'s
   `recordWindow` is the shape of the answer for the one stream whose count is static.
   **`tail()` does not exist on the ELEMENT stream at all** though `filter/Tail.feature` has 22
   scenarios; `sample()` exists nowhere. The other 63: 42 current-object aggregates (ARCHITECTURAL —
   they need an "expression denoting the traverser's value" authority), 7 `order`, 6 `is` (mechanical
   now), 5 `unfold` (correctly per-shape forever).
   **The trap that cost 42 corpus traversals:** a shape table is a Map where the LAST duplicate key wins
   and `dispatchShapeTail` consults ONE handler per name, so spreading a shared op into a table that
   already owns that name REPLACES the incumbent — and a handler that "declines" falls to the FALLBACK
   THROW rather than through. Compose with `firstOf`. The variant tail now takes `globalRowOps()` verbatim
   (its re-declared copy was the one missing the `Scope.local` decline); `lowerScalarRows`
   (`scalar.ts:640`) is the one tail never transposed to a dispatch Map. **Low-Med.**

28. **`expandRepeatBody` is a SEVENTH specialized lowering and the only one the differential cannot
   see.** `branch.ts:800`'s gate means the flat expansion always wins where it recognises the body, and
   its own header calls it *"a second implementation of what the StepFns already do"* — but it is not a
   `FastPath` object, so it has no config flag and no `equivalentWhen`; the six real ones all do. Add
   `repeatBodyExpansion` to `FastPathConfig` and gate `flatOk`. **Do this BEFORE item 3's unroll.**
   *Medium-High.*

29. **The barrier side of the carried-role contract has no policy table.** `LAYOUT_ROLE_POLICY`
   (`context/context.ts:288`) is total over `keyof TraverserLayout` — for ARM MERGE only.
   `dropLayoutAtBarrier` (`:617`) hand-builds a literal with four fields and every other role is
   optional, so **a role added tomorrow compiles clean and is silently dropped at all 15 barrier sites**
   — the 33%-of-defects class. A `BARRIER_ROLE_POLICY` beside the merge table also makes the **17
   `carried-state × barrier` deferral sites** answerable in one place. Not one of Phase 1's two
   non-goals (both merge-side). *Medium.*

3. **`repeat()` residuals.** The body compiles through the ordinary StepFns into a keyed child relation
   (`tail/keyed.ts`). **The gate is NOT "whatever `lowerElementSteps` accepts"**: a per-iteration GLOBAL
   barrier observes the whole frontier and the generic StepFns would lower it per-origin, answering a
   different question — the gate is the row-local vocabulary (`isElementChildStep`).
   **A barrier body under a fixed `times(n)` could be UNROLLED into n generic phases** — the single
   biggest L3 mechanism at **41 queries** (`order` 15, `limit` 7, `local` 5, `dedup` 4, `range` 4,
   `groupCount` 3, `sample` 2, `group` 1; plus 8 on the adjacent row-local gate), unchanged across three
   measurements. *Medium.* Also: named-loop `repeat("a",…)` needs named loop counters; `as()` in the body
   rebinds per iteration so it stays out; `path()`/`sack()` bodies stay with the flat expansion (→ P3).
   → [deep-seam-migration-roadmap](./2026-07-18-deep-seam-migration-roadmap.md) #5,
   [foldable-carried-column](./2026-07-24-foldable-carried-column-plan.md)

20. **Results ordered only because SQLite scanned the convenient way.** `mise run test:perturbed`
   (`PRAGMA reverse_unordered_selects`) — a failure there is never a flake. Perturbed census **41 → 8**,
   suite 18. Three mechanisms landed; left:
   - **A GROUP VALUE body's barrier runs in the wrong SCOPE — a live silent wrong answer, not an
     ordering fix.** `group().by(T.label).by(__.values('name').order().by(desc).fold())` returns
     vertex-id order while the same `order().fold()` at ROOT is correct: the value body compiles
     per-origin, so each partition holds ONE name and the sort is a no-op. The reference splits the
     value traversal — last barrier is the group's REDUCER, everything before it per-traverser. Item 5's
     ground; **do not fix it by changing the ORDER BY.** *Med — both scenarios assert `unordered`.*
   - **A RECORD stream carries no `encounter`**, so `recordSlice`'s `orderByEncounter` is inert and a
     record slice picks an arbitrary window. *Med.* · `aggregate('x').by(__.out().order().by('name'))`
     reads child rows in scan order. *Low-Med.* · Three WRITE traversals via row-at-a-time `write.ts`.
   - `g.V().repeat(__.both()).times(3).range(5,11)` is EXPECTED (item 4's `repeat`/`match` boundary).
   - ~15 remain in `test/compiler/`, `test/L2-sql/` and the census — each needs reading to decide
     whether the ASSERTION is over-strong or the traversal under-determined. **Do not bulk-relax them**:
     the `order().fold()` block looked exactly like test-side fragility and was a real defect.
   **Clearing these makes `test:perturbed` a gate**, which is the point of one item.

21. **A `union`/`choose` ARM's barrier observes the branch's whole input. T1+T2 LANDED 2026-07-31
   (L3 1647 → 1648); T3 and T4 open.** `BranchStep.standardAlgorithm`'s `hasBarrier` decides arm SCOPE
   and emission order together, and only `union`/`choose` extend `BranchStep` — `coalesce`/`optional`
   are per-traverser by class and our lowering of those is CORRECT.
   **What landed, and it needed no new lowering substrate** (the arm goes through the ordinary engine
   over the branch's input, scalar or element): `armCollapses`/`BATCHING_BRANCHES`/
   `COLLAPSING_BARRIERS` (`ir/step.ts`); `layoutArmProjection` resolving the merged carried schema per
   COLUMN, so an arm that lost `bulk` to a barrier and gained an alias after it merges cleanly
   (`collapsedArmProjection` existed for a day and was subsumed); `collapsedArmAdmissible` declining a
   live path/sack/fromV/origin at the branch input; and `gateArmOnNonEmptyInput`, because an arm that
   received no traversers emits nothing even though `count()` over an empty stream is 0.
   **Open, in the plan's order:**
   - **T3, the slice/order arms.** `union(__.out().limit(1), …)` batches in the reference too
     (`RangeGlobalStepContract extends FilteringBarrier`), but our per-origin form is pinned the WRONG
     WAY by our own tests and by no corpus scenario. **Needs a hand-derived L4 pin BEFORE any code**,
     which is exactly why those step names are OUT of `COLLAPSING_BARRIERS`. T3 also owns the
     RECURSION `armCollapses` deliberately lacks: a barrier sitting only inside a NESTED branch arm
     sets `hasBarrier` in the reference and does not here.
   - **T4, emission order** — the original framing of this item, and it comes last: once an arm
     batches, arm-major over the whole stream is CORRECT and is what we already emit. What remains is
     the barrier-FREE case, needing the parent's encounter as a distinct carried role (the child
     ordinal is `ROW_NUMBER() OVER ()` — it identifies a traverser without ordering them).
   **No fail-closed gate covers what T3 has not reached**; nothing named `verifyBranchArmBarrierScope`
   is in `src/`. **Medium** (was High — the two live wrong-answer families are closed).
   → [branch-arm-barrier-scope](./2026-08-01-branch-arm-barrier-scope-plan.md) — **read §1 and §6
   before proposing anything**

5. **Non-element child bodies.** Map and record bodies compile. **Two premises that were FALSE — do not
   rebuild on them:** the element terminal does not need a relational form, and `project`/`group`/`path`
   already HAVE relational forms (they were blocked only on having no child PROVIDER). Open: a **GROUP
   child body** (one map PER PARENT — threading an ORIGIN dimension through `lowerGroup` needs a
   per-origin analogue for each of its 6+ value modes; demand is 2 traversals, so start with a bare
   `groupCount()` body, which has exactly ONE); a **PATH child body** (path-history-substrate ground);
   `valueMap(true)`/`elementMap`, zero-demand and mechanical. *Low-Med.*
   **`ChildShape` is deliberately NOT widened to 'map'** — admitting 'map' would tell the branch triage
   a map ARM is mergeable when no merge covers one, turning a clean deferral into a wrong answer.
   **Group failure taxonomy** (128 traversals mention group; 88 compile) — the label hides unrelated
   causes: 4 scalar-parent (5c), 3 side-effecting `groupCount("a")` (P3), 3 barrier in a `repeat()` body
   (3), 2 `by(traversal)` needing fold/sideEffect in the key (2), ~2 bare `groupCount()` child body.
   → [carried-schema-and-projection-reentry](./2026-07-14-carried-schema-and-projection-reentry-plan.md)

5c. **PARENT-SHAPE uniformity — a step works over an element stream but not a scalar/list/path/map one.**
   **84 failures**, a lower bound (268 traversals never reached shape dispatch). **NOT one substrate fix
   and NOT one item** — probed, some steps already compose over a scalar parent (`groupCount`, `choose`,
   `coalesce`, `math`) and others do not (`group`, `none`, `repeat`). By MECHANISM, not parent shape:
   ~10 set-drift, ~14 `ResultStream` residue, ~30 row-ops copied per shape (**item 17 first**), ~35
   genuinely per-step — the first three cut ACROSS parent shapes, so the old "one shape at a time" axis
   is wrong.
   **The deferral surface by root cause** (258 typed deferral throws of 488 `throw` sites; sites/L3
   scenarios), ranked by "one lift, most sites cleared": **D carried-state × barrier 17 → item 29** ·
   **C's `path()` through a mixed shape, 8 of branch triage's 20 → one lift** · **F `by()`/modulator
   42/21, the highest site count here → ~24 collapse into a shared "resolve a by() to a sort/projection
   Expression over any stream" seam** (`classifyBy` is the one decode but its `ByClass` has no
   `'column'` arm, so every host re-decides) · **A shape-tail ceiling 14/85**, the highest ratio at 6:1,
   which is item 17's matrix. Then E repeat-body 26/66 (3), G write 31/92 (10), K label 17/11, B
   child-seam 13/32 (2/5).
   → [shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md)

22b. **Item 0 was deleted while four citations still point at it — and the defect it named is FIXED.**
   `POSITION_MOVEMENTS` (`tail/path.ts:49`) includes `OTHER_V`, with
   `test/L4-addendum/where-under-otherv-context.feature` as its test. Still asserting otherwise:
   `src/compiler/ir/step.ts:38`, `test/compiler/step-vocabulary.exec.test.ts:11` (whose test now asserts
   a locally rebuilt set, not the real `POSITION_MOVEMENTS`), `test/L5-properties/README.md:29`, and
   `docs/2026-07-28-property-based-testing-l5.md`. *Low as code, Medium as integrity.*

22c. **The capability ratchet cannot tell "fixed" from "not drawn".** `capability.test.ts` computes
   `stale` only over witnesses the seed DREW, and logs rather than fails — all six runs this refresh
   printed *"2 known raw witness(es) not drawn by this seed"*. Re-run directly, entry 1 of
   `KNOWN_RAW_WITNESSES` now executes cleanly; entry 2 still reproduces. The list is TWO fixed strings —
   run both unconditionally. Entry 1 also carries no diagnosis, which its own header forbids. *Low, but
   it is the ratchet-rots-silently mechanism.*

23. **27 scenarios where we DO reject and only the WORDING differs — several are deferrals mis-phrased
   as permanent gaps.** We refuse `aggregate('x').by('name').by('age')` but say *"…not yet supported"*
   where the spec asserts *"Aggregate step can only have one by modulator"*. **The wording is cheap; the
   defect is "not yet supported"** — two `by()`s is invalid Gremlin forever, and spelling it as a
   deferral puts it in the telemetry that RANKS THIS INDEX. **Not all 27 are free:** where we reject for
   the same reason it is a rename; where the reason differs it is a real gap that merely coincides
   (`choose().option()`, `asBool`/`asDate`/`asNumber` over a list). *Medium.*

0b. **Apply-contract consumers.** `ModulationContract` covers nested property keys/values, merge-map
   keys/values and `AddVertexStep` labels/parameters via `ElementReadDriver`. Remaining:
   `ListFunction`/`ConjoinStep`, plus whole-map `MergeStep`/`MergeElementStep`/`MergeEdgeStep` bodies,
   which need a map-shaped rather than scalar driver. *Medium-High — extend the declared contract, not
   another argument evaluator.*

0f. **We carry a patch against antlr4ng's prediction DFA — WATCH ONLY.** antlr4ng keys a decision's DFA
   states on `ATNConfigSet.hashCode()` with no equality check, so a collision conflates two
   configuration sets and one query permanently breaks another (in a DO, for every later request the
   isolate serves). Fixed locally by `patches/antlr4ng@3.0.16.patch`;
   **[mike-lischke/antlr4ng#109](https://github.com/mike-lischke/antlr4ng/pull/109) is OPEN**. Until it
   ships keep the patch and the `overrides.antlr4ng` pin — a bump silently drops it
   (`test/L1-corpus/parser-state.test.ts` guards the mechanism). Close-out: bump, drop the patch, keep
   the test, delete this item. *High while it lasts.*

0e. **Nothing detects a stale `parser/`.** A byte-compare against a fresh generation must first resolve
   a ref mismatch: the generate script sources `origin/master` (moving) while the submodule pins a
   gitlink, so a naive comparison is only accidentally green today. *Medium — measurement integrity.*

1. **List members frame as bare values, not elements.** `AliasEntry` does not record the member shape,
   so a path/element-list label cannot frame its members as vertices. *Low-Med.*

4. **Canonical-emission-order Stage C — residual.** A bare re-source `V()`/`E()` arm carries no
   `encounter`, so `armFansOut` and `positionArmFansOut` fail closed; minting `encounter = new element
   id` at a re-source is the one missing primitive. `repeat()`/`match()` stay outside by design. ONE
   slot, `TraverserLayout.encounter` — do not derive a "two encounters" reconciliation. **Low-Med.**
   → [canonical-emission-order](./2026-07-19-canonical-emission-order.md)

4d. **`within()`/`without()` folded-traversal residuals.** A UNION-rooted operand (~4 queries) —
   widening the rooted test to admit an all-rooted union was tried and **REVERTED**: it compiles but
   returns unfiltered rows, so diagnose why the fold's shape does not reach the operand intact before
   re-widening. Also a CORRELATED list operand, inexpressible by a standalone sub-read.
   **Scoping trap:** `json_each` exposes a column named `value` and `hasProp` passes the UNQUALIFIED
   `value`, so both sides bind to json_each and `within` silently returns everything — keep the operand
   LEFT of `IN (SELECT …)`.

6. **`order().by()` of paths (path natural-order comparability).** Unlocks the Orderability cluster.
   **Medium.** → [path-history-substrate](./2026-07-18-path-history-substrate.md)


---

## P2 — feature / conformance buckets

7. **`match()` generic patterns.** What remains is STRUCTURAL, not shape: a pattern not starting with
   `as()` (6), 0-root-variable patterns (3), `or`/`not`/nested-match, a LIST-shaped end var, and
   `where(var,P)` on a scalar-bound var (a downstream alias-compare gap, not a match one). **Medium.**
   → [conformance-structural-bets](./2026-07-12-conformance-structural-bets.md)

7c. **Predicate operands that are TRAVERSALS — narrow tails.** `within`/`without` over a MULTI-VALUE
   operand is not the cheap wiring it looks: `predicateSql` renders each operand as ONE element of a
   comma list, so a set-valued operand needs `expr IN (SELECT …)`, i.e. a scalar-vs-set distinction in
   the pure SQL layer. Also widening `isReSourced` (a narrow proxy for "traverser-independent" that
   misses a union of independent branches); the `none()` host; a scalar-parent `is()`. *Low.*

7e. **Correlated predicate fast path — one hand-rolled aggregate left.** `correlatedReduce`'s E-form
   aggregate still hand-writes an `edgeProperties.as('xep')` join (`prefix/predicate.ts:95-97`); its
   COUNT sibling (`:81`) goes through `compileCorrelatedChild`. Grep tests + corpus for that shape
   first and decide whether to extend it or let it fail closed — do NOT silently regress a working
   shape. Bare `out()`/`in()` stays out deliberately (the value would come from the neighbour vertex).
   *Low.* → [correlated-child-rendering](./2026-07-17-correlated-child-rendering-plan.md) (landmark
   paths predate the 2026-07-23 restructure and the 2026-07-29 rename — read it through the rename map)

8. **Graph-algorithms layer.** Algorithms as `call()` services + the four OLAP step names as desugar
   Passes. Nothing built; PageRank is the proof-of-concept; 6 open research questions. **Medium.**
   → [graph-algorithms](./2026-07-24-graph-algorithms-plan.md)

9. **Side-effect readback predicates — `where(within/without('x'))`.** The `aggregate().where(without('x'))`
   dedup idiom; no aggregate-readback exists. **Medium.**
   → [side-effect-state](./2026-07-13-side-effect-state-plan.md)

10. **`addV` mid-chain + read-tails-after-write.** Gates a write-conformance cluster. **Medium.**
    → [compiler-consolidation](./2026-07-16-compiler-consolidation-plan.md) §6

11. **Federation tail:** CF-parity test on the DO harness (Low-Med); map-valued injection for
    mid-traversal federation (Med); import-a-graph (Med/Large); federated *traversal* via local scratch
    (Large); async failure/timeout/retry policy (Low-Med).

12. **Strategy completion tails** — `SubgraphStrategy(vertexProperties)` (6 scenarios),
    `PartitionStrategy` meta-properties + partition-aware upsert (7), nested-body descent. **Medium/Low.**
    → [with-strategies-exploration](./2026-07-13-with-strategies-exploration.md)

13. **`with(...)` / `OptionsStrategy` sugar — remaining hosts.** Selective token subsets
    `with(tokens, ids|labels)` (needs a `by(unfold)` that also flattens the value lists), and
    `index().with(WithOptions.indexer, map)` (needs 14). **Low-Medium.**
    → [with-strategies-exploration](./2026-07-13-with-strategies-exploration.md) §0

14. **`index()` step** — unimplemented. Default indexer turns `[e0,e1,…]` into `[[e0,0],[e1,1],…]`; the
    map variant needs 13's selector. **Low-Medium.** → [seam-reuse-audit](./2026-07-13-seam-reuse-audit.md)

15. **Multi-key `cap('x','y')` + cap-of-group unfold.** **Low-Medium.**
    → [side-effect-state](./2026-07-13-side-effect-state-plan.md)

16. **W4 — multi/meta-property schema rework → `Cardinality.list/set` writes.** Only meta-property
    *typing* is touched today. **Medium.**
    → [conformance-structural-bets](./2026-07-12-conformance-structural-bets.md) (W4)

19. **Multi-label vertices — LANDED except two narrow tails** (60 of 67 in-scope scenarios pass).
    `labels()` as a CHILD BODY (3 scenarios — not label work, it is item 2 meeting a fan-out body), and
    `elementMap()` on EDGES (3, a pre-existing gap needing the IN/OUT direction tokens).
    → [multi-label-elements](./archive/2026-07-30-multi-label-elements-plan.md)

19b. **No provider can declare a multi-label DEFAULT, so `@MultiLabelDefault` is untestable for
    everyone — an upstream gap and a good fork contribution.** All three GLVs skip its 10 scenarios.
    Verified in `gremlin-core`: `TraversalHelper.isMultilabelEnabled` reads the source-level `with()`
    option and nothing else (`.orElse(false)`), so the reference default is ALWAYS single-label whatever
    a graph's `LabelCardinality` says, and no knob exists. **We are apparently that provider** — our
    `labelRegime` falls back to the declared cardinality, a deliberate divergence recorded at
    `src/api.ts`. A second symptom makes the declaration *unsatisfiable*: three untagged scenarios
    assert a BARE string `T.label`, so a blanket multi-label default forfeits them by construction —
    which is why we derive the regime from the graph instead. Raise as an ISSUE (a `gremlin-core` API
    addition, not a patch); precedent `apache/tinkerpop#3511` came from here and merged.
    → `patches/upstream/tinkerpop-03-multilabel-default-untestable.md`. *Medium — 10 scenarios for everyone.*

24. **`tree()` — 12 scenarios, the largest unimplemented-step bucket, parked on a false premise.** The
    won't-do said the JS GLV stubs `DataType.TREE`; it does not — the vendored client ships a full
    bidirectional `TreeSerializer.js`, so the result decodes end to end. `tree()` is a path-history
    consumer, so scope it against P3's recursive-path tails and item 6: the wire half is free, the path
    half is not. **Medium.**

25. **Unimplemented-step matrix-fill, with L3 counts.** `subgraph()` 6 · `branch()` 5 · `discard()` 4 ·
    `sideEffect()` 4 · `sample()` 3 · `index()` 2 (14) · `with()` 2 (13) · `asString()` 2 · `fail()` 2 ·
    `hasNot()` 1. Separately **`select(Pop.mixed).by(…)` is 5** — not a missing step but an
    unimplemented `Pop` mode. *Low each; listed so the counts are not re-derived every sweep.*

---

## P3 — narrow / fail-closed matrix-fill (correct-by-design today)

Each fails closed. Do only when a concrete scenario demands it.

- **`hasNot(key)`** — `not(__.has(key))` is the verified equivalent. *Low.*
- **`match()` cannot seed a CYCLE** — root detection is "a start var never used as an end", and a cyclic
  pattern has none. Pre-binding outside (`g.V().as('a').match(…)`) takes the supported zero-root path,
  so this only bites hand-written Gremlin. *Low.*
- **Recursive-path tails** — `cyclicPath`/`until`/`emit(pred)` with path, edge-inclusive bodies, mixed
  linear+repeat, recursive-regime `from()`/`to()`, multiple `by()`s, `order()` before a movement while a
  path is live. *Low-Med.*
  · **A path-REGIME change inside a child body emits malformed SQL — the one fail-closed VIOLATION here,
  so take it first.** `g.V(1).simplePath().project('a').by(__.repeat(__.in('knows')).times(2))` →
  `near "FROM": syntax error`: the child's `repeat()` retypes the carried path from linear `cols` to its
  own recursive accumulator while the parent still DECLARES the position columns, so `rel.c.p0` is
  `undefined` and splices an empty string. **Do not fix by declining at the repeat** — measured, the same
  condition holds for `local(__.repeat(…))` and `where(__.repeat(…))` under `simplePath()` and BOTH
  execute correctly, so a guard there regresses two working shapes. The fix is for a child body to
  restore the parent's path regime across the rejoin. *Med.*
  → [path-history-substrate](./2026-07-18-path-history-substrate.md)
- **Group re-entry matrix-fill** — element/property-valued inner keys+values, composite `project()` keys,
  `elementMap()` followers, `keys→SET`, `as()`/`order()` on a group. Extend `tail/group.ts` (item 2),
  don't dedup. *Low.*
  · **Productivity is not the aggregate.** An unreduced value traversal yielding nothing FILTERS the
  traverser (the key vanishes); `fold()` always yields, so its key survives with `[]`. So
  "implicit-collect ≡ fold" is TRUE for the aggregate and FALSE for productivity.
  → [group-value-generic-seam](./2026-07-18-group-value-generic-seam-plan.md)
- **Mixed-shape branch corners** — independent walls, not a family: node+edge in one branch; `path()`
  through a mixed-shape branch. *Low.*
- **Branch forms no merge covers** — a WRITE branch (the merges are read merges), and a branch whose
  shape is map/group/record/path. Throws naming the shape. *Low.*
- **A re-source `V()`/`E()` after `path()`/`sack()`/`otherV()`** — the carried fork through the CROSS
  JOIN is undefined. *Low.*
- **Write fail-closed walls** — `addE`/`mergeE` endpoint traversals past a movement/branch, map-valued
  merge drivers, nested keys/values. *Low.*
- **`has(k, eq(collectionLiteral))` + meta-property typing.** *Low.*
- **`sideEffect(__.…)` + `withSideEffect(...)`** and **`branch()`** — distinct families, no consumer yet.
  *Low.* → [side-effect-state](./2026-07-13-side-effect-state-plan.md)
- **Foldable-sack residuals** — fan-out `by(__.trav)` in a repeat sack body, mutate `sack(op)` in a branch
  arm, `withSack()` at a `union()` source, mixed sack+element `until`/`emit`, `sack(BiFunction)`. *Low.*
  → [foldable-carried-column](./2026-07-24-foldable-carried-column-plan.md)
- **`repeat`/`match` emission order** — a recursive CTE can't window across iterations. *Low.*
- **L3 ratchet hygiene.** `tags.ts` names which of three exclusion KINDS each tag is, and
  `runner-skips.test.ts` gates the kind that depends on someone else's code. **Do not descope
  GraphComputer or the `io` source**: 4 of GraphComputer's 6 scenarios are the OLAP names item 8 will
  serve (that exclusion should NARROW, not harden), and `io(...).read()` (6, in scope and failing) is a
  real capability — unlike `io().write()`, which needs a filesystem a DO does not have. *Low.*

---

## Product / operations (not compiler features)

- **Real Cloudflare deploy** (only `--dry-run` wired; code is CF-ready). *Medium.*
- **Bearer-token auth per graph** (no auth surface yet). *Medium.*
- **Untyped GraphSON v4 response encoder** — makes the shipped `/docs` panel usable; ~½–1 day. *Medium.*
  → [graphson-untyped-scope](./2026-07-13-graphson-untyped-scope.md)
- **Multi-request `g.tx()` session state** (needs DO session state). *Low-Med.*
- **Per-request implicit transaction** (likely moot — DO single-threading). *Low.*
- **Typed GraphSON (`types=true`)** — gated on a type-faithful JSON consumer. *Low.*

All → [phased-roadmap](./2026-07-11-phased-roadmap-plan.md) unless noted.

---

## Internal debt / give-backs (Low)

**There is no TODO/FIXME/XXX/HACK in `src/compiler/`, `src/sql/` or `src/execute.ts`.** Debt here is
typed `throw` deferrals and prose, so a marker grep finds nothing and proves nothing — read the
deferral clusters in 5c instead.

- **A `Scope.local` slice over a SCALAR or ELEMENT-tail value still declines rather than answering.**
  The argument decode is now one function (`sliceOf`/`isLocalScope`, `ir/step.ts`) and the rendering one
  more (`limitOffset`, `plan/plan.ts`), so a host can no longer read the scope token as a row count — but
  three hosts still have no member-scoped FORM. `values('name').limit(Scope.local,1)` throws where the
  reference is identity (a String is not a Collection), and it cannot simply become identity: the same
  stream carries list-valued properties, for which it is a real member slice. `dedup(Scope.local)` on an
  element stream is the same shape of gap. The missing authority is "how many members does this value
  have", which is also what keeps `tail` out of `SLICE_STEPS` (item 17). *Low-Med.*
- **A record sliced down to ZERO fields defers** — `project('n').by('name').skip(Scope.local,1)` should be
  an empty map per traverser; `materializeRecordRoot` has no zero-field form, so it throws. Needs the
  record shape and the framer to agree that `{}` is a value. *Low.*
- **The remaining `as any` reads are a rename-safety hole** — a field read a future LSP rename yields
  `undefined` for, invisibly to `tsc`. 26 in `src/` (down from 35 after `cb8eabf`), most benign row/bind
  casts; the rename-unsafe FIELD reads are `(s as any).productiveBy` (`tail/projection.ts:91`),
  `(a as any).nested` (`tail/child-shape.ts:214,239`) and `(pred as any).values` (`tail/operand.ts:162-191`).
  **This item has been cleared once and refilled from elsewhere — treat it as a standing sweep.**
- **§6 vocabulary-set derivation — ~4 movement lists left.** The reducer list, `PATH_FAMILY` and the
  movement BASES all landed; what remains is `ir/analyze.ts:60`, `tail/child-shape.ts:293`,
  `ir/strategies.ts:210`, `tail/bulk.ts:178`. One family per commit, gated on byte-identical
  `test/L2-sql/` snapshots. **Do not fix a membership bug inside a rename.**
  → [tinkerpop-core-engine-alignment](./2026-07-29-tinkerpop-core-engine-alignment.md) §6
- **L5's known-bad state is split across artifacts with one reader each** — `known.ts` (empty),
  `capability-baseline.ts` (2 entries) and `laws.ts`'s `knownBroken`, which is now **a declared type at
  line 47 with zero entries** while `README.md:29` still advertises two. **Do not merge them naively:**
  they are keyed differently on purpose (exact query / query→message Map / per-law PREFIX RegExp), all
  are hand-curated *because* each entry must carry a prose diagnosis, and `laws.ts` entries arguably
  belong beside their law. The honest shape is one file with a tagged union and a shared stale-entry
  check, keeping the per-kind matcher. Fix the README as part of it.
- **`feature-support-matrix.md` over-promises.** (a) Generate the capability ratchet's per-step shape
  strip into it so its ✅ matches 5c. (b) It states "There are currently NO 🐞 rows — no form is known to
  mis-execute", which is false (items 20 and 21's T3; items 2 and 22's write half were MEASURED clean
  on 2026-07-31), and the legend points at `known.ts`,
  which is empty — so the mark has no source of truth.
- **The `ResultStream` residue is the one worthwhile `Shape` retirement** — six orphan `Shape` kinds
  across 13 `toResultStream` sites, and ~14 of 5c's failures. Zero corpus demand, so it is a give-back.
  → [shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md) §9
- **The anchor rule is enforced by a script, not the type system.** `mise run arch` checks the
  REACHABILITY half; the bright line itself — *a Pass may CONSULT shape, never CONSTRUCT it* — is not
  expressible in a type. → [shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md) §8
- **Four module-boundary policy calls `mise run orphans` surfaces but cannot settle** — `alias.ts`'s
  symmetric accessor vocabulary, `isMidBarrierPoint`, `SCALAR_ROW_STEPS`, and the 86 `local-only`
  exports. Decide the policy once rather than drifting into it one sweep at a time. Related:
  `compile()`, the named public entry, is exercised only by tests (production uses `compilePlan`); no
  tool can move a SYMBOL between files (`tsc --lsp` advertises no `refactor.*` kind, measured) — the
  real question is whether `tsserver` is worth losing "the same TypeScript `mise run check` uses"; and
  making `parser/` a separately-built package is the one untested route to moving the three unused-code
  flags out of `scripts/lint.ts` into `tsconfig.json`, at the cost of a build step.
  → [lsp-tooling-plan](./2026-07-30-lsp-tooling-plan.md) §§2–4
- **`write.ts` row-at-a-time nested read** — no hand-rolled SQL is left in the merge region, so this is
  purely the execution-model question: `run` interleaves reads with INSERTs and reads back what it wrote,
  so a set-based form must decide match-vs-create for the whole driver set before writing. Both routes
  are verified; what is missing is the decision, not the rendering.
- **Review-fix duplication residue (C1/C2/C3 + D)** — property-list framing / tie-break / `PARTITION BY
  ordinal` dups; the `execute.ts` pre-parsed-`pmeta` divergence is latent-correctness. Status
  unconfirmed — treat as open. → [review-fix-plan](./2026-07-22-review-fix-plan.md)
- **Upstream `q`-kernel surface to lazyrecords.** → [q-kernel-sql-builder](./2026-07-12-q-kernel-sql-builder.md)
- **Land the TinkerPop fork's upstream payloads** (fork at `danielbodart/tinkerpop`): (1) `toNumeric`
  cannot produce a BigInteger — branch written and pushed, **not yet a PR**; (2) the generated cucumber
  `gremlin.js` references an undefined `uuid`, killing every UUID scenario — patch ready
  (`patches/upstream/tinkerpop-01`); (3) the cucumber port is hard-coded, the intermittent CI conflict
  with our conformance host — patch ready (`tinkerpop-02`); (4) Bun's `undici` shim lacks `Agent.close()`/`destroy()` —
  a BUN bug, worked around in `test/support/undici-shim.ts`, worth reporting. Do NOT "fix" (4) by making
  the client call `close?.()` — that skips real pool teardown. The fork is also the intended home for the
  non-conformant-client UUID/ISO-date shim (**opt-in**, never default).

---

## Superseded / won't-do (do NOT relitigate)

- **ansi SQL builders / CTE-recipe templates** → replaced by the `q` kernel.
- **Self-tuning `nodes.props` indexes / flat `edges.props` blob** → replaced by normalized
  `*_properties` tables + static covering indexes.
- **"L3 count has duplicate names → miscount"** → *not a bug*; distinct scenarios normalize to the same
  name across feature files. See `test/CLAUDE.md`.
- **Two-`union` merge / `optional` fast-path cleanup** → keep the fast path.
- **BulkSet "wire dead-end"** → corrected; wire bulking landed and is live.
- **Cross-DO federation via `ATTACH` coordinator** → rejected; per-request `call(federate)` landed
  instead (open tail in P2·11).
- **Client-side partition → DO routing** → out of scope; server-side soft filtering is the path.
- **Child-scope split-seed + 4-consumer migration** → superseded by the smaller carried-cols fix.
- **Phase 6's IR shape annotation** → killed on its own pre-committed criterion (56.8% `unknown` against
  a 10% ceiling). Lowering remains the sole owner of shape interpretation.
- **Platform walls** — regex UDFs, `typeOf` over some stored props, bigdecimal, lambdas → architectural
  limits, fail-closed by design. **OLAP/GraphComputer was on this list and should NOT have been**: the
  v4 language carries the four OLAP step names with no execution surface, and filling that is exactly
  item 8. The genuine wall is narrower — a `VertexProgram` execution surface (2 scenarios).
- **Channel-preservation Phase 1 (was P1·18)** → LANDED 2026-07-31.
  **Two DELIBERATE non-goals — do not re-file either.** `finishElementMerge` is not folded into
  `mergeArmRelation` (it keeps the arm's encounter in its declared slot and is the only merge that pads
  a ragged `path`, so folding it changes SQL for no correctness gain — revisit only if a THIRD spelling
  appears); and `bulk` is lost through `match()`, so a reducer after one counts ROWS rather than
  traversers — declared and probed, with no live wrong answer.
  → [channel-preservation](./archive/2026-07-28-channel-preservation-refactoring-plan.md)
- **`is(typeOf(GType.X))`: the group/path disagreement is KEPT deliberately.** `group` throws on a
  non-MAP assert where `path` returns an empty relation — what a non-matching assert MEANS is per-arm
  policy and both answers are defensible. **Do not "finish" this by picking one.**
- **`classifyBy`: `mapLocalOrder`'s `by(Column.keys|values)` scan stays hand-written.** `ByClass` has no
  `'column'` arm, and adding one is not a cleanup — a `{column}` by() classifies as `{kind:'none'}`
  today, so all 25 consumers read it as a BARE by() and a new arm silently reclassifies them.
- **"`asNumber(GType.BIGINT)` of a small value should downcast on the wire"** → our framing is already
  correct; the blocker is a vendored-harness defect (`feature-steps.js`'s `toNumeric` — `parseFloat`
  never throws, so its `BigInt` branch is unreachable). `data/BigInt.feature` expects the declared type
  PRESERVED. A blanket downcast would REGRESS the 5 siblings that pass today; fix it in the fork.

---

## Research / vision (reference — no build items)

- **[agent-memory-vision](./2026-07-17-agent-memory-vision.md)** — sibling `mogwai-memory` repo.
- **[graph-algorithms](./2026-07-24-graph-algorithms-plan.md)** — build spec for P2·8.
- **[conformance-structural-bets](./2026-07-12-conformance-structural-bets.md)** — strategic unlock map.
- **[cross-do-federation-prior-art](./2026-07-13-cross-do-federation-prior-art.md)** — federation prior-art.
- **[path-tracking-prior-art](./2026-07-12-path-tracking-prior-art.md)** — path prior-art for P3 tails.
- **[wire-and-storage-facts](./2026-07-25-wire-and-storage-facts.md)** — Map.Entry framing + MapStream.
- **[shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md)** — the shape/type
  vocabularies per layer and the bright line. **Refutes three cross-layer refactors — read before
  proposing one.**
- **[scalartype-refactoring-pattern](./2026-07-28-scalartype-refactoring-pattern.md)** — vocabulary-cleanup
  template; live targets are `AliasShape` member shape (item 1) and front-end tagged-token accessors.
- **[tinkerpop-core-engine-alignment](./2026-07-29-tinkerpop-core-engine-alignment.md)** — naming
  authority and rename map. The open `ir/rewrites.ts`/`ir/strategies.ts` partition needs a shared home.
- **[branch-arm-barrier-scope](./2026-08-01-branch-arm-barrier-scope-plan.md)** — the build spec for
  item 21, and the reason it is not the ordering item it was filed as. **This refresh had missed it
  entirely**, which is how item 21 kept a sizing its own plan document refutes in §6. Its §1 is the
  `BranchStep`/`FlatMapStep` class fact that decides which branch kinds can disagree with us at all.
- **[property-based-testing-l5](./2026-07-28-property-based-testing-l5.md)** — L5's oracle design space.
  **Stale**: it lists four defects against the deleted item 0, all four of which probe clean (22b).
- **[channel-preservation](./archive/2026-07-28-channel-preservation-refactoring-plan.md)** — closed;
  read it for the constitution a vocabulary migration passes.
- **[hand-rolled-sql-audit](./archive/2026-07-27-hand-rolled-sql-audit.md)** — closed; the measured
  method behind items 3, 5, 5c and 17.
