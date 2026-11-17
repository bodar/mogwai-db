# Retiring the correlated-child ladder

_Status: IN PROGRESS. Round 1 (2026-11-17) landed R0, R1, R2a, R2b, R3, R4.1, R4.3, R4.4 and R5.1; the
next round starts at "Next round" below. No deadline: each step lands on its own when it is ready, and
any step may stop and be reconsidered._

**The principle (owner, 2026-11-16): smart, considered replacement — not a forced migration.** A route is
replaced where the connector genuinely does the job as well or better, and left where it does not. Nothing is
shoe-horned onto the connector to hit a count. What is GENUINELY SHARED between the connector and the ladder is
neither's: it is pulled out as shared substrate under its own name, used by both, and is not a deletion target.

_Parent: `docs/2026-11-15-compositional-coverage-plan.md` (Phase 3, the "Kept routes" audit holds the
measurements this plan starts from). Direction: root `CLAUDE.md` locked decision 6._

## Where we are

- The scoped-relation connector (`src/compiler/rel/lower/scoped.ts` + `src/rel/decorrelate.ts`) is the
  DEFAULT at every child site. The ladder is the opt-in `correlatedChild` FastPath, plus the `bothChildOrders`
  retry (`src/compiler/rel/spine.ts`), which re-lowers a declining compile in the other order.
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
  - `bothChildOrders`;
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

The first-row read is referenced twice (value and presence `EXISTS`) and emitted as two byte-identical
`MATERIALIZED` CTEs, so the graph scan + sort runs twice: `g.V().map(V().values('name'))` 757 → 1430 bytes,
`map(V().order().by('name').values('name'))` 1367 → 2779. Give both uses one fenced node, or read presence off the
value CTE's row. Lands naturally with P4 (one first-row builder) below.

### N3 — Linear pooled re-source for many keys (MAJOR — performance is semantics)

`g.V().group().by('name').by(V().count())` is 183 ms at 1k and 14,810 ms at 8k (81×): with `poolWeight` the graph
is still crossed once per KEY. `reSourcedBody`'s own law, rest(prefix×G) = prefix×rest(G), says rest(G) is computed
once and scaled by each key's weight; `pooledGroup` should reuse that seam instead of being a second re-source
authority. Measure with the scaling probe (≈8× is the bar).

### N4 — `covering` from `bounds.ts`, not a second copy (MAJOR — one authority)

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

### N6 — R0 ratchet follow-ups (cheap, concrete)

- Fail (or at least print) when `fresh` is non-empty in `test/L9-connector/connector-closure.test.ts`: the ratchet
  gates COUNTS, so a swap within one pool×family cell (one query closes, another regresses) lands silently.
- `familyOf` (`test/L9-connector/ladder-reach.ts`): a family host under a `host-owned` `DEFERRED_HOSTS` position
  (e.g. the `map()` inside the Grateful Dead `match()` scenario) is charged to `other`, using `Deferred.scope`.
- R2's done-when: count retry FIRES (first order declines), not only rescues, or reword it. Re-record the baseline
  if the rescue count has fallen since R2b.

### N7 — Delete the `CopiedDraw` retry arm, then `bothChildOrders` (after N6)

After R2a and R2b, `bothChildOrders` (`src/compiler/rel/spine.ts`) retries only on `CopiedDraw`. Once N6 counts
fires and the count is 0 on the pools, delete the arm and the retry (R7's precondition "R2's retry count is 0").

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
- **P2 — One productivity rule (after P1).** Build `alwaysProduces`/`bodyAlwaysProduces` and coalesce's
  `alwaysFires` on the `existencePrefix` walk (a global seeded terminal cuts to `[]`; `isStreamIdentity` never
  empties; purity a separate gate), and fold `isAlwaysProductiveFilterNoOp` into `trimExistenceSuffix`.
- **P3 — Make `decorrelate`'s `owns` mandatory.** One keyed-body helper (`owning` + lower + effects + reframe +
  `decorrelate(…, mine.owns)`) for `scopedBody`/`rootedBody`/`pooledGroup`; the `() => true` default reintroduces
  the R2b bug for a fourth caller. Also one `ownDraws`/`draws` walker in `src/rel/copies.ts`.
- **P4 — One first-row builder** that returns the relation itself when `atMostOneRow` (replacing the hand-rolled
  sort+LIMIT 1 / `ROW_NUMBER` forms in `reSourcedBody`, the scalar first-row, `rowsKeyedBy`, `build.ts`
  `firstRootedColumn`); the short-circuit lives in `perOriginWindow`. Carries N2.
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
