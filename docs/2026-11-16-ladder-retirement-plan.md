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
3. ✅ **U1 — CLOSED by S1 (6793d40a).** The `edgePair` pass is gone; a label-free edge probe is one `e_pair` seek
   at any vocabulary (300 edge labels: 787 → 16.2 ms), so no residual cost needs a §1b line. The 300-label row is in
   `test/compiler/walk-condition-hub-scale.exec.test.ts`. Remains: nothing.
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
9. ✅ **S1 — LANDED (6793d40a).** Measured both: a `labels` kind flag would still cost |edge labels| per probe and
   keep the pass, so the winner is an `e_pair(src, tgt)` index (`src/storage.ts`) whose prefix IS the label-free
   probe — one seek SQLite's own planner picks; `edgePair` (`src/rel/passes/edge-pair.ts`) is deleted. Re-timed (ms
   at 8×): 300 labels 779 → 16.0, `repeat(both()).times(2).where(…)` 54769 → 1267, air-routes 2986 → 684,
   grateful-dead 1338 → 869; bulk load +7–11%. Remains: nothing.
10. **S2 — survey for other simple structural splits (owner, 2026-11-19). REPORT ONLY; the owner decides.** Is there
   another cheap schema split that halves (or better) what an index seek or scan reads — more schema in exchange for
   leaning harder on SQLite? Check every table and index in `src/storage.ts` against the shapes the lowering
   actually emits. Known candidate to assess first: property keys are `key TEXT` on every
   `vertex_properties`/`edge_properties` row and lead `vp_key_value`/`ep_key_value` — not interned the way labels
   are. Report each candidate with what it splits, measured index size and seek cost before/after on the sample
   graphs, and the code it touches. Do not build.

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
