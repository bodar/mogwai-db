---
name: update-outstanding-work
description: Refresh docs/outstanding-work.md — the project's open-work index. Re-runs L3 for current conformance candidates, fans out agents to sweep newer docs and audit technical-debt/generic-substrate opportunities, merges findings into the index, reprioritizes, and archives completed plans. Use when the user asks to update/refresh/re-sweep the outstanding work, backlog, or work index, or after a batch of work lands and the index has gone stale.
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

## Workflow

Run the three investigations in parallel (one `mise run L3` in the background, two subagents),
then merge. Track with TaskCreate if the run is long.

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

Point it at `src/compiler/`, `src/compiler/steps/`, `src/sql/`, `src/execute.ts`,
`src/materialize.ts` (read the nested `CLAUDE.md`s first). Ask specifically for **places the
substrate/lowering could be made more generic** — steps hand-rolling similar SQL that could route
through a shared seam, fast-paths duplicating the general path, shapes special-cased where a generic
mechanism exists — plus hard `throw` deferrals and TODO/FIXME. For each finding: title, file+lines,
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

- Run **`mise run L3`**, never bare `bun test` (see `test/CLAUDE.md`).
- Read telemetry JSON, never tail the full L3 log into context.
- The index tracks compiler features AND the product/ops track AND internal debt/give-backs AND a
  Superseded/won't-do section (so nobody re-opens a closed question) AND a research/vision section.
  Preserve all of them.
- This is a docs change. If you touched `src/` comments while repointing links, run
  `bunx tsc --noEmit` before handing off. Commit is the user's call.
