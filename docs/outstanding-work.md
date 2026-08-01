# Outstanding work

The de-duplicated index of open work across the `docs/` corpus. **Each item sets the scene — what,
why, where to start — not a spec.** The linked doc holds the rationale; the picking agent does the
validation and design. Live per-step capability: `feature-support-matrix.md`.

**This file records what is LEFT.** What landed is in `git log` and `docs/archive/`; a paragraph
about finished work cannot be picked up, so it does not belong here. A refresh that lands items
should make this file SHORTER.

**Refreshed** 2026-08-01 · **L3 1682 / 2267** (`l3-state.json`; fewer UNIQUE names than that — the
collision is expected, see won't-do) · census **0 `crashed`, 4 `nondet`**, perturbed census **4** ·
`known.ts` **1 entry** (repeat's two body routes disagree on a positional window) ·
`capability-baseline.ts` **1 entry** · L5 `L5-random` plus fixed seeds 5/11/27/91/143 at
`L5_RUNS=3000`: **36 pass / 0 fail on every run** (35).

Item numbers are stable IDs; landed items are DELETED and their numbers not reused, because code
cites them. **A deletion must sweep its citations** — item 0 was deleted with four left standing and
the sweep became an item of its own.

> **Verify an item's premise before picking it — this index has been stale in BOTH directions.** A
> 10-line probe that compiles the traversal and greps the SQL is usually enough. If it is partly
> landed, rewrite the line; don't close it silently.

**Ordering — floor vs ceiling.** L3 is the floor; the ceiling is generic lowering that composes the
full nested grammar at any depth (`src/compiler/steps/CLAUDE.md`). P1 raises the ceiling — each item
unblocks a *family*; one-off step impls are matrix-fill, lower.

---

## P1 — ceiling-raising generic-substrate lifts

**Ranked entry point.** Numbers are IDs, not an order.
**[write-path](./2026-08-01-write-path-plan.md) §2** (silent wrong answers) → **2** → **17**'s
partitioned row-ops seam → **34** → **29** → **3**'s `times(n)` unroll (unblocked; its
precondition landed).

The write cluster — **10**, **16**, **0b**, the `write.ts` row-at-a-time entry in Internal debt — is
CLAIMED by a second agent again as of 2026-08-01; leave it alone. It has
one plan covering all of it: [write-path](./2026-08-01-write-path-plan.md), whose §2 is ranked second
here because it is wrong answers rather than gaps. P2·11's import-a-graph is deliberately NOT part of
it (different machine — `BulkLoader`, not the traversal write driver).

**No item below is a known wrong answer** except 20's group-value residual, 22's six per-member type
refusals, 31, 36 — **and the WRITE path, which this line denied until 2026-08-01**. The write half was
"measured clean" on 2026-07-31 about its validation REFUSALS; nobody had looked at graph STATE, and
eleven L3 scenarios fail at a `the graph should return N` step (three reproduced in
[write-path](./2026-08-01-write-path-plan.md) §2). Everything else fails closed, and the index's centre
of gravity is ceiling, not correctness.

22. **Validation the spec MANDATES and we do not perform — 7 scenarios left, and they need a RUNTIME
   type channel we do not have.** Of the 22 L3 scenarios failing AT an error-assertion step, **7
   mis-execute and 15 only differ in WORDING** (→ 23). The split is not in the deferral buckets —
   those rank only traversals that THREW — so read `scenarios[].firstFailingStep` and `errorMessage`;
   the recipe is *"`expected … to be an instance of Error`" ⇒ mis-execute, anything else ⇒ wording*.
   **What is left is ONE cause.** `trim/lTrim/rTrim(Scope.local)` over `[1,2]` and
   `asString()`/`asString(local)` over a null must throw PER MEMBER — `StringLocalStep.map` inspects
   each element's runtime class — and our `listStringTransform` renders one `json_group_array` over
   `json_each`, where a member's type is a SQL expression and there is no way to raise from one.
   **The blocker is that SQLite cannot raise a message from an expression**, so the honest routes are
   (a) an error CHANNEL — a sentinel column the framer turns into the throw — or (b) a static check
   where the member types are known, which covers every corpus spelling (all are `inject()` literals)
   but not the general stream. Neither is built; (b) is cheap and sound, (a) is the general answer and
   would also serve any other per-row runtime refusal. Plus **1 = `property(single,k,traversal)`**,
   unrelated. *Low each, but the six share a substrate question.*

2. **Universal child-seam acceptance.** Element, scalar, list, count, branch, `repeat`,
   `as()`/`select(label)`, option-map and scalar child-in-child bodies compose everywhere.
   **What is still open, all of it fail-closed:** map/group/record child bodies (→ 5);
   `group().by(project(…))` composite keys; the MANY-valued child-in-child
   (`local(__.local(__.out().values('n')))`) — deliberately excluded when the scalar case landed,
   since admitting it would change the classifier's cardinality contract, so it needs an
   all-cardinality child-in-child route rather than a wider producer; and an option map carrying only
   `Pick.none`. Also **36 of 17's 41 child-scope matrix gaps**, which are the `ChildShape` decline;
   `local()` is still the third-largest L3 deferral bucket at 10.
   **Two things this item once called wrong answers are the REFERENCE's answers, pinned in L4
   (`child-body-labels.feature`, `nested-branch-arms.feature`) — do not re-file:** a label rebound
   inside `filter()` is an ordinary rebind (TinkerPop routes by variable location in `where()` and
   only where()), and `choose().option(Pick.none, …)` with an unproductive choice takes the none arm,
   as we do.
   Start `steps/tail/{child-shape,child,scalar-arm}.ts`. **Three invariants:** the ONE arm triage is
   `classifyBranchArms` (two documented exceptions); a renderer that cannot carry alias columns must
   DECLINE, not answer; and a `first`-cardinality consumer may skip the encounter ranking only on a
   PROOF that the body cannot fan out, never because the stream happens to carry no encounter.
   **Medium.**
   → [carried-schema-and-projection-reentry](./2026-07-14-carried-schema-and-projection-reentry-plan.md),
   [group-value-generic-seam](./2026-07-18-group-value-generic-seam-plan.md)

17. **Share the row-ops — the GLOBAL half landed; the PARTITIONED (per-origin) twin has no seam at
   all.** `reprojectRows` + `globalRowOps()` (`tail/barrier.ts`) are spread into 5 of 11 dispatch tables.
   Their per-origin twin is **five private scalar-only functions** — `partitionedSlice`,
   `partitionedTail`, `rootTail`, `partitionedOrder`, `partitionedDedup` (`tail/scalar.ts`) — consumed by
   the 100-line if-chain `lowerScalarRows`, the one tail never transposed to a dispatch Map. All five
   share ONE skeleton: rank with `ROW_NUMBER() OVER (PARTITION BY origins ORDER BY <key>)`, filter on
   `rn`, rebuild, differing only in the order key and the `rn` predicate. **Four are a mechanical lift**
   onto authorities `reprojectRows` already uses (`streamPayloadCols`/`streamColumns`, `withRelation`);
   **`partitionedDedup` alone is architectural** — `PARTITION BY …, p.c.v` needs an expression denoting
   the traverser's VALUE, the same missing authority as the 42 aggregates below and as `Scope.local` in
   Internal debt.
   **Two measured matrices.** Child scope (7 body shapes × 9 row ops, hosts `local()` and `map()`,
   identical): **41 gaps / 63**, but 36 are the single `ChildShape` decline (→ 2), so the seam is what
   unblocks every child-scope slice on list/record/variant/property/path. Root scope (10 shapes × 15
   tail ops, via `outcomeOf`/`ALL_GENERIC`): **66 / 150**, row-algebraic sub-matrix 21/80 — of which
   **`group` is 7 by itself**, and `cardinalityOf` correctly refuses it (`wholeResult`), so that is a
   *cardinality* question and NOT row-op sharing; do not fold it in here.
   **The ELEMENT tail is the one shape not on the dispatch substrate:** `ELEMENT_DISPATCH`
   (`tail/projection.ts`) does not spread `globalRowOps`, routing through the `TailAcc` accumulator, so
   `limit()` has **three** implementations. Converting the accumulator is architectural, not a spread —
   its fusion into one SELECT is what makes `order()`+`limit()` correct in a single statement — so
   sequence it after the partitioned seam. Same seam from the wire end: `materializeStream`
   (`tail/materialize.ts`) excludes `ElementStream` from its 11-kind dispatch and calls that "the final
   materialization-boundary slice", while six other arms differ only in which column authority supplies
   `<cols>` and collapse to one `materializeSimpleRoot`.
   **The trap that cost 42 corpus traversals, still live:** a shape table is a Map where the LAST
   duplicate key wins and `dispatchShapeTail` consults ONE handler per name, so spreading a shared op
   into a table that already owns that name REPLACES the incumbent — and a handler that "declines" falls
   to the FALLBACK THROW rather than through. Compose with `firstOf`.
   **Remaining per-step gaps:** 42 current-object aggregates (architectural, above), 7 `order`, 6 `is`
   (mechanical), 5 `unfold` (correctly per-shape forever). **`tail`/`sample` are NOT here — the shared
   op exists and their residual is item 4's missing encounter.** **Medium.**

29. **The 17 `carried-state × barrier` deferral sites still each re-derive their answer**, though the
   TABLE they can cite exists: `BARRIER_ROLE_POLICY` (`context/context.ts`) is total over
   `keyof TraverserLayout` beside the merge table, in four distinct policies —
   `consumed`/`empty`/`drop`/`keep` — and `barrierLayout` is checked against it role by role in
   `test/channel-contracts.test.ts`, because a `drop` role appears in the literal as its own ABSENCE
   and so table and code could disagree by omission in either direction.
   Fold a citation into whichever site is next touched. **Do not "finish" this by mechanically
   rewriting all 17**: some defer for a reason the table does not capture. *Low.*

3. **`repeat()` residuals — and the `times(n)` unroll is NOT the free rewrite this item claimed.**
   The body compiles through the ordinary StepFns into a keyed child relation (`tail/keyed.ts`).
   **The gate is NOT "whatever `lowerElementSteps` accepts"**: a per-iteration GLOBAL barrier observes
   the whole frontier and the generic StepFns would lower it per-origin, answering a different
   question — the gate is the row-local vocabulary (`isElementChildStep`).
   **Two reference facts, pinned in `test/compiler/repeat-unroll-boundary.exec.test.ts`. They pull
   opposite ways:** our deferral message is the REFERENCE's reading —
   `RepeatStep.standardAlgorithm:217` tests `hasStepOfAssignableClassRecursively(Barrier.class, …)` and
   drains EVERY start into the body before iterating when it holds; and TinkerPop refuses to unroll
   such a body on purpose — `RepeatUnrollStrategy.ALLOWED_STEP_CLASSES` is movement + `has()` only,
   "intentionally conservative … (**especially barriers**)".
   **So the 41 queries are not 41 free wins.** Every body they count is a barrier body — the set the
   reference declines — and the bodies it DOES admit already compile here. The unroll may still be
   right for us, for a reason that does not apply to an interpreter: our phases are set-at-a-time by
   construction, so "the whole frontier at iteration k" IS phase k's relation — the property `:217` had
   to special-case to obtain. **But that is an argument to make per barrier, with a pin each, not a
   corpus count to cash in.** Breakdown, unchanged across four measurements: `order` 15, `limit` 7,
   `local` 5, `dedup` 4, `range` 4, `groupCount` 3, `sample` 2, `group` 1; plus 8 on the adjacent
   row-local gate. *Medium, and re-scoped: the cheapest honest slice is ONE barrier (`dedup`, 4
   queries, the easiest equivalence to state) rather than the mechanism wholesale.*
   Also: named-loop `repeat("a",…)` needs named loop counters; `as()` in the body rebinds per iteration
   so it stays out; `path()`/`sack()` bodies stay with the flat expansion (→ P3).
   → [deep-seam-migration-roadmap](./2026-07-18-deep-seam-migration-roadmap.md) #5,
   [foldable-carried-column](./2026-07-24-foldable-carried-column-plan.md)

20. **Results ordered only because SQLite scanned the convenient way.** `mise run test:perturbed`
   (`PRAGMA reverse_unordered_selects`) — a failure there is never a flake. Perturbed census
   **41 → 4**, suite **21 → 1**, and the ONE remaining suite failure IS the census. **So the gate is
   four corpus traversals away**, and three of them are the write driver.
   - **A GROUP VALUE body's barrier runs in the wrong SCOPE — `limit`/`range` are what is left.** The
     rule is `Grouping.determineBarrierStep`: the first non-local barrier in a value traversal is the
     group's REDUCER, and `projectTraverser` feeds that traversal one traverser at a time — which is
     exactly our child scope, so a barrier compiled there observes one origin. `order()`/`dedup()` are
     hoisted out of the child scope because each has an EXACT aggregate form (`partitionBarriers`,
     `tail/group.ts`: `ORDER BY`, `DISTINCT`). **`limit`/`range` before the terminal have none** — a
     partition-wide window inside an aggregate — so they stay child-scoped and silently observe one
     origin. Same for an ELEMENT value body's `order().by(key)`. A bare `dedup().fold()` is correct but
     its member order is first-occurrence over a scan-determined sequence, so it is not L4-pinnable
     until that order is fixed. *Med.*
   - **The four corpus traversals, none an ordering bug in the compiler:** three WRITE traversals via
     row-at-a-time `write.ts` (a driver rewrite; leave with the write cluster) and
     `g.V().repeat(__.both()).times(3).range(5,11)`, EXPECTED per item 4's `repeat`/`match` boundary,
     so it needs an exemption rather than a fix when the gate lands.
   **The INVARIANT this item established, which any new work must honour: a child-scoped stream's
   emission order is the PAIR `(ordinal, encounter)`.** The encounter alone is per-origin
   (`ROW_NUMBER() OVER (PARTITION BY <ordinal> …)`) and stays that way on purpose — a scoped slice
   reads it as a per-parent window — so across parents every first row ties at 1. Any new cross-parent
   reader must use the pair; anything inside the scope still uses the encounter alone. Two rules came
   with it: **every row slice demands the encounter**, fan-out or not; and **an exec test asserts what
   a client can observe** — an internal claim belongs in an L2 SQL assertion, and asserting it a second
   time through result position costs the instrument.

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
   **The deferral surface by root cause** (sites/L3 scenarios), ranked by "one lift, most sites
   cleared": **F `by()`/modulator — the ARITY half landed, the `by(T.token)` half is item 33** ·
   **D carried-state × barrier 17 → item 29** · **C's `path()` through a mixed shape, 8 of branch
   triage's 20 → one lift** · **A shape-tail ceiling 14/85**, the highest ratio at 6:1, which is item
   17's matrix. Then E repeat-body 26/66 (3), G write 31/92 (10), K label 17/11, B child-seam 13/32
   (2/5). A–E/G–K are the 2026-07-28 measurement and were not re-derived; F was, and the whole-tree
   `throw ` count is **533** by grep across `src/compiler`, `src/sql` and `src/execute.ts` — a
   different instrument from the 488 this line used to cite, so read it as a fresh baseline rather
   than a delta.
   → [shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md)

23. **The wording family — 14 error-assertion scenarios left, and NONE of them is renaming.** The
   premise held: a permanent refusal spelled *"…not yet supported"* is both false and mis-filed,
   because it competes with real gaps in the telemetry that RANKS THIS INDEX. The arity table
   (`BY_MODULATOR_ARITY` + the `byModulatorArity` verify Pass), `StandardVerificationStrategy`,
   `LIST_INPUT_REFUSALS` and the write family all landed as reference-sourced authorities — **a host
   must not re-check what a table dominates.**
   What is left: (a) **7 are item 22's runtime-type-channel group.** (b) **7 are real gaps that merely
   coincide with an error assertion** — the reason differs, so the message is the least of it:
   `choose().option()`'s Pick token, `fail(msg)` (item 25), `addE`'s ambiguous endpoint,
   `merge(__.constant('a'))` over an `elementMap()` receiver (we cannot consume a MAP receiver at all;
   the reference is complaining about the ARGUMENT), `mergeE`'s `option(Merge.outV, select)`, and
   `withStrategies(VertexProgramRestrictionStrategy, VertexProgramStrategy)` — which wants
   `VertexProgramRestrictionStrategy` moved OUT of `NO_OP_STRATEGIES` into a real verify strategy.
   **One divergence is deliberate and will not be closed:** `Can't parse type ArrayList as number.`
   asserts the JVM CLASS of the offending value; we say `list`. *Low — what is left belongs to the
   items that own each gap.*

0b. **Apply-contract consumers.** `ModulationContract` covers nested property keys/values, merge-map
   keys/values and `AddVertexStep` labels/parameters via `ElementReadDriver`. Remaining:
   `ListFunction`/`ConjoinStep`, plus whole-map `MergeStep`/`MergeElementStep`/`MergeEdgeStep` bodies,
   which need a map-shaped rather than scalar driver. *Medium-High — extend the declared contract, not
   another argument evaluator.* **It is the shared substrate under six of the merge rows**, so it is
   the entry point to that cluster rather than one item beside it.
   → [write-path](./2026-08-01-write-path-plan.md) §3

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

31. **A MIXED `inject()` FLATTENS its list arguments — a live wrong answer, not a deferral.**
   `g.inject(["a","b"],"c")` yields three traversers where the reference yields two (the list, then
   the string): `seedInject` (`steps/write/inject.ts`) takes the all-arrays path only when EVERY
   argument is an array, and otherwise falls to `flattenListArgs`. The single-argument spelling
   `g.inject(["a","b"])` is correct, so the defect is exactly the mixed call. Its own code comment
   names the blocker — "until ScalarStream gains a per-row shape/type discriminant" — which is the
   VariantStream question, so this is not a local fix. It is what still fails
   `g_injectXListXa_bXcX_concat_XdX` now that `concat()` over a list correctly refuses. *Med — one
   scenario, but a wrong answer, and it shares its substrate with item 1.*

4. **Encounter minting — the one missing primitive, and it owns three residuals.** A bare re-source
   `V()`/`E()` arm carries no `encounter`, so `armFansOut`/`positionArmFansOut` fail closed; minting
   `encounter = new element id` at a re-source is the primitive. ONE slot, `TraverserLayout.encounter` —
   do not derive a "two encounters" reconciliation; `repeat()`/`match()` stay outside by design.
   **The three residuals:** `tail`/`sample` are the two widest gaps in the root shape × row-op matrix
   (6/10 each) even though the shared op exists — it declines for want of a carried encounter
   (`g.V().project('a').by('name').tail(1)` → *"needs explicit encounter-order metadata"*, and an
   upstream `order()` does NOT supply it on any shape tried); **5 of the 28 `by(traversal)` deferral
   sites are this, not a child-seam gap** — they say *"requires child encounter order"* (`sack.ts`,
   `sideeffect.ts`, `filter.ts`, `group.ts`, `barrier.ts`), re-derived per host, while the other 12
   stay with 2/5; and item 20's `repeat`/`match` boundary is the declared outside.
   **Low-Med as the primitive, Medium as what it unblocks.**
   → [canonical-emission-order](./2026-07-19-canonical-emission-order.md)

33b. **`select(…).by(T.token)` is the ONE by()-token host left, and it is NOT a resolver gap.**
   `tokenExpr` (`plan/plan.ts`) is now the single resolution of what a `T` token denotes, and every
   other host routes through it — including the tail accumulator, whose three order-term renderers
   collapsed into `tailOrderTerm` on the way. `byToEntry` (`tail/select.ts`) does not, because it
   answers a record FIELD's shape — `{sub: 'vertex' | 'value', key?}` — not an expression, so
   admitting a token means widening that field vocabulary and teaching the record builder to render
   it. `lowerRecordSelectProject` ALREADY renders `spec.token` for the project-arg spelling, so two
   readers in one file disagree about the same token; **start by asking whether `byToEntry` should
   exist.** *Low-Med.* **Do NOT add a `'column'` arm to `ByClass`** — recorded won't-do.

34. **Alias-compare `where("a", P…("b"))` has two near-verbatim copies and works on 2 of 8 shapes.**
   `where` (`prefix/filter.ts`, alias branch) and `recordWhere` (`tail/select.ts`) are ~28 identical
   lines each — same `P.not` unwrap+flip, same `P_OPS` guard, same `where().by(key) on an edge-typed
   label` message verbatim in both, same `productiveBy` → `IS`/`IS NOT`. They differ **only** in how a
   label resolves to `{id, elem}` — `aliasIdExpr(label, aliases, prevRel)` vs
   `aliasId(r.c[entry.col], 'last')`, the ARGUMENT-TYPE tell from `steps/CLAUDE.md`. Measured:
   `g.V().as('a').out().as('b')<shape>.where('a', P.neq('b'))` runs on element and record, defers on
   **scalar, list, variant, property, path** — all of which physically carry the alias columns.
   **Mechanical**: parameterize the body on a `(label) => {id, elem}` resolver; several duplicated
   deferral strings retire with it. Also what P2·7's `where(var,P)` scalar-bound tail is waiting on.
   **Medium.**

35. **The L5 generator's lattice covers 54 of the corpus's 131 step names — growing it now beats running
   it.** Six runs this refresh were 36 pass / 0 fail every time, so the oracles are SATURATED at the
   current generator depth and another seed buys nothing. Top unmodelled steps in table-growth order
   (corpus occurrences): `property` 467, `inject` 420, `as` 388, `addV` 278, `option` 155, `cap` 143,
   `addE` 82, `to` 80, `from` 76, `aggregate` 70. Start at `test/L5-properties/generate.ts`'s transition
   table (108 transitions, 7 shapes, 63 names emitted). The rotating seed is NOT the gap — `seed.ts`
   derives it from `HEAD`, so every commit already draws a fresh corpus inside the standard build.
   **Medium — the instrument that finds the next ceiling item.**
   → [property-based-testing-l5](./2026-07-28-property-based-testing-l5.md)

36. **Shape-changing barriers are excluded from arm batching — the branch-scope class the T-tranches
   did not cover.** `fold`/`group`/`groupCount`/`aggregate` are out of `BATCHED_BARRIERS`
   (`ir/step.ts:217`) because batching one turns a homogeneous merge into a mixed-shape merge — but
   each IS a `Barrier` upstream (`FoldStep extends ReducingBarrierStep`), so `union(__.out().fold(), …)`
   batches in the reference and lowers per-origin here. Start at `BATCHED_BARRIERS` + the arm routing
   in `prefix/branch.ts`. **Three smaller tails from the same plan, none carried elsewhere:**
   `GLOBAL_BARRIER_STEPS` carries two meanings (§5·1); three spellings of *"is there a whole-stream
   barrier in this body"* — `repeat()`'s body gate, `match()`'s pattern body, and the FLAT `armBatches`
   — want one recursion (§5·2), which is also the nested-arm gap the branch plan declared; and the
   `union(barrier-arm…)` ≡ `local(union(…))` law (§5·4) is absent from `laws.ts` and now due.
   Also **`ir/step.ts:86-92` is STALE on its live half** — it still says the branch-arm case "does
   NEITHER", citing `g.V().values('age').union(__.min(), __.max())`, which is pinned at
   `test/L4-addendum/scalar-reentry.feature`. *Med.*
   → [branch-arm-barrier-scope](./2026-08-01-branch-arm-barrier-scope-plan.md) — **read §1 and §6
   before proposing anything**

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
   `where(var,P)` on a scalar-bound var (a downstream alias-compare gap → 34, not a match one). **Medium.**
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

10. **`addV` mid-chain + read-tails-after-write.** Gates a write-conformance cluster, and is the
    prerequisite inside it — several of the merge TAILS wait on it. **Medium.**
    → [write-path](./2026-08-01-write-path-plan.md) §4 (the whole write cluster in one place),
    [compiler-consolidation](./2026-07-16-compiler-consolidation-plan.md) §6

11. **Federation tail:** map-valued injection for mid-traversal federation (Med); async
    failure/timeout/retry policy (Low-Med); federated *traversal* via local scratch (Large).
    **Federated *materialize* is UNBLOCKED and is this item's next piece**: `call(federate,…)` returns
    detached rows, `BulkLoader` lands them, and its stated blocker — cross-graph id collision — is
    `idPolicy: 'remap'`/`'renumber'` (a source id has no meaning in the target, so it is kept as `uid`
    or dropped). **import-a-graph** is the same machinery pointed at a document instead of a sibling
    graph, and `io().read()` already is it.
    → [bulk-transfer-and-io-substrate](./archive/2026-07-31-bulk-transfer-and-io-substrate-plan.md) §5/§7

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

16. **W4 — multi/meta-property schema rework → `Cardinality.list/set` writes. It is not a
    capability gap: it is a SILENT WRONG ANSWER.** Measured 2026-08-01 —
    `addV('animal').property('name','mateo').property('name','gateo').property('name','cateo')` keeps
    only `cateo`, and `property(Cardinality.list,'friends',__.out('knows').values('name'))` stores one
    value where the reference appends both. → [write-path](./2026-08-01-write-path-plan.md) §2.
    Only meta-property *typing* is touched today. **Adjacent, from the io work:** meta-property VALUES have no per-value
    type in storage — `vertex_properties.meta` is a flat `{metaKey: scalar}` JSONB bag, so a meta value
    round-trips through GraphSON as whatever JSON returns. The format can carry more than storage gives.
    **Medium.**
    → [conformance-structural-bets](./2026-07-12-conformance-structural-bets.md) (W4)

19. **Multi-label vertices — two narrow tails.** `labels()` as a CHILD BODY (3 scenarios — not label
    work, it is item 2 meeting a fan-out body), and `elementMap()` on EDGES (3, a pre-existing gap
    needing the IN/OUT direction tokens).
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
    half is not. **`feature-support-matrix.md` still carries the refuted premise in two places** — the
    `tree()` 🚫 row and the Locked non-goals table; sweep both. **Medium.**

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
  · **A path-REGIME change inside a child body still has no answer — but it now DEFERS.**
  `g.V(1).simplePath().project('a').by(__.repeat(__.in('knows')).times(2))`: the child's `repeat()`
  retypes the carried path from linear `cols` to its own recursive accumulator while the parent still
  DECLARES the position columns. It emitted malformed SQL (`rel.c.p0` was `undefined` and spliced an
  empty string) and was the one fail-closed VIOLATION here; `layoutProjection`
  (`steps/context/context.ts`) now refuses to project a carried column the relation does not declare,
  so it throws naming the channel. **Do not fix by declining at the repeat** — measured, the same
  condition holds for `local(__.repeat(…))` and `where(__.repeat(…))` under `simplePath()` and BOTH
  execute correctly, so a guard there regresses two working shapes. The fix is for a child body to
  restore the parent's path regime across the rejoin. *Med, and no longer urgent.*
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
  GraphComputer**: 4 of its 6 scenarios are the OLAP names item 8 will serve, so that exclusion should
  NARROW, not harden. The four `io` scenarios still excluded are REFUSALS of two different kinds and
  must be read as such rather than as a gap: `.kryo` is a platform wall (JVM serialization, no
  dependency available), `.xml` is a **format decision** — no XML, because GraphML's `attr.type` is more
  type-lossy than CSV *and* Workers has no `DOMParser`. That makes `tags.ts` carry its first
  format-decision exclusion. *Low.*

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
  The argument decode is one function (`sliceOf`/`isLocalScope`, `ir/step.ts`) and the rendering one
  more (`limitOffset`, `plan/plan.ts`), so a host can no longer read the scope token as a row count — but
  three hosts still have no member-scoped FORM. `values('name').limit(Scope.local,1)` throws where the
  reference is identity (a String is not a Collection), and it cannot simply become identity: the same
  stream carries list-valued properties, for which it is a real member slice. `dedup(Scope.local)` on an
  element stream is the same shape of gap. The missing authority is "how many members does this value
  have", the same one item 17's `partitionedDedup` needs. *Low-Med.*
- **A record sliced down to ZERO fields defers** — `project('n').by('name').skip(Scope.local,1)` should be
  an empty map per traverser; `materializeRecordRoot` has no zero-field form, so it throws. Needs the
  record shape and the framer to agree that `{}` is a value. *Low.*
- **The remaining `as any` reads are a rename-safety hole** — a field read a future LSP rename yields
  `undefined` for, invisibly to `tsc`. 26 in `src/`, most benign row/bind casts; the rename-unsafe FIELD
  reads are `(s as any).productiveBy` (`tail/projection.ts:91`), `(a as any).nested`
  (`tail/child-shape.ts:214,239`) and `(pred as any).values` (`tail/operand.ts:162-191`).
  **This item has been cleared once and refilled from elsewhere — treat it as a standing sweep.**
- **§6 vocabulary-set derivation — ~4 movement lists left**: `ir/analyze.ts:60`,
  `tail/child-shape.ts:293`, `ir/strategies.ts:210`, `tail/bulk.ts:178`. One family per commit, gated on
  byte-identical `test/L2-sql/` snapshots. **Do not fix a membership bug inside a rename.**
  → [tinkerpop-core-engine-alignment](./2026-07-29-tinkerpop-core-engine-alignment.md) §6
- **L5's known-bad state is split across artifacts with one reader each, and three self-reports are
  stale.** `known.ts` (1 entry), `capability-baseline.ts` (1) and `laws.ts`'s `knownBroken` (a declared
  type with zero entries). Stale: `README.md:28` claims `known.ts` is EMPTY and `:29` that `laws.ts`
  carries two entries; `known.ts:14` shouts *"THE LIST IS CURRENTLY EMPTY, AND THAT IS THE INTENDED
  STATE"* above a non-empty list. **Do not merge the artifacts naively:** they are keyed differently on
  purpose (exact query / query→message Map / per-law PREFIX RegExp), all are hand-curated *because* each
  entry must carry a prose diagnosis, and `laws.ts` entries arguably belong beside their law. The honest
  shape is one file with a tagged union and a shared stale-entry check, keeping the per-kind matcher.
  Fix the self-reports as part of it — *a ratchet whose banner denies its own contents is how one gets
  ignored.*
- **`feature-support-matrix.md` over-promises.** (a) Generate the capability ratchet's per-step shape
  strip into it so its ✅ matches 5c. (b) It states "There are currently NO 🐞 rows — no form is known to
  mis-execute", which is false (items 20, 31 and 36), and the legend points at `known.ts` for the
  mark's source of truth.
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
  **Measured 2026-08-01: the perturbed instrument does NOT depend on this.** Its three write rows are
  id-ASSIGNMENT order — the same graph, different ids — so consuming the driver's input in emission
  order closes them without the rewrite. → [write-path](./2026-08-01-write-path-plan.md) §5
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
- **Channel preservation — two DELIBERATE non-goals, do not re-file either.** `finishElementMerge` is
  not folded into `mergeArmRelation` (it keeps the arm's encounter in its declared slot and is the only
  merge that pads a ragged `path`, so folding it changes SQL for no correctness gain — revisit only if a
  THIRD spelling appears); and `bulk` is lost through `match()`, so a reducer after one counts ROWS
  rather than traversers — declared and probed, with no live wrong answer.
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
- **Widening the primary key** → refuted on measurement: a random 52-bit `INTEGER` costs 2.8× on the
  3-hop hot path, a `TEXT` uuid 5× and 7× on disk; `uid TEXT UNIQUE` already IS the global-identity
  slot; and `coerceBindValue` makes >2^53 unrepresentable at our own bind seam. Read
  [bulk-transfer-and-io-substrate](./archive/2026-07-31-bulk-transfer-and-io-substrate-plan.md) §7
  before proposing an id change.
- **Widening the format set** → the set is DECIDED: typed GraphSON adjacency (read v3+v4, write v4)
  plus Neptune/Neo4j CSV for interop, no homegrown format and nothing XML (§4/§4b is why re-widening
  buys no capability; §4d is CSV's loss table, split into declared widenings and refusals).

---

## Research / vision (reference — no build items)

- **[agent-memory-vision](./2026-07-17-agent-memory-vision.md)** — sibling `mogwai-memory` repo.
- **[graph-algorithms](./2026-07-24-graph-algorithms-plan.md)** — build spec for P2·8.
- **[conformance-structural-bets](./2026-07-12-conformance-structural-bets.md)** — strategic unlock map.
- **[cross-do-federation-prior-art](./2026-07-13-cross-do-federation-prior-art.md)** — federation prior-art;
  the `ATTACH` correction stands.
- **[bulk-transfer-and-io-substrate](./archive/2026-07-31-bulk-transfer-and-io-substrate-plan.md)** —
  closed; read for the id-width refutation (§7), the decided format set (§4) and the two instruments
  that keep the 100-bind class from returning (§2). Both decisions are in won't-do above.
- **[path-tracking-prior-art](./2026-07-12-path-tracking-prior-art.md)** — path prior-art for P3 tails.
- **[wire-and-storage-facts](./2026-07-25-wire-and-storage-facts.md)** — Map.Entry framing + MapStream.
- **[shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md)** — the shape/type
  vocabularies per layer and the bright line. **Refutes three cross-layer refactors — read before
  proposing one.**
- **[scalartype-refactoring-pattern](./2026-07-28-scalartype-refactoring-pattern.md)** — vocabulary-cleanup
  template; live targets are `AliasShape` member shape (item 1) and front-end tagged-token accessors.
- **[tinkerpop-core-engine-alignment](./2026-07-29-tinkerpop-core-engine-alignment.md)** — naming
  authority and rename map. The open `ir/rewrites.ts`/`ir/strategies.ts` partition needs a shared home.
- **[write-path](./2026-08-01-write-path-plan.md)** — every open write problem in one place, measured
  2026-08-01: the eleven L3 scenarios that leave the GRAPH wrong (three reproduced), the upsert cluster
  and the one substrate under six of its rows, the positions the driver cannot reach, and the
  determinism question. Items 10, 16 and 0b are its tranches; item 11 is deliberately NOT (different
  machine).
- **[branch-arm-barrier-scope](./2026-08-01-branch-arm-barrier-scope-plan.md)** — closed; read for §1's
  `BranchStep`/`FlatMapStep` class fact, which decides which branch kinds can disagree with us and in
  WHICH respect (arm SCOPE for two of them, emission ORDER for all four), and §6's five wrong turns.
  Item 36 is its one open remainder.
- **[property-based-testing-l5](./2026-07-28-property-based-testing-l5.md)** — L5's oracle design space.
- **[canonical-emission-order](./2026-07-19-canonical-emission-order.md)** — the emission-order model
  behind item 4.
- **[channel-preservation](./archive/2026-07-28-channel-preservation-refactoring-plan.md)** — closed;
  read it for the constitution a vocabulary migration passes.
- **[hand-rolled-sql-audit](./archive/2026-07-27-hand-rolled-sql-audit.md)** — closed; the measured
  method behind items 3, 5, 5c and 17.
