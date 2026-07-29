---
name: update-outstanding-work
description: Refresh docs/outstanding-work.md — the project's open-work index. Re-runs L3 for current conformance candidates, probes the ceiling with L5-random across several seeds, reads the five committed test baselines (l3-state, census TSVs, the two L5 ratchets) for parked defects, fans out agents to sweep newer docs and audit technical-debt/generic-substrate opportunities, merges findings into the index, reprioritizes, and archives completed plans. Use when the user asks to update/refresh/re-sweep the outstanding work, backlog, or work index, or after a batch of work lands and the index has gone stale.
---

# Update the outstanding-work index

`docs/outstanding-work.md` is the de-duplicated index of every open "future thing" across the
`docs/` corpus. It is a **pointer list, not a spec** — each item sets the scene (what · why · what
it unblocks · where to start) and links to its source doc; the agent that later *picks* an item
does the detailed validation and design. This skill refreshes it.

Keep the same voice and structure the file already has. Read it first — do not restructure it.

## The prime directive — floor vs ceiling

This ordering principle governs prioritization; preserve it and use it to rank.

- **L3 is the floor** — documented scenarios that pass. Not the goal.
- **The ceiling** is generic lowering that composes the full nested Gremlin grammar at any valid
  depth/combination (see `src/compiler/steps/CLAUDE.md`).
- A one-off "implement step X for exactly the failing scenario" raises the floor by one; extending
  the **generic seam** so a whole family of nested compositions lowers at once raises the ceiling —
  and the floor follows for free.
- So **P1 = ceiling-raising generic-substrate lifts** (each unblocks a *family*). One-off step
  implementations are lower — matrix-fill, not ceiling-raising. The largest L3 deferral buckets
  (`local`/`where`/`choose`/`map`/`by(traversal)` child shapes) are almost always ceiling gaps.

## The committed test baselines ARE inputs to this index

Five artifacts record known-bad state. **A defect parked in any of them must also appear in the
index** — per `test/CLAUDE.md`, a finding that stays only in a ratchet is *tracked, not defended*, and
a ratchet is where an open defect goes to be forgotten. Read all five every refresh:

| Artifact | What it parks | Failure mode to look for |
|---|---|---|
| `test/L3-conformance/l3-state.json` | the passing floor | count moved; `passed` shrank |
| `test/census/deferrals.tsv` | 873 throwing traversals, **17 `crashed`** | a `crashed` row absent from the index (fail-closed VIOLATIONS) |
| `test/census/goldens.tsv` | 1,425 executing + result digest | — (a two-way baseline; the census gate owns it) |
| `test/L5-properties/known.ts` | fast-path divergences, one per ROOT CAUSE | a diagnosed entry with no index line |
| `test/L5-properties/capability-baseline.ts` | `KNOWN_RAW_WITNESSES` — raw failures reached by generated compositions | same; these are usually malformed SQL or a bind rejection |

Plus one that is easy to miss because it is not a file of its own: **the `knownBroken` entries inside
`test/L5-properties/laws.ts`**, keyed on a prefix RegExp with a prose diagnosis. Those are
metamorphic-law violations — silent wrong answers, the highest-severity class in the whole ladder.

`crashed` count and the two L5 lists are the cheap greps:
```
awk -F'\t' '$1=="crashed" {print $2}' test/census/deferrals.tsv | sort | uniq -c | sort -rn
grep -n "query:\|diagnosis:" test/L5-properties/known.ts
grep -n -A3 "knownBroken" test/L5-properties/laws.ts
```

## Workflow

Run the investigations in parallel (`mise run L3` and `mise run L5-random` in the background, two
subagents), then merge. Track with TaskCreate if the runs are long.

### 1. Refresh L3 (current candidates + areas)

```
mise run L3          # ratcheted; writes test/L3-conformance/l3-telemetry.summary.json + l3-state.json
```

Then read the telemetry (NOT the raw run log — it's huge):
- `l3-state.json` → `passing` / `total`. **Gotcha:** `len(passed) > len(set(passed))` is EXPECTED
  and correct — distinct TinkerPop scenarios normalize to the same name across feature files
  (e.g. one traversal is a scenario in both `HasKey.feature` and `HasValue.feature`). Report the
  unique count too, but do NOT treat the difference as a ratchet bug (documented in `test/CLAUDE.md`;
  it has been misdiagnosed more than once).
- `l3-telemetry.summary.json` → `buckets` (deferral reasons by frequency) and `clusters`
  (contiguous failing areas — "biggest N× near the size" means one fix clears the cluster). The
  top buckets by count are your P1/P2 candidates.

### 1b. Probe the ceiling with L5-random (the instrument L3 structurally cannot be)

**L3 measures the floor; L5 measures what COMPOSES.** CI runs L5 at a fixed seed, which is by design
(a flaky property test gets disabled) but means it is *a deterministic generated corpus* that discovers
nothing after its first run. So this skill must run the exploration:

```
mise run L5-random   # random seed, 3000 traversals; NOT a CI gate — expect it to be red
```

A single red run tells you little; **run 3–5 FIXED seeds instead**, so findings are reproducible and
you can cluster them by cause rather than by seed:
```
for s in 5 11 27 91 143; do L5_SEED=$s L5_RUNS=3000 bun test test/L5-properties 2>&1 \
  | grep -E "^\(fail\)|Counterexample"; done
```
(Bare `bun test` is acceptable here *only* because `mise run L5-random` already ran and satisfied the
`check`/`submodule` deps in this same session — otherwise use the mise task.)

Reading the output, in this order:

1. **`fc.assert` shrinks — trust the shrunk `Counterexample`, not the first "Encountered failure".**
   The shrunk line is minimal and is what you diagnose.
2. **Classify by divergence `kind` before anything else.** `GATING` is `{support, multiset}`
   (`oracle.ts`). `multiset` = a genuine **wrong answer**, top severity. `support` = *"generic threw,
   fast paths ON ran"* — NOT a wrong answer, but still a defect: it means a fast path answers where the
   generic path (the declared semantic authority) has no lowering, which `FastPathConfig`'s contract
   forbids. `order` is telemetry and never gates.
3. **Attribute it.** The `each fast path in isolation` tests name the switch. Confirm with
   `gatingDivergences(mint, q, onlyDisabled('<name>'))` — an empty result means that switch is *not*
   the cause, which is how you tell two co-occurring causes apart.
4. **Reproduce standalone before filing, and compare the RIGHT pair.** Comparing `ALL_GENERIC` vs `{}`
   with `outcomeOf` can look identical while `gatingDivergences` reports a real `support` divergence —
   call `gatingDivergences` directly. (This wasted a cycle on 2026-07-29.)
5. **Then narrow the rule by hand.** Vary one step at a time to find the boundary; that boundary is
   the item. E.g. 2026-07-29: `dedup()`/`limit(n)` *followed by another step* in a filter-position
   child body diverges, while `order()`/`tail(n)` followed by a step does not, and a barrier as the
   LAST step is fine — a far more useful item than "where() sometimes diverges".
6. **A `table.test.ts` failure is a TABLE bug, never a compiler one** — the generator emitted invalid
   Gremlin. Its cost is silent (those traversals always throw, emptying differential coverage rather
   than failing anything), so file it as instrument integrity. Check arity against
   `vendor/tinkerpop/gremlin-language/src/main/antlr4/Gremlin.g4`.

File each cause as ONE item (never one per seed or per traversal), and note in the index that the
process gap — no scheduled random-seed run — is itself the item, since otherwise this rots again.

### 2. Sweep newer docs (subagent, `general-purpose`)

Point it at the docs added/changed since the index's last-refreshed date (compare the header date
to `git log`/mtimes under `docs/`). Have it: read `docs/outstanding-work.md` first so it doesn't
re-report captured items; for each newer doc, give a status verdict (COMPLETED / PARTIALLY-DONE /
RESEARCH-VISION / SUPERSEDED) and extract only OPEN items not already indexed, each with a
one-sentence scene-set. It may use a **quick, cheap grep** to settle an obvious "does this symbol
still throw / exist" question, but do NOT commission an exhaustive doc-vs-code audit — that is out
of scope for this skill (too expensive). Trust the doc self-reports otherwise; the agent that later
picks an item validates it against code then.

### 3. Audit technical debt / generic-substrate (subagent, `general-purpose`)

Point it at `src/compiler/`, `src/compiler/steps/`, `src/sql/`, `src/execute.ts` and
`src/compiler/steps/tail/materialize.ts` (read the nested `CLAUDE.md`s first). Also hand it
`docs/2026-07-28-shape-vocabulary-architecture.md`, which **refutes three cross-layer refactors** and
states the bright line (*a Pass may CONSULT shape; it may never CONSTRUCT it*) — tell it not to
re-propose those. Ask specifically for **places the
substrate/lowering could be made more generic** — steps hand-rolling similar SQL that could route
through a shared seam, fast-paths duplicating the general path, shapes special-cased where a generic
mechanism exists — plus hard `throw` deferrals and TODO/FIXME. **Expect zero TODO/FIXME markers**:
debt here is encoded as typed `throw` deferrals and prose, so ask it to cluster the throw sites by ROOT
CAUSE and say which clusters ONE generic lift would clear. Ask for a measured
**(shape × row-op) matrix** if it is auditing the shape tails — a counted matrix turned "67 per-step
failures" into one ceiling item in 2026-07-29. For each finding: title, file+lines,
what the duplication/debt is, whether generalizing is a mechanical lift or an architectural change
(say why), and leverage (unblocks features vs maintainability-only). Highest-leverage first. These
feed P1 (ceiling) and the internal-debt section.

### 4. Merge into the index

- **De-dupe** against what's already there; fold residuals of now-landed items down to their real
  (lower) priority rather than deleting the history.
- **Reprioritize** the whole list under the floor-vs-ceiling frame (§ above). A generic-substrate
  lift that unblocks a family and/or another item outranks a one-off.
- **Keep each item terse** — scene-set + `→ links`, not a spec. If you're restating the source
  doc, cut it. (We deliberately shrank this file once; don't re-inflate it.)
- **Correct stale self-reports** the sweep/audit surfaced in passing (e.g. an item marked open that
  a cheap check showed landed) — but don't go hunting; a full doc-vs-code reconciliation is not part
  of this refresh. Mark freshly-landed work `✅` with residual follow-ons left listed.
- Update the **last-refreshed** line (date + L3 count) and the restructure-path note if paths moved.

### 5. Archive completed plans

Move a plan to `docs/archive/` when it is either (a) fully COMPLETED/LANDED, or (b) has only MINOR
tails AND those tails are now carried into the index with enough detail. **Keep** in top-level
`docs/`: research/vision docs, and the design-of-record for any OPEN P1/P2 item (an agent picking
that item will read it — even if the plan is partly landed).

For each move: `git mv docs/X.md docs/archive/` then **repoint every inbound link** — search all
`*.md` (docs + `CLAUDE.md` files), `src/` code-comment pointers, and `.claude/`. Forms to fix:
- `docs/X.md` (prose/backtick) → `docs/archive/X.md`
- `](./X.md)` (markdown link, from a top-level doc) → `](./archive/X.md)`
- from a doc already inside `archive/`, a link to a kept top-level doc needs `../`

Then verify **zero broken links** before finishing (resolve every `](./…​.md)` relative to its
file's own dir; check every `docs/…​.md` prose path exists).

## Guardrails

- Run **`mise run L3`** / **`mise run L5-random`**, never bare `bun test` as the entry point (see
  `test/CLAUDE.md`).
- Read telemetry JSON, never tail the full L3 log into context. L5's logs ARE small enough to grep —
  filter to `^\(fail\)` and `Counterexample`.
- **`mise run L5-random` being red is the expected state, not a blocker** — it is deliberately outside
  `ci`. Diagnose and file; do not "fix" it by adding ratchet entries, and never add an entry to
  `known.ts` / `capability-baseline.ts` without a diagnosis (the header of each forbids it) or without
  a matching index line.
- **Never silence a baseline to make a run green.** Do not hand-edit `l3-state.json`'s `passed`, and do
  not `census-record` as part of this skill — the census is deliberately not auto-recording because its
  most dangerous transition is *still runs, different answer*, and re-recording launders exactly the
  regression it exists to catch. This skill READS baselines; only real work changes them.
- The index tracks compiler features AND the product/ops track AND internal debt/give-backs AND a
  Superseded/won't-do section (so nobody re-opens a closed question) AND a research/vision section.
  Preserve all of them.
- Report counts you actually measured, and say which instrument measured them. "L3 1511" and "the
  matrix is 55/100" are useful; an unattributed number is how this index went stale in both directions
  before.
- This is a docs change. If you touched `src/` comments while repointing links, run
  `bunx tsc --noEmit` before handing off. Commit is the user's call. Delete any scratch probe files you
  wrote in the repo root.
