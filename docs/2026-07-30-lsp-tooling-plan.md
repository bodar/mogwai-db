# LSP-driven refactoring tools — remaining work

_Written 2026-07-30, after `8c33450` landed on trunk. Everything below is measured against that
commit, not estimated. Verify a premise before acting on it — the numbers here go stale the moment
someone runs `fix.ts`._

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

## 2. `mise run lint` — the unused-code flags

**Current state: 76 errors in our code, 16 in generated `parser/`** (re-measured at `bf10425`; it
was 46 at `8c33450`, so this grows by roughly one a day when ungated — which is the argument for
the gate, not against it).

Ours breaks down as 70 × TS6133 (declared but never read), 5 × TS6192 (whole import declaration
unused), 1 × TS6138 (unused private property). Two facts the earlier count obscured:

- **`verbatimModuleSyntax` is already clean in our code.** Its only hit (TS1484) is in generated
  `parser/`. So that flag costs nothing to adopt and can go straight into `tsconfig.json` the day
  `parser/` stops being in the root program — it is not part of the 76.
- **The test-file half is not 30 separate defects.** `read`, `seededStore`, `run`, `runWith` and
  `bare` are copy-pasted into 18–20 test files each; the errors are just the copies that happened to
  go unused. Deleting them one by one treats the symptom. See §2a.

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

The pragmatic path is an invocation-scoped task:

```toml
[tasks.lint]
description = "Unused-code checks over src/test/scripts (generated parser/ is exempt — see tsconfig.json)"
depends = ["install"]
run = "bun scripts/lint.ts"
```

A `tsc --noEmit --noUnusedLocals …` invocation still pulls `parser/` in via the import graph, so the
task needs to filter `parser/` out of the OUTPUT and exit on what remains. That filtering is the
whole job — keep it honest: print what was filtered, never silently drop.

**Clear the 76 first, or the gate cannot go green.** `fix.ts` will NOT fix them — it only removes
unused *imports*, and it already did that (506 edits, 46 files, landed in `8c33450`). These need
judgement: some are a signal that a code path was abandoned mid-refactor, which is worth a look
rather than a deletion. Categories: unused destructured params (`ctx` in several
`src/services/catalog/*.ts`), an unused private field (`registry` in `src/execute.ts:675`), dead
locals (`isSackRead` in `child-shape.ts:298`), and the duplicated test harness below.

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

## 3. Dead-code / orphan-export sweep — not started

`textDocument/references` with `includeDeclaration: false` over every exported symbol; zero
references outside its own file means either delete or unexport. Verified working on this server
(8 real hits for `analyzeChain`).

Design notes:

- **Exclude test files from the "is it referenced" question** or every test helper looks orphaned.
- **An export with zero refs is a QUESTION, not a verdict.** Public API surface, DI-registered
  leaves, and things referenced only from `.feature` step definitions will all look dead. Report,
  do not auto-delete.
- This directly serves the technical-debt sweep in `docs/outstanding-work.md`.

## 4. `moveToFile` — not started

The server advertises `workspace.fileOperations.willRename`, which is the real mechanism. A move
that rewrites import paths across the workspace is currently a manual multi-file fixup.

The motivating case is the subsystem boundary the docs already state: `src/gremlin/` must not reach
into the compiler (locked decision 5). Moving a symbol to the correct side of that line is the use
case; a general-purpose file mover is not.

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
