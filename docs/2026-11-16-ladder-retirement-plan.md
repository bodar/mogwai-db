# Retiring the correlated-child ladder

_Status: IN PROGRESS. Round 1 (2026-11-17) landed R0, R1, R2a, R2b, R3, R4.1, R4.3, R4.4 and R5.1; round 2
landed N0, N1, N2+P4, N4, N6, P1, P3; round 3 landed M0, M1 (+M3), M4, N7 (+M5), P7, P10; round 4 landed N5, K1+P15, Q2 (both halves), P12, M2, R6's first item (+R6.0) and N3 partially. The next round starts at
"Next round (written 2026-11-17, after round 4)" at the end. No deadline: each step lands on its own when it is ready, and
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
- **The correlated equality `by()` compare** (`where(V().where(eq('a')).by('name').where(neq('a')))`, a duplicate-name
  finder): 1.16 s → 79 s at 1k → 8k (68×). It was newly reachable with M2; the `coalesce`/`optional` spellings were
  already on trunk at the same cost. The `vp_key_value` index could answer it in N log N. Whether to build this is an
  owner question (below).

### N3 remainder — gated on S6a (prerequisite, ordered first)

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

- **R6 — `P.not(within('x'))` → `without('x')`.** Normalize this at the one `memberOf` helper. Corpus
  `g_VX1X_out_aggregateXxX_out_whereXnotXwithinXaXXX` and `g_V_classic_recommendation` still decline; the
  `without` spelling answers `[ripple]`.
- **R6 — compute the membership key once.** `scalarMembership` (`src/compiler/rel/lower/filter.ts`) spells
  `typedValueKey(v, coalesce(tag, inferredVtype(v)))` about 6 times per member row (2649 → 3941 bytes). Project the
  member's total tag as one column under `set`, then key over that column.
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
