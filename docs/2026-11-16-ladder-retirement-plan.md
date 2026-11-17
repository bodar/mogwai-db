# Retiring the correlated-child ladder

_Status: IN PROGRESS. Round 1 (2026-11-17) landed R0, R1, R2a, R2b, R3, R4.1, R4.3, R4.4 and R5.1; round 2
landed N0, N1, N2+P4, N4, N6, P1, P3; round 3 landed M0, M1 (+M3), M4, N7 (+M5), P7, P10; round 4 landed N5, K1+P15, Q2 (both halves), P12, M2, R6's first item (+R6.0) and N3 partially; round 5 landed S1, S2, S3, S4, S5's first bullet, S6, K5 (+P19) and R6's
follow-ups. The next round starts at "Next round (written 2026-11-17, after round 5)" at the end (T1 is a regression:
do it first). No deadline: each step lands on its own when it is ready, and
any step may stop and be reconsidered._

**The principle (owner, 2026-11-16): smart, considered replacement — not a forced migration.** A route is
replaced where the connector genuinely does the job as well or better, and left where it does not. Nothing is
shoe-horned onto the connector to hit a count. What is GENUINELY SHARED between the connector and the ladder is
neither's: it is pulled out as shared substrate under its own name, used by both, and is not a deletion target.

_Parent: `docs/2026-11-15-compositional-coverage-plan.md` (Phase 3, the "Kept routes" audit holds the
measurements this plan starts from). Direction: root `CLAUDE.md` locked decision 6._

## Where we are

- The scoped-relation connector (`src/compiler/rel/lower/scoped.ts` + `src/rel/decorrelate.ts`) is the
  DEFAULT at every child site. The ladder is the opt-in `correlatedChild` FastPath. The `bothChildOrders` retry
  is deleted (N7, 8a103627): `compileViaRel` (`src/compiler/rel/spine.ts`) lowers once.
- Already off the ladder (`LADDERLESS`, `scoped.ts`): `project`, `order`/`dedup`/`groupCount` `by()`,
  `coalesce`/`optional`, `choose`, `union`.
- Still on it, per the audit: existence (`where`/`filter`/`not`/`and`/`or`), per-traverser
  (`map`/`flatMap`/`local`), and `group` with a child value `by()`.
- Ladder-only answers over the L1/L6/L9 pools: **66** (from 119 before cc3d) — the wide instrument
  (`mise run ladder-reach`, ~29k traversals). The CI-gated subset (L1, L6, the sweep's host queries) is **30**
  (existence 7, per-traverser 6, group 17), plus 1 `bothChildOrders` rescue. Ladder files: 328 `return null`.
  _After round 1 (baseline `test/L9-connector/ladder-reach-baseline.json`):_ **23** — existence 0, per-traverser
  6 (L1), group 17 (L1 14, L6 3); the recorded rescue count still reads 1 and `bothChildOrders`' `CopiedDraw` arm
  is still in `src/compiler/rel/spine.ts`. `LADDER_FILES` is `lower/per-traverser.ts` alone (12 `return null`).

## What "retired" means — the end state

What is deleted is the ROUTING: a `(host, body-shape)` choice made before the connector sees the site, and
the code only that routing uses. Concretely:

1. Shared code — the correlated forms (`EXISTS`, the correlated first-row scalar), the condition builders —
   lives as shared substrate under a neutral name. It is not the ladder, so it is never deleted as part of it.
2. A route goes when the connector answers what it answers, as fast within the bar, with less code. A route
   where replacement does not make sense stays, as a small, legible, documented switch with its measured reason.
   Whether the `correlatedChild` switch itself disappears is an OUTCOME of those calls, not a goal.
3. No query that answers today declines afterwards. Zero wrong answers throughout.
4. No common shape gets slower than the cost-discipline list allows (parent plan §5), unless the owner
   accepts a named margin.

## Hidden dependencies — why this is not "delete the files"

- **The connector calls ladder helpers.** `scalarChild`/`byField` sit under `byValues`/`recordLeft`
  (`childSeam.scalar`). `childPredicate`/`correlatedExists` build every `choose`/`repeat`/`coalesce` condition
  and `childSeam.predicate`. These are shared code, not the ladder's own.
- **The retry rescues connector declines.** `bothChildOrders` currently turns two connector failures into
  answers by handing them to the ladder:
  - a join wider than SQLite's 64 tables (`local(repeat(out()).times(63))`);
  - a random draw copied by the plan (`CopiedDraw`, e.g. `rooted-sample-scale`).

  Deleting the ladder first would turn those into declines.
- **`ladderOwns` refuses bodies by design.** The connector refuses any body that re-sources (`map(V().count())`)
  or draws (`local(out().sample(1))`). Today the ladder is the only thing that answers them.
- **Deferred hosts** (`test/L9-connector/deferred-hosts.ts`, 48 positions):
  - Some are the host's own lowering and never were ladder: `repeat` until/emit is a `Recursive` term, which
    cannot hold a window.
  - Others need effects threaded through a scoped body (`sideEffect` with effects).
  - Each needs classifying: "ladder" or "host-owned, not in scope".

## Steps

Each step is independently landable and leaves trunk better even if the next never happens.

### R0 — Make the remaining gap a number CI holds (instrument + guard)

- Promote the audit's `reach.ts` (scratch) into `scripts/` and a `mise` task. Per family, it counts the queries
  the shipping default answers and connector-only does not.
- Add that count to L9 as a ratchet. It may only fall, it starts at 66, and it is reported per family.
- Classify every `deferred-hosts.ts` entry as `ladder` or `host-owned`, so the end state has an exact scope.
- *Why first:* every later step is measured by this number. Without it, "done" is a judgement.

✅ **LANDED (6b31bffc).** `test/L9-connector/ladder-reach.ts` compiles each traversal under the default and
`connectorOnly`, charges a ladder-only answer to its deepest family host, and counts `bothChildOrders` rescues
via the new measurement mode `FastPathConfig.childOrderRetry: false`; where both answer, the multisets must agree.
The ratchet (`ladder-reach.test.ts`, baseline `ladder-reach-baseline.json`, `mise run ladder-reach-record`) gates
the CI pools at **30** — L1 21, L6 3, H 6 (existence 7, per-traverser 6, group 17) — and 1 rescue; it may only
fall. The wider `mise run ladder-reach` (not a gate) reproduces the audit's 66 (existence 40, per-traverser 9,
group 17) and finds 4 rescues. `deferred-hosts.ts` gives all 48 entries a `scope` (27 `ladder`, 21 `host-owned`),
asserted by host-totality. Measured after R5.1 landed: unchanged at 30. **Remains:** the owner must confirm the
split. It is the builder's judgement. `repeat` until/emit's own condition lowering is set to `host-owned` for now
(open question 2), and `sideEffect` is set to `ladder`. Each choice is recorded in a comment in `deferred-hosts.ts`.

### R1 — Pull out what is genuinely shared (move/rename, no behaviour change)

- Find what both sides call, by line coverage of the pools under ladder-first AND connector-alone (the audit's
  method): the code BOTH runs is shared. Candidates: `childPredicate`, `correlatedExists`, `scalarChild`,
  `byField`, and the condition builders `choose`/`repeat`/`coalesce` use.
- Extract it into its own module(s) — shared substrate, named for what it IS (a correlated existence, a
  correlated first-row read), owned by neither the ladder nor the connector. Use `scripts/move.ts` and
  `rename.ts`. Split a function only where one part is shared and the rest is routing.
- Shrink `LADDER_FILES` in `scripts/ladder-check.ts` to what is left: routing only.
- *Why:* it separates "the ladder" from "SQL's fast correlated forms". After this, the ladder's real size is
  visible, and every later replacement decision is about routing, not about substrate that would survive anyway.
- *Risk:* low. Guards: census plan hashes unchanged, `sql-hygiene` unchanged.

✅ **LANDED (c10c57aa).** Measured: line coverage of the L1 and L6 pools compiled ladder-first
(`correlatedChild: true`) and connector-alone (`connectorOnly`), per top-level function of the five ladder files.
Nearly everything in them runs in BOTH modes, so the shared side is most of the code, and the ROUTING is the small
part: the per-traverser route — `perTraverserChild`, `flatMapRejoin` and the admission gates only they consult
(`bodyScopesPerOrigin`, `nestedHostScopes`, `atMostOnePerTraverser`, `localDrawsPerRow`, `originMajor`, the two
`PER_ORIGIN_*` sets). So the move went the cheap direction for the same end state: the routing left
`lower/reduction.ts` for its own file, `lower/per-traverser.ts` (12 `return null`), and the shared substrate kept
its module. The correlated existence and its predicate shapes (`correlatedExists`, `anchoredSeed`,
`matchPredicate`, `bodyPredicate`, `childPredicate`, `valuePredicate`) left `lower/filter.ts` for
`lower/exists.ts`, so `filter.ts` holds only the filter steps' clauses. `byField` stays in `modulator.ts`, a neutral
by() module already (its callers are `record.ts` and `collection.ts`). `child.ts` and `branch.ts` are entirely
shared (every branch host is `LADDERLESS`). `LADDER_FILES` is now `lower/per-traverser.ts` alone. The total is
unchanged (1278: the moves net to zero, and the baseline's 1279 was an unrecorded earlier fall in `branch.ts`).
Plan hashes and SQL are byte-identical: the functions moved, nothing else changed. R4.3's `admitsReSource` (the one
re-source admission rule, asked by both the scalar seam and the connector) is shared and stays in `reduction.ts`.
**Remains (R1): nothing.** The ladder routing
still outside that file is in `lower.ts`: the existence leg for `ladderOwns` bodies (`aliasWhere`) and group's
own lowering of a child-value `by()` (`collectionArm` → `groupRows`, `map.ts`, reading the body through `childSeam`).
Each goes with its family's step (R2/R4/R5), not as a move.

### R2 — Make the retry unnecessary (connector handles its own declines)

- **Join width:**
  - carry the scope key as a channel through a decorrelated body instead of re-joining it;
  - or, when one order is too wide, fall back WITHIN the connector to the correlated form, which needs no
    scope table.
- **Copied draws:** a draw under `local`/`flatMap` is independent per scope (the reference applies the body per
  traverser). Make the decorrelated plan hold ONE draw per scope row, or route draws to a correlated form that
  evaluates per host row.
- *Done when:* `bothChildOrders` never fires on the pools. Count it.

✅ **R2a (join width) LANDED (b1210037).** Neither alternative above was needed: the emitter's join assembly closes
the wider side of a join whose FROM would pass SQLite's 64 tables into one `OFFSET 0`-fenced derived table (`side`'s
`fence`, `src/rel/emit.ts`; the width counts what the flattener merges, `derivedTables`), so an unroll nests a
SELECT every 64 tables and answers in either child order; `bothChildOrders` lost its `JoinWidthExceeded` retry arm,
and `JoinWidthExceeded` remains only as the assembler's assertion. Tests: `test/compiler/host-unroll-width.exec.test.ts`.
Remains for R2a: nothing. (The copied-draws bullet is a separate item.)

✅ **R2b (copied draws) + R4.4 LANDED (5c656e99, a43f1af1, 760b3d5f).** A drawing body is the connector's and
always DECORRELATED (never `correlatedBody`): the decorrelator counts the body's OWN draw as touching the scope
(`decorrelate.ts`; `owning` in `lower/scoped.ts`, `ownDraws` in `src/rel/copies.ts`), so every
`ORDER BY RANDOM()`/`ROW_NUMBER` is partitioned by the scope key — one draw per scope row, linear (7.9×–8.2× 1k→8k);
`name.ts` fences a shared drawing CTE; an upstream pick the body only reads stays one shared draw. `ladderOwns` is
now exactly a draw over a re-source (one shared read: the ladder's explained `shared-draw` decline). Tests:
`test/compiler/per-scope-draw.exec.test.ts`; L4 dropped two `@Unsupported` tags; L9's existence-draw witness is
closed. Remains for R2b/R4.4: nothing.

### R3 — Existence family (smallest; audit says within the bar)

**DECIDED (owner, 2026-11-16): REPLACE (option A).** Speed is not a factor (connector within 1.14×, and it is already
the default). Generalise the ladder's one real idea, then delete the route:

- **An existence check ignores everything after the last step that can drop a row.** The ladder does this privately
  (`withoutMappingTerminal`, `lower/filter.ts`): a trailing `project()` never filters, because an unproductive `by()`
  drops the KEY, not the row (`vendor/tinkerpop/gremlin-core/.../step/map/ProjectStep.java`, `map()`'s
  `ifProductive`). Make it a Pass, so every host and the connector get it at any depth. It also covers
  `sample(n ≥ 1)` (never empties a non-empty stream), so `where(out().sample(1))` is `where(out())`. This closes
  27 of the 28 sole answers, which come from the random pool generator, plus the draw case.
- The 28th sole answer is one L1 alias-compare scenario, `where(a, P).by(<traversal>)`: give it a connector row.
- Then drop the dispatch entries (`hostFilter`, the scan fusion's `correlatedChild` test, `aliasWhere`'s
  traversal leg). Delete `selectRerootSubject`: about 55 lines and 5 `return null`.

✅ **LANDED (96f8f2c2).** One productivity authority, `existencePrefix` (`src/compiler/ir/productivity.ts`), used by
the `trimExistenceSuffix` Pass (where/filter/not, and/or arms, if-then choose predicate, repeat until/emit) and by
`childPredicate`'s coalesce-arm emptiness (replacing `withoutMappingTerminal`). `where(a, P).by(<traversal>)` is
the `where` connector row's `aliasCompare`, landing by() values through `byValues`' shared `landedStep`/`afterLanded`.
The existence hosts join ladderless (except `ladderOwns` draw/re-source bodies, R2/R4); the scan fusion's
`correlatedChild` test is gone. Kept, measured as still reached: `selectRerootSubject` (via `match()` legs) and
`aliasWhere`'s leg (for `ladderOwns` bodies) — they retire with R2/R4, not here. Remains: nothing.

### R4 — Per-traverser family (largest prize: ~360 LOC, 13 `return null`)

**DECIDED (owner, 2026-11-16): REPLACE IN STAGES (option A); the route stays until the typed carrier (Phase 4) lands.**
Now: inline a body that only moves (flatMap(out().out()) is 1.29× today, on the default path); the reducer marker is
accepted where it is READ; re-source bodies go to the connector; the pinned `[]` scenario (`resourced-scalar-value.feature`) moves to the six nulls and its §17 line is deleted — the `[]` was the ladder scalar subquery confusing a null value with no row, not a JS/SQLite semantic (owner, 2026-11-16); draws are one per scope row (with R2). The
variant- and property-payload sole answers wait for the carrier; the route is deleted when they land.

Each sub-item is its own commit. The audit's "measured and NOT landed" list is the starting evidence.

1. **The reducer's `result` marker on an emitted value.** It closes 4 sole answers. Fix it where the marker is
   READ (the `match` binding and the arm meet accept it), not where it is shed. Shedding it lost
   `property(k, local(values('age').sum()))`'s stored type.
   ✅ **LANDED (2e46e203).** The marker is two facts: the value's class on `vt` (kept) and `reducedGlobally`
   (a global barrier produced one row), set only by the global reducers and cleared by `perTraverserFraming`
   and every per-traverser rejoin — `src/compiler/rel/framing.ts`, `lower/scoped.ts`; `scalarArmType`
   (`lower/branch.ts`) is the one type authority for both arm merges, and `match` declines only
   `reducedGlobally`. Number class kept (a Long sum stays `L`); every probe shape ~7.5× from 1k to 8k; no
   baseline moved. Remains: nothing. (A pre-existing wrong answer found while probing,
   `match-null-reducer-end`, is tracked in `docs/outstanding-work.md`.)
2. **Variant and property payloads through the rejoin.** These close 5. The first attempt raised `sql-hygiene`
   by 7.5 → 12.7 KB, so it probably wants the typed carrier (parent Phase 4, S5); sequence it there.
3. **Re-source bodies** (`map(V()…)`). First establish the reference semantics with scenarios: a re-source
   body under `map`/`local`/`flatMap`, including over a maybe-absent value. The first attempt gave a wrong answer
   (six nulls for `[]`). Only then remove `ladderOwns`' re-source refusal.
   ✅ **LANDED (f4742d44).** The connector owns a re-sourcing body (`map`/`local`/`flatMap`/`where`/`group().by`
   over `V()…`): `reSourcedBody` (`lower/scoped.ts`) lowers the rest after the re-source ONCE as a rooted read and
   crosses it with an exactly-one-row prefix (first-row consumers cross only its first row); `connectorOwns` keeps
   the ladder from answering the same query a second way, and `ladderOwns` now refuses only draws. Presence is the
   body's ROW, so a productive null is a value (`resourced-scalar-value.feature` asserts the six nulls; the §17
   line narrowed to scalar operands). `admitsReSource` (`lower/reduction.ts`) is the one explained
   resource-under-absent rule, asked by the scalar seam and the fold's `reSourceTail`. A pooled re-source is one
   traverser of bulk |pool| (`group().by(label).by(V().count())`: 2.1 ms at 1k, 18.5 ms at 8k, from the ladder's
   850 ms at 1k). No baselines moved. Remains: nothing.
4. **Draw bodies** (`local(out().sample(1))`): shared with R2's per-scope draw.
   ✅ **LANDED with R2b (above).** Remains: nothing.
5. **Speed:** `flatMap(out().out())` is 1.29×. Splicing a transparent body measured 1.14×, but a pass test pins
   "a body that MOVES is left alone". Decide whether that pin is semantic (cite the reference) or a ladder-era
   fact.

### R5 — `group` with a child value `by()`

**DECIDED (owner, 2026-11-16): REPLACE IN STAGES (option A); the route stays until the last stage passes.**
1. **Domain elimination** in `decorrelate.ts`, the general rule: when the body only equates the scope key with a
   column the members already carry, group the members by it directly instead of joining a domain
   (`vendor/calcite/core/src/main/java/org/apache/calcite/sql2rel/TopDownGeneralDecorrelator.java:476-482`, "D is
   eliminated"). The pooled `group().by(label).by(count())` plan is 2.8 KB of domain + cross join + LEFT JOIN +
   window today, against the ladder's 1.2 KB single `GROUP BY`. Measure on the R5 shapes and the whole scaling probe.
   ✅ **LANDED (c0c204bf).** The pooled group row hands `decorrelate` a `KeyProjection` fact (never inferred from
   an equi-correlation, so selective correlated bodies keep their index seek): the pool is keyed by the members'
   own columns (null-safe, no domain cross join), a scalar aggregate over a covering input skips the count-bug
   LEFT JOIN, and first-row/LIMIT over an `atMostOneRow` input emits no `ROW_NUMBER` — `src/rel/decorrelate.ts`,
   `src/compiler/rel/lower/scoped.ts`. Measured CONN/LADDER at 8k: `group.by(label).by(count)` 1.95 → 1.40,
   `by(name).by(tail)` 1.37 → 1.30; every shape ~8× from 1k to 8k. Remains for step 1: nothing. Note the
   label/count shape is still above the 1.2× deletion bar, which the step-4 decision must weigh.
2. A connector row for keyed `group("a")…cap("a")` (13 sole answers), through the collection substrate.
   ✅ **LANDED (c1419463).** `pooledGroup` splits into `pooledGroupMap` (R5.1's per-key pool) plus two tails; the
   keyed side effect hands that map to `keyedGroupTail`, extracted from `collectionArm` in
   `src/compiler/rel/lower.ts`, so the host's lowering and the connector share ONE authority for registration,
   drain and re-entry (`src/compiler/rel/lower/scoped.ts`). ladder-reach group L1 14 → 3, L6 3 → 2; L3 2055 → 2056;
   connector/ladder at 8k 0.77–1.23×, every shape linear. Remains for step 2: nothing (a pooled keyed form INSIDE a
   connector body, and a second pooled site on one label, still decline cleanly in `registerGrouping`).
3. A child-traversal key together with a child-traversal value (2).
4. Nested groups (2 L6 workload queries). Then delete if within 1.2×; if step 1 misses the bar, back to the
   owner with the numbers.

### R6 — Deferred hosts classified as `ladder` in R0

Work them by workload reach, not by list order. `sideEffect` with effects is the likely big one.

✅ **First item (+R6.0) LANDED (5452ee0b, 490a66e8, 690de3d8).** Collector side effects (`aggregate`/`group`/
`groupCount('x')`) inside a decorrelated child body: `sideEffect()` is a CONNECTORS row, and the body plus its collector
sites are keyed in ONE decorrelation (`keyedBody`, `src/compiler/rel/lower/scoped.ts`); a body-filled collection is one
spooled relation read at the cap, membership one uncorrelated IN probe. Composes under local/flatMap/optional/where/map
(`test/L4-addendum/child-body-collectors.feature`). Remains for this item: nothing; the other R0-`ladder` hosts are
still open.

### R7 — Delete the switch, IF the earlier calls left nothing on it

Only if R3–R6 each concluded "replace". If a route was deliberately kept, the switch stays as that route's small,
documented fast path (the kept-route catalogue entry is its record), and R7 does not happen. That is an
acceptable end state, not a failure.

- **Preconditions:**
  - R0's count is 0;
  - R2's retry count is 0;
  - the scaling probe holds the cost-discipline list.
- **Delete:**
  - `correlatedChild` in `options/fast-paths.ts` and its readers;
  - `bothChildOrders` (deleted by N7);
  - L5's per-switch entry;
  - `FastPathConfig.connectorOnly`, which becomes the only mode.
- L9's connector-only ratchet becomes the ordinary coverage ratchet.
- Update root `CLAUDE.md` decision 6 and `src/compiler/CLAUDE.md`: no ladder remains.

## Order and parallelism

- R0 and R1 come first and are cheap.
- R2 and R3 are independent of each other.
- R4.1, R4.3 and R4.5 can go any time. R4.2 waits for the typed carrier. R4.4 rides with R2.
- R5 needs the owner's call only if its speed fix misses the bar.
- R7 is last, and conditional.

## Guards that already hold the direction

- `mise run ladder`: ladder files may not grow.
- L9: connector-only closure may not fall; every host is a row or a classified deferral.
- `mise run scaling`: the 1k/8k margins every deletion cites.

R0 adds the one guard still missing: the count of ladder-only answers may only fall.

## Next round (written 2026-11-17, after round 1)

Ordered: each prerequisite sits BEFORE the item it unblocks. Every round-1 item landed; nothing is parked on a
branch.

### N0 — Trunk CI is RED on a nondeterministic witness (FIRST — fix before anything else lands)

✅ **LANDED (4c213aa8).** `reach` (`test/L9-connector/ladder-reach.ts`) consults `isNondeterministic` — the
authority the census and L5 share — so a draw counts in its pool and can still be ladder-only, but is listed in
`random`, never compared in `differ`; the by-value per-scope-draw witness is now
`g.V().where(out('knows').sample(1).has('age'))`, whose outcome is deterministic ([marko] in both modes). No
baseline moved. Remains: nothing (the browser-graph-manager flake noted below is a separate observation).

GitHub CI for 760b3d5f (R2b+R4.4) and c10c57aa (R1, trunk tip) fails in `test/L9-connector/ladder-reach.test.ts`
("a draw a later step filters, under an existence host: CLOSED (R2b)"): `differ` lists
`g.V().where(out().sample(1).has('age')).values('name')`. The query DRAWS, so the default and connector-only
multisets legitimately differ run to run (marko passes with probability 2/3 per run); local `mise run ci` passed by
chance. Fix the witness, not the engine: assert `ladderOnly: 0` and both modes answer, and make `differ` skip a
query whose answer is nondeterministic (the same `orderIndeterminacy`/draw fact the L5 oracle uses), or pick a
witness whose filter makes the draw's outcome deterministic.
(c0c204bf, R5.1, was also red, on an unrelated browser test — `browser-graph-manager.test.ts` "a graph re-opened right
after its owner Worker died", `reopened = {vertexCount:0}`; later shas passed it, so it reads as a flake worth a look.)

### N1 — Fix R4.3's coverage regression (MAJOR — breaks end-state rule 3, "no query that answers today declines")

✅ **LANDED (6e58b6d2, 942cf358, 1c0d8cd3).** `reSourcedBody` (`src/compiler/rel/lower/scoped.ts`) now keeps a
re-source ONE shared read crossed with the prefix: under a first-row host the prefix's path crosses unchanged and the
read's own labels/path are shed; under an all-rows host the read's label binds ride out as alias channels
(`ownLabels`) and the rest splits only at a real host-state read or a rebind of a prefix label (`sharedEnd`), the fold
continuing over the cross (`reSource` in `lower/movement.ts` admits a path and a sack via one `splitRefuses`).
A query-text decline with an advisory reason remains for an all-rows host on a tracked path (`resource-path`); a
first-row host reading host state now ANSWERS through the fold's cross, kept correlated by the host's
correlated-first policy (M2; `resource-reads-host` remains only where the host cannot stay correlated). Witnesses in
`test/compiler/resource-general-cross.exec.test.ts`; scaling ~7-8x for 8x input; no baseline moved. Remains: nothing.

`reSourcedBody` (`src/compiler/rel/lower/scoped.ts`) returns `null` (hard decline) where it should return
`undefined` (fall through to the fold's GraphStep cross join, `reSource` in `lower/movement.ts`, which handles a
path) in two cases: (a) the prefix carries a channel outside alias/sack/loops/encounter — a `path` or a
`simplePath` host; (b) the rooted read binds its own alias. `connectorOwns` also removed the ladder fallback, so
these now raise "no lowering covers" in DEFAULT mode where the parent answered (parent answer in brackets):
`g.V().map(V().count()).path()` [6 paths], `g.V().out().map(V().count()).path()`,
`g.V().repeat(out()).times(1).map(V().count()).path().count()` [6], `g.V().both().simplePath().map(V().count()).count()`
[12], `g.V().local(V().as('x').out().select('x')).count()` [36], `g.V().local(V().as('x').out().where(neq('x'))).count()`
[36], `g.V().map(V().has('name','marko').as('m').out().select('m').values('name'))` [marko ×6],
`g.V().local(V().values('name').as('n').select('n')).count()` [36], `g.V().as('a').local(V().as('b').select('a','b')).count()`
[36], `g.V().local(V().has('name','lop').as('x')).select('x').count()` [6]. Fix: return `undefined` for those
shapes (the fold answers them), not a ladder rung. Add each as a witness; CI stayed green only because no corpus
scenario uses them.

### N2 — One fenced first-row read in `reSourcedBody` (MAJOR — compute-once rule)

✅ **LANDED with P4 (a2a1715f, eb11bdd8).** The twin CTEs came from `substRelId` (`src/rel/walk.ts`) rebuilding
every correlated subplan it walked; an untouched subplan now stays the same node (Calcite's
`RelShuttleImpl.visitChild` rule), so value and presence share one fenced read: `map(V().values('name'))` 1430 → 1024
bytes, `map(V().order().by('name').values('name'))` 2779 → 1642. Witness `test/L2-sql/first-row-once.sql.test.ts`.
Remains: nothing.

The first-row read is referenced twice (value and presence `EXISTS`) and emitted as two byte-identical
`MATERIALIZED` CTEs, so the graph scan + sort runs twice: `g.V().map(V().values('name'))` 757 → 1430 bytes,
`map(V().order().by('name').values('name'))` 1367 → 2779. Give both uses one fenced node, or read presence off the
value CTE's row. Lands naturally with P4 (one first-row builder) below.

### N3 — Linear pooled re-source for many keys (MAJOR — performance is semantics)

✅ **LANDED (d229d834) — partially: the bare re-source shapes.** `fuse` (`src/rel/fuse.ts`) gained Calcite's
AggregateJoinTransposeRule for a cross join beside Filter-below-Window: a SUM/COUNT over `Project* ∘ Join(cross)`
is factored into per-side sub-aggregates multiplied by the other side's count (Calcite's CountSplitter /
SumSplitter), so `group().by('name').by(V().count())` is 11.8 → 69.7 ms at 1k → 8k (5.9×; `E().count()` 7.3×,
`both()…` 8.9×). Test: `test/compiler/aggregate-join-transpose.exec.test.ts`. **Remains:** Witness 4
(`g.V().group().by('name').by(V().values('age').sum())`) and the name-keyed forms of witnesses 3 and 5
(`V().out().count()`, `V().has('age',gt(30)).count()`) are still quadratic, as before this change. In the weighted
pool (`scoped.ts` `pooledGroup` → `poolWeight` → `continueAs`) the cross happens at `V()` and the hops and filters
stack above it, so no Aggregate sits directly over the cross join. Missing prerequisite, one of: (a) push filters
and inner joins down through a cross join in `fuse` (Calcite's FilterJoinRule and join-associate rules, carrying
columns through the intermediate projections), or (b) make `reSourcedBody` accept a bulk-carrying prefix: cut the
shared read before the first bulk-observing barrier and carry bulk as the product of the two sides. With either,
the factoring rule reaches these shapes unchanged.

`g.V().group().by('name').by(V().count())` is 183 ms at 1k and 14,810 ms at 8k (81×): with `poolWeight` the graph
is still crossed once per KEY. `reSourcedBody`'s own law, rest(prefix×G) = prefix×rest(G), says rest(G) is computed
once and scaled by each key's weight; `pooledGroup` should reuse that seam instead of being a second re-source
authority. Measure with the scaling probe (≈8× is the bar).

### N4 — `covering` from `bounds.ts`, not a second copy (MAJOR — one authority)

✅ **LANDED (55fae41b).** `covering` in `src/rel/decorrelate.ts` is now `rowBounds(min ≥ 1)` over the correlated
input (`src/rel/bounds.ts`), with the eliminated key-projection filter as the one injected fact; the rule-by-rule
copy is gone. No answer or SQL change (census/sql-hygiene unmoved); L2 tests in `test/L2-sql/group.sql.test.ts` tie
`keyProjected` to `pooledGroup`'s `member.term IS scoped.term` filter. Landing also fixed a pre-existing L8 witness
(2b9f2054): `orderIndeterminacy` now credits an `order()` only in the window's own scope. Remains: nothing.

R5.1's `Out.covering` in `src/rel/decorrelate.ts` re-implements `rowBounds().min` rule by rule (limit, filter,
project/sort/distinct/window, LEFT JOIN, union, recursive, HAVING); the only fact `bounds.ts` lacks is "the
key-projection filter yields ≥1 row per key under `covers`". Compute covering as `rowBounds` over the correlated plan
with the eliminated filter passed in as a bounds override (the `ref.bounds` style). No answer change expected. Add
the L2 assertion tying `keyProjected` to the exact `member.term IS domain.term` filter `pooledGroup` builds, so a
future rewrite of that filter cannot silently lose the elimination.

### N5 — Connector's per-traverser min/max lowering (MAJOR — a named margin until fixed)

R4.1 opened the arm meet, so `g.V().union(map(outE().values('weight').min()), constant(0))` now takes the connector
in default mode: 5.6/45.0 ms → 24.9/196.2 ms (1k/8k, ~4.3×, still linear). The cost is the connector's existing
window/materialize argmax for a correlated min/max (`g.V().map(outE().values('weight').min())` is 25.0 vs 5.7 ms on
the ladder at 1k). `union(local(max), …)` shapes are ~1.3×. Fix it in the body's lowering (a plain per-key
`MIN`/`MAX` aggregate where only the value is read), not with a ladder rung. Until then it is a margin — see
owner question 3.

✅ **LANDED (f31ec6bb).** The one global min/max reducer (`src/compiler/rel/lower.ts`) is now a scalar `Aggregate`
of `arg_min`/`arg_max` (Calcite's ARG_MIN; `AggFn` in `src/rel/expr.ts`, emitted as SQLite's bare-column MIN/MAX)
plus a row count and a `count > 0` Filter — no window, no materialize — so a scoped body is keyed by
`decorrelate.ts`'s existing Aggregate rule; the `correlatedReduce` min/max ladder arm is deleted. Per-host min/max is
3–5× faster and linear (`union(map(min),constant)` 5.1/39.1 ms at 1k/8k, was 24.4/191.0). sql-hygiene bytes moved
for max/min/select (spelling only); census unchanged. Remains: nothing.

### N6 — R0 ratchet follow-ups (cheap, concrete)

✅ **LANDED (1c2b861f).** The closure ratchet is held per QUERY (`test/L9-connector/closure-ratchet.ts`
`compareClosure`): any fresh decline fails its cell even at an unchanged rate, and ladder-reach gets the same rule.
`familyOf` charges everything beneath a `host-owned` `DEFERRED_HOSTS` position to `other`. Ladder-reach now counts
FIRES (first child order alone declines with `CopiedDraw`) over pools that keep draws; recorded `fires 0` and
`rescued 0`, so N7's precondition already holds. Remains: nothing.

- Fail (or at least print) when `fresh` is non-empty in `test/L9-connector/connector-closure.test.ts`: the ratchet
  gates COUNTS, so a swap within one pool×family cell (one query closes, another regresses) lands silently.
- `familyOf` (`test/L9-connector/ladder-reach.ts`): a family host under a `host-owned` `DEFERRED_HOSTS` position
  (e.g. the `map()` inside the Grateful Dead `match()` scenario) is charged to `other`, using `Deferred.scope`.
- R2's done-when: count retry FIRES (first order declines), not only rescues, or reword it. Re-record the baseline
  if the rescue count has fallen since R2b.

### N7 — Delete the `CopiedDraw` retry arm, then `bothChildOrders` (after N6)

After R2a and R2b, `bothChildOrders` (`src/compiler/rel/spine.ts`) retries only on `CopiedDraw`. Once N6 counts
fires and the count is 0 on the pools, delete the arm and the retry (R7's precondition "R2's retry count is 0").

✅ **LANDED (8a103627).** Mechanism: `compileViaRel` (`src/compiler/rel/spine.ts`) lowers once, no retry. The wide instrument (`mise run ladder-reach`, L1 2395 + L6 312 + H1 2200 + H2 24594 traversals,
1155 s) read `rescued 0; fires 0`, ladder-only 22 (unchanged). Measured over those pools, not proved in general:
FIRES compiles only draws, and the H pools exclude draws, so the fire count covers L1/L6. So the whole retry went,
not only its `CopiedDraw` arm: `bothChildOrders`, `FastPathConfig.childOrderRetry`, `NO_RETRY` and the
rescued/fires counters and baseline fields. A plan decline (`CopiedDraw`) is now the ONE lowering's own reason,
pinned at depth in `test/L9-connector/ladder-reach.test.ts` (both modes). L1 compile work fell 2190 → 2016
lowerings (`test/compiler/compile-work.test.ts`). R7's "R2's retry count is 0" holds by deletion. M5 is absorbed:
its counter has no subject. Remains: nothing.

### N8 — Depth gaps (clean declines today; each is a body or a host row, never a rung)

- `where('a', P('b'))` with TWO by() entries where either is a traversal (`.by(out().count()).by(in().count())`,
  `.by('age').by(__.values('age'))`): `aliasCompare` answers both bodies; the host's own alias-where lowering
  declines the two-entry list. Also a landed fold body, `.where('a', eq('b')).by(out().values('name').fold())`.
- A pooled `group` inside a `choose` arm and a global `group` inside a `union` arm
  (`g.V().union(__.group().by(T.label).by(__.count()), __.count())`).
- A draw in a `group()` value-by (`group().by(label).by(sample(2).fold())`, corpus
  `g_withStrategiesXSeedStrategyX_V_group_byXlabelX_byXbothE_weight_order_sampleX2X_foldXunfold`): `pooledGroup`
  refuses a nondeterministic body; R2b's per-scope keying is the substrate.
- Weighted `sample(n).by(k)` anywhere (corpus `g_V_localXoutE_sampleX1X_byXweightXX`), `local(out().coin(p))`,
  `local(bothE().sample(1).otherV())`.
- `match(__.as('a').local(out().count()).as('b'))`: `local` passes on the reducer's new traverser without the `a`
  binding.

### N9 — Pre-existing, outside this plan (move to `docs/outstanding-work.md`)

- Reading a collected side effect in a per-traverser body is super-linear, no draw involved:
  `g.V().out().aggregate('x').V().limit(5).local(select('x').unfold()).dedup().count()` 1.5 s → 104 s (68×).
- `g.V().fold().as('x').unfold().local(select('x').unfold().sample(1))` leaks a bare `Error: database or disk is
  full` at 1k vertices (a data-size failure AND a bare Error reaching the user).
- `local(repeat(both()).times(k).dedup())` has no per-iteration bulk collapse inside a host (degree^k); R2a made
  k ≥ 64 reachable. Collapse-authority residue, `outstanding-work.md` §3.
- R2a docs: `docs/feature-support-matrix.md` row "Long bounded repeat inside a per-traverser host" still says
  times(63); `emit().times(64)` answers on Bun but declines on a DO (≈120 KB statement) — say so; and
  `host-unroll-width.exec.test.ts` wants a multiplicity witness (ring with a doubled edge, walks multiply 2^k).

### Reuse sweep (proposals from round 1's reviewers)

- **P1 — One effect vocabulary (fixes a measured WRONG ANSWER; do first).** `productivity.ts` `isImpure`'s private
  `SIDE_EFFECTING` list misses `addLabel`/`dropLabel`/`dropLabels`, keyed `tree('x')`, `call`/`io`/`fail`, so
  `g.V().where(__.addLabel('x').count())` is deleted by `isAlwaysProductiveFilterNoOp` and the write never happens
  (then `hasLabel('x').count()` is 0, not 6). Reuse `dropEffectFreeSideEffect`'s predicate (`MUTATING_STEPS` +
  `collectsSideEffect` + `OPAQUE_OR_RAISING`) as one export from `ir/step.ts`, keeping `sack(op)` and `mayRaise`.
  ✅ **LANDED (e89bb6f2).** `stepHasEffect` (`src/compiler/ir/step.ts`) is the one effect predicate that both
  `dropEffectFreeSideEffect` and `isImpure` ask (the private `SIDE_EFFECTING` list is deleted); a write inside a
  filter is now kept and declines by name (`write-in-filter`) instead of being silently trimmed. Remains: nothing.
- **P2 — One productivity rule (after P1).** Build `alwaysProduces`/`bodyAlwaysProduces` and coalesce's
  `alwaysFires` on the `existencePrefix` walk (a global seeded terminal cuts to `[]`; `isStreamIdentity` never
  empties; purity a separate gate), and fold `isAlwaysProductiveFilterNoOp` into `trimExistenceSuffix`.
- **P3 — Make `decorrelate`'s `owns` mandatory.** One keyed-body helper (`owning` + lower + effects + reframe +
  `decorrelate(…, mine.owns)`) for `scopedBody`/`rootedBody`/`pooledGroup`; the `() => true` default reintroduces
  the R2b bug for a fourth caller. Also one `ownDraws`/`draws` walker in `src/rel/copies.ts`.
  ✅ **LANDED (71fad22a).** `keyedBody` (`src/compiler/rel/lower/scoped.ts`) is the one owning-mint + lower +
  effect-refusal + reframe + `decorrelate(…, mine.owns)` sequence for `scopedBody`/`rootedBody`/`pooledGroup`;
  `decorrelate`'s `owns` (`src/rel/decorrelate.ts`) has no default. The `draws`→`ownDraws` merge in `copies.ts` was
  deliberately not done: it would trade the global memo for a per-call one. Baselines unchanged. Remains: nothing.
- **P4 — One first-row builder** that returns the relation itself when `atMostOneRow` (replacing the hand-rolled
  sort+LIMIT 1 / `ROW_NUMBER` forms in `reSourcedBody`, the scalar first-row, `rowsKeyedBy`, `build.ts`
  `firstRootedColumn`); the short-circuit lives in `perOriginWindow`. Carries N2.
  ✅ **LANDED (eb11bdd8, with N2 a2a1715f).** `firstRow(rows, order, fresh, partition?)` in `src/compiler/rel/build.ts`
  builds every first-row read (each caller keeps its own order); a relation already at most one row is its own first
  row. It lives in `build.ts`, not `lower/reduction.ts`, to avoid a cross-family import cycle. Corpus plans
  byte-identical. Remains: nothing.
- **P5 — `typeColumnOf(framing)`** in `framing.ts`: the one "which column holds a scalar's per-row type (`vt` vs
  `vtype`)" authority for the six sites that re-derive it; variant/merge admission becomes
  `scalarArmType(arm) && !reducedGlobally`.
- **P6 — Test harness:** one `sameAnswer(q, a, b)` + `totalBulk` + `storeFor(q, shared, mint)` in
  `test/support/multiset.ts`, replacing four hand-kept §17 unordered-window comparisons (L5 oracle, L5
  host-closure, L7 census, L9 ladder-reach).
- Smaller: one existence-host list (`EXISTENCE_HOSTS` in `scoped.ts`, `EXISTENCE_FILTER_HOSTS` in
  `strategies.ts`, the Pass's `applies` in `passes.ts`); `rootedBody` shares `scopedBody`'s second half.

### Still open from the original steps (unchanged)

R4.2 (waits for the typed carrier), R4.5 (decide whether the "a body that MOVES is left alone" pin is semantic),
R5.2–R5.4, R6, R7.

## Next round (written 2026-11-17, after round 2)

Round 2 landed N0, N1, N2+P4, N4, N6, P1, P3 (trunk 71fad22a). Nothing is parked on a branch. **N3 was not built:
it waits on owner question 5** (below), so it is struck from the worklist until answered. Still open from round 1:
N5, N7, N8, N9, P2, P5, P6, the existence-host list. Ordered: each prerequisite sits BEFORE what it unblocks.

### M0 — Do not hoist a constant one-row `VALUES` unit into a CTE (MAJOR, regression from N2 — do first)

N2's `substRelId` rule (`src/rel/walk.ts`, a2a1715f) now SHARES the scoped connector's seed row (`scoped.ts`
`seedRow`, `(VALUES (1)) su`) between the value scalar, the vtype scalar and the presence `EXISTS`. `name`
(`src/rel/passes/name.ts` `binds()`, ~l.89) hoists any node reached twice, so the seed becomes
`rNN AS (SELECT su.column1 AS n FROM (VALUES (1)) su)`; `emit.ts`'s unit fold (`unit: true`, ~l.636) drops only an
INLINE `VALUES`, so every correlated per-row subquery gets `FROM rNN su CROSS JOIN …` back — the co-routine the
emitter comment says costs ~10% of a one-hop body. Answers unchanged, still linear, but every plain
`map(<path>.values(k))` is slower: `g.V().map(values('name'))` 7.22 → 10.20 ms at 8k (+42%);
`g.withPath().V().as('a').out().map(select('a').values('name'))` 137.5 → 173.1 ms at 32k (+26%, corpus plan 1143 →
1252 bytes). Fix on the existing authority: `name` does not bind a compiler-constant one-row `VALUES` (copying it is
free), reusing `emit.ts`'s unit classification, not a special case in `substRelId`. Pin it in
`test/L2-sql/first-row-once.sql.test.ts`: no `(VALUES (1))` CTE and a byte bound on `g.V().map(out().values('name'))`
(the current test checks only for duplicate `MATERIALIZED` bodies, so it cannot see this). Record correction: N2's
"census byte-identical" holds for the census only. Corpus SQL changed in 4 of 2,395 plans (2 shrank, 2 grew +109/+11
bytes from this hoist), so the `select.compiler` 175 → 275 re-record is not purely a stale baseline.

✅ **LANDED (fe84f779).** One predicate, `isUnitValues` (`src/rel/block.ts`, beside `isDirectSource`): the emitter's
`directSource` sets `unit` from it and `name`'s `binds` refuses to hoist it, so each block's `withoutUnit` fold erases
the inline seed. `map(out().values('name'))` 1423 → 1314 bytes, `map(values('name'))` 928 → 824; both linear (~8× at
1k → 8k). Pinned in `test/L2-sql/first-row-once.sql.test.ts`; witness shapes in `scripts/scaling-probe.ts`. No
baseline moved. Remains: nothing.

### M1 — All-rows host over a tracked path: one shared-read crossing (substrate for M2–M4)

One root cause behind several round-2 findings: when a body reads no host state, `local`/`flatMap` over a tracked
path has no shared-read crossing. It either declines (`resource-path`) or goes to the per-host fold (N×G).
- `flatMap` is wrongly grouped with `local`. `FlatMapStep.processNextStart` returns `this.head.split(...)`
  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/FlatMapStep.java`),
  so its output path is host path + end object, the same contract as `map()`'s first-row crossing. Only `LocalStep`
  (`…/step/branch/LocalStep.java`) emits the child's own traversers. Answers are right today (inner labels already do
  not ride out of flatMap). But `g.V().out().flatMap(V().has('name','marko')).path()` declines `resource-path` when it
  could cross like `map()`, and the `scoped.ts` comments cite the wrong contract.
- `g.V().out().local(V().order().by('name').limit(1).values('name')).path().count()` runs the per-host fold (1.9 s at
  500 vertices; it declined on trunk before). The shared read could serve it.
Item: under `local`/`flatMap`, a body that reads no host state crosses the prefix's path unchanged with ONE shared
read (`reSourcedBody` / `sharedEnd`). `flatMap` takes `map()`'s path contract. Fix the comments.

✅ **LANDED (ab0c9a36, f195241f).** `reSourcedBody`'s `first` flag became the host's own rejoin contract,
`'first' | 'split' | 'forward'` (`src/compiler/rel/lower/scoped.ts`), taken at each site from the rejoin policy it
already passes. Under `'split'` (flatMap, coalesce) a tracked path crosses the shared read unchanged and `rejoin`
extends it by the result, so `g.V().out().flatMap(V().has('name','marko')).path()` answers. `local` stays `'forward'`
(`LocalStep` emits the child's own path); its cost policy is M2's. Fix-forward: `tree()` orders its paths by the
rejoin's encounter (`src/compiler/rel/lower.ts` `treeTail`), closing a bare internal Error that predated M1. Linear
(~7–8.5× at 1k → 8k). No baseline moved. Remains: nothing.

### M2 — Make the reducing-rest cost policy consistent (after M1)

✅ **LANDED (a6a8f497, 90f1118d, 75e1d1a9).** One decision: a FIRST-row host (`map`, a `by()`, a filter) whose
re-source rest reads host state ANSWERS through the fold's GraphStep cross (`reSourcedBody` returns `undefined`,
`reSource` in `lower/movement.ts`), read per host row by the host's own correlated-first policy (`correlatedBody` sets
`lowerBody`'s `correlated`; `firstInnerOver` / `fencedHost`, `landValues`' `correlatedValue`, the existence probe) and
stopped at its first row (`LIMIT 1` / `EXISTS`) — TraversalMapStep's one `next()`, TraversalFilterStep's one
`hasNext()`. Only where the host cannot read it per row (the decorrelated fallback, every host × G ahead of the pick)
does it still decline, with the explained `resource-reads-host` message — a property of the query text, never a cost
decline. A barrier rest (`map(V().as('x').out().where(neq('a')).count())`) is N×G by the query's meaning, as under
the all-rows hosts, and the probe labels those shapes `xNG`. Fix-forward: `positionKeys` (`src/rel/position.ts`) keeps
a nested join side's key columns in place (`g.V().map(both().both().values('name'))` read the wrong vertex on trunk).
Linear (5–8.6× at 1k → 8k) for the first-row shapes; no baseline moved. Remains: nothing.

`scoped.ts`'s host-state comment says an all-rows host's fold is "linear in what it returns". That is false when
the rest ends in a barrier: `g.V().as('a').local(V().as('x').out().where(neq('a')).count()).count()` takes 52 ms at
250 vertices and 916 ms at 1k (17.6× for 4×). The query asks for N×G (Java flows N×G too), so it is not a defect in
itself. But the first-row decline refuses the same cross on the ground that it "would pay that whole cross for one row
per host", so the two policies disagree. Fix the comment and make one decision; if it is not clear-cut, take it to
the owner with both timings.

### M3 — Scaling probe shapes that can see a quadratic re-source (cheap)

✅ **ABSORBED BY M1 (ab0c9a36, f195241f).** `scripts/scaling-probe.ts` now carries the `resource: … .path` shapes
(`map(V.max).path`, `map(V.limit.values).path`, `where(V.out.has).path`, `local(V.order.limit).path`) and the M2
`resource xNG` query; the N1 `.dedup()` is recorded in a comment beside `local(V.has.values).count`. Remains: nothing.

Every `resource:` shape in `scripts/scaling-probe.ts` ends in a cheap rest (`count()`, `values()`, an indexed
`has`), so the probe could not see the routes in M1/M2. Add `map(V().values('age').max()).path()`,
`map(V().limit(1)).path()`, `where(V().out().has(…)).path()` and the M2 query. Note: N1 changed the existing shape
`local(V.has.values).count` to add `.dedup()` without saying why, so its numbers are not comparable with earlier
runs. Either revert that or record it in the probe.

### M4 — Decline messages that name the user's shape (cheap, explain-don't-baffle)

- `resource-path` says the path is tracked by "a path(), simplePath() or cyclicPath() around it". For
  `g.V().local(V().simplePath().count())` and `g.V().local(V().order().by('name').limit(1).path())` the tracking is
  INSIDE the body.
- `keyedBody`'s effect refusal (`scoped.ts`) is still a silent `null`, so `g.V().local(addV('x'))` gets the generic
  "no lowering covers". Give it a reason at that site; the reason's wording follows `writeInFilter`.
- `g.V().group().by(label).by(out().sample(1))` (and `.count()`) declines generically. Say that the problem is a
  random draw inside a group value.
- `CopiedDraw` on a `choose()` predicate (`g.V().choose(out().sample(1).hasLabel('person'), constant(1),
  constant(2))`) suggests `local(out().sample(1)).union(…)`, which does not fit a predicate.
- P1's `write-in-filter` replaced the generic message for EVERY graph write in a filter body
  (`where(property(..))`, `not(drop())`, `where(addE(..))`, `where(mergeV(..))`), not only label writes. Say so in
  `test/compiler/existence-prefix.exec.test.ts`.

✅ **LANDED (ee8157e8).** One builder, `writeInChild` (`src/compiler/unsupported.ts`), names a graph write in any
child body. It is called from `programWrites`' walk (`src/compiler/rel/write.ts`), which already visits every child
with its host. A filter host keeps the write-in-filter wording; coalesce/optional/choose/union point at
`mergeV()`/`mergeE()`; every other host says to move the write out. `resource-path` names its host
(`ChainCtx.host`) and says when the path is asked for inside the body. `pooledGroup` names a random draw in a group
value. `CopiedDraw`'s suggestion now fits a predicate. No SQL change. Remains: nothing.

### M5 — Refine N6's FIRES count before N7 (cheap; then N7)

✅ **ABSORBED BY N7** — the retry and its FIRES counter were deleted; the positive witness below is now a
`CopiedDraw` decline test.

`fires` counts four ordinary `choose()` queries whose first order throws `CopiedDraw` and whose second order ALSO
declines (`g.V().choose(out().sample(1).hasLabel('person'), constant(1), constant(2))`, the no-else form,
`…count().is(gt(0))…`, `g.V().hasLabel('person').choose(__.outE().sample(1).inV().hasLabel('software'),
values('name'))`). N7 cannot change them, but a corpus pin that adds one would turn the ratchet red and block N7 for
no reason. Count only a fire whose second order ANSWERS (that is the one N7 risks), and add a POSITIVE witness so the
counter cannot go silently vacuous (`g.V().choose(out().sample(1).values('name'), identity(), out())` fires under
`NO_RETRY` today). State in N7 that "fires = 0" is measured over the L1/L6/H pools, not proved in general.
Unblocks N7.

### M6 — Small cleanups from review (cheap, concrete)

- Duplicate `encounterOf`: `src/compiler/rel/build.ts` ~l.980 copies the export in `src/compiler/rel/lower/chain.ts`
  ~l.104. Keep the one in `build.ts` (lower layer).
- `decorrelate.ts` doc comment (P3) says the `owns` default "made … pick again for every row — a measured wrong
  answer". At the parent every production caller already passed `mine.owns`, so it was a trap for new callers, not a
  live bug. Reword it.
- N4 changed plans for a PARAMETER `limit`/`skip` in a `by()` body (`group().by(label).by(limit($n).count())`):
  the domain `LEFT JOIN` is now always kept, because `rowBounds` refuses a parameter. That is an improvement: the old
  plan shape depended on the parameter's value. Pin it with one L2 test.
- N4 missed optimisation (predates N4): `by(identity().count())` keeps the domain `LEFT JOIN` because the pooled
  filter carries a residual `WHERE (1 = 1)`, so `keyProjected`'s `rest` is non-empty. Drop a provably-true conjunct
  in `keyProjected`. Also check `by(order().by('name').count())` and `by(V().count())`.
- `test/compiler/resource-general-cross.exec.test.ts`: "two read labels beside a host label" and "a read label
  beside a host label of another name keeps both" check only row counts. Assert the maps (e.g.
  `select('x','y').by('name')` → josh/lop, josh/ripple).
- N0: a draw that both modes answer now goes to `random` and is not checked at all. Keep a weak invariant over
  `random`: a count bound, or each answer a sub-multiset of the un-sampled query.
- N6's `familyOf` also lets a host-owned site outrank an ENCLOSING family host. That moved 4 L1 queries
  (`local`/`map(choose(values('age')).option(…))`, corpus.txt 515/516/2077/2078) from per-traverser to `other`.
  Connector-only declines them (the same `choose` at the top level answers), so R4's family count no longer shows
  that dependency. L3 would still catch a lost answer. Note this in R4's done-when. The body itself goes in N8.

### N8 additions (depth gaps, clean declines today; a body or host row, never a rung)

- N1 leftovers: `g.V().local(V().as('x').out().select('x')).path()`, `g.V().project('n','c').by('name').by(V().count()).path()`,
  `g.V().out().map(V().fold()).path()`, `g.V().repeat(out().V().has('name','lop')).times(2).path()`, corpus
  `CyclicPath.feature:74`; first-row bodies `g.V().out().map(V().values('name').fold()).path()`,
  `map(V().has('name','zzz').fold()).path()`, `project('a').by(V().values('age').sum()).path()`,
  `choose(V().count().is(6),constant('six'),constant('no')).path()`; `local(V().coalesce(out('knows'),constant('none')))`.
- `g.V().map(__.choose(label()).option('person', __.out().count()).option('software', constant(0)))` and the four
  `local`/`map(choose(values('age')).option(…))` corpus queries: an option-map `choose` body under a host.
- Out of plan, for `docs/outstanding-work.md`: `g.V().coin(1.0).count()` / `coin(0.0).count()` decline, while
  `Coin.feature` expects every vertex and zero vertices.

### Next round — reuse sweep (round 2's proposals)

- **P7 — One col-retargeting authority, `substRelId`** (`src/rel/walk.ts`). Since N2 it keeps untouched subplans
  shared, so three hand-rolled copies can go. Answers unchanged; plans can only share more. Do this after M0, so the
  extra sharing does not re-trigger the unit hoist.
  - `src/rel/passes/semijoin.ts` `retarget` (~l.390): one memo per nested subplan, and it un-shares the DAG (the N2
    root cause).
  - `src/compiler/rel/build.ts` `reread` (~l.1310): its pre-scan exists only because `substRelId` used to rebuild
    every subplan, which no longer holds.
  - `src/compiler/rel/write.ts` `reScope` (~l.4800): it stops at subplans, so a correlated subquery over `incoming`
    would keep naming the old scope (a latent unresolved column).
  ✅ **LANDED (620df051).** All three copies are gone. `semijoin.ts` `retarget`, `build.ts` `reread` and `write.ts`
  `reScope` now call `src/rel/walk.ts` `substRelId`, which keeps subplans it does not touch shared and does go into
  correlated subplans. Answers and plans did not change: census, sql-hygiene and l3-state are as before. Remains:
  nothing.
- **P8 — Route the remaining hand-rolled `sort`+`LIMIT 1` first-row picks through `firstRow`.** The sites:
  - `scoped.ts` priority-arm `firstOf` (~l.570) and `first` (~l.585)
  - `reduction.ts` ~l.957 (min/max winner)
  - `list.ts` ~l.777
  - `collection.ts` `lastMember` (~l.687)
  - `build.ts` `firstOf` (~l.895)
  Each keeps its own order terms. That is about 25 lines, and P4's "one first-row builder" becomes true.
- **P9 — Route the first-per-partition `ROW_NUMBER … = 1` windows through `perOriginWindow`.** These are exact
  matches:
  - `write.ts` `rankedFirst` (~l.1617)
  - `map.ts` `dedupGroupMembers` (~l.1196)
  `collection.ts` `firstOccurrences` (keeps the rank column) and `slice.ts` `dedupOnTyped` (rewrites bulk) need a
  small option, or stay as they are. Have `perOriginWindow` emit `= 1` for a slice of one, or re-record census and
  sql-hygiene for a text-only change.
- **P10 — One filter-host set** (absorbs round 1's "one existence-host list"). The same five names are spelled
  separately in:
  - `scoped.ts` `EXISTENCE_HOSTS` (~l.2049)
  - P1's `unsupported.ts` `FILTER_HOSTS` (~l.83, used by `write.ts` ~l.1119)
  - an inline list in `ir/passes.ts` ~l.188
  - `ir/strategies.ts` `EXISTENCE_FILTER_HOSTS` (~l.187), a near-twin
  - `ir/bulk.ts` `COLLAPSE_FILTERS` (~l.192), a superset
  - `test/L5-properties/attribution.ts` ~l.211
  Export one set and import it everywhere. If they drift, a new filter host declines generically rather than with
  `writeInFilter`.
  ✅ **LANDED (6db3f4bd).** `FILTER_HOSTS` lives once in `src/compiler/ir/step.ts` (with `SINGLE_BODY_FILTER_HOSTS`
  and `FAN_OUT_HOSTS` beside it); every `src/` copy derives from it, guarded by `test/compiler/filter-hosts.test.ts`.
  Remains: nothing in `src/` (the L5 generator's own `FILTER_HOSTS` in `test/L5-properties/attribution.ts` is a
  test-side copy, left as is).
- **P11 — `writesOrCollects` in `ir/step.ts`** (= `MUTATING_STEPS` ∪ `collectsSideEffect`). `stepHasEffect` becomes
  `writesOrCollects || OPAQUE_OR_RAISING`, and `strategies.ts` `carriesIterationState` (~l.1505) asks
  `writesOrCollects`. That leaves one place to add a new write or collector step. Also check `reduction.ts` ~l.1579:
  its evaluable-once prefix test asks only `collectsSideEffect`. Confirm a write there is refused upstream, or make it
  ask `writesOrCollects`.

## Decisions for the owner

1. **Per kept route, at its step:** replace or keep. Settled in principle (considered replacement, not forced);
   each call is made with that step's measurements in hand. (`group` at R5 is the first likely "keep".)
2. **Scope of "ladder" vs "host-owned"** (R0's classification). Should `repeat` until/emit's own condition
   lowering stay as it is?
3. **(round 1, R5.1 builder, verbatim:)** "It still misses the 1.2× bar on two witnesses: group().by(label).by(count())
   went from 1.95× to 1.40× and group().by('name').by(tail()) from 1.37× to 1.30×. Those numbers go back to the owner."
   Accept these as named margins for R5's step-4 delete, or require more speed work first? Same question for N5's
   per-traverser min/max margin (~4.3× on `union(map(<min/max>), constant(0))` until the connector's argmax is fixed).
4. **(round 1, R0 builder, verbatim:)** "The R6 split of the deferred hosts is my judgement and needs the owner's
   confirmation." (27 `ladder` / 21 `host-owned`; `repeat` until/emit set `host-owned`, `sideEffect` set `ladder`,
   each with a comment in `test/L9-connector/deferred-hosts.ts`.)
5. **(round 2, N3 — not built, verbatim:)** "N3's 81× is measured per VERTEX, but the queries semantically produce
   N×G traversers (the reference does the same N×G work, and poolWeight already does less), so by the 'linear in
   traversers flowing' rule it is linear. Its witnesses are bodies that ignore their key (group().by(k).by(V().count())).
   Should vertex-quadratic but traverser-linear cost be in the performance rule's scope? If yes, build it as one fuse.ts
   AggregateJoinTransposeRule (COUNT/SUM over a cross join), not a pooledGroup law; if no, strike N3 from the plan."
   (M2's reducing-rest policy is the same question in another host. Answer them together.)

### Owner answers (2026-11-17) — questions 2–5 are DECIDED; build from these

- **Q2 — `repeat` until/emit: option B.** Bounded (`times(n)`) `emit`/`until` conditions lower through the
  connector's existence row at each unrolled phase — today a bounded loop declines conditions the unbounded one
  answers (measured: `emit(out().count().is(gt(1))).repeat(out()).times(2)` declines, the same without `times`
  answers; also `emit(map(…))`, `emit(where(…mean()…))`, `emit(coalesce(…))`, `emit(local(…limit(1)))`, and the L1
  `emit(hasLabel('person')).repeat(out().order().by('name')).times(2)`). Then MEASURE whether the unbounded condition
  can take the connector's correlated form (SQLite forbids aggregates/windows in the recursive SELECT, not inside a
  correlated subquery — `count().is()` already works there). Only what SQLite genuinely cannot hold stays
  `host-owned`, with that limit as its recorded reason. Owner: "the implementation there has to be a limited one" —
  a partial is accepted where SQLite forces it, so users don't have to think about it elsewhere.
  ✅ **LANDED (5c1edb55) — the bounded half.** `repeat(b).emit(p).times(n)` (every emit/until position) unrolls:
  each tested level is the arm's phases + `filter(p)` through the connector's existing filter row
  (`src/compiler/ir/strategies.ts`; level order read off `.../step/branch/RepeatStep.java`, `doUntil` before
  `doEmit`); `emit(loops().is(P))` is decided per arm at compile time, any other `loops()` read in the test declines
  by name. Repeat.feature `g_V_emitXhasLabelXpersonXX_repeatXout_order_byXnameXX_timesX2X_valuesXnameX` now passes
  (L3 2052 → 2053); emit shapes in the scaling probe, ~8.5–9× from 1k to 8k. Remains: nothing for the bounded
  item. (The "then MEASURE the unbounded condition in correlated form" clause was not part of this landing.)
  ✅ **LANDED (ccfe92a4, 30568349, 5ca1aef2) — the unbounded half.** An unbounded `repeat`'s `emit`/`until`
  condition led by a non-movement step (`coalesce`/`local`/`union`/…) lowers as the connector's correlated
  existence probe inside the recursive term (`src/compiler/rel/lower/scoped.ts` + `src/rel/decorrelate.ts`;
  `test/L4-addendum/repeat-condition-any-head.feature`); an emit condition is asked once per distinct walk state, and
  what SQLite genuinely refuses in a recursive term stays declined with that limit as its recorded reason. Remains —
  both recorded in `docs/outstanding-work.md` §1b: (1) **walk-until-hub** — the movement-head `until` that filters a
  neighbourhood is 22.8× (already on trunk); fixing it needs a per-distinct-element evaluation inside the recursion
  (e.g. a reachability pre-pass), or an owner decision to decline it. (2) **scope-free-subterm** — a decorrelator rule
  leaving a scope-independent membership subterm unkeyed; until then a filtering walk condition under
  `where`/`local`/`map` is 18–21× at a hub, as are the equivalent nested `where()` bodies on trunk. Caveat: the
  per-state semi-join relies on SQLite's automatic index (same caveat as setop-autoindex-do); unchecked on DO.
- **Q3 — margins.** (a) ACCEPT the `group` margins (`by(label).by(count())` 1.40×, `by('name').by(tail())` 1.30×) as
  named margins; R5 step 4 deletes the route. Default users already run the connector, so the delete slows no one.
  QUEUE (not a gate) a decorrelation rule that closes the remaining join-then-GROUP BY gap. (b) N5 is a FIX, not a
  margin: a plain per-key `MIN`/`MAX` where only the value is read — a 4.3× default-mode regression R4.1 introduced.
- **Q4 — deferred-host split: option B (widest scope).** Confirmed, plus: writes (`WRITE_ARG`) and option maps
  (`OPTION_MAP`) come INTO scope as CONNECTORS rows (they answer connector-only today through the shared substrate;
  the point is that no position is a special case); `V`/`E` (`RESOURCE`) is stale since R4.3 (`map(V().count())`
  answers connector-only) — make it a row; bounded `repeat` per Q2; `sideEffect` with effects is R6's FIRST item —
  `g.V().sideEffect(out().aggregate('x')).cap('x')` declines in EVERY mode today. Not this plan:
  `g.V().as('a').mergeV(project('name').by(select('a').values('name')))` declines in every mode → `docs/outstanding-work.md`.
- **Q5 — N3 + M2: option A.** Vertex-quadratic but traverser-linear cost IS in scope. Build the general
  `AggregateJoinTransposeRule` (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/rules/AggregateJoinTransposeRule.java`)
  in `fuse.ts` — COUNT/SUM over a cross join factored per side — not a pooledGroup law. First scenario: bulk/
  multiplicity (the count×count arithmetic is where it can go wrong). M2: make the policies consistent by the first-row
  path ANSWERING the cross it declines today — never decline on cost.

## Next round (written 2026-11-17, after round 3)

Round 3 landed M0 (fe84f779), P7 (620df051), P10 (6db3f4bd), M4 (ee8157e8), N7 (8a103627; absorbs M5) and M1
(ab0c9a36, f195241f; absorbs M3). Every round-3 branch landed; nothing is parked on a branch. Owner answers Q2–Q5
(above) are DECIDED and feed the items below. Still open from earlier rounds: M2 (now decided by Q5), M6, N3 (decided
by Q5), N5 (decided by Q3b: a fix), N8, N9, P2, P5, P6, P8, P9, P11, R4.2, R4.5, R5.2–R5.4, R6, R7. Ordered: each
prerequisite sits BEFORE what it unblocks.

### Parked: M1b — `local()` over a tracked path with a `V()`/`E()` re-source (DEFERRED)

M1 kept `local` on the `'forward'` contract, because `LocalStep` emits the child's own traversers
(`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/LocalStep.java`),
so its path is host path ++ read path, not host path + end. `g.V().out().local(V().order().by('name').limit(1)).path()`
therefore still takes the per-host fold rather than one shared read. Not built: no substrate concatenates two paths.

- **Prerequisite, ordered before M1b — H1: a history-concatenation primitive** in `src/compiler/rel/history.ts`
  (path ++ path over the canonical JSON history, exact, O(path length) per row, no new per-row term beyond the
  concatenation). Build it only when a NON-contrived query needs it; the measured cost today is the fold, which is
  linear in what it returns. Then M1b is `local`'s `'forward'` contract crossing the shared read with H1.
- M2's cost policy (above) owns the question of whether the fold is acceptable meanwhile.

### K1 — Ground the child-write advisory in the host that declined (MAJOR-ish: explain, don't baffle; do first, cheap)

Two reviewers found the same root cause in M4. `lowerChain` (`src/compiler/rel/lower.ts`) appends
`writes.childWrite` to ANY decline, so a child write that lowers fine is blamed for an unrelated gap:
`g.V().hasLabel('software').union(addV('x')).local(V().simplePath().count())` and
`…union(addV('x')).group().by(label).by(out().sample(1).count())` now say "a write (addV()) inside union() is not
supported yet", but `union(addV('x'))` alone answers. Likewise the real gap behind
`g.V().union(addV('x'), identity()).count()` is a write in a MULTI-arm union, not a write in a union. Fix: keep
`programWrites` (`src/compiler/rel/write.ts`) as the place the write is FOUND (sideEffect and a write's own argument
never reach `scopedHost`), but attach the hint only when that host's own lowering declined (record it on the route that
refused the body), or soften the wording to "may not be supported here". Same item:

- **Upsert advice by shape, not host.** `UPSERT_HOSTS` (`src/compiler/unsupported.ts`) gives the `mergeV()/mergeE()`
  hint to every coalesce/optional/choose/union write, including a conditional update
  (`g.V().has('person','name','marko').choose(has('age', gt(20)), property('adult', true), property('adult', false))`).
  Give it only when the write is `addV`/`addE`/`mergeV`/`mergeE` (or the body is the `fold().coalesce(unfold(), …)`
  idiom); `property()`/`drop()` get the "move it out" wording. `UPSERT_HOSTS` is the same set as `BRANCH_KINDS`
  (`src/compiler/ir/step.ts`) — import it.
- Cosmetic: `resourcePathMessage` (`src/compiler/rel/lower/scoped.ts`) writes "a optional() body"; choose a/an.

✅ **LANDED (b93bbdbf, with P15).** `Declines` records the furthest step the fold reached per step list, and
`lowerChain` (`src/compiler/rel/lower.ts`) names the child write only when the fold declined AT the step holding it
(else "may not be supported here"); a write on a path-tracked traverser now says so at its own lowering
(`write-on-path`). Upsert advice follows the write's shape (addV/addE in a `BRANCH_KINDS` body); `UPSERT_HOSTS` is
deleted; "an optional()". Message-only, no baseline moved. Remains: nothing.

### K2 — Declines that lost their explanation under M1 (minor, one item)

Under `'split'`, `reSourcedBody` no longer notes `resource-path`, and the later decline notes nothing, so these say only
"no lowering covers …": `g.V().out().coalesce(V().has('name','marko'), constant('x')).path()`,
`g.V().out().flatMap(V().has('name','marko')).dedup().by(path()).count()`, `….flatMap(V().has(…)).dedup().path()`,
`….tree().count(local)`, `….path().tree()`, `flatMap(V().fold()).path()` (while `flatMap(V().count()).path()` answers),
`project('n','p').by('name').by(flatMap(V().has(…)).path())`, `.select('a').path()` after a flatMap re-source. Each
matches the same shape with a plain `flatMap(out())` body on trunk, so these are older flatMap/coalesce+path gaps
newly exposed, not new holes. Fix: the LATER decline says in the user's terms what is unsupported (a `constant()` arm
beside a re-sourced arm; `by(path())`/`dedup()` over a flatMap rejoin), or close the gap in the body's lowering. Also:
the header comment of `test/compiler/resource-general-cross.exec.test.ts` still groups `local` with `flatMap` as "an
ALL-rows host on a tracked path declines" — now true only of forward hosts; add a row for a path reader AFTER the split
host (`flatMap(V()…).simplePath()`, answers 6 on `g.V().both()…`).

### K3 — P7 left one hand-rolled retarget (cheap, concrete)

`negativeOwners` (`src/rel/passes/semijoin.ts` ~l.594) re-points `props.value` to `fts.text` with its own
`rewriteExpr`; that is `substRelId(matches, props.id, fts.id, () => 'text')` (the `readsOnlyValue` gate guarantees one
column, no subplan). P7 also rewrote the `readsOnlyValue` comment to cite `substRelId`, which this site does not call —
route it through `substRelId` or restore the comment. Reach: `g.V().has('name', notContaining('x'))` on an FTS-indexed
store. Answers unaffected.

### K4 — tree()'s encounter order (minor, judgement)

M1's fix makes `treeTail` (`src/compiler/rel/lower.ts`) order folded paths by the encounter column, repeating the
`fold()` path arm's law instead of sharing it. `Tree` is a `HashMap` in the reference, so that order is not observable;
`dropEncounter` before the fold gives the same answer for one sort fewer. Either share one `foldPaths` default with the
`fold()` arm (so the next collector cannot leak the same bare `Error` from `collectionConsumesEncounter`,
`src/rel/obligations.ts`), or drop the encounter. Pick one; no answer changes.

### R6.0 — `sideEffect` with a filter-hosted body feeding a collector (folds into R6's first item, owner answer Q4)

✅ **LANDED with R6's first item (5452ee0b, 490a66e8).** `sideEffect(where(out()).aggregate('x'))` now answers.
Remains: nothing.

`g.V().sideEffect(where(out()).aggregate('x')).cap('x').unfold().count()` declines with the generic message, the same
on trunk before P10. It is the `sideEffect`-with-effects host owner answer Q4 makes R6's FIRST item
(`g.V().sideEffect(out().aggregate('x')).cap('x')` declines in every mode); both need effects threaded through a
scoped body. Until R6 lands, the decline must name what is unsupported ("a side effect (aggregate()) collected inside
sideEffect() …"), not "no lowering covers".

### Next round — reuse sweep (round 3's proposals)

- **P12 — One `PATH_READERS` set (PATH_FAMILY ∪ {tree}) in `src/compiler/ir/step.ts` — FIXES A WRONG ANSWER; do
  first.** `src/compiler/ir/strategies.ts` ~l.762 `inlineIdentityHostBody`'s `readsPath` asks only `PATH_FAMILY`, so a
  `map(identity())` entry is spliced away when only `tree()` reads the path: `g.V(1).map(identity()).out('created').path()`
  gives `[v1, v1, v3]` but `.tree()` gives `{v1:{v3}}` where the reference gives `{v1:{v1:{v3}}}`
  (`vendor/tinkerpop/gremlin-core/.../step/map/TreeStep.java` reads the full path). Replace `analyze.ts:43`'s private
  `PATH_STEPS`, M1's inline `readsPath` in `scoped.ts` ~l.349 and M4's `PATH_STEPS` in `scoped.ts` ~l.338 (a copy of
  `PATH_FAMILY` that also misses `tree`) with the one set; consider `TRAVERSER_STATE_READS` = {sack, loops} ∪
  `PATH_READERS`. Pin the tree() answer.
  ✅ **LANDED (7f715408).** `PATH_READERS` = `PATH_FAMILY` ∪ {tree} is exported from `src/compiler/ir/step.ts` and is
  the one "is a path position observable" authority: the identity-host splice, `analyze.ts` `tracksPath` (private
  `PATH_STEPS` deleted), `scoped.ts` `readsPath`, and `TRAVERSER_STATE_READS` derive from it; `PATH_FAMILY` stays only
  where the question is from()/to() hosting or label emission. `map(identity()).out('created').tree()` now gives
  `{v1:{v1:{v3}}}` (pinned). No baseline moved. Remains: nothing.
- **P13 — `rejoin()` takes the `RejoinContract`** (`scoped.ts` ~l.1154) instead of `(policy, firstOnly)`: ('split',
  true) is `'first'`; `allRows`/`priority` take `Exclude<RejoinContract,'first'>`; the meaningless ('forward', true) can
  no longer be written. 4 call sites, no SQL change.
- **P14 — Derive the last literal filter-host copies from P10's sets.** `bulk.ts` `BULK_TRANSPARENT` =
  `COLLAPSE_FILTERS` ∪ {as, identity, barrier} (else a new filter host misses `bulkVerdict`); `analyze.ts`
  `CONNECTOR_HOSTS` = `FILTER_HOSTS` ∪ `FAN_OUT_HOSTS` ∪ the branch/by()/reducer names (else the load-time
  CONNECTORS==CONNECTOR_HOSTS throw, `scoped.ts` ~l.2046, trips); `lower/filter.ts` ~l.157 and `strategies.ts` ~l.250
  inline tests → `SINGLE_BODY_FILTER_HOSTS`/`FILTER_HOSTS` (the filter.ts site is on the ladder; may wait for its
  rung's deletion). Identical membership; extend `test/compiler/filter-hosts.test.ts`.
- **P15 — Classify a child write once.** `programWrites` (`write.ts` `noteWrite`) already splits on `FILTER_HOSTS`;
  `writeInChild(host, write, filterHosts)` (`unsupported.ts` ~l.107) tests it again. Carry `filter: boolean` on the
  child write (or two builders) and drop the parameter. Do with K1.
  ✅ **LANDED with K1 (b93bbdbf).** `programWrites` classifies each child write once (`ChildWrite`: filter, upsert,
  host step); `writeInChild` lost its `filterHosts` re-test. Remains: nothing.

### Needs-human questions (round 3)

None raised.

## Next round (written 2026-11-17, after round 4)

Round 4 landed N5 (f31ec6bb), K1 + P15 (b93bbdbf), Q2 bounded half (5c1edb55), P12 (7f715408), M2 (a6a8f497,
90f1118d, 75e1d1a9), R6's first item + R6.0 (5452ee0b, 490a66e8, 690de3d8), N3 partially (d229d834) and Q2's unbounded
half (ccfe92a4, 30568349, 5ca1aef2). Every round-4 branch landed, so no branch is parked as a resume point. Still open
from earlier rounds: M1b (parked behind H1), M6, N3 (remainder below), N8, N9, K2, K3, K4, P2, P5, P6, P8, P9, P11,
P13, P14, R4.2, R4.5, R5.2–R5.4, R6 (other hosts), R7. The items below are ordered so that each prerequisite comes
BEFORE the item it unblocks. Major items come first.

### S1 — One correlated row read per host (SUBSTRATE: shared root cause of four findings; do first)

✅ **LANDED (11992908).** `correlatedFirst` (`src/compiler/rel/lower/scoped.ts`) returns one Pick the host attaches:
where every payload column is a function of one carried key (`pickKey` over the new `columnLineage` authority in
`src/rel/copies.ts`), the key is searched once and value, vtype and presence are read off it; otherwise the scalar
columns move as one substitution with a presence probe built from the same `positionKeys`/`leadingRead`. The
`positionKeys`/`leadingRead` WeakMaps and semijoin's Filter-id `narrowed` key are deleted; `dropUnreadJoins`
(`src/rel/passes/prune.ts`) drops an unread keyed pick. sql-hygiene now fails a SELECT list that spells one
correlated subquery twice; the remaining cases are banked in `scripts/sql-hygiene-respelled.json`. **Remains:**
1. Arg-min/arg-max keyed pick for min/max bodies (witnesses 1–2). The reducer (`src/compiler/rel/reducer.ts`) needs a
   form that exposes the winning row's key while keeping its eligibility, mixed-class and decimal raises. Until then
   they stay as two scalar reads (value and type tag), recorded in `scripts/sql-hygiene-respelled.json`.
2. The `priorityArms` per-arm-per-column path (out of scope; needs an arm-tagged key).
3. Other double spellings the new hygiene gate surfaced: `format()`/`concat()` reading one value twice, and
   `choose().option` arms. All are banked in `sql-hygiene-respelled.json`.
4. The `both().both()` re-source pick's super-linear 1k→8k ratio predates this item (trunk's values variant is 28×);
   it would need S2/S3-style bounded per-host work.
5. Separate finding: `group().by(id()).by(map(V().where(neq('a'))…))` still declines.

Several round-4 reviewers found the same root cause from different sides. A correlated per-host pick is emitted as
one scalar subquery PER COLUMN, plus a presence `EXISTS`, and each one re-spells the same body. That breaks the rule
that an expression is computed once:

- **M2:** `correlatedValue` → `correlatedFirst` computes value, vtype and the presence probe as three copies of one
  search (`g.V().as('a').groupCount().by(V().where(neq('a')).values('name'))`: CORRELATED SCALAR SUBQUERY 4/5/6; the
  leading-key `(SELECT s.id … ORDER BY s.id LIMIT 1)` appears three times in `map(V().where(neq('a')).out().values('name'))`).
- **M2, identity coupling:** to make those copies agree, `positionKeys` (`src/rel/position.ts`) and `leadingRead`
  are memoized in module-global WeakMaps keyed on `Rel`, and `semijoin.ts` `narrowed` is keyed by Filter id ("a copy
  of the same query block"). The cached ids come from whichever `fresh` minter asked first, so a later pass rewrite
  or a Rel reused across compiles can break this silently.
- **N5:** a body's min/max is two or three correlated scalars per host (v, vt, and in CONN mode the presence
  `EXISTS`), each re-running the whole aggregate with its own `count(DISTINCT)` temp B-tree. The old
  `correlatedReduce` did the same, so this is not a regression.

**Item:** a per-host pick yields ONE relation (a fenced per-host row, or one keyed aggregate the host joins) that the
value, the vtype and the presence read as columns. Then delete the WeakMap memos and the Filter-id `narrowed` key,
because nothing needs copies to agree any more. Measure with sql-hygiene's subquery checks: they stay green today only
because the copies sit in separate select items. Tighten the check so it sees that case. Witnesses: the three queries
above, plus `g.V().project('n','m').by('name').by(outE().values('weight').min())` and
`g.V().map(out().values('age').max()).count()`.

### S2 — The leading-scan rewrite moves to `src/rel/passes` and reuses lineage (MAJOR, placement + duplication; after S1)

✅ **LANDED (e2b515da, 01f29c3a).** The first-hit read of a correlated re-source is a physical pass over the finished
algebra, `src/rel/passes/leading.ts` (after fuse, before semijoin), recognising a Limit-1-over-rowid-Sort or a
one-column EXISTS over `reSourceCross` (`src/rel/lineage.ts`, the one predicate S3/S5 can reuse) whose seed reads an
outer row. `columnPath`/`definingPath`/`spinePath`/`columnAt` are one lineage authority in `src/rel/lineage.ts`
(replacing `traceDown`); one `conjuncts` beside `and` in `src/rel/expr.ts` (the semijoin/scoped/decorrelate copies
are gone); `copies.ts` `nestsCorrelatedSubplans` is the shared compounding guard. Plans unchanged across the L1
corpus; nested `map(V().where(neq('a')).map(V().where(neq('a'))…))` now answers; all probes ≈7–9× per 8×.
**Remains:** nothing.

M2's `leadingFirst`, `leadingRead`/`buildLeadingRead`, `elementSource`, `scanKey`, `holdSource`, `reaches`,
`traceDown`, `mapColsDeep`, `deepColsRead` and `slicesByKeys` (about 230–400 lines in
`src/compiler/rel/lower/scoped.ts`) are a physical-plan rewrite. They push Sort+fetch and conjuncts onto the leading
scan of an uncorrelated scan crossed with the seed row, and they live inside the lowering. `src/compiler/CLAUDE.md`
puts that kind of rewrite in `src/rel/passes`, next to `propertySeek`, and the comment cites Calcite's
SortJoinTransposeRule
(`vendor/calcite/core/src/main/java/org/apache/calcite/rel/rules/SortJoinTransposeRule.java`). The code also
duplicates existing authorities:
- `traceDown`/`scanKey` re-implement `semijoin.ts` `columnPath`/`definingPath` and `copies.ts` `columnIsRowKey`;
- `conjuncts` now has four definitions (`semijoin.ts` ~384, `scoped.ts` ~877 and ~942);
- `deepColsRead` sits beside `colsRead`.

The walk's hand-written spine list (project/filter/sort/inner-join left) is also too narrow: a window, an aggregate or
a nested decorrelated filter on the spine stops it.

**Item:** move it to a pass over the finished algebra, reuse the lineage helpers, and keep one `conjuncts`. Run it
after S1, which removes the identity memos this code relies on.

### S3 — One "per-host work is bounded" fact for first-row and existence hosts (MAJOR, special-case; after S1)

✅ **LANDED (7e2def6f).** `perHostWork(plan)` (`src/rel/work.ts`, a memoised sibling of `rowBounds`) reads two facts
off the LOWERED Rel: `reSources` (S2's one `reSourceCross` recogniser, widened to `seed: 'any'` and to look through
a `materialize`) and `exhausts` (a barrier or rejection over an unbounded input; `distinct` deliberately excluded,
SQLite streams it). `landValues` asks the body's correlated plan instead of the `reSourcesDeep` name test;
`correlatedExistence` reads `exhausts` instead of its node-kind list. Nothing trunk answers declines and no plan moves
(A/B over 67 compositions: identical answers and SQL); the walk-condition decline set is pinned in
`test/compiler/per-host-work.exec.test.ts`; `work:` scaling probes 6.8–8.7× per 8×. **Remains:** nothing (the
movement-head `correlatedExists` quadratic shapes stay with owner question 1, unchanged).

Two syntactic choices stand in for a cost fact:
- **M2:** `landValues` picks the correlated route with `reSourcesDeep(body)`, a name test for `V()`/`E()` at any
  depth. That makes it a (host, body-shape) branch for order/dedup/group/groupCount `by()`. A by() body that reaches
  the whole graph some other way takes the N×G landed window, and a re-source that does not read the host is routed
  correlated for no reason.
- **Q2b:** `correlatedExistence`'s bounded-work guard is a hand-written list of node kinds (aggregate/sort/window over
  an input with `rowBounds` max = ∞). It misses `distinct`, and it sits on the new route only. The older movement-head
  `correlatedExists` still runs the shapes this guard declines, at quadratic cost:
  - `emit(in().order().by('age').limit(1).has('age',gt(30)))`: 54×
  - `until(in('created').values('age').sum().is(gt(100)))`: 63×
  - `until(in('created').values('age').dedup().count().is(gt(3)))`: 54×
  - `emit(in().fold().count(local).is(gt(1)))`: 21×

  So whether a query declines or answers depends on how it is spelled (the condition's first step), not on what it
  means.

**Item:** one authority on the LOWERED Rel ("can this body's first row / existence be read per host with early stop
and bounded per-host work"), shared by map/project/where/by() and both walk-condition routes. A route this item
newly declines must not take away an answer trunk gives (end-state rule 3). Where that conflicts, see the
needs-human question on walk-until-hub below.

### S4 — `perState` only where the state key merges rows (MAJOR, regression in scoped walks)

✅ **LANDED (5b19bb55).** `perState` applies only over an uncorrelated walk (`freeRelIds(walk)` empty — an algebra
fact, not a host name), so the scoped witness is back to its pre-Q2b cost (14 → 256 ms at 130 → 1050 chains). The
until test is spelled once as the walk's EXIT column (`wx`), read by the stop test and both arms
(`src/compiler/rel/walk.ts`). ✅ **Remainder done with S6 (90d70f16):** the `freeRelIds` gate is deleted and the
scoped witnesses assert the project's 16× bound (measured about 6× per 8×).

Q2b's `perState` (`src/compiler/rel/walk.ts`) makes a query trunk already answered slower when the walk runs under a
decorrelated host. `g.V().where(repeat(out()).emit(in('created').has('age',gt(45)))).count()` went from 14.3 → 265 ms
to 30.7 → 640 ms at 130 → 1050 chains, and from 993 ms to 2356 ms at 2100 (about 2.4×).
`g.V().hasLabel('person').local(repeat(out('knows')).emit(out('created').has('lang')).count())` went from 52 to 76 ms
at 2100. Under a scoped host the state key carries the scope columns (dk/dc), so the DISTINCT, the spool and the
semi-join add cost and merge nothing.

**Item:** apply `perState` only at the root (or wherever the key really merges rows). Keep the condition per row under
a scoped host until scope-free keying (S6) exists. In the same file:
- compute the walk's exit flag once and filter both arms on that column (the until test is spelled three times when
  an emit reads adjacency, and `lp0 > 0` is repeated);
- the unbounded `until()` condition is spelled twice (term stop test and outer emit filter).

Add a scoped-host witness to `test/compiler/walk-condition-hub-scale.exec.test.ts`, plus a selective/failing
condition over a hub (`emit(union(in('created'),out('knows')).has('age',gt(45)))`). Tighten its 20× bound to the
project's ≈16×.

### S5 — Index-driven probes for a re-source compare (MAJOR, super-linear; after S2)

- **M2's existence probe** (`existenceProbe` → `leadingRead`, `LIMIT 1` with no ORDER BY) reads `nodes` through the
  covering index `nodes_gid`. gid is effectively random, so "stop at the first match" lands at a random position.
  `g.V().as('a').where(V().where(neq('a')).values('name').is('p7')).count()` takes 14.6 → 3135 ms at 1k → 8k (215×),
  while the `has('name','p7')` spelling is 2×. Drive `values(k).is(c)` after a re-source through `propertySeek`, as
  `has(k,c)` already is.
  ✅ **LANDED (f59b6ece).** Semi-join reduction in `src/rel/passes/leading.ts`: a re-source's candidates are narrowed
  by a filter whose columns are spelled over one owner-joined property scan, so `values(k).is(c)` seeks like
  `has(k,c)` (no rewrite into `has`, which would differ under list cardinality; a property row joined to a hop
  declines). Measured: the `is('zzz')` miss went 767 ms at 1k → 3.2 s at 2k to 0.53 ms at 1k → 4.2 ms at 8k
  (`scripts/scaling-probe.ts`; `test/leading-owner-seek.test.ts`). **Remains:** nothing.
- **The correlated equality `by()` compare** (`where(V().where(eq('a')).by('name').where(neq('a')))`, a duplicate-name
  finder): 1.16 s → 79 s at 1k → 8k (68×). It was newly reachable with M2; the `coalesce`/`optional` spellings were
  already on trunk at the same cost. The `vp_key_value` index could answer it in N log N. Whether to build this is an
  owner question (below).

### N3 remainder — gated on S6a (prerequisite, ordered first)

✅ **S6a + N3 remainder LANDED (fac4c754).** `fuse` (`src/rel/passes/fuse.ts`) normalises an Aggregate over
`(Filter | inner Join)* → Join(cross)` by pushing each side-local Filter and inner Join below the cross (Calcite's
FilterJoinRule / JoinPushThroughJoinRule), so AggregateJoinTransposeRule now reaches the hop or predicate after a
re-source; `groupedOn` looks through renames and factored aggregates mint `ajt*` ids (both cheap follow-ups done).
Measured 1k → 8k: `by(V().values('age').sum())` 9.4 → 70.4 ms (7.5×), `by(V().out().count())` 6.5 → 48.1 ms (7.4×),
`by(V().has('age',gt(30)).count())` 6.7 → 53.2 ms (7.9×). **Remains:** `g.V().group().by('name').by(V().values('age')
.max()/min()/mean())` is still not factored — `max`/`min` lower as `arg_max`/`arg_min` (they carry the value's type
tag) and `mean`'s reducer is one `factor` cannot split. The probes found no shape that normalisation turned into a
wrong answer. A `group().by(...)` whose value by() holds `coin()`/`sample()` is declined before this pass; that decline
predates this change.

Witness 4 `g.V().group().by('name').by(V().values('age').sum())` (1.5 s → 89 s) and the name-keyed
`by(V().out().count())` / `by(V().has('age',gt(30)).count())` are still quadratic, the same as on trunk. In the
weighted pool the cross is at `V()`, and the hops and filters stack ABOVE it, so no Aggregate sits directly over the
cross join and `fuse`'s AggregateJoinTransposeRule never fires.

- **S6a (prerequisite) — push a side-local Filter and an inner Join below a cross join in `fuse`**, carrying columns
  through the intermediate projections. This is Calcite's FilterJoinRule and JoinPushThroughJoinRule
  (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/rules/FilterJoinRule.java`,
  `.../JoinPushThroughJoinRule.java`). Prefer it to the alternative of a bulk-carrying prefix in `reSourcedBody`: it
  is algebra, it lives in the seam the rule already lives in, and it adds no lowering special case. With S6a in place,
  the N3 factoring reaches these shapes unchanged.
- Cheap, same file: `groupedOn` should look through a column-renaming Project. Today
  `g.V().both().group().by('name').by(V().count())` re-groups an already-grouped pool side and adds an unused
  `count(1)`. Calcite uses a unique side as it is, with count 1. Also give the factored aggregates a mint hint
  distinct from their column names (`fa0.fa2 * fa2.fa1`).

### S6 — Scope-free subterm: a decorrelator rule (prerequisite for walk conditions under a host)

✅ **LANDED (90d70f16, 9a4d34ee).** `existenceOverOwnRows` (`src/rel/decorrelate.ts`): a Semi/Anti join whose right
side is a ROW-WISE image of its own left (project/filter/distinct/materialize only, joined on paired columns, no outer
read) is rebuilt over the keyed left with no scope-key equality, so the condition is asked once per distinct state
ACROSS scopes. S4's `freeRelIds` gate in `walk.ts` is deleted; the scoped walk-condition witnesses went from 17× to 6×
per 8× (`test/compiler/walk-condition-hub-scale.exec.test.ts`; refusals pinned in
`test/compiler/decorrelate-self-semijoin.test.ts`). The R6 rejoin is gone too: `decorrelateAll` takes `carry` and
exposes each answer's `domain`, so `scopedSite` reads the host encounter off the domain (the scope CTE is read once).
**Remains:** Witness 2, `local(out().out().where(in().has(..)).count())`, is still super-linear (about 16–19× per
8×). It is a per-row correlated EXISTS over a hub's in-neighbourhood with no self-semijoin, so this rule does not
reach it. It needs its own item: T3 (after round 5).

Q2b's remaining **scope-free-subterm** (`docs/outstanding-work.md` §1b): a filtering condition under
`where`/`local`/`map` is keyed per scope by the decorrelator, which costs 16–23× at a hub. That holds connector-wide on
trunk (`where(out().out().where(in().has(..)))`), and Q2b's new non-movement heads reach it at depth. **Item:** one
rule in `src/rel/decorrelate.ts` that leaves a membership test of a scope-independent fact unkeyed. S4's per-row
fallback becomes unnecessary once this lands. The R6 rejoin finding is the same family: `scopedSite` re-joins the
keyed site to a projection of `outer` to get the host encounter, but the domain already carries it. Carry `hostEnc`
in the domain.

### K5 — The decline signal: a host records its own decline (minor x4, one item; replaces the position watermark)

✅ **LANDED (38fe5827, with P19).** A connector host that declines before handing its stream on records that itself
(`Declines.hostDeclined`, in `scopedHost`, `src/compiler/rel/lower/scoped.ts`), and `lowerChain` names a child write
only where its top-level host recorded it; the record reaches the compile only through the fork sink's `adopt`, so
route order cannot change the message. `Declines.#furthest`/`reach`/`furthest` are deleted. The write reason now
displaces the effect-in-child advisory, and a keyed `group('x')` with a reducing `by()` in a child gets the advisory
where `registerGrouping` refuses. Remains: nothing.

K1's `Declines.furthest` advances only in `continueAs`, so whether a write hint is certain or hedged depends on
routing, not on where the decline is:
- `sideEffect(property(...))`, `sideEffect(drop())` and `repeat(addV(...)).times(2)` became "may not be supported
  here", which is vaguer than trunk;
- `g.V().hasLabel('software').union(drop())` lost the hint entirely, because `afterWrite` (`write.ts` ~1346) advanced
  furthest past the union;
- `…union(addV('x')).values('name').order()` and `coalesce(out(), addV('x')).order().by('name')` still blame the
  write, although `union(addV('x')).values('name')` answers.

**Item:** a write host records its own decline, instead of reading a position watermark. Also in this item:
- R6.0's advisory overrides a write reason. `g.V().sideEffect(out().aggregate('x').property('k',1)).cap('x')` now
  points at a cap/select the user never wrote. Let the write reason win (skip the `effectInChild` note when
  `keyedInFork` returned null on `lowered.effects?.length`).
- The R6.0 hint never fires when `registerGrouping` returns false before a site is pending:
  `sideEffect(out().group('x').by('name').by(count()))` and `…by(values('age').sum())` say only "no lowering covers".
  Note the advisory there too.

### Cheap, concrete follow-ups (round 4)

- ✅ **R6 — `P.not(within('x'))` → `without('x')` — LANDED (3537cd84).** `membershipOf(pred)`
  (`src/compiler/ir/step.ts`) is the one decode of a `where(P)` membership test: it peels every `not` (flipping
  polarity) down to a single-key within/without, and both `labels.ts` `isMembershipWhere` and `filter.ts`
  `collectionMembership` read it. L3 +1 (`g_VX1X_out_aggregateXxX_out_whereXnotXwithinXaXXX`). Remains: nothing
  for this item (`g_V_classic_recommendation` still declines on its own `group-side-effect` blocker, ledgered).
- ✅ **R6 — compute the membership key once — LANDED (3537cd84).** `scalarMembership` projects the member tag
  `coalesce(tag, inferredVtype(v))` once as a column under the key set; scaling 1k→8k ≈ 7.7–9.0×. Remains: nothing.
- **N5 — root min/max re-inlines the per-row value CASE** (`CASE WHEN vtype IN ('list','map','set') THEN json(value)
  …`) into the compare key, the bare value and the class. Project it once below the Aggregate.
- **Q2a — one `loopCountPredicate(test): P | null`** in `src/compiler/ir/strategies.ts`, shared by `emitLevelTest`
  and `loopCountUntilAsTimes`.
- **P12 — pin the drop-vs-keep classes.** `coalesce(map(identity()).out('created')).path()` drops the inner position
  CORRECTLY: `CoalesceStep extends FlatMapStep`
  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/CoalesceStep.java:38`),
  and `SimplePath.feature:80` adds one position. Add tests in `test/compiler/tree-step.exec.test.ts`:
  map/flatMap/coalesce drop the inner positions (`map(out('knows').map(identity())).tree()` → `{marko:{vadas}}`);
  `local(map(identity()).out('knows')).tree()` keeps them. Without these, a later item may "fix" it into a wrong
  answer. Do NOT record it as outstanding work.
- **P12 (optional)** — typing a kept identity-body host as its input's kind would remove the 3-way `CASE` that
  `tree().by(id)`/`path()` emit after `map(identity())` (linear today).
- **M2 scaling witnesses** in `scripts/scaling-probe.ts`: a hop (`map(V().where(neq('a')).out().values('name'))`), a
  limit, a sparse filter, `project('n').by(V().where(neq('a')).values('name'))`, `hasLabel`, `id()`/`label()`,
  `not(where(...))`, `E()`, an eq-by-key miss, and `values(k).is(c)`. The current witnesses all hit the first vertex
  scanned, so they cannot see S5.

### N8 additions (round 4 depth gaps; clean declines today; a body or host row, never a rung)

- **M2:** `map(V().where(neq('a')).out().id())` declines while `…out().values('name')` answers (also
  `both().both().id()`, `E().where(outV().where(neq('a'))).inV().id()`, `limit(3).out().id()`, under map and
  `project().by`). Likely `id()`'s computed payload after a hop trips `correlatedFirst`'s two-column/subquery rule.
  This shares a root with S1. Also still declined: an `order()` in the rest (`map(V().where(lt('a')).by('age').order()…)`),
  `addE(…).to(V()…where(lt('a')))`, `group().by('name').by(map(V().where(neq('a'))…))`, a `choose(V()…where(neq('a')), …)`
  predicate (the message says "inside map(), by() or a filter"; name `choose()`), `repeat(V().has('age').where(gt('a')).by('age')).times(1)`
  and `map(V().where(neq('a')).sample(1))`. The last two say only "no lowering covers"; give them a reason.
- **R6:** `coalesce(out().aggregate('x'), constant(1)).cap('x')` (a constant arm beside a collecting arm);
  `sideEffect(out().group('x').by(k).by(<reducing>))`; `sideEffect(out().fold().aggregate('x'))`;
  `sideEffect(properties('name').aggregate('x'))`; a non-empty seed `withSideEffect('x',[1,2])`; membership over a
  SEEDED collection (`where(without('a'))` after `withSideEffect('a',['marko'])`); `project('n').by(out().aggregate('x').count()).cap('x')`.
- **Q2a/Q2b:** a label bound in the repeat body and read by the condition or after it
  (`repeat(out().as('x')).emit(select('x')…)`); `loops()` inside a coalesce/union condition arm (the `sameChannels`
  branch-merge limit); a `select('a')` in a walk condition (`walk.ts` does not pass the alias map to
  `child.predicate`); a `path()` read inside a walk condition answers only when the outer chain also tracks path (the
  condition's own `path()` should turn tracking on).
- **K1:** a write after a path-tracked `repeat`/`where(simplePath())` (now explained by `write-on-path`).

### Next round — reuse sweep (round 4's proposals)

- **P16 — `min(local)`/`max(local)` reuse N5's arg-extremum Aggregate.** Pull the global reducer's Aggregate
  (`lower.ts` ~2620–2645) out into one builder and call it from `src/compiler/rel/list.ts` `listReduce` over `members`,
  with `memberCompareKey` as the key. That deletes the Sort+Limit/JSON-pair/fence block (~55 lines) and
  `predicate.ts` `mixedClassesRefused` (its only caller). Measured: `local(out().values('age').fold().max(local))` is
  17,101 B and 12.2/97.2 ms; the arg-extremum spelling is 7,883 B and 4.4/37.1 ms. A tie between two spellings (1 vs
  1.0) then goes to SQLite: widen N5's §17 line to cover `local`, and say so in the commit.
- **P17 — `firstArrival` → `arg_min(value, order)`** (`src/compiler/rel/build.ts`; callers `lower/slice.ts` ~491,
  `lower/scoped.ts` ~2499, `map.ts` ~142). This removes the per-row `printf('%020d…')` packing and keeps the winner's
  storage class (the packed form is always TEXT, while the pooled-group KEY is declared `int`). In `slice.ts` the
  plain `MIN(encounter)` becomes `arg_min(enc, enc)`, or `checkArgExtremumLaw` allows a plain MIN identical to the
  anchor.
- **P18 — dedup-first windows → one Aggregate of `arg_min` per carried column.** Targets: `map.ts`
  `dedupGroupMembers` and the `list.ts` `dedup(local)` arm (~505). Both use ROW_NUMBER only because "an Aggregate
  cannot give the value of the row with MIN(mo)", which arg_min now does. This also moves them onto decorrelate's
  Aggregate rule. `slice.ts` `dedupOn`/`dedupOnTyped` are not candidates (multi-key order).
- ✅ **LANDED with K5 (38fe5827)** — one `pathCarried → writeOnPath` check at the top of `elementTail`'s loop; the
  scalar tail keeps its single check (hoisting it would blame the path for scalar `property()`/`drop()`). Remains:
  nothing. **P19 — Hoist the path-tracked write decline.** Use one
  `if (MUTATING_STEPS.has(step.name) && pathCarried(rel)) return writeOnPath(step, ctx)` at the top of `elementTail`'s
  loop (`lower.ts` ~5755–5859) and at the scalar-tail site (~2802). It replaces 6 repeated lines, and a new write step
  is covered automatically. Do it with K5.
- **P20 — One keyed-collector predicate.** `labels.ts` `KEYED_SIDE_EFFECT_WRITERS` and `step.ts` `KEYED_REDUCERS` are
  the same set with the same string-arg test. Export one `isKeyedCollector(step)`. Also spell `write.ts` ~881
  `LABEL_READING_STEPS` as `PATH_READERS` ∪ {select, match, cap, sack}. Membership is unchanged.

### Needs-human questions (round 4)

1. **(Q2b builder, verbatim:)** "walk-until-hub: the movement-head until, e.g. `until(in('created').has(..))`, is
   22.8x. It already runs this way on trunk, so declining it would take away answers trunk gives; that is your call."
   (The alternative is a per-distinct-element evaluation inside the recursion, e.g. a reachability pre-pass. S3
   needs this answer before it may decline anything the movement-head route answers today.)
2. **(M2 reviewer, verbatim:)** "Flagged for the owner: either accept it under the xNG rule, or treat a correlated
   equality by() compare as a propertySeek term." (Witness: `g.V().as('a').where(V().where(eq('a')).by('name').where(neq('a'))).values('name')`,
   1.16 s → 79 s at 1k → 8k. The reference's `TraversalFilterStep` also scans the graph per host when there is no
   match. An index answers it in N log N. This decides S5's second bullet.)

## Next round (written 2026-11-17, after round 5)

Round 5 landed S1 (11992908), R6's two cheap follow-ups (3537cd84), K5 + P19 (38fe5827), S4 (5b19bb55), S6
(90d70f16, 9a4d34ee), S2 (e2b515da, 01f29c3a), S3 (7e2def6f) and S5's first bullet (f59b6ece). Every round-5 branch
landed, so no branch is parked as a resume point. Not built this round: **S6a** (the N3 remainder's prerequisite,
above) — since LANDED (fac4c754). Still open from earlier rounds: M1b (behind H1), M6, N8,
N9, K2, K3, K4, P2, P5, P6, P8, P9, P11, P13, P14, P16–P18, P20, R4.2, R4.5, R5.2–R5.4, R6 (other hosts), R7, S5's
second bullet (owner question 2, round 4), and the round-4 cheap follow-ups (N5 root CASE, Q2a, P12 pins, M2 probe
witnesses). Ordered so that each prerequisite comes BEFORE the item it unblocks; major items first.

### T1 — The walk's EXIT column is not payload (MAJOR — REGRESSION from S4, do first)

✅ **LANDED (6e6e45ca, 6b6619f6, 1274c293).** `emits` (`src/compiler/rel/walk.ts`) asks a finished-walk emit condition
of `traverserView(rel)` — the term's existing `wt` projection, extracted (id + carried channels) — and retargets it onto
the walk with `substRelId`, so `payloadCols` and `correlatedExistence`'s guard stay the ONE authority and `wx` is never
seen as payload; until+emit(local/union/coalesce/choose) answers again at the root and under where/local/map/not
(`test/compiler/walk-exit-not-payload.exec.test.ts`). Follow-ons found on the way: every walk condition is now handed
the walk's `aliases` (a label minted inside an until/emit no longer reaches `channel column 'a0' is already carried`;
`bindAliases` declines a new label over a carried column), and the `edgePair` physical pass
(`src/rel/passes/edge-pair.ts`) reads an edge pinned at both endpoints through all three index columns, so the
newly reachable adjacency-to-a-label conditions scale 5–8× per 8× rather than 24–45×. Remains: nothing.

S4 (5b19bb55) added the `EXIT` column `wx` to the walk relation (`src/compiler/rel/walk.ts`). It is neither a carried
channel nor payload, but `payloadCols` (`src/compiler/rel/build.ts` ~82) counts every non-channel column as payload.
`emits(walk)`/`leaves(walk)` ask the emit condition with the walk itself as subject, and `correlatedExistence`
(`src/compiler/rel/lower/scoped.ts`) needs `payload = [id]`, sees two columns and returns null. The same subject check
guards `local`'s first-row pick. Result: a walk with an `until` AND an `emit` whose condition uses the correlated
fallback (`local`/`union`/`coalesce`/`choose`) now DECLINES where 1c8653e7 answered — in every modulator position, at
the root and under a host. Re-measured on trunk (dc811656):
`g.V().repeat(out()).until(hasLabel('software')).emit(local(in().limit(1))).values('name')` and
`…emit(coalesce(in('created').has('age',gt(30)),out('nope')))` decline; the same `emit(local(…))` without `until`
answers. The corpus has no until+emit(local/union/coalesce/choose) scenario, which is why CI stayed green.
**Item:** ask emit conditions over a traverser-only projection of the walk (as the term already does with `wt`), or
carry EXIT so `payloadCols` does not count it — prefer whichever keeps ONE authority on "what is payload". Add an
exec test for until+emit(local/union/coalesce/choose) at the root, under `where`, and under `local`.

### T2 — Fence the walk in `perState` (MAJOR — compute-once rule; S6 widened its reach)

`perState` reads the walk relation twice: in the DISTINCT that builds the passing set (fenced) and in the semi-join it
filters (not fenced), so SQLite runs the recursive CO-ROUTINE twice (EXPLAIN plan ids 110 and 214 for
`g.V().hasLabel('person').where(repeat(out('knows')).emit(in('knows').has('age',gt(40)))).count()`). It was already so
at the root; S6 deleted S4's gate, so it now runs under every scoping host: non-hub scoped walks are 1.2–2.1× slower
in absolute time (still linear; e.g. `where(repeat(out('knows')).emit(…))` 61.6 ms vs 29.4 ms at 1,050 chains).
Fencing the CTE by hand gave identical answers and 34.5 → 24.4 ms. **Item:** fence the walk in `perState`
(`MATERIALIZED` / a materialize node), which also helps the root route; and say in `walk.ts` that per-state costs a
constant factor where no state is shared. Cheap, same item: `sql-hygiene` checks a subquery evaluated twice per row
but not a CTE inlined twice per query — teach it that, so the next one is a gate failure, not a review finding.

✅ **LANDED (ec2db3de).** `fenced` (`src/rel/passes/name.ts`) renders a shared, bound relation `AS MATERIALIZED` when it
draws OR when `copyRerunsBarrier` (`src/rel/copies.ts`, the flattener model minus the computed-column half) says a
flattenable top would re-run a walk or barrier per reader — so `perState`'s two reads (and every other such shared CTE)
run the walk once (witness 58.7 → 38.8 ms at 8k). `sql-hygiene` now fails any WITH-defined CTE that EXPLAIN lists as
CO-ROUTINE/MATERIALIZE more than once per statement (`test/support/cte-runs.ts`); corpus at zero. `walk.ts` documents
per-state's constant factor. Remains: nothing.

### T3 — One correlated EXISTS per owner scan; per-row correlated EXISTS at a hub (MAJOR, super-linear, common reach)

Three findings share one root: a correlated EXISTS evaluated per candidate per host, with no rewrite to a
once-per-statement set.
- **S6's witness 2**, `g.V().local(out().out().where(in().has('age',gt(45))).count()).sum()`: 7.2 → 142.5 ms at 130 →
  1,050 hub chains (19.8×; trunk 21×). The condition never forms a self-semijoin, so `existenceOverOwnRows` does not
  reach it. Common reach.
- **S5a, multi-conjunct `is()`:** `leadingRead` calls `ownerJoined` once per spine conjunct, so
  `values('name').is(containing('zz'))` becomes three EXISTS (type guard, `like`, `instr`). Only the type guard is
  lifted into the `vp_key_value` IN, and it narrows nothing: 757 ms → 50 s at 1k → 8k (66×); `endingWith` 89×;
  `startingWith` 645 ms → 2.6 s at 1k → 2k. Pre-existing (parent was already quadratic). Each EXISTS also re-spells
  the CASE/json value expression.
- **S2's boundary:** correlated re-sources outside the one-row-seed shape stay N×G —
  `hasLabel('person').property('best', V().has('name','p5').values('name'))` (json_each snapshot × nodes before the
  `has()` EXISTS; 742 ms → 11.5 s at 1k → 4k) and `as('a').optional(V().where(neq('a')).has('name','p3'))` /
  `coalesce(…)` / `local(V().where(neq('a')).out().limit(1))` / `map(E().where(outV().where(eq('a'))))` over a
  root-level decorrelated CROSS on an unindexed CTE (~400 ms → 1.6 s at 1k → 2k).
**Item, in order:** (a) in `src/rel/passes/leading.ts`, group the conjuncts that resolve to the same owner-joined
property scan into ONE EXISTS, so the IN subquery carries the `like`/`instr` test (cheap, concrete); (b) one
`src/rel/decorrelate.ts` rule (or an S2-style physical pass) that turns a correlated EXISTS whose right side reads the
outer row only through an equality on an indexed column into a once-per-statement semi-join — witness 2 and the S2
boundary shapes are its tests. (b) needs a design pass before building; say if it is a new node rule or an extension
of `existenceOverOwnRows`.

✅ **T3(a) LANDED (614a69e4, 6b1457dd, 4231ed52).** `leading.ts` splits `ownerJoined` into `ownerScan` + `ownerProbe`:
every spine conjunct over one owner-joined property row becomes ONE `EXISTS`, holding the place of its first conjunct,
so the seek lifts the whole TextP conjunction (`values('name').is(containing('zz'))` after a re-source in `where()`:
646 ms → 43.9 s @1k→8k before, 6 → 10 ms now). `narrowFilter` (`src/rel/passes/semijoin.ts`) now narrows by the
INTERSECTION of every self-contained seek on the element (`allOwners`, one uncorrelated IN per statement) instead of
ranking one, and a stack of Filters joins its lowest Filter's intersection (`ElementFacts.above`); all witnesses
linear 1k→8k (`test/leading-owner-seek.test.ts`). No baseline moved. **Remains:** (b), and two quadratic re-source
shapes left for follow-up items because each needs different substrate: the leading candidate filter cannot see an
owner conjunct inside a nested `where(values(k).is(c))` (T4's lowering fix is its natural home); and the decorrelated
`flatMap(V().where(neq('a'))…)` cross-joins a materialized nodes CTE that no seek can narrow (part of (b)'s design).

✅ **T3(b) LANDED IN PART (7971f932) — the read-in-full bodies.** A physical pass, `magic` (`src/rel/passes/magic.ts`, between
`leading` and `semijoin`): a Filter conjunct `[NOT] EXISTS B(x)` inside a correlated body, `B` reading one never-NULL
column `x` of the Filter's input and nothing else, becomes a semi/anti-join on `x` to the passing set of the MAGIC
SET — the distinct `x` over the Filter's input for every host row, decorrelated by `decorrelate` (the domain is the
host's rows, so a point query stays a point query), the test asked once each, fenced. `semiJoinPerDistinct`
(`src/rel/decorrelate.ts`) is the one builder for that form; `perState` (`src/compiler/rel/walk.ts`) now uses it
too. Guards: the host rows self-contained (nested hosts reach theirs through the enclosing host's), nothing draws
(so `owns: () => false` is sound), one host column read. Measured on the hub graph (130 → 1050 chains):
`local(out().out().where(in().has('age',gt(50))).count()).sum()` 13.1 → 526 ms (40×) before, 8.8 → 25.5 ms (2.9×)
now; `map(…)`, `local(local(…))`, `local(…not(…)…)`, `local(union(…))`, `dedup()` before the test all 16–20× → 3–5×.
Uniform out-degree 4 graph, 1k → 8k: the hub-shaped witnesses got faster (`local(…gt(50)…)` 145 → 75 ms), but NOT
every rewritten form — a selective host or a one-seek test got 1.3–2× slower, still linear (review correction; U2 below);
out-degree 20: 3.3 s → 1.2 s. Point query `g.V(21).local(…)` unchanged (~3 ms at both sizes). Witnesses in
`test/compiler/walk-condition-hub-scale.exec.test.ts`.
**Remains: witness 2, the existence body (`where(...)`, `filter(...)`, a first-row `map`; `g.V().where(out().out().where(in().has(…)))`), still about 48× at a hub.**
The pass fires only where every row of the domain is work the plan does anyway (`demanded`: under an aggregate,
sort, window or ≤1 row, up to the plan root). An EXISTS body stops at its first passing row, and built there the
domain cost `g.V().where(out().out().where(in().has('age',gt(20)))).count()` 10.6 → 505 ms at 8k on the
out-degree-20 graph (48× slower), `gt(50)` 16 → 509 ms. With no statistics neither form dominates — owner call
(`docs/outstanding-work.md`). The S2-boundary shapes stay with S6a, as the review moved them.

### T4 — `where(is(c))` / `filter(is(c))` over a value lowers like `is(c)` (minor, depth gap next to S5a's witness)

`V().where(neq('a')).values('age').where(is(99))` and `.filter(is(99))` do not get S5a's narrowing and are roughly
CUBIC: 8.5 s at N=250, 73 s at N=500 (same on parent). The fix belongs in the lowering — `where(is())`/`filter(is())`
over a value traverser should produce the same spine filter as `is()`, so `ownerJoined` sees one conjunct. Not a new
`leading.ts` case. After T3(a).

### T5 — The keyed-group advisory is raised where the connector body declines (minor, explain-don't-baffle)

K5's advisory for `g.V().sideEffect(out().group('x').by('name').by(count())).cap('x')` (also `local(...)`,
`by(values('age').sum())`) exists only on the ladder route; connector-only mode gives a bare "no lowering covers".
When the ladder retires (R7) the hint disappears with no test noticing. **Item:** note it where the connector body
declines (`keyedBody`), and pin the message under connector-only mode in `test/compiler/existence-prefix.exec.test.ts`.

✅ **LANDED (846f4e35).** `keyedBody` (`src/compiler/rel/lower/scoped.ts`) is now the ONE raiser: the group connector
row records a pooled keyed `group('x')` as a fork refusal (`refuseSite`, `src/compiler/rel/collection.ts`), and the
declining body names it with the pooling step the user wrote; the `lower.ts` raiser is deleted. Pinned under
connector-only mode in `test/compiler/existence-prefix.exec.test.ts`. Message only, no baseline moved. Remains: nothing.

### T6 — S3's trial lowering compounds compile time with nesting (minor, compile time only)

`correlatedReSources` runs a full throw-away `correlatedBody` lowering for every non-rooted landed `by()` body (trunk
did so only for bodies naming `V()`/`E()`), and nested bodies recurse, so the per-level multiplier went ~5× → ~7×:
`g.V().group().by(local(out().order().by(in().count()).limit(1)).values('name')).by(count())` 30.0 → 46.8 ms; a
synthetic depth-4 nest 7.1 → 26.5 s. Not data-dependent. **Item:** memoise the trial per body key and minter scope, or
reuse the trial's tail when it says re-source, so the cost fact adds no second lowering per level. Also fork
`ctx.declines` (and roll back `budget.noteUnroll`) around the trial, so a thrown-away trial cannot leave a reason.

✅ **LANDED (d4aebac4).** `landValues` (`src/compiler/rel/lower/scoped.ts`) runs the `correlatedReSources` trial only
when the body names a `V()`/`E()` at any depth (`reSource`, `movement.ts`, is the re-source cross's one producer);
where the trial says yes its tail IS the correlated read, never lowered twice; a "no" restores collections, site
effects, the unroll note (`CompileBudget.restoreUnroll`) and its decline reasons (forked sink). Depth 1/2/3 witness
48/283/1921 → 40/152/679 ms; no baseline moved.

**Remains:** the reviewer's target ("depth 2 compile time no more than about 2× depth 1") is not met: it is 3.8×. The
trial is no longer the cause; other repeated lowerings are, and they are outside this item's seam. Counts of
`landValues` calls at depths 1/2/3 are 1/3/13; with `lowerBody`'s retry switched off they are 1/2/5.
- `lowerBody` (`scoped.ts`) lowers an order='read' body once unpositioned, then lowers it again from a positioned seed
  when the result may have several rows and carries no position. That doubles the work at each 'read' level.
- The remaining growth comes from host routes that try one lowering and then fall back to another, such as `local`'s
  correlated route followed by the keyed route.

Follow-up item: decide `positioned` before lowering instead of retrying. That would change some plans, so it needs a
census and sql-hygiene review.

### T7 — S1 remainders (after P16–P18; shared root with them)

- **Arg-min/arg-max keyed pick for a min/max body.** S1's witnesses 1–2 keep two scalar reads (value, type tag),
  banked in `scripts/sql-hygiene-respelled.json`. The reducer (`src/compiler/rel/reducer.ts`) must expose the winning
  row's key while keeping its eligibility, mixed-class and decimal raises. This is the SAME substrate as P16
  (`min/max(local)` on N5's arg-extremum Aggregate), P17 (`firstArrival` → `arg_min`) and P18 (dedup-first windows →
  `arg_min`): **one arg-extremum Aggregate builder** pulled out of `lower.ts` ~2620–2645. Build P16 first (it extracts
  the builder), then this.

✅ **P16 + the keyed pick LANDED (97b6e161, c93e6a1c).** One arg-extremum Aggregate builder, `argExtremum`
(`src/compiler/rel/reducer.ts`), serves the global min/max reducer and `min(local)`/`max(local)`; a per-host pick of a
min/max body threads the winning row's rowid (`threadingRowKey`, `src/rel/copies.ts`) and `keyedPick`
(`lower/scoped.ts`) searches for that key once, reading value and tag back by a rowid join. `map(out().values('age').max())`
6,129 → 1,980 B, 7.4/75.3 → 2.4/19.1 ms at 1k/8k.

**Remains:** the plan's 7,883 B target for `local(out().values('age').fold().max(local))` was not reached: it is now
12,097 B (was 17,101 B). The remaining cost is the connector's `correlatedFirst`, which still reads a list-valued body's
`v` and `vt` as two scalars plus a presence check. The keyed pick only applies when the winner is a stored row, and a
list member is not one. Reading two columns of a per-host relation once would need either decorrelating such bodies or
a LATERAL-like way to attach a relation per host. Neither exists, so the list form keeps its pair-and-fence and the
fence was not deleted.
- **Other double spellings the new hygiene gate banked:** `format()`/`concat()` reading one value twice and
  `choose()`/`branch()` option arms (priorityArms, needs an arm-tagged key). Each entry leaving
  `sql-hygiene-respelled.json` is the measure.
- **`group().by(id()).by(map(V().where(neq('a'))…))`** still declines (separate finding; joins N8).
- **`scalarPick`'s synthetic `{kind:'call', fn:'pick'}` node** (`scoped.ts`) exists only so one `substRelId` moves
  several expressions; replace it with a helper that moves an expression list, so a fake SQL function can never reach
  the emitter. `abstractOver` compares by `JSON.stringify` of every subexpression including nested subplans
  (compile-time quadratic in body size) — compare structurally or by id.
- **Scaling-probe graph:** use a reference vertex whose degree is held fixed, so a `both().both()` pick's 1k→8k ratio
  reads per host (S1 measured 26× raw, flat per pick).

### N8 additions (round 5 depth gaps; clean declines today; a body or host row, never a rung)

- **S1/S2:** `map(V().where(neq('a')).bothE().otherV().id())`; `map(V().where(neq('a')).order().by('name').values('name'))`
  and `…outE().order().by('weight',desc).inV().id()`; `map(V().where(neq('a')).out().id()).as('b').select('a','b')`;
  `hasLabel('software').coalesce(V().has('name','p7'),constant('none'))`; `as('a').choose(V().where(neq('a')).has('age',30),…)`;
  `addE('next').to(V().where(neq('a')).has('age',30))` and `from(V().where(neq('a')).where(eq('a')).by('age'))`;
  `as('a').map(V().where(neq('a')).values('name').is('marko')).values('name')` (the `count()` form answers).
- **Trunk declines next to S1's witnesses, common idiom first:** `g.V().project('n').by(out().values('name')).aggregate('x').cap('x')`;
  `group('m')`/`groupCount('m')` after a `project().by()`; `g.V().group().by('name').by(map(out().id()))`.
- **R6:** membership followed by `path()` (`…aggregate('x').out().where(P.not(within('x'))).path().by('name')`,
  same as the `without` form); membership over a SEEDED side effect (`withSideEffect('x',['lop','josh'])…where(P.not(within('x')))`);
  the startKey form `where('a', P.not(within('x')))`; membership over a PATH LABEL (`as('x').both().where(within('x'))`,
  `without`, `P.not(within)` — uniform; `neq('x')` answers); `.and()` of two memberships; an aggregate read inside its
  own repeat body.
- **S6:** an emit condition reading a label bound before or inside the walk under a scoping host
  (`local(__.as('s').repeat(out()).emit(in('created').where(neq('s'))).count())`, `…repeat(out().as('x'))…select('x')`,
  and unscoped `as('s').repeat(out()).emit(…where(neq('s')))`) — blocked before S6's rule, joins Q2a/Q2b's label item.
- **S5a (narrowing does not fire, answers correct):** reducing bodies (`map(…values('age').is(gt(30)).fold())`,
  `project().by(…is(…).count())`, `order().by(…count())`) and coalesce/optional/flatMap/choose hosts.

### Next round — reuse sweep (round 5's proposals)

**One column-lineage authority (SUBSTRATE: the shared root of five review findings and five proposals; do as one
item, in this order).** S1 added `columnLineage` (`src/rel/copies.ts`) and S2 added `definingPath`/`columnAt`
(`src/rel/lineage.ts`); private walkers still answer "which column below defines this one":

✅ **P21–P24 LANDED (53e8f1b2).** One positional join-side mapper (`joinSide`, `src/rel/walk.ts`) serves
`columnLineage`/`constantOver`/`columnIsStored`/`columnIsRowKey`; `definingPath` (`src/rel/lineage.ts`) passes through
`limit`/`distinct`/`materialize`; `leading.ts` and `priorityArms.constantIn` ask `columnLineage`; semijoin's leaf
questions go through one `rowidScan` in lineage.ts. Hand-built same-name joins: `test/rel-lineage.test.ts`.
**Remains:** `g.V().group().by('name').by(V().values('age').sum())` is quadratic at production size (66× from 1k to 8k
vertices) — its own item, starting by checking whether fuse `factor` fires for a sum over the property-join side.
Measured with `.count(local)` appended; the scaling probe's own `ajt` entry (no `.count(local)`) was stopped before it
finished, so that the unmodified entry is also quadratic is unconfirmed. Separately,
`g.V().project('a').by(choose(values('age')).option(between(20,40),constant('young')).option(none,constant('old'))).count()`
gives a clean UnsupportedTraversal, both before and after this change.
- **P21 — one positional join-side mapper** `joinSide(r, name)` in `src/rel/walk.ts` or `copies.ts`, replacing the
  4-line block written 5× (`columnIsStored`, `columnIsRowKey`, `columnLineage`, `constantOver`,
  `priorityArms.constantIn`). Fixes `definingPath`'s by-NAME join case, which gives up when both sides carry the name
  and would silently drop a leading key to the N×G whole-cross sort (latent today; names are minted distinct). Do first.
- **P22 — `definingPath` passes through `limit`/`distinct`/`materialize`** (identity-preserving, as the other walkers
  already are); delete `reSourceCross`'s materialize loop and `decorrelate.ts` `existenceOverOwnRows`' private
  `carried`. Check: S2's byte-identity sweep over the L1 corpus.
- **P23 — `leading.ts` `definingSeed` + `inSeed` → `columnLineage`** (reject if a leaf is the seed's own relation or
  the result has a subquery).
- **P24 — `priorityArms.constantIn` → two `columnLineage` calls** (~25 lines). Strictly safer at a LEFT join's right
  side; check with the choose()/branch() priority tests and the respelled baseline.
- `semijoin.ts` `columnPath` folds into the same authority.

**Small helpers, one home each:**
- **P25 — `conjoin` everywhere** (`src/rel/expr.ts`, beside S2's `conjuncts`): delete `semijoin.ts` `andAll` and the
  19 hand-written `.reduce((a,b) => and(a,b))` folds (leading.ts, decorrelate.ts, scoped.ts, slice.ts, map.ts,
  lower.ts, write.ts — a seeded `eq(1,1)` becomes `conjoin(xs) ?? always`). Emitted SQL identical but for grouping.
- **P26 — one memoised "is this relation id defined inside this plan"** in `src/rel/walk.ts` (export `definesId` or a
  `definedRelIds` nodeFact) for `scoped.ts` `isOuterOf` (a full walk per column node — compile-time O(cols × plan)),
  `constantOver`'s `inside`, `semijoin.ts` `idsWithin`, `leading.ts` `inSeed`.
- **P27 — one `columnsRead`** in `src/rel/walk.ts`: S6's `decorrelate.ts` `columnsRead` = `fuse.ts` `colsOf`, and
  `scoped.ts` `colsRead` is a shallow variant; `exprReads`/`exprTouchesSelf` share `exprTouches`' traversal. Move
  S1's `freeIds` there too, beside `freeRelIds`.
- **P28 — one property side-table fact** (table, owner column, keyed by element table) in `src/rel`, from which
  `semijoin.ts` `SEEK_PROPERTIES`/`PROPERTY_OWNER`/`FTS_PROPERTIES`/`propertyOwner` and `build.ts` `PROPERTIES` derive.
- **P29 — one `B.owner = X` reader** `ownerOperand(conjunct, props)` beside `propertyOwner`, shared by `leading.ts`
  `ownerJoined` and `semijoin.ts` `ownerColumn`. After P28.
- **P30 — `isGraphStep(s)`** in `src/compiler/ir/step.ts` for the 16 hand-written `V`||`E` tests, plus one exported
  "draws over a re-source" predicate for `scoped.ts` `ladderOwns` and `per-traverser.ts` (identical today).
- **P31 — `namesACollection` reads `collectWhereKeys`** (LOWER CONFIDENCE): one select-key authority instead of three.
  Today `namesACollection` claims any list member; `collectWhereKeys` takes only the first, as getSelectKey does
  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/WherePredicateStep.java`).
  Lands only if `within(['y','x'])` still declines the same way — check `test/compiler/not-within-membership.exec.test.ts`.

### Needs-human questions (round 5)

None raised this round. Round 4's two questions are still open: question 1 (movement-head `until` at a hub, 22.8×;
S3 confirmed the two reducer walk-condition witnesses `sum().is`/`dedup().count().is` stay at 56×/49× pending it) and
question 2 (decides S5's second bullet).

## Next round (written 2026-11-17, after round 6)

Round 6 landed every item it built: T1 (6e6e45ca, 6b6619f6, 1274c293 — with the `edgePair` pass), T3(a) (614a69e4,
6b1457dd, 4231ed52), P21–P24 (53e8f1b2), T3(b) in part (7971f932), T2 (ec2db3de), P16 + T7's keyed pick (97b6e161,
c93e6a1c), S6a (fac4c754), T5 (846f4e35) and T6 (d4aebac4). No round-6 branch is parked as a resume point. Nothing was
deferred for a missing substrate; the one item left open by choice is T3(b) witness 2, parked on an owner decision
(question R6-1 below). Still open from earlier rounds: T4, T7's other bullets, M1b (behind H1), M6, N8, N9, K2, K3, K4,
P2, P5, P6, P8, P9, P11, P13, P14, P17, P18, P20, P25–P31, R4.2, R4.5, R5.2–R5.4, R6 (other hosts), R7, S5's second
bullet. Ordered so each prerequisite comes BEFORE the item it unblocks; major items first.

**Shared root of four round-6 majors: a physical pass fires on a SHAPE, with no fact for what the reader demands or
what one call of the replaced test costs.** `edgePair` (U1) fires on every both-pinned label-free probe whatever the
label vocabulary; `magic` (U2) fires on a one-seek test where nothing can be shared; the T2 fence (U3) spools a CTE
whose reader stops after `limit(k)`; `narrowFilter`'s constant seek (U4) drives whatever its selectivity. `magic`
already has half of the missing fact privately (`demanded`, "every row of this relation is work the plan does
anyway"), and `src/rel/work.ts` `perHostWork`/`exhausts` has the other half (a filter straight over a base table IS
the index seek). So the substrate item comes first:

### U0 — One "reader demand + per-call cost" fact in `src/rel/work.ts` (SUBSTRATE for U2, U3; do first)

Lift `magic.ts`'s private `demanded` into `src/rel/work.ts` beside `perHostWork`, as a node fact: does every
consumer read this relation IN FULL (aggregate, sort, window, ≤1 row, up to the root), or can it stop early (EXISTS,
`limit`, first-row pick)? And expose `exhausts`' "the test is one index seek over a base table" as a per-call cost
question. No behaviour change by itself (magic's answers byte-identical; L1 compilePlan diff). Then U2 and U3 each
become one extra condition on that fact, not a new private model.

✅ **LANDED (cab95bf4).** `readInFull(roots, mode)` in `src/rel/work.ts` beside `perHostWork`, with ONE blocking-kind
predicate `readsInputInFull` (aggregate/sort/window/materialize) shared with `exhaustsInput`. `'spine'` is magic's old
`demanded`, byte-identical (whole-L1-corpus plan dump unchanged); `'once'` (U3's fence) also counts a correlated
subplan, `IN (SELECT)`, recursive term and per-row-re-read join side as full, and returns the complement as
`stopsEarly` so a consumer fences by default. The per-call cost half stays `perHostWork`'s `exhausts`. Tests:
`test/rel-reader-demand.test.ts`. Remains: nothing.

### U1 — `edgePair` costs |label vocabulary| per probe (MAJOR, common reach; regression from T1's 1274c293)

`edgePair` (`src/rel/passes/edge-pair.ts`) reads every both-endpoint-pinned, label-free edge probe through
`label IN (SELECT id FROM labels)`. `labels` holds the WHOLE vocabulary, vertex labels included (`src/storage.ts` ~70),
so each probe is |labels| seeks. Measured on the walk-condition hub graph with N extra vertex labels (small/large =
130/1050 chains): `g.V().as('a').out('knows').where(__.in().as('a')).count()` at 300 labels 2.9/7.5 → 32.2/264.4 ms
(35×), at 3000 labels 4.2/9.5 → 302/2631 ms (277×); the hub form `…out().where(__.in().as('a'))` breaks even at 30
labels and is 69× slower at 3000. Linear in traversers, but a per-row term whose cost grows with the SCHEMA. The
header's "this is the skip-scan SQLite would pick with sqlite_stat1" is wrong: a real skip-scan steps only through the
labels present under the pinned prefix. **Item:** either give SQLite the statistic it lacks (a `sqlite_stat1` row for
`e_out`/`e_in`, so its own skip-scan is chosen, bounded by the labels at that vertex), or restrict the membership to
labels present under the pinned prefix. Add a multi-label (≥300 labels) hub row to
`test/compiler/walk-condition-hub-scale.exec.test.ts` — the suite uses 3 labels, which is why CI could not see it. Also
record in the design doc that the pass widened past walks to point lookups (`g.V(1).outE().inV().hasId(3)`,
`g.E().where(outV().hasId(1)).where(inV().hasId(3))`), while `g.V(1).out().hasId(2)` does not fire — the same question
with two access paths.

### U2 — `magic` fires where there is nothing to share (MAJOR, common reach; after U0)

T3(b)'s pass rewrites any element test it reaches, including a one-seek test and a selective host. Best of 3, trunk vs
7971f932, both linear: u4 `g.V().local(out().where(out()).count()).sum()` 4.0/12 → 6.6/23.8 ms (2× at 8k);
`g.V().project('n','f').by('name').by(out().where(out('knows')).count()).select('f').sum()` 5.3/15 → 8.8/24 ms;
`g.V().hasLabel('software').local(__.in().where(out().has('age',gt(30))).count()).sum()` 8.2 → 12.8 ms at 8k;
`g.V('v1').local(out().out().where(…).count())` 2.0 → 3.3 ms (the doc said unchanged). **Item:** fire only when U0's
per-call cost says one call of the test costs more than the semi-join probe that replaces it, and skip a point or
low-cardinality host (`rowBounds`). Add controls to the hub-scale suite: a cheap one-seek test
(`local(out().where(out()).count())`, `project().by(out().where(out('knows')).count())`) and a selective host, each
asserting no regression. Cheap, same item: `hostRows` re-reads an unordered `limit`/`range`/`dedup().by` host as an
independent copy, so the domain is valid only if SQLite picks the same rows twice (0 mismatches over 23 hosts measured,
but structural) — skip hosts with an unordered limit/first pick, or say why it holds in a comment.

### U3 — The T2 fence spools a short-circuiting stream (MAJOR, common reach; after U0)

`copyRerunsBarrier` (`src/rel/copies.ts`) counts the `SELECT DISTINCT node` seed of a range `has()` as a barrier, so
the shared start CTE of `has(…).both()`, `union(out(),in())`, `coalesce`, `optional`, `repeat(both()).times(n)` renders
`AS MATERIALIZED`, and under `limit(k)` SQLite computes the whole set first. Best of 7:
`g.V().has('age',gt(30)).both().values('name').limit(3)` 2.0 → 8.0 ms at 8k, 4.7 → 53 ms at 64k (near-constant became
linear); `…union(out(),in()).limit(2).count()` 4.6 → 52.7 ms at 64k; `repeat(both()).times(3).limit(5)` 2.4 → 7.5 ms.
Movers that read every row got faster (`…both().values('name').count()` 21.8 → 13.7 ms). **Item:** fence only where
U0 says every reader reads in full, or do not count an index-streamed DISTINCT seed as re-run work; keep fencing the
walk witnesses. Same item (minor, concrete): `barrierBeneath` near-duplicates `copiedWork` and diverges on
`self-ref`/`explode` and on subplans in expressions — make it ONE parameterised fact (with/without the computed half).
Note in `test/support/cte-runs.ts` that the gate counts only WITH-defined names: a derived table spelled twice
(`dag124` in `g.V().hasLabel('person').choose(repeat(out('knows')).emit(in('knows').has('age',gt(20))).count().is(gt(0)),constant('y'),constant('n'))`)
and a CTE re-run per outer row inside a correlated subquery are invisible to it.

### U4 — The correlated seek drives; constant seeks become uncorrelated INs (MAJOR, super-linear, plausible reach)

`narrowFilter` (`src/rel/passes/semijoin.ts`) still CHOOSES between a correlated and a constant seek: it skips a
correlated seek whenever `facts.constantSeek` has the element, so an unselective constant `has()` drives, re-run per
host. `g.V().values('name').as('n').V().has('name',select('n')).has('kind','person').count()` (every vertex
kind=person): 770 ms → 12.4 s at 1k → 4k (quadratic; 6.7/12.9 ms without the `kind` term);
`g.V().as('a').values('city').as('c').V().has('city',select('c')).has('kind','person').where(neq('a')).count()` 1.08 →
17.4 s. Not newly reachable. **Item:** the correlated seek drives and each constant seek is an uncorrelated `IN` set
built once per statement — `allOwners` with the correlated seek as `first`; delete `constantSeek`. This removes the
last selectivity choice in the seam. Same seam, after: `stackedAbove` merges only Filters stacked directly; a Project
between them or a conjunct inside a nested `where()` stays quadratic
(`…where(V().where(neq('a')).has('kind','person').where(values('name').is('zz'))).count()` 452 ms / 30.7 s at 1k/8k;
`flatMap(V().where(neq('a')).has('kind','person').has('name','zz'))` 675 ms / 47.3 s) — the nested-`where` half is T4's.

### U5 — `fuse.ts` re-derives the lineage authority (MAJOR x2, one-authority; cheap)

S6a added two hand-rolled rename tracers to `src/rel/passes/fuse.ts` — `overRenames().trace` and the rename loop in
`groupedOn` — plus `sideIndex`, a third positional side lookup beside `joinSide`, one commit after P21–P24 made
`src/rel/lineage.ts` the single column-lineage authority. **Item:** add a positional `index: 0|1` to `JoinSide` (so the
self-join case is identity-free), delete `sideIndex`; `trace(name)` becomes `columnAt(r, name, under.join)`;
`groupedOn` asks `definingPath`. Same rewrites; check with the L1 compilePlan diff. (Round 6's reuse proposal 6.)

### U6 — A `both()`/`union` body's positional scope key (SUBSTRATE for two super-linear findings)

Over a UNION input a correlated body lowers through a `row_number` scope key (`sk*`/`dk*`) re-inlined per host, and
an element test then reads the row key, not one element column. Two findings share it:
`g.V().local(both().both().where(both().has('age',gt(20))).count()).sum()` 1.7 s → 17.9 s at 1k → 8k on u4 (10.5×,
huge constant; hub form > 120 s), and `magic` cannot reach `g.V().local(both().where(in().has('age',gt(30))).count()).sum()`
(52 ms → 1.0 s, 19×). **Item:** key a union body's scope by element (or have `decorrelate` leave it unkeyed, as
`existenceOverOwnRows` does) — in `src/rel/decorrelate.ts`, one rule, never a magic.ts special case. Then the both()
forms join U2's witnesses.

### U7 — Pre-existing super-linear shapes found this round (each its own item; not newly reachable)

- **Coalesce arm cross join:** `g.V().as('a').coalesce(V().where(neq('a')).values('name').is(startingWith('zz')).is(endingWith('q')),constant('none')).count()`
  990 ms → 93 s at 1k → 8k (94×). The arm decorrelates to a plain `CROSS JOIN` with no EXISTS or first-row pick, so
  `leading` never sees it — the leading/seek idea for a whole arm read under coalesce.
- **A `distinct` on the leading spine:** `g.V().hasLabel('software').as('a').map(V().dedup().where(neq('a')).values('name')).count()`
  238 ms → 15.4 s (64×); without `dedup()` linear. `leading.ts`'s spine walk accepts only project/filter/sort — let it
  pass `distinct` (restricting an element commutes with a whole-row distinct), now that `definingPath` does.
- **fuse `factor` after a dedup / non-count aggregate:** `g.V().group().by('name').by(V().dedup().count()).count(local)`
  1.46 s at 1k (8k did not finish); `group().by('name').by(V().values('age').is(gt(30)).sum())` 719 ms at 1k (filter over
  a computing values Project); `group('m').by('name').by(V().out().count()).cap('m')` 3.8 s; `by(V().union(out(),in()).count())`
  1.7 s; `by(V().optional(out()).count())` 1.0 s; `by(V().values('age').max()/min()/mean())` unfactored (min/max are
  `arg_max`/`arg_min`; S6a's `SelfSplitter` fires only for sum's clw/clf bookkeeping). Re-measure P21's
  `group().by('name').by(V().values('age').sum())` (66×) on trunk after S6a first — it may already be factored.
- **Mid-chain re-source before a keyed aggregate:** `g.V().hasLabel('person').V().out().groupCount().by('name')` does
  |pool|×|body| work (S6a's normalisation reaches only the pooled by() re-source).

### U8 — Cheap, concrete follow-ups (round 6)

- **T1:** tests for the outer-label-READING walk conditions it newly answers — `g.V().as('a').repeat(both()).until(where(eq('a'))).limit(5).path()`
  (cycle detection), `emit(where(neq('a')))`, `until(select('a').has('name','marko'))`, `emit(local(select('a').out()))`
  — and one of them in the hub-scale suite. Re-check after T2 that the per-state walk CTE (referenced by DISTINCT and
  semi-join) now runs once.
- **T3(a):** stale `ownerJoined` citations (now `ownerScan`/`ownerProbe`) in `test/leading-owner-seek.test.ts` l.13
  and this doc; add a regression case with `has()` BEFORE the `values().is()` conjunct to the scaling test.
- **P21–P24:** one L2 assertion pinning the new narrowing through `dedup()`/`limit` (`g.V().dedup().has(k,v)`); P22
  widened `definingPath` callers (`edgePair`, `leading` `columnAt`, `reSourceCross`) beyond "byte-identical SQL" — the
  L1 corpus was identical, 7/38 off-corpus shapes changed, all faster or same rows.
- **P16/T7:** the keyed pick's type-tag fallback inlines the value-read `CASE` three times (`vt = coalesce(skq.skc24,
  … typeof(CASE …) … abs(2*CASE …+1))`) — project the value once in the pick's lookup (compute-once rule).
  `threadingRowKey` (`src/rel/copies.ts`) and `positionKeys` (`src/rel/position.ts`) share a "widen a spine node by one
  carried column" step — extract it when either is next touched.
- **T5:** `poolingStep` (`src/compiler/rel/map.ts`) is a second statement of `GroupRows.done` and disagrees:
  `sideEffect(out().group('x').by('name').by(count(local))).cap('x')` lost its hint; `…by(dedup().count())` now names
  the wrong reason. Return a `pooled` fact from `groupRows`' own decision and delete the parallel predicate.
- **T6:** `reSourcingBody`'s `someStepDeep(… V||E …)` repeats `ladderOwns` and mirrors `reSource`'s trigger — one
  `mayReSource(body, params)` beside `reSource` (`movement.ts`), joins P30. Say in the compile-time ratio test that
  the <30 margin (measured ~17) is deliberate.
- **T6 remains (follow-up item, plan-changing):** decide `positioned` before lowering in `lowerBody` instead of
  retrying (depth 2 is 3.8× depth 1; `landValues` calls 1/3/13 → 1/2/5 without the retry). Needs a census and
  sql-hygiene review.
- **S6a:** add one or two of its newly factored routes to `scripts/scaling-probe.ts` (`E().values().sum()`,
  `in().count()`, a `where()` semi-join body, `withSack().sack().sum()`).

### N8 additions (round 6 depth gaps; clean declines today; a body or host row, never a rung)

- **T1:** an emit/until condition reading a label bound OUTSIDE the walk with a path read
  (`g.V().as('s').repeat(out()).until(hasLabel('software')).emit(where(neq('s')))`, `emit(local(in().where(eq('s'))))`,
  `emit(path().count(local).is(gt(2)))`); a `simplePath` walk under a scoping host
  (`g.V().local(repeat(both().simplePath()).until(hasLabel('software')).emit(local(in().limit(1))).values('name').fold())`,
  also under `map(..count())`, `not(..)`, `group().by(..).by(..count())`).
- **T3(a):** `g.V().as('a').where(V().where(neq('a')).values('name').is(regex('^m.*o$'))).values('name')`;
  `choose(V().where(neq('a')).values('name').is(startingWith('m')).is(endingWith('o')),constant('y'),constant('n'))`.
- **T2:** `g.V().hasLabel('person').group().by('name').by(repeat(out('knows')).emit(in('knows').has('age',gt(20))).values('name').fold())`
  (the `count()` body answers); `groupCount().by('age').as('m').union(identity(),identity()).select('m')`.
- **T5:** under connector-only, a keyed `group('x')` with any child value `by()` declines everywhere, root included
  (`g.V().group('x').by(label).by(out().count()).cap('x')`), and `union(...)` arms get no hint — R7 must close these.
- **P21–P24:** `g.V().project('a').by(choose(values('age')).option(between(20,40),constant('young')).option(none,constant('old'))).count()`.

### Next round — reuse sweep (round 6's proposals)

- **P32 — one lowering-trial transaction in `scoped.ts`.** `reSourcingBody` (rolls back collections, siteEffects,
  `budget.restoreUnroll`, a declines fork), `attempt` (collections + siteEffects), `lowerBody`'s 'read' retry
  (collections ONLY) and `scopedHost`'s route loop (collections + declines fork + T5's `refusalMark`/`dropRefusals`)
  become one `trial(ctx, run) → {value, commit, rollback}` capturing every piece of per-compile state. Also closes a
  probable gap: `lowerBody`'s retry does not truncate siteEffects or restore the unroll note — probe first
  (order:'read', a body with `aggregate('x')`, positioned retry). Do before T6's `positioned` follow-up.
- **P33 — identity-preserving `rewrite`/`rewriteRels`** (`src/rel/walk.ts` `mapRelChildren`/`mapRelExprs` return `r`
  when every child is `===`; Calcite `vendor/calcite/core/src/main/java/org/apache/calcite/rel/RelShuttleImpl.java`
  `visitChild`). Deletes `magic.ts` `unchanged()` and its `relsBeneath` comparison; no future pass can split a shared
  node by a no-op rewrite (the bug T3(b) hit). Check with the L1 compilePlan diff.
- **P34 — `edge-pair.ts` `pathFrom`'s fast path moves into `lineage.ts` `columnPath`** (check top / a direct child
  first), so `semijoin` `drivenElement`/`rowidScan` get linear compile cost on an unrolled `times(K)` spine too.
- **P35 — one "fixed for the block / outer-only" lineage question** `outerOnly(top, e, allowLeaves)` on
  `columnLineage`, plus an exported expression free-id set from `walk.ts` (`exprReach` computes it privately), shared
  by `edge-pair.ts` `fixed()`, `leading.ts` `seedExpr` and `scoped.ts` `freeIds` (~35 lines). Joins P27.
- **P36 — `decorrelate.ts` `columnsRead` → `walk.ts` `deepColsRead`** (a superset, more conservative). Part of P27.
- **P37 — one `labelsScan(mint)`** in `build.ts`/`element.ts` for the ten inline `make.scan({table:'labels',…})`
  spellings (`edge-pair.ts`, `build.ts` `labelIds`, `element.ts` `labelTable`, `source.ts` ×3, `write.ts` ×3).
  Do with or after U1, which may change edge-pair's use.
- **P38 — `collapsesGlobally(step)`** = `selfCollapses(step.name) && !isLocalScope(step)` for the four inline
  conjunctions (`branch.ts` L117/L1238, `per-traverser.ts` L189) and T5's `reducesPool`; decide whether
  `per-traverser.ts` L142's REDUCERS||fold-without-count variant is intended. Pairs with U8's T5 `pooled` fact.
- **P39 — `firstArrival` → P16's `argExtremum` where the arrival is one column** (`build.ts` `firstArrival`; callers
  `slice.ts` L491, `scoped.ts` ~L2537, `map.ts` `groupKeyed`). Drops four per-row terms per passenger and keeps the
  value's storage class (check integer passengers for a wrong-class risk). Needs the bare-column law
  (`structure.ts` `checkArgExtremumLaw`) to admit a plain `min()` identical to the anchor. This IS P17 — build as P17.
  Measure sql-hygiene bytes and 1k/8k `dedup().by`/group-key timings first.
- (Round 6's proposal 6, `fuse.ts` `sideIndex`/`overRenames.trace`, is U5 above.)

### Needs-human questions (round 6)

- **R6-1 (T3(b) witness 2), from the builder, verbatim:** "Witness 2, the `where()` existence body, is deliberately
  not rewritten, because doing so made ordinary `where()` queries up to 48× slower. That trade needs your call." The
  measured trade: building the magic domain under an EXISTS costs `g.V().where(out().out().where(in().has('age',gt(20)))).count()`
  10.6 → 505 ms at 8k on a uniform out-degree-20 graph, while leaving it costs 48× per 8× at a hub. The depth
  reviewer's view: keep the short-circuit without statistics; defer until a substrate keeps the first-row stop while
  sharing the test (none known on SQLite). Same owner call as `docs/outstanding-work.md` ("A correlated EXISTS body
  at a hub…"). U0's demand fact does not answer it — it is a statistics question.
  **Same residue, from U2:** a selective but unbounded host (`g.V().hasLabel('software').local(__.in().where(out().has('age',gt(30))).count()).sum()`)
  is still rewritten by `magic` — no static fact tells it from a hub's hosts — and measured 9.4/27.7 ms without the
  rewrite vs 12.5/40.6 ms with it on the hub graph (130 → 1050 chains), linear either way; the hub-scale suite
  asserts only linearity there.
- Round 4's question 1 (movement-head `until` at a hub) and question 2 (S5's second bullet) remain open.

All 13 round-6 `wf/*-6-*` branches and their worktrees were removed after their landing shas were confirmed on
origin/trunk; none is a resume point.
