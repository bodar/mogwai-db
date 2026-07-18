# CLAUDE.md — mogwai-db

Context for Claude working on this repo. This file is **only the things that took
an investigation to learn** — durable facts and guardrails, not a changelog. Do not
re-derive them; do not turn this back into a progress log.

**For "is step X supported, and where's the edge?" → `docs/feature-support-matrix.md`**
— a living, code-grounded capability map (✅/🟡/❌/🚫 per step). Keep it in sync when a
step's support changes. Per-feature design docs live in `docs/` (dated); consult them
for rationale, but this file must not depend on any in-flight plan doc.

## What this is

A TinkerPop 4 Gremlin server compiled onto SQLite, targeting Cloudflare Durable
Objects. One DO = one isolated graph, created on first request via `idFromName`. Any
TinkerPop 4 GLV in any language connects over plain HTTP. Verified against unmodified
`gremlin@4.0.0-beta.2` on both runtimes (Bun + Cloudflare DO): the shared contract
(`test/contract.ts`) passes over GraphBinary; 2298/2298 official corpus parse rate.

The name: *mogwai* (魔怪) is Cantonese for a mischievous little devil — fitting for a
pocket-sized graph that speaks **Gremlin**, the TinkerPop query language.

## Working rules

- **No new dependencies without explicit approval** — runtime or dev, and no second
  build/test tool. This includes defaults pulled in by skills/docs (e.g. a skill
  suggesting Vitest when the project runs `bun test`). Surface the tradeoff, don't
  silently add.

## Locked decisions — do not relitigate without strong cause

1. **TinkerPop 4, not 3.7.** v4 dropped bytecode; the wire format is a canonical
   Gremlin string + parameters over HTTP.
2. **Parser is generated, never edited.** `parser/` comes from TinkerPop's canonical
   `Gremlin.g4` via antlr4ng (TypeScript target). Track upstream by regenerating
   (`mise run generate`). If you find yourself editing generated files, stop.
3. **Compile to SQL, never interpret.** Each read step lowers to CTE-chained SQL;
   SQLite's planner + covering indexes do the traversal. Row-at-a-time JS
   interpretation is the failure mode this project exists to avoid.
4. **Reuse the client's GraphBinary code — reuse-first, not reuse-only.** `gremlin`'s
   `build/esm/structure/io/binary` ships ~30 bidirectional serializers (Apache-2.0);
   default to reusing them. NOT a hard lock: where the client is deficient we fix it in
   our wire layer (we hand-roll `vertexBuffer`/`edgeBuffer`/`vertexPropertyBuffer` in
   `execute.ts` precisely because the client's serializers hardcode empty properties).
5. **Own IR = the step chain** `{name, args}[]`. The grammar visitor is a thin
   front-end; the compiler consumes the IR. If the wire format changes, only the
   front-end moves.
6. **Graph selection: URL path first, `g` body field as fallback.** `POST
   /gremlin/{g}` routes with NO body parse; the body `g` field is peeked ONLY on the
   bare `/gremlin` endpoint a stock client uses. `id = pathG ?? bodyG ?? 'g'`, resolved
   identically on both runtimes into one flat namespace. TinkerPop has no data-plane
   create/drop-DB API — DO-on-first-access *is* the provisioning story.

## SQL generation — the `q` kernel

The compiler builds SQL with a template-first `q` kernel + typed `Relation` handles:
`src/q.ts` (`q`/`Relation`/`Query`/`list`/`empty`) + `src/schema.ts` (nodes/edges/labels
relation constants). **Only `src/q.ts` may import raw lazyrecords `Text`/`Compound`**;
every step module builds through the kernel. Do NOT reintroduce ansi builders
(`select`/`from`/`join`/`cte`/…) — retired. The kernel renders an aliased relation as
`edges e` (no `AS`) and `rel.c.x` as `qualifier.x`.

`q.derived(body, cols, alias)` is the typed **non-CTE** relation boundary: use it when
SQL needs a subquery but the Query graph doesn't need a separately named intermediate.
Wrap a relation in a named CTE only when it's shared/reused or the planner needs an
intentional materialization boundary.

## Compiler architecture

`compile()` (`src/compiler.ts`) is a thin orchestrator: `parse → normalize → dispatch`.
Three seams:

- **Seam 3 — `src/strategies.ts`:** pure `Step[]→Step[]` normalization passes run once
  up front (strip terminal, fold repeat clusters, fold by() modulators, apply
  `withStrategies`) so dispatch sees a canonical, peek-free chain. No index arithmetic
  in step compilers; multi-step modulator consumption belongs in a strategies fold.
- **Seam 2 — `src/steps/*.ts`:** the read prefix is a functional fold of `StepFn`s over
  an immutable typed **`Stream`** (`context.ts`/`stream.ts`). The union:
  `ElementStream`/`ScalarStream`/`VariantStream`/`ListStream`/`PropertyStream`/
  `RecordStream`/`GroupStream`/`PathStream` (+ internal `MapStream`). `lowerSteps` is the
  one iterative shape orchestrator; a retype yields a `LoweringContinuation` back to it,
  so `V().fold().unfold().out()` flows elements→list→elements, each phase with its own
  ≤1 projection. Per-family modules: `movement`/`filter`/`branch`/`passthrough`, writes
  (`write.ts`), the tail split per step-family (`projection.ts` dispatcher +
  `coerce`/`inject`/`select`/`mapscalar`/`group`). To add a step: write a `StepFn`,
  register it in the right Map — do NOT grow a switch.
- **Root materialization (`steps/materialize.ts`):** read leaves never frame themselves.
  `materializeFinal`'s exhaustive `materializeStream` switch is the only read caller of
  `readCompiled`. Do not add a terminal `Compiled` branch in a leaf.

### Compiler extension law — mandatory

`lowerSteps(Stream, steps, at)` is the semantic authority for read traversals at root
and child scope. To implement a step: normalize sibling/modulator structure in
`strategies.ts`; lower from the appropriate typed `Stream`; for a child, push a
`ChildScope` (`steps/child.ts`) and run the same engine; materialize only at the root.

**Do NOT add** a private child-traversal parser or supported-step vocabulary, a
`compileNested*` mini-compiler, sibling/index scanning inside a step compiler, a second
movement/filter/projection implementation, direct materialization from a read leaf, or
loose domain/ordinal arguments where `CompileScope` owns that state.

The generic child seam (`steps/child.ts`) is how one traversal runs per parent
traverser: `pushChildScope` gives each parent a multiset-safe ordinal + preserved
domain; `reuseCurrentFrame` lets N siblings share one domain (the multi-modulator
pattern). Element/scalar/list/fold children, existence gates
(`tryFilterByChildExistence`/`tryCombineByChildExistence`), and reducers
(`lowerScopedScalarReducer`) all lower through it. The seam is **parent-shape-polymorphic**
(`ChildParent = ElementStream | PropertyStream`): a `properties().group().by(__.…)` folds
over PROPERTY parents, and its `key()`/`value()`/`element().…` by()-children lower through
the SAME `lowerSteps → compileFromProperty` dispatcher — there is no property-group inline
reader (the old `tryPropertyGroupScalar` was retired). Element-valued property children
(no adjacency) fail closed in the element-only cores.

**Fast paths** are explicit per-compilation switches in `CompileOptions.fastPaths`
(`src/fast-paths.ts`) — never a mutable global. A specialized lowering qualifies as a
fast path only when: the generic path stays the semantic authority and disabling the
switch compiles the same traversal generically; recognition failure returns `null`/falls
through (never defines support or throws because its optimized vocabulary is exhausted);
enabled-vs-disabled are result-equivalent in a committed test; and an EXPLAIN/benchmark
shows material benefit. Currently: `predicateInlining`, `singleHopOptional`,
`bulkRepeatCount`, `scalarPredicateInlining` (the scalar-parent predicate gate: inline
`WHERE` over the value vs a correlated EXISTS over a pushed scalar scope — used by
`and`/`or`/`not`/`filter`/`where`/`choose`/`coalesce` over a scalar). A fast path should reuse the surrounding plumbing and swap only the
"middle" — e.g. the predicate family (`predicateInlining`, `src/steps/predicate.ts`)
feeds one boolean `Expression` to the shared `filterCte`; the fast middle is the GENERIC
movement/filter StepFns rendered in inline-correlated mode (`compileCorrelatedChild`,
`src/steps/correlated.ts`) — a nested correlated `derived()` subquery seeded from the
outer row's id, NOT a second hand-rolled movement/alias/EXISTS scheme — and the generic
middle is a materialized child gated on existence. Alias safety is structural: each
StepFn wraps the prev relation as a FROM-clause derived table (`(<prev>) p`), and FROM
derived tables are not laterally visible, so the innermost seed's correlated `n.id`/
walk-id can never bind to an intermediate `nodes n`/`edges e` the child introduces — no
`xe`/`xn` renaming needed. The predicate compiler lives in `steps/` (not `plan.ts`)
precisely so this movement branch can reach `lowerElementSteps`.

**Migration debt, NOT extension patterns:** `until()`'s predicate is the ONE
correlated-only consumer (a recursive-CTE term can't reference its outer row, so it has
no materialized generic fallback) — but it is NOT debt: it correlates through the same
`compileCorrelatedChild` as where()/choose(). (The former property-group inline reader
`tryPropertyGroupScalar` is GONE — property groups now use the parent-polymorphic child
seam above.) Do not add a new fast-path switch without its generic fallback + equivalence
test + perf evidence in the same change.

## Management API + runtime parity

Whole-graph lifecycle is a thin REST layer on the same `/gremlin/{g}` path, **identical
on Bun and Cloudflare** — no separate control plane. The shared `makeRouter`
(`src/router.ts`) is the edge; it owns the two HTTP-facing concerns — wire parsing
(`src/wire.ts`) and response framing/pacing (`src/http.ts`) — and dispatches by verb onto
an injected `GraphManager` (`src/manager.ts`, the per-runtime seam, sibling to `Sql`). The
data-plane seam is **`query(id, gremlin, params) → Promise<Buffer[]>`**: the store tier
(`src/execute.ts`) compiles + runs + frames and returns GraphBinary buffers; the edge
streams them. **No HTTP in the store tier / DO.**

- `POST /gremlin/{g}` → query (graph from path). `POST /gremlin` (bare) → graph from body
  `g`. `PUT` → create-if-absent (201). `GET` → `{vertexCount,edgeCount}`. `DELETE` → 204.
  Always 200 for queries; errors ride the GraphBinary status trailer. All create-on-demand.
- **Idempotent + create-on-demand on both, because CF's DO namespace has no
  "does this exist?"** (`getByName` always returns a stub). No verb 404s on a valid id.
- **Teardown = `ctx.storage.deleteAll()`, NOT dropping tables** (dropping leaves
  metadata; `deleteAll` is the only route to zero storage/billing). CF gotcha (cost a
  debug cycle): `deleteAll()` wipes tables but the warm DO keeps serving, and its
  `GraphStore` ran DDL once in the ctor → next request hits `no such table`. Fix
  (`worker.ts`): `destroy()` sets an in-memory `wiped` flag; `ensureLive()` lazily
  re-runs `initSchema()` on reuse. Lazy not eager, on purpose (an abandoned graph stays
  GC-eligible). Proven identical by `managementContract` in `test/contract.ts`.
- Known limitation (both runtimes): a `DELETE` racing an in-flight `POST` on the same
  graph fails *safe* (a GraphBinary error, no corruption), not correct.
- **Self-describing surface (GET-only, both runtimes):** `/openapi.json` (hand-written
  OpenAPI 3.1, `src/docs.ts`), `/docs` (a pinned Scalar shell — zero-dependency), `/` → 302
  `/docs`.

## Hard-won wire-protocol facts (each cost debugging time)

- beta.2 sends **requests in GraphBinary** (`0x84 + map(fields,bare) +
  string(gremlin,bare)`); master moved to JSON. Sniff first byte 0x84, accept both. The
  parameter field is named `bindings` in binary requests.
- Response frame: `0x84, bulked(0x00), values…, 0xFD 0x00 0x00, status int (bare),
  nullable message, nullable exception`. Always HTTP 200; errors ride the status trailer.
- **Chunked streaming** (`src/http.ts`): v4 chunking splits ONE logical frame across HTTP
  chunks (HEADER once, then values `resultIterationBatchSize` at a time, then the trailer)
  — NOT N frames. Framing fully completes before streaming, so a value can't fail
  mid-stream; any throw surfaces as a buffered 500. The beta.2/master JS client buffers
  the whole body and streams neither direction. On DO the SQLite cursor can't be held
  across `await`s, so the store drains the row array up front — the seam returns the whole
  array anyway, so streaming only avoids the final concat copy (a cursor-lifetime floor,
  NOT transport; do not log it as a memory win).
- `iterate()` appends `.discard()`. Strip trailing discard/none, execute, return no values.
- Grammar node classes encode step + overload: `TraversalMethod_limit_long`. Overload
  suffixes are **lowercase** — the step name is the segment before the first underscore.
- The client's vertex/edge/VP serializers **hardcode empty properties** — we hand-roll
  framing from ioc primitives (`execute.ts`).
- DO SQLite has **no user-defined functions**: regex TextP and anything SQL can't express
  is filtered post-SQL in JS inside the DO.

## Schema (src/storage.ts) — rationale

Integer rowid PKs; interned labels (small hot indexes); covering edge indexes
`(src,label,tgt)` and `(tgt,label,src)` so out()/in() are index-only. `nodes`/`edges`
carry a nullable `uid TEXT UNIQUE` (user-supplied ids); rowid stays the internal PK.

**Properties are normalized on both node and edge.** `vertex_properties(id, node, key,
value, vtype, meta)` — one row per VertexProperty instance, so a key may repeat
(multi-property `list`/`set`), `id` (rowid) IS the VertexProperty id, `meta` is a JSONB
meta-property blob. `edge_properties(id, edge, key, value, vtype, UNIQUE(edge,key))` — a
TinkerPop edge `Property` has no id/meta/multi, so one row per (edge,key). The old flat
JSONB `edges.props` blob is retired.

`value` has **no declared type** (BLOB affinity) so it keeps the bound value's SQLite
storage class → correct numeric order/range for `has('age',gt(30))`/`order().by('age')`.
`vtype` = the canonical Gremlin type the write channel carried (`src/gremlin-types.ts` is
the one type vocabulary), sourced from the truth channel (bound param's GraphBinary
DataType captured in `wire.ts` and threaded through `query`→`compile`; inline literal's
parsed subtype). NULL vtype = infer on read. A collection value stores as JSONB — a
**self-describing typed tree** (`ValueNode`): the sibling `vtype` names the OUTER shape and
every nested element/key/value carries its own `{t,v}` tag, so collection ELEMENTS, typed &
non-string map KEYS, and arbitrary nesting round-trip with each leaf's exact gremlin type
(`valueNodeOf` on write; `frameTypedNode`/`propNodeExpr` on read/frame — the whole
`docs/2026-07-17-full-fidelity-typed-collections-plan.md` family).

**Static covering indexes** `vp_key_value(key,value)` + `vp_node_key(node,key)`, built at
schema time. A property key BINDS as a parameter (`key=?`) — a plain B-tree column seeks
fine bound, so no literal splice and no injection surface.

**The read seam (`src/plan.ts`).** Nodes AND edges read props via `idExpr` into their own
normalized table (no `propsExpr`). `hasProp`/`scalarProp`/`framedProps` dispatch on elem,
each with an edge twin (`edgeHasProp`/`edgePropScalar`/`edgePropsAgg`). `framedProps`/
`valueMapProps` read only at leaf materialization (never inside movement/filter CTEs, so
the hot path stays index-only). `values('k')` is a flatMap JOIN (one row per multi-value).

**Writes (`src/steps/write.ts`).** `applyVertexProperty` (single=delete-then-insert,
list=append, set=append-unless-equal); `insertEdgeProperty` (UPSERT, single cardinality).
`drop()` cascades both property tables. JSONB is available on both runtimes (DO 3.47.0,
Bun 3.53.0): bind JSON *text* + wrap `jsonb(?)`, read back via `json(col)` (a raw Buffer
bind diverges across runtimes — see the bind-type gotcha below).

## Semantics traps — encode as tests before touching related steps

- Traversers are multisets: UNION ALL everywhere; only `dedup()` collapses.
- `both()` on a self-loop yields the vertex twice.
- `repeat()` needs an exit modulator (`times()`/`until()`/`emit()`); bare `repeat()` is
  rejected. **No artificial depth cap** — `times()` bounds depth; `until()`/`emit()` run
  to the natural fixpoint. A cyclic body without `simplePath()` is infinite *per the
  spec*; we compile it faithfully and rely on the DO's per-request CPU/memory limit as the
  backstop (blast radius is the caller's own tenant). Do NOT reintroduce a cap.
- Element ids are integer rowids externally faced as `COALESCE(uid, id)`; don't invent
  string ids. Edge endpoints frame as external ids at materialization only.
- **Correct by design, fail closed:** never reject a valid input to keep scope small, and
  never silently answer a different question. An unsupported shape throws a clear deferral
  or falls through to the generic path — it never mis-executes.

## Testing (the build discipline)

Everything runs under bare `bun test` (scoped to `test/` by `bunfig.toml`). The
`vendor/tinkerpop` submodule (pinned at 4.0.0-beta.2 = the published npm) supplies the
grammar, Gherkin features, and JS cucumber runner; `mise run submodule` provisions it
blobless+sparse (self-healed in the L3 test's `beforeAll`).

**Version split — DO NOT collapse (cost a full investigation):**
- **Parser + corpus track `origin/master`** (a strict superset of beta.2 — adds
  unreleased-but-landing literals/args, removes nothing → forward-compatible). `mise run
  generate` (antlr-ng, byte-stable) and `mise run regen-corpus` source `origin/master`.
- **L3 conformance tracks the pinned beta.2 checkout** (matches the `gremlin` npm dep +
  its GraphBinary wire). Pinning L3 to master breaks it (master's cucumber harness hits a
  bun+cucumber dual-instance load issue) for zero gain. Bump the pin only when a new
  `gremlin` npm ships.
- **L1** (`test/conformance/corpus.test.ts`): 2,298 canonical traversals; parse+chain must
  stay 100%.
- **L3** (`test/conformance/l3.test.ts`): a ratcheted `bun test` — boots the conformance
  host in-process and runs the official cucumber suite over GraphBinary. TWO gates: (1) the
  committed passing-SET `test/conformance/l3-passing.txt` (scenario names) — ANY scenario
  that passed at baseline and fails now is a REGRESSION → fail + name it (with its failing
  step + error), no noise from the ~740 always-deferred; this catches a net-positive run
  that silently breaks a green scenario, which the count alone would hide; (2) the count in
  `baseline.json`: fewer → fail. A clean run (`!CI`) folds new passes into the set + bumps
  the count, and rewrites the count in every file in `SYNC_FILES` (`README.md` +
  `docs/feature-support-matrix.md`), each fenced by `<!-- L3:passing -->…<!-- /L3:passing -->`
  so the prose can't drift; commit `l3-passing.txt` + `baseline.json` + synced files
  together. CI never rewrites (it only reads). Add a new SYNC consumer by giving it the
  marker + listing it in `SYNC_FILES`. Step scope =
  `test/conformance/tags.ts` (widen as steps land; never narrow). NB `@StepWrite` tags
  the `io().write()` graph-SERIALIZATION step (deliberately excluded), NOT the data-write
  steps — addV/addE/mergeV/mergeE carry `@StepAddV`/`@StepAddE`/`@StepMergeV`/`@StepMergeE`,
  are untagged in the exclusion list, and are already in scope + ratcheted. Runbook:
  `test/conformance/README-cucumber.md`.
- **L4** (`test/conformance/l4.test.ts` + `test/conformance/addendum/*.feature`): OUR
  addendum suite — valid traversals the official corpus doesn't cover (our combinatorial-
  completeness work), authored in TinkerPop's exact Gherkin format. NOT cucumber-driven: the
  official harness binds a scenario name to a vendored generated `gremlin.js`; we parse Gremlin
  natively, so `l4.test.ts` reads each scenario's embedded string + `| result |` table and runs
  it through the REAL stack (`executeQuery` → GraphBinary, decoded by the client `ioc` — so our
  extended serializers are exercised both directions). Gate = **all pass** (ours; not a subset
  like L3). `@gap:<area>` tags mark families for an upstream `gremlin-test` PR (the give-back).
  Add a scenario = drop it in a `.feature`; no code change. See `addendum/README.md`.
- Every new step lands with SQL snapshot tests, its cucumber tag added to `tags.ts`, and
  corpus still 100%.
- **SQL snapshots assert semantic equivalence, NOT byte-identity.** They mostly `.toContain`
  the meaningful SQL fragments; whitespace, formatting, and incidental token spacing never
  matter. When a change alters emitted SQL the bar is that it means the same thing (same
  result set + plan shape) — do NOT chase byte-for-byte identical output, and do not treat a
  refactor as "unsafe" because the string moved. Update the snapshot to the equivalent SQL.
  (This is the canonical statement of the rule; other docs must not reintroduce a
  byte-identical *requirement*.)

The L3 harness (`test/conformance/conformance-server.ts`) is the SAME shared stack as the
production Bun server, with toy graphs pre-seeded by running each graph's write traversals
through the normal query path (`seed-*.ts`).

## Environment notes

- Runtime is **Bun** (pinned in `mise.toml`), not Node — runs TS natively, no tsx/esbuild.
  `bun run start` serves via `Bun.serve`; `bun test` runs the suite.
- Build graph is mise tasks: `install ─▶ {test, build} ─▶ ci`. GitHub Actions runs `mise
  run ci` — nothing CI-specific in the workflow, so the gate is reproducible locally.
- Storage runtimes meet at the **`Sql` interface** (`src/storage.ts`, both sync):
  `bun:sqlite` (dev) and DO `ctx.storage.sql` (prod). The agnostic `GraphStore` (schema,
  label interning) sits on top; compiler + execute/frame tier are storage-agnostic; the
  HTTP edge never touches a store.
- Bun ⇄ Cloudflare via DI (`@bodar/yadic`): `application(deps)` wires the shared `router`
  from one injected `GraphManager`. Entry points: `src/bun/server.ts`,
  `src/cloudflare/worker.ts`. Reference impl: `~/Projects/the client`.
- **Bind-type gotcha (cost a review cycle):** `bun:sqlite` accepts `boolean`/`bigint`
  binds; DO `ctx.storage.sql` throws on them. `GraphStore.query` coerces boolean→1/0 and
  bigint→number at the one seam so both runtimes agree. Covered by a contract test.
- `src/io.ts` reuses gremlin's GraphBinary serializers via a RELATIVE import (bypasses the
  package `exports` map). Upstream fix pending: apache/tinkerpop#3511 adds a `gremlin/io`
  export.
- Useful references in the Apache TinkerPop repo (sparse-clone it): grammar at
  `gremlin-language/src/main/antlr4/`, features at `gremlin-test/.../features/`, JS GLV +
  cucumber runner at `gremlin-js/gremlin-javascript/`.
