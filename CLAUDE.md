# CLAUDE.md — mogwai-db

Context file for Claude (Code or otherwise) working on this repo. Read
`docs/2026-07-11-phased-roadmap-plan.md` after this; it has the phased roadmap
and test strategy. This file is the things that took a whole investigation to
learn — do not re-derive them.

**SQL generation (current):** the compiler builds SQL with a template-first `q`
kernel + typed `Relation` handles — `src/q.ts` (kernel: `q`/`Relation`/`Query`/
`list`/`empty`) + `src/schema.ts` (nodes/edges/labels relation constants). Design
+ rationale: `docs/2026-07-12-q-kernel-sql-builder.md`. Do NOT reintroduce
lazyrecords ansi builders (`select`/`from`/`join`/`comparison`/`cte`/…) — retired;
only `src/q.ts` may import raw lazyrecords `Text`/`Compound`, every step module
builds through the kernel.

**Compiler is fully decomposed (all 3 seams done, 2026-07-12).** `compile()` in
`src/compiler.ts` is a 51-line orchestrator: `parse → normalize → dispatch`.
- **Seam 3 — `src/strategies.ts`:** pure `Step[]→Step[]` normalization passes
  (`stripTerminal`, `foldRepeatClusters`, `foldByModulators`) run once up front so
  the dispatch sees a canonical, peek-free chain (no index arithmetic anywhere).
- **Seam 2 — `src/steps/*.ts`:** the read prefix is a **functional fold** —
  `StepFn = (step, St) => St` over an immutable `St` (`context.ts`); only the
  `Query` builder accumulates CTEs. Per-family modules (`movement`/`filter`/
  `branch`/`passthrough`), tail (`projection.ts`: `PROJECTORS` + `MODIFIERS` Maps +
  group/properties/select barriers), writes (`write.ts`: imperative interpreters
  behind an ordered `WRITE_RULES` table). `index.ts` = `PREFIX` Map + `buildPrefix`
  + `compileRead`. To add a read step: write a `StepFn`, register it in the right
  Map — do NOT grow a switch. Multi-step modulator consumption belongs in a
  `strategies.ts` fold, NOT in a compiler peeking at siblings.

## What this is

A TinkerPop 4 Gremlin server compiled onto SQLite, targeting Cloudflare
Durable Objects. One DO = one isolated graph database, created on first
request via `idFromName`. Any TinkerPop 4 GLV in any language connects over
plain HTTP. Verified against unmodified `gremlin@4.0.0-beta.2` on both runtimes
(Bun + Cloudflare DO): the shared contract (`test/contract.ts`) passes over
GraphBinary, 2298/2298 official corpus parse rate.

The name: mogwai are what gremlins start as. A DO that becomes a Gremlin
server when you feed it. npm name `mogwai-db` (bare `mogwai` is squatted by
a dead 2013 OGM).

## Working rules

- **No new dependencies without explicit approval.** Do not add a package
  (runtime or dev) — or a second build/test tool — without asking first and
  getting a clear yes. This includes defaults pulled in by skills or docs
  (e.g. a skill suggesting Vitest when the project runs `bun test`).
  Reconcile any such suggestion against the project's existing stack and
  surface the tradeoff instead of silently adding it.

## Locked decisions — do not relitigate without strong cause

1. **TinkerPop 4, not 3.7.** v4 dropped bytecode entirely; the wire format is
   a canonical Gremlin string + parameters over HTTP. We parse it with a
   generator-produced parser, not a hand-written one.
2. **Parser is generated, never edited.** `parser/` comes from TinkerPop's
   canonical `gremlin-language/src/main/antlr4/Gremlin.g4` via antlr4ng
   (TypeScript target). The grammar has zero embedded Java actions, so it
   generates cleanly. Track upstream by regenerating. If you find yourself
   editing generated files, stop.
3. **Compile to SQL, never interpret.** Each read step appends a CTE; SQLite's
   planner + covering indexes do the traversal. Row-at-a-time JS interpretation
   is the failure mode this project exists to avoid.
4. **Reuse the client package's GraphBinary code.** `gremlin`'s
   `build/esm/structure/io/binary` ships ~30 bidirectional type serializers
   (Apache-2.0). We wrote only response framing. Don't write serializers.
5. **Own IR = the step chain** `{name, args}[]`. Grammar visitor is a thin
   front-end; compiler consumes the IR. If the wire format ever changes,
   only the front-end moves.
6. **Multi-tenancy: tenant in the URL.** `POST /g/{graphId}` → Worker does
   `env.GRAPH.idFromName(graphId)` → DO. Auth tokens scope to the path. The
   request's `g` field (traversal source name) optionally selects a named
   graph *within* a tenant — two-level hierarchy for free. Do NOT route on
   the `g` field at the Worker layer; it would force body-parsing before
   routing. TinkerPop has no data-plane create/drop-database API — DO
   on-first-access *is* the provisioning story. *Element* deletion is native
   client gremlin (`drop()`, vertices+edges); *whole-graph* lifecycle is a thin
   in-band REST layer on the SAME `/g/{graphId}` path (see "Management API +
   runtime parity" below), NOT an out-of-band control plane.

## Management API + runtime parity (W3, DONE)

Whole-graph lifecycle is a thin REST layer on the same `/g/{id}` path, **identical
on Bun and Cloudflare** — no separate control plane. The shared `makeRouter`
(`src/router.ts`) owns ALL management HTTP framing in one place and dispatches by
verb onto an injected `GraphManager` (`src/manager.ts`), the one thing that differs
per runtime (sibling seam to `Sql`):
- `POST /g/{id}` → gremlin query (GraphBinary, always 200; errors ride the status
  trailer). Creates-on-demand.
- `PUT /g/{id}` → create-if-absent → 201. `GET /g/{id}` → `{vertexCount,edgeCount}`
  (auto-creates empty). `DELETE /g/{id}` → 204. Bad path → 404; bad verb → 405.

**Semantics are idempotent + create-on-demand on BOTH, because CF's DO namespace
has no "does this exist?" query** (`getByName`/`idFromName` always returns a stub;
the DO springs into being on first access). So no verb 404s on a valid id — that's
not laziness, it's the only honest mirror of the platform. Bun matches via
`BunGraphManager`: a `Map<id,GraphStore>` registry (one `bun:sqlite` per graph),
`:memory:` default, file-per-id (`{dir}/{id}.sqlite`, WAL sidecars removed on
destroy) when `$MOGWAI_DB_DIR` set. Element deletion stays native gremlin `drop()`
(vertices *and* edges).

**Teardown = `ctx.storage.deleteAll()`, NOT dropping tables** (CF docs: dropping
tables leaves internal metadata; `deleteAll` is the only route to zero storage /
stop billing). CF-only gotcha that cost a debug cycle and a contract-test failure:
`deleteAll()` wipes the SQLite tables but the **warm DO instance keeps serving** —
CF doesn't evict it synchronously — and that instance's `GraphStore` ran its schema
DDL once in the ctor, so the next request on the same instance hits `no such table:
nodes`. Fix (`worker.ts`): `destroy()` sets an in-memory `wiped` flag; `ensureLive()`
(called by fetch/create/info) lazily re-runs `GraphStore.initSchema()` on reuse.
Lazy, NOT eager in `destroy()`, on purpose — an abandoned graph then leaves storage
empty so the DO is GC-eligible and billing stops; only actual reuse pays to rebuild.
Proven identical on both runtimes by the shared `managementContract` in
`test/contract.ts` (write→count→destroy→recreated-empty, delete-twice idempotent).
Known limitation (both runtimes): a `DELETE` racing an in-flight `POST` on the
same graph can make the query resume against wiped storage → it fails *safe* (a
GraphBinary error, no corruption), not correct. This is the per-request-transaction
gap P4 still lists as remaining (DO single-threading + one implicit txn per request
closes it); destroy is a rare admin op, so it's not yet worth a lock.

**Self-describing docs surface (DONE).** The shared router also serves, GET-only,
on both runtimes: `/openapi.json` (a hand-written OpenAPI 3.1 spec for the 4 verbs,
`src/docs.ts`), `/docs` (a tiny Scalar shell rendering it as an interactive
reference — CDN-loaded, **pinned**, so zero npm dep and zero Worker-bundle cost),
and `/` → 302 `/docs`. Management verbs (PUT/GET/DELETE) are fully interactive in
Scalar's try-it; the gremlin POST accepts a JSON request body but its response is
still GraphBinary (binary), so try-it shows the request succeeding with an
unrenderable body. **Future improvement (scoped, not built):** content-negotiated
**untyped GraphSON v4** responses make the POST fully readable for non-binary
clients — `docs/2026-07-13-graphson-untyped-scope.md` (request-side JSON parsing
already works; only a parallel `executeJson` response encoder is missing).

## Hard-won wire-protocol facts (each cost debugging time)

- beta.2 sends **requests in GraphBinary** (`0x84 + map(fields,bare) +
  string(gremlin,bare)`); master moved to JSON. Sniff first byte 0x84,
  accept both. Parameter field is named `bindings` in binary requests.
- Response frame: `0x84, bulked(0x00), values..., 0xFD 0x00 0x00,
  status int (bare), nullable message (0x00+string bare | 0x01),
  nullable exception (same)`. Always HTTP 200; errors ride the status
  trailer and the client raises ResponseError with the message.
- `iterate()` appends a `.discard()` step. Strip trailing discard/none,
  execute, return no values.
- Grammar node classes encode step + overload: `TraversalMethod_limit_long`.
  Overload suffixes are **lowercase** — step name is the segment before the
  first underscore, not a regex on capitalization.
- The client's `VertexSerializer.serialize()` **hardcodes empty properties**
  (client never sends them). To materialize properties, write our own vertex
  framing from ioc primitives: `[DataType.VERTEX, 0x00] + any(id) +
  list([label], bare) + list(vertexProps, qualified)`. Its deserialize side
  reads them fine. This is the known blocker for valueMap/elementMap.
- DO SQLite has **no user-defined functions**: regex TextP and anything SQL
  can't express filters post-SQL in JS inside the DO.

## Schema (src/storage.ts) — rationale

Integer rowid PKs; interned labels (small hot indexes); props as JSON **text**;
covering edge indexes `(src,label,tgt)` and `(tgt,label,src)` so out()/in() are
index-only scans.

**JSONB is available on both runtimes** (verified 2026-07-12: DO SQLite = **3.47.0**
in workerd `1.20260708.1`; Bun dev = **3.53.0**; JSONB landed 3.45.0). Migrating the
`props` storage column to a JSONB blob is a *measured perf opportunity*, not done and
not a bug — json_extract/json_each skip the per-row text-parse. It is NOT a
find-replace: (a) the ~6 read sites doing JS `JSON.parse(r.props)` must select
`json(props)` (a JSONB blob isn't JSON.parse-able); (b) writes wrap `jsonb(?)`;
(c) contract-test both runtimes. Verified the property expression index STILL matches
on a JSONB column (`SEARCH … USING COVERING INDEX`), so the hot-property story
survives. Expected gain is marginal for the target workload (small OLTP prop-maps);
JSONB's win scales with JSON size — measure before migrating. **New JSON columns
(e.g. the recursive path-tracking column) should use JSONB from the start** — free
at build time, no migration, no read-boundary issue if framed in SQL.

Property key handling — **do not naively "always bind the key"** (`compiler.ts`
`propExtract`). SQLite matches an on-demand expression index
`CREATE INDEX ...(json_extract(props,'$.age'))` ONLY against a *literal* JSON
path; the parameterized `json_extract(props,'$.'||?)` form never matches, so it
forces a full SCAN and silently defeats the whole hot-property index story
(measured: 32 ms scan vs 0.35 ms index seek at 200 k rows, ~90×). So we splice
identifier-safe keys (`^[A-Za-z_][A-Za-z0-9_]*$`) literally — index-eligible,
injection-safe by *validation* — and fall back to binding only for exotic keys
(spaces/dots/unicode), which can't be an index target anyway.

Those expression indexes are **auto-built on first filtered use** (self-tuning,
no management endpoint / no key-guessing). `compileRead` reports the hot keys
used in a filter/order position (`has`, `order().by` — NOT plain `values`
projections, to bound proliferation) as `Compiled.indexKeys`; the handler calls
`store.ensureNodePropIndex(key)` for each before running. `ensureNodePropIndex`
is idempotent (`CREATE INDEX IF NOT EXISTS`) with a per-isolate cache. Cost: the
first filtered query on a cold key pays a one-time index build (~53 ms at 200 k
rows, ~270 ms at 1 M — blocks that one request), then it's a ~0.005 ms seek;
the index persists in SQLite across DO restarts. `test/performance.test.ts`
asserts via EXPLAIN QUERY PLAN that the key is reported, the index is built, and
it engages — failing if the literal splice or the auto-build regresses.

Perf shape: traversal hops (out/in/both) are index-only and sub-ms at 1 M edges
with no tuning; property filters/orders full-scan on first touch of a key, then
ride the auto-built expression index.

## Semantics traps — encode as tests before touching related steps

- Traversers are multisets: UNION ALL everywhere; only dedup() collapses.
- `both()` on a self-loop yields the vertex twice.
- `repeat()` needs an exit modulator — `times()`, `until()`, or `emit()` (bare
  `repeat()` is rejected). There is NO artificial depth cap: `times()` bounds depth;
  `until()`/`emit()` run to the natural fixpoint (frontier exhaustion). A cyclic body
  without `simplePath()` (any `both()`) is infinite *per the spec* — we compile it
  faithfully and rely on the DO's per-request CPU/memory limit as the backstop (a
  self-inflicted request fails, the DO reloads from durable storage; blast radius is
  the caller's own tenant). Do NOT reintroduce a cap — it silently truncated legit
  deep walks (removed 2026-07-13).
- Element ids are integer rowids; don't invent string ids.

## Testing (the build discipline)

Everything runs under bare `bun test` (scoped to `test/` by `bunfig.toml` so it
skips the submodule's own suites). The `vendor/tinkerpop` submodule (pinned at
4.0.0-beta.2 = the published npm) supplies the grammar, Gherkin features, and JS
cucumber runner; `mise run submodule` (a dep of `mise run test`, and self-healed
in the L3 test's `beforeAll`) provisions it blobless+sparse, so nobody has to
think about checkout. See `scripts/init-submodule.sh`.

**Version split — DO NOT collapse (cost a full investigation, 2026-07-12):**
- **Parser + corpus track tinkerpop `origin/master`** (ahead of beta.2). master's
  grammar is a strict *superset* (adds Char/Duration/Binary/PDT literals,
  `match(String)`, child-traversal args — all unreleased but landing, none
  removed), so mogwai is forward-compatible; beta.2 clients are unaffected
  (proven: L3=204). `mise run generate` (parser, antlr-ng) and `mise run
  regen-corpus` both source `origin/master` via the submodule. The committed
  parser is now **antlr-ng output** (was Java ANTLR 4.13.1) so `generate` is
  byte-stable; frontend uses only Lexer+Parser (Visitor/Listener unused).
- **L3 conformance tracks the pinned beta.2 checkout** (matches the `gremlin` npm
  dep `io.ts` links + its GraphBinary wire). Pinning L3 to master *breaks* it
  (204→0: master's cucumber harness hits a bun+cucumber dual-instance load issue)
  for zero gain — don't. Bump the pin only when a new `gremlin` npm ships.
- L1: `test/conformance/corpus.test.ts` — 2,298 canonical traversals; parse+chain
  must stay 100%. Step-frequency output = implementation priority order.
- L3: `test/conformance/l3.test.ts` — a ratcheted `bun test`. Boots the
  conformance host in-process (port 45940, hardcoded in the GLV's `helper.js`) and
  spawns `bunx --bun cucumber-js --format json` against the submodule runner. Parses
  the passing-scenario count, compares `test/conformance/baseline.json`: fewer →
  fail; more → auto-bump baseline *locally* (`!process.env.CI`; commit it) so CI
  only reads it (no re-trigger loop). Step scope = `test/conformance/tags.ts`
  (widen as steps land; never narrow). Full runbook: `test/conformance/README-cucumber.md`.
- Every new step lands with: SQL snapshot tests, its cucumber tag added to
  `tags.ts` (baseline ratchets up), corpus still 100%.

## P1–W2 done — read/write semantics (historical function names)

> **Names moved (see "Compiler is fully decomposed" above).** The P1–W2 notes below
> describe *semantics that are still current*, but the function/structure names are
> historical: `traversalCtes()` is now the `buildPrefix` fold in `src/steps/index.ts`
> (per-family `StepFn`s in `src/steps/{movement,filter,branch,passthrough}.ts`); the
> `compileRead` tail is `compileTail` in `src/steps/projection.ts`; the write compilers
> live in `src/steps/write.ts`; multi-step gathering (repeat cluster, by() modulators)
> is now `src/strategies.ts` normalization, so the compilers no longer scan siblings.

`compileRead` is two phases. `traversalCtes()` builds the movement/filter CTE
prefix (V, hasLabel, has, out/in/both, dedup, and range/skip/limit *as CTEs*)
and returns where it stopped. Then a tail loop consumes an optional projection
(values/id/label/count/valueMap/elementMap) plus `order().by(key[,dir])` and
range/skip/limit as **tail modifiers** that fold `ORDER BY`/`LIMIT`/`OFFSET`
into the final projection select. Key rule: range/skip/limit are CTEs when they
appear *before* any `order()` (so mid-chain `out().limit(5).out()` works) and
tail modifiers *after* order() (so ORDER BY + LIMIT stay one query). `count()`
wraps the tail-limited id-relation. `drop()` and `inject()` have their own
compile fns (`compileDrop`, `compileInject`).

Property materialization: `handler.ts` `vertexBuffer` frames the vertex from
ioc primitives instead of routing through anySerializer (whose VertexSerializer
hardcodes empty props). valueMap/elementMap build JS `Map`s; the id/label token
keys are `t.id`/`t.label` (from `io.ts`), which ride as GraphBinary `DataType.T`.

L3 harness: `test/conformance/conformance-server.ts` fronts the named graphs by the
request `g` field (DEV ONLY — production routes tenancy by URL path per the
locked decision). `makeHandler` now takes a `StoreSource` (a store *or* a
`(g)=>store` resolver). See `test/conformance/README-cucumber.md` to run the full
suite manually.

## P2/P3 read-compiler progress log (all landed; historical narrative)

> This section is a *record* of how the read compiler was built, not a to-do list.
> The **actual immediate next work is W3 — Cloudflare deploy + Worker auth** (see
> docs/2026-07-11-phased-roadmap-plan.md). Live L3 is 589 (path family, then the
> per-traverser branching family + multi-hop/alias where landed 2026-07-13; then the
> safe optimization-strategy whitelist 473→495; then the value-tail unification
> 495→496 (compileInject reuses the shared foldTailAcc+renderProjection in
> projection.ts, see docs/2026-07-13-seam-reuse-audit.md #1); then the typed-value
> carrier + asBool 496→508 (Shape value gains a compile-time `as?: ValueType` tag the
> handler frames by); then asNumber(GType.X) 508→525 (numeric subtype ladder — target
> from the explicit arg; const overflow-checks + runtime CAST); then bare asNumber()
> 525→534 (frontend now records each numeric literal's subtype in a parallel
> `Step.argTypes`; args stay plain numbers so no consumer ripple); then semantic
> strategies 534→582 (see below) — see docs/2026-07-13-per-traverser-branching.md).

**`math()` — LANDED (2026-07-13, L3 583→589).** `math("<formula>")` compiles to ONE
SQL arithmetic scalar (locked #3 — no per-row JS), always Double. The formula parser
is `src/math.ts` (pure: tokenizer + recursive-descent, precedence `+ -` < `* / %` <
unary `-` < `^` right-assoc < function-apply/primary; exp4j function set — `log`=natural
→`LN`, `signum`/`cbrt` expand inline; call form `ceil(_ * 100)` AND juxtaposition
`sin _`). **Correct-by-leaf-REAL-coercion:** literals emit real form (`100.0`), variables
wrap `CAST(… AS REAL)` → all arithmetic floats, so `/` is real division (SQLite `/` is
integer div on ints) with no per-op fixups except `^`→`POW`, `%`→`MOD`. `compileMath`
(`steps/projection.ts`, sibling to `compileMapScalar`/`compileChooseOptions`) resolves
each variable — `_`→`elemCtx` (current), an identifier→`aliasCtx` on the carried
`as()`-rowid column — through its `by()` modulator (a property key or nested traversal via
`compileNestedScalar`; positional/round-robin over folded `.bys` in first-seen variable
order, so 1 by feeds all vars, N bys feed N vars — matching `project()`). A missing by()
value → NULL arithmetic → the traverser is filtered (`baseWhere` = `<expr> IS NOT NULL`).
Routes through the shared `renderProjection` value tail, so a trailing
`.asNumber(GType.X)`/`is`/`order`/`dedup`/`limit` composes for free. `'math'` added to
`strategies.ts` BY_HOSTS. Frontend/handler unchanged (`stepName` extracts `math`
generically; `frameValue('double')` already exists). Deferred (clear throws): a var with
no by() (bare incoming — needs local()/sack()), `withSideEffect`-bound vars, and reading
`project()`/`select()` map columns (`order().by(__.math(...))`).

**Traversal strategies — semantic support LANDED (2026-07-13, L3 534→582).**
`withStrategies`/`withoutStrategies` are extracted from the parse tree by
`extractStrategies` (`src/frontend.ts`) into `{name,config}` specs and applied by
`applyStrategies` (`src/strategies.ts`) BEFORE `normalize()`. The insight: every
semantic strategy is a `Step[]→Step[]` rewrite emitting **synthetic steps the ordinary
dispatch already compiles** — no new SQL machinery. **SubgraphStrategy** injects
`where(vertexCriterion)` after every vertex producer (reuses the where/`compileExistsChain`
seam); **PartitionStrategy** injects `has(partitionKey, within(readPartitions))` after
every vertex/edge producer (read visibility) + `property(partitionKey, writePartition)`
after each addV/addE (write stamp). Optimization strategies stay no-ops (15-name
whitelist, moved here from compiler.ts); **verification** (ReadOnly/EdgeLabel/ReservedKeys)
throw TinkerPop's canonical messages. `withoutStrategies` is a safe no-op (we apply NO
default; a co-named `with` is suppressed). Two fail-closed invariants, DO NOT regress:
(1) an omitted `readPartitions` defaults to EMPTY = "see nothing", never "see everything"
(gating the filter on presence leaks all data); (2) any form a semantic strategy can't
yet filter — Subgraph edge/vertexProperty criteria + edge-landing steps (adjacency),
Partition meta-properties/merge, and ANY nested body (repeat/union/where-with-movement) —
throws a clear deferral rather than under-filter. ProductiveBy stays rejected (gated on
aggregate/cap). Rationale + the challenged "DO routing obviates partitioning" presumption:
`docs/2026-07-13-with-strategies-exploration.md`.

DONE: P2a (as/select/project/by column-threading), P2c-1 (edge traversal — the
typed node/edge `Elem` id-relation, edge shape, `edgeBuffer`), P2c-1b (property
elements), **P2c-2 (aggregation — gate + adjacent slice)**. Note P2c-1b did NOT
thread pkey/pval through movement as first sketched — `properties()` compiles in
its own tail fn `compileProperties`, because a property is a multi-column
traverser the single-`id` movement CTEs can't carry.

**P2c-2 shape (what landed).** `group`/`groupCount`/`fold`/`sum` + nested `by()`.
The L3 `BeforeAll` gate is **cleared** — official cucumber runs live (82 pass,
was 0). Key pieces:
- `compileNestedScalar(inner, ScalarCtx)` — compiles a nested `by(__.…)`/(future
  `where(__.…)`) traversal into a **correlated SQL scalar** for node/edge/property
  contexts (values/label/id/key/value/element/outV/inV/`out…count()`). This is
  the shared engine P2b's `where` builds on — extend it, don't rewrite it.
- `compileGroup` — group() is a **barrier** → one `{kind:'group'}` Map. Dual-path
  (locked #3): scalar reducers (count/sum, `json_group_array` scalar-lists) →
  real SQL `GROUP BY`; element values (default list / `by(__.tail())`) →
  `ORDER BY key` + the handler's `groupBuffer` folds runs into the Map. Composite
  `by(__.project(...))` keys build one correlated scalar per part (`k0_v`,`k1_v`,…).
  Group over `properties()` is handed off from `compileProperties`.
- Handler: `groupBuffer` (one loop keyed on `GroupVal.kind`; element values via
  `v_`-prefixed cols, scalar keys/values via `anySerializer`), `listBuffer`
  (hand-framed LIST so vertex/edge items keep props), `numberBuffer` (Long/Double).
  `fold()`→`{kind:'list'}` (reuses the plain projection cols), `sum()`→
  `{kind:'scalar'}` (SQL `SUM`, integer→Long).
- Deferred with clear errors: `cap`/`aggregate` (side-effect state), general
  `unfold`, top-level `tail`, deep nested-`by()` chains, `local`/`Scope`.

**P2b — `where`/`not`/`is` + TextP. DONE** (live L3 85→119). Shared
`predicateSql(expr,binds,pred)` backs `has`/`is`/`where` (+ TextP → bound `LIKE`).
`is(P)` folds onto the projected scalar. `where`/`not`/`filter(__.T)` are filter
CTEs via `compileFilterPredicate` (EXISTS movement / correlated `.count().is` /
current-prop); `not()` uses `NOT COALESCE((pred),0)` for correct missing-prop
semantics. Alias-compare `where(P.neq("a"))`/`where("a",P,by(k))` over P2a columns.

**P2 tail — PARTIALLY DONE** (live L3 119→126). `and`/`or` filter steps
(`combineBranchPreds`, reuses `compileFilterPredicate`; also inside `where(__.and/
or)`); `union` (element branches, `branchMovementSelect` — single out/in/both hop,
UNION ALL merged id-relation); `optional` (single hop, LEFT JOIN + COALESCE-to-
self). All compose mid-chain as CTEs in `traversalCtes`.

**P3 repeat — MOSTLY DONE** (live L3 126→130, then path/until landed 2026-07-12).
`repeat(__.<out/in/both>).times(n)` [+ emit before/after] → `WITH RECURSIVE
walk(id, depth)` in `src/steps/branch.ts` (the repeat/emit/times/until cluster is
gathered by strategies since the modulators sit either side of `repeat`). All
`WITH` → `WITH RECURSIVE`. **`repeat().path()`** adds a JSONB `path` column
(`jsonb_insert '$[#]'`); **`simplePath()` in the body** = a `NOT EXISTS(json_each)`
cycle guard; **`until(<pred>)`** = a `done` column (do-while / while-do), predicate
via `compileFilterPredicate` on a correlated node ctx, `loops().is(n)` → depth
predicate — `until().path()` composes. **No depth cap** (removed 2026-07-13): `times()`
bounds depth; `until()` and unbounded `emit()` run to the natural fixpoint — a cyclic
body without `simplePath()` is infinite by spec, bounded only by the DO's per-request
CPU/memory limit. Deferred: `emit(pred)`, `until`+`times`/`emit`, cyclicPath-in-repeat,
`path().by()` on recursive, edge-inclusive bodies, mixed linear+repeat path, complex
bodies. See `docs/2026-07-12-path-tracking-prior-art.md`.

**Target locked — see docs/2026-07-11-phased-roadmap-plan.md "Target — declared feature profile" + the W1–W5
writes-first roadmap.** Profile: UserSuppliedIds ✅, Multi/MetaProperties ✅ (W4
schema rework), Upsert ✅, no lambdas/OLAP/multi-request-tx. Sequence:
ids → writes → deploy → multi/meta rework → conformance grind.

**W1 user-supplied ids — DONE.** `nodes`/`edges` have a nullable `uid TEXT UNIQUE`;
rowid stays the internal PK (joins/perf untouched). uid resolved only at the
`V('x')` seed (`uid IN`) and framing-out (`COALESCE(uid,id) AS id`, via
`ScalarCtx.extIdExpr` for group/select element framing). `addV().property(T.id,v)`
sets id, `property(T.label,v)` overrides label. Gaps: `properties().element().id()`
and `group().by(__.id())` still show rowid; `addE` can't set the edge's own uid.

**W2 writes — DONE (live L3 130 → 204).** `mergeV`/`mergeE`, `property()` update,
general `addE`, all landed. Shape:
- **Front-end**: `extractArgs` refactored to `walkArgs`/`argOf`; new cases for
  map literals (`GenericMapLiteralContext` → JS `Map`, matching how a bound Map
  param arrives after GraphBinary deserialization), bare enum tokens
  (`TraversalTLong`/`Direction`/`Merge`/`Cardinality`), so `mergeV([(T.label):…])`
  and `option(Merge.onCreate,…)` parse without flattening/dropping.
- **mergeV/mergeE** (`compileMergeV`/`compileMergeE`): upsert closures. Match map
  normalised (`normalizeMergeMap` — handles BOTH EnumValue keys from bound Map
  params AND `{token}`/`{direction}` tags from inline literals). Match → emit
  (props patched by `option(Merge.onMatch,…)`); miss → insert (match + onCreate).
  `mergeDrivers` sizes the run: start=1, `inject(v1,…)`=one per value, `V()`-rooted
  =one per incoming (re-queried each iteration so an earlier create is visible to a
  later match). mergeE endpoints from `Direction.OUT/IN` (`Merge.outV/inV`=incoming);
  missing endpoint → "Vertex does not exist for mergeE". Bare `mergeV()`/`mergeE()`
  (incoming-as-map) throws a clear deferral.
- **general addE** (`compileAddE` + `runWriteChainFull`): a pure write chain
  (addV/as/addE/from/to/property — a graph initializer, MANY addE) runs through the
  sequential interpreter; a `V()`-rooted single addE runs one edge per driver row
  (alias cols carried). `from()`/`to()` = an `as()` alias or nested `__.V(...)`;
  default endpoint = the incoming traverser. `property(T.id)` sets the edge uid.
  Shared `parseEdgeCluster`/`insertEdge`/`applyEdgeCluster`/`resolveEndpoint`.
- **property() update** (`compileSetProperty`): `UPDATE … props` (JS-merge, single
  cardinality) on the movement-selected V/E set. `Cardinality.list/set` → W4.
- **Fixes landed alongside**: `has(label,key,value)` 3-arg + `has(T.label|T.id, v|P)`
  (was ignoring the 3rd arg / crashing on a predicate — the dominant cucumber
  *verification* idiom); edge write-response now frames via `edgeBuffer`
  (materialises props; `handler.ts` was dropping them through `anySerializer`).
- **Edge endpoints are external ids on BOTH paths** (`COALESCE(uid,id)`). Writes use
  `nodeExtId` (write.ts); reads use `plan.ts` `extIdOf(rowid)` =
  `(SELECT COALESCE(uid,id) FROM nodes WHERE id=<rowid>)`, applied at the three edge-
  ELEMENT materialization sites in `steps/projection.ts` (the `__element` edge
  projector, `compilePath`'s edge position, `elementSelect` for group). This was a
  read/write divergence (read showed the raw rowid — identity for integer-id graphs,
  wrong under UserSuppliedIds); DO NOT reintroduce it. The old "perf: avoids
  correlated subqueries" rationale was misdiagnosed: endpoint resolution is only ever
  needed when framing an edge OUT (a bounded result set that has already left the
  index-only regime), NEVER inside the movement/filter CTEs (those carry only bare
  `id` and use src/tgt as JOIN keys), so the per-row PK lookup can't touch the hot
  traversal path. Covered by SQL snapshots + a `guid` end-to-end round-trip
  (test/conformance/seed-uid.ts).
  Still rowid (separate W1 gaps, NOT this fix): the SCALAR id of an endpoint via
  `by(__.outV().id())` / `group().by(__.id())`, and `properties().element().id()`.
- **Deferred (clear errors)**: nested-traversal merge maps (`mergeV(__.select…)`),
  `option(…, __.traversal)`, `Cardinality.list/set` (W4), `.with()`, `hasId`.

Cucumber tag set widened with `@StepAddV/@StepAddE/@StepMergeV/@StepMergeE` (NOT
`@StepWrite`, which is the unrelated `io().write()` serialization feature).

Read-step backlog (continues under W5). DONE 2026-07-12/13: the **path family** —
`path`/`simplePath`/`cyclicPath` + `path().by()`, `repeat().path()` (JSONB array
walk), `repeat().until()` (do-while/while-do, `loops().is(n)`), unbounded `repeat().emit()`
(natural-fixpoint termination, no depth cap). **DONE 2026-07-13: the
per-traverser BRANCHING family** (455→473, `docs/2026-07-13-per-traverser-branching.md`)
— `choose` (predicate form + option-map scalar CASE), `coalesce` (first-non-empty via a
carried input-ordinal `St.origin`), multi-hop `union`/`optional` (rewritten onto the
`foldBody` seam; optional keeps its single-hop LEFT JOIN fast path), `flatMap`, scalar
`map` (`compileMapScalar`), **multi-hop `where`** (`compileExistsChain` — correlated
EXISTS over a movement chain + terminal filter) + `where(__.label()/not())`, and the
**alias-threading foundation** (`aliasCtx` + `resolveAlias`: a where/and/or/not predicate
starting `as('x')`/`select('x')` re-roots on that alias's carried column) and **`match`**
(`src/steps/match.ts` — a conjunctive pattern join: bind the root var to the incoming id,
fold patterns in dependency order, each a join CTE extending the alias columns; downstream
select/count/dedup consume them; deferred: both()/scalar-terminal/or/not/nested patterns,
strategies, select-then-movement). Still open:
`emit(pred)`, compound `until(…and/or().loops())`, `path().by()` on the recursive walk,
`aggregate`/`cap`, `local`, `sack`; element-body `map` (first-result), scalar branch bodies, mixed-shape
branches, branch-inside-branch, option-map choose without a scalar `Pick.none`. `tree()`
deliberately skipped (0 L3: JS GLV stubs it).

## Environment notes

- Runtime is Bun (pinned in `mise.toml`), not Node. `bun run start` serves
  via `Bun.serve`; `bun test` runs the suite (`*.test.ts`). No tsx/esbuild —
  Bun runs TS natively.
- Build graph is mise tasks (`mise.toml`): `install ─▶ {test, build} ─▶ ci`.
  GitHub Actions (`.github/workflows/ci.yml`) runs `mise run ci` — nothing
  CI-specific lives in the workflow, so the gate is reproducible locally.
- Storage runtimes meet at the `Sql` interface in `src/storage.ts` (both sync):
  `bun:sqlite` for dev/Bun, DO `ctx.storage.sql` for production. The agnostic
  `GraphStore` (schema, label interning) sits on top; compiler + handler are
  storage-agnostic.
- Bun ⇄ Cloudflare via DI (`@bodar/yadic`), DONE: `application(deps)` in
  `src/application.ts` wires the shared `router` (`src/router.ts`) from the one
  injected leaf, a `GraphManager` (`src/manager.ts` — the graph-lifecycle seam,
  sibling to `Sql`). Entry points: `src/bun/server.ts` (`Bun.serve` +
  `BunGraphManager`; exports `startServer`, listens under `import.meta.main`)
  and `src/cloudflare/worker.ts` (`CloudflareGraphManager` over the DO namespace;
  DO `GraphDatabase` + `DurableObjectSqlite`). Reference impl: `~/Projects/talebrary`.
- Bind-type gotcha (cost a review cycle): `bun:sqlite` accepts `boolean`/`bigint`
  binds; DO `ctx.storage.sql` (`SqlStorageValue`) throws on them. `GraphStore.query`
  coerces boolean→1/0 and bigint→number at the one seam so both runtimes agree —
  don't reintroduce raw binds. Covered by a contract test.
- `src/io.ts` reuses gremlin's GraphBinary serializers via a RELATIVE import
  (bypasses the package `exports` map; bundles under esbuild). Upstream fix
  pending: apache/tinkerpop#3511 adds a `gremlin/io` export.
- Worker bundle (`wrangler deploy --dry-run`): ~2.2 MB raw, ~265 KB gzip.
  ATN warm-up ~few ms once per isolate; warm parse ~0.27 ms.
- Useful references live in the Apache TinkerPop repo (sparse-clone it):
  grammar at `gremlin-language/src/main/antlr4/`, features at
  `gremlin-test/src/main/resources/.../features/`, JS GLV + cucumber runner
  at `gremlin-js/gremlin-javascript/`, v4 migration rationale at
  `docs/src/upgrade/release-4.x.x.asciidoc`.
