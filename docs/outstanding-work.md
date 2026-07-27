# Outstanding work

The de-duplicated index of open work across the `docs/` corpus. **Each line sets the scene — what,
why, what it unblocks, where to start — not a spec.** The linked doc holds the rationale; the
picking agent does the detailed validation and design. Landed work is excluded (the corpus
over-reports `LANDED`; this keeps only what a code check confirms open). Live per-step capability:
`feature-support-matrix.md`.

**Refreshed** 2026-07-26 against L3 1362 unique / 2297 (`l3-state.json` shows 1364 — two names
recur legitimately, see `test/CLAUDE.md`); item 2's Slice 3 took it to **1372** on 2026-07-27.
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
   (bodies producing map/group/project/valueMap shapes), `repeat()` in a child (item 3). The fix is
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
       `where(__.out().where(__.select('x'))))` silently returned `[]`. It now calls
       `mentionsLabel` up front and falls through to the materialized gate (the fast-path
       contract: recognition-failure falls through). Fixed a live wrong answer.
     - `emptyElementLike` now keeps the input's carried COLUMNS (zero rows). At root that is
       invisible; in a child scope it is the difference between a correct answer and a relation
       the consumer cannot join to its frame ordinal.
   - **Still open:** `choose().option()` without a `Pick.none` default (mixed pass-through); child
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

3. **Alias columns through `repeat()`.** Teach the recursive-CTE term to carry `as()`/`select(label)`
   columns. (The sibling capability — *foldable* carried state via `sack()` — ✅ landed 2026-07-24;
   its residuals are Low fail-closed tails in P3.) **Unblocks:** labels surviving a recursive walk.
   Start: `steps/prefix/branch.ts` (recursive term). **Medium.**
   → [deep-seam-migration-roadmap](./2026-07-18-deep-seam-migration-roadmap.md) #5,
   [path-history-substrate](./2026-07-18-path-history-substrate.md),
   [foldable-carried-column](./2026-07-24-foldable-carried-column-plan.md)

4. **Canonical-emission-order Stage C — residual only.** The headline premise ("branch merges don't
   mint the arm-merge `encounter`") is **false and has been for some time**: every merge family mints
   it (Stage A landed), and as of 2026-07-25 that includes the four scalar-parent mixed-shape merges
   (item 1). `dedup(labels)` first-in-emission also landed (`filter.ts`). Stage B landed for movement,
   source seed, element-prefix `limit`/`range`/`skip`, root `fold`, child `first`, and `values()`.
   What actually remains:
   - **`union()` as a SOURCE form** — `engine/engine.ts` `seedUnion` throws outright
     (`emission-order encounter over a union() source not yet supported`).
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

5. **Map/non-element re-entry.** `valueMap().select()` into a retyped `MapStream`, and `as()`/
   `select(label)` over group/map/path/property streams. **Medium.**
   → [carried-schema-and-projection-reentry](./2026-07-14-carried-schema-and-projection-reentry-plan.md),
   [deep-seam-migration-roadmap](./2026-07-18-deep-seam-migration-roadmap.md) #5

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

7. **`match()` generic patterns.** Largest single named L3 cluster; the compiler rejects patterns
   not starting with `as(...)`. **Medium.**
   → [conformance-structural-bets](./2026-07-12-conformance-structural-bets.md)

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

- **Finish deleting `correlatedExists`/`correlatedReduce`** (`steps/prefix/predicate.ts`) — the
  correlated-child refactor largely landed; these inline fast-paths remain (the "no second movement
  impl" law). → [correlated-child-rendering](./2026-07-17-correlated-child-rendering-plan.md)
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

Sources: [lazyrecords-cutover](./archive/2026-07-11-lazyrecords-cutover-plan.md),
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
