# Retiring the correlated-child ladder

_Status: IN PROGRESS. Round 10 (2026-11-19) landed F1 and R4.2. Owner then answered U1 (→ S1/S2) and R4.5 (A),
raised the regression bar to 2×, and added G1.
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

## Where we are (2026-11-19)

- The connector is the DEFAULT at every child site. The ladder is the opt-in `correlatedChild` FastPath; its code is
  `src/compiler/rel/lower/per-traverser.ts` alone. `group` is `LADDERLESS` and its dead ladder arms are deleted.
- **Ladder-only answers in the corpus: 0** (from 66; CI ratchet `test/L9-connector/ladder-reach-baseline.json`).
  R4.2 (ae0fadb7) closed the last 5. **R7 is NOT yet unblocked**: L9 counts corpus traversals only, so it cannot see
  (i) bodies that draw over a re-source (`ladderOwns`, R4.5) or (ii) ladder-only answers outside the corpus (R4.6).
  Both must be closed, or kept as a named non-ladder route, first.
- Landed: R0–R3, R4.1/R4.3/R4.4, R5.1–R5.5, R6 side effects, pooled keyed `group('a')` in arms/bodies (95334eb3);
  regressions/wrong answers V0+U3 (911eef32), V1 (77eb86cb, b09dee81), V2 (33356b80), V3 (75ad576d),
  V4 (1ef9b707), V5 (b600fc15); F1 pins V4's answers (f5d2a6bc); F2 exact depth bag (34674e92); R4.2 (ae0fadb7).

## Remaining work, in order

1. ✅ **F1 — LANDED (f5d2a6bc), tests only.** Pins V4's per-traverser `count(local)` group values
   (`test/compiler/group-ladderless.exec.test.ts`, GroupStep.java:123-126). Remains: nothing (F2 landed).
2. ✅ **F2 — LANDED (34674e92), tests only.** F1's `project('g').by(out().group().by(label).by(…count(local)))`
   depth case now asserts the exact bag of each traverser's `g` map — `{person:1}` ×1, `{}` ×5
   (`test/compiler/group-ladderless.exec.test.ts`, GroupStep.java:123-126), on the plain run, not `agreed()`.
   Remains: nothing.
3. **U1 — `edgePair` costs |label vocabulary| per probe (regression from T1, 1274c293). DECIDED (owner,
   2026-11-19): fix it in the SCHEMA — see S1.** Step 1's measurement (full text at 87400956) ruled out (b)
   (quadratic at an out-hub, 264 → 3744 ms at 2k → 8k out-edges) and (a) (air-routes 7.3 → 10.8 s). The owner's
   call: we are pre-v1 with no users, so a schema split is cheap and is the mechanically sympathetic fix. Once S1
   lands, whatever cost remains (e.g. 300 EDGE labels) is accepted: one §1b line, U1 closed. Keep the real-graph
   witnesses as a one-off comparison script; add the 300-label row to
   `test/compiler/walk-condition-hub-scale.exec.test.ts`.
4. ✅ **R4.2 — LANDED (ae0fadb7).** `rejoin` (`src/compiler/rel/lower/scoped.ts`) reads the total switch
   `rowResident` (`src/compiler/rel/framing.ts`), so variant and property payloads ride the per-traverser rejoin.
   Corpus ladder-only answers went 5 → 0. Remains: P1.
5. ~~P1~~ **DROPPED (owner, 2026-11-19).** R4.2's 1.31× / 1.37× slowdowns are linear and inside the new 2× bar.
   P1a (an exclusive-arm bound in `bounds.ts`) is not built for it; one §1b line if not already filed.
6. **R4.5 — a body that draws over a re-source (`ladderOwns`). DECIDED (owner, 2026-11-19): (A).** The connector
   owns it (decorrelated per scope row, like every other drawing body) and `ladderOwns` is deleted. Witness:
   `g.V().hasLabel('person').local(__.V().hasLabel('software').sample(1))` — one independent pick per person.
7. **R4.6 — find ladder-only answers OUTSIDE the corpus.** This is a shared prerequisite for R7 and has the same
   root cause as R4.5: L9's pool is only the corpus. Run a one-off `MOGWAI_CONNECTOR_ONLY=1 mise run test` sweep and
   compare each extra decline against default mode. A real lost answer becomes its own item before R7; anything
   else gets a §4 line. Known witness, from the R4.2 review, on CREW:
   `g.V().hasLabel('person').map(__.properties('location').order().by(T.value)).project('v','s').by(T.value)
   .by('startTime')`. It declined on trunk. It now answers correctly in default and ladder mode
   (`{v:brussels,s:2004}`, `{centreville,1990}`, …) but still declines in connector-only mode. The likely reason is
   that the connector feeds a property traverser to `project().by(T.value).by('startTime')` and the ladder answers
   that part. Fix the connector's `project().by` over a property host before R7.
   **Owner (2026-11-19): run the sweep. A WRONG answer is fixed (or, if the fix is not small, turned into a clean
   decline). A LOST answer is fixed if small, else accepted as a decline with a §4 line — it does not block R7.
   A slowdown inside 2× does not block R7.**
8. **R7 — delete the switch.** After R4.5 (A) lands and R4.6's sweep shows no wrong answers (owner: get rid of the
   ladder; a small regression or a deferred lost answer is acceptable). Then delete `correlatedChild` and its readers, L5's per-switch entry, and
   `FastPathConfig.connectorOnly` (connector-only becomes the only mode). L9's connector-only ratchet becomes the
   ordinary coverage ratchet, and F1's `agreed()` ladder half goes. Update root `CLAUDE.md` decision 6 and
   `src/compiler/CLAUDE.md`.
9. **S1 — split the label vocabulary by element kind (fixes U1; owner, 2026-11-19).** `labels` (`src/storage.ts`)
   holds vertex AND edge labels in one table, so `edgePair`'s `label IN (SELECT id FROM labels)` probes vertex
   labels it can never match. Split it (two vocabularies, or a kind column with an index that leads on it — the
   builder measures and picks the simpler). Pre-v1, no users: change the schema directly, no migration. Re-time U1's
   rows (3/300 labels, out-hub, air-routes, grateful-dead) and record absolute ms.
10. **S2 — survey for other simple structural splits (owner, 2026-11-19). REPORT ONLY; the owner decides.** Is there
   another cheap schema split that halves (or better) what an index seek or scan reads — more schema in exchange for
   leaning harder on SQLite? Check every table and index in `src/storage.ts` against the shapes the lowering
   actually emits. Known candidate to assess first: property keys are `key TEXT` on every
   `vertex_properties`/`edge_properties` row and lead `vp_key_value`/`ep_key_value` — not interned the way labels
   are. Report each candidate with what it splits, measured index size and seek cost before/after on the sample
   graphs, and the code it touches. Do not build.
11. **G1 — does each performance change EARN ITS KEEP? (owner, 2026-11-19).** NOT a blanket "remove what only
   got us under 1.3×". For each change this plan made for performance (V0+U3 911eef32, V1 77eb86cb/b09dee81, V2
   33356b80, V3 75ad576d, V5 b600fc15, T1 1274c293), weigh the measured win against the code complexity it added:
   - It made the code simpler or no more complex, or bought a large win (e.g. well below the pre-change cost, or a
     super-linear shape made linear): it earns its keep. Keep it.
   - It added substantial code for a marginal win (removing it keeps every answer and stays within 2× of the trunk
     before that commit): it does not earn its keep. Simplify or remove it.
   - Report each with its witnesses before/after in ms, the lines it added, and the verdict with a one-line reason.
     Wrong-answer fixes are never removed.

## Next round

- The reuse-sweep proposal (gate `map()`'s two correlated first-row forms in `firstInnerOver` on `rowResident`, not
  `framingCols`) is filed in `docs/outstanding-work.md` "Next round — reuse sweep", per scope rule 4.
- This round's depth gaps were already present and are not ladder-only, so they went to outstanding-work §4.

## Guards

- `mise run ladder`: ladder files may not grow.
- L9: connector-only closure may not fall; ladder-only answers may only fall; every host is a row or a classified
  deferral.


## Owner questions (open)

None. R4.5-Q (A; sweep yes; regressions inside 2× accepted) and U1-Q (schema split S1, plus survey S2) were answered
2026-11-19 and are written into their items.
