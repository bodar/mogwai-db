# Outstanding work

The de-duplicated index of open work across the `docs/` corpus. **Each line sets the scene — what,
why, what it unblocks, where to start — not a spec.** The linked doc holds the rationale; the
picking agent does the detailed validation and design. Landed work is excluded (the corpus
over-reports `LANDED`; this keeps only what a code check confirms open). Live per-step capability:
`feature-support-matrix.md`.

**Refreshed** 2026-07-26 against L3 1362 unique / 2297 (`l3-state.json` shows 1364 — two names
recur legitimately, see `test/CLAUDE.md`). A 2026-07-27 session took it to **1437**: item 2's
Slice 3 (child-body labels, +8), the constant predicate-operand fold (+29), read-only child
verification (+14), re-sourced operand subqueries (+6), correlated operands (+4), the operand
tails (+5), the union() source consolidation (+6), where()'s scope variables (+1) and
mid-traversal V()/E() (+12).
Path pointers assume the 2026-07-23 restructure
(`src/compiler/steps/{context,prefix,tail,write}/`, `src/compiler/{ir,plan,engine}/`).

> **Before picking an item, verify its premise against the code — this index has been stale in BOTH
> directions.** The corpus over-reports `LANDED`, but item 1 also over-reported *open*: it named a
> duplication that had already been consolidated and an `encounter` mint that already existed, which
> cost a full re-investigation. The cheapest check is usually a 10-line probe that compiles the
> traversals the item claims are broken and greps the emitted SQL — do that before designing.
> When an item turns out to be partly landed, rewrite the line rather than closing it silently.

**Ordering — floor vs ceiling.** L3 is the floor (scenarios that pass); the ceiling is generic
lowering that composes the full nested grammar at any depth/combination (see
`src/compiler/steps/CLAUDE.md`). P1 raises the ceiling — each item unblocks a *family*; one-off
step impls are matrix-fill, lower. Impact: **High** (correctness / whole-family unblock) ·
**Medium** (real feature bucket) · **Low** (narrow, fail-closed, or debt).

---

## P1 — ceiling-raising generic-substrate lifts

1. ~~**Unify the branch-merge family onto the `VariantStream`/`variantArm*` substrate.**~~
   ✅ **LANDED 2026-07-25.** The premise was already half-stale when written: the three merge
   *builders* (`finishElementMerge`, `unionScalarStreams`, `mergeVariantArms`) were consolidated
   AND each already minted the arm-merge `encounter` — i.e. **Stage A of canonical-emission-order
   had landed**, so this item's "unblocks item 4" was already discharged. What was genuinely
   duplicated was the dispatch **head**, now fixed:
   - `classifyBranchArms` + `BRANCH_SHAPE_ORDER` (`steps/tail/child-shape.ts`) is the ONE arm
     triage. It replaced ten ad-hoc booleans in `engine/engine.ts`'s prefix fold, three hardcoded
     `list→scalar→variant→element` cascades in `steps/tail/projection.ts`, and a third
     re-classification inside each `tryLower*`. Pinned by `test/compiler/branch-triage.exec.test.ts`,
     which keeps the old ten-boolean predicate as an oracle and asserts equivalence over 44 branch
     steps — that test caught a real bug during the change (an unclassifiable `optional()` body
     routed to the tail reports `step not implemented: optional()`, so unclassifiable splits by
     kind: `optional`→element, multi-arm→variant).
   - `finishListMerge` replaced 3 verbatim list-merge copies; `mergeVariantParts` was split out of
     `mergeVariantArms` for the heterogeneous hit/miss `optional` merges.
   - **A real wrong answer was fixed**: the four scalar-parent mixed-shape merges hand-inlined
     `mergeVariantArms`' no-encounter branch, so with a live encounter (any positional consumer
     downstream of a fan-out — `values('age').union(constant('x'),V()).limit(2)`) arm ordering was
     silently dropped and the slice picked rows in incidental SQLite order.
   - `lowerLegacy*` → `lowerElement*`: those are the authoritative element-homogeneous compilers
     and the fail-closed backstop, not legacy. The name drove much of this item's apparent size.

   **Residual — ✅ also LANDED 2026-07-25**, and it turned out to be the visible tip of a much
   wider alias/barrier defect (widening the investigation was the right call — it produced the
   only L3 gain of the whole effort):
   - `as()` inside a **scalar arm** now survives the merge. `mergeAliasMaps` moved from
     `branch.ts` to `context.ts` (+ a new `aliasArmProjection`) so the scalar/variant merges share
     the element merge's remap/NULL-pad logic; `unionScalarStreams` unions the arms' label sets;
     only then was `as` admitted to `SCALAR_ARM_ROW`. Semantics match the element-arm reference:
     a label bound in one arm only drops the other arm's rows, both-bound keeps both.
   - **A single LIST-shaped label read back as its JSON TEXT**, not as a list — so
     `fold().as('b').select('b').unfold()` emitted one text blob instead of its members. Fixed;
     this gained **L3 1277 → 1278** (`g_V_hasLabelXpersonX_aggregateXxX_byXageX_capXxX_asXyX_selectXyX`).
   - **A LINEAR `path()` is row-preserving**, so it now threads the alias history instead of wiping
     it (Piece C of [path-history-substrate](./2026-07-18-path-history-substrate.md)):
     `path().as('a')` and `select('a')` after a path work. The recursive/grouped layout is one row
     per position, not per path, so it still drops them and declines explicitly.
   - **`Carried.consumedAliases`** (metadata, never a column) records the labels a REDUCING barrier
     ate, so `select(label)` after `fold`/`count`/`sum` can PROVE the empty result is correct rather
     than arriving there by accident. TinkerPop pins empty here (`Select.feature g_V_selectXaX`), and
     `count().as('a')…select('a')` reads back fine because the label binds on the barrier's OUTPUT.
     **7 of 10 barrier+select combinations previously returned `[]` indistinguishably from a typo.**

   **Still open (smaller, now precisely scoped):** list members frame as bare values, not elements —
   `AliasEntry` does not record the member shape, so a path/element-list label cannot frame its
   members as vertices. Blocks
   `g_V_hasXperson_name_markoX_path_asXaX_unionXidentity_identityX_selectXaX_unfold` (which also
   needs `union()` over a path value). *Low-Med.*

2. **Universal child-seam acceptance.** The generic child seam still throws for whole child-body
   families — `as()` in a child body, `choose().option` pass-through, non-element `by(__.trav)`
   (bodies producing map/group/project/valueMap shapes). The fix is
   extending the classifier+compiler so every body is admitted at every position, not one shape at a
   time. Start: `steps/tail/{child-shape,child,scalar-arm}.ts`. **High.**
   - ✅ **Slice 1 LANDED 2026-07-26** (`1e15e75`): a **uniform-element branch**
     (`union`/`choose`/`coalesce`/`optional`, all arms element) now composes as an element/scalar/
     list/count child body at EVERY position — `map`/`local`/`flatMap`, `where()` existence, and
     `group().by(value)` — so `map(__.union(out(),in()))`, `by(__.coalesce(out(),in()).count())`, etc.
     lower. The emit substrate already threaded the child ordinal; the gate was the classifier, now
     `isUniformElementBranch` (`child-shape.ts`) admitting the branch into the element-preserving
     prefix via the ONE canonical arm triage (`classifyBranchArms`). A scalar/list-armed branch keeps
     its own path. Pinned by `test/L4-addendum/element-branch-child.feature` + a `branch.exec.test.ts`
     block; L3 floor unchanged (ceiling raised, no named scenario). This also promoted several
     mixed→homogeneous branch classifications (`union(__.out().optional(in()), both())` is now an
     element union, not a variant).
   - ✅ **Slice 2 LANDED 2026-07-26**: a **list-armed OR mixed-shape (variant) branch**
     (`union`/`coalesce`/`choose`) now composes as an ALL-cardinality child body at `local`/`flatMap`
     — `local(__.union(out().fold(), in().fold()))` and `local(__.union(out(), values('name')))` lower
     via `lowerStepsStrict` over a pushed scope to a List/VariantStream, re-projected to the parent's
     cardinality (`tryCompileBranchChildAllCard`, `child.ts`). Deliberately NOT wired into `map` (a
     multi-output body's first-cardinality would silently drop arms — fails closed) nor into
     `classifyListChild` (which feeds the branch-arm triage — kept untouched). Pinned by
     `test/L4-addendum/list-branch-child.feature`.
   - ✅ **Slice 3 LANDED 2026-07-27: `as()`/`select(label)` inside a child body**, at every
     position and any depth. The gate was never the emit side — `pushChildScope` already projects
     the parent's alias columns into every frame, so a label bound anywhere up the chain is
     PHYSICALLY present in the innermost body. What was missing was that the pure classifiers had
     no way to ask what a label holds, and `select(label)`'s shape IS the label's contents. They
     now take a **`ChildCtx`** (bound params + a `LabelEnv`: label → element/scalar/list), seeded
     from the parent's carried aliases and EXTENDED as a body is scanned — so a bind types the
     selects after it, and a nested arm classifies against the labels visible where it sits. One
     rule at every recursion, not a per-position vocabulary patch. `as()` joined
     `ELEMENT_CHILD_STEPS` (it preserves every shape); `select(label)` is a tail step, so
     `lowerElementBody` (`child.ts`) applies the ONE existing `selectOneFromAlias` and keeps
     folding rather than adding a second select to the prefix table. **L3 1364 → 1372** (+8, all
     label-in-child scenarios: `g_V_mapXselectXaXX`, `g_V_asXaX_flatMapXselectXaXX`, the
     `and`/`or`/`choose` select forms, `g_V_hasLabelXpersonX_asXpX_outXcreatedX_group_byXnameX_
     byXselectXpX_valuesXageX_sumX`, `g_withPath_V_asXaX_out_mapXselectXaX_valuesXnameXX`).
     Pinned by `test/L4-addendum/child-body-labels.feature` + a `branch.exec.test.ts` block.
     Three facts worth keeping:
     - **Escape semantics fall out of the existing boundaries — do not add a per-position rule.**
       A MAPPING consumer pops the child stream (`popChildScope` carries the child's own carried,
       so a bind inside `map`/`local`/`flatMap`/an arm rides out); a FILTER or `by()` consumer
       re-projects the parent domain (so it stays confined). Both are TinkerPop's.
     - **A renderer that cannot carry alias columns must DECLINE, not answer.** The inline
       correlated predicate child (`correlated.ts`) seeds a bare id with no carried schema, where
       an absent alias column is indistinguishable from a never-bound label — so
       `where(__.out().where(__.select('x'))))` silently returned `[]`. It called
       `mentionsLabel` up front and fell through to the materialized gate (the fast-path
       contract: recognition-failure falls through). Fixed a live wrong answer.
       **Superseded 2026-07-27:** the columns are now GIVEN to it (a `LabelScope`) rather than the
       body declined, so label-mentioning predicate bodies inline again instead of paying the
       materialized gate. Declining survives only where there is no relation to read them from.
     - `emptyElementLike` now keeps the input's carried COLUMNS (zero rows). At root that is
       invisible; in a child scope it is the difference between a correct answer and a relation
       the consumer cannot join to its frame ordinal.
   - ✅ **`WhereEndStep`/`WhereStartStep` LANDED 2026-07-27.** A where() body's FIRST and LAST
     labels are scope VARIABLES, not binds (`GraphTraversal.where` →
     `TraversalHelper.getVariableLocations`): first = re-root, last = an equality constraint, so
     `where(__.as("a").out("knows").as("b"))` means "a knows b". Both are now canonicalized by ONE
     Pass (`rewriteWhereEndLabels`) into forms both lowerings already implement — `select(label)`
     and `where(P.eq(label))` — rather than taught to either, which is what makes the inline fast
     path and the materialized gate agree by construction. It recurses through and()/or()/not()
     exactly as upstream's `configureStartAndEndSteps` does, and threads the labels visible where
     each where() SITS, so it holds at any nesting depth. **Two live wrong answers fixed:** the end
     constraint read as an inert bind (answering the far weaker "a knows somebody"), and a leading
     `as()` re-rooting inside `filter()`/`choose()` predicates, which TinkerPop does NOT route by
     variable location — that one also disagreed with itself depending on the fast-path flag.
     L3 1436 → 1437.
     - **Residual, pre-existing and separate:** a label REBOUND inside a `filter()` body over an
       outer label of the same name drops rows TinkerPop keeps —
       `g.V().as("a").out().as("b").filter(__.as("a").out("knows")).count()` is 0 for us, 1 for
       TinkerPop (josh). Consistent across both lowerings, so it is a child-seam rebind question,
       not a variable-location one. Pinned as an ON≡OFF equivalence in `branch.exec.test.ts`.
       *Low-Med.*
   - ✅ **`choose().option()` as an ARM MERGE — LANDED 2026-07-27** (+7). The premise "without a
     `Pick.none` default (mixed pass-through)" was right about the semantics and wrong about the
     blocker: unmatched inputs DO pass through as the element, but that mixed scalar/element result
     stopped being unrepresentable when `VariantStream` landed. The real blocker was that option-map
     choose was implemented ONLY as a scalar `CASE` projector, so an element body
     (`option('x', __.out('knows'))`), a list body and the pass-through all deferred for the same
     reason. It is now a branch: gate the parent per option (first match wins — the CASE's own WHEN
     order), lower each body from its gated seed, route to the ONE triage + the four merges. The
     CASE stays as the all-scalar specialization, tried first, and now DECLINES instead of throwing
     (the same fast-path-contract fix 7c needed). `__.discard()` drops its rows → no arm.
     ✅ **Follow-ups also LANDED 2026-07-27** (+5, L3 1456 → 1461): `Pick.unproductive` (the choice
     produced NOTHING — distinct from `Pick.none`, a value matching no key; the correlated choice's
     `present` column already carried the signal, so it cost one extra projected column), and LIST
     (`…fold()`) option bodies inside a `local()` child (`isBareBranchChildAllCard` excluded the
     option-map form; it now asks the same triage). The option-map triage
     (`readOptionMapArms`/`optionMapMerge`/`optionMapIsCase`/`optionMapNeedsPassthrough`,
     child-shape.ts) is the ONE place that answers "what does this option map do" — the second
     deliberate exception to one-arm-triage after `scalarArmShape`, documented as such. It absorbed
     two sites that had been answering privately, one of which was already a live lockstep break
     (`elementOptionMapScalarBranch` claimed 'scalar' for a body the emitter widened to a variant,
     tripping a non-null assertion). `optionMapMerge` models the DISPATCH ROUTE, not just the
     shapes: the CASE is tried first, so a body it serves never reaches the merge.
     **Still open — a real WRONG ANSWER, precisely scoped.** With only `Pick.none` written AND a
     choice that can be unproductive, the CASE's single ELSE claims the unproductive inputs too;
     TinkerPop emits the ELEMENT for them (`Choose.feature`
     `g_V_chooseXageX_optionXbetweenX26_30X_nameX_optionXnone_nameX` pins `v[lop]`/`v[ripple]`).
     Making the CASE decline there IS correct and the arm merge answers it properly — measured
     **+1/−1**: the resulting `VariantStream` has no `group()`/`groupCount()` tail, which costs
     `g_V_hasLabelXpersonX_chooseXageX…_groupCount` (whose `hasLabel` filter means the pass-through
     could never fire at runtime anyway). **So this is gated on group/groupCount over a
     VariantStream, not on the option map.** Also still open: `Pick.any` (only reachable via
     `branch()`, unimplemented).
   - ✅ **`repeat()` in a child body LANDED 2026-07-27** (item 3): the walk now carries its origin
     column, so it composes at `local`/`map`/`where`/`group`/`order`/a branch arm — 1/7 → 7/7 probes.
     Same shape as the slices above: the emit substrate was ready, the classifier was the gate.
   - **Still open:** child
     bodies producing map/group/record shapes (item 5 territory); the `group().by(project(...))`
     composite key and non-scalar/non-count nested-group inner keys. Also still open, and
     ORTHOGONAL to labels (it reproduces with none): a child-in-child body whose inner child is
     not element-shaped — `local(__.local(__.out().values('n')))`, `map(__.out().map(...))`. That
     family now DEFERS instead of crashing: `local` sits in the element-row suffix vocabulary but
     emit recurses into an *element* child for it, so classify has to ask the same question —
     until it did, `group().by(__.out().local(__.values('n')).fold())` died on a null-deref
     through the caller's non-null assertion instead of failing closed.
   → [carried-schema-and-projection-reentry](./2026-07-14-carried-schema-and-projection-reentry-plan.md),
   [group-value-generic-seam](./2026-07-18-group-value-generic-seam-plan.md)

3. ~~**The `repeat()` recursive term: alias columns + the private movement/filter mini-compiler.**~~
   ✅ **BOTH LANDED 2026-07-27** (independently, then reconciled — and reconciling them produced the
   better framing, so it is recorded here rather than left as two bullets).

   **The unifying fact: a walk carries LOOP-INVARIANT columns, and there are two kinds.** The walk
   MOVES the traverser; it neither reads nor rewrites these, so they simply ride each iteration —
   seeded from the outer row, passed through untouched, emitted in `carriedCols`' declared order.
   One `ride()` helper in `branch.ts` now serves both:
   - **ALIAS columns** — a label bound BEFORE the walk is invariant because the walk never rebinds an
     existing label. The old framing ("teach the recursive term to carry them") over-stated it: it is
     a projection, not a fold. What had been there was a blanket `carried.aliases.size > 0` refusal,
     so ANY `as()` before a `repeat()` deferred the whole traversal whether or not the label was read.
     Oracle: `times(n)` over a single-movement body IS the linear n-hop chain, so the carried label
     must come out elementwise identical to the linear form — pinned that way in
     `repeat-path.exec.test.ts` rather than against hand-written expectations.
   - **ORIGIN columns** — a walk is row-local (each traverser walks independently), so the ordinal
     saying which parent a row came from is just carried too. This was the ONLY thing keeping
     `repeat` out of `ELEMENT_CHILD_STEPS`, and it is what admits the walk as a CHILD body
     (`local`/`map`/`where`/`group`/`order`/a branch arm — **1/7 → 7/7** probes) AND inside another
     repeat's body. Two capabilities, one column.

   **`expandRepeatBody` is now a FAST PATH, not the vocabulary.** It stays unchanged — it walks the
   frontier lazily where the generic route materializes — but no longer decides what a body may
   contain. It existed for a real reason: SQLite has no `LATERAL`, so the nested-derived correlated
   rendering cannot fan out inside the recursive term's FROM. The way around needs **no new rendering
   mode**: a recursive term MAY reference a non-recursive CTE, so `repeatBodyRelation` compiles the
   body ONCE through the ordinary StepFns — seeded from every vertex, carrying its origin in the slot
   `pushChildScope` already uses — into `(from_id, to_id)` for the recursive term to join. Also
   needed: `otherV` joined the row-local vocabulary (the odd one out among the nine movements, gating
   every exploded-edge body in EVERY child position), and the body is now canonicalized with the same
   `normalize()` every other nested body uses (with `foldByModulators` alone a nested `times()` never
   folded onto its `repeat()`).

   Measured: repeat corpus **43 → 48**, body vocabulary **2/12 → 9/12** probes, total corpus
   1,626 → 1,635.

   **The trap, pinned by a test:** the gate is NOT "whatever `lowerElementSteps` accepts". A
   per-iteration GLOBAL barrier (`dedup`/`order`/`limit`/`range`/`sample`/`tail`/`group`/`aggregate`/
   `local`) observes the whole frontier at one iteration, and the generic StepFns would happily lower
   it per-origin — bare `dedup` emits `SELECT DISTINCT id, <carried>`, which with an origin column in
   the tuple silently becomes per-origin and answers a DIFFERENT question. The gate is the row-local
   vocabulary (`isElementChildStep`); the deferral now names the offending step and says why.

   **Still open, each now precisely scoped:**
   - A label bound INSIDE the body (`repeat(__.out().as("b"))`) genuinely rebinds per iteration, so
     it is a fold, not a projection — `as` stays out of the body vocabulary (fails closed). *Low-Med.*
   - A **barrier body under a fixed `times(n)`** could be UNROLLED into n generic phases (that route
     hosts barriers; `bulk.ts` already unrolls a specialized version for the count case). The natural
     next slice. *Medium.*
   - `walkPredicate` (`until()`/`emit()`) still has NO generic fallback, which is what keeps the
     inline predicate compiler's leaf vocabulary load-bearing (see the give-back below). Same trick as
     the body: compile an element-only predicate once as a `matching(id)` relation and read
     `id IN matching` in the recursive term. *Low-Med.*
   - The named-loop form `repeat("a", …)`/`loops("a")` still **crashes** rather than failing closed
     (`undefined is not an object (evaluating 'node.constructor')`, 4 corpus cases). Cheap, isolated.
   - `path()`/`simplePath()` + `sack()` bodies stay with the flat expansion (both are per-iteration
     state) — P3 recursive-path tails, unchanged.
   → [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md) #1,
   [deep-seam-migration-roadmap](./2026-07-18-deep-seam-migration-roadmap.md) #5,
   [path-history-substrate](./2026-07-18-path-history-substrate.md),
   [foldable-carried-column](./2026-07-24-foldable-carried-column-plan.md)

4. **Canonical-emission-order Stage C — residual only.** The headline premise ("branch merges don't
   mint the arm-merge `encounter`") is **false and has been for some time**: every merge family mints
   it (Stage A landed), and as of 2026-07-25 that includes the four scalar-parent mixed-shape merges
   (item 1). `dedup(labels)` first-in-emission also landed (`filter.ts`). Stage B landed for movement,
   source seed, element-prefix `limit`/`range`/`skip`, root `fold`, child `first`, and `values()`.
   What actually remains:
   - ~~**`union()` as a SOURCE form**~~ ✅ closed 2026-07-27 as a side effect of item 4b: the
     source union now routes through the same merges, every one of which mints the encounter.
   - **A bare re-source `V()`/`E()` arm carries no encounter**, so the take-first guards that depend
     on one still fail closed: `armFansOut` (`steps/tail/scalar-arm.ts`) and `positionArmFansOut`
     (`steps/tail/path.ts`). `map()` over a `union`/`choose` fan-out arm ALREADY works (those carry
     an encounter); only the re-source arm is left. Minting `encounter = new element id` at a
     re-source is the one missing primitive.
   - **`repeat()`/`match()`** stay deliberately outside (a recursive CTE can't window across
     iterations) — `analyze.ts` returns `demandsEncounter: false` for them by design.
   Do NOT re-derive the "two encounters" reconciliation: there is one slot, `Carried.encounter`;
   `ScalarStream` has no separate field. **Low-Med.**
   → [canonical-emission-order](./2026-07-19-canonical-emission-order.md)

4b. ~~**The `union()` SOURCE is a second, weaker branch implementation — consolidate it onto the
   mid-traversal one.**~~ ✅ **LANDED 2026-07-27.** `seedUnion` is gone. The spiked boundary held
   exactly: the MERGES were reusable, the TRIAGE was not.
   - Each branch is a fully ROOTED traversal, so it lowers through `Engine.lowerRootedArm` —
     compileRead's own spine (seed the source, run the ONE shaped loop) minus the root
     materialization, since a merge consumes a relation, not a framed leaf. The merge is then
     picked from the arms' **kinds**, never `classifyBranchArms` (which describes a child body
     under a parent traverser — not what a rooted branch is).
   - The four merges took it verbatim once `finishElementMerge` became `Carry`-typed like its
     three siblings (`mergeElementArms` is the union-shaped wrapper; the gated coalesce/optional/
     choose merges still call `finishElementMerge` directly). All four fail-closed walls fell out
     at once: arm SHAPE (scalar/list/mixed/`inject`-rooted/nested-union), `as()` in a branch,
     the emission `encounter` (closing item 4's residual), and `sack`.
   - Every source form (`V`/`E`/`union`/`inject`/`call`) is now recognized in ONE place,
     `Engine.seedRooted` — which is what let an `inject`-rooted branch seed on the SHARED Query
     (`seedInject`, factored out of `compileInject`) instead of needing its own compile.
   - `g.union()` (no branches) is legal and empty, not an arity error; one branch is legal too.
   - **L3 1430 → 1436**, +6/−0: `g_unionXX`, `g_unionXV_name`, `g_unionXinjectX1X_injectX2X`, and
     the three `path()` forms. The last two of those needed one adjacent generic lift, since a
     source union is the first branched path a `by()` can reach: a PADDED path position now
     carries a presence column (`PathPos.optional` + `<prefix>_at`), so "this arm's path is
     shorter" (omit the position) stays distinct from "the `by()` value is missing" (drop the
     whole path). That also un-defers `g.V().union(…).path().by(…)` mid-traversal.
   - **Still deferred (fail-closed):** a WRITE branch (`g.union(__.addV('person')…)` — the merges
     are read merges), and a branch whose shape no merge covers (map/group/record/path), which
     throws naming that shape.

4c. ~~**Mid-traversal `V()`/`E()` — an untracked gap, not in this index at all.**~~
   ✅ **LANDED 2026-07-27.** `step not implemented: V()` was the 3rd-largest deferral bucket (16
   queries) while appearing nowhere here — worth remembering that the telemetry buckets find work
   this index misses. TinkerPop's `GraphStep(isStart=false)` discards the current object and
   re-sources the graph PER TRAVERSER, i.e. a flatMap. That CROSS JOIN already existed for the
   SCALAR tail (`inject(1).as('a').V()`), and a re-source reads only the carried schema — never
   the parent's payload, by definition — so it was parent-agnostic already in everything but its
   type. Widened it (`lowerScalarVE` → `lowerReSource`) and registered `V`/`E` as prefix StepFns;
   `seedRooted` consumes a SOURCE V()/E() before the prefix fold runs, so the StepFn only ever
   sees the mid-chain position. **L3 1437 → 1449** (+12/−0), including
   `g_VXvid1X_asXaX_V_hasXage_gtXselectXaX_valuesXageXXX_valuesXnameX`, the `E()` id forms, and two
   `property(k, __.V(…)…)` write-operand scenarios.
   - **Placement note worth keeping:** it lives at `steps/resource.ts`, the shared level, NOT under
     `tail/`. Importing it into `prefix/movement.ts` from `tail/projection.ts` created a module-INIT
     cycle — `child-shape.ts` builds a Set from `scalar.ts` at import time, and the new prefix→tail
     edge reordered initialization into a TDZ error. A leaf both families need belongs beside them.
   - **Still deferred (fail-closed):** a re-source after `path()`/`sack()`/`otherV()`, whose
     carried fork through the CROSS JOIN is undefined.

4d. **`within()`/`without()` over a folded traversal — LIST membership.** ✅ **Partly landed
   2026-07-27.** A predicate operand had one reading: substitute a SCALAR and compare. But
   `within(__.V(1).out('knows').values('age').fold())` is a LIST — "is the value among the members
   that read produces" — so it is intercepted at the PRED level and re-minted as `withinList`/
   `withoutList`, which predicateSql renders as a json_each scan over the folded sub-read. The
   fold-to-JSONB core is now shared with the set-op operands (`foldedListSubquery`, list.ts) so the
   two cannot disagree about which traversals qualify. **L3 1456 → 1457.**
   - **Scoping trap worth keeping:** `json_each` exposes a column named `value`, and `hasProp`
     passes the UNQUALIFIED `value` column of `vertex_properties`. Rendered as
     `EXISTS (… WHERE je.value = value)` both sides bind to json_each, every row matches, and
     `within` silently returns everything while `without` returns nothing. Keeping the operand on
     the LEFT of `IN (SELECT …)` evaluates it in the outer scope. The `is()` host never showed
     this — it passes a qualified column — so only the has() form exposed it.
   - **Still open:** a UNION-rooted operand (`within(__.union(__.V(1)…, __.V(4)…).fold())`, ~4
     queries). Widening the rooted test to admit a union whose arms are all rooted was tried and
     REVERTED: it compiles, but returns unfiltered rows, so something in the source-union fold's
     shape does not reach the list operand intact — diagnose that before re-widening. A
     `constant()` arm additionally is not seedable as a source-union arm yet
     (`unsupported source step: constant`). *Low-Med.*
   - **Also still open:** a CORRELATED list operand (members varying per traverser), which the
     standalone sub-read cannot express by construction.

5. **Non-element child bodies + map re-entry.** ✅ **The child-seam half is now generic (2026-07-27);
   what remains is named below.** The dependency was that only 3 of 11 stream kinds could be a child
   body, and four items pointed at it. Fixed by making the seam shape-agnostic rather than adding
   shapes one at a time:
   - **ONE cardinality rejoin for every shape.** `applyChildCardinality` derives the payload from
     `streamPayloadCols` (split out of `streamColumns` — already the single authority per kind) and
     re-homes the stream by spread (`{...child, ...carryOf(parent), rel}`), so metadata rides along.
     The scalar-specific copy is retired. **Adding a shape now adds nothing here.**
   - **ONE projection classifier.** `classifyProjectionChildRows` covers
     `<element prefix>.<terminal projection>`, parameterized by which projection it accepts; map and
     record are two predicates over it, in the pure classify leaf with their siblings.
   - **MAP bodies** (`local`/`map`/`flatMap(__.valueMap(…))`) and **RECORD bodies**
     (`project(k…)`/multi-label `select(k…)`) compile, verified elementwise against the ROOT form
     through the real GraphBinary wire, with movement+filter prefixes. L3 1470 → 1471.
   - Two builder-level fixes fell out: `lowerValueMap` refused a live origin and declared no carried
     columns (so a map could never rejoin a parent), and it sorted map keys alphabetically —
     destroying the property INSERTION order `bareValueMapProps` builds, invisible until a map could
     be framed from a child. There is now ONE blob encoding: the framer treats a bare ARRAY as a
     list of bare members, exactly as it already treats a bare scalar as an inferred value.

   **Two premises that were FALSE — do not rebuild on them:** (a) "the element terminal needs a
   relational form" — `local(__.out())` already worked, the element child has its own provider;
   (b) "the remaining shapes are blocked on making the tail's terminal boundary relational" —
   `project`/`group`/`path` already HAVE relational forms and were blocked only on having no child
   PROVIDER. So no tail-boundary rewrite is needed for them.

   **Still open, each precisely scoped:**
   - **A GROUP child body.** Design is settled — the wire frames `group` as ONE Map from all rows (a
     barrier), so a scoped group must emit one map PER PARENT, i.e. a `MapStream`, which the seam now
     supports. Threading an ORIGIN dimension through `lowerGroup`/`GroupSource` means a per-origin
     analogue for each of its 6+ value modes (`valFold`, `valElement`, `valNestedMap`, `valReducer`,
     composite keys). **An earlier draft called the mode coverage a decision needing a human; that
     was overstated — measured, there is almost no demand** (2 corpus traversals mention a group
     inside a child body, and BOTH are `by(__.group()…)`, i.e. group at root with a group-shaped
     KEY). So: build it when a scenario asks, and start with the cheap half — a bare `groupCount()`
     child body has exactly ONE value mode (count → a scalar), so it sidesteps the matrix entirely.
     Note only the SCALAR-key half is framable: a bare `groupCount()` over elements keys the map by
     the ELEMENT, and `frameTypedNode` has no element case, so an element-keyed map blob cannot be
     framed (the standing `materializeMapRoot` deferral). *Low-Med.*
   - **A PATH child body** (`local(__.path())`) — needs path tracking INSIDE a child scope, which is
     path-history-substrate territory, not this seam's. *Low-Med.*
   - **`valueMap(true)`/`elementMap` as a child body** — fails closed (excluded by the classifier);
     **NO scenario demands it: zero corpus traversals use either as a child body**, so this is a
     Low tail to revisit when one appears, per the standing rule. An earlier draft of this line
     called it a type-vocabulary DECISION and posed "a T-token tag in the `{t,v}` tree vs a `MapOf`
     key-side variant" — that was a false dilemma and is struck. The `{t,v}` codes are explicitly
     the ones a property VALUE can carry, with element/token codes deliberately excluded
     (`gremlin/types.ts`), and a T token is not a value — so that option is wrong, not a trade-off.
     Token-ness belongs in SHAPE metadata, which is already how the terminal path does it
     (`{kind:'valueMap', keys, tokens}`, the framer emitting the T enums from the flag). If a
     scenario ever needs it, carry the same flag on `MapStream` — mechanical, no vocabulary change.
     *Low.*
   - **`ChildShape` is deliberately NOT widened to 'map'.** It is `BranchArmShape` minus null, so
     admitting 'map' would tell the branch triage a map ARM is mergeable when no merge covers a map
     shape — converting a clean deferral into a wrong answer. A map ARM stays unclassifiable.
   **The group failure taxonomy, measured 2026-07-27** (128 corpus traversals mention group; 88
   compile, 40 fail). Recorded because the causes are unrelated and the label "group" hides that —
   most of these are NOT group-seam work:
   - ✅ **2 — count/projection asymmetry in the value gate. FIXED** (see the give-back below).
   - **3 — a SIDE-EFFECT `groupCount("a")` in a child scope** (`local(groupCount("a"))`). Not a group
     problem at all: a string arg makes it the side-effecting form, a pass-through barrier dispatched
     by `groupCountSE`. This is P3's `sideEffect`-in-a-child-scope item.
   - **4 — `group()`/`groupCount()` over a SCALAR parent.** Needs a scalar group builder (no element
     to project, and the default value mode `elementList` does not apply). One instance of the wider
     parent-shape uniformity gap: ~67 corpus traversals fail as "X after a scalar stream / on a list
     value / cannot consume the <MAP> result shape" across ~35 steps.
   - **3 — a barrier `groupCount` inside a `repeat()` body.** That is item 3's `times(n)` unroll.
   - **2 — `group().by(traversal)` KEY needing `fold()`/`sideEffect()` in the body** — child
     vocabulary, item 2.
   - **~2 — a bare `groupCount()` child body** (map per parent) — the cheap half of the item above.
   - remainder: a nested group inside a value body, `sample()`, and one-offs.

   → [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md),
   [carried-schema-and-projection-reentry](./2026-07-14-carried-schema-and-projection-reentry-plan.md)

5b. ~~**Re-enter the PREFIX after a value-tail barrier — `…order().by(k).out()`.**~~
   ✅ **LANDED 2026-07-25** (the prescribed retype boundary; the `WITH #5` coupling turned out not
   to bind — a keyed/bare order re-enters as an ordered *element* stream, which never needs #5's
   non-element re-typing). A plain `order()` whose FOLLOWER is a step outside the value-tail
   vocabulary (`VALUE_TAIL_STEPS` = every projection + modifier `foldTailAcc` folds) is no longer a
   terminal accumulator: `tailOrder` (`steps/tail/projection.ts`) mints a fresh emission `encounter`
   (ROW_NUMBER over the composite order key, `lowerElementOrderReenter`) that SUPERSEDES any
   demand-pass encounter in its declared slot, and re-enters generic lowering. The order then
   survives the follower through the *existing* substrate — `finishMove` re-mints the encounter
   across each hop, the branch merges mint the arm-merge encounter — so `order().by(k)` followed by
   movement (`out`/`in`/`both`/…), a branch (`union`/`choose`/`coalesce`/`optional`), `as()`, or a
   post-movement `limit` all order correctly. Direct-key order-expr building was factored to
   `directOrderExpr`, shared with `lowerElementOrderByTraversal` (no second copy). Pinned by
   `test/compiler/movement-filter.exec.test.ts`; **L3 1278 → 1281** (incl. the Coalesce scenario
   `g_V_outXcreatedX_order_byXnameX_coalesceXname_constantXxXX` and an `order().by().as().outV()`
   chain).
   **Residual (deferred, fail-closed):** `order()` before a movement/branch while a **path** is live
   throws `order() before a movement/branch while tracking a path not yet supported` (a fresh
   encounter would collide with the path's positional ordering) — that IS #6/path-history territory.

6. **`order().by()` of paths (path natural-order comparability).** Unlocks the Orderability
   conformance cluster. **Medium.**
   → [path-history-substrate](./2026-07-18-path-history-substrate.md)

7. **One type channel — collapse `as` + `vtype` into a single scalar `type`. ✅ DONE 2026-07-26.**
   → [type-channel-unification](./2026-07-25-type-channel-unification.md)

   Landed as four commits (`78e2508`, `bc212ca`, `6997533`, `715ba07`). All 7 `test.todo`s in
   `test/typed-collections-e2e.test.ts` are green: **838 pass / 0 fail / 0 todo, L3 1364 (+1)**.

   `ScalarType = {static}|{perRow}|{unknown}` lives at the render boundary and is the ONLY
   spelling — the derived `as`/`vtype` accessors were deleted, so the compiler named every site
   and each had to state which case it means. `Shape{kind:'value'}` and `GroupKey` scalar carry
   the same union (this absorbed the `as?` xor `perRowType?` debt item and `GroupKey.vtypeCol`).

   The runtime per-list decision the dead end was missing is `barrier.ts foldMember()`, shared by
   every fold barrier: wrap members as `{t,v}` iff SOME member's type is lossy under its storage
   class, asked once per relation so the encoding stays UNIFORM per list. `assertUntypedList` is
   retired — the list transforms read members through one `memberValue`/`memberNode` seam, so a
   typed list flows through the same code as a bare one.

   Two facts worth keeping:
   - **Lossless ≠ what SQL can recover.** The bar is what the READER infers back identically, so
     the lossless set is `string/double/int` — NOT `long`. SQL distinguishes int from long by the
     int32 range; the framer's JS inference does not, so a bare long > 2^53 returns as INT.
   - **A merge that cannot preserve a per-row type must say so.** The union/optional arm merges
     project `(v[,vt])` with no vtype column, so they degrade to `unknown` rather than claim a
     column the relation lacks — `assertStreamColumns` caught exactly that during the migration.

---

## P2 — feature / conformance buckets

7. **`match()` generic patterns.** The compiler rejects patterns not starting with `as(...)`.
   **Re-measured 2026-07-27: the Gremlin `match()` STEP is in better shape than this line implied
   — 14 of the 35 `Match.feature` traversals compile today.** The remainder splits into small,
   nameable gaps rather than one wall: a pattern not starting with `as()` (6), 0-root-variable
   patterns (3), and pattern steps `count`/`values`/`order`/`map` (6). **Medium.**
   → [conformance-structural-bets](./2026-07-12-conformance-structural-bets.md)

7b. **`g.match("MATCH (a:person)-[:knows]->(b:person)")` — the GQL pattern-STRING form. NEEDS A
   DECISION, not just implementation** (found 2026-07-27; 23 scenarios, all of
   `MatchString.feature`, and the single largest remaining L3 bucket: every one fails with
   `unsupported source step: match`). This is NOT the `match()` step above — it is a second query
   LANGUAGE embedded in a string argument (TinkerGQL / GQL patterns), so it needs a pattern parser
   and a lowering from pattern → our IR. That collides with locked decision #2 (*the parser is
   generated from TinkerPop's grammar, never hand-edited*): the MATCH-string grammar would be a
   new hand-rolled front-end unless upstream ships one we can generate from. Worth answering
   deliberately — 23 scenarios is a lot, but a bespoke second parser is exactly the kind of thing
   that decision exists to prevent. **Large.**

7c. **Predicate operands that are TRAVERSALS — ✅ the four shapes landed 2026-07-27; narrow tails.**
   TinkerPop compares against a traversal operand's FIRST result. All four shapes now lower:
   a `constant()` operand folds to a literal in the IR (`foldConstantPredicateOperands`, +29
   scenarios, and it reached hosts nobody enumerated — `hasLabel`, the `all()`/`none()` list
   predicates, `choose`); a RE-SOURCED (`V()`/`E()`-headed) operand compiles as a scalar subquery
   (`steps/tail/operand.ts`, +6); and a MUTATING operand is rejected by the read-only child
   verification (+14); and a TRAVERSER-DEPENDENT operand renders as a CORRELATED scalar subquery
   (+4). That last one follows the child seam's usual split — `<element movement/filter
   prefix>.<scalar projection>` — with the prefix going through `compileCorrelatedChild`, the SAME
   inline renderer `where()`/`filter()` use (so movement inside an operand is not a second
   implementation), the projection reading the reached element through `aliasCtx` exactly as
   `correlatedExists` does, and a terminal reducer reusing `correlatedReduce`. An EMPTY prefix is
   the degenerate case, not a special one: the element the operand lands on IS the traverser,
   which is what keeps `has('name', __.values('k'))` on the same path as
   `has('name', __.out().values('k'))` instead of being a `values(k)` special case. An
   unproductive operand is SQL NULL — already TinkerPop's answer at both pinned hosts (`eq(NULL)`
   drops the traverser; a NULL member contributes nothing to a `within` set while a sibling
   constant still matches).

   **Still open**, all narrow: ✅ the `__.sack()` operand (a carried column — it needs the host's row, not
   a subquery), `hasId(__.V(id).id())` in both spellings, and the fast-path DECLINE all landed
   2026-07-27 (+5). `tryInlineScalarPredicate` was THROWING on an operand it could not resolve,
   which violates its own "return null and the caller falls through" contract — a fast path must
   never define support by vocabulary exhaustion; with the decline it reaches the generic path and
   one choose() scenario passes there.

   **Genuinely left:** `within`/`without` over a MULTI-VALUE operand — and this one is NOT the
   cheap wiring it looks like (checked 2026-07-27): `predicateSql` renders each operand as ONE
   element of a comma list, so a SET-valued operand cannot be substituted in as an Expression the
   way a scalar one can. It needs `expr IN (SELECT …)` / `IN (SELECT value FROM json_each(<list>))`,
   i.e. a scalar-vs-set distinction in the pure SQL layer — a new concept there, not a new caller;
   the `union(...).fold()` operands — the union-SOURCE half of that is no longer a blocker (item 4b
   landed; such a body compiles as a standalone read now), so what is left is the set-valued
   operand above PLUS widening `isReSourced` (`steps/tail/operand.ts`), a narrow proxy for
   "traverser-independent" that tests for a `V`/`E` head and so still misses a union of independent
   branches; the `none()` host; and an operand with no scalar to read (a filter body such as
   `__.not(__.identity())`). Correlation needs an element ScalarCtx, so a scalar-parent `is()`
   still defers. *Low.*

7d. **`match()`: lower each pattern through the FULL loop, not `lowerElementSteps`.** (Found
   2026-07-27, [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md) #3 — the sharper
   framing of item 7's "small nameable gaps".) The pattern BODY is already generic (`union` inside a
   pattern works); what is hand-rolled is the binding table around it, which holds node rowids only —
   so a scalar (`values`), reduced (`count`) or edge-typed end var defers. **This is 4b's move, and
   4b has now built the machinery** (`lowerRootedArm` + kind-dispatch): lower to a Stream of any
   shape and bind on its `kind`. The one difference is that a pattern is SEEDED from a bound var, not
   rooted, so it wants `lowerStepsStrict` over `applyPattern`'s existing seed rather than a fresh
   source. Note **23 of match's 49 corpus failures are the MATCH-STRING form (7b), not this** —
   `match()` compiles 17/66 and the real residual here ≈ 26. **Medium.**

8. **Graph-algorithms layer (new cluster).** Algorithms as `call()` services + OLAP step names
   (`pageRank`/`connectedComponent`/`peerPressure`/`shortestPath`) as desugar Passes. Nothing built.
   Build-first: PageRank as the proof-of-concept. Absorbs the old P3 `shortestPath()` line. Carries
   6 open research questions. **Medium.**
   → [graph-algorithms](./2026-07-24-graph-algorithms-plan.md)

9. **Side-effect readback predicates — `where(within/without('x'))`.** The
   `aggregate().where(without('x'))` dedup idiom; no aggregate-readback exists yet. **Medium.**
   → [side-effect-state](./2026-07-13-side-effect-state-plan.md)

10. **`addV` mid-chain + read-tails-after-write.** Gates a write-conformance cluster (e.g.
    `property()` after `addV()`). **Medium.**
    → [compiler-consolidation](./2026-07-16-compiler-consolidation-plan.md) §6,
    [write-args-through-read-spine](./archive/2026-07-16-write-args-through-read-spine.md)

11. **Federation tail** (call() Phases 1–6b landed): CF-parity test on the DO harness (Low-Med);
    map-valued injection for mid-traversal federation (Med); import-a-graph (Med/Large);
    federated *traversal* via local scratch (Large); async failure/timeout/retry policy (Low-Med).
    → [call-service-registry](./archive/2026-07-20-call-service-registry-plan.md)

12. **Strategy completion tails** — `SubgraphStrategy(vertexProperties)`, `PartitionStrategy`
    meta-properties + partition-aware upsert (`mergeV`/`mergeE`), nested-body descent. **Medium/Low.**
    → [with-strategies-exploration](./2026-07-13-with-strategies-exploration.md)

13. **`with(...)` / `OptionsStrategy` sugar.** ✅ **The `valueMap().with(WithOptions.tokens)` form
    LANDED 2026-07-25**: `foldValueMapWith` (`ir/strategies.ts`, a fold Pass) desugars the all-tokens
    form — `with('~tinkerpop.valueMap.tokens')` (the wire string the JS GLV resolves the enum to),
    optionally `+ 15`/`all`, or the raw `{withOption}` enum the frontend now captures
    (`WithOptionsConstants_*`) — to the existing `valueMap(true)` tokens flag. **L3 1281 → 1284.**
    **Still open:** the SELECTIVE token subsets `with(tokens, ids|labels)` (a proper subset paired
    with `by(unfold)` that also flattens the value lists — no `valueMap(true)` equivalent; fails
    closed today), `index().with(WithOptions.indexer, WithOptions.map)` (needs item 14), and any
    other `with()`/OptionsStrategy host. **Low-Medium.**
    → [with-strategies-exploration](./2026-07-13-with-strategies-exploration.md) §0

14. **`index()` step** — unimplemented (`index() on a list value not yet supported`). Default (list)
    indexer turns a collection `[e0,e1,…]` into `[[e0,0],[e1,1],…]`; a `with(WithOptions.indexer,
    map)` variant produces a Map (needs item 13's `with` selector). `format()` is **already landed**
    (8 L3 scenarios pass; the doc's "both unimplemented" was stale) — only `index()` remains here.
    **Low-Medium.** → [seam-reuse-audit](./2026-07-13-seam-reuse-audit.md)

15. **Multi-key `cap('x','y')` + cap-of-group unfold.** **Low-Medium.**
    → [side-effect-state](./2026-07-13-side-effect-state-plan.md)

16. **W4 — multi/meta-property schema rework → `Cardinality.list/set` writes.** Only meta-property
    *typing* is touched today (P3), not the list/set write cluster. **Medium.**
    → [conformance-structural-bets](./2026-07-12-conformance-structural-bets.md) (W4)

---

## P3 — narrow / fail-closed matrix-fill (correct-by-design today)

Each fails closed (clear error, never mis-executes). Do only when a concrete scenario demands it.

- **Recursive-path tails** — `path().by()` on the walk, `cyclicPath`/`until`/`emit(pred)` with path,
  edge-inclusive bodies, mixed linear+repeat, recursive-regime `from()`/`to()`. Includes
  `path().by(__.trav)`/`by(T.token)` in the array regime — needs a new *positional-child* substrate
  over `json_each` (`steps/tail/path.ts` hard-throws). *Low-Med.*
  → [path-history-substrate](./2026-07-18-path-history-substrate.md)
- **Group re-entry matrix-fill** — element/property-valued inner keys+values, composite `project()`
  keys, `elementMap()` followers, `keys→SET`, `as()`/`order()` on a group. `steps/tail/group.ts` is
  where the child seam most often bottoms out — extend it (item 2), don't dedup. *Low.*
  · ~~**An IMPLICIT-collect group value is not emission-ordered**~~ ✅ **FIXED 2026-07-27.**
    `by(__.out().values('n'))` built its list with a bare `json_group_array` — no `ORDER BY` — so
    member order was incidental (it happened to match the emission order until any extra CTE in
    the body, e.g. a `select(label)` re-root, permuted it). It now shares the explicit fold's
    AGGREGATE: `tryCompileScalarValueRows` retains the child frame so the per-origin `encounter`
    survives, and the list is built `ORDER BY` it. This also retired the weaker
    `val:'scalarList'` branch for child-seam values — with marked rows the SQL is authoritative,
    so the wire layer no longer strips nulls in JS (which could not tell an unproductive child
    from a productive NULL member). `scalarList` remains the DIRECT `by(key)` projection, which
    has no child rows and does emit SQL NULLs.
    **The correction worth keeping:** sharing the fold's aggregate must NOT import the fold's
    PRODUCTIVITY. An unreduced value traversal that yields nothing FILTERS the traverser (inner
    join, key vanishes); `fold()` is a barrier that always yields, so its key survives with `[]`.
    TinkerPop pins both halves on one graph — `Group.feature`
    `g_V_hasXperson_name_withinXvadas_peterXX_group_by_byXout_foldX` keeps `v[vadas]: []` while
    its unreduced twin `…_byXout_orderX` drops the key, annotated *"validates that a collecting
    barrier produces a filtering effect if it is unproductive"*. So the tempting
    "implicit-collect ≡ fold" equivalence is TRUE for the aggregate and FALSE for productivity;
    the element path (`genericElementImplicitFold`) already gets this right by a different
    route (`groupBy=false` + element rows). Pinned by `group-properties.exec.test.ts`.
  → [group-value-generic-seam](./2026-07-18-group-value-generic-seam-plan.md),
  [p3-reenterable-shapes](./archive/2026-07-16-p3-reenterable-shapes-plan.md)
- **Mixed-shape branch corners** — node+edge in one branch, `path()` through it, `as()` inside an
  arm. Items 1+4 did NOT close these as a family (that claim was aspirational); they are each an
  independent wall, and all four now fail closed with an error naming the branch:
  · node+edge in one branch → the element lowerer's mixed-element-kind defer.
  · `path()` through a mixed-shape branch → all four mixed-shape lowerers now throw, including
    `optional` (that one silently rode `path` through `carryFrag` unpadded until 2026-07-25 —
    a hit arm is a scalar row with no path position, a miss arm keeps the element's).
  · ~~`as()` inside a non-element arm~~ → ✅ **closed 2026-07-27** by item 2's Slice 3: the
    alias-aware merges landed first (item 1's residual), so admitting `as()` to the child
    vocabulary was safe. Element and scalar arms both merge the binding. *Low.*
  → [p4-dynamic-variant](./archive/2026-07-16-p4-dynamic-variant-plan.md)
- **Write fail-closed walls** — `addE`/`mergeE` endpoint traversals past a movement/branch (need the
  bare rowid, not the framed external id), map-valued merge drivers, nested keys/values. *Low.*
  → [writes-through-read-spine](./archive/2026-07-17-writes-through-read-spine-plan.md)
- **`has(k, eq(collectionLiteral))` + meta-property typing** — two remaining typed-value tails.
  (`Scope.local` STRING transforms over typed list elements moved into the unification item
  below — it is the same root cause, not an independent gap.) *Low.*
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
- **L3 ratchet hygiene** — descope OLAP/GraphComputer + `io` source in `tags.ts`. *Low.*
  → [with-strategies-exploration](./2026-07-13-with-strategies-exploration.md)

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

- ✅ **Group value gate: the two shape classifiers are now COMPLEMENTARY, not alternative**
  (2026-07-27). `tryLowerGroupChildSource` picked ONE classifier by whether the value body's
  terminal was `count` — `classifyCountChild` (no scalar projection) or `classifyScalarChildRows`
  (`<prefix>.<projection>.<reducer>`). Neither subsumes the other, so a count-terminal body WITH a
  projection matched neither: `by(__.label().count())` failed while `by(__.label().sum())` worked.
  Both are tried now; emit needed nothing (a count-terminal body already routed to
  `tryCompileRowsBeforeReducer`). Widens the KEY side by the same statement. L3 1471 → 1473.

- ~~**Finish deleting `correlatedExists`/`correlatedReduce`**~~ (`steps/prefix/predicate.ts`) —
  **the premise was wrong and is now retired. ✅ The real work landed 2026-07-27.** Measured, the
  module was NOT redundant: the inline form is **1.2×–17× faster** than generic lowering (20k/160k
  graph; the `count().is(P)` reducer 11.7ms vs 191.6ms, results identical), and its movement branch
  already delegates to `compileCorrelatedChild`, so the "no second movement impl" law was already
  satisfied. It was **misclassified**, not duplicated: a fast path with one load-bearing capability
  welded inside it — `splitInfixConnectors`, the ONLY implementation of infix `.and()`/`.or()`
  precedence, which made the declared `enabled≡disabled` contract false (compiling the corpus with
  `predicateInlining:false` regressed exactly 6 traversals, all that shape).
  Extracted to **`ConnectiveStrategy`, a `fold` Pass** (`ir/strategies.ts foldConnectives`) —
  TinkerPop's own name for the rewrite, and `NO_OP_STRATEGIES` already (falsely) claimed we applied
  it unconditionally. Disable-safety now measures **0 regress / 0 newly-compile** both ways;
  **+5 corpus compiles, L3 1,436 → 1,440** (top-level infix threw `and() needs at least two
  traversal branches` before — the fold only ever ran on child bodies). Also fixed: the decline
  signal is now an `InlineDecline` type rather than a message-prefix sniff, so
  `g.V().filter(__.is(0))` fails closed instead of crashing.
  **Residual, narrow:** the leaf vocabulary is kept for `until()`/`emit()` alone, where
  `walkPredicate` has no fallback — item 3's body-relation route discharges that too (compile an
  element-only until/emit predicate once as a `matching(id)` relation; the recursive term reads
  `id IN matching`). A sack/`loops()`-dependent predicate still needs the inline form.
  → [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md) #6,
  [correlated-child-rendering](./2026-07-17-correlated-child-rendering-plan.md)
- **Duplicate property→owner projection in `services/catalog/search.ts:73`** — `searchProperties`
  hand-builds the payload join its own comment says is "mirroring `lowerProperties`"
  (`tail/group.ts:648`). Zero deferrals; a schema change lands twice. The contrast worth keeping:
  `degree-centrality.ts` calls `scopedMovementCount` and gets `where(call(…).is(n))` at arbitrary
  depth for free. → [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md) #8
- **Fold the third scalar-child projector residue** (`compileScalarChildRows`, `steps/tail/child.ts`)
  onto generic `PROJECTORS`. → [compiler-consolidation](./2026-07-16-compiler-consolidation-plan.md) §1
- **Node/edge property-SQL duplication** (`plan/plan.ts` `nodeProp*`/`edgeProp*` pairs) — one
  `propSource(elem)` descriptor would halve it. Do opportunistically.
- **`write.ts` row-at-a-time nested read** (`steps/write/write.ts`) — imperative surface; could
  materialize once via the child seam + a batch form.
  → [writes-through-read-spine](./archive/2026-07-17-writes-through-read-spine-plan.md)
- **Review-fix duplication residue (C1/C2/C3 + D)** — property-list framing / tie-break / `PARTITION
  BY ordinal` dups; the `execute.ts` pre-parsed-`pmeta` divergence is latent-correctness. Status
  unconfirmed — treat as open. → [review-fix-plan](./2026-07-22-review-fix-plan.md)
- **Upstream `q`-kernel surface to lazyrecords**.
  → [q-kernel-sql-builder](./2026-07-12-q-kernel-sql-builder.md)
- **Fork TinkerPop as our vendor submodule + upstream the harness fixes.** Agreed 2026-07-25;
  the submodule now tracks `origin/master` directly (2026-07-26) and the fork exists at
  `danielbodart/tinkerpop` — what remains is landing the payloads. Four found so far, each
  verified against source, in descending confidence:
  1. **`toNumeric` cannot produce a BigInteger** — branch `fix-cucumber-bigint-numeric-parsing`
     is written, self-verified and pushed; it captures the `d[…].<suffix>` type tag and
     dispatches on it (mirroring gremlin-dotnet's `NumericParsers`), with `l` → Number inside the
     safe-integer range and BigInt outside it, matching `LongSerializer.deserializeValue`.
     **Not yet opened as a PR.** See the won't-do entry below for why our framing is already right.
  2. **The generated cucumber `gremlin.js` references an undefined `uuid`** — the JS translator
     emits `uuid.v4()`/`uuid.parse(…)` (16 uses), but the file never imports it and `uuid` is in
     neither deps nor devDeps, so every UUID scenario dies with `uuid is not defined`.
     Costs us `g_injectXUUIDXXX` (dropped from the ratchet).
     **CORRECTION (2026-07-26): the generator IS in-tree** — the old note said it wasn't. It is
     `gremlin-js/gremlin-javascript/scripts/groovy/generate.groovy`, and since the generated
     `test/cucumber/gremlin.js` is TRACKED, the fix touches all three: the template's import
     block, the `uuid` devDependency, and the regenerated output.
     **Patch ready** (verified to apply from a clean tree, `uuid@14` confirmed to export the
     `parse`/`v4` the generated code calls): `docs/upstream-patches/01-cucumber-uuid-import.patch`.
  3. **The cucumber port is hard-coded** (`gremlin-js/gremlin-javascript/test/helper.js`, no env
     override; docker-compose pins 45940/45941 too). This is the intermittent CI conflict — it
     collides with our own conformance host, which must own that port because the client offers
     no way to configure it.
     **Patch ready**: `docs/upstream-patches/02-cucumber-port-env-override.patch` —
     `GREMLIN_SERVER_PORT` /
     `GREMLIN_SERVER_AUTH_PORT`, defaults unchanged (verified byte-identical when unset). Also
     drops a duplicate hard-coded copy in `test/integration/traversal-test.js`, which already
     imports from `helper.js` and can just use its `serverUrl` export.
  4. **Bun's `undici` shim lacks `Agent.close()`/`destroy()`** — a BUN bug, not TinkerPop's
     (`close` is non-optional on undici's `Dispatcher`, and the real Agent inherits it via
     `DispatcherBase`). Worked around in `test/support/undici-shim.ts`; worth reporting to Bun.
     Do NOT "fix" this by making the client call `close?.()` — that would silently skip real
     connection-pool teardown wherever a dispatcher genuinely lacked it.

  The fork is also the intended home for the **non-conformant-client UUID/ISO-date shim** (a JS
  client cannot send a UUID's type, so sniff the obvious string shapes — **opt-in**, never
  default: a string that merely looks like a uuid is not one, and silently retyping user data is
  worse than not typing it). → [typed-merge-values](./archive/2026-07-17-typed-merge-values-plan.md)

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
- **Platform walls** — regex UDFs, `typeOf` over some stored props, bigdecimal, lambdas,
  OLAP/GraphComputer → architectural limits, fail-closed by design.
- **Child-scope split-seed + 4-consumer migration** → superseded by the smaller carried-cols fix.
- **"`asNumber(GType.BIGINT)` of a small value should downcast to Int/Long on the wire"** → **our
  framing is already correct; the blocker is a vendored-harness defect.** Verified 2026-07-25
  against source, correcting a P3 entry that had the causality backwards:
  · TinkerPop's `NumberSerializationStrategy` does magnitude-dispatch ONLY for
    `typeof item === 'number'`; for `bigint` it is unconditional
    (`return this.ioc.bigIntegerSerializer.serialize(item, …)`). There is no BigInteger downcast
    to replicate — `execute.ts`'s `case 'bigint'` already does exactly what TinkerPop does.
  · `data/BigInt.feature` expects `d[456].n` — BigInteger — for the value 456, i.e. the suite
    requires the declared type to be PRESERVED, not narrowed. Emitting Int would contradict it.
  · The real cause is `gremlin-js`'s cucumber `feature-steps.js`:
    `function toNumeric(s) { try { return parseFloat(s) } catch { return BigInt(s) } }` —
    `parseFloat` never throws, so the `BigInt` branch is unreachable and `d[456].n` becomes the
    JS Number 456, which our correct `456n` can never deep-equal.
  · 5 sibling scenarios in that file PASS today (`math(mul)`/`sum`/`min`/`max`/`project`) because
    `math()`/`sum()` coerce away from BigInteger — a blanket downcast would REGRESS them.
  Route: fix it in our TinkerPop fork's harness and offer it upstream (debt item above), not by
  changing our serializer. ~3 scenarios, net L3 gain likely ≤0 if "fixed" our side.

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
  path-decayed ranking (partly enabled now `sack()` landed). Separate-repo, exploratory.
- **[graph-algorithms](./2026-07-24-graph-algorithms-plan.md)** — build spec for P2·8.
- **[conformance-structural-bets](./2026-07-12-conformance-structural-bets.md)** — the strategic
  unlock map; bets largely landed, tails folded into P1–P3.
- **[cross-do-federation-prior-art](./2026-07-13-cross-do-federation-prior-art.md)** — federation
  prior-art (ATTACH rejected; `call(federate)` landed).
- **[path-tracking-prior-art](./2026-07-12-path-tracking-prior-art.md)** — path prior-art; two-regime
  plan implemented, only P3 tails remain.
- **[wire-and-storage-facts](./2026-07-25-wire-and-storage-facts.md)** — Map.Entry framing + MapStream
  model. Durable reference, not a plan.
