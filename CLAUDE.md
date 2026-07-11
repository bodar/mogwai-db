# CLAUDE.md — mogwai-db

Context file for Claude (Code or otherwise) working on this repo. Read PLAN.md
after this; it has the phased roadmap and test strategy. This file is the
things that took a whole investigation to learn — do not re-derive them.

## What this is

A TinkerPop 4 Gremlin server compiled onto SQLite, targeting Cloudflare
Durable Objects. One DO = one isolated graph database, created on first
request via `idFromName`. Any TinkerPop 4 GLV in any language connects over
plain HTTP. Verified against unmodified `gremlin@4.0.0-beta.2` on both runtimes
(Bun + Cloudflare DO): the shared contract (`test/contract.ts`) passes over
GraphBinary, 2177/2177 official corpus parse rate.

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
   on-first-access *is* the provisioning story; deletion is a management
   endpoint on the Worker, out-of-band, as it always was in TinkerPop.

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

Integer rowid PKs; interned labels (small hot indexes); props as JSON text
(move to JSONB when DO SQLite ≥ 3.45); covering edge indexes
`(src,label,tgt)` and `(tgt,label,src)` so out()/in() are index-only scans.

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
- `repeat()` without `until()` is legal and infinite — max-depth guard
  (default ~32), documented deviation.
- Element ids are integer rowids; don't invent string ids.

## Testing (the build discipline)

- L1: `conformance/corpus-test.ts` — 2,177 canonical traversals from the
  official Gherkin features; parse+chain must stay 100%. Its step-frequency
  output is the implementation priority order. Notable: `inject` is #4 in
  the corpus (test-data setup idiom) — implement early to unlock scenarios;
  `drop()` early too because the official runner cleans graphs with it.
- L3: TinkerPop's own cucumber runner (in the tinkerpop repo:
  `gremlin-js/gremlin-javascript`, `npm run features-graphbinary`) pointed at
  a live mogwai-db seeded with `conformance/seed-modern.ts` (canonical ids).
  Server URL is hardcoded to `localhost:45940/gremlin` in test/helper.js.
  Start with `--tags` for implemented steps; the passing count is THE
  conformance number; ratchet only upward.
- Every new step lands with: SQL snapshot tests, its cucumber tag enabled,
  corpus still 100%.

## P1 done — how the read compiler is now shaped

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

L3 harness: `conformance/conformance-server.ts` fronts the named graphs by the
request `g` field (DEV ONLY — production routes tenancy by URL path per the
locked decision). `makeHandler` now takes a `StoreSource` (a store *or* a
`(g)=>store` resolver). See `conformance/README-cucumber.md` to run the full
suite.

## Immediate next work (P2b in PLAN.md)

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

**P3 repeat — PARTIALLY DONE** (live L3 126→130). `repeat(__.<out/in/both>).
times(n)` [+ emit before/after] → `WITH RECURSIVE walk(id, depth)` in
`traversalCtes` (the repeat/emit/times cluster is gathered since the modulators
sit either side of `repeat`). All `WITH` → `WITH RECURSIVE` (harmless for
non-recursive CTEs; needed once any walk appears). Depth guard 32 when `times`
absent. Deferred: `until`, `emit(pred)`, complex bodies, `path`/`simplePath`.

**Target locked — see PLAN.md "Target — declared feature profile" + the W1–W5
writes-first roadmap.** Profile: UserSuppliedIds ✅, Multi/MetaProperties ✅ (W4
schema rework), Upsert ✅, no lambdas/OLAP/multi-request-tx. Sequence:
ids → writes → deploy → multi/meta rework → conformance grind.

**W1 user-supplied ids — DONE.** `nodes`/`edges` have a nullable `uid TEXT UNIQUE`;
rowid stays the internal PK (joins/perf untouched). uid resolved only at the
`V('x')` seed (`uid IN`) and framing-out (`COALESCE(uid,id) AS id`, via
`ScalarCtx.extIdExpr` for group/select element framing). `addV().property(T.id,v)`
sets id, `property(T.label,v)` overrides label. Gaps: `properties().element().id()`
and `group().by(__.id())` still show rowid; `addE` can't set the edge's own uid.

**W2 writes — DONE (live L3 130 → 205).** `mergeV`/`mergeE`, `property()` update,
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
- **Edge endpoints on write responses** expose the external id (`nodeExtId` =
  COALESCE(uid,id)); the READ path still shows raw rowid endpoints (perf: avoids
  correlated subqueries on index-only edge scans) — a known divergence, identity
  for integer-id graphs, matters only under UserSuppliedIds.
- **Deferred (clear errors)**: nested-traversal merge maps (`mergeV(__.select…)`),
  `option(…, __.traversal)`, `Cardinality.list/set` (W4), `.with()`, `hasId`.

Cucumber tag set widened with `@StepAddV/@StepAddE/@StepMergeV/@StepMergeE` (NOT
`@StepWrite`, which is the unrelated `io().write()` serialization feature).

Read-step backlog (continues under W5): `repeat().until()`/`emit(pred)`,
`path`/`simplePath`, `coalesce`, `aggregate`/`cap`, `match`, `local`, `choose`,
`sack`; multi-hop/scalar `union`, `both()`/multi-hop `optional`, multi-hop
`where`, `where(P.eq(__.constant()))`.

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
  `src/application.ts` wires the shared `handler` from the one injected leaf,
  `store`. Entry points: `src/bun/server.ts` (`Bun.serve` + `BunSqlite`;
  exports `startServer`, listens under `import.meta.main`) and
  `src/cloudflare/worker.ts` (route `POST /g/{graphId}` → DO `GraphDatabase` +
  `DurableObjectSqlite`). Reference impl: `~/Projects/the client`.
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
