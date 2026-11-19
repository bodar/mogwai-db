# Retiring the correlated-child ladder

_Status: IN PROGRESS. Trimmed 2026-11-19 after round 7; round 8 (V0+U3, R5.3+R5.4, V1, pooled keyed bodies, group
route) updated in place. The full round-by-round record (rounds 1–7, every
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
  `group` is `LADDERLESS` (2a94fda9).
- **Ladder-only answers: 5** (from 66; CI ratchet `test/L9-connector/ladder-reach-baseline.json`):
  group 0, per-traverser 1, other 4 (option-map `choose` bodies under `local`/`map`, corpus.txt
  515/516/2077/2078), existence 0. All 5 decline at ONE line — `rejoin`'s `framingCols()` gate (`scoped.ts` ~1616) —
  so they are one item, R4.2, and it is the last thing R7 waits on.
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
  latter's linear cost is pre-existing, filed in `outstanding-work.md` §1b. **Its own regression is V2.**
- **V2 — a shared relation read BOTH in full and partially went unfenced (regression from 911eef32; both review
  lenses, major).** `name.ts` fences only `demand.full`, but `work.ts`'s `ReaderDemand` contract says anything not in
  `stopsEarly` takes the CONSERVATIVE answer. A mixed relation is in neither set, so the partial reader re-runs the
  barrier the full reader already pays for. Witnesses (before 911eef32 → now, 1k / 8k): `g.V().out().dedup()
  .values('name').union(limit(2), count())` 1.01/8.41 → 2.89/26.26 ms (dedup co-routine run 5×);
  `g.V().has('age',gt(30)).both().union(limit(2), count())` 1.33/9.14 → 2.44/18.26 ms; the emit walk
  `g.V().repeat(out('knows')).emit(in('knows').has('age',gt(40)))` + `.limit(5)` / `.range(10,20)` /
  `.dedup().limit(5)` / `.limit(1000000).count()` evaluates `wk_w3` twice (`reevaluatedCtes` non-empty; 374 → 556 ms
  at 32k). Answers unchanged, growth linear. **Fix (measured in a scratch tree):** `!demand.stopsEarly.has(original)
  && copyRerunsBarrier(mapped)` in place of `demand.full.has(original) && …`; flip the comment "A relation read both
  ways is not in `full` and stays lazy too". The U3 witness stays unfenced (0.13/0.36 ms). Pin it: add the limited
  emit-walk shapes to `WALKS` and the mixed `union(limit(2), count())` case to
  `test/compiler/shared-cte-fence.exec.test.ts`. Record U3's accepted trade-off in the `name.ts` comment: a selective
  filter under a `limit` that never stops early (`has('name','nomatch').limit(1)`) reads the seed twice — the
  pre-ec2db3de cost, not to be re-fenced as a "fix".
- ✅ **V1 — LANDED (77eb86cb, b09dee81).** Remains: nothing. A raising pooled keyed group's drain IS the finished
  map's binding (`takeFinishedMap`, `collection.ts`): the map is evaluated once, retained as one `[key, value]` pair row
  per key (so it splits under the DO 2 MB value cap like any retained set), and cap/select/unfold re-fold it with
  `collectedArray`. Keyed/unkeyed 1.1–1.3× at 1k/8k (was 2.6–3.4×); scaling linear. Add a regression test for the
  shape V1 made answer: `g.V().group('a').by(label).by(values('age').sum()).where(select('a').count(local).is(1))
  .count()` → [6] (it threw a bare Error before V1; the non-raising twin still does — V5).
- **V3 — a ONE-site keyed pooled group pays for the multi-site pool (regression from 95334eb3, major).**
  `g.V().group('a').by('name').by(count()).cap('a')` used to take the host's counting recipe (one CTE, `count(1)` per
  key, 1714 SQL chars); it now goes through `poolMembers`/`reduceFrom`: two MATERIALIZED CTEs, a
  `min(printf('%020d',…)||key)` first-arrival domain, a domain→pool join and a regroup (2945 chars, +72%; compile
  4.8 → 7.5 ms). 1k / 8k: 5.2/23.8 → 9.8/48.9 ms; `by(out().count())` at 8k 48.6 → 74.4 ms;
  `union(group('a')…by(count()), out()).cap('a')` at 8k 23.4 → 46.4 ms; single-site choose/optional/coalesce arms
  ≈1.5×. Linear, but every one-site keyed `by(count())`/`by(values().fold())` pays per-row terms nothing reads.
  **Fix:** with ONE site on the label, reduce with the host recipe; register pool members only where a second site or
  a body reads them. The two-site arm cases must keep answering (why the pool exists). While there:
  `keyedPooledGroup` builds the whole reduction only to test `mayRaise`, and the reader builds it again — decide "can
  raise" from the value body.
- ✅ **V4 — LANDED: it was a WRONG answer, not a lost one.** A `Scope.local` reducer ending a group value `by()`
  (`by(values('name').count(local))`, `by(values('age').sum(local))`) reached `groupRows`' pooled arm by step NAME
  and answered the key's total (`person:4`, `person:123`); a local reducer is a `MapStep`, so the body has no barrier
  and the reference assigns per traverser (`person:1`, one member's age). The arm is now gated on `reducesPool`
  (`src/compiler/rel/map.ts`), which also fixed the §1 group-local-count-local and group-value-local-reader entries.
  The old ladder's `by(out().count(local))` → `{person:6, software:0}` was itself wrong (ref `{person:1, software:1}`);
  it declines cleanly because element `count(local)` is a top-level gap (`outstanding-work.md` §4 element-count-local).
- **V5 — a bare internal Error reaches the user (pre-existing, in the keyed-group family this plan owns).**
  `g.V().group('a').by(label).by(count()).where(select('a').count(local).is(1)).count()` and
  `g.V().group('a').by('name').by(count()).where(select('a').unfold().count().is(2)).count()` throw `Error: RelIR: no
  relation 'c1' is in scope for column 'id'` on trunk (d374f001) and before. The raising `sum()` twin answers since V1
  (its finished map is taken once), so the missing case is reading a non-raising pooled-members collection from a
  `where()` body. Answer, or decline cleanly; never a bare Error.
- **U1 — `edgePair` costs |label vocabulary| per probe (regression from T1, 1274c293).** Large schemas only
  (`g.V().as('a').out('knows').where(__.in().as('a')).count()` 35× at 300 labels). **Blocked on owner question 1.**

### B. Ladder retirement

- ✅ **R5.3 + R5.4 — LANDED (ec4ea890).** A `group()` value `by()` with no barrier is assigned per traverser
  (`Operator.assign`, `vendor/tinkerpop/gremlin-core/.../Grouping.java`): `perTraverserSlot` (`scoped.ts`) marks the
  value slot per traverser when the body has no `isValueBarrier` step, so `byValues` lands it beside the key, unkeyed
  and keyed `group("m")` alike; nested groups close with it. Group ladder reach 5 → 0; L3 +1. Remains: the `union`
  witness `union(group('a').by(label).by(count()), out()).cap('a')` is refused for a reason outside this item — a
  `union` whose arms produce maps is refused even with no value `by()` (a separate union-host gap). With group's
  ladder reach at 0, `group` joined `LADDERLESS` — ✅ LANDED (2a94fda9; owner Q3a margins accepted; `LADDERLESS`
  in `scoped.ts`, the witness answers in every mode). Remains: R5.5 (the code was not deleted); V4 landed (a wrong answer, not a lost one).
- **R5.5 — actually delete the group ladder code (follow-up to 2a94fda9, major).** The commit and
  `docs/2026-11-15-compositional-coverage-plan.md` §3 say `groupReduced`/`groupCollected` are "still served by the
  PROPERTY host, e.g. `g.V().properties().group().by(key).by(count())`". False: hit counters at their entries read 0
  over the 34-query group probe set (default and LADDER), the whole corpus (`rel-blockers.ts`) and the full
  `mise run test`; they read 9/3 before 2a94fda9. Delete in `src/compiler/rel/map.ts`: `groupReduced`'s pooling arm
  (~945–1077, after the `!pre.length` → `groupBarrier` arm), `groupCollected` (~1101–1205), `dedupGroupMembers`,
  `dedupBeforeFold`, and `groupRows`' pooled-routing block (~428–512, incl. its second copy of `GLOBAL_ARMS`); then
  whatever orphans (`bun scripts/refs.ts`, `mise run orphans`). Keep the `!pre.length` + `count()` → `groupBarrier`
  arm: it is the property host's live route. Fix the stale `group` in `GATE_ONLY_FAST_PATHS.correlatedChild`'s comment
  (`src/compiler/options/fast-paths.ts` ~193) and the false sentence in the coverage plan. Expect `mise run ladder`
  below 1277; `test/L2-sql/group.sql.test.ts` may pin SQL from these arms. No answer changes.
- ✅ **Pooled keyed `group('a')` in a branch arm / connector body — LANDED (95334eb3).** Remains: nothing. Each
  site registers the pool's MEMBERS as a `pooled` collection carrying its `PoolRecipe`; the reader reduces once over
  every site's members (`poolMembers` / `reduceFrom`, `collection.ts`). A raising reduction keeps V1's finished-map
  registration. L3 2057 → 2058; scaling linear (1.6–6.7× at 1k → 8k).
- **R4.2 — variant and property payloads through the per-traverser rejoin. Closes ALL 5 remaining ladder-only
  answers** (the 4 option-map bodies and the 1 per-traverser one: round 8 found one root cause, so R6's "option maps
  first" and "the 1 per-traverser answer" merged here). **BLOCKED on owner question 2.** All 5 decline at `rejoin`'s
  `framingCols()` gate (`scoped.ts` ~1616); `rejoin` never uses that column list — it carries the body's own payload
  columns — and `framingCols`' null for variant/property exists for RECORD FIELDS. (a) Relax the gate for
  variant/property (record fields still decline) — makes R7 reachable this cycle; (b) wait for typed-carrier T1
  (parent Phase 4, not started). PREREQUISITE: the owner's answer.
- R6's other hosts (`V`/`E` re-source — already answers connector-only, value arguments, predicate operands,
  projection `by()`s, writes `WRITE_ARG`) carry no ladder-only answer, so they left this plan for
  `outstanding-work.md` §4; they stay listed in `test/L9-connector/deferred-hosts.ts`.
- **R7 — delete the switch**, when the ladder-only count is 0 and the scaling probe holds: `correlatedChild` and its
  readers, L5's per-switch entry, `FastPathConfig.connectorOnly` (becomes the only mode); L9's connector-only ratchet
  becomes the ordinary coverage ratchet; update root `CLAUDE.md` decision 6 and `src/compiler/CLAUDE.md`.

## Guards

- `mise run ladder`: ladder files may not grow.
- L9: connector-only closure may not fall; ladder-only answers may only fall; every host is a row or a classified
  deferral.
- `mise run scaling`: the 1k/8k margins a deletion cites.

## Owner questions (open, verbatim from round 8)

1. **U1:** "U1 (plan owner question 1): to fix edgePair's per-probe label-vocabulary cost, pick (a) recursive loose
   scan (10–19× faster at 300 labels, 1.6–2× slower at 3), (b) label IN (SELECT DISTINCT label FROM edges WHERE src=…)
   (trunk speed at 3 labels, fastest at 300, reads a hub's whole neighbourhood), or (c) close U1 and move the cost to
   outstanding-work."
2. **R4.2:** "All 5 remaining non-group ladder-only answers decline at one line, scoped.ts:1616 rejoin's framingCols()
   gate. rejoin never uses that column list; it carries the body's own payload columns, and framingCols' null for
   variant/property exists for RECORD FIELDS. Should the per-traverser rejoin carry variant/property payloads now
   (record fields still decline), which makes R7 reachable this cycle? Or keep the 2026-11-16 decision to wait for
   typed-carrier T1, which has not started?"

Every other open question from rounds 4–7 was a performance trade-off, so it moved to `docs/outstanding-work.md`
under the scope rule.
