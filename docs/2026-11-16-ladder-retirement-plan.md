# Retiring the correlated-child ladder

_Status: PROPOSED, 2026-11-16. Not started. No deadline: each step lands on its own when it is ready, and
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

### R2 — Make the retry unnecessary (connector handles its own declines)

- **Join width:**
  - carry the scope key as a channel through a decorrelated body instead of re-joining it;
  - or, when one order is too wide, fall back WITHIN the connector to the correlated form, which needs no
    scope table.
- **Copied draws:** a draw under `local`/`flatMap` is independent per scope (the reference applies the body per
  traverser). Make the decorrelated plan hold ONE draw per scope row, or route draws to a correlated form that
  evaluates per host row.
- *Done when:* `bothChildOrders` never fires on the pools. Count it.

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

### R4 — Per-traverser family (largest prize: ~360 LOC, 13 `return null`)

**DECIDED (owner, 2026-11-16): REPLACE IN STAGES (option A); the route stays until the typed carrier (Phase 4) lands.**
Now: inline a body that only moves (flatMap(out().out()) is 1.29× today, on the default path); the reducer marker is
accepted where it is READ; re-source bodies go to the connector; the pinned `[]` scenario (`resourced-scalar-value.feature`) moves to the six nulls and its §17 line is deleted — the `[]` was the ladder scalar subquery confusing a null value with no row, not a JS/SQLite semantic (owner, 2026-11-16); draws are one per scope row (with R2). The
variant- and property-payload sole answers wait for the carrier; the route is deleted when they land.

Each sub-item is its own commit. The audit's "measured and NOT landed" list is the starting evidence.

1. **The reducer's `result` marker on an emitted value.** It closes 4 sole answers. Fix it where the marker is
   READ (the `match` binding and the arm meet accept it), not where it is shed. Shedding it lost
   `property(k, local(values('age').sum()))`'s stored type.
2. **Variant and property payloads through the rejoin.** These close 5. The first attempt raised `sql-hygiene`
   by 7.5 → 12.7 KB, so it probably wants the typed carrier (parent Phase 4, S5); sequence it there.
3. **Re-source bodies** (`map(V()…)`). First establish the reference semantics with scenarios: a re-source
   body under `map`/`local`/`flatMap`, including over a maybe-absent value. The first attempt gave a wrong answer
   (six nulls for `[]`). Only then remove `ladderOwns`' re-source refusal.
4. **Draw bodies** (`local(out().sample(1))`): shared with R2's per-scope draw.
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

## Decisions for the owner

1. **Per kept route, at its step:** replace or keep. Settled in principle (considered replacement, not forced);
   each call is made with that step's measurements in hand. (`group` at R5 is the first likely "keep".)
2. **Scope of "ladder" vs "host-owned"** (R0's classification). Should `repeat` until/emit's own condition
   lowering stay as it is?
