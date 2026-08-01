# Outstanding work

The de-duplicated index of open work across the `docs/` corpus. **Each item sets the scene — what,
why, where to start — not a spec.** The linked doc holds the rationale; the picking agent does the
validation and design. Live per-step capability: `feature-support-matrix.md`.

**Refreshed** 2026-07-31, **L3 line updated 2026-08-01** · **L3 1679 / 2267** (`l3-state.json`; fewer
UNIQUE names than that — the collision is expected, see won't-do) · census **0 `crashed`, 4
`nondet`** (`sample()` landed) ·
`known.ts` **1 entry** — repeat's two body routes disagree on a positional window, found by the
`repeatBodyExpansion` switch on its first sweep ·
`capability-baseline.ts` **1 entry** (was 2; the stale one is deleted, and the ratchet can now
tell a FIXED entry from an undrawn one) · L5 `L5-random` plus fixed seeds 5/11/27/91/143 at
`L5_RUNS=3000`: **36 pass / 0 fail on every run** (35).

Item numbers are stable IDs; landed items are DELETED and their numbers not reused, because code
cites them. **A deletion must sweep its citations** — item 0 was deleted with four left standing, and
that sweep (`ir/step.ts`, the vocabulary test, the L5 README + design doc) was itself a whole item.

> **Verify an item's premise before picking it — this index has been stale in BOTH directions.** A
> 10-line probe that compiles the traversal and greps the SQL is usually enough. If it is partly
> landed, rewrite the line; don't close it silently.

**Two instrument facts that shaped this refresh.** (1) The L3 telemetry's deferral buckets only rank
traversals that THREW — they are blind to a scenario that failed because we returned rows where the
spec demands an error. Read `scenarios[].firstFailingStep` too; that blind spot hid 60 scenarios
(item 22). (2) **L5 found nothing** across six runs — the generated oracles are saturated at the
current generator depth, so **growing the generator now beats running it** (item 35).

**Ordering — floor vs ceiling.** L3 is the floor; the ceiling is generic lowering that composes the
full nested grammar at any depth (`src/compiler/steps/CLAUDE.md`). P1 raises the ceiling — each item
unblocks a *family*; one-off step impls are matrix-fill, lower.

---

## P1 — ceiling-raising generic-substrate lifts

**Ranked entry point.** Numbers are IDs, not an order. **32** (a live crash) → **2** → **17**'s
partitioned row-ops seam → **33** → **34** → **29** → **3**'s
`times(n)` unroll. **28** landed and was 3's stated precondition, so the unroll is unblocked;
**17**'s cheap half landed and its remainder is the architectural current-object-aggregate
authority, a bigger question than its neighbours. (Item **30** headed this list and is now DELETED —
all eight phases of its plan landed, so the two CF-only wrong-answer walls are closed and the bulk
substrate they needed is built.)

> **CLAIMED, 2026-07-31 — two agents are on this trunk.** Item 30 itself has LANDED and is deleted
> (`io()`, seeding, the chunked loader, both formats), but the write / bulk-import-export cluster it
> pulls in still belongs to the OTHER agent: **10**, **16**, **0b**, P2·11's import-a-graph, and the
> `write.ts` row-at-a-time entry in Internal debt. Do not pick them up; take the next
> item in the ranking instead. This note is transient — delete it when the claim lapses.
> Already landed on trunk and NOT part of that claim, but in the same file: item 22's merge
> validation (`steps/write/validate.ts`, `MergeRole`, `validateNoOverrides`) touched `write.ts`
> substantially and is upstream of anything started after `b878b29`.

**Landed 2026-07-31, in this order, and each changed what came after it.** Item 27's seven
`Scope.local` fail-closed violations (one argument decode, `sliceOf`). Item 22's 24 write-path
non-validations (`steps/write/validate.ts`, L3 1623 → 1647). The root-materialization ordering gap
(was 26) — `rootOrder` is now the one place the wire's row order is decided, all eleven roots ask it,
and **that is what made 21 measurable at all**. Then 21's T1/T2/T3, the branch-arm batching family
(L3 → 1648). Two of item 2's four named wrong answers turned out to be the reference's own answers
and are now L4-pinned rather than open. Then item 17's `tail`/`sample` (L3 → 1650), which also gave
the census its first four `nondet` rows; and item 28's `repeatBodyExpansion` switch, whose first
sweep found one real disagreement (now diagnosed in `known.ts`) where nothing could look before.

**Landed 2026-08-01.** Item 21's T4 — a barrier-free branch merges traverser-major, which with a
positional consumer after it was a wrong SUBSET rather than the reorder the item was filed as. All
four merge families plus the scalar-parent branches take the key; the substrate is
`TraverserLayout.branchOrders` (the input order frozen at branch entry) and `branchFork` derives it
per merge. Item 21 is DELETED — what is left of it is Crux 4's deliberate "unordered out stays
unordered", not open work. Also item 23's wording family, as three reference-sourced authorities rather than
a rename sweep — the `by()` arity table + verify Pass, `StandardVerificationStrategy` modelled whole,
and the list-input refusals (L3 1652 → 1666). It closed item 22's `groupCount()` pair, which were
real wrong answers, and it deleted four per-host arity checks it dominates. Then item 2's scalar
child-in-child (L3 → 1669), which was a classifier gap rather than missing machinery; then item 20's
group-value barrier scope (L3 → 1671), the last of the three known wrong answers outside 21's T4.

**What that leaves.** No item below is a known wrong answer except 20's residuals and item
22's six remaining per-member type refusals — the rest fail closed. Read that as the index's centre of gravity moving from correctness to ceiling.
**The one exception is now CLOSED: item 30's two breaches were hard FAILURES rather than fail-closed
deferrals, and only on Cloudflare** — which is why nothing in the ladder found them, since every level
of it runs on Bun. All eight phases landed 2026-07-31, so what is left of that thread is two
instruments that keep the class from returning: `mise run binds` statically, and
`mise run test:cf-limits` at runtime (green, and green BEFORE the fixes — the suite never reaches the
cardinality, which is the measurement that says the ladder could not have found this).

32. **A multi-arm SCALAR `union()` in a child scope, followed by a reducer, emits MALFORMED SQL — a
   fail-closed VIOLATION.** `g.V().local(__.union(__.values('name'), __.values('age')).count())` →
   `near "FROM": syntax error`; same for `.sum()`/`.max()`, and `where(…)`/`filter(…)` hosting it give
   `near "=":`. ONE arm defers cleanly and an element-armed union runs, so the trigger is ≥2 SCALAR arms.
   Re-probed against trunk 2026-08-01 (after T4 and the ordinal/encounter pair landed): still reproduces.
   **Mechanism, off the emitted SQL:** `unionScalarStreams` (`tail/scalar.ts`) merges arms with
   `mergeLayouts(…, {rigid:'rehomed'})`, dropping the branch's child ordinal `o1`; the following
   `count()` then sees no `origins` and takes `lowerGlobalCount` instead of `lowerScopedScalarReducer`,
   so the `local()` rejoin projects the parent ordinal off a global relation and `rel.c.o0` splices
   empty: `SELECT r.v AS v,  FROM c8 r`. Architectural — the wrong thing is the scoped-vs-global reducer
   ROUTING; adjacent to the `layoutArmProjection` substrate the branch work built.
   **Invisible to every instrument:** absent from both L5 ratchets, and its two corpus witnesses
   (`deferrals.tsv`) are `unbound` so they never execute. `assertStreamColumns` cannot see it — the
   merged stream is self-consistent and the mismatch is child-frame-ordinal vs merged layout, which
   nothing asserts. **That missing assertion is the reusable half of the fix. High.**

22. **Validation the spec MANDATES and we do not perform — the write family and the arity family
   LANDED; 7 scenarios are left and they need a RUNTIME type channel we do not have.** Re-measured
   2026-08-01: of the 22 L3 scenarios failing AT an error-assertion step, **7 mis-execute and 15 only
   differ in WORDING** (→ 23). The split is not in the deferral buckets — those rank only traversals
   that THREW — so read `scenarios[].firstFailingStep` and `errorMessage`; the recipe is *"`expected …
   to be an instance of Error`" ⇒ mis-execute, anything else ⇒ wording*.
   The 24 write ones went in one change (2026-07-31, L3 1623 → 1647):
   `steps/write/validate.ts` holds TinkerPop's `ElementHelper` identifier rules and is reached from
   the four storage waists; a `MergeRole` on `MergeSpec` lets one check cover all three maps;
   `validateNoOverrides` runs statically AND in the create branch. The `groupCount()` pair went with
   item 23's arity table (2026-08-01).
   **What is left is ONE cause, and it is not the "member count" authority this line used to name.**
   `trim/lTrim/rTrim(Scope.local)` over `[1,2]` and `asString()`/`asString(local)` over a null must
   throw PER MEMBER — `StringLocalStep.map` inspects each element's runtime class — and our
   `listStringTransform` renders one `json_group_array` over `json_each`, where a member's type is a
   SQL expression and there is no way to raise from one. **The blocker is that SQLite cannot raise a
   message from an expression**, so the honest routes are (a) an error CHANNEL — a sentinel column
   the framer turns into the throw — or (b) a static check where the member types are known, which
   covers every corpus spelling (all are `inject()` literals) but not the general stream. Neither is
   built; (b) is cheap and sound, (a) is the general answer and would also serve any other
   per-row runtime refusal. Plus **1 = `property(single,k,traversal)`**, unrelated. *Low each, but
   the six share a substrate question.*

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
   **The SCALAR child-in-child landed 2026-08-01** (L3 1666 → 1669): `isScalarProducingScope`
   (`tail/child-shape.ts`) makes a `map(B)`/`local(B)` with a scalar body a scalar PRODUCER, so
   `local(__.out().local(__.count()))` and every by()/filter/branch spelling of it compose. It was a
   pure classifier gap — root lowering already accepted the identical body — and the two arms carry
   different predicates on purpose: `map` takes the FIRST result so any scalar B qualifies, `local`
   emits all of them so only a `count()`-reduced B does. `oneRowEncounter`'s proof
   (`isOneRowProjection`) gained the same two shapes, which is what let the `first`-cardinality
   consumers stop saying *"child first cardinality requires explicit encounter order"*.
   **What is still open, all of it fail-closed:** map/group/record child bodies (→ 5);
   `group().by(project(…))` composite keys; the MANY-valued child-in-child
   (`local(__.local(__.out().values('n')))`) — deliberately excluded above, since admitting it would
   change the classifier's cardinality contract, so it needs an all-cardinality child-in-child route
   rather than a wider producer; and the only-`Pick.none` option-map deferral above. Also **36 of 17's
   41 child-scope matrix gaps**, which are the `ChildShape` decline; `local()` is still the
   third-largest L3 deferral bucket at 10.
   Start `steps/tail/{child-shape,child,scalar-arm}.ts`. **Three invariants:** the ONE arm triage is
   `classifyBranchArms` (two documented exceptions); a renderer that cannot carry alias columns must
   DECLINE, not answer; and a `first`-cardinality consumer may skip the encounter ranking only on a
   PROOF that the body cannot fan out, never because the stream happens to carry no encounter.
   **Medium** (was High — the wrong-answer half evaporated on measurement).
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
   **Measured child-scope matrix** (7 body shapes × 9 row ops, hosts `local()` and `map()`, identical):
   **41 gaps / 63** — but 36 are the single `ChildShape` decline (→ 2), not the op, so the seam is what
   unblocks every child-scope slice on list/record/variant/property/path.
   **The trap that cost 42 corpus traversals, still live:** a shape table is a Map where the LAST
   duplicate key wins and `dispatchShapeTail` consults ONE handler per name, so spreading a shared op
   into a table that already owns that name REPLACES the incumbent — and a handler that "declines" falls
   to the FALLBACK THROW rather than through. Compose with `firstOf`.
   **Remaining per-step gaps:** 42 current-object aggregates (architectural, above), 7 `order`, 6 `is`
   (mechanical), 5 `unfold` (correctly per-shape forever). **`tail`/`sample` are NOT here — they landed
   2026-07-31 and their residual is item 4's missing encounter.** **Medium.**

29. **The 17 `carried-state × barrier` deferral sites still each re-derive their answer** — the
   TABLE they can now cite landed 2026-07-31 but nothing was rewritten to cite it.
   `BARRIER_ROLE_POLICY` (`context/context.ts`) is total over `keyof TraverserLayout` beside the merge
   table, in four policies that turned out to be distinct — `consumed`/`empty`/`drop`/`keep` — and
   `barrierLayout` is checked against it role by role in `test/channel-contracts.test.ts`, because a
   `drop` role appears in the literal as its own ABSENCE and so table and code could disagree by
   omission in either direction.
   So each of the 17 sites can now cite a role's policy instead of re-deriving it, which is what the
   item wanted — but that is a separate sweep and it should be folded into whichever site is next
   touched, not done as a rename. **Do not "finish" this by mechanically rewriting all 17**: some of
   them defer for a reason the table does not capture. *Low.*

3. **`repeat()` residuals — and the `times(n)` unroll is NOT the free rewrite this item claimed.**
   The body compiles through the ordinary StepFns into a keyed child relation (`tail/keyed.ts`).
   **The gate is NOT "whatever `lowerElementSteps` accepts"**: a per-iteration GLOBAL barrier observes
   the whole frontier and the generic StepFns would lower it per-origin, answering a different
   question — the gate is the row-local vocabulary (`isElementChildStep`).
   **Two reference facts, read from the vendored source 2026-07-31 and pinned in
   `test/compiler/repeat-unroll-boundary.exec.test.ts`. They pull opposite ways:**
   - *Our deferral message is the REFERENCE's reading, not our assumption.*
     `RepeatStep.standardAlgorithm:217` tests `hasStepOfAssignableClassRecursively(Barrier.class, …)`
     and, when it holds, drains EVERY start into the body before iterating it — "so that RepeatStep
     always has 'global' children". Without a barrier it pulls ONE start at a time.
   - *TinkerPop refuses to unroll such a body, on purpose.*
     `RepeatUnrollStrategy.ALLOWED_STEP_CLASSES` is movement + `has()` only, and the class comment
     says why: "intentionally conservative as there have been unintentional traversal semantics
     changes in the past when allowing a large variety of steps (**especially barriers**)."
   **So the 41 queries are not 41 free wins.** Every body they count is a barrier body — the set the
   reference strategy declines — and the bodies it DOES admit already compile here, so unrolling those
   buys nothing. The unroll may still be right for us, for a reason that does not apply to an
   interpreter: our phases are set-at-a-time by construction, so "the whole frontier at iteration k"
   IS phase k's relation — the property `:217` had to special-case to obtain. **But that is an
   argument to make per barrier, with a pin each, not a corpus count to cash in.** Breakdown, unchanged
   across four measurements: `order` 15, `limit` 7, `local` 5, `dedup` 4, `range` 4, `groupCount` 3,
   `sample` 2, `group` 1; plus 8 on the adjacent row-local gate. *Medium, and re-scoped: the cheapest
   honest slice is ONE barrier (`dedup`, 4 queries, the easiest equivalence to state) rather than the
   mechanism wholesale.*
   Also: named-loop `repeat("a",…)` needs named loop counters; `as()` in the body rebinds per iteration
   so it stays out; `path()`/`sack()` bodies stay with the flat expansion (→ P3).
   → [deep-seam-migration-roadmap](./2026-07-18-deep-seam-migration-roadmap.md) #5,
   [foldable-carried-column](./2026-07-24-foldable-carried-column-plan.md)

20. **Results ordered only because SQLite scanned the convenient way.** `mise run test:perturbed`
   (`PRAGMA reverse_unordered_selects`) — a failure there is never a flake. Perturbed census
   **41 → 8 → 5**, suite **21 → 2** (measured 2026-08-01). **Two failures from a gate**, which is the
   point of the item. Five mechanisms landed; left:
   - **A GROUP VALUE body's barrier runs in the wrong SCOPE — `dedup()`/`order()` LANDED 2026-08-01
     (L3 1669 → 1671); `limit`/`range` are what is left.** The rule is
     `Grouping.determineBarrierStep`: the first non-local barrier in a value traversal is the group's
     REDUCER, and `projectTraverser` feeds that traversal one traverser at a time — which is exactly
     our child scope, so a barrier compiled there observes one origin. The two with an EXACT aggregate
     form are hoisted out of the child scope (`partitionBarriers`, `tail/group.ts`): `order()` → the
     aggregate's `ORDER BY`, `dedup()` → `DISTINCT`. It fixed a wrong answer the corpus COULD see
     (`…bothE().values('weight').dedup().order().by(asc).fold()` was leaving each weight repeated once
     per incident vertex) and one it could not (every group scenario asserts `unordered`, which
     compares the map's entries and never the order inside a value list — hence
     `test/L4-addendum/group-value-partition-barrier.feature`).
     **`limit`/`range` before the terminal have no aggregate form** — a partition-wide window inside an
     aggregate — so they stay child-scoped and silently observe one origin. Same for an ELEMENT value
     body's `order().by(key)`. A bare `dedup().fold()` is now correct but its member order is
     first-occurrence over a scan-determined sequence, so it is NOT L4-pinnable until that order is
     fixed. *Med.*
   - **LANDED 2026-08-01, and the durable fact is the INVARIANT it established: a child-scoped
     stream's emission order is the PAIR `(ordinal, encounter)`.** The encounter alone is per-origin
     (`ROW_NUMBER() OVER (PARTITION BY <ordinal> …)`) and stays that way on purpose — a scoped slice
     reads it as `encounter > offset AND encounter <= stop`, a per-parent window that would be a
     different question globally — so across parents every first row ties at 1. `pushChildScope` now
     mints the ordinal ORDERED by the parent's encounter (still unique, which is all the identity
     contract asks), and `armOrderKey` (`context/context.ts`) reads the pair off an arm so all four
     merges key on `arm_idx, arm_ordinal, arm_encounter`. **Any new cross-parent reader must use the
     pair; anything inside the scope still uses the encounter alone.**
   - **LANDED 2026-08-01 — `dedup()` keeps the FIRST occurrence.** `DedupGlobalStep` keeps the
     traverser it saw first, so `order().by('name').dedup()` still emits in name order; we cleared
     the encounter (a per-row-unique value defeats `SELECT DISTINCT`). Now a `GROUP BY` with
     `MIN(encounter)` at both sites. `2026-07-22-review-fix-plan.md` A3 called the clearing
     correct-by-design and was wrong; three ordered L4 pins hold under perturbation.
   - **LANDED 2026-08-01 — two smaller ones.** A vertex's label ARRAY was built with the `ORDER BY`
     outside `json_group_array`, which orders the subquery and not the aggregate, so the array and
     `vertexLabelName`'s pick disagreed on the first label. And a bulk-load id collision named
     whichever id the scan reached first (`MIN` now, so the message is stable).
   - **WHAT IS LEFT, all measured 2026-08-01, and the first two are the ones to take.**
     1. An ELEMENT-shaped `aggregate('x').by(traversal)` builds a side-effect relation carrying no
        order channel at all (`prefix/sideeffect.ts` — the SCALAR branch orders via
        `jsonbGroupArray(…, memberOrder)`, the element branch has nowhere to put it), so `cap('x')`
        reads it in scan order. A collection's member order is FULLY OBSERVABLE (the members ride
        inside the collected traverser's own GraphBinary buffer — `jsonbGroupArray` says so), which
        is what makes this a wrong answer rather than a nicety. Probe first: whether the order rides
        as a column on the `SideEffectDef` for `cap` to sort by (general — serves `store` too), or
        whether the element branch should collect at aggregate time like its scalar twin.
        *Med, and the last real defect in this item.*
     2. A RECORD stream carries no `encounter`, so `recordSlice`'s `orderByEncounter` is inert.
        **Re-rated 2026-08-01 from polish to CORRECTNESS:** with a slice after it that is a wrong
        SUBSET, not a reorder — `project(…).limit(n)` returns an arbitrary n — which is exactly the
        shape 21's T4 turned out to have. Likely small: declare the role on the record layout and
        the existing `orderByEncounter` becomes live. *Med.*
     3. Three WRITE traversals via row-at-a-time `write.ts` — a driver rewrite, not an ordering fix;
        leave with the write cluster. · `g.V().repeat(__.both()).times(3).range(5,11)` is EXPECTED
        (item 4's boundary), so it needs an exemption rather than a fix when the gate lands.
   - **The assertion sweep is DONE and the rule it used is worth keeping.** Thirteen exact-array
     assertions across seven files were pinning scan order for traversals that fix none; they now
     compare as multisets through `bagOf` (`test/support/harness.ts`), which states the rule and its
     limit.
   - **The ONE test left red, and the decision taken on it 2026-08-01: rewrite it as a PAIRING, and
     only exempt it if that cannot reach the branch arms.** `branch-triage.exec.test.ts`'s
     projection-with-reducer test asserts `[1,1,0,1,0,1]` (per-traverser) against `[1,1,1,1,0,0]`
     (by-arm) — the same multiset, so `bagOf` erases exactly what it is testing, and the order it
     reads is `g.V()`'s SCAN order. Ordering the source is not the fix either: that makes the
     encounter live, which makes the branch traverser-major (21's T4) and deletes the distinction.
     **Do this instead:** pair each result with the input that produced it —
     `project('v','c').by('name').by(__.values('age').count())` or an `as()`/`select` — so the
     assertion is *which vertex produced which count*, which is what the test means and what
     position was only ever a proxy for. If the pairing cannot express the branch-arm reading, add
     ONE named exemption in the perturbed runner with the reason beside it; a single documented
     exception costs far less than a permanently red instrument.
     **And the prior question, worth asking before doing either:** by-arm emission is now observable
     ONLY where nothing demands an order — a barrier-free branch nobody slices, folds or orders —
     which is an unordered result by design (Crux 4), i.e. an internal. Internals belong in L2, and
     that half is ALREADY pinned there: `test/L2-sql/branch.sql.test.ts` asserts the merge window is
     `ROW_NUMBER() OVER (ORDER BY … arm_idx, arm_ordinal, arm_encounter)`. So the pairing rewrite
     loses nothing — the observable half moves to a stable assertion, the internal half is already
     covered by the SQL snapshot. Deleting the positional assertion outright is defensible on the
     same reasoning; what is NOT defensible is keeping a scan-order pin and calling it coverage.

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
   cleared": **F `by()`/modulator — the ARITY half landed as item 23's table, but the `by(T.token)`
   half did not, and it is item 33** · **D carried-state × barrier 17 → item 29** · **C's `path()`
   through a mixed shape, 8 of branch triage's 20 → one lift** · **A shape-tail ceiling 14/85**, the
   highest ratio at 6:1, which is item 17's matrix. Then E repeat-body 26/66 (3), G write 31/92 (10),
   K label 17/11, B child-seam 13/32 (2/5). A–E/G–K are the 2026-07-28 measurement and were not
   re-derived; F was, and the whole-tree `throw ` count is **533** by grep across `src/compiler`,
   `src/sql` and `src/execute.ts` — a different instrument from the 488 this line used to cite, so read
   it as a fresh baseline rather than a delta.
   → [shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md)

**The measured root shape × row-op matrix — 66 gaps / 150** (10 root shapes × 15 tail ops, executed
2026-08-01 via `outcomeOf`/`ALL_GENERIC`; row-algebraic sub-matrix 21/80). Two readings prose did not
give. **`group` is 7 of the 21 row-algebraic gaps by itself**, and `cardinalityOf` correctly refuses it
(`wholeResult`) — a *cardinality* item, NOT row-op sharing; do not fold it into 17. And the **ELEMENT
tail is the one shape not on the dispatch substrate**: `ELEMENT_DISPATCH` (`tail/projection.ts`) does
not spread `globalRowOps`, routing through the `TailAcc` accumulator, so `limit()` has **three**
implementations. Converting the accumulator is architectural, not a spread — its fusion into one SELECT
is what makes `order()`+`limit()` correct in a single statement; sequence it AFTER 17. Same seam from
the wire end: `materializeStream` (`tail/materialize.ts`) excludes `ElementStream` from its 11-kind
dispatch and calls that "the final materialization-boundary slice", while six other arms differ only in
which column authority supplies `<cols>` and collapse to one `materializeSimpleRoot`. *Maintainability
alone; a precondition for 17 reaching the element stream.*

**Three instrument self-reports are stale, all in the L5 tier** (swept 2026-08-01, none fixed):
`test/L5-properties/README.md:28` claims `known.ts` is EMPTY (it has one entry) and line 29 that
`laws.ts` carries two `knownBroken` entries (it has zero); and `known.ts:14` shouts *"THE LIST IS
CURRENTLY EMPTY, AND THAT IS THE INTENDED STATE"* above a non-empty list. *Low as code, Medium as
integrity — a ratchet whose banner denies its own contents is how one gets ignored.*

23. **The wording family — 36 error-assertion scenarios on 2026-07-31, 22 now, and the residue is
   NOT more renaming.** The premise held: a permanent refusal spelled *"…not yet supported"* is both
   false and mis-filed, because it competes with real gaps in the telemetry that RANKS THIS INDEX.
   Three groups landed 2026-08-01 (L3 1652 → 1666):
   - **`BY_MODULATOR_ARITY` + the `byModulatorArity` verify Pass** (`ir/strategies.ts`,
     `ir/passes.ts`) — one table off the reference's `modulateBy` overrides, counting the contiguous
     `by()` run on `ctx.originalChain` at every depth. It DOMINATED four per-host checks, which are
     deleted; a host must not re-check. Pinned in `test/compiler/by-modulator-arity.exec.test.ts`.
   - **`StandardVerificationStrategy` modelled as the strategy** rather than one clause of it
     (`verifyStandard`): the read-only child rule plus inject-under-repeat, plus RepeatStep's own
     wording for an `emit()`/`until()`/`times()` with nothing to repeat.
   - **`LIST_INPUT_REFUSALS`** (`tail/list.ts`) for the steps whose input contract excludes a
     collection at every scope. `concat` LEFT `STRING_LOCAL_TX` on the way — TinkerPop ships no
     `ConcatLocalStep`, so `fold().concat('x')` was answering where it must refuse.
   The WRITE family followed the same day (L3 1671 → 1679): `mergeE`'s missing endpoints take
   `MergeEdgeStep`'s wording, `addV`/`addLabel`'s label count takes `LabelCardinalityValidator`'s,
   and a MAP argument to a list-receiver set op takes `MergeStep`'s.
   **14 error-assertion scenarios remain and NONE of them is renaming.** (a) **7 are item 22's
   runtime-type-channel group.** (b) **7 are real gaps that merely coincide with an error
   assertion** — the reason differs, so the message is the least of it: `choose().option()`'s Pick
   token, `fail(msg)` (item 25), `addE`'s ambiguous endpoint,
   `merge(__.constant('a'))` over an `elementMap()` receiver (we cannot consume a MAP receiver at
   all; the reference is complaining about the ARGUMENT), `mergeE`'s `option(Merge.outV, select)`,
   and `withStrategies(VertexProgramRestrictionStrategy, VertexProgramStrategy)` — which wants
   `VertexProgramRestrictionStrategy` moved OUT of `NO_OP_STRATEGIES` into a real verify strategy.
   **One divergence is deliberate and will not be closed:** `Can't parse type ArrayList as number.`
   asserts the JVM CLASS of the offending value; we say `list`. *Low, and the item is nearly done —
   what is left belongs to the items that own each gap.*

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

31. **A MIXED `inject()` FLATTENS its list arguments — a live wrong answer, not a deferral.**
   `g.inject(["a","b"],"c")` yields three traversers where the reference yields two (the list, then
   the string): `seedInject` (`steps/write/inject.ts`) takes the all-arrays path only when EVERY
   argument is an array, and otherwise falls to `flattenListArgs`. The single-argument spelling
   `g.inject(["a","b"])` is correct, so the defect is exactly the mixed call. Its own code comment
   names the blocker — "until ScalarStream gains a per-row shape/type discriminant" — which is the
   VariantStream question, so this is not a local fix. Found 2026-08-01 while landing item 23: it is
   what still fails `g_injectXListXa_bXcX_concat_XdX` now that `concat()` over a list correctly
   refuses, so the scenario's remaining cause is here and NOT in the string family. *Med — one
   scenario, but a wrong answer, and it shares its substrate with item 1.*

4. **Encounter minting — the one missing primitive, and it owns three residuals.** A bare re-source
   `V()`/`E()` arm carries no `encounter`, so `armFansOut`/`positionArmFansOut` fail closed; minting
   `encounter = new element id` at a re-source is the primitive. ONE slot, `TraverserLayout.encounter` —
   do not derive a "two encounters" reconciliation; `repeat()`/`match()` stay outside by design.
   **Re-homed here 2026-08-01:** `tail`/`sample` are the two widest gaps in the root shape × row-op
   matrix (6/10 each) and item 17 records both as LANDED — both true, the shared op exists and then
   declines for want of a carried encounter (`g.V().project('a').by('name').tail(1)` → *"needs explicit
   encounter-order metadata"*, still reproducing on trunk after the ordinal/encounter pair landed, and
   an upstream `order()` does NOT supply it on any shape tried). And **5 of the 28 `by(traversal)`
   deferral sites are this, not a child-seam gap** — they say *"requires child encounter order"*
   (`sack.ts`, `sideeffect.ts`, `filter.ts`, `group.ts`, `barrier.ts`), re-derived per host; the other 12
   stay with 2/5. Also item 20's record slice.
   **Low-Med as the primitive, Medium as what it unblocks.**
   → [canonical-emission-order](./2026-07-19-canonical-emission-order.md)

33. **`by(T.token) → Expression` has 12 hand-written resolvers and 11 identical deferrals.** Item 23's
   `BY_MODULATOR_ARITY` settled how MANY `by()`s a step takes; nothing settled what ONE resolves to.
   `classifyBy` (`tail/child-shape.ts`) is the one DECODE, so twelve sites write the same 2–3-arm switch
   and throw on the rest: `prefix/branch.ts` (×2), `prefix/sack.ts`, `prefix/predicate.ts`,
   `prefix/filter.ts`, `tail/group.ts` (×2), `tail/path.ts`, `tail/select.ts`, `tail/modulation.ts`,
   `tail/projection.ts`, `tail/mapscalar.ts`. The best-developed already calls itself the authority —
   `directOrderExpr` (`tail/projection.ts`), *"the one place a direct order key is built"* — but is
   element-only and private. **Mechanical: hoist it to `tokenExpr(ctx, token): Expression | null` beside
   `classifyBy`**, clearing 11 `by(T.${token}) not yet supported` sites and unblocking
   `by(T.id)`/`by(T.label)` at every host at once. Three arity checks outside the new table also survive
   (`sack.ts`, `group.ts` ×2) and should route through it. **Do NOT add a `'column'` arm to `ByClass`** —
   recorded won't-do. **Medium-high.**

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

36. **Shape-changing barriers are excluded from arm batching — the branch-scope class T4 did not
   cover.** `fold`/`group`/`groupCount`/`aggregate` are out of `BATCHED_BARRIERS` (`ir/step.ts:217`)
   because batching one turns a homogeneous merge into a mixed-shape merge — but each IS a `Barrier`
   upstream (`FoldStep extends ReducingBarrierStep`), so `union(__.out().fold(), …)` batches in the
   reference and lowers per-origin here. Start at `BATCHED_BARRIERS` + the arm routing in
   `prefix/branch.ts`. **Three smaller tails from the same plan, none carried elsewhere:**
   `GLOBAL_BARRIER_STEPS` carries two meanings (§5·1); three spellings of *"is there a whole-stream
   barrier in this body"* — `repeat()`'s body gate, `match()`'s pattern body, and the FLAT `armBatches`
   — want one recursion (§5·2), which is also the nested-arm gap the branch item declared; and the
   `union(barrier-arm…)` ≡ `local(union(…))` law (§5·4) is absent from `laws.ts` and now due.
   Also **`ir/step.ts:86-92` is STALE on its live half** — it still says the branch-arm case "does
   NEITHER", citing `g.V().values('age').union(__.min(), __.max())`, which T1 landed and pinned at
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

10. **`addV` mid-chain + read-tails-after-write.** Gates a write-conformance cluster. **Medium.**
    → [compiler-consolidation](./2026-07-16-compiler-consolidation-plan.md) §6

11. **Federation tail:** map-valued injection for mid-traversal federation (Med); async
    failure/timeout/retry policy (Low-Med); federated *traversal* via local scratch (Large). The
    **CF-parity test landed** as `src/cf-limits.ts` + `mise run test:cf-limits` (it was mispriced here
    at Low-Med: it is what makes a DO-only bind wall fail on Bun), and so did the bulk-write machinery
    the persist path always needed. So **federated *materialize* is now UNBLOCKED and is this item's
    next piece**: `call(federate,…)` returns detached rows, `BulkLoader` lands them, and its stated
    blocker — cross-graph id collision — is `idPolicy: 'remap'`/`'renumber'` (a source id has no
    meaning in the target, so it is kept as `uid` or dropped). **import-a-graph** is the same
    machinery pointed at a document instead of a sibling graph, and `io().read()` already is it.
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

16. **W4 — multi/meta-property schema rework → `Cardinality.list/set` writes.** Only meta-property
    *typing* is touched today. **Adjacent, from the io work:** meta-property VALUES have no per-value
    type in storage — `vertex_properties.meta` is a flat `{metaKey: scalar}` JSONB bag, so a meta value
    round-trips through GraphSON as whatever JSON returns. The format can carry more than storage gives.
    **Medium.**
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
  GraphComputer**: 4 of its 6 scenarios are the OLAP names item 8 will serve, so that exclusion should
  NARROW, not harden. **The `io` source is now LANDED, not a descoping question** — the 2 in-scope
  `Read.feature` scenarios (the `.json` GraphSON-adjacency pair) pass, and `io().write()` runs on a real
  R2 binding inside a DO, so the source/sink asymmetry that line used to claim is gone. The other four
  scenarios are REFUSALS of two different kinds and must be read as such rather than as a gap: `.kryo`
  is a platform wall (JVM serialization, no dependency available), `.xml` is a **format decision** — no
  XML, taken 2026-07-31 because GraphML's `attr.type` is more type-lossy than CSV *and* Workers has no
  `DOMParser`. That makes `tags.ts` carry its first format-decision exclusion. *Low.*

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
- **L5's known-bad state is split across artifacts with one reader each** — `known.ts` (1 entry),
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
  Its 2026-07-21 addendum's deferred bulk capability was item 30's plan and is now BUILT; the `ATTACH`
  correction stands.
- **[bulk-transfer-and-io-substrate](./archive/2026-07-31-bulk-transfer-and-io-substrate-plan.md)** —
  closed (all eight phases; item 30 was deleted with it), and kept for three durable things.
  **The measured refutation of widening the primary key** (a random 52-bit `INTEGER`
  costs 2.8× on the 3-hop hot path, a `TEXT` uuid 5× and 7× on disk; `uid TEXT UNIQUE` already IS the
  global-identity slot; and `coerceBindValue` makes >2^53 unrepresentable as an integer at our own bind
  seam) — read §7 before proposing an id change. **The DECIDED format set** — typed GraphSON adjacency
  (read v3+v4, write v4) plus Neptune/Neo4j CSV for interop, no homegrown format and nothing XML; §4/§4b
  is why re-widening it buys no capability, and §4d is CSV's loss table split into declared widenings
  and refusals. **And the two instruments** that keep the 100-bind class from returning (§2).
- **[path-tracking-prior-art](./2026-07-12-path-tracking-prior-art.md)** — path prior-art for P3 tails.
- **[wire-and-storage-facts](./2026-07-25-wire-and-storage-facts.md)** — Map.Entry framing + MapStream.
- **[shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md)** — the shape/type
  vocabularies per layer and the bright line. **Refutes three cross-layer refactors — read before
  proposing one.**
- **[scalartype-refactoring-pattern](./2026-07-28-scalartype-refactoring-pattern.md)** — vocabulary-cleanup
  template; live targets are `AliasShape` member shape (item 1) and front-end tagged-token accessors.
- **[tinkerpop-core-engine-alignment](./2026-07-29-tinkerpop-core-engine-alignment.md)** — naming
  authority and rename map. The open `ir/rewrites.ts`/`ir/strategies.ts` partition needs a shared home.
- **[branch-arm-barrier-scope](./2026-08-01-branch-arm-barrier-scope-plan.md)** — CLOSED 2026-08-01
  (was item 21, now deleted): all four tranches landed, including T4's traverser-major merge key and
  the `branchOrders` carried role behind it. Read it for two durable things — §1's
  `BranchStep`/`FlatMapStep` class fact, which decides which branch kinds can disagree with us and in
  WHICH respect (arm SCOPE for two of them, emission ORDER for all four), and §6's five wrong turns.
- **[property-based-testing-l5](./2026-07-28-property-based-testing-l5.md)** — L5's oracle design space.
  Its four blind-spot defects all cited the deleted item 0 and all four are now FIXED — re-probed
  2026-08-01, recorded per entry, citations dropped.
- **[channel-preservation](./archive/2026-07-28-channel-preservation-refactoring-plan.md)** — closed;
  read it for the constitution a vocabulary migration passes.
- **[hand-rolled-sql-audit](./archive/2026-07-27-hand-rolled-sql-audit.md)** — closed; the measured
  method behind items 3, 5, 5c and 17.
