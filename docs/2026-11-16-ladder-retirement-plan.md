# Retiring the correlated-child ladder

_Status: IN PROGRESS — the ladder is GONE. Round 13 (2026-11-20) landed 10a (4a1e42a8), S1's follow-ups
(666ebf3e), 6b (157d7ad0), 6a (e4c03ba8), the R4.6 witness (c8c7d7f4), 6c (1d1f3fc8) and R7 (82da81ae): the
`correlatedChild` switch and `lower/per-traverser.ts` are deleted and the connector is the one child lowering.
R7a (46e0a19b) and 6d ((b) 64bae352, (a) d5ce03e2) landed; G1 audited every performance change and removed
nothing (each earns its keep). **Round 14's review reopened the plan:** R7a lost answers (a `local()` with a label,
sack or value body inside a bounded `repeat()`), so U4 (the prerequisite) and then R7b are open. Round 12 landed item
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
  `sql-plan.ts` scan check (+ 10a), 6a, 6b, 6c, 6d.
- **Open: U4, then R7b (items 8b, 8c).** R7a (46e0a19b) lost answers that trunk gave before it (scope rule 1).
  Apart from that, 6d ((b) 64bae352, (a) d5ce03e2), R7a and G1 (0d10cb47, audit only) landed in full.
- **No parked branch.** Every round-14 item landed; nothing is waiting on a resume point.

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
     **(b) ✅ LANDED (64bae352):** `rowBounds` (`src/rel/bounds.ts`) bounds a Filter of `row_number <= n` over an
     unpartitioned window at max n, so `perOriginWindow`'s single pick satisfies `atMostOneRow` and hosts a rooted
     draw again (shuffle and `sample(1)` forms write one edge; `sample(2)` as host still declines). Compile-time
     metadata only, no new SQL term. Remains of (b): nothing.
     **(a) ✅ LANDED (d5ce03e2):** `'sample'` joins `FROM_V_TRANSPARENT` (`src/compiler/rel/lower.ts`, read by
     `edgeFeedsOtherV`), so a sampled or shuffle-cut edge mints `fromV` and `otherV()` answers again in every host
     (global, `local`, `local(…).otherV()` via `allRows('forward')`, `flatMap`, `map`, `project().by`, `where`,
     `optional`, union arms, repeat bodies), plus TinkerPop's random-walk recipe; `perOriginWindow` already carried
     every channel, so no new SQL term. Witness `test/compiler/sample-other-v.exec.test.ts`. Weighted
     `sample(1).by(…)` still declines (pre-existing, separate gap). Remains of (a): nothing. **6d is done.**

7. ✅ **R4.6 — LANDED with R7 (82da81ae; witness be26dfa7, c8c7d7f4).** The sweep found no wrong answer; its lost
   answers were fixed in R7. The witness: `reductionHost` answers the property framing and `propertyTail` hands
   shape-keeping steps on through `continueAs`. Remains: nothing (follow-ups `property-ladderless-pair`,
   `tail-loop-head` in outstanding-work §6).

8. ✅ **R7 — LANDED (82da81ae).** `correlatedChild`, `connectorOnly`, `lower/per-traverser.ts` and L9's
   ladder-reach are deleted; `local(<edge body>).otherV()` is answered by `allRows('forward')` lowering its body
   with `fromV`. Follow-ups in outstanding-work §6 `r7-followups` and §3 `local-edge-otherv-depth`.
   Its one regression past the 2× bar is fixed by R7a.

8a. ✅ **R7a — LANDED (46e0a19b).** A `local()` whose body holds no stream barrier (and no write, call, unlabelled
   traverser source or top-level re-source) is spliced into its host chain — `spliceableLocalBody`, consulted by
   `spliceIdentityHosts` (`src/compiler/ir/strategies.ts`); `tree`/`cap` joined `GLOBAL_BARRIER_STEPS`. All four
   witnesses are now below the pre-R7 baseline (e.g. `map(local(outE()).otherV()…fold())` 2.8 / 22.6 ms, 2 joins)
   and linear. Remains: its lost answers in bounded repeat bodies, handled by U4 then R7b (8b, 8c). The original finding, kept for the record:
   R7's forwarding rejoin was past 2× on the unsliced `local(<edge body>).otherV()` family (scope rule 1).
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

8b. **U4 — the bounded unroll admits label, sack, value and select body steps. PREREQUISITE of R7b; do first.**
   This is the one root cause behind every R7a lost answer. `tryUnroll` (`src/compiler/ir/strategies.ts`) splices
   `times(n)` only when every body step passes `unrollableBodyStep`, and `as()`, `sack()` (with its `by()`),
   `values()` and `select()` are not in that set. Before R7a a `local()` host hid them: it was admitted as a
   `PER_TRAVERSER_RESET_HOSTS` step with no iteration state and lowered per phase by the connector. R7a now splices
   that body into the repeat body first, so the unroll sees the bare steps and refuses, and the recursive walk
   cannot hold them either. The inline forms already decline on trunk, corpus scenarios included:
   `vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/test/features/sideEffect/Sack.feature:280`
   (`repeat(__.outE().sack(Operator.sum).by("weight").inV()).times(2).sack()`) and `…/features/map/Select.feature:462`
   and `:488` (`as("a").repeat(__.out().as("a")).times(2).select(Pop.first|last, "a")`). Re-verified 2026-11-20 on
   046254bc: the inline and `local()` forms all decline with the generic "no lowering covers …".
   Fix: admit these steps as phase steps, each with its reason. A spliced phase is an ordinary chain step, so a
   label binds and a sack updates once per level, exactly as if written out (prior art:
   `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/RepeatUnrollStrategy.java`).
   Witness `select()` of a label the body itself binds, and `select(first|last|all, …)` over n bindings of one
   label. Do NOT narrow `spliceableLocalBody` instead: review and scope rule both call that a per-shape exclusion.
   It gains the corpus scenarios above; move the L3/census baselines only for them, and say so in the commit.

8c. **R7b — restore R7a's lost answers (scope rule 1: answered before 46e0a19b, decline now). After U4.**
   Witnesses, trunk 29c83d03 (before R7a) → 46e0a19b, modern graph:
   - `g.withSack(0.0).V().repeat(__.local(__.outE().sack(sum).by('weight').inV())).times(2).sack()`: [1.4, 2.0] → decline
     (the `local()` wrapper of Sack.feature:280).
   - `g.withSack(1.0).V().repeat(__.local(__.outE().sack(mult).by('weight').inV())).times(2).sack()`: [0.4, 1.0] → decline.
   - `g.V().repeat(__.local(__.outE().as('e').inV())).times(2).select(all,'e').count()`: 2 → decline.
   - `g.V().repeat(__.local(__.out().as('x').in())).times(2).count()`: 50 → decline.
   - `g.V().repeat(__.local(__.out().as('x'))).times(2).select('x').values('name')`: [lop, ripple] → decline; also
     `select(last,'x')` and `select(all,'x').count(local)` ([2, 2]).
   - `g.V().as('s').repeat(__.local(__.out().select('s'))).times(2).count()`: 14 → decline.
   - `g.V().repeat(__.local(__.out().values('name'))).times(1)` (6 rows) → decline; also
     `repeat(local(out().as('a')).simplePath()).times(2)` and `repeat(local(out().as('x'))).times(2).simplePath()`.
   - Lower reach, different cause: a re-source inside an ARM of a spliced `local()` in a repeat.
     `g.V().repeat(__.local(__.union(__.V().has('name','marko'), __.out()))).times(2).count()` 32 → decline, and
     `…local(__.coalesce(__.out('knows'), __.V().has('name','peter')))…` 7 → decline. `spliceableLocalBody`'s V()/E()
     exclusion reads only top-level body steps. Fix it by reading the body at any depth (one `someStepDeep` walk over
     the shared `graph-sources-vocabulary` set, outstanding-work §6), not with a per-arm branch.
   After U4, re-run every witness. Whatever still declines is fixed in the unroll or the splice gate, never with a
   `(repeat, local)` branch. Add the test review asked for: `test/compiler/local-splice.exec.test.ts` pins a
   repeat-hosted `local()` over a sack, label and value body (e.g. the `sack(sum)` witness = [1.4, 2.0]).
   R7a's gains stay: `repeat(local(outE().sack(mult).by('weight').inV())).emit().sack()` (8 rows),
   `.until(outE().count().is(0)).sack()` (7) and `until(has('name','ripple')).repeat(local(out())).path()` (3) now
   answer correctly where trunk declined. If U4 turns out not to be small, raise an owner question (accept the loss
   for now, or keep the splice out of bounded repeat bodies) rather than shoehorn.

8d. **RC — repeat()-condition gaps (owner, 2026-11-20; added by the owner despite scope rule 5).** Measured on
   trunk 0d10cb47, modern graph. Bounded `emit` conditions all answer now; these UNBOUNDED conditions decline with the
   generic "no lowering covers …" though `test/L9-connector/deferred-hosts.ts` (REPEAT) says they should answer
   (emit: any head, asked once per distinct state over the finished walk; until: any head whose per-row work is
   bounded):
   - `g.V().repeat(__.out()).until(__.project(a).by(__.out().count()).select(a).is(0)).count()` (bounded
     `emit(project…)` answers; `until(map(out().count()).is(0))` answers 7).
   - `g.V().repeat(__.out()).until(__.group().by(label).select(keys).count(local).is(1)).count()`.
     ✅ **LANDED (bf776b35) — both `until` bullets above.** A condition reading only the frontier element's own
     rows (properties, labels, a value's members) is bounded by the element, so it now answers in the walk term
     (`group().by(label)…` = 6; also `elementMap()`/`properties()`/`project().by(values)`/`valueMap()` heads).
     Mechanism: `PerHostWork.readsNeighbourhood` + `exprReadsNeighbourhood` (`src/rel/work.ts`, the one authority;
     walk.ts's private `readsAdjacency` moved there); the term refuses only `exhausts && (readsNeighbourhood ||
     reSources)`. `until(project('a').by(out().count())…)` stays a DELIBERATE refusal (it reads the neighbourhood
     — quadratic at a hub) and now says so, naming `until(out().count().is(0))` (`hub-in-walk-term`,
     `src/compiler/unsupported.ts`). Pinned in `test/L4-addendum/repeat-condition-any-head.feature` and
     `test/compiler/per-host-work.exec.test.ts`. Remains for these bullets: nothing (the `map(out().count())`
     spelling's pre-existing hub cost is outstanding-work §2 `until-map-count`).
   - `g.V().repeat(__.out()).emit(__.order().by(name).limit(1).has(name,marko)).count()` — an emit condition,
     which the deferral says takes any head.
   - `until` combined with `times(n)` (`g.V().repeat(__.out()).until(__.out().count().is(0)).times(2).count()`, in
     every order) fails with "VerificationException: The repeat()-traversal was not defined" — a misleading message.
     Read `vendor/tinkerpop/gremlin-core/…/RepeatStep.java` and `GraphTraversal.java` (`times`/`until`) for what
     the combination MEANS; answer it if the reference defines it, else decline in the user's terms.
     ✅ **LANDED (115e58ee).** Invalid per the reference (`times(n)` fills the `until` slot, so the second
     modulator opens a bodiless `RepeatStep`); `verifyRepeatDefined` (`src/compiler/ir/strategies.ts`) keeps the
     reference sentence and appends the collision in the user's terms plus the one-modulator form
     `until(or(loops().is(n), <condition>))` (doubled `emit`/`until`/`times` likewise); pinned in
     `test/compiler/constant-steps.exec.test.ts`. Remains for this bullet: nothing.
   Fix each in the condition's lowering or the decorrelator (one rule, every head), never a per-shape branch. Keep the
   deliberate refusals (a per-frontier-row condition that is quadratic at a hub, a draw) and make their messages say
   so. Pin the answers in a test; correct the REPEAT deferral text to what is true after the fix.

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

11. ✅ **G1 — DONE (2026-11-20, landed 0d10cb47): every performance change earns its keep; nothing removed;
   remains: nothing.** Measured on trunk
   2f133ee4 (after 6d and R7a): each change's witnesses at 1k / 8k vertices (median of 9, ms), with the change and
   with a scratch revert of only its hunk. Answers were identical both ways. The rule (owner, 2026-11-19): keep a
   change that is no more complex, or that bought a large or super-linear→linear win; remove only substantial code
   bought for a marginal win.
   - **V0+U3 911eef32 + V2 33356b80: KEEP.** 2 code lines in `name.ts` (`demand` and the `stopsEarly` waiver; V2
     changed one word) plus `work.ts`'s `blockedInput`, a fact fix (an unfenced materialize and a `cross` join now
     agree with the emitter). The revert fences every shared barrier copy: `has(age,gt(30)).both().values(name)
     .limit(3)` goes 2.8/2.2 → 3.2/7.2, from near-constant to linear in N (45 ms at 64k). The mixed witnesses (an
     emit walk under limit/range, `union(limit(2),count())`, and those under where/local) are equal either way
     (39–58 ms at 8k), because both versions fence them.
   - **V1 77eb86cb/b09dee81: KEEP.** ~30 lines (`takeFinishedMap`, `ENTRY_COL` and a 2-line call) plus 6 lines
     (`namedEffect`, `lower.ts`). Reverting `takeFinishedMap` evaluates the map twice: `group('a').by(name)
     .by(values(age).sum()).cap('a')` goes 16.8/88.0 → 29.4/143.9 and `by(label)` 7.5/24.4 → 15.0/48.4 (1.6–2.0×,
     at the bar). The unkeyed barrier takes 14.4/70.4. Reverting only `namedEffect` makes the drain spell its domain
     twice: 88.0 → 108.2 and 24.4 → 37.6. It is small code enforcing the project's compute-once rule. b09dee81's
     entry split stays with it, because of the 2 MB value cap.
   - **V3 75ad576d: KEEP.** `keyedCount` (5 code lines) plus `countsTraversers` (2). It also SIMPLIFIED `groupRows`:
     one counting authority replaced the `groupBarrier` re-entry. The revert sends a keyed count through the member
     pool. At 8k: root `group('a').by(name).by(count()).cap('a')` 33.0 → 57.9, two union sites 36.7 → 76.1,
     `repeat(out().group('a')…).times(2)` 98.2 → 198.5, `choose` 26.8 → 47.5, `where(out().group('a')…)`
     27.7 → 41.5 (1.5–2.1×).
   - **V5 b600fc15: KEEP, untimed.** It fixed a bare RelIR error (`walk.ts`), so it is a correctness change.
   - **T1 1274c293: gone.** S1 6793d40a deleted the `edgePair` pass (replaced by the `e_pair` index).
   - Every witness is linear with its change in place: 1k→8k ratios are 0.8× (paged) and 2.5–5.9× otherwise.

## Next round

- **Order: U4 (item 8b) → R7b (item 8c).** U4 is R7b's prerequisite and fixes corpus declines on its own. Round 14
  landed 6d(b) 64bae352, 6d(a) d5ce03e2, R7a 46e0a19b and G1 0d10cb47 (audit only, no code).
- Round 14's follow-ups outside this plan's scope were filed in `docs/outstanding-work.md` (scope rules 2, 4, 5):
  - §2 performance (within the 2× bar or pre-existing): `simplepath-reinline` (R7a made
    `repeat(local(both().simplePath())).times(3)` take the inline SQL, ≈15%), `inline-label-compare-cast` (≈1.36×).
  - §3 depth gaps (not regressions): `repeat-barrier-otherv`, `weighted-sample-otherv` (both also want a decline that
    names the shape), `single-row-host-bounds` (6d(b)'s `boundsOf` join and fold/unfold arms), `keyed-group-arm-hosts`
    (G1 review: a keyed `group('a')` in `coalesce`/`union` arms).
  - §6 debt: `sample-otherv-selfloop-test`, `row-number-cap-authority`.
- **Reuse sweep (round 14), filed as outstanding-work §6 items per scope rule 4:**
  - `graph-sources-vocabulary` — one exported `GRAPH_SOURCES` in `src/compiler/ir/step.ts` replaces R7a's copy in
    `strategies.ts`, `write.ts`'s original and about 14 hand-spelled `name === 'V' || name === 'E'` tests. R7b's
    arm-depth splice gate should read it.
  - `row-number-cap-authority` — one `predicateBound(pred, leaf)` for `uniqueKeyMatches` and `rowNumberCap`
    (`src/rel/bounds.ts`), the and/or law written once.
  - `from-v-transparent-vocabulary` — build `FROM_V_TRANSPARENT` from `FILTER_HOSTS` and slice.ts's set renamed
    `ROW_SLICE_STEPS`, which removes a `SLICE_STEPS` homonym and the drift that 6d(a) had to repair.
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

None. Rounds 13 and 14 raised no needs-human question. R7b may raise one if U4 turns out not to be small (item 8c).
