---
name: execute-plan
description: Drive a plan doc to completion on trunk, autonomously. Given a plan.md (usually the first argument), verify each item against CURRENT code before touching it — the doc is a stale pointer, not a spec — then land items one at a time: mise run ci green, commit + push to trunk, update the doc as a local-only commit, watch that commit's CI async, and move to the next item. Increasing scope to build generic/compounding substrate or remove duplication is the default, not the exception. Only stop for a human design decision, a hard block, or when the work is genuinely done. Use when the user points you at a plan and asks you to execute / work through / grind / land it.
---

# Execute a plan on trunk

The user hands you a plan — normally `plan.md` as the first argument, occasionally another path or an
inline description. **The plan is a stale pointer, not a spec.** Parts of it are out of date the
moment it is written; the code is the authority. So the loop is *verify → land → advance*, never
*read the doc and do what it says*.

If no plan path was given, ask for one (or the section to work) — do not invent a backlog.

## Before the first item

1. **Land on current trunk.** `git fetch origin trunk` and rebase/reset your working state onto it.
   Trunk is the working branch (a web session cannot push anywhere else). Everything below assumes you
   are building on the real tip, not the shallow-clone stub.
2. **Read the plan once, end to end**, and read every `CLAUDE.md` in the subsystems it touches. Note
   which items look already-done, superseded, or wrong — you will confirm each against code at the
   moment you pick it up, not now.

## The per-item loop

For each logical item, smallest shippable unit first:

1. **Verify it's still real.** Check the claim against the code before writing anything — the step may
   already lower, the throw it cites may be gone, the file may have moved. If the item is stale, fold
   it down (mark it in the doc) and move on. A "fix" for a problem that no longer exists is the most
   common waste here.
2. **Build it at depth.** An implementation that only works at the top of a traversal, or only for the
   one scenario named, is not done — it is a matrix-fill masquerading as a lift. It must compose at any
   valid depth/combination in a query (the ceiling, per `docs/outstanding-work.md`'s floor-vs-ceiling
   frame). Prefer extending a generic seam so a whole family lowers at once over special-casing one
   shape. **If a deferral can be dissolved by widening the seam instead of throwing, widen the seam.**
3. **Cite the references.** Every semantics or lowering decision is grounded in upstream *at the pin*,
   cited as a checkable path: `vendor/tinkerpop/gremlin-core/...` (and `gremlin-language`,
   `gremlin-test`) for Gremlin's WHAT and WHY, `vendor/calcite/...` for algebra and rel→SQL lowering.
   In doubt about semantics, read the vendored reference — do not reason it out (CLAUDE.md, "Semantics
   traps").
4. **Prove it green.** Run **`bash scripts/ci.sh`** — its last line is the truthful `CI: PASS` /
   `CI: FAIL (exit N)`. Do NOT trust `mise run ci 2>&1 | tail`/`| grep`: a pipe drops the exit code and
   a red run reads green (this shipped a red commit once — CLAUDE.md, "Tooling"). If a task is red,
   `grep`/`Read` its `.logs/<task>.log` rather than re-running to re-scroll.
5. **Land the code on trunk.** Green → commit the code change with a clear message and
   `git push -u origin trunk`. A non-fast-forward comes back as `RPC failed; HTTP 403` with
   `! [rejected] … (fetch first)` — that is the ordinary concurrent-push race, not an access failure:
   `git fetch origin trunk`, read what landed, rebase, push again. **Never force-push trunk.**
6. **Update the plan, local-only.** Mark the item done / correct what you learned / adjust remaining
   items. Commit that doc change **locally, do not push it** — the plan is the working ledger, not
   trunk content.
7. **Watch that commit's CI async, and keep moving.** Kick off a background check of the pushed
   commit's GitHub Actions run (`mcp__github__actions_list` / `actions_get` / `get_job_logs` for the
   commit you just pushed) and immediately start the next item — do not block on the run. If it comes
   back red, fix-forward on trunk as its own item before it compounds; do not let a red trunk sit while
   you build on top of it.

## Scope is meant to grow

**Increasing scope is actively encouraged** — it is the point, not a risk to be managed — whenever the
larger move:

- builds **generic or compounding substrate** (a shared seam many items route through), or
- **removes duplication** (two steps hand-rolling the same SQL, a fast path re-deriving the general
  path).

**Blast radius is never, by itself, a reason not to do the principled thing.** An LSP rename costs the
same at 1,200 references as at 12 (CLAUDE.md, "Naming"); the type-aware tools (`scripts/refs.ts`,
`rename.ts`, `rename-batch.ts`, `move.ts`) exist precisely so reach is cheap. The only real questions
are *is it principled* and *does it compound* — if yes, take the wider cut even when it is bigger than
the item that revealed it.

## When to stop — and only then

Keep going autonomously. Stop and hand back **only** for:

- a **human design decision** — a genuine fork where either branch loses behavior or commits an API,
  and the code/references do not settle it. Use `AskUserQuestion` with enough context to answer without
  scrolling, then continue.
- a **hard block** — you are stuck (a failure you cannot root-cause, a missing capability, a dependency
  you may not add without approval per CLAUDE.md's working rules).
- **out of work** — every verified item in the plan is landed or dissolved.

Do not stop merely because an item got bigger, because the diff is wide, or because CI went red once —
those are work, not stopping points.

## Guardrails

- **Verify before you build, always.** The doc lies by omission and by age; the code and the vendored
  references are the authority.
- **`bash scripts/ci.sh` is the gate**, and its verdict line is the only truthful signal through a pipe.
- **Never force-push trunk**; a 403 with `(fetch first)` is a rebase-and-retry, not an incident.
- **No new dependencies** (runtime, dev, or a second build/test tool) without explicit approval —
  including defaults a skill or doc pulls in.
- **One spine, fail closed.** A traversal the RelIR lowering does not cover raises `UnsupportedTraversal`
  — a clear failure, never a silent different answer. Widen the lowering; do not add a fallback.
- After a batch lands and the plan is worked down, offer to run `/update-outstanding-work` so the
  project's real index absorbs what changed.
