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
`src/sql/kernel/q.ts` (`q`/`Relation`/`Query`/`list`/`empty`) + `src/sql/schema.ts` (nodes/edges/labels
relation constants). **Only `src/sql/kernel/q.ts` may import raw lazyrecords `Text`/`Compound`**;
every step module builds through the kernel. Do NOT reintroduce ansi builders
(`select`/`from`/`join`/`cte`/…) — retired. The kernel renders an aliased relation as
`edges e` (no `AS`) and `rel.c.x` as `qualifier.x`.

`q.derived(body, cols, alias)` is the typed **non-CTE** relation boundary: use it when
SQL needs a subquery but the Query graph doesn't need a separately named intermediate.
Wrap a relation in a named CTE only when it's shared/reused or the planner needs an
intentional materialization boundary.

## Compiler architecture

`compile()` (`src/compiler/compiler.ts`) is a thin orchestrator: `parse → normalize → dispatch`.
Three seams:

- **Seam 3 — `src/compiler/ir/strategies.ts`:** pure `Step[]→Step[]` normalization passes run once
  up front (strip terminal, fold repeat clusters, fold by() modulators, apply
  `withStrategies`) so dispatch sees a canonical, peek-free chain. No index arithmetic
  in step compilers; multi-step modulator consumption belongs in a strategies fold.
- **Seam 2 — `src/steps/{context,prefix,tail,write}/`:** the read prefix is a functional fold of
  `StepFn`s over an immutable typed **`Stream`** (`context/context.ts`/`context/stream.ts`). The union:
  `ElementStream`/`ScalarStream`/`VariantStream`/`ListStream`/`PropertyStream`/
  `RecordStream`/`GroupStream`/`PathStream` (+ internal `MapStream`). `lowerSteps` is the
  one iterative shape orchestrator; a retype yields a `LoweringContinuation` back to it,
  so `V().fold().unfold().out()` flows elements→list→elements, each phase with its own
  ≤1 projection. Per-family modules: `movement`/`filter`/`branch`/`passthrough`, writes
  (`write.ts`), the tail split per step-family (`projection.ts` dispatcher +
  `coerce`/`inject`/`select`/`mapscalar`/`group`). To add a step: write a `StepFn`,
  register it in the right Map — do NOT grow a switch.
- **Root materialization (`steps/tail/materialize.ts`):** read leaves never frame themselves.
  `materializeFinal`'s exhaustive `materializeStream` switch is the only read caller of
  `readCompiled`. Do not add a terminal `Compiled` branch in a leaf.

### Compiler extension law — mandatory

`lowerSteps(Stream, steps, at)` is the semantic authority for read traversals at root
and child scope. To implement a step: normalize sibling/modulator structure in
`strategies.ts`; lower from the appropriate typed `Stream`; for a child, push a
`ChildScope` (`steps/tail/child.ts`) and run the same engine; materialize only at the root.

**Do NOT add** a private child-traversal parser or supported-step vocabulary, a
`compileNested*` mini-compiler, sibling/index scanning inside a step compiler, a second
movement/filter/projection implementation, direct materialization from a read leaf, or
loose domain/ordinal arguments where `CompileScope` owns that state.

The generic child seam (`steps/tail/child.ts`) is how one traversal runs per parent
traverser: `pushChildScope` gives each parent a multiset-safe ordinal + preserved
domain; `reuseCurrentFrame` lets N siblings share one domain (the multi-modulator
pattern). Element/scalar/list/fold children, existence gates
(`tryFilterByChildExistence`/`tryCombineByChildExistence`), and reducers
(`lowerScopedScalarReducer`) all lower through it. The seam is **parent-shape-polymorphic**
(`ChildParent = ElementStream | PropertyStream | ScalarStream`): a `properties().group().by(__.…)`
folds over PROPERTY parents, and its `key()`/`value()`/`element().…` by()-children lower through
the SAME `lowerSteps → compileFromProperty` dispatcher — there is no property-group inline
reader (the old `tryPropertyGroupScalar` was retired). Element-valued property children
(no adjacency) fail closed in the element-only cores. A SCALAR parent's branch/map arms
(`values(…).{choose,coalesce,union,map,flatMap,local}(__.…)`) route through the shared
`tryCompileScalarArm` (the scalar twin of `tryCompileElementTraversal`): value/reducer/
nested-branch bodies, plus a `V()`/`E()` **re-source** (`lowerScalarVE` carries the pushed
ordinal through its CROSS JOIN, so a following scoped reducer/projection reduces per input).
Mixed-shape scalar-parent arms (scalar + re-source-element + `fold()`-list) merge into the
SAME `VariantStream` the element parent produces via the `Carry`-typed builders
`variantArmSelect`/`variantArmsMeta`/`variantCols` (in leaf `steps/tail/variant.ts`, shared by both
parents — only the per-arm compiler differs) — for `union`/`choose`/`coalesce`; `optional(t)` ≡
`coalesce(t, identity)` (a scalar arm restores the value on miss, an element/list arm →
variant). `map(t)` is 1-to-1 (keeps `t`'s FIRST EMITTED result). Over a SCALAR parent it takes
first even when `t` FANS OUT (`map(__.union(a,b))` → arm 0, `map(__.V().values('k'))` →
element-id order): the **canonical emission order** substrate
(`docs/2026-07-19-canonical-emission-order.md`) mints a per-origin `encounter` at the branch
merge (`unionScalarStreams`: `ROW_NUMBER() OVER (ORDER BY arm_idx, arm_encounter)`) and the
`'first'` child cardinality collapses to it. Emission order is ONE unified `Carried.encounter`
slot (root-global or per-origin child; movement re-mints over `(prev_encounter, new_id)`); a
demand pre-pass (`demandsEncounterOrder`, `strategies.ts`) seeds it only when a positional
consumer (limit/range/skip/tail/fold/dedup(labels)) follows a fan-out, so order-free chains and
`movementCollapse` are untouched. **Residual take-first (fail-closed, correct-by-design, NOT
mis-executed):** a fan-out arm at a `path().by(__.trav)` position, and a mixed-shape
(`VariantStream`) branch take-first — both need the ELEMENT-parent branch merges
(`tryLowerScalarUnion/Choose/Coalesce`, branch.ts) and the variant merge builders to synthesize
the arm-merge encounter too (they don't yet; only the scalar-PARENT `unionScalarStreams` does).
Use `flatMap`/`local` for all-results.

### Dependencies vs state — the DI object model (do not conflate)

The lowering CORE is a **dependency-injected object**, not free functions that read their
dependencies off the traverser. Two things are kept strictly apart:

- **Dependencies** — ambient capabilities fixed for a whole compilation: `registry`, `fastPaths`,
  `federationDepth`, the recursive-lowering engine itself, the store `source`. Grouped by
  LIFECYCLE into named DI scopes (`src/scopes.ts`, backed by `@bodar/yadic` `LazyMap`, but
  downstream depends only on the `AppScope`/`CompilerScope` **interfaces** — the container is
  hidden): **`AppScope`** (per process — registry/fastPaths/source; built once by the `Executor`)
  and **`CompilerScope`** (per `compile()`, a child of an app scope — `q`/`params`/`federationDepth`).
  Nested sub-compiles mint a FRESH compiler scope (fresh `Query`) off the SAME app scope.
- **State** — `Carry` (`steps/context/context.ts`) is now PURE per-query lowering state:
  `q`/`params`/`carried`/`sideEffects`. Dependencies do NOT ride `Carry` and are NOT threaded
  through function signatures.

The dispatcher is the **`LoweringEngine`** class (`src/compiler/engine/engine.ts`), built once per
compile from the `CompilerScope`. It holds the ambient deps + the whole recursive surface
(`PREFIX` fold, `seedSource`/`seedUnion`, `buildPrefix`, `lowerElementSteps`, `lowerSteps`,
`lowerStream`, `compileRead`, segment builders, the collapse scan). The step families
(`prefix/`, `tail/`, `write/`) stay **free functions** that reach lowering + deps through
`engineOf(stream)` (= `stream.q.engine` — the Engine rides the per-compile `Query`, which already
threads through every `Stream`, so nothing is signature-threaded). They import ONLY the leaf
interface `src/compiler/engine/deps.ts` (`Engine` + `engineOf`, erased at runtime); the concrete
`LoweringEngine` imports the families. **This is what dissolves the former
`index.ts ⇄ child.ts ⇄ projection.ts` import cycle** into a DAG: `deps.ts` (interface) ◂ family
impls ◂ `engine.ts` (concrete) ◂ `compiler.ts`. There is NO barrel (`steps/index.ts` is gone).
Adding a dependency = a scope field + an `Engine` accessor, never a new `Carry` field or a new
parameter on the StepFns. See `docs/2026-07-23-directory-restructure-plan.md`.

**The families stay FREE FUNCTIONS reaching one Engine — this is deliberate, not unfinished.**
The original plan floated per-concern dependency *objects* (`ChildCompiler`/`TailCompiler`/…). We
evaluated that and did NOT build them: the Engine does NOT call the child compilers (the dependency
is one-way, families→Engine), and the ~40 child compilers mutually recurse as a flat peer-set (≈107
internal cross-calls + ≈135 external). Wrapping them in an object would convert ~240 call sites to
`this.`/`.children.` to eliminate only ~15 `engineOf(stream).*` hops — net MORE to read, the exact
mechanical churn the design forbids. So the win came from **file cohesion, not objects**: the child
seam is THREE files — **`tail/child-shape.ts`** (the PURE classify leaf: `is*Child`/`classify*Child`,
`childSteps`, the shape `Set`s + shared scalar vocab `SCALAR_ARM_TX`/`scalarChildPrefixOk`; zero
`engineOf`, zero SQL — the ~40 dispatch-time classifier importers depend on this leaf, not the
compiler file), **`tail/child.ts`** (the compilers: `pushChildScope`/`popChildScope` + the element/
scalar/property child lowerers), and **`tail/scalar-arm.ts`** (the scalar-PARENT branch/map/filter
compilers, called only from `projection.ts`'s `compileFromScalar`). Dependency flows one way:
`child-shape.ts` (leaf) ◂ `child.ts` ◂ `scalar-arm.ts`; `child.ts` does NOT import `scalar-arm.ts`.
To add a child form: extend the classifier in `child-shape.ts`, the compiler in `child.ts` (or
`scalar-arm.ts` if it's a scalar-parent arm) — do NOT reach for an object.

**Fast paths** are explicit per-compilation switches in `CompileOptions.fastPaths`
(`src/compiler/options/fast-paths.ts`) — never a mutable global. A specialized lowering qualifies as a
fast path only when: the generic path stays the semantic authority and disabling the
switch compiles the same traversal generically; recognition failure returns `null`/falls
through (never defines support or throws because its optimized vocabulary is exhausted);
enabled-vs-disabled are result-equivalent in a committed test; and an EXPLAIN/benchmark
shows material benefit. Currently: `predicateInlining`, `singleHopOptional`,
`bulkRepeatCount`, `scalarPredicateInlining` (the scalar-parent predicate gate: inline
`WHERE` over the value vs a correlated EXISTS over a pushed scalar scope — used by
`and`/`or`/`not`/`filter`/`where`/`choose`/`coalesce` over a scalar), `movementCollapse`
(frontier collapse: each movement folds convergent walks into `SELECT id, SUM(bulk) …
GROUP BY id`, bounding the frontier by reachable |V| not the exponential walk count —
gated by `chainCollapseSafe` in `engine.ts` to reducer-terminal pure movement/filter
chains where the terminal `SUM(bulk)` makes it result-equivalent; the traverser-`bulk`
carried column is the substrate). A fast path should reuse the surrounding plumbing and swap only the
"middle" — e.g. the predicate family (`predicateInlining`, `src/steps/prefix/predicate.ts`)
feeds one boolean `Expression` to the shared `filterCte`; the fast middle is the GENERIC
movement/filter StepFns rendered in inline-correlated mode (`compileCorrelatedChild`,
`src/steps/tail/correlated.ts`) — a nested correlated `derived()` subquery seeded from the
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

## call() + the Service Registry (`src/services/`)

`call()` is the extensibility seam. A `Service` registers into a `ServiceRegistry` (a
per-runtime DI seam, sibling to `GraphManager`) and contributes to the compile. **Cycle-free
structure — do not collapse:** `spi/types.ts` (interfaces + `DIRECTORY_SERVICE_NAME`, a
dependency-free leaf) ◂ `spi/registry.ts` (cycle-free mechanism: `createRegistry`/`EMPTY_REGISTRY`,
what the compiler core imports for its default) ◂ `standard.ts` (`standardRegistry`, imports the
`catalog/` service impls → reached ONLY by the DI layer / entry points, NEVER the compiler core —
this breaks the fast-paths→registry→directory→steps cycle). The registry is an **app-scope
dependency** (`src/scopes.ts` `AppScope`, see the DI section below): it is held by the `LoweringEngine`
(reached via `engineOf(stream).registry`), NOT a `Carry` field. Production injects `standardRegistry`
at the store tier (`executeFramed`), a call() with no registry throws "unknown service". A `Contribution` is `'stream'` (pure, inline
SQL — all of Phases 1–5) or `'barrier'` (async/federated, Phase 6 — variant present so the seam is
additive, executor throws a deferral). `g.call(…)` is `seedCall` (a peer of `seedSource`, returns
whatever `Stream` shape the service yields); `V().call(…)` is `lowerCall` (pushes a child scope).
No new orchestrator — services build through the ordinary q-kernel + stream constructors and the
generic `lowerSteps`/`materializeFinal` takes over. Standard services keep TinkerPop's canonical
names (`--list`, `tinker.search`, `tinker.degree.centrality`); our own extensions would be
`mogwai.*`. See `docs/2026-07-20-call-service-registry-plan.md`.

## Full-text search — `property_fts` (`src/services/fts-index.ts`)

A single FTS5 **trigram** virtual table (`tokenize="trigram case_sensitive 0"` — options go INSIDE
the tokenize string) is the shared index behind `tinker.search` AND the TextP substring predicates.
Maintained in the **write path** (`applyVertexProperty`/`insertEdgeProperty`/`compileDrop`), NOT
triggers — the stored `{t,v}` ValueNode tree needs app awareness. The indexer walks the in-memory
tree (no `json_tree`, no tag noise) emitting one `kind='value'` row (the logical `toString()`, what
`tinker.search`/TextP match) + `kind='jsonkey'`/`'jsonleaf'` rows for nested collection content.
Substring matching is **case-insensitive** (a documented divergence — it is what lets the trigram
index serve `LIKE`; `regex` stays deferred, no index-only path, never JS-filtered).
- **PERF TRAP (cost a debug cycle): an FTS5 `DELETE` by an `UNINDEXED` column is an O(n) content
  scan** (UNINDEXED cols aren't indexed). An unconditional per-property-write delete makes a bulk
  write O(n²) (the grateful-dead seed 743ms→5020ms, blowing the conformance host's 5s `beforeAll`).
  Delete FTS rows ONLY on a genuine overwrite — vertex single-cardinality already probes existing
  rows (empty on a fresh insert); edge UPSERT does a cheap `UNIQUE(edge,key)`-served prior probe.
  Never put an unconditional FTS delete on a per-property write path.
- The TextP fast path (`ftsSubstringPredicate`, `plan.ts`) routes a ≥3-char POSITIVE
  `containing`/`startingWith`/`endingWith` over a STORED property through the index (MATCH prefilter
  + the existing `LIKE` as a position confirm), opt-in ONLY at the `has()` choke point (`filter.ts`,
  which has `st.fastPaths`). Generic `LIKE` stays the semantic authority + equivalence fallback;
  `<3`-char / `not*` / computed-scalar / injected-list all stay on `LIKE` (NOT fail-closed).

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
- DO SQLite has **no user-defined functions** — and we do **NOT** work around that by filtering or
  evaluating traversal predicates in JS. Compile-to-SQL is absolute (locked decision #3): anything
  SQL can't express (`regex`/`typeOf` TextP) **fails closed** with a clear deferral, it is never
  filtered post-SQL in JS. Text matching that SQL *can* express (`containing`/`startingWith`/
  `endingWith`) stays in SQL (`LIKE`). (JS framing/serialization of already-computed rows is not
  "filtering" and is unaffected.)

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
`vtype` = the canonical Gremlin type the write channel carried (`src/gremlin/types.ts` is
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

**The read seam (`src/compiler/plan/plan.ts`).** Nodes AND edges read props via `idExpr` into their own
normalized table (no `propsExpr`). `hasProp`/`scalarProp`/`framedProps` dispatch on elem,
each with an edge twin (`edgeHasProp`/`edgePropScalar`/`edgePropsAgg`). `framedProps`/
`valueMapProps` read only at leaf materialization (never inside movement/filter CTEs, so
the hot path stays index-only). `values('k')` is a flatMap JOIN (one row per multi-value).

**Writes (`src/steps/write/write.ts`).** `applyVertexProperty` (single=delete-then-insert,
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

Everything runs under bare `bun test` (scoped to `test/` by `bunfig.toml` — this stops
discovery recursing into `vendor/tinkerpop`). The `vendor/tinkerpop` submodule (pinned at
4.0.0-beta.2 = the published npm) supplies the grammar, Gherkin features, and JS cucumber
runner; `mise run submodule` provisions it blobless+sparse (self-healed in the L3 test's
`beforeAll`).

**Test layout — the conformance ladder lives in one folder per level;** each level's
harness/data sits IN its folder, except the reference graph seeds shared by L3+L4, which
live in `test/fixtures/`:
- `test/L1-corpus/` — `corpus.test.ts` + `corpus.txt` + `regen-corpus.ts`
- `test/L2-sql/` — the compile-to-SQL contract, split by step family (mirrors `src/steps/`):
  `{movement,filter,branch,repeat-path,group,scalar,call,write,plumbing}.sql.test.ts`
- `test/L3-conformance/` — `l3.test.ts`, `conformance.test.ts`, `conformance-server.ts`,
  `telemetry.ts`, `tags.ts`, `l3-state.json`, `README-cucumber.md`
- `test/L4-addendum/` — `l4.test.ts` + `*.feature`
- `test/fixtures/` — `seed-{modern,crew,uid}.ts` + `seed-graphson.ts` (imported by L3's
  `conformance-server.ts`, L4's `l4.test.ts`, and a few L2/root tests)
- `test/compiler/` — compiler EXECUTION semantics (the behavioural twin of L2's SQL snapshots),
  split by family 1:1 with `test/L2-sql/`: `{scalar,unified-lowering,movement-filter,branch,
  select-project,group-properties,repeat-path,writes,typed-properties}.exec.test.ts`
- `test/` (root) — the remaining non-ladder tests: `contract.ts`, `wire`/`streaming`/
  `exact-values`/`typed-collections-e2e`/`performance`/`bun`/`cloudflare`/`serializers`/
  `typed-collections`/`scopes`/`services`/`federation`/`foreign`/`fts-index` `.test.ts`.

**Invoke one level directly:** `mise run L1` / `L2` / `L3` / `L4` (each is `bun test
test/L{n}-…`; L1/L2 skip the submodule, L3/L4 depend on it). `mise run test` still runs the
whole suite.

**Version split — DO NOT collapse (cost a full investigation):**
- **Parser + corpus track `origin/master`** (a strict superset of beta.2 — adds
  unreleased-but-landing literals/args, removes nothing → forward-compatible). `mise run
  generate` (antlr-ng, byte-stable) and `mise run regen-corpus` source `origin/master`.
- **L3 conformance tracks the pinned beta.2 checkout** (matches the `gremlin` npm dep +
  its GraphBinary wire). Pinning L3 to master breaks it (master's cucumber harness hits a
  bun+cucumber dual-instance load issue) for zero gain. Bump the pin only when a new
  `gremlin` npm ships.
- **L1** (`test/L1-corpus/corpus.test.ts`): 2,298 canonical traversals; parse+chain must
  stay 100%.
- **L3** (`test/L3-conformance/l3.test.ts`): a ratcheted `bun test` — boots the conformance
  host in-process and runs the official cucumber suite over GraphBinary. **Telemetry is
  always on** (no env flag): a live compact progress line (`.` per query, `·` per EXPECTED
  throw — a message that satisfies a negative scenario's `raise an error … text of "…"`
  assertion, keyed off the corpus's own strings so a real bug throwing a canonical-looking
  error still shows `E` — and `E` per real compile/exec gap) prints during the run, then the
  systematic-gap summary (deferral buckets + failing-step frequency + **failure clusters**:
  `clusterGaps` groups contiguous real-gap throws into coherent areas — cucumber runs scenarios
  in feature-file order — so a big cluster whose "biggest" type ≈ its size flags a high-leverage
  single fix the frequency-sorted buckets can't show) after. The summary counts
  the same way: `summarize(records, expectedErrorSubstrings(FEATURES))` excludes expected
  negative-test throws entirely, so `uniqueFailed`, the buckets, and the failing-step frequency
  are ALL real gaps only (an expected throw is a pass, not a gap — it never appears in a count). **One committed state file,
  `test/L3-conformance/l3-state.json`**, records the last-known run — `{passing, total,
  passed[], failed[]}` — and is the SINGLE ratchet source of truth (`passing` =
  `passed.length`; there is no separate `baseline.json`/`l3-passing.txt`). Every run diffs
  this run against it and prints the **DELTA**: `✅ NEWLY PASSING` (fixes) and `❌ REGRESSED`
  (a scenario in committed `passed[]` that fails now, with its failing step + error). TWO
  gates: (1) any regression → fail + name it (no noise from the ~800 always-deferred; catches
  a net-positive run that silently breaks a green scenario, which the count alone would
  hide); (2) the count falls below `passing` → fail. A clean run (`!CI`) re-records
  `l3-state.json` (both sets, so `passed[]` grows AND `failed[]` shrinks) and rewrites the
  count in every file in `SYNC_FILES` (`README.md` + `docs/feature-support-matrix.md`), each
  fenced by `<!-- L3:passing -->…<!-- /L3:passing -->` so the prose can't drift; commit
  `l3-state.json` + synced files together. The per-run NDJSON capture
  (`l3-telemetry.ndjson`) + `*.summary.json` are transient/gitignored — only `l3-state.json`
  is durable. CI never rewrites (it only reads). Add a new SYNC consumer by giving it the
  marker + listing it in `SYNC_FILES`. Step scope =
  `test/L3-conformance/tags.ts` (widen as steps land; never narrow). NB `@StepWrite` tags
  the `io().write()` graph-SERIALIZATION step (deliberately excluded), NOT the data-write
  steps — addV/addE/mergeV/mergeE carry `@StepAddV`/`@StepAddE`/`@StepMergeV`/`@StepMergeE`,
  are untagged in the exclusion list, and are already in scope + ratcheted. Runbook:
  `test/L3-conformance/README-cucumber.md`.
- **L4** (`test/L4-addendum/l4.test.ts` + `test/L4-addendum/*.feature`): OUR
  addendum suite — valid traversals the official corpus doesn't cover (our combinatorial-
  completeness work), authored in TinkerPop's exact Gherkin format. NOT cucumber-driven: the
  official harness binds a scenario name to a vendored generated `gremlin.js`; we parse Gremlin
  natively, so `l4.test.ts` reads each scenario's embedded string + `| result |` table and runs
  it through the REAL stack (`executeQuery` → GraphBinary, decoded by the client `ioc` — so our
  extended serializers are exercised both directions). Gate = **all pass** (ours; not a subset
  like L3). `@gap:<area>` tags mark families for an upstream `gremlin-test` PR (the give-back).
  Add a scenario = drop it in a `.feature`; no code change. See `test/L4-addendum/README.md`.
- Every new step lands with SQL snapshot tests, its cucumber tag added to `tags.ts`, and
  corpus still 100%.
- **SQL snapshots assert semantic equivalence, NOT byte-identity.** They mostly `.toContain`
  the meaningful SQL fragments; whitespace, formatting, and incidental token spacing never
  matter. When a change alters emitted SQL the bar is that it means the same thing (same
  result set + plan shape) — do NOT chase byte-for-byte identical output, and do not treat a
  refactor as "unsafe" because the string moved. Update the snapshot to the equivalent SQL.
  (This is the canonical statement of the rule; other docs must not reintroduce a
  byte-identical *requirement*.)

The L3 harness (`test/L3-conformance/conformance-server.ts`) is the SAME shared stack as the
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
  `src/cloudflare/worker.ts`. Reference impl: `~/Projects/talebrary`.
- **Bind-type gotcha (cost a review cycle):** `bun:sqlite` accepts `boolean`/`bigint`
  binds; DO `ctx.storage.sql` throws on them. `GraphStore.query` coerces boolean→1/0 and
  bigint→number at the one seam so both runtimes agree. Covered by a contract test.
- `src/io.ts` reuses gremlin's GraphBinary serializers via a RELATIVE import (bypasses the
  package `exports` map). Upstream fix pending: apache/tinkerpop#3511 adds a `gremlin/io`
  export.
- Useful references in the Apache TinkerPop repo (sparse-clone it): grammar at
  `gremlin-language/src/main/antlr4/`, features at `gremlin-test/.../features/`, JS GLV +
  cucumber runner at `gremlin-js/gremlin-javascript/`.
