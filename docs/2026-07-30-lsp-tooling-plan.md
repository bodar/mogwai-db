# LSP-driven refactoring tools — remaining work

_Written 2026-07-30, after `8c33450` landed on trunk. Everything below is measured against that
commit, not estimated. Verify a premise before acting on it — the numbers here go stale the moment
someone runs `fix.ts`._

> **Status 2026-07-30, after `4f10149`.** All four items are resolved: 1 and 2 landed as CI gates,
> 3 landed as an instrument with its findings partly actioned, 4 split into a landed file-mover and
> a measured, blocked symbol-mover. Doing them re-confirmed the warning above — every headline
> number in the original text was stale within the day (46 → 76 errors, 16 → 24 exempt, 14 → 8
> orphans), so the tools were built to re-measure rather than to assert a count.
>
> **What is left is not implementation.** §3b lists four design decisions a sweep is the wrong
> instrument to settle, §2's "one option NOT tested" is explicitly the user's call, and §4's blocked
> half needs a decision about whether to take on a second language server.

## What already landed (do not redo)

`scripts/lsp.ts` is a **session-scoped library**, not a daemon and not a per-script copy of the
plumbing. Measured on this repo: spawn+initialize ~70ms, first query ~230ms (that is the program
build), every query after ~1ms. The cost lives inside one process, so the win is open-once-query-many.
A daemon was considered and rejected: it would have to answer "is the buffer I hold still what is on
disk" across invocations whose whole purpose is changing files — a cache-coherence problem invented
to save ~300ms, with a silently-wrong failure mode. Revisit only for a genuinely long-lived client
(editor integration, watch mode) that owns the buffers because it is making the edits.

Built and verified: `rename.ts` (rewritten onto the session), `rename-batch.ts`, `fix.ts`,
`arch-check.ts`. Plus the Pass factory in `src/compiler/ir/passes.ts` and six tsconfig correctness
flags.

**The one load-bearing rule in `lsp.ts`: `Session.resync()` moves the server's buffer and our text
cache TOGETHER.** Splitting them corrupted a batch rename (`typeof PASSPASS_KINDSber]`) while
reporting success — positions computed against text the server did not have. Never read a file's
content directly when a session has it open; go through the session.

---

## 1. Wire `arch-check.ts` into the build — LANDED (`9a2fdea`)

`[tasks.arch]` exists and `[tasks.ci]` depends on it. Re-measured at `cbfc2be` before wiring rather
than trusting the number below: still 17 Pass runs, still zero violations, 40-odd commits after it
was first written down. The task costs 735ms.

It sits next to `check`, not in the ladder, for the reason recorded in `mise.toml`: L1–L5 assert
runtime behaviour over traversals, this asserts a static property of the source. `depends =
["install"]` only — no submodule, no graph, no traversal execution.

Not a ratchet, deliberately: it passes at zero, so the gate is zero. A deliberate exception goes in
the script as ONE named entry with a diagnosis, the way `L5-properties/known.ts` does.

How it was verified before landing, so nobody re-does it: injecting a real violation
(`analyzeChain(steps)` inside `stripTerminalPass`) correctly reported `stripTerminalPass:
annotating — that is ChainFacts (ir/analyze.ts), not a Pass` with the path
`stripTerminalPass -> analyzeChain`, exit **1**. It detects what it claims to detect.

### Known limits — state these, do not quietly widen the claim

- **Row 3 of the role table is not checkable here.** `src/compiler/CLAUDE.md` states three roles with
  a `Never` column. Rows 1 (Pass never annotates / selects SQL) and 2 are reachability questions and
  are what this checks. Row 3 — FastPath "is never the semantic authority" — is a semantic claim, and
  L5's differential is already its instrument.
- **Value-carried calls are invisible.** A Pass reaching a forbidden target through a callback stored
  in a DI scope or on `PassContext` will not be seen. This is the same blind spot as the `as any`
  trap in `rename.ts`'s header. The compiler's one-way DAG (`deps ◂ families ◂ engine ◂ compiler`)
  is what keeps that from being a live hole today.
- **It depends on the Pass factory shape.** `arch-check.ts` locates runs by matching
  `run: function name(` and `run: (…) => helper(` in `passes.ts`. If that file's shape changes, the
  script fails closed (`found no Pass run implementations`) rather than silently checking nothing —
  but it will need updating.

---

## 2. `mise run lint` — the unused-code flags — LANDED (`7821875`)

`scripts/lint.ts` + `[tasks.lint]`, and `ci` depends on it. Our source is at **0**; generated
`parser/` is at 24 and exempt. Adversarially verified — an injected unused local was reported with
its site, exit 1.

The backlog was cleared first, in three passes, because a gate cannot go green over 76 errors:

| | | |
|---|---|---|
| 76 → 52 | `3181430` | extract the duplicated test harness (§2a) |
| 52 → 25 | `fda7a27` | `fix.ts --unused` over `src/` — 227 edits, ordinary drift since `8c33450` |
| 25 → 0 | `0635cab` | the judgement calls, each read in context (§2b) |

**The count moves, so do not pin it.** It was 46 at `8c33450`, 76 at `bf10425`, and the exempt side
went 16 → 24 mid-task when the GQL sub-language parser landed. `lint.ts` therefore filters by
DIRECTORY and prints a per-directory tally; a pinned number would have been wrong within the day.

Two facts the original count obscured:

- **`verbatimModuleSyntax` was already clean in our code.** Its only hit (TS1484) is in `parser/`.
  It can go straight into `tsconfig.json` the day `parser/` stops being in the root program.
- **The test-file half was not 30 separate defects** but one duplication — see §2a.

**Why filtering OUTPUT is not a hole**, since this is the part that looks like cheating: the lint
run ADDS three flags to those `mise run check` already gates on, and `check` exempts nothing. Real
type errors in generated code remain `check`'s job; only unused-code noise is suppressed. A
diagnostic that does not parse into a file path fails the run rather than being assumed exempt.

The six *correctness* flags are already in `tsconfig.json` (measured at 0 errors each). The three
*unused-code* flags — `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` — are
deliberately NOT in the config, because generated `parser/` fails 16 of them and must never be
hand-edited (locked decision 2).

**Read the long comment in `tsconfig.json` before trying to "fix" this.** Every config-level
exemption was measured and none work:

- `include`/`exclude` only filter the ROOT set; an imported file is still checked with the root
  config's flags, so `parser/` returns via `src/gremlin/frontend.ts`.
- Project references would scope it, but `composite` REQUIRES emit (`TS6310`) and this project is
  `noEmit` by design — Bun and Wrangler consume the TS directly.
- A workspace or `link:` package does not help: tsc resolves the symlink back to the real path, and
  **even a real copy under `node_modules/` is still linted**. `skipLibCheck` covers `.d.ts` only;
  there is no source equivalent.

**One option was NOT tested and may work:** a genuinely separate package *outside* the root tsconfig's
tree (a sibling directory with its own tsconfig, consumed as a BUILT dependency). tsc would then
consume `.d.ts` rather than the generated `.ts`, and `skipLibCheck` would cover it. The reason it was
not pursued: it reintroduces a build step for a project that is deliberately build-free. That is a
real trade, and it is the user's call — do not treat "no config-level way" as covering this case.

### 2b. The judgement calls, and how each was settled

`fix.ts` cannot make these — it removes unused *imports* only. Recorded because the reasoning, not
the edit, is the reusable part, and because "delete the unused thing" was the wrong answer in three
of the six:

- **Unused param in a positional signature → rename `_x`, never drop.** `otherV`'s `s` is
  positional in `StepFn` and `st` is used. `passthrough.ts`'s `identity: StepFn = (_s, st)` is the
  same shape and already spelled it this way.
- **Unused param that is the LAST/only one → drop it.** The three `resolve: (ctx) =>` services;
  `federate.ts` already wrote `resolve: () => ({`, so the convention was in the tree. A narrower
  function still satisfies the wider signature.
- **An unused `private readonly` constructor property → drop the MODIFIER, keep the param.**
  `execute.ts`'s `registry` is read once to build the AppScope and never through `this`.
- **A param threaded purely to reach a callee that ignores it → remove at BOTH levels.**
  `oracle.ts` passed a `GraphStore` through `diverge` into `preview`, which never read it. `diverge`
  is now pure in its two outcomes, which is what it always was.
- **Dead local → delete, but check whether the CONCEPT is duplicated first.** `isSackRead` was dead;
  its concept survives inline at `engine.ts:315`, and the two files' `isSackMutate` are *not* the
  same predicate (engine's omits the name check), so there was no unification to do. Noted, not
  attempted.
- **Deleting by line number needs a shape guard.** The line-driven pass asserted the text matched
  the expected form, and earned it twice: two `dec` sites were `async` variants, and a blind delete
  would have taken the wrong line.

### 2a. The duplicated test harness — LANDED (`3181430`)

`test/support/harness.ts` now holds `read`, `seededStore`, `run`, `runWith` and `bare`; −532/+87
across 21 files. Backlog 76 → 52. CI 1041/0 and census 5/5, which is the assertion that matters for
a refactor.

Identity was verified before unifying, not assumed: whitespace-normalised hashes put `seededStore`
at 19/19 identical, `run` 18/18, `runWith` 18/18, `bare` 9/9, `read` 18/19. Three lookalikes are
deliberately untouched because they are unrelated functions sharing a name — `read` in
`test/serializers.test.ts` (deserializes a buffer), `read` in `test/L3-conformance/glv-compat.ts` (a
bound `deserializeValue`), and `bare` in `test/L2-sql/group.sql.test.ts` (a test-local variable).

**The finding worth keeping:** `bare` in `typed-properties.exec.test.ts` was referenced only by its
own recursive calls. TypeScript counts a self-reference as a use, so `noUnusedLocals` cannot see a
dead *recursive* helper — no flag would ever have reported it. It took removing the definition and
asking whether anything still named it. All five of that file's helpers turned out dead.

Generalise that before trusting the gate: **the unused-code flags under-report by construction.** A
dead mutually-recursive pair, or a helper used only by other dead code, is invisible to them. §3's
reference sweep is the instrument that can see it; the flags are not.

---

## 3. Dead-code / orphan-export sweep — LANDED (`8214b3f`), findings partly actioned (`b0e2c71`)

`scripts/orphans.ts` + `mise run orphans`. Over `src` and `scripts`: **725 exported declarations,
86 local-only, 13 test-only, 8 orphan** (was 14 before the wrapper deletion below).

**An instrument, not a gate, and deliberately not in `ci`** — gating would need an allowlist
(somewhere for a real orphan to hide) or would force a deletion the tool is not confident enough to
make. Three verdicts, in descending confidence:

| verdict | meaning | fix |
|---|---|---|
| `local-only` (86) | referenced only inside its own file | drop the `export` keyword — mechanical |
| `test-only` (13) | no product file outside its own references it | judgement: is the test the only user? |
| `orphan` (8) | no references at all | delete, unexport, or a reflective edge |

Two design choices that turned out to matter more than expected:

- **Scan `src`+`scripts`, but COUNT test references.** The plan's "exclude test files" rule applies
  to the scan set, not the reference set. Excluding test references instead would turn `test-only`
  from a category into a false negative — and `test-only` is the signal the sweep exists to find.
- **Every finding carries a whole-repo textual mention count** (including `.feature` and `.md`),
  because the reflective edges this codebase really has — DI leaves, registry-resolved services,
  Gherkin step names, the worker/server entry points — are invisible to a reference query. Zero
  references *and* zero prose mentions is a much stronger candidate than zero references alone.

**Verify a finding before believing it.** Two looked like tool bugs and were not: `compile` and
`standardRegistry` are genuinely test-only — `src/execute.ts` imports `compilePlan`, not `compile`,
and every other mention of `standardRegistry` in `src/` sits inside a comment. That `compile()`, the
named public entry, is exercised only by tests while production goes through `compilePlan` is a real
finding about the API surface and is left standing here deliberately.

### 3a. Actioned: the superseded predicate wrappers (`b0e2c71`)

Six exports deleted as ONE finding, not six: `isPropertyScalarChild`, `isPropertyScalarFoldChild`,
`isTotalScalarChild`, `isScalarFoldChild`, `isElementFoldChild`, `isElementImplicitFoldChild` were
each a thin `classifyX(...) !== null` wrapper whose `classifyX` is alive and called directly. The
reason is in `classifyListChild`'s own comment — the classifier "returns the parsed body so the
emitter reuses it instead of re-parsing". Once a caller wants the body, a boolean wrapper has
nothing left to offer. Re-running the sweep after showed no NEW orphan, so they held nothing alive.

### 3b. NOT actioned — these are design decisions, not dead code

Left for whoever owns each seam. Deleting them is defensible; so is keeping them, and a sweep is the
wrong instrument to settle it:

- **`alias.ts` exposes a symmetric accessor vocabulary of which one member is used.**
  `entryId`/`entryScalar`/`entryKind`/`entryTypeTag` are four spellings of the same extraction and
  only `entryTypeTag` has a caller; likewise `nodeEntry`/`elemEntry` are used while `edgeEntry` is
  not, and `popIsList`/`kindShape` are unused. The trade is a complete, discoverable vocabulary
  against less dead code — a judgement about what that module's API *is*.
- **`isMidBarrierPoint` (`tail/call.ts`)** — a type guard for `MidBarrierPoint` with no caller. Same
  question in miniature: guards usually come as a set.
- **`SCALAR_ROW_STEPS` (`tail/scalar.ts`)** — an unused step-vocabulary Set. Worth checking against
  the "declared twice" hazard in `src/compiler/steps/CLAUDE.md` before either deleting or wiring it
  up; a second copy of a vocabulary is the failure mode that section warns about.
- **The 86 `local-only` exports.** Mechanically safe to unexport, but it is 86 edits asserting that
  each module's public surface should be exactly what is currently consumed. That is a module-
  boundary policy, and it should be decided once and applied, not drifted into by a tool.

This directly serves the technical-debt sweep in `docs/outstanding-work.md`.

## 4. `moveToFile` — SPLIT: file moves LANDED (`4f10149`), symbol moves BLOCKED

The item assumed one capability; there are two, and only one exists here. Measured, so nobody
re-derives it:

| | capability | status |
|---|---|---|
| move a FILE, rewrite importers | `workspace/willRenameFiles` | **advertised and answers** — `scripts/move.ts` |
| move a SYMBOL between files | `refactor.move` code action | **not exposed by this server** |

`codeActionProvider.codeActionKinds` is `quickfix, source.organizeImports,
source.removeUnusedImports, source.sortImports, source.fixAll` — **no `refactor.*` kind at all** —
and a `textDocument/codeAction` asking for `refactor` or `refactor.move` over a declaration returns
zero actions, with or without `codeActionLiteralSupport` declared at initialize. `tsc --lsp` is not
`tsserver`: the refactor surface is simply not part of it.

**So the item's motivating case is the half that is blocked.** Moving a symbol to the correct side
of the `src/gremlin/` ↔ compiler boundary (locked decision 5) still has no tool. Options, none
attempted: drive `tsserver` instead (a second server, a second protocol, and it would no longer be
"the same TypeScript `mise run check` uses" — that property is why these tools are trustworthy), or
do it by hand and let `mise run check` catch the fallout.

### What `scripts/move.ts` does

`bun scripts/move.ts <from> <to> [--dry]`. No mise task, matching `rename.ts`/`fix.ts` — two
positional paths, a manual operation.

**Order is load-bearing: edits first, then the move.** A depth-changing move rewrites the moved
file's OWN relative imports, and those edits come back keyed to its OLD uri. Both cases measured:
`src/services/` → `src/sql/` is depth-preserving, 1 edit (its single real importer — the other
textual hits were comments); `src/services/` → `src/` needs 3, two of them inside the moved file.

Verified by a real apply, per this doc's own rule that a dry run cannot catch an applier bug: moved
`fts-index.ts` up a level, `check` clean, git recorded a **rename**, then moved it back with the same
tool and the tree returned byte-identical. `git mv` rather than a raw rename keeps `git log --follow`
working, which is precisely when someone wants it.

---

## Gotchas that cost real time here — do not rediscover them

- **`prepareCallHierarchy` returns nothing for an arrow assigned to an object-literal property.**
  Measured. This is why the Pass factory writes real-logic runs as `function name(...)`
  declarations. `Object.defineProperty(fn, 'name', …)` does NOT help — it sets a runtime property,
  and call hierarchy is a static AST query.
- **A dry run cannot catch an applier bug.** The batch-rename corruption reported success in dry
  mode and only surfaced on apply + type-check. Any tool that writes needs a real apply in its
  verification, not just a preview.
- **`exit=$?` after a pipe measures the LAST command, not the script.** This produced two false
  readings during this work (`arch-check` looked like it exited 0 on a violation; it exits 1).
  Use `${PIPESTATUS[0]}` or redirect to `/dev/null`.
- **`git checkout src/` is too broad when reverting a test edit.** It destroyed the Pass factory
  once mid-session. Revert specific files.
- **Code actions produce multi-line ranges and multi-line `newText`.** `applyEdits` handles this now
  (flat offsets, last-first) but the original line-oriented version threw. Do not reintroduce a
  line-oriented applier.
- **`fix.ts` must filter no-op reformats.** The server offers `removeUnusedImports` for nearly every
  file and its edit usually rewrites the import block to exactly what was already there — 1037
  "edits" across 152 files on a tree `tsc` calls clean. The filter compares resulting text.

## Verification bar for anything here

`mise run check` (0 errors), `mise run census` (5/5 — the refactor guard that catches "still runs,
different answer"), and `bun test test/compiler test/L2-sql` (542 pass at `8c33450`). The census
deliberately does not auto-record; a re-record with no reason in the commit message is
indistinguishable from the regression it hides.
