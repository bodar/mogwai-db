# Retiring the correlated-child ladder

_Status: IN PROGRESS. Trimmed hard 2026-11-19 after round 9 (owner request). The full record — every round,
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
- **Ladder-only answers: 5** (from 66; CI ratchet `test/L9-connector/ladder-reach-baseline.json`): per-traverser 1,
  other 4 (option-map `choose` bodies under `local`/`map`, corpus.txt 515/516/2077/2078). All 5 decline at ONE line,
  `rejoin`'s `framingCols()` gate in `src/compiler/rel/lower/scoped.ts`, so they are one item, R4.2 — the last thing
  R7 waits on.
- Landed: R0–R3, R4.1/R4.3/R4.4, R5.1–R5.5, R6 side effects, pooled keyed `group('a')` in arms/bodies (95334eb3);
  regressions/wrong answers V0+U3 (911eef32), V1 (77eb86cb, b09dee81), V2 (33356b80), V3 (75ad576d),
  V4 (1ef9b707), V5 (b600fc15).

## Remaining work, in order

1. **F1 — pin V4's newly correct answers (tests only, cheap).** In `test/compiler/group-ladderless.exec.test.ts`'s
   V4 block, add: `g.V().as('a').out().group().by(select('a').values('name')).by(values('name').count(local))` →
   `{josh:1, marko:1, peter:1}` (trunk declined it before V4); and the key-dropped case
   `g.V().group().by(label).by(values('age').is(gt(30)).count(local))` → `{person:1}` with no `software` key
   (was `{person:2, software:0}`; a key whose value traversal yields nothing is omitted,
   `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GroupStep.java`
   :123-126). Both verified on trunk 11378285.
2. **U1 — `edgePair` costs |label vocabulary| per probe (regression from T1, 1274c293).** Large schemas only
   (`out().out().where(__.in().as('a'))` 22 → 759 ms at 300 labels; `repeat(out()).emit(where(__.in().as('a')))`
   136 → 2337 ms). **DECIDED (owner, 2026-11-19): measure, then (b) if it holds, else (a).** Ratios are not the bar
   here — absolute cost is: (a)'s ~3 µs per probe adds milliseconds on small schemas and is accepted.
   - **Step 1, a one-off measurement (not a CI gate):** compare trunk, (a) the correlated recursive loose scan and
     (b) `label IN (SELECT DISTINCT label FROM edges WHERE src = <fixed>)` on (i) the round-7 hub rows at 3 and 300
     labels, (ii) a pinned start vertex that is an OUT-HUB (10k–100k out-edges) — (b)'s unmeasured risk, it reads the
     whole out-neighbourhood per probe — and (iii) REAL queries over the conformance/workload sample graphs (L1
     corpus scenarios and L6 workload queries whose plans fire `edgePair` — find them by compiling the pools and
     checking for the pass's output). Report absolute ms, not only ratios.
   - **Step 2:** take (b) if it stays near trunk at the out-hub; otherwise (a). Add a 300-label row and (for the
     chosen form) an out-hub row to `test/compiler/walk-condition-hub-scale.exec.test.ts`.
3. **R4.2 — variant and property payloads through the per-traverser rejoin. Closes ALL 5 ladder-only answers.**
   **DECIDED (owner, 2026-11-19): option (c).** Relax `rejoin`'s `framingCols()` gate (`scoped.ts` ~1616) for
   variant/property only — record fields and every fixed-width consumer still decline. Before it lands, compare the 5
   ladder-only queries' answers VALUE BY VALUE against the ladder (the ladder is the reference while it exists): a
   pinned test, not only the L9 multiset check. Any difference stops and returns to the owner. The typed carrier
   later refactors working code; it is not a prerequisite.
4. **R7 — delete the switch**, once the ladder-only count is 0: `correlatedChild` and its readers, L5's per-switch
   entry, `FastPathConfig.connectorOnly` (becomes the only mode); L9's connector-only ratchet becomes the ordinary
   coverage ratchet; update root `CLAUDE.md` decision 6 and `src/compiler/CLAUDE.md`.

## Guards

- `mise run ladder`: ladder files may not grow.
- L9: connector-only closure may not fall; ladder-only answers may only fall; every host is a row or a classified
  deferral.

## Owner questions (open)

None. Q1 (U1) and Q2 (R4.2) were answered 2026-11-19 and are written into their items.
