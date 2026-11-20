# Retiring the correlated-child ladder

_Status: IN PROGRESS. Round 12 (2026-11-20) landed item 10's three decided builds: (5) 73616a6b, (3) 22b79ae5 and
the `sql-plan.ts` scan check d64a6d3a; review's tooling follow-ups on the scan check (10a) landed 4a1e42a8. Round 11 (2026-11-19) landed S1 (6793d40a), F2 (34674e92) and the S2 survey (39a8f01a).
R4.5 was PARKED: it made two quadratic shapes reachable and lost some path answers (see 6a–6c). So R7 and G1 were
deferred. Round 10 landed F1 and R4.2; the owner answered U1 (→ S1/S2) and R4.5 (A), raised the bar to 2×, and
added G1.
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
  bodies that draw over a re-source (`ladderOwns`). **The one blocker left is R4.5, and it now waits on 6a and
  6b.** R4.6 (the sweep outside the corpus) is merged into R7: the deletion's own suite run is the sweep.
- Landed: R0–R3, R4.1/R4.3/R4.4, R5.1–R5.5, R6 side effects, pooled keyed `group('a')` in arms/bodies (95334eb3);
  regressions/wrong answers V0+U3 (911eef32), V1 (77eb86cb, b09dee81), V2 (33356b80), V3 (75ad576d),
  V4 (1ef9b707), V5 (b600fc15); F1 pins V4's answers (f5d2a6bc); F2 exact depth bag (34674e92); R4.2 (ae0fadb7);
  S1 `e_pair` index, `edgePair` pass deleted (6793d40a); S2 survey, report only (39a8f01a); S2 builds: TextP
  trigram probe (73616a6b), `e_label` index (22b79ae5), `sql-plan.ts` scan check (d64a6d3a).

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
6. **6a–6c share ONE root cause.** On the parked branch, the connector's drawing pick (`reSourcedOnce`,
   `drawnPerOrigin` and `pickAt` in `src/compiler/rel/lower/reduction.ts`) has two limits. It recognises a draw
   only in a narrow literal spelling, and it refuses an input that carries a path or sack channel. Every miss
   falls to the scope × read fold. Trunk declined these shapes through `ladderOwns`. With `ladderOwns` deleted
   they become reachable and run quadratic, or they lose answers the ladder gave. So the substrate comes first
   (6a, 6b), then R4.5 lands again (6c).

   6a. ✅ **LANDED (d19d6f6e, d4406e18, e4c03ba8).** The per-origin draw and a forward re-source under a tracked path carry the origin's path and sack as GraphStep's split does: one shared read crossed with the hosts, the path extended by one position after the cross (`splitInto`/`splitPosition`, `src/compiler/rel/lower/movement.ts`), gated by the one `splitRefuses(input, keepsPosition(prefix))` authority; a stream barrier after a move, or a bounding slice after a host-reading step, declines with the resource-path reason. All witnesses below linear (≈7× per 8×). Remains: nothing.
   ~~R4.5a — carry the origin's PATH and SACK channels across the re-source cross and the pick~~ (before 6c).
   Do it the way the plain re-source cross already carries them, instead of refusing them in `drawsOver`. This
   fixes blocker 1 and restores the lost answers below.
   - Blocker 1 (79×, newly reachable): `g.V().hasLabel('holder').as('h').map(__.V().hasLabel('person').order()
     .by(shuffle).limit(1)).path().count()` takes 1,658 ms at N=1k and 131,226 ms at N=8k (26 / 32 ms without
     `path()`). Same class: `g.withSack(1).V().hasLabel('holder').map(__.V().hasLabel('person').order()
     .by(shuffle).limit(1)).sack().sum()`. Trunk 03920cc8 declined both at once with the shared-draw message.
   - Lost answers. Trunk answered these through the ladder; the parked commit declines them with 'a V()/E()
     inside local() on a traverser whose path is tracked': `g.V().local(__.V().sample(1)).path().count()`,
     `g.V().as('a').local(__.V().sample(1)).path().count()`, `g.V().local(__.V().hasLabel('software').sample(2))
     .path().count()`, `g.V().out().local(__.V().sample(1)).path().count()`, `g.V().local(__.V().sample(1))
     .path().by('name')`, `g.V().local(__.V().sample(1)).simplePath().count()`,
     `g.V().hasLabel('holder').local(__.V().hasLabel('person').sample(1)).path().count()`. They were quadratic on
     trunk too (454 ms → 31.7 s), so once the channels are carried the bar is linear. A non-drawing
     `local(__.V()…).path()` declines on trunk for the same reason, and this item should fix it too.

   6b. ✅ **LANDED (157d7ad0).** A global `order().by(shuffle)` cut to exactly one member (read through `sliceOf`/`countOf`, a bound `$x` reduced at plan time) is canonicalized to `sample(1)` by one Pass, `src/compiler/ir/shuffle-cut.ts` (`shuffleCutToSample`), at every depth; `reSourcedOnce`'s draw then serves it. Remains: nothing.
   ~~R4.5b — the pick is a FACT, not a list of spellings~~ (before 6c). `pickAt` is a lookahead peephole: it
   matches `order().by(shuffle)` followed by a literal `limit(1)`, `range(0,1)` or `tail(1)`. Replace it with a
   rule: a RANDOM-collation sort that feeds a slice of cardinality 1. That can be a `Sort(RANDOM)` + `Limit 1` rel
   shape, or a canonicalizing pass gated on the unit-bulk fact (shuffle is unweighted, `sample` weights by bulk).
   Read the slice bound from a bound GValue at plan time, the last responsible moment. When n ≠ 1, keep rankPairs.
   - Blocker 2 (69×, newly reachable): `g.V().hasLabel('holder').map(__.V().hasLabel('person').order()
     .by(shuffle).limit(x)).count()` with `{x:1}` takes 1,107 ms at N=1k and 75,939 ms at N=8k. The literal
     `limit(1)` takes 26 / 32 ms. Sending a limit as a parameter is the normal TinkerPop 4 idiom, so this shape
     has to work.

   6c. **R4.5 — a body that draws over a re-source (`ladderOwns`). DECIDED (owner, 2026-11-19): (A). PARKED in
   round 11.** The connector owns it (decorrelated per scope row, like every other drawing body) and `ladderOwns`
   is deleted. Witness: `g.V().hasLabel('person').local(__.V().hasLabel('software').sample(1))`, one independent
   pick per person. **Resume point:** branch `wf/r4-5-connector-draw-over-resource-1-4` (4a5a40aa; earlier
   attempts `-1-0` d06e2a6d, `-1-2` 1cf7a9f1, `-1-3` 9702c97d). Rebase it onto 6a and 6b. When it lands again it
   must also do the following.
   - **Keep the specific decline reason.** With `ladderOwns` gone, a draw the connector cannot lower gets only
     'no lowering covers <query>'. Trunk said 'a random draw (sample/coin/shuffle) inside a V()/E() body is not
     supported where the body may run for more than one traverser…'. Witnesses: `g.V().map(__.V().coin(0.5)
     .count())`, `g.V().local(__.V().coin(0.5).count())`, `g.V().where(__.V().coin(0.5))`,
     `g.V().hasLabel('person').local(__.V().hasLabel('software').coin(1.0)).count()`,
     `g.V().local(__.V().sample(1).by('age'))`, `g.V().hasLabel('holder').map(__.V().hasLabel('person').fold()
     .sample(local,1)).count()`. Restore the `decline-reasons.exec.test.ts` assertions the branch deleted. Either
     the fold records the reason, or coin goes through the same per-scope keyed draw that sample uses.
   - **Keep one filter-fusion authority.** The branch's new loop in `reSource` (`src/compiler/rel/lower/movement.ts`)
     copies `lowerChainOf`'s PHASE-1 loop (`src/compiler/rel/lower.ts`). Make one helper,
     `fuseSourceFilters(steps, from, seeded, ctx, stop)`. The copy fuses only under `encounterOf(input.channels)`,
     so that a `has(k, select(…))` pair stays visible to `src/rel/passes/semijoin.ts`. That guard becomes a
     parameter of the helper, not a second authority.
   - **Add scale tests for the fall-through**, at 1k and 8k: `local(__.V().hasLabel('person').order().by('age')
     .limit(5).sample(1))` and `map(__.V()…sample(1)).path()`. Today only the counting-pick shape is timed.
   - **Do not land the branch's claim** (in `src/compiler/CLAUDE.md` and the `crossedRun` comment) that, with no
     position window, a run's filters "stay in the product, where SQLite pushes them". Measured false:
     `g.V().hasLabel('holder').V().hasLabel('person').has('age',1500).count()` takes 152 ms at 1k and 10,801 ms at
     8k (71×). This is pre-existing; it is filed in outstanding-work §1b.
7. **R4.6 — find ladder-only answers OUTSIDE the corpus. MERGED INTO R7 (round 11):** the deletion's suite run is
   this sweep, so it is not built on its own. The text below is what that run must check. This is a shared prerequisite for R7 and has the same
   root cause as R4.5: L9's pool is only the corpus. Run a one-off `MOGWAI_CONNECTOR_ONLY=1 mise run test` sweep and
   compare each extra decline against default mode. A real lost answer becomes its own item before R7; anything
   else gets a §4 line. Known witness, from the R4.2 review, on CREW:
   `g.V().hasLabel('person').map(__.properties('location').order().by(T.value)).project('v','s').by(T.value)
   .by('startTime')`. It declined on trunk. It now answers correctly in default and ladder mode
   (`{v:brussels,s:2004}`, `{centreville,1990}`, …) but still declines in connector-only mode. The likely reason is
   that the connector feeds a property traverser to `project().by(T.value).by('startTime')` and the ladder answers
   that part. Fix the connector's `project().by` over a property host before R7.
   ✅ **Known witness LANDED (be26dfa7, c8c7d7f4).** `reductionHost` answers the property framing and
   `recordLeft` passes it through, so the connector alone answers `project().by(…)` over a property row; the
   hand-built property `ChildHost` literals and `propertyTail`'s duplicate `project` record are gone, and
   `propertyTail` hands shape-keeping steps on through `continueAs` (`src/compiler/rel/lower/reduction.ts`,
   `scoped.ts`, `lower.ts`). Connector-only, 1k → 8k: 3.2×–5.8×, linear. Remains for this witness: nothing (the
   sweep itself still runs as part of R7).
   **Owner (2026-11-19): run the sweep. A WRONG answer is fixed (or, if the fix is not small, turned into a clean
   decline). A LOST answer is fixed if small, else accepted as a decline with a §4 line — it does not block R7.
   A slowdown inside 2× does not block R7.**
8. **R7 — delete the switch. DEFERRED in round 11; it now waits only on 6c (F2 landed).** R4.6 is merged into R7.
   After R4.5 (A) lands and R4.6's sweep shows no wrong answers (owner: get rid of the
   ladder; a small regression or a deferred lost answer is acceptable). Then delete `correlatedChild` and its readers, L5's per-switch entry, and
   `FastPathConfig.connectorOnly` (connector-only becomes the only mode). L9's connector-only ratchet becomes the
   ordinary coverage ratchet, and F1's `agreed()` ladder half goes. Update root `CLAUDE.md` decision 6 and
   `src/compiler/CLAUDE.md`.
9. ✅ **S1 — LANDED (6793d40a).** Measured both: a `labels` kind flag would still cost |edge labels| per probe and
   keep the pass, so the winner is an `e_pair(src, tgt)` index (`src/storage.ts`) whose prefix IS the label-free
   probe — one seek SQLite's own planner picks; `edgePair` (`src/rel/passes/edge-pair.ts`) is deleted. Re-timed (ms
   at 8×): 300 labels 779 → 16.0, `repeat(both()).times(2).where(…)` 54769 → 1267, air-routes 2986 → 684,
   grateful-dead 1338 → 869; bulk load +7–11%. Writes stay inside 2× (bulk addE 65 → 101 ms; 300 labelled mergeE
   3842 → 5403 ms at 8k). Both follow-ups ✅ LANDED (666ebf3e): `movement.ts` prose names `e_pair`; the 300-label
   test replaces the wall-clock ratio with a structural plan check on the wide graph (`e_pair (src=? AND tgt=?)`
   seek, no label index read, `classify` from `scripts/sql-plan.ts` flags only the root `V()`). Remains: nothing.
   - (a) Stale prose still names only `e_out`/`e_in`, but SQLite now also picks `e_pair (src=?)` for an unlabelled
     `out()` seek. `scripts/sql-plan.ts` and `src/sql/schema.ts` were fixed in round 12 (d64a6d3a, 22b79ae5);
     `src/compiler/rel/lower/movement.ts:319` remains.
   - (b) The new 300-label test in `walk-condition-hub-scale.exec.test.ts` asserts a wall-clock ratio below 2× on
     ~16 ms queries, which can flake on CI. Drop the ratio: the answer check and `expectLinear` already pin the
     behaviour.
10. ✅ **S2 — LANDED (39a8f01a), report only; nothing built.** Survey (below) of every `src/storage.ts` table/index
   against the emitted shapes. **DECIDED (owner, 2026-11-19): build (3), build (5), and fix the `sql-plan.ts` alias blindness;
   NOT (1) or (2).** The question was: build candidate 3 (the `edges(label)` index, one line of
   schema) and candidate 5 (the TextP full-text probe fix in `src/rel/passes/semijoin.ts`)? Optionally also fix the
   alias blindness in `scripts/sql-plan.ts`. Candidates 1 (interned keys) and 2 (full-text split by vertex/edge) are
   not recommended now.
   **(5) LANDED (73616a6b).** The positive TextP probe and `tinker.search` now seek `property_fts`'s trigram
   index (`INDEX 0:L4`) through a 2-argument `LIKE` built from the raw term, decoded by one helper
   (`src/rel/like.ts`, beside `likePattern`); the exact residual EXISTS still decides. `negativeOwners` kept its
   rowid seek by measurement (the 2-argument form made it `0:=L1`, super-linear). Remaining for (5): nothing.
   **Before building (5), from review:**
   - (a) A TextP argument can be a user parameter, so the probe pattern must be the expression `'%' || ? || '%'`,
     not a literal built at compile time.
   - (b) The trigram index seeks only for a literal of 3 or more characters, so `containing('ab')` still scans.
     The 32–230× win applies only to literals of 3+ characters.
   - (c) `negativeOwners` ties `property_fts` to each candidate by rowid, which is a per-row seek, not the trigram
     path. Measure it on its own (`g.V().has('name',TextP.notContaining('harl')).count()` on air-routes) rather
     than copying the positive fix, which could pull the planner off the rowid seek.

   **(3) LANDED (22b79ae5).** One schema line, `e_label ON edges(label)` (`src/storage.ts`, beside `vl_label`): a
   root `E().hasLabel(x)` now `SEARCH`es `e_label` instead of scanning `e_in`, at the root and inside any body; no
   lowering or emitted-SQL change. Reads 9–13× faster (air-routes `contains` count 1.64→0.117 ms); bulk load +3% at
   8k edges. Pinned by `test/compiler/edge-label-seek.exec.test.ts`. Remaining for (3): nothing.
   **Before building (3):** measure its own cost to `addE` and to bulk load. It would be a fourth index on
   `edges`, and the doc gives its cost only by analogy to `e_pair`.
   **Scan-check fix LANDED (d64a6d3a).** `scripts/sql-plan.ts` resolves each `SCAN <alias>` to its base table
   through the emitted SQL's FROM items (index cross-checked against `sqlite_schema`), classifies it by EQP-tree
   position (ROOT reported, NESTED ratcheted against `scripts/sql-plan-baseline.json`, an unconstrained
   `property_fts` scan gated at zero), and plans `call()` reads too. No compiled-SQL change. Remaining: nothing (10a landed).

   10a. **LANDED (4a1e42a8).** `scripts/sql-plan.ts` `classify()` now exempts a ROOT scan only for `nodes`/`edges`
   (any other root base-table scan is gated at zero), and gates at zero a base-table `AUTOMATIC` index and a nested
   `SEARCH` constrained only by a label/key prefix; `[tasks.sql-plan]` sources gained `parser/**/*` + `bunfig.toml`;
   the header's baseline prose names the 27th entry. Pinned by `test/sql-plan.test.ts`; baseline unchanged.
   Remaining for 10a: nothing.
   _Original brief:_ **Scan-check follow-ups from round-12 review (tooling only; no compiled SQL, no answer changes).** The
   gate the owner asked for still has holes. Each new gate costs nothing today (measured over all 1458 planned
   corpus reads on trunk d64a6d3a):
   - **(major) The ROOT exemption is too wide.** `classify()` exempts the first loop under its parent for EVERY base
     table, but the reason (a root `g.V()`/`g.E()` reads every element by meaning) holds only for `nodes`/`edges`.
     Witness: drop `vp_key_value` and `g.V().has('name','marko')` / `g.V().has('person','name','marko').out()` plan
     a full `SCAN vertex_properties`, classed `root:vertex_properties`, reported only, so `sql-plan` exits 0 — the
     most common index regression (a `has()` lookup) is invisible. Today the corpus has 988 root scans of `nodes`,
     30 of `edges`, 0 of anything else: gate a root scan of any other base table at zero.
   - **SEARCH is always treated as index-served.** Two disguised nested scans pass: an inner or CORRELATED
     `SEARCH` whose only constraint is a low-selectivity prefix (`e_label (label=?)`, `vp_key_value (key=?)`), and
     a base-table `SEARCH … USING AUTOMATIC [PARTIAL] COVERING INDEX` (SQLite builds it by scanning the table on
     every run). Witness: drop `e_out` and `e_pair`; `g.V(1).out('knows').values('name')` plans
     `SEARCH … e_label (label=?)` and `classify()` returns []; 278 corpus reads switch to an automatic index on
     `edges` unflagged. `e_label` (22b79ae5) is what makes this fallback available. Both occur 0 times on trunk:
     hard gate at zero.
   - **`[tasks.sql-plan]` sources omit `parser/**/*` and `bunfig.toml`** (`mise.toml`), which `sql-hygiene`'s
     identical compile-and-plan task lists, so `mise run generate` alone leaves the gate skipped locally. CI runs
     fresh. One line.
   - **The baseline's description is wrong.** d64a6d3a says all 27 entries are "a V() mid-traversal or inside a
     correlated set-operation argument"; one is neither (the `groupCount('a')…where(select('a')…)` query, filed in
     `outstanding-work.md` §1b as pre-existing super-linear). Correct the prose in `scripts/sql-plan.ts`'s header
     when the baseline is next re-recorded.
   _Original brief:_ survey for other simple structural splits (owner, 2026-11-19). Is there
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
11. **G1 — does each performance change EARN ITS KEEP? (owner, 2026-11-19). DEFERRED in round 11; it waits on 6c
   and R7** (S1 landed), so it weighs the code as it stands once the ladder is gone. NOT a blanket "remove what only
   got us under 1.3×". For each change this plan made for performance (V0+U3 911eef32, V1 77eb86cb/b09dee81, V2
   33356b80, V3 75ad576d, V5 b600fc15, T1 1274c293), weigh the measured win against the code complexity it added:
   - It made the code simpler or no more complex, or bought a large win (e.g. well below the pre-change cost, or a
     super-linear shape made linear): it earns its keep. Keep it.
   - It added substantial code for a marginal win (removing it keeps every answer and stays within 2× of the trunk
     before that commit): it does not earn its keep. Simplify or remove it.
   - Report each with its witnesses before/after in ms, the lines it added, and the verdict with a one-line reason.
     Wrong-answer fixes are never removed.

## Next round

- Order: 10a (tooling, cheap, independent) alongside 6a and 6b (6b landed 157d7ad0), then 6c (rebase the parked branch onto them), then R7 (its suite
  run is R4.6's sweep), then G1. Item 10's decided builds have all landed: (3) 22b79ae5, (5) 73616a6b, and the `sql-plan.ts`
  scan-check fix d64a6d3a.
- Round 11's reuse proposals are filed in `docs/outstanding-work.md` "Next round — reuse sweep", per scope rule 4:
  - fold mergeE's labelled both-endpoint seek arm into the unlabelled one, now that `e_pair` makes the pair one seek;
  - one shared test helper for "adjacency seek" plan assertions (`e_out` ↦ {`e_out`, `e_pair`}).
- Round 11 follow-ups outside this plan's scope went to outstanding-work:
  - §4: `union(project().by(…group…count(local)), constant(1))` declines;
  - §1b: a value join after a re-source is ×67, and a crossed run's filters are not pushed (×71);
  - §6: `sql-plan.ts` cannot see a full scan (fixed, d64a6d3a); a far-endpoint `hasId` is not pushed into `e_pair`'s `tgt`; a
    drawing body whose prefix does not depend on the origin still pays scope × candidates.
- The reuse-sweep proposal (gate `map()`'s two correlated first-row forms in `firstInnerOver` on `rowResident`, not
  `framingCols`) is filed in `docs/outstanding-work.md` "Next round — reuse sweep", per scope rule 4.
- This round's depth gaps were already present and are not ladder-only, so they went to outstanding-work §4.
- Round 12's reuse proposals are filed in `docs/outstanding-work.md` "Next round — reuse sweep", per scope rule 4:
  - one EXPLAIN-tree reader (`PlanRow`, alias resolution, loop-position walk) shared by `scripts/sql-plan.ts`,
    `test/support/snapshot-scans.ts`, `cte-runs.ts` and `sql-hygiene.ts`; adopting snapshot-scans' MATERIALIZE
    stop drops 5 of the 27 `sql-plan-baseline.json` entries (re-record in the same commit; take after 10a);
  - `tinker.search` builds one escaped `%term%` pattern and derives its probe via `likeProbePattern`, with an
    `escapedLike` beside `trigramProbe` in `src/rel/like.ts`;
  - one `property_fts` row type + `trigramCandidates` builder for `semijoin.ts` and `search.ts`;
  - plan-shape tests assert through the gate's classifier and one `explain()` helper.
- Round 12 follow-ups outside this plan's scope went to outstanding-work: §1b a side effect read in `where`
  re-derived per traverser (68×, pre-existing); §6 the FTS probe decoder (carry the raw term on the atom), the
  trigram seek's root-only reach, stale `storage.ts`/`src/services/CLAUDE.md` prose, and `e_label`'s one-time
  build on an existing DO's next `initSchema`. `hasLabel(P)` declining was already filed in §4.

## Guards

- `mise run ladder`: ladder files may not grow.
- L9: connector-only closure may not fall; ladder-only answers may only fall; every host is a row or a classified
  deferral.


## Owner questions (open)

None. Owner's round-12 request, verbatim — "#3 and #5: I'd build both. The broken scan check: I'd fix that
too." — is done (73616a6b, 22b79ae5, d64a6d3a). S2 answered 2026-11-19 (build 3 and 5, fix the scan check; not 1 or 2), written into item 10. R4.5-Q and
U1-Q were answered earlier the same day and are written into their items.
