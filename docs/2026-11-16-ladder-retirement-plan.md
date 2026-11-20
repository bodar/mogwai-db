# Retiring the correlated-child ladder

_Status: IN PROGRESS — the ladder is GONE. Round 13 (2026-11-20) landed 10a (4a1e42a8), S1's follow-ups
(666ebf3e), 6b (157d7ad0), 6a (e4c03ba8), the R4.6 witness (c8c7d7f4), 6c (1d1f3fc8) and R7 (82da81ae): the
`correlatedChild` switch and `lower/per-traverser.ts` are deleted and the connector is the one child lowering.
What is left is two in-scope regression fixes found by round 13's review (6d, R7a), then G1. Round 12 landed item
10's three decided builds; rounds 10–11 landed F1, F2, R4.2, S1 and the S2 survey.
Trimmed hard 2026-11-19 after round 9 and again 2026-11-20 after round 13 (owner rule 6). The full record — every
round, measurement, reviewer finding and proposal — is in git history: rounds 1–7 at `4100715c`, rounds 8–9 at
`11378285`, rounds 10–13 at `326456e9`. Nothing below depends on it._

**The principle (owner, 2026-11-16): smart, considered replacement — not a forced migration.** A route is replaced
where the connector genuinely does the job as well or better, and left where it does not. Code genuinely shared by
the connector and the ladder is shared substrate under its own name, not a deletion target.

_Parent: `docs/2026-11-15-compositional-coverage-plan.md`. Direction: root `CLAUDE.md` locked decision 6._

## Scope rule — read this before adding ANYTHING (owner, 2026-11-19)

This plan is about retiring the ladder. Rounds 5–9 kept drifting into performance work because every reviewer
ran a scaling probe and every probe found something. The owner stopped it twice. The rule:

1. **In scope, and only this:** moving a query off the ladder, deleting ladder routing, what R7 needs, a **wrong
   answer**, a **lost answer** (answered before, declines now), and a **performance regression one of THIS plan's
   commits introduced** — measured against the trunk immediately before that commit, past the **2× bar** (owner,
   2026-11-19: raised from 1.3×; 1.3× was a deliberately high bar, and code bought only to get under it is not a
   good trade), and named with that commit's sha.
2. **Performance is not a plan item unless it is such a regression.** "Super-linear", "quadratic", "N× slower than
   the alternative", "less SQL", "compute it once", a cost gate, a hub/statistics trade-off, a faster route — if the
   pre-change trunk had the same cost, it is NOT a regression and it does NOT come here: not as an item, not as a
   follow-up, not as a "next round" proposal, not as an owner question. Write ONE line in
   `docs/outstanding-work.md` §1b (super-linear) or §6 (debt) and move on.
3. **Scaling probes are a regression check, not a search.** A builder or reviewer times its item's own witnesses
   before/after its own commit. It does not go looking for new super-linear shapes elsewhere. A scout or steward
   does not draft an item from a performance finding.
4. **Reuse / "one authority" refactors and decline-message polish** go to `outstanding-work.md` §6, not here.
5. **Depth gaps** (a clean decline the connector could answer) belong here only if they are ladder-only answers
   (counted by `test/L9-connector/ladder-reach.test.ts`). Every other depth gap goes to `outstanding-work.md` §4.
6. **No per-round sections, no landed-item narratives.** A round flips an item to "landed (sha)" in one line,
   updates "Where we are", and stops.

_Section numbers above are pre-2026-11-20. `docs/outstanding-work.md` is now a uniform reference: §1b → §2
Performance, §4 → §3 Queries we decline, §6 Internal debt unchanged. L9 ladder-reach is deleted with the ladder, so
every depth gap now goes to §3._

## Where we are (2026-11-20)

- **The ladder is deleted (R7, 82da81ae).** The connector (`src/compiler/rel/lower/scoped.ts` `CONNECTORS` +
  `src/rel/decorrelate.ts`) is the only child lowering. A host with its own tail lowering (`group()` over
  properties, `order(local).by`, `dedup('a','b').by`, …) falls back to that tail through `scopedHost`'s
  `hostTailAt`/`TAILED_HOSTS`, never to a per-traverser route. L9's ladder-reach engine is gone; its closure
  ratchet (`test/L9-connector/connector-closure-baseline.json`) is now the ordinary coverage ratchet.
- A body that draws over a re-source is the connector's (6c): `reSourcedBody` ends the shared read at the first
  draw, `drawnPerOrigin` draws a uniform pick per scope row, a shuffle cut to one IS `sample(1)` (6b,
  `shuffleCutToSample`), and the draw carries path and sack through `splitInto` (6a).
- Landed in full: R0–R7, R4.1–R4.6, R5.1–R5.5, R6, V0–V5 + U3, F1, F2, S1 (+ follow-ups), S2 builds (3)/(5) and the
  `sql-plan.ts` scan check (+ 10a), 6a, 6b, 6c.
- **Open:** 6d and R7a (regressions a round-13 commit introduced; scope rule 1), then G1.
- **No parked branch.** Every round-13 item landed; nothing is waiting on a resume point.

## Remaining work, in order

1. ✅ **F1 — LANDED (f5d2a6bc), tests only.** Pins V4's per-traverser `count(local)` group values
   (`test/compiler/group-ladderless.exec.test.ts`, GroupStep.java:123-126). Remains: nothing (F2 landed).
2. ✅ **F2 — LANDED (34674e92), tests only.** F1's `project('g').by(out().group().by(label).by(…count(local)))`
   depth case now asserts the exact bag of each traverser's `g` map — `{person:1}` ×1, `{}` ×5
   (`test/compiler/group-ladderless.exec.test.ts`, GroupStep.java:123-126), on the plain run, not `agreed()`.
   Remains: nothing.
3. ✅ **U1 — CLOSED by S1 (6793d40a).** The `edgePair` pass is gone; a label-free edge probe is one `e_pair` seek
   at any vocabulary (300 edge labels: 787 → 16.2 ms), so no residual cost needs a §1b line. The 300-label row is in
   `test/compiler/walk-condition-hub-scale.exec.test.ts`. Remains: nothing.
4. ✅ **R4.2 — LANDED (ae0fadb7).** `rejoin` (`src/compiler/rel/lower/scoped.ts`) reads the total switch
   `rowResident` (`src/compiler/rel/framing.ts`), so variant and property payloads ride the per-traverser rejoin.
   Corpus ladder-only answers went 5 → 0. Remains: P1.
5. ~~P1~~ **DROPPED (owner, 2026-11-19).** R4.2's 1.31× / 1.37× slowdowns are linear and inside the new 2× bar.
   P1a (an exclusive-arm bound in `bounds.ts`) is not built for it; one §1b line if not already filed.
6. ✅ **6a / 6b / 6c — LANDED.** They shared ONE root cause (the connector's drawing pick knew a draw only by a
   literal spelling and refused a path/sack input), so the substrate came first.
   - 6a ✅ (d19d6f6e, d4406e18, e4c03ba8): the per-origin draw and a forward re-source under a tracked path carry
     the origin's path and sack as GraphStep's split does (`splitInto`/`splitPosition`,
     `src/compiler/rel/lower/movement.ts`), gated by `splitRefuses(input, keepsPosition(prefix))`; a stream
     barrier after a move, or a bounding slice after a host-reading step, declines. Linear (≈7× per 8×).
   - 6b ✅ (157d7ad0): a global `order().by(shuffle)` cut to exactly one member (via `sliceOf`/`countOf`, a bound
     `$x` reduced at plan time) is canonicalized to `sample(1)` by `shuffleCutToSample`
     (`src/compiler/ir/shuffle-cut.ts`), at every depth. **Two lost answers — see 6d.**
   - 6c ✅ (1d1f3fc8): R4.5 (A). `reSourcedBody` ends the shared read at the first drawing step; `drawnPerOrigin`
     (`src/compiler/rel/lower/reduction.ts`) draws a uniform pick keyed per scope row, O(scope + read); a coin or a
     weighted/local sample keeps the shared-draw decline; `ladderOwns` is deleted.
   - Residue, all pre-existing cost or depth (scope rules 2 and 5), filed in `docs/outstanding-work.md`:
     `resource-union-prefix-slice`, `resource-barrier-prefix-path`, `cr-fu5` (shuffle `limit(n>1)`),
     `param-draw-slice`, `reresource-host-filter`, `reresource-path-draw`, `map-draw-host-read`,
     `resource-path-still-steps`.

6d. **Restore 6b's two lost answers (scope rule 1: answered before 157d7ad0, decline now). DO FIRST.**
   Re-verified 2026-11-20 on trunk 2c360906 (after R7):
   - (a) **A shuffle or sample pick followed by `otherV()` declines** with "no lowering covers":
     `g.V().bothE().order().by(shuffle).limit(1).otherV().count()`,
     `g.V().local(__.bothE().order().by(shuffle).limit(1).otherV()).count()`,
     `g.V().local(__.bothE().order().by(shuffle).limit(1)).otherV().count()`, the `inE`/`outE`, `flatMap` and `map`
     forms, and the random-walk recipe
     `g.V().hasLabel('person').repeat(__.local(__.bothE().order().by(shuffle).limit(1).otherV())).times(2).count()`.
     Trunk before 157d7ad0 answered all of them. Cause: the rewritten `sample(1)` is not in `FROM_V_TRANSPARENT`
     (`src/compiler/rel/lower.ts`, read by `edgeFeedsOtherV`), so the edge hop never mints `fromV`. Fix (verified by
     review in a scratch checkout of 157d7ad0): add `'sample'` to the set — `perOriginWindow` already carries every
     channel through `carriedCols`. It also makes TinkerPop's own recipe
     `g.V(1).repeat(local(bothE().sample(1).otherV())).times(4).path()` answer (pre-existing gap). Pick must stay
     uniform (`g.V(4).local(bothE().sample(1).otherV())` ≈ 1/3 each of ripple/lop/marko). Test both the shuffle
     and the `sample` forms, including the `local(…).otherV()` form R7 routes through `allRows('forward')`.
   - (b) **A single shuffle pick as the HOST of a rooted draw declines with SHARED_DRAW**:
     `g.V().hasLabel('person').order().by(shuffle).limit(1).addE('likes').to(__.V().hasLabel('software').order().by(shuffle).limit(1))`
     (trunk before 157d7ad0: 1 edge). The `project().by(V()…limit(1))` form review also named answers again since
     6c. Cause: `rootedHosts` (`src/compiler/rel/lower/reduction.ts`) asks `atMostOneRow`; `rowBounds`
     (`src/rel/bounds.ts`) treats `perOriginWindow`'s `Filter(prn<=1)` over a materialized window as unbounded. Fix
     generically in `rowBounds`: a Filter of `row_number <= n` over an unpartitioned window has max n. Do not
     special-case the Pass.

7. ✅ **R4.6 — LANDED with R7 (82da81ae; witness be26dfa7, c8c7d7f4).** The sweep found no wrong answer; its lost
   answers were fixed in R7. The witness: `reductionHost` answers the property framing and `propertyTail` hands
   shape-keeping steps on through `continueAs`. Remains: nothing (follow-ups `property-ladderless-pair`,
   `tail-loop-head` in outstanding-work §6).

8. ✅ **R7 — LANDED (82da81ae).** `correlatedChild`, `connectorOnly`, `lower/per-traverser.ts` and L9's
   ladder-reach are deleted; `local(<edge body>).otherV()` is answered by `allRows('forward')` lowering its body
   with `fromV`. Follow-ups in outstanding-work §6 `r7-followups` and §3 `local-edge-otherv-depth`.
   **One regression past the 2× bar — see R7a.**

8a. **R7a — R7's forwarding rejoin is past 2× on the unsliced `local(<edge body>).otherV()` family (scope rule 1).**
   Measured by review, best of 5, trunk 517e695a~1 → R7, ms at 1k / 8k vertices:
   `g.V().map(local(outE()).otherV().values('name').fold())` 4.1 / 35.9 → 12.4 / 101.1 (**2.8×**);
   `g.V().local(bothE().where(otherV().has('age',gt(30)))).otherV().count()` 4.1 / 40.2 → 9.8 / 88.6 (**2.2×**);
   `g.V().local(union(outE(),inE())).otherV().count()` 1.3 / 12.6 → 3.0 / 26.1 (2.1×);
   `g.V().local(bothE()).otherV().count()` 1.3 / 12.4 → 3.0 / 24.1 (1.9×). All linear (≈8–9× per 8×). The common
   sliced idiom `local(bothE().limit(1)).otherV()` is unchanged (34.7 vs 33.4). Cause: the connector's
   `allRows('forward')` materializes the scope and joins it back on `sk = dk` (plan 3 → 4 joins) where the
   deleted route emitted one flat UNION/JOIN. Fix direction: when the body holds no barrier (nothing needs a
   per-scope partition), lower it inline over the host as a plain flatMap rejoin, without the materialized scope
   — a general rule in the connector, not a `(local, otherV)` branch. Re-measure the four witnesses against
   517e695a~1. If the fix is not small, this becomes an owner question (accept, as the R7 owner note allowed "a
   small regression"), not a shoehorn.

9. ✅ **S1 — LANDED (6793d40a; follow-ups 666ebf3e).** `e_pair(src, tgt)` (`src/storage.ts`) is the label-free
   probe; `edgePair` is deleted. Remains: nothing (test-brittleness note folded into outstanding-work §6
   `adjacency-seek-assert`).

10. ✅ **S2 — LANDED.** Survey 39a8f01a (owner decided: build (3) and (5), fix the scan check; not (1) or (2)).
   (5) TextP trigram probe 73616a6b; (3) `e_label` 22b79ae5; scan check d64a6d3a; 10a gate holes 4a1e42a8
   (`classify()` exempts a root scan only for `nodes`/`edges`, gates base-table `AUTOMATIC` indexes and
   label/key-prefix-only nested SEARCH at zero). Remains: nothing (`sql-plan-weak-prefix-ratchet` in
   outstanding-work §6). The survey is kept below as the measured record for (1) and (2).

   **Surveyed 2026-11-19 (report only; nothing built).** Method: EXPLAIN QUERY PLAN over every L6 (304) and L1
   (1,446) read plan, mapping each `SCAN <alias>` back to its base table; then size (page-count growth of a
   copy) and timed seeks on modern, crew, grateful-dead (808 v / 8k e), air-routes (3.7k v / 58k e) and a
   synthetic 20k v / 40k e graph carrying 180k properties.

   *Already split, so the answer to "are we missing one?" is explicit:* vertices/edges are separate tables;
   vertex/edge properties are separate tables, each with its own `(key, value)` index; vertex labels are
   interned and normalized (`vl_label(label, node)`); edge labels are interned and sit inside
   `e_out(src,label,tgt)`/`e_in(tgt,label,src)`; S1 added `e_pair(src,tgt)`; FTS rowids are signed by kind.

   One line per candidate (ms per query; "→" is before → after):
   - **(1) Interned property keys** (`key INTEGER` + a key vocabulary, like `labels`). Size only, as
     predicted: property tables + indexes 580→440 KB grateful (76%), 5.7→4.8 MB air-routes (84%), 14.0→11.7 MB
     synthetic (84%). Seek time unchanged (name = v 0.005→0.004; `age > 30` 4.66→4.53; edge `weight > 0.5`
     5.25→4.95 synthetic). Touches every property reader and writer, the catalog, `write.ts`, `bulk.ts`,
     `refresh.ts`, `replicate.ts`, the formats and the FTS `pk`. **Not worth it**: a 16–24% size win, no seek win.
   - **(2) `property_fts` split by owner kind.** Real but modest: with the trigram index in use, a V probe
     8.7→4.6 and an E probe 9.4→3.7 on the synthetic graph (a 10%-selective substring); total FTS size about the
     same (16.2 MB → 8.0 + 6.7). Small code (DDL, `positiveOwners`/`negativeOwners`, the write path and
     loaders). **BUT it is dwarfed by (5): today the trigram index is not used at all**, so fix (5) first and
     re-ask this one only if kind-restricted TextP on a mixed graph is still a hotspot.
   - **(3) Edge label lead index `edges(label)`.** `g.E().hasLabel(x)` scans a whole adjacency index because
     neither `e_out` nor `e_in` leads with `label`: grateful `sungBy` (501/8049) 0.241→0.020, air-routes
     `contains` (7k/58k) 1.81→0.134, synthetic `created` (5k/40k) 1.23→0.107 — **9–13×**, SQLite picks it
     unaided. Cost: one more index per edge (540 KB on air-routes; S1's similar `e_pair` cost +7–11% bulk load).
     Reach: 4/304 L6 queries, 3 L1 reads. Code: one DDL line. **Recommended** — the vertex side already has
     `vl_label`, so this is the missing half of an existing split rather than a new one.
   - **(4) Other base-table SCANs.** None that a split would fix: 751 L1 / 18 L6 plans scan `nodes` (via
     `nodes_gid`) and 31 / 3 scan `edges` via `e_pair` — all root `V()`/`E()` scans (or a key-existence
     `has(k)`, which reads every element and probes) that read every element by meaning; 128 L1 `nodes`
     table scans are the modern graph's planner choosing a 6-row scan. `has(k)` could start from
     `vp_key_value(key)` instead — a lowering choice, not a schema one; not measured.
   - **(5) NOT a split, but the biggest finding: the TextP→FTS probe never uses the trigram index.**
     `positiveOwners` (`src/rel/passes/semijoin.ts`) emits `like(pattern, text, '\')` — the 3-argument
     (ESCAPE) form, which SQLite does not offer to a virtual table's `xBestIndex` (only the 2-arg
     `text LIKE p` is), so the plan is `SCAN property_fts VIRTUAL TABLE INDEX 0:` — every FTS row, every query
     (the 2-arg form plans `INDEX 0:L4`). The comment there says the opposite. Air-routes end to end:
     `has('airport','desc',TextP.containing('Intercontinental')).count()` 12.9→0.40, `has('desc',
     containing('Heathrow')).values('code')` 12.5→0.054 (same answers) — **32–230×**. Fix: build the FTS
     probe's pattern from the RAW literal as a 2-arg `LIKE '%' || lit || '%'` — unescaped `%`/`_` only widen
     it, so it is a SUPERSET, and the exact residual EXISTS still decides. (Do NOT just drop the ESCAPE
     argument from the escaped pattern: `a\%b` would then require a backslash and lose rows.) ~10 lines; the
     negative probe (`negativeOwners`) re-asks the atom's body and wants the same check.
   - Dropped per review: `tombstones.kind` (changes feed, contrived reach).

   *Instrument defect found on the way:* `scripts/sql-plan.ts`'s "0 base-table scans" gate matches the
   ALIAS after `SCAN` (`rn`, `re`, `rfs0`) against table names, so it can never fire — the RelIR emitter
   aliases every table. It is vacuous today; the alias→table map in this survey is the fix.

   Scaling probe (synthetic 1k → 8k vertices, ms): `has('name','alpha-500')` 0.080→0.071 (×0.9),
   `has('age',gt(30)).count()` 0.75→7.8 (×10.5), `E().has('weight',gt(0.5)).count()` 1.08→10.5 (×9.7),
   V `TextP.containing('harl')` 1.62→14.3 (×8.8), E same 1.83→15.1 (×8.2), `E().hasLabel('created').count()`
   0.072→0.50 (×6.9), `where(out().has('age',gt(30)))` 0.58→5.9 (×10.3), `local(outE().has('weight',
   gt(0.5)))` 1.53→13.6 (×8.8), `has('person','city','golf').out('knows').has('name',containing('elta'))`
   0.33→2.7 (×8.1) — all linear. **Owner decides**: (3) and (5) are each small and ≥9×; (1) and (2) are not
   worth building now.

11. **G1 — does each performance change EARN ITS KEEP? (owner, 2026-11-19). UNBLOCKED (6c and R7 landed); after
   6d and R7a** so it weighs the code as it will stand. NOT a blanket "remove what only got us under 1.3×". For each
   change this plan made for performance (V0+U3 911eef32, V1 77eb86cb/b09dee81, V2 33356b80, V3 75ad576d, V5
   b600fc15, T1 1274c293), weigh the measured win against the code complexity it added:
   - It made the code simpler or no more complex, or bought a large win (e.g. well below the pre-change cost, or a
     super-linear shape made linear): it earns its keep. Keep it.
   - It added substantial code for a marginal win (removing it keeps every answer and stays within 2× of the trunk
     before that commit): it does not earn its keep. Simplify or remove it.
   - Report each with its witnesses before/after in ms, the lines it added, and the verdict with a one-line reason.
     Wrong-answer fixes are never removed. Some of those commits touched code R7 deleted; say so per item rather
     than re-measuring a route that no longer exists.

## Next round

- **Order: 6d, then R7a, then G1.** 6d is two small, independent fixes (one set member; one `rowBounds` rule) and
  may build in parallel with R7a. G1 waits for both.
- Round 13's follow-ups outside this plan's scope went to `docs/outstanding-work.md` (scope rules 2, 4, 5):
  - §2 performance (pre-existing): `resource-union-prefix-slice`, `resource-barrier-prefix-path`; `cr-fu5` gained the
    shuffle `limit(n>1)` witness.
  - §3 depth gaps (not regressions): `map-draw-host-read`, `local-edge-otherv-depth`, `resource-path-still-steps`.
  - §6 debt: `keeps-position-authority` (6a's `KEEPS_POSITION` duplicates `KEEPS_PATH_ENTRY`; take before
    `resource-path-still-steps`), `bounding-slices-truncates`, `resource-decline-messages`,
    `property-ladderless-pair`, `sql-plan-weak-prefix-ratchet`; `adjacency-seek-assert` widened.
  - Already filed, unchanged: writes inside `sideEffect` (§3 writes), `reresource-host-filter`.
- **Reuse sweep (round 13), filed as outstanding-work §6 items per scope rule 4:**
  - `tail-loop-head` — one loop-head re-dispatch (`handsBack` → `continueAs`) for the seven tails in
    `src/compiler/rel/lower.ts`; `pathTail`/`mapEntryTail`/`recordTail` have drifted
    (`g.V().valueMap().unfold().V().count()` declines while `g.V().valueMap().V().count()` answers 36).
  - `slice-window-of` — a total `windowOf(step)` in `src/compiler/ir/step.ts`; deletes five catches of `sliceOf`'s
    internal plain `Error`.
  - `bounding-slices-truncates` — `BOUNDING_SLICES` → `write.ts`'s `truncates`, moved to `ir/step.ts`.
  - `adjacency-seek-assert` — plan-pinning tests read the seek rule from `scripts/sql-plan.ts`'s `schemaFacts` /
    `constrainedColumns` instead of hand-listing `e_out`/`e_pair`.
- Earlier rounds' reuse proposals are already in `docs/outstanding-work.md` §6.

## Guards

- `mise run ladder` (`scripts/ladder-check.ts`): the `return null` decline sites in `src/compiler/rel/` may not grow.
- L9: the connector-closure ratchet may not fall; every host is a `CONNECTORS` row or a classified deferral
  (`test/L9-connector/deferred-hosts.ts`, `host-totality.test.ts`).

## Owner questions (open)

None. Round 13 raised no needs-human question. R7a may become one only if its fix is not small (see the item).
