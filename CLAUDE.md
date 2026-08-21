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
- `src/services/CLAUDE.md` — `call()` + Service Registry + full-text search
- `test/CLAUDE.md` — the L1–L5 conformance ladder (L5 = property-based; everything tracks
  tinkerpop `origin/master`, the old version split is gone)
- `.claude/rules/{wire-protocol,schema-storage,management-api}.md` — glob-scoped, fire on the
  matching files
- `.claude/hooks/web-session-notes.md` — everything true only of a Claude-web session: the harness
  boilerplate that is not project policy, pushing to a trunk two sessions share, the shallow clone,
  and the one environment whose egress lets this project build. `session-start.sh` prints it into a
  web session's context (`SessionStart` stdout IS context) and nothing else loads it, so a local
  session doesn't pay for facts it cannot observe. Add web-session facts THERE, not here
- `docs/archive/2026-08-09-repeat-two-regimes-plan.md` — ✅ **LANDED AND ARCHIVED (2026-08-11).** `repeat()` is
  TWO lowerings chosen by a total function on ONE axis: **bounded** (a compile-time `times(n)`) → the IR
  unroll, because only PHASES can carry both a per-iteration barrier and the RLE collapse; **unbounded**
  → `Recursive`; unbounded+barrier → a clear refusal. Both regimes are live and every item in its
  shipping list is on trunk. Read it for the MEASURED FACTS, which is the whole reason it is kept: a
  recursive term cannot hold an aggregate (so a walk cannot collapse a multiset, while the corpus asks
  for 2.5×10¹⁵ traversers over 808 vertices); the arm laws for a compound term; and its §7 — the
  collapse authority is ONE and POSITIONAL, per node from `CHANNEL_GROUP_POLICY` and per suffix from
  `src/compiler/ir/bulk.ts`, which is how TinkerPop (`Traverser.equals` per traverser class, plus
  `LazyBarrierStrategy` deciding per POSITION where bulking may be introduced) and Calcite
  (`RelMetadataQuery` per node, `SqlSplittableAggFunction` per function) both model it. Its
  chain-global relaxation stays REFUTED — do not retry it. Residue moved to the RelIR build plan's
  Phase 3 step 4.
- `docs/2026-08-09-named-collections-are-bindings-plan.md` — `aggregate("a")` RETAINS a relation under a
  name; `cap("a")` reduces it, which is why N sites are a UNION of relations rather than N−1 list
  concatenations. **Phases 1/2/3a/4/5/6/7 have all LANDED** — multi-site accumulation, a site as a
  `snapshot` Binding, a declared merge policy (`withSideEffect(k, seed, Operator)` — ONE object with
  `withSack`'s) as a seeded LEFT FOLD, and a keyed `group("a")`/`groupCount("a")` as `(key, contribution)`
  MEMBER ROWS so N sites merge per key. Its remaining work is mixed member shapes, keyed declared
  policies, and safe member re-entry; downstream step gaps remain owned by their own substrates.
  Read it before touching `collection.ts`
- `docs/2026-07-28-property-based-testing-l5.md` — L5's oracle design space + the two oracles built.
  Its "architectural lesson" section is CORRECTED by the bright line in `src/compiler/CLAUDE.md` — the
  boundary is the anchor rule, not "shape belongs downstream". The shape vocabularies themselves landed
  as the RelIR three-layer boundary (`docs/2026-08-01-relir-build-plan.md` §6·3); the durable rule
  (a Pass may CONSULT shape, never CONSTRUCT it) and the refuted cross-layer refactors live in
  `src/compiler/CLAUDE.md`

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

The code and this vocabulary are the authority; historical rename campaigns are not design guidance.

## Tooling

**Every `mise run <task>` tees its full output to `.logs/<task>.log`** (one file per task, last run,
via the `[task_config]` shell in `mise.toml`). So when a run is red or long, `grep`/`Read` the printed
log path — `mise run ci` leaves `.logs/check.log`, `.logs/test.log`, … — instead of re-running the
suite because a `tail` scrolled the part you needed past. **Do not pipe a suite through `tail`/`grep`
and then re-run when you miss something; the whole run is already in the file.**

**`mise run ci`'s EXIT CODE is truthful, but a PIPE hides it — this is a green-that-was-red trap that
shipped a red commit once.** mise exits non-zero on any failed task (a failed dependency propagates its
code and the parent `run` is skipped — measured). But `mise run ci 2>&1 | tail`/`| grep` makes the
PIPELINE return `tail`'s exit 0 (no `pipefail` in the ambient shell), so a red run reads green. No exit
code survives a pipe — shell semantics, unfixable — so the survivable signal is a terminal LINE: **run
`bash scripts/ci.sh`, which prints `CI: PASS` / `CI: FAIL (exit N)` as its LAST line and exits with the
true code.** When you must read a piped run, grep the verdict line (or the presence of the ci task's
`CI passed`), NEVER trust the pipeline's exit code.

Every tool below is driven by the LSP inside our **pinned `typescript`** (`tsc --lsp --stdio`), so
none of them can disagree with what `mise run check` gates on. That property is the whole point —
it is why a second linter is not wanted and why adopting `tsserver` would be a real trade, not a
free upgrade.

| Command | Use it for | Role |
|---|---|---|
| `bun scripts/refs.ts <name>` | every real USE of a symbol | **reach for this before `grep`** |
| `bun scripts/rename.ts <file> <old> <new> [--dry] [--at l:c]` | type-aware rename | tool |
| `bun scripts/rename-batch.ts <plan.tsv> [--dry] [--keep-going]` | a vocabulary campaign, one session | tool |
| `bun scripts/move.ts <from> <to> [--dry]` | move a FILE + rewrite every importer | tool |
| `bun scripts/fix.ts [--organize] [--unused] [--dry] [paths…]` | TypeScript's own `source.*` code actions | tool |
| `mise run arch` (`scripts/arch-check.ts`) | no Pass reaches `ChainFacts`/fast paths | **CI gate**, at zero |
| `mise run lint` (`scripts/lint.ts`) | unused locals/params/value-position type imports | **CI gate**, at zero |
| `mise run binds` (`scripts/binds-check.ts`) | no bind list sized by ROW COUNT — no hand-rolled `?` synthesis | **CI gate**, at zero |
| `mise run orphans` (`scripts/orphans.ts`) | exports nothing imports | instrument — findings need judgement |
| `scripts/lsp.ts` | the shared session library — build new tools on it | library |

**`refs.ts` answers the question `grep` cannot.** `textDocument/references` is the type checker's own
resolution, so a comment mentioning the name is not a reference and a same-named symbol in another
scope is not a reference. Measured: `standardRegistry` shows 16 textual hits and has 11 references,
**all of them in `test/`** — the five extra are `src/` comments, and they are exactly why grep made it
look like production code used it. Resolution goes through `workspace/symbol`, which is FUZZY (a query
for `compile` returns 75 hits including `compileAddV`), so exact matching is the default and `--fuzzy`
opts out; a name resolving to several declarations reports each with its own references rather than
silently picking one.

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
allowlist. **`mise run lint`** (`scripts/lint.ts`) is the second: the three unused-code flags that
cannot live in `tsconfig.json` because generated `parser/` fails them, run with `parser/` filtered
out of the OUTPUT and every suppression counted and attributed. Also at zero, also gated.
**`mise run binds`** (`scripts/binds-check.ts`) is the third, and the one whose absence let a
production-only wall ship twice: no hand-rolled placeholder repetition ANYWHERE in `src/` — an arrow
returning `'?'`, `.fill('?')`, `'?,'.repeat(n)`. The sanctioned form for a data-sized set is now ONE
`json_each(?)` bind (a read's `IN (SELECT value FROM json_each(?))`, a write's relational `Insert` over
`json_each` — `src/setwrite.ts`, `src/formats/drain.ts`), so there is no chunked placeholder builder to
route through and a data-sized `IN (…)` list is never correct. It deliberately does NOT try to decide
whether an arbitrary `binds` array is bounded — that is dataflow over every `store.query` call, and
`store.query(plan.sql, plan.binds)` is unbounded to any local analysis and perfectly correct. What is
decidable is the IDIOM, and the idiom is what produced both walls.

One INSTRUMENT, deliberately not a gate, because its answer needs judgement:
**`mise run orphans`** (`scripts/orphans.ts`) reports exports nothing imports, split into
`local-only` / `test-only` / `orphan` and carrying a whole-repo textual mention count, because the
reflective edges here (DI leaves, registry-resolved services, Gherkin step names, the worker/server
entry points) are invisible to a reference query — an export with zero references is a QUESTION.
**`bun scripts/move.ts <from> <to> [--dry]`** moves a file and rewrites every import that pointed at
it, via `workspace/willRenameFiles`. Order is load-bearing: it applies the edits BEFORE the move,
because a depth-changing move rewrites the moved file's own relative imports and those edits are
keyed to its OLD path. It moves FILES only — TypeScript's "Move to file" refactor for a SYMBOL is
not exposed by our server (measured: `codeActionProvider.codeActionKinds` has no `refactor.*` kind).
**The arch check** is why a Pass `run` containing real logic is a `function name(...)` declaration and
not an arrow: `prepareCallHierarchy` returns NOTHING for an arrow assigned to an object-literal
property.

## Working rules

- **No new dependencies without explicit approval** — runtime or dev, and no second
  build/test tool. This includes defaults pulled in by skills/docs (e.g. a skill
  suggesting Vitest when the project runs `bun test`). Surface the tradeoff, don't
  silently add.

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
   Do not reach wire/parse concepts into the compiler or IR shapes into the wire layer. **A user
   PARAMETER is not a wire concept** — that a `Step.arg` is a named parameter rather than a literal
   constant is a legitimate IR fact (it decides bind-vs-literal), carried on the argument's `Arg`
   object (`name`) alongside its `type`, so the front-end no longer flattens it away (see the bind
   rule under Environment notes and
   `docs/archive/2026-08-05-parameters-are-the-only-binds.md`). What stays out of the compiler is the wire
   *format*, not the *fact that the user declared a parameter*.

## Semantics traps — encode as tests before touching related steps

- Traversers are multisets: UNION ALL everywhere; only `dedup()` collapses. `both()` on a
  self-loop yields the vertex twice.
- **`repeat()` has no artificial depth cap** — `times()` bounds it; `until()`/`emit()` run to the
  natural fixpoint. A cyclic body without `simplePath()` is infinite *per the spec*; we compile it
  faithfully and let the DO's per-request limit be the backstop. Do NOT reintroduce a cap.
- Element ids are integer rowids, externally faced as `COALESCE(uid, id)` — don't invent string ids.
- **Correct by design, fail closed:** never reject a valid input to keep scope small, and never
  silently answer a different question — throw a clear deferral or fall through, never mis-execute.
- **IN DOUBT ABOUT A SEMANTICS QUESTION, READ THE VENDORED REFERENCE — do not reason it out.** The
  `.feature` corpus says WHAT the answer is; **`vendor/tinkerpop/gremlin-core` says WHY and covers the
  cases no scenario names** (e.g. what a reducing barrier emits over ZERO rows is per-step and decided by
  whether it supplies a seed — `GroupStep`/`FoldStep` do and emit `{}`/`[]`, `SumGlobalStep` overrides
  `processAllStarts` and emits nothing). Algebra and lowering questions go to `vendor/calcite` on the same
  footing. **Cite the path at the pin** so the claim is checkable by CI and by anyone else. Measured cost
  of not doing this: a correct guard was deleted on a plausible-sounding inference that one line of
  `Group.feature` refuted. **When two comments in this repo cite one feature file for opposite behaviours,
  the resolution is IN the file, not in the argument.**

## Environment notes

- Runtime is **Bun** (pinned in `mise.toml`), not Node — TS runs natively.
- **`antlr4ng` is patched (`bun patch`) and the patch is load-bearing — never drop it on a version
  bump.** `patches/antlr4ng@3.0.16.patch` fixes a correctness bug in the shared prediction DFA:
  upstream keys a decision's states on `ATNConfigSet.hashCode()` with no equality check, so a hash
  collision conflates two different configuration sets and one valid query permanently breaks
  another — in a DO, for every later request the isolate serves. Not upstream yet, so a bump
  re-exposes it; `package.json` also pins `overrides.antlr4ng` so only ONE copy exists to patch.
  `test/L1-corpus/parser-state.test.ts` fails if the patch goes missing.
- **`patches/` is bun's patch dir and the ONLY one — everything we owe someone else's repo lives in
  `patches/upstream/`, never in `docs/`.** Bun applies only what `package.json`'s
  `patchedDependencies` names, so `upstream/` nested inside is inert. `patches/upstream/README.md`
  indexes each payload, its target project, and its submission state.
- **One spine.** The legacy compiler (`src/compiler/steps/`, `src/compiler/engine/`), its routing
switch and the whole differential harness (`MOGWAI_RELIR`, `test:legacy-spine`, the two-floor L3
ratchet, the census's legacy columns) are DELETED. A traversal the RelIR lowering does not cover
raises `UnsupportedTraversal` — a clear query failure, never a fallback. The RelIR plan records the
remaining cross-cutting substrate.

**Test via `mise run test`, NOT bare `bun test`** (bare skips `tsc --noEmit` + the submodule). See
  `test/CLAUDE.md`. Build graph: `submodule ─▶ install ─▶ {check, test, build} ─▶ ci`; CI just runs
  `mise run ci`. **`install` depends on `submodule` and that edge is load-bearing** — `gremlin` is a
  `link:` dep resolving to the submodule-built client, so `bun install` FAILS (rather than falling
  back to npm's beta.2) if the submodule has not registered the link. Consequence: nothing is
  submodule-free, `check`/L1/L2 included.
- **Two submodules, both blobless + sparse, both provisioned by `scripts/init-submodule.sh`
  (`provision`), re-asserted on every run.** `vendor/tinkerpop` is sparse to four dirs:
  `gremlin-language` (the `Gremlin.g4` source), `gremlin-js` (the linked GLV + cucumber runner),
  `gremlin-test` (the `.feature` corpus), and `gremlin-core` — the Java core engine, **reference only,
  never built or imported**. `vendor/calcite` is the RelIR's prior art on the same reference-only
  footing (never built, never imported, no Java toolchain implied), sparse to the seven dirs it takes
  to trace `rel2sql`; ~17 MB because it is also `shallow`.
  **Cite upstream as `vendor/tinkerpop/...` or `vendor/calcite/...` so the claim resolves at the
  pinned gitlink**; a path outside the repo is uncheckable by anyone else and by CI, and the outside
  clone is typically at a SHA that is not even a valid object in our blobless history.
  **`shallow` vs `full` is a real distinction, not a size knob.** A shallow checkout holds ONE commit,
  so `git log`/`git blame` do not work in it and moving the pin means re-provisioning — `--depth 1`
  cannot fetch an off-tip SHA without reconciling the shallow boundary and dragging the history graph
  in (measured on calcite: 3.9 MB of pack → 21 MB, permanently). tinkerpop is therefore `full`: we
  diff a pin bump against the previous pin. calcite is `shallow`: we only ever read it at the pin.
- **A linked worktree SHARES the main checkout's `vendor/<sm>` by symlink rather than cloning its
  own** (`share_from_main`), which also means one client build and one `bun link` target instead of
  one per worktree. Measured before: four checkouts held 1.2 GB of `vendor/` trees + 317 MB of packs,
  ~1 GB of it duplication; this worktree's `vendor/` went 299 MB → 88 bytes. Three things make it
  safe, and none is optional:
  - **`git update-index --skip-worktree vendor/<sm>`, re-applied every run.** Without it `git add -A`
    rewrites the `160000` gitlink into a `120000` symlink entry, and committing that deletes the
    submodule for everyone. Measured, not theoretical. The index is per-worktree, so it cannot leak
    into the main checkout — and a superproject checkout/rebase resets it, which is why it is
    re-applied rather than set once.
  - **the shared submodule's `.git` gitdir pointer is rewritten ABSOLUTE.** git writes it relative,
    and through a symlink at a different depth it resolves against the LINK's path and misses —
    taking out `git status` in the superproject and any `git -C vendor/<sm> …`.
  - **share ONLY when the two gitlinks agree**, else provision locally. A shared tree is whatever
    commit MAIN is at; for tinkerpop the L3 corpus AND the client come out of it, so a divergent pin
    would run conformance against a corpus it does not describe — a wrong ANSWER, not an error.
  `--root <dir>` exists so the worktree's OWN copy of the script provisions main (each checkout has
  its own committed copy, and reading main's made behaviour depend on what trunk happened to hold).
- **A BIND SERVES A USER PARAMETER — nothing else earns one.** A GValue the client sent in the
  `bindings`/`parameters` map is the user's strongest signal of intent ("this is variable, it will
  change"); that is what a `?` is *for*, and the 100-bind cap below is therefore a **parameter budget**.
  A value the compiler already holds — a **parsed literal** (the `30` typed in the Gremlin string), an
  ordinal, a class name, a JSON path, an `as()` label — is a **constant**: inline it as a *typed* SQL
  literal (we know the type — the argument's `Arg.type` — so storage class follows the literal's form; do not
  re-derive it), spending zero of the 100. The statement cache is the *user's* payoff for sending a
  GValue, never a reason for US to manufacture a bind on a constant. Two traps a clean context keeps
  falling into, both wrong: "inlining a literal defeats the cache" (the cache is not ours to farm) and
  "keeping params as binds needs provenance" (it needs us to STOP flattening `$x` at `frontend.ts` —
  deleting a lossy step, not adding tracking). A parameter is a first-class concept at every layer
  (this is TinkerPop 4's `GValue`), reduced to a concrete value only at the last responsible moment
  (only `unrollFixedRepeat` needs it). The only non-parameter values that may still bind are the
  MECHANICAL exceptions — a collection `{t,v}` tree and, pending measurement, the big-decimal/duration
  tail — a NAMED category, not evidence that "data must bind." Full rationale + phased plan:
  `docs/archive/2026-08-05-parameters-are-the-only-binds.md`. (Legacy `src/compiler/steps/**` is dead — do not
  reclassify its binds.)
- **DO SQLite caps a query at 100 BOUND PARAMETERS (and 100 KB of statement text) — Bun's cap is
  65,535, so a bind list that scales with ROW COUNT passes every test and fails only in production.**
  Never write `ids.map(() => '?')`. **A row set whose size is a function of DATA crosses the seam as
  ONE VALUE — a single JSON bind exploded by `json_each` — read or write**; a set bounded by the
  QUERY TEXT may stay an IN-list. Two gates keep it that way: `mise run binds` statically,
  `mise run test:cf-limits` at runtime (`src/cf-limits.ts` — the `Sql` decorator that makes a DO-only
  wall fail on Bun).
  **The rule is STRUCTURAL, not a benchmark result** — three independent reasons, none of which a
  runtime release can move: a read cannot chunk at all (a compiled plan is one statement, and the set
  must be a relation it can join against); a chunked write cannot be a value the algebra references,
  which is what preserves a cascade's pre-mutation snapshot; and one value makes a plan's bind count
  O(plan size) BY CONSTRUCTION rather than an idiom to grep for. Typing goes the same way — JSON
  transport fails closed on what it cannot carry (`src/program.ts`) and AGREES across runtimes where
  native binds do not (an integer binds INTEGER on Bun, REAL on DO; `boolean`/`bigint` throw on DO).
  Its one real cost: a BLOB cannot travel, so **a `RETURNING` feeding a retained binding projects
  `json(x)`, never `jsonb`.** Performance merely agrees (chunking ~1.7× faster on `bun:sqlite`, ~2×
  SLOWER on DO) — a tiebreaker, and a reminder that picking the form the DEV runtime prefers is the
  error `cf-limits.ts` exists to prevent. There is no longer a second write mechanism: the chunked
  row-at-a-time driver is deleted, and the ONE runtime write driver is `src/setwrite.ts` — a data-sized
  batch is a relational `Insert` over `json_each`, rendered by the RelIR emitter like any compiled write.
- Storage runtimes meet at the sync **`Sql` interface** (`src/storage.ts`): `bun:sqlite` (dev) and
  DO `ctx.storage.sql` (prod). Compiler + frame tier are storage-agnostic; the HTTP edge never
  touches a store. **Bind-type gotcha:** DO SQLite throws on `boolean`/`bigint` binds — `GraphStore`
  coerces them at the one seam so both runtimes agree.
- **A QUERY FAILURE IS NOT A CRASH, at either boundary it crosses.** Server-side it is returned to
  the client on the GraphBinary trailer and NOT logged — the router's default `QueryLogger` is
  silent (`src/router.ts`; `$MOGWAI_LOG=1` for the access log), because the common failure is an
  unsupported traversal, i.e. someone else's typo, not our incident. DO-side it crosses the RPC
  boundary as a VALUE (`src/cloudflare/rpc.ts`): a throw out of a Durable Object RPC method is an
  *uncaught exception* to workerd, which logs a stack and counts it in the DO's error rate, so
  every user typo would read as a DO crash in production observability. The DO-side stack travels
  with the value and is rethrown on the caller side, so nothing that was diagnosable stops being so.
  Test-output discipline follows from the same rule and lives in `test/CLAUDE.md`.
- **A SECOND storage seam, `IoStore` (`src/iostore.ts`), hides where a graph's DOCUMENTS live** —
  `Sql` hides where its rows do. ASYNC (an object store's get/put are promises, which costs nothing
  because `io()` is a barrier service): a rooted directory on Bun (`$MOGWAI_IO_DIR`, so a path cannot
  escape it), an **R2 bucket binding** inside a DO (`IO` in wrangler.jsonc — bindings are a property of
  a DO's env exactly as they are a Worker's, so a whole-graph read/write happens where the graph
  lives). **Optional on both**, and absent it fails closed NAMING the missing binding rather than
  silently doing nothing. Formats are adapters in `src/formats/`, draining through the shared
  keyset-page + `json_each` membership helpers (`src/formats/drain.ts`) and loading through the
  set-based writer: typed GraphSON adjacency is the lossless one (backup, seeding, `io()`), CSV is
  interop-only and says so by refusing what it cannot carry.
- Bun ⇄ Cloudflare via DI (`@bodar/yadic`): `application(deps)` wires the shared router from one
  injected `GraphManager`. Entry points: `src/bun/server.ts`, `src/cloudflare/worker.ts`.
- Web-session-only facts (which environment can build this at all, the shallow clone, pushing to a
  shared trunk) are NOT here — see the pointer in "Where subsystem detail lives".
