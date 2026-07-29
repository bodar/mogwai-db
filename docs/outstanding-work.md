# Outstanding work

The de-duplicated index of open work across the `docs/` corpus. **Each line sets the scene — what,
why, where to start — not a spec.** The linked doc holds the rationale; the picking agent does the
detailed validation and design. Live per-step capability: `feature-support-matrix.md`.

**Refreshed** 2026-07-27 against L3 1475 / 2297. Item numbers are stable IDs — landed items are
deleted and their numbers are not reused, because code comments and other docs cite them.

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

0. **The L5 findings — ALL LANDED; one adjacent defect still open.** Design rationale +
   the three unbuilt oracles: `docs/2026-07-28-property-based-testing-l5.md`. The fast-path differential
   (`test/L5-properties/`) found 22 divergent traversals in 17 signature groups, reducing to four
   root causes, all fixed: infix-composed predicates (front-end `parseComposedPredicate`), 3-arg
   `has(LABEL,k,v)` in the inline predicate leaf, always-producing filter bodies
   (`alwaysProductiveFilterIsNoOp`, plus relaxing the bogus `and()/or() needs two branches` guard
   that made the inline path narrower than the path it accelerates), and `bulkRepeatCount` seeding
   its frontier with `COUNT(*)` instead of `SUM(bulk)`, losing the input multiplicity — a wrong
   answer in the DEFAULT config. L3 1475 → 1490 (+15, −0); each pinned in an L4 `.feature`; the L5
   ratchet is empty and the differential finds no disagreement over ~4,000 generated traversals with
   every switch off and each one off alone. Fixed alongside: the non-productive `by(key)` drop at
   `order()` — one shared policy (`orderProductivityFilter`) applied at each element-order route.
   Worth knowing if you touch it: this was FIRST written as a `decoration` Pass injecting `has(key)`,
   to centralise the policy, and that is wrong — the rewrite is only valid over an ELEMENT stream and
   the IR layer has no shape information, so it broke all six non-element `order().by(key)` forms
   (list/map/group/record/scalar/path). Shape is exactly what the lowering knows and the IR does not. Still open, from the same investigation:
   - **`otherV()` miscounts while PATH TRACKING is live.** `g.V().out().simplePath().bothE('created')
     .otherV()` yields lop×3/marko×2 where `.both('created')` yields lop×1/marko×3. The `simplePath()`
     is provably a no-op there (a one-hop path cannot revisit), so the law must hold exactly as it does
     without it — and it does, which identifies the path form as broken. Likely the otherV() position
     projector picking the wrong endpoint off the exploded path row: `POSITION_MOVEMENTS`
     (`steps/tail/path.ts`) lists `bothV` but otherV reaches it separately. Found by the METAMORPHIC
     oracle; invisible to the differential (both configs agree). *High — silent wrong answer.*
   - **A non-terminal `fold()` after `dedup()` folds the UN-deduplicated multiset.**
     `g.V().out().dedup()` gives 4; `.dedup().fold().unfold()` gives 6. The TERMINAL fold is correct
     (`buildProjection` renders `SELECT DISTINCT` off `acc.distinct`), so this is the retype route only:
     `foldTailAcc` stops at a non-terminal `fold()` as a shape boundary and the list built there drops
     the dedup the acc had already absorbed. Found by the metamorphic oracle. *High — silent wrong
     answer.*
   - **An unproductive `sum()`/`min()`/`max()`/`mean()` body in a filter position wrongly KEEPS the
     traverser.** `g.V().where(__.out().values('age').sum())` returns all 6 vertices; only marko has
     an out-neighbour carrying an `age`, so TinkerPop returns 1. Those four reducers emit NOTHING
     over empty input — exactly the distinction `ir/productivity.ts ALWAYS_PRODUCTIVE_TERMINAL`
     draws against `count()`/`fold()` — so an empty body must DROP the traverser, and the natural fix
     is the mirror of `alwaysProductiveFilterIsNoOp`: a NEVER-productive-on-empty body needs the
     existence gate, not a constant. **Invisible to the L5 differential** (both configs answer
     identically), found only by reading the semantics while diagnosing the four above. Same
     blind-spot class as the `order().by()` defect, and the argument for L5's metamorphic-law oracle,
     which compares against a law rather than another implementation. *Medium-High — silent wrong
     answer.*

   The IR-vs-shape boundary this item states is **refined** (not overturned) in
   [shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md): the Pass failed as
   an unchecked shape CLAIM, not for want of information — the correct shape-specific injectors
   anchor on steps whose output shape is fixed by name. Same doc measures where the defects actually
   come from (carried-channel drops 33%, shape/vocabulary 8%) and names the higher-yield work.

0b. **`concat(<traversal>)` — LANDED 2026-07-29, and it built the `apply` child-value seam.** The
   five wrong goldens are re-recorded (each hand-verified against upstream's `Concat.feature`) and
   L3 is 1504 → 1511. What the work actually established, and what is left of it:
   - **TinkerPop has TWO child-value contracts and we modelled one.** `TraversalUtil.produce`
     returns a `TraversalProduct` and its consumer FILTERS when unproductive (`FormatStep extends
     MapStep` → `EmptyTraverser`). `TraversalUtil.apply` returns the value, THROWS when
     unproductive, and can never filter — `ConcatStep extends ScalarMapStep`, whose
     `processNextStart` is `traverser.split(map(traverser), this)` (1-in-1-out), and whose
     `prepare()` sets `setBulk(1L)` so a child cannot multiply the parent either. The modulation
     seam's `required?: boolean` conflated them; it is now `ModulationContract`
     (`'produce' | 'apply' | 'presence'`, `steps/tail/child.ts`) with the JOIN derived from the
     contract. `'presence'` is the third real case — `choose()`/`order().by()` read the `present`
     column themselves and are neither TinkerPop method.
   - **The seam is unchanged for provisioning** (still PARENT STREAM / `pushChildScope`), so the
     remaining `TraversalUtil.apply(traverser, …)` consumers plug in by DECLARING
     `contract: 'apply'` and need no new substrate: `Parameters.java:125,177,178`
     (`property(k, __.t)` — see item 2's `property() after addV()` — plus merge-map KEYS and
     VALUES, item 0c's biggest cluster), `DateDiffStep:82`, `ListFunction`/`ConjoinStep`,
     `MergeStep`/`MergeElementStep`/`MergeEdgeStep`, `AddVertexStep` (which is what still blocks
     `g.addV(constant('prefix_').concat(__.V(vid1).label())).label()`). **This is the compounding
     part and none of it is built.** *Medium-High — one declared contract each.*
   - **Still deferring, fail-closed (1 corpus row):**
     `g.inject('hello','hi').concat(__.V().order().by('name').values('name'))` throws
     `concat() after a scalar stream not yet supported`. The cause is generic and predates this
     work: `lowerScalarProjection` (`steps/tail/projection.ts`) rejects `order()/limit()/dedup()`
     before a projection inside a child scope, because the encounter it mints IS
     `PARTITION BY origin ORDER BY <projection key>`. Its comment said "unreached in practice";
     a re-sourced modulation child now reaches it. **The opening: for a re-sourced body the
     partition is redundant** (the child ignores the traverser). *Medium.*
   - **A fast-path contract violation, fixed in passing and invisible to every artifact.**
     `tryInlineScalarPredicate` is the `scalarPredicateInlining` recognizer, whose contract is
     "recognition-failure falls through, never throws" — but `scalarTx`'s deferral escaped it, so
     `g.V().values('name').filter(__.concat(__.select('a')).is('x'))` hard-failed with the switch
     both ON and OFF. No corpus traversal has that shape, so neither the census nor L3 could see
     it. Same class as `predicateInlining` not being disable-safe (item 0). **The lesson worth
     keeping: adding a `throw` to a shared pure leaf can silently narrow every fast path that
     calls it.**
   - Semantics pinned in `test/L4-addendum/concat-traversal.feature` (8 scenarios), SQL contract in
     `test/L2-sql/scalar.sql.test.ts` (asserts `format()` keeps INNER while `concat()` gets LEFT).
     The trap worth knowing: `concat(__.inject('c'))` is `aa`/`bb`, NOT `ac`/`bc` — `InjectStep
     extends StartStep`, whose `processNextStart` APPENDS its injections while `prepare()` already
     queued the split traverser, so `.next()` returns the traverser's own value.
   - Item 7b's `MatchString.feature` claim was that this was the ONE thing between it and 25/25.
     `match()` itself is still an unsupported source step, so re-measure rather than assume.

0c. **17 fail-closed VIOLATIONS, surfaced by the census** (`test/census/deferrals.tsv`, status
   `crashed`). Each throws a raw runtime error instead of a clear deferral, which the project's
   root rule forbids outright. They were invisible before because a crash and a deferral both just
   "fail"; the census separates them and gates the count from growing. Five root causes:
   - **`Cardinality.set(v)`/`list(v)`/`single(v)` as a merge-map VALUE — 8 cases.**
     `g.mergeV([name:"marko"]).option(Merge.onMatch, [age: Cardinality.set(31)])` reaches SQLite
     with the tagged `{cardinality}` object still wrapping the value: *"Binding expected string,
     TypedArray, boolean, number, bigint or null"*. The value needs unwrapping (and the
     cardinality honouring, or a clean deferral) at the merge-map seam. Biggest single cluster and
     probably the cheapest. *Medium.*
   - **A `datetime` property beyond int32 — 2 cases.** `property("birthday", datetime(...))` with
     an epoch-ms outside ±2^31 throws Node's *"The value of \"value\" is out of range"* — an Int32
     write on a value that is a Long. A framing/serializer bug, not a storage one. *Medium.*
   - **`g.addV().property(T.id, 1)` on an existing id — 1 case.** Raw *"UNIQUE constraint failed:
     nodes.id"*. Should be a clear "vertex id already exists". *Low.*
   - **We emit syntactically invalid SQL — 1 case.**
     `g.V().as("a").out("knows").as("a").select(Pop.all, __.constant("a"))` produces SQL SQLite
     rejects with *near ",": syntax error*. A rebound label under `select(Pop.all, …)` with a
     traversal argument. **The most concerning of the five** — every other entry fails on a value,
     this one means the emitted string is malformed. *Medium-High.*
   - **Two `null`/`undefined` dereferences — 3 cases.** `child.stream` on a `project()` whose
     `by()` bodies are `select(first/last, "v")` over a rebound label; and `node.constructor` on
     the named-loop `repeat("a", …)` form (already tracked in item 3, listed here for completeness
     — the census counts it as a crash either way). *Low-Med.*

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
     next slice. *Medium.*
   - ~~**`walkPredicate` (`until()`/`emit()`) has no generic fallback.**~~ **LANDED.** A row-local
     predicate compiles once over every vertex via `keyedChildRelation` (`steps/tail/keyed.ts`) and
     the recursive term reads `id IN <origin set>` — until/emit are existence, so that is the whole
     semantics. Inline is still tried FIRST because it alone reads the walk's per-iteration state
     (`loops()`, the sack), which is why it is a capability rather than a declared FastPath.
   - **The named-loop form `repeat("a", …)`/`loops("a")` CRASHES** rather than failing closed
     (`undefined is not an object (evaluating 'node.constructor')`, 4 corpus cases). Cheap, isolated.
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
   `demandsEncounter: false` by design). There is ONE slot, `Carried.encounter`; do not re-derive a
   "two encounters" reconciliation. **Low-Med.**
   → [canonical-emission-order](./2026-07-19-canonical-emission-order.md)

4d. **`within()`/`without()` over a folded traversal — LIST membership.** The scalar-substitution
   reading landed as `withinList`/`withoutList` (a `json_each` scan over the folded sub-read, sharing
   `foldedListSubquery` with the set-op operands). Open:
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
   shape at a time; the scalar parent is biggest and has the most machinery (`SCALAR_TAIL`,
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
   → [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md),
   [shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md)

6. **`order().by()` of paths (path natural-order comparability).** Unlocks the Orderability
   conformance cluster. **Medium.**
   → [path-history-substrate](./2026-07-18-path-history-substrate.md)

---

## P2 — feature / conformance buckets

7. **`match()` generic patterns.** The END-VAR shapes are done (see 7d): a variable holds an
   element, an edge, or a scalar, and a reducer pattern binds per binding. What remains is
   STRUCTURAL rather than shape: a pattern not starting with `as()` (6), 0-root-variable patterns
   (3), `or`/`not`/nested-match patterns, a LIST-shaped end var (`fold()`), and `where(var,P)` on a
   scalar-bound var — the last only became REACHABLE once scalar vars could be bound, and it is a
   downstream alias-compare gap, not a match one. **Medium.**
   → [conformance-structural-bets](./2026-07-12-conformance-structural-bets.md)

7b. **`g.match("MATCH (a:person)-[:knows]->(b:person)")` — the GQL pattern-STRING form. DESIGNED
   2026-07-28; no decision left, and it is not Large.** 25 scenarios (all of `MatchString.feature`),
   **0 passing**, the single largest remaining L3 bucket, every one failing
   `unsupported source step: match`. Both premises this item was filed on were falsified by
   measurement: upstream DOES ship a grammar (`gql-gremlin/src/main/antlr4/GQL.g4` on
   `origin/master`, generated cleanly by our own antlr-ng invocation — 21/21 corpus patterns parse),
   so locked decision #2 is satisfied by the mechanism it already names; and the COMPILER needs no
   change — hand-desugaring every scenario into Gremlin trunk compiles today reproduces **24 of 25**
   expected result sets, the 25th blocked by an unrelated `concat()` defect. The work is: generate a
   second parser (`parser/gql/`), add one front-end translator (`src/gremlin/gql.ts`, sitting where
   `math.ts` sits), add one `extract`-category Pass. **Medium.**
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

7d. ~~**`match()`: lower each pattern through the FULL loop, not `lowerElementSteps`.**~~
   **LANDED 2026-07-27.** And the premise above was wrong in a way worth keeping: the binding table
   was never the limitation — `aliasEntry` has tagged node/edge/value/list/map since labels became
   path histories. What walled it in was folding only the ELEMENT prefix, which stops at the first
   non-element step. `applyPattern` now runs prefix fold → `lowerStepsStrict` and binds on the
   result's `kind`; a var's SHAPE is recorded at bind time (an edge rowid read as a node id is
   silently wrong, both being integers), which also lets an edge var START a pattern. A REDUCER body
   is a separate defect — a global barrier over the binding table — and routes through the child
   seam for per-binding scoping, verified equal to `map(__.<same body>)`.
   Still open there: `fold()` (list-shaped end var) and the MATCH-string form (7b).
   → [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md) #3

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

11. **Federation tail** (call() Phases 1–6b landed): CF-parity test on the DO harness (Low-Med);
    map-valued injection for mid-traversal federation (Med); import-a-graph (Med/Large);
    federated *traversal* via local scratch (Large); async failure/timeout/retry policy (Low-Med).
    → [call-service-registry](./archive/2026-07-20-call-service-registry-plan.md)

12. **Strategy completion tails** — `SubgraphStrategy(vertexProperties)`, `PartitionStrategy`
    meta-properties + partition-aware upsert (`mergeV`/`mergeE`), nested-body descent. **Medium/Low.**
    → [with-strategies-exploration](./2026-07-13-with-strategies-exploration.md)

13. **`with(...)` / `OptionsStrategy` sugar — remaining hosts.** The all-tokens
    `valueMap().with(WithOptions.tokens)` form landed. Open: the SELECTIVE token subsets
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
  **`path().by()` in the array regime is DONE** — `by(key)`/`by(T.token)` share ONE position
  projector with the linear regime, and `by(__.trav)` runs the SAME positional child compiler: the
  `json_each` explode carries `(pk, ord)` as its `origins`, which makes it an ordinary element
  stream, so no new substrate was needed. *Low-Med.*
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
- **Platform walls** — regex UDFs, `typeOf` over some stored props, bigdecimal, lambdas,
  OLAP/GraphComputer → architectural limits, fail-closed by design.
- **Child-scope split-seed + 4-consumer migration** → superseded by the smaller carried-cols fix.
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
- **[tinkerpop-core-engine-alignment](./2026-07-29-tinkerpop-core-engine-alignment.md)** — our
  vocabulary read against TinkerPop `gremlin-core` on `origin/master`. Names the prior art for
  `Carried` (`TraverserRequirement`'s declare→union→derive), lists the renames worth doing
  (incl. two dangerous collisions: `CompileScope`/`CompilerScope`, `Carry`/`Carried`), and records
  **four TinkerPop patterns to refuse** — marker-interface `instanceof` dispatch, the Global/Local
  step-class split, `GValue` placeholder duality (elegant, but worthless without a plan cache), and
  the already-refuted typed core IR. Read before proposing a naming change or porting a TinkerPop
  mechanism. Its structural half defers to
  [channel-preservation](./2026-07-28-channel-preservation-refactoring-plan.md).
