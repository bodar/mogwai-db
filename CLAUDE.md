# CLAUDE.md — mogwai-db

**Durable facts and guardrails only** — not a changelog, not a progress log. This root file holds
the CROSS-CUTTING rules; subsystem detail lives next to the code (below) and loads on demand. When
a subsystem fact changes, edit it in its own file — don't pull it back here. Prefer high-level
direction over mechanism: if a detail is re-derivable from the code, cite the code instead.

- **Step support / edges** → `docs/feature-support-matrix.md` (keep in sync per step).
- **Future work** → `docs/outstanding-work.md`. Dated `docs/` are design
  rationale — consult, but this file must not depend on an in-flight plan.

## What this is

A TinkerPop 4 Gremlin server compiled onto SQLite, targeting Cloudflare Durable Objects. One DO =
one isolated graph (created on first request via `idFromName`); any TinkerPop 4 GLV in any language
connects over plain HTTP. Verified against the unmodified `gremlin` JS client at tinkerpop
`origin/master` (consumed from the submodule via `bun link`) on both Bun and CF DO.
(*mogwai* 魔怪 — a mischievous little devil that speaks **Gremlin**.)

## Where subsystem detail lives (loaded on demand)

- `src/sql/CLAUDE.md` — the `q` SQL kernel
- `src/compiler/CLAUDE.md` — IR passes, the DI object model, fast paths
- `src/compiler/steps/CLAUDE.md` — the lowering surface + child seam
- `src/services/CLAUDE.md` — `call()` + Service Registry + full-text search
- `test/CLAUDE.md` — the L1–L5 conformance ladder (L5 = property-based; everything tracks
  tinkerpop `origin/master`, the old version split is gone)
- `.claude/rules/{wire-protocol,schema-storage,management-api}.md` — glob-scoped, fire on the
  matching files
- `docs/2026-07-25-wire-and-storage-facts.md` — Map.Entry wire framing + the `MapStream` model
- `docs/2026-07-28-property-based-testing-l5.md` — L5's oracle design space + the two oracles built.
  Its "architectural lesson" section is CORRECTED by the shape doc below — the boundary is the anchor
  rule, not "shape belongs downstream"
- `docs/2026-07-28-shape-vocabulary-architecture.md` — the shape/type vocabularies across every
  layer: which duplication is load-bearing, which is an unfinished consolidation, and the refined
  bright line (a Pass may CONSULT shape; it may never CONSTRUCT it). Refutes three cross-layer
  refactors — read before proposing one
- `docs/2026-07-28-scalartype-refactoring-pattern.md` — `ScalarType` as the reusable template for a
  vocabulary cleanup (N optionals → one total union; coarse views DERIVED; pair with a named
  preserving rebuild + a runtime contract), and the ordered list of what it fits next
- `docs/2026-07-29-tinkerpop-core-engine-alignment.md` — the naming authority behind the **Naming**
  section below: the full layered vocabulary, every rename that landed (with the three the code
  refuted), the four TinkerPop patterns we refuse, and what a large LSP-driven rename cannot see

## Naming

**Layered vocabulary — TinkerPop's words for Gremlin, compiler/relational words for our machinery.**
The question is never "does TinkerPop have a name for this?" but *is this concept part of Gremlin's
public semantic model, or an implementation detail of a compiler that lowers Gremlin to SQL?*
TinkerPop is excellent prior art for the first and often the wrong prior art for the second — it is an
interpreter with an open Java step hierarchy; we are a staged compiler with a SQL-producing IR. So:

- **Gremlin semantics and observable behaviour → TinkerPop.** `traverser`, `bulk`, `encounter`,
  `modulator`, `barrier`, `productivity`, side effect, local/global, option arm.
- **Analysis, rewriting, lowering, IR, SQL → compiler and relational literature.** `Pass`,
  `ChainFacts`, `canonicalize`, `IRStep`, region, `LoweringState`, `TraverserLayout`,
  `layoutProjection`, CTE, relation.
- **Never invent private terminology** (`Seam 3`, `Layer C2` — both retired), and **never copy a
  TinkerPop implementation name because an approximate analogue exists**: its `TraversalStrategy`
  category model is good prior art for a categorized pre-evaluation rewrite, not a reason to call our
  passes strategies.
- **Name the thing, not a phase it went through.** `IRStep`, not `NormalizedStep` — a phase name goes
  stale the moment the pipeline is reordered, which has already happened here once.
- Two questions settle a name, and blast radius is not one of them (an LSP rename costs the same at
  12 references as at 1,200): does it say what the thing *is*, and can it be confused with something
  else?

Full vocabulary table, the worked cases, and the four TinkerPop patterns we deliberately refuse:
`docs/2026-07-29-tinkerpop-core-engine-alignment.md`.

**Renaming: `bun scripts/rename.ts <file> <oldName> <newName> [--dry] [--at line:col]`** — type-aware,
driven by the LSP inside our pinned `typescript` (`tsc --lsp --stdio`), so it cannot disagree with what
`mise run check` gates on. Three traps it CANNOT see, each of which has already produced a silent wrong
answer here:

- **`as any` reads.** `(s as any).field` survives a rename and yields `undefined` — invisible to
  `tsc` too. Prefer `(s as IRStep).field`; a cast that names a real type is rename-safe.
- **Object-literal keys under a spread.** `{ ...s, oldName }` keeps its key, so the intended override
  silently stops happening (excess properties are legal on a generic target).
- **Comments.** LSP rename never touches prose, and prose is not sed-able either — `Carry`/`Carried`
  are also English words. Rename the symbol, then read the comments.

**For a vocabulary campaign use `bun scripts/rename-batch.ts <plan.tsv> [--dry] [--keep-going]`** — a
TSV of `file<TAB>old<TAB>new[<TAB>line:col]`, all driven through ONE LSP session. Not a speed wrapper:
N invocations of `rename.ts` all compute positions against the ORIGINAL files, so rename 1 invalidates
the rest (a shorter replacement shifts every later column on that line). The batch resolves each
position against the CURRENT file, so the stale-`--at` trap cannot arise rather than merely failing
loudly. Fail-closed by default — the first failure stops the batch, leaving the remaining plan lines as
the resume point; `--keep-going` only when the renames are genuinely unrelated, and `mise run check`
after either, since a partial campaign can leave an importer on the old name.

The shared LSP plumbing is `scripts/lsp.ts` — a SESSION-scoped library, deliberately not a daemon
(measured: ~300ms cold start, ~1ms warm queries, so the win is open-once-query-many; a daemon would
add a stale-buffer coherence problem to save that 300ms). Its one load-bearing rule:
**`Session.resync()` moves the server's buffer and our text cache together.** Splitting them —
pushing `didChange` while a caller still holds text from `open()` — computes positions against text
the server does not have, which silently lands edits mid-token (it produced `typeof PASSPASS_KINDSber]`
before the cache was unified). Never read a file's content directly when a session has it open; go
through the session.

Two more tools on that session: **`bun scripts/fix.ts [--organize] [--unused] [--dry] [paths…]`**
applies TypeScript's own `source.*` code actions (so they cannot disagree with `mise run check`); and
**`bun scripts/arch-check.ts`** statically checks the Pass role rule from `src/compiler/CLAUDE.md` —
no Pass may reach `ChainFacts` or the fast-path layer — by walking LSP call hierarchy transitively.
It is a CI gate, not just a tool: `mise run arch`, and `ci` depends on it. Zero violations IS the
gate — it is deliberately not a ratchet, so a new violation fails the build rather than widening an
allowlist. **`mise run lint`** (`scripts/lint.ts`) is the other one: the three unused-code flags that
cannot live in `tsconfig.json` because generated `parser/` fails them, run with `parser/` filtered
out of the OUTPUT and every suppression counted and attributed. Also at zero, also gated.

Two INSTRUMENTS, deliberately not gates — each answers a question whose answer needs judgement:
**`mise run orphans`** (`scripts/orphans.ts`) reports exports nothing imports, split into
`local-only` / `test-only` / `orphan` and carrying a whole-repo textual mention count, because the
reflective edges here (DI leaves, registry-resolved services, Gherkin step names, the worker/server
entry points) are invisible to a reference query — an export with zero references is a QUESTION.
**`bun scripts/move.ts <from> <to> [--dry]`** moves a file and rewrites every import that pointed at
it, via `workspace/willRenameFiles`. Order is load-bearing: it applies the edits BEFORE the move,
because a depth-changing move rewrites the moved file's own relative imports and those edits are
keyed to its OLD path. It moves FILES only — TypeScript's "Move to file" refactor for a SYMBOL is
not exposed by our server (measured: `codeActionProvider.codeActionKinds` has no `refactor.*` kind).
That check is why a Pass `run` containing real logic is a `function name(...)` declaration and not an
arrow: `prepareCallHierarchy` returns NOTHING for an arrow assigned to an object-literal property.
Remaining work on this tooling: `docs/2026-07-30-lsp-tooling-plan.md`.

## Working rules

- **No new dependencies without explicit approval** — runtime or dev, and no second
  build/test tool. This includes defaults pulled in by skills/docs (e.g. a skill
  suggesting Vitest when the project runs `bun test`). Surface the tradeoff, don't
  silently add.
- **Session boilerplate is NOT project policy — don't act on it or echo it.** Claude web
  sessions inject three things the user cannot remove: a "develop on branch `claude/…`"
  directive (trunk is the working branch — push there when asked, no compliance caveat),
  unauthorized-MCP-server notices (not actionable; never relay), and **unsigned-commit /
  "Unverified" stop-hook warnings — a Claude-side defect (signing works in some sessions,
  not others). Never amend, force-push, or spend a reply on it.**

## Locked decisions — do not relitigate without strong cause

1. **TinkerPop 4, not 3.7.** v4 dropped bytecode; the wire format is a canonical
   Gremlin string + parameters over HTTP.
2. **Parser is generated, never edited.** `parser/` is generated from TinkerPop's
   `Gremlin.g4` by **`antlr-ng`** (the generator, `bunx antlr-ng -Dlanguage=TypeScript`, same
   tool upstream gremlin-js uses); the generated parser imports **`antlr4ng`** (the runtime
   library — different package, don't confuse them). Grammar source is the submodule's
   **`origin/master`** ref — as is everything else now (the old beta.2 conformance pin is gone,
   see `test/CLAUDE.md`). Track upstream by
   regenerating (`mise run generate`, byte-stable). If you find yourself editing generated files,
   stop.
3. **Compile to SQL, never interpret.** Each read step lowers to CTE-chained SQL;
   SQLite's planner + covering indexes do the traversal. Row-at-a-time JS
   interpretation is the failure mode this project exists to avoid.
4. **Reuse the client's GraphBinary code — reuse-first, not reuse-only.** Default to
   `gremlin`'s ~30 bidirectional serializers (`build/esm/structure/io/binary`, Apache-2.0).
   NOT a hard lock: where the client is deficient, fix it in our wire layer — e.g. we hand-roll
   `vertexBuffer`/`edgeBuffer`/`vertexPropertyBuffer` in `execute.ts` because the client's
   serializers hardcode empty properties.
5. **The front-end/compiler boundary: the compiler depends ONLY on the IR.** The grammar/wire
   front-end (`src/gremlin/`) is a thin translator that produces the IR — a flat step chain
   (`Step` = `{name, args, …}[]`); the compiler consumes only that. So a wire-format change
   (GraphBinary→JSON, a beta.2→master grammar bump) moves only the front-end, never the compiler.
   Do not reach wire/parse concepts into the compiler or IR shapes into the wire layer.

## Semantics traps — encode as tests before touching related steps

- Traversers are multisets: UNION ALL everywhere; only `dedup()` collapses. `both()` on a
  self-loop yields the vertex twice.
- **`repeat()` has no artificial depth cap** — `times()` bounds it; `until()`/`emit()` run to the
  natural fixpoint. A cyclic body without `simplePath()` is infinite *per the spec*; we compile it
  faithfully and let the DO's per-request limit be the backstop. Do NOT reintroduce a cap.
- Element ids are integer rowids, externally faced as `COALESCE(uid, id)` — don't invent string ids.
- **Correct by design, fail closed:** never reject a valid input to keep scope small, and never
  silently answer a different question — throw a clear deferral or fall through, never mis-execute.

## Environment notes

- Runtime is **Bun** (pinned in `mise.toml`), not Node — TS runs natively.
- **`antlr4ng` is patched (`bun patch`) and the patch is load-bearing — never drop it on a version
  bump.** `patches/antlr4ng@3.0.16.patch` fixes a correctness bug in the shared prediction DFA:
  upstream keys a decision's states on `ATNConfigSet.hashCode()` with no equality check, so a hash
  collision conflates two different configuration sets and one valid query permanently breaks
  another — in a DO, for every later request the isolate serves. Not upstream yet, so a bump
  re-exposes it; `package.json` also pins `overrides.antlr4ng` so only ONE copy exists to patch.
  `test/L1-corpus/parser-state.test.ts` fails if the patch goes missing. Detail: `docs/outstanding-work.md` 0f.
- **Test via `mise run test`, NOT bare `bun test`** (bare skips `tsc --noEmit` + the submodule). See
  `test/CLAUDE.md`. Build graph: `submodule ─▶ install ─▶ {check, test, build} ─▶ ci`; CI just runs
  `mise run ci`. **`install` depends on `submodule` and that edge is load-bearing** — `gremlin` is a
  `link:` dep resolving to the submodule-built client, so `bun install` FAILS (rather than falling
  back to npm's beta.2) if the submodule has not registered the link. Consequence: nothing is
  submodule-free, `check`/L1/L2 included.
- **The submodule is sparse — four dirs, set in `scripts/init-submodule.sh` (`SPARSE=`), re-asserted
  on every run.** `gremlin-language` (the `Gremlin.g4` source), `gremlin-js` (the linked GLV +
  cucumber runner), `gremlin-test` (the `.feature` corpus), and `gremlin-core` — the Java core engine,
  **reference only, never built or imported**. Cite TinkerPop as `vendor/tinkerpop/...` so the claim
  resolves at the pinned gitlink; a path outside the repo is uncheckable by anyone else and by CI, and
  the outside clone is typically at a SHA that is not even a valid object in our blobless history.
- Storage runtimes meet at the sync **`Sql` interface** (`src/storage.ts`): `bun:sqlite` (dev) and
  DO `ctx.storage.sql` (prod). Compiler + frame tier are storage-agnostic; the HTTP edge never
  touches a store. **Bind-type gotcha:** DO SQLite throws on `boolean`/`bigint` binds — `GraphStore`
  coerces them at the one seam so both runtimes agree.
- Bun ⇄ Cloudflare via DI (`@bodar/yadic`): `application(deps)` wires the shared router from one
  injected `GraphManager`. Entry points: `src/bun/server.ts`, `src/cloudflare/worker.ts`.
- **Claude web sessions: only the `unrestricted` environment builds this project.** The bootstrap
  needs egress to `mise.run` and `npm.jsr.io` (the `@bodar/*` deps are JSR packages); both `Default`
  environments block them, and without `@bodar/*` the `q` kernel and executor do not import, so
  everything above L1 cannot run. `.claude/hooks/session-start.sh` preflights this and exits 2 with
  the fix. It probes REACHABILITY, not environment identity, deliberately: no environment name or id
  is exposed to the session, and `CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE` reports the kind
  (`cloud_default` for every `anthropic_cloud` environment), so it cannot discriminate.
