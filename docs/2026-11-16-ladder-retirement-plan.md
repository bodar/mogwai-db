# Retiring the correlated-child ladder

_Status: IN PROGRESS. Round 10 (2026-11-19) landed F1 and R4.2 and parked U1 and R4.5 on owner questions.
Trimmed hard 2026-11-19 after round 9 (owner request). The full record — every round,
measurement, reviewer finding and proposal — is in git history: rounds 1–7 at `4100715c`, round 8–9 at `11378285`.
Nothing below depends on it._

**The principle (owner, 2026-11-16): smart, considered replacement — not a forced migration.** A route is replaced
where the connector genuinely does the job as well or better, and left where it does not. Code genuinely shared by
the connector and the ladder is shared substrate under its own name, not a deletion target.

_Parent: `docs/2026-11-15-compositional-coverage-plan.md`. Direction: root `CLAUDE.md` locked decision 6._

## Scope rule — read this before adding ANYTHING (owner, 2026-11-19)

This plan is about retiring the ladder. Rounds 5–9 kept drifting into performance work because every reviewer
ran a scaling probe and every probe found something. The owner stopped it twice. The rule:

1. **In scope, and only this:** moving a query off the ladder, deleting ladder routing, what R7 needs, a **wrong
   answer**, a **lost answer** (answered before, declines now), and a **performance regression one of THIS plan's
   commits introduced** — measured against the trunk immediately before that commit, past the 1.3× bar, and named
   with that commit's sha.
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

## Where we are (2026-11-19)

- The connector is the DEFAULT at every child site. The ladder is the opt-in `correlatedChild` FastPath; its code is
  `src/compiler/rel/lower/per-traverser.ts` alone. `group` is `LADDERLESS` and its dead ladder arms are deleted.
- **Ladder-only answers in the corpus: 0** (from 66; CI ratchet `test/L9-connector/ladder-reach-baseline.json`).
  R4.2 (ae0fadb7) closed the last 5. **R7 is NOT yet unblocked**: L9 counts corpus traversals only, so it cannot see
  (i) bodies that draw over a re-source (`ladderOwns`, R4.5) or (ii) ladder-only answers outside the corpus (R4.6).
  Both must be closed, or kept as a named non-ladder route, first.
- Landed: R0–R3, R4.1/R4.3/R4.4, R5.1–R5.5, R6 side effects, pooled keyed `group('a')` in arms/bodies (95334eb3);
  regressions/wrong answers V0+U3 (911eef32), V1 (77eb86cb, b09dee81), V2 (33356b80), V3 (75ad576d),
  V4 (1ef9b707), V5 (b600fc15); F1 pins V4's answers (f5d2a6bc); R4.2 (ae0fadb7).

## Remaining work, in order

1. ✅ **F1 — LANDED (f5d2a6bc), tests only.** Pins V4's per-traverser `count(local)` group values
   (`test/compiler/group-ladderless.exec.test.ts`, GroupStep.java:123-126). Remains: F2.
2. **F2 — tighten F1's `project().by()` depth pin (tests only, cheap; both reviewers raised it).** The
   `project('g').by(out().group().by(label).by(values('age').is(gt(30)).count(local)))` case checks only 6 rows and
   one row containing `person`, so `{person:2}` or a bogus `software` key would pass. Assert the bag exactly,
   `{g:{person:1}}` ×1 and `{g:{}}` ×5, as the `local()` case beside it does.
3. **U1 — `edgePair` costs |label vocabulary| per probe (regression from T1, 1274c293). PARKED, needs-human
   (U1-Q below).** Step 1 (the one-off measurement) is DONE, and it overturned the decided rule "(b) if it holds,
   else (a)":
   - (b) `label IN (SELECT DISTINCT label FROM edges WHERE src = …)` is quadratic at an out-hub: 264 → 3744 ms from
     2k to 8k out-edges.
   - (a) the correlated recursive loose scan makes real air-routes queries ~50% slower than trunk (7.3 → 10.8 s).
     That is the kind of regression this plan forbids its own commits to introduce.
   - On grateful-dead and air-routes, today's T1 plan is already 1.5–3.5× faster than pre-T1. The vocabulary cost
     only shows up with hundreds of labels.
   - New candidates: (d) a `labels.edge` flag maintained by the schema's first trigger, plus a migration. It was
     faster everywhere measured and fixes the 300-vertex-label case, but not the 300-edge-label case. (e) accept
     T1, file one `outstanding-work.md` §1b line, and close U1.
   - Whatever is chosen: keep the real-graph witnesses as a one-off comparison script (not a CI gate), and add the
     300-label row (plus an out-hub row if a form is chosen) to
     `test/compiler/walk-condition-hub-scale.exec.test.ts`.
   - Prerequisite to resume: the owner answers U1-Q and the answer is written into this item. No branch to resume.
4. ✅ **R4.2 — LANDED (ae0fadb7).** `rejoin` (`src/compiler/rel/lower/scoped.ts`) reads the total switch
   `rowResident` (`src/compiler/rel/framing.ts`), so variant and property payloads ride the per-traverser rejoin.
   Corpus ladder-only answers went 5 → 0. Remains: P1.
5. **P1 — a regression R4.2 (ae0fadb7) introduced; in scope under rule 1.** In default mode, two shapes moved from
   the ladder to the connector and got slower. Both still scale linearly.
   - `g.V().hasLabel('person').map(__.choose(__.values('age')).option(P.between(26,30), __.values('name').fold())
     .option(Pick.none, __.values('name').fold())).count()`: 6.1/45.6 ms → 7.7/59.6 ms at 1k/8k (1.31× at 8k).
     Cause: the per-scope first-row window (`map-variant-window`, outstanding-work §4).
   - `g.V().local(union(values('name'), out())).dedup().count()`: 3.8/31.0 → 5.2/42.4 ms (1.37×), and the plan
     goes from 2 to 3 joins. The cause is not yet separated (first-row window vs. the rejoin join itself), so
     measure that first.
   - Prerequisite, ordered first: **P1a — an exclusive-arm bound on the choose merge in `src/rel/bounds.ts`**, so
     that `rowBounds` knows option arms are exclusive per traverser and `firstRow` drops the window. Then re-time
     both witnesses against the trunk before ae0fadb7; the bar is ≤1.3×.
6. **R4.5 — a body that draws over a re-source (`ladderOwns`) is answered only by the ladder, and L9 cannot see it.
   PARKED, needs-human (R4.5-Q below).** Witness: `g.V().hasLabel('person').local(__.V().hasLabel('software')
   .sample(1))`. Without a fix, R7 turns it into a decline (a lost answer). Options: (A) the connector owns it with
   a correlated per-traverser form and `ladderOwns` is deleted; (B) the ladder's code for this one shape is kept as
   a named non-ladder route that the connector calls. No branch to resume.
7. **R4.6 — find ladder-only answers OUTSIDE the corpus.** This is a shared prerequisite for R7 and has the same
   root cause as R4.5: L9's pool is only the corpus. Run a one-off `MOGWAI_CONNECTOR_ONLY=1 mise run test` sweep and
   compare each extra decline against default mode. A real lost answer becomes its own item before R7; anything
   else gets a §4 line. Known witness, from the R4.2 review, on CREW:
   `g.V().hasLabel('person').map(__.properties('location').order().by(T.value)).project('v','s').by(T.value)
   .by('startTime')`. It declined on trunk. It now answers correctly in default and ladder mode
   (`{v:brussels,s:2004}`, `{centreville,1990}`, …) but still declines in connector-only mode. The likely reason is
   that the connector feeds a property traverser to `project().by(T.value).by('startTime')` and the ladder answers
   that part. Fix the connector's `project().by` over a property host before R7.
8. **R7 — delete the switch. DEFERRED** until R4.5 lands (A or B) and R4.6's sweep is triaged with zero real lost
   answers. Then delete `correlatedChild` and its readers, L5's per-switch entry, and
   `FastPathConfig.connectorOnly` (connector-only becomes the only mode). L9's connector-only ratchet becomes the
   ordinary coverage ratchet, and F1's `agreed()` ladder half goes. Update root `CLAUDE.md` decision 6 and
   `src/compiler/CLAUDE.md`.

## Next round

- The reuse-sweep proposal (gate `map()`'s two correlated first-row forms in `firstInnerOver` on `rowResident`, not
  `framingCols`) is filed in `docs/outstanding-work.md` "Next round — reuse sweep", per scope rule 4.
- This round's depth gaps were already present and are not ladder-only, so they went to outstanding-work §4.

## Guards

- `mise run ladder`: ladder files may not grow.
- L9: connector-only closure may not fall; ladder-only answers may only fall; every host is a row or a classified
  deferral.


## Owner questions (open)

**R4.5-Q** (verbatim): Some queries still get their answer only from the ladder, and L9 does not count them: a
random draw over a re-source inside local/flatMap, such as
`g.V().hasLabel('person').local(__.V().hasLabel('software').sample(1))` ('a random pick per user'). R7 would make
them decline. Do you want (A) the connector to own them with a correlated per-traverser form, which deletes
`ladderOwns`, or (B) the ladder's code for this one shape kept as a named non-ladder route the connector calls?
Either way, should R7 be gated on a one-off `MOGWAI_CONNECTOR_ONLY=1 mise run test` sweep showing no other lost
answers?

**U1-Q** (verbatim): You leaned towards (b) then (a). Measured on the conformance and workload sample graphs: (b) is
quadratic at an out-hub (264→3744 ms going from 2k to 8k out-edges). (a) makes real air-routes queries about 50%
slower than trunk (7.3→10.8 s), which is the kind of regression this plan forbids its own commits to introduce. On
grateful-dead and air-routes, today's T1 plan is already 1.5–3.5× faster than before T1. The vocabulary cost only
appears with hundreds of labels. Which do you want?
(d) A `labels.edge` flag kept by the schema's first trigger plus a migration. Faster everywhere measured, and it
fixes the 300-vertex-label case. It does not fix 300 edge labels.
(e) Accept T1 as is, file one §1b line, and close U1.
(a) as decided, accepting the real-graph slowdown.
Either way I will keep the real-graph witnesses as a one-off comparison script.
