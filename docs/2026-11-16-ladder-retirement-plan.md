# Retiring the correlated-child ladder

_Status: IN PROGRESS. Trimmed 2026-11-19 after round 7. The full round-by-round record (rounds 1–7, every
measurement, reviewer finding and proposal) is this file at `4100715c`, in git history; nothing below depends on it._

**The principle (owner, 2026-11-16): smart, considered replacement — not a forced migration.** A route is replaced
where the connector genuinely does the job as well or better, and left where it does not. Nothing is shoe-horned onto
the connector to hit a count. Code genuinely shared by the connector and the ladder is neither's: it is shared
substrate under its own name, not a deletion target.

_Parent: `docs/2026-11-15-compositional-coverage-plan.md`. Direction: root `CLAUDE.md` locked decision 6._

## Scope rule — read this before adding ANY item (owner, 2026-11-19)

Rounds 5–7 drifted from retiring the ladder into general performance work (magic sets, seek choice, hub costs,
schema-size costs). Every round's reviewers found new performance majors, so the list grew faster than it shrank. The
owner stopped it. From now on:

1. **In scope:** only work that moves a query off the ladder, deletes ladder routing, or is needed for R7 — plus a
   **wrong answer**, a **lost answer** (something that answered before now declines), or a **performance regression
   this plan's own commits introduced** (measured against the trunk before that commit, past the 1.3× bar).
2. **Out of scope — never added here:** any other performance finding, however real: super-linear shapes that were
   already super-linear on the pre-change trunk, hub/statistics trade-offs, cost gates, compute-once tidy-ups that
   are not regressions, reuse/"one authority" refactors, and decline-message polish. A builder or reviewer who finds one
   writes ONE line in `docs/outstanding-work.md` (§1b for super-linear, §6 for debt) and moves on. It does not become
   a plan item, a follow-up, a "next round" section or an owner question here.
3. **Depth gaps** (a clean decline the connector could answer) belong here only if it is a ladder-only answer
   (counted by `test/L9-connector/ladder-reach.test.ts`). Every other depth gap goes to `outstanding-work.md` §4.
4. **No per-round sections.** A round updates the status line of the items it touched and the "Where we are"
   numbers. Nothing else is appended.

## Where we are (2026-11-19)

- The connector is the DEFAULT at every child site; `bothChildOrders` is deleted (N7). The ladder is the opt-in
  `correlatedChild` FastPath; its code is `src/compiler/rel/lower/per-traverser.ts` alone (12 `return null`).
- **Ladder-only answers: 5** (from 66; CI ratchet `test/L9-connector/ladder-reach-baseline.json`):
  group 0 (R5.3+R5.4, ec4ea890), per-traverser 1, other 4 (option-map `choose` bodies under `local`/`map`, corpus.txt
  515/516/2077/2078), existence 0.
- Done (detail at `4100715c`): R0 ratchet; R1 shared substrate; R2 join width + per-scope draws; R3 existence family;
  R4.1/R4.3/R4.4; R5.1 domain elimination; R5.2 keyed `group("a")`; R6 `sideEffect` with effects; owner answers
  Q2 (bounded and unbounded `repeat` conditions through the connector), Q3b (N5 min/max), Q5 (N3 cross-join
  `AggregateJoinTransposeRule`, M2 answers instead of declining).

## End state

1. Shared code (the correlated `EXISTS`, the correlated first-row read, the condition builders) stays as substrate.
2. A route goes when the connector answers what it answers, within the bar or an owner-accepted margin.
3. No query that answers today declines afterwards. Zero wrong answers throughout.
4. R7 deletes the switch only if nothing is left on it; a deliberately kept, documented route is acceptable.

## Remaining work, in order

### A. Regressions this plan introduced (do first)

- ✅ **V0 + U3 — LANDED (911eef32).** Remains: nothing. `readsInputInFull` counts only a fenced `materialize` and a `cross` join keeps its left
  outside; `name`'s fence for re-run work applies only to a shared relation in `readInFull(roots,'once').full`.
  `has('age',gt(30)).both().values('name').limit(3)` is back to 2.9 ms at 64k (45 ms fenced). `repeat(both()).times(3)
  .limit(5)` and `union(out(),in()).limit(2)` were never moved by the fence (measured equal before ec2db3de); the
  latter's linear cost is pre-existing, filed in `outstanding-work.md` §1b.
- ✅ **V1 — LANDED (77eb86cb, b09dee81).** Remains: nothing. A raising pooled keyed group's drain IS the finished
  map's binding (`takeFinishedMap`, `collection.ts`): the map is evaluated once, retained as one `[key, value]` pair row
  per key (so it splits under the DO 2 MB value cap like any retained set), and cap/select/unfold re-fold it with
  `collectedArray`. Keyed/unkeyed 1.1–1.3× at 1k/8k (was 2.6–3.4×); scaling linear.
- **U1 — `edgePair` costs |label vocabulary| per probe (regression from T1, 1274c293).** Large schemas only
  (`g.V().as('a').out('knows').where(__.in().as('a')).count()` 35× at 300 labels). **Blocked on owner question 1.**

### B. Ladder retirement

- ✅ **R5.3 + R5.4 — LANDED (ec4ea890).** A `group()` value `by()` with no barrier is assigned per traverser
  (`Operator.assign`, `vendor/tinkerpop/gremlin-core/.../Grouping.java`): `perTraverserSlot` (`scoped.ts`) marks the
  value slot per traverser when the body has no `isValueBarrier` step, so `byValues` lands it beside the key, unkeyed
  and keyed `group("m")` alike; nested groups close with it. Group ladder reach 5 → 0; L3 +1. Remains: the `union`
  witness `union(group('a').by(label).by(count()), out()).cap('a')` is refused for a reason outside this item — a
  `union` whose arms produce maps is refused even with no value `by()` (a separate union-host gap). With group's
  ladder reach at 0, `group` is now in `LADDERLESS` — its route is deleted (owner Q3a margins accepted; the
  witness answers in every mode).
- ✅ **Pooled keyed `group('a')` in a branch arm / connector body — LANDED (95334eb3).** Remains: nothing. Each
  site registers the pool's MEMBERS as a `pooled` collection carrying its `PoolRecipe`; the reader reduces once over
  every site's members (`poolMembers` / `reduceFrom`, `collection.ts`). A raising reduction keeps V1's finished-map
  registration. L3 2057 → 2058; scaling linear (1.6–6.7× at 1k → 8k).
- **R6 — the remaining deferred hosts as CONNECTORS rows** (owner Q4, widest scope), by workload reach:
  option maps (`choose(k).option(…)`, `branch`, closes the 4 "other" ladder-only answers — first), `V`/`E` re-source
  (stale entry: already answers connector-only), value arguments, predicate operands, projection `by()`s
  (`path`/`select`/`valueMap`/`sack`/`math`/`format`/`aggregate`), writes (`WRITE_ARG`). Each landed host deletes its
  `test/L9-connector/deferred-hosts.ts` entry.
- **The 1 per-traverser ladder-only answer** — identify it from the ratchet and give it a body or host fix.
- **R4.2** — variant and property payloads through the rejoin; waits for the typed carrier (parent Phase 4).
- **R7 — delete the switch**, when the ladder-only count is 0 and the scaling probe holds: `correlatedChild` and its
  readers, L5's per-switch entry, `FastPathConfig.connectorOnly` (becomes the only mode); L9's connector-only ratchet
  becomes the ordinary coverage ratchet; update root `CLAUDE.md` decision 6 and `src/compiler/CLAUDE.md`.

## Guards

- `mise run ladder`: ladder files may not grow.
- L9: connector-only closure may not fall; ladder-only answers may only fall; every host is a row or a classified
  deferral.
- `mise run scaling`: the 1k/8k margins a deletion cites.

## Owner questions (open)

1. **U1's fix (R7-1):** (a) recursive loose scan — 10–19× faster at 300 labels, 1.6–2× slower at 3 labels;
   (b) `label IN (SELECT DISTINCT label FROM edges WHERE src = …)` — trunk speed at 3 labels, fastest at 300, but reads
   an out-hub's whole neighbourhood per probe; (c) leave trunk and close U1, moving the large-schema cost to
   `outstanding-work.md`.

Every other open question from rounds 4–7 was a performance trade-off, so it moved to `docs/outstanding-work.md`
under the scope rule.
