# CLAUDE.md — mogwai-db

Context file for Claude (Code or otherwise) working on this repo. Read
`docs/2026-07-11-phased-roadmap-plan.md` after this; it has the phased roadmap
and test strategy. This file is the things that took a whole investigation to
learn — do not re-derive them.

**For "is step X supported, and where's the edge?" → `docs/feature-support-matrix.md`**
— a living, code-grounded capability map (✅/🟡/❌/🚫 per step, with the deferral
reason). Keep it in sync when a step's support changes.

**SQL generation (current):** the compiler builds SQL with a template-first `q`
kernel + typed `Relation` handles — `src/q.ts` (kernel: `q`/`Relation`/`Query`/
`list`/`empty`) + `src/schema.ts` (nodes/edges/labels relation constants). Design
+ rationale: `docs/2026-07-12-q-kernel-sql-builder.md`. Do NOT reintroduce
lazyrecords ansi builders (`select`/`from`/`join`/`comparison`/`cte`/…) — retired;
only `src/q.ts` may import raw lazyrecords `Text`/`Compound`, every step module
builds through the kernel.

**Compiler is fully decomposed (all 3 seams done, 2026-07-12).** `compile()` in
`src/compiler.ts` is a 51-line orchestrator: `parse → normalize → dispatch`.
**Current lowering model (2026-07-15 refactor):** orchestration dispatches a truthful
`Stream` union (`ElementStream`/`ScalarStream`/`ListStream`/`PropertyStream`/
`RecordStream`/`GroupStream`/`PathStream`, with derived entry `MapStream`) and materializes only at
the root through `steps/materialize.ts`. `select`/`project` always lower to streams;
`group`/`groupCount` always lower through `lowerGroup` to a rich GroupStream, terminal
or followed. See `docs/2026-07-15-unified-relational-lowering-plan.md` for the active
staged migration; the older P1–P3 sections below are historical semantics notes.
Element-valued child `map`/origin-safe `flatMap` bodies now enter
`tryCompileElementChild` (`steps/child.ts`): the same prefix StepFns run over a pushed
parent domain, then `first`/`all` cardinality restores the outer scope. Extend this
child seam; do not add another private movement parser. Terminal child `count()` is
the first shared scope-aware barrier (`tryCompileCountChild`): `map()` and scalar
`local()` both LEFT JOIN productive child rows to the preserved parent domain and
GROUP BY the child ordinal, so empty children yield zero and duplicate equal parents
remain distinct. Scalar child tails `values`/`id`/`label`/`constant` likewise lower
through `tryCompileScalarChild`: productivity is row existence (including productive
NULL), multi-properties are real rows, and `map()` selects the first row per origin.
`flatMap()` is shape-aware dispatch (not a PREFIX entry): it applies the same child
compiler with `all`, so element and scalar children both flatten without private parsers.
Homogeneous scalar `union()` arms also dispatch through child streams and `UNION ALL`;
the syntax-only `isScalarChild` preflight stops the prefix without appending CTEs.
Element union retains its existing branch compiler; mixed shapes fail closed.
Three-argument predicate `choose` uses the same shape-aware split for homogeneous
scalar arms: the existing predicate gates seed two child compilations, whose scalar
rows merge with `UNION ALL`; two-argument identity-else and element choose stay legacy.
Homogeneous scalar `coalesce` arms share one ordinal-tagged parent domain and retain
that ordinal until the first-productive merge; a total reducer result such as count=0
is productive and correctly prevents fallback.
Scalar child projections continue through the ordinary `lowerScalarRows` pipeline
before `first`/`all` selection. `ScalarStream.encounter` makes provider order a physical
stream contract, so `is`/`order`/`limit`/`skip`/`range`/`dedup` lower there partitioned
by child origins (never accidental SQLite CTE order). Child chains pass through root
`normalize()` too, including `order().by()`.
`lowerScopedScalarReducer` (`steps/barrier.ts`) now owns child `count/sum/min/max/mean`:
it LEFT JOINs the preserved domain, groups by origin, counts the non-null encounter
marker (not `v`), and retains dynamic numeric `v,vt` through map/flatMap and homogeneous
scalar branch merges. `lowerScopedScalarFold` uses the same domain + encounter marker
to produce one ListStream per parent (`[]` for an empty child, `[null]` for a productive
NULL); map/flatMap/local consume it, and ordinary ListStream lowering handles followers.
Homogeneous scalar-list `union`/three-arg `choose`/`coalesce` arms merge through
`unifyLists`. `lowerScopedElementFold` applies the same parent-domain rule to element
children, aggregating rowids in encounter order while retaining the node/edge item tag.
Map/flatMap/local can therefore return element lists, `unfold()` rejoins the correct
table, and root materialization expands the rowids back to property-preserving element
objects in the same SQL query. Homogeneous element-list union/three-arg choose/coalesce
arms share the same merge; incompatible node/edge or scalar/element lists fail closed.
An empty folded list is productive, so list coalesce correctly never advances past a
first fold arm. `local(child)` now uses this same compiler with `all` cardinality
(contrasted with `map`'s `first`): scalar transforms/reducers/folds and element
`limit`/`skip`/`range`/`dedup` all partition by child origin. The former `local.ts`
movement parser/private window engine is deleted; bare movement local bodies now work,
and the same element row operators can feed a child `fold()` without another path.
Traversal-valued `project().by(__.<scalar child>)` is the first generic by-consumer:
one outer origin identifies each parent, every field compiles with child `first`
cardinality, and the field relations inner-join on that origin. Missing child rows drop
the project traverser; a productive NULL remains a field value; duplicate parents remain
distinct. Mixed property-key and `T.id`/`T.label` scalar modulators share that relation;
bare vertex/edge fields share it too, retaining their complete element payload and
internal rowid so later movement can re-enter ordinary element lowering. Single- and
multi-label `select(...).by(__.<scalar child>)` use the same seam after relationally
re-rooting each child on its selected alias; mixed direct/bare fields share the outer
origin join. Record fields may be scalar, first node/edge, or typed scalar/element lists;
selecting a field re-enters its ordinary stream, and root materialization expands element
list rowids only at the GraphBinary boundary. `unfold()` preserves the list row's carried
aliases/path/origins (a global fold simply has none). Inline element `group()`/`groupCount()` scalar traversal keys now do the
same: compile child-first, join the productive key back to its source element by outer
origin, then enter the existing GroupStream barrier. Non-reducing scalar group value
children share that origin and consume `all` productive rows into the group list (not
`first`). Inline group-scoped `count`/`sum`/`min`/`max`/`mean` expose raw child rows and
reduce once at the final group-key barrier: count LEFT JOINs the parent domain for zero,
while productive numeric/comparable reducers inner-join. Never reduce these per parent
and combine afterward. Scalar child `…fold()` likewise folds raw rows once per final key,
ordered by parent then child encounter; empty keys receive `[]`. Named `group('a')`
side effects retain their live source stream, so `cap('a')` uses the same generic path;
the correlated `compileNestedList` mini-compiler is deleted. Element `tail()` and property
groups retain compatibility paths. Group-scoped whole-element `…fold()` now also
uses raw child rows at the final key boundary; LEFT-joined null payloads retain empty keys
but are never framed as phantom elements. Consumers call
`tryCompileScalarValueChild` and never distinguish row projections from total count;
do not grow `compileNestedScalar` to implement new by forms.
- **Seam 3 — `src/strategies.ts`:** pure `Step[]→Step[]` normalization passes
  (`stripTerminal`, `foldRepeatClusters`, `foldByModulators`) run once up front so
  the dispatch sees a canonical, peek-free chain (no index arithmetic anywhere).
- **Seam 2 — `src/steps/*.ts`:** the read prefix is a **functional fold** —
  `StepFn = (step, St) => St` over an immutable `St` (`context.ts`); only the
  `Query` builder accumulates CTEs. Per-family modules (`movement`/`filter`/
  `branch`/`passthrough`), writes (`write.ts`: imperative interpreters
  behind an ordered `WRITE_RULES` table). `index.ts` = `PREFIX` Map + `buildPrefix`
  + `compileRead`. To add a read step: write a `StepFn`, register it in the right
  Map — do NOT grow a switch. Multi-step modulator consumption belongs in a
  `strategies.ts` fold, NOT in a compiler peeking at siblings.
- **The tail is split per step-family (2026-07-13, was one 1353-line file).**
  `projection.ts` (~530) is the DISPATCHER (`compileTail`/`compileFromScalar`) +
  shared RENDER BASE (`foldTailAcc` + `MODIFIERS`/`PROJECTORS` Maps +
  `buildProjection`/`renderProjection`/`compileFold`/`wrapReducer`/`compileSackRead`/
  `compileCap`). Leaf handlers live in per-family modules, mirroring the prefix's
  `movement`/`filter`/… grain: `coerce.ts` (asBool/asNumber/asDate const-fold + SQL —
  the ONE pure leaf, no back-import), `inject.ts` (`compileInject`), `select.ts`
  (select/project/path), `mapscalar.ts` (map/math/choose), `group.ts` (group +
  properties). Layering: leaves import the render base UP from `projection.ts`; the
  dispatcher imports the leaves for dispatch — a value cycle (`projection`↔`mapscalar`)
  same as the pre-existing `projection`↔`index` `dispatchNext` one, safe (all refs are
  in fn bodies, none at module-init). To add a tail step: put its `compile*` in the
  right leaf (or a new one), route it from `compileTail`. `write.ts` imports
  `compileInject` from `inject.ts`.

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
6. **Graph selection: URL path first, `g` field as fallback.** `POST /gremlin/{g}`
   → Worker does `env.GRAPH.getByName(g)` → DO. Auth tokens scope to the path.
   `id = pathG ?? bodyG ?? 'g'` — resolved identically on BOTH runtimes into ONE
   flat namespace (revised 2026-07-14, was two-level tenant/`g`). A path id routes
   with NO body parse; the body `g` field is peeked ONLY on the bare `/gremlin`
   endpoint a stock TinkerPop client uses (its `traversalSource`, default `'g'`,
   rides the body — see the wire fact below). So the old "never route on `g`" perf
   rule is *preserved as* "path routing never body-parses"; the peek is confined to
   the one case with no path id to route on. TinkerPop has no data-plane
   create/drop-database API — DO on-first-access *is* the provisioning story.
   *Element* deletion is native client gremlin (`drop()`, vertices+edges);
   *whole-graph* lifecycle is a thin in-band REST layer on the SAME `/gremlin/{g}`
   path (see "Management API + runtime parity" below), NOT an out-of-band control
   plane. **Upstream ask (undrafted):** the JS client POSTs to its configured URL
   verbatim and puts `traversalSource` in the *body*, forcing every L7 proxy/cache
   to body-parse to route; v4 (not final) should project `traversalSource` onto the
   URL path. We ship exactly that (`/gremlin/{g}`), so we'd file from the reference impl.

## Management API + runtime parity (W3, DONE; edge refactored 2026-07-14)

Whole-graph lifecycle is a thin REST layer on the same `/gremlin/{g}` path,
**identical on Bun and Cloudflare** — no separate control plane. The shared
`makeRouter` (`src/router.ts`) is the EDGE: it owns the two HTTP-facing concerns —
**A** wire parsing (`src/wire.ts` `parseRequest`) and **C** response framing/chunk
pacing (`src/http.ts` `streamBuffers`/`errorResponse`) — and dispatches by verb onto
an injected `GraphManager` (`src/manager.ts`), the one thing that differs per runtime
(sibling seam to `Sql`). The data-plane seam is **`query(id, gremlin, params) →
Promise<Buffer[]>`**: the store tier (concern **B**, `src/execute.ts` `executeQuery`)
compiles + runs + frames and returns the GraphBinary value buffers as a materialized
array; the edge streams them out. No HTTP lives in the store tier / DO.
- `POST /gremlin/{g}` → gremlin query, graph id from the path. `POST /gremlin` (bare)
  → same, graph from the body `g` field (default `'g'`) — the stock-client path.
  GraphBinary, always 200; errors ride the status trailer. Creates-on-demand.
- `PUT /gremlin/{g}` → create-if-absent → 201. `GET /gremlin/{g}` →
  `{vertexCount,edgeCount}` (auto-creates empty). `DELETE /gremlin/{g}` → 204. Bad
  path → 404; bad verb → 405.

**Seam shape rationale (2026-07-14).** The DO already drains the whole row array up
front (a DO SQLite cursor can't cross `await`s), so lazy streaming from SQLite is a
fiction. The seam returns `Buffer[]` (bytes only — no SQLite value types cross RPC),
run in the store tier; on CF that's a native DO RPC `query` method (NOT an internal
`fetch` — HTTP stays out of the DO). This buys **layering**, not memory: the floor is
unchanged (do not log it as a perf/memory win). It deletes the old generator-prime +
mid-stream-error dance — any compile/SQL/framing error just throws to the edge's one
try/catch (buffered 500), never a partial/truncated body.

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
(called by query/create/info) lazily re-runs `GraphStore.initSchema()` on reuse.
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
- **Chunked streaming (DONE; re-homed to `src/http.ts` 2026-07-14).** The response
  body is a `ReadableStream` — v4 chunking splits the SAME single logical frame above
  across HTTP chunks (HEADER once, then values `resultIterationBatchSize` at a time,
  then the trailer), NOT N independent frames. `streamBuffers(buffers, batchSize)`
  (concern C, at the edge) takes the already-framed `Buffer[]` from `executeQuery`
  (concern B, store tier) and paces them: HEADER in `start()`, then `slice(i,i+batch)`
  per `pull()`, then the trailer. `batchSize`/`resultIterationBatchSize` request field
  (default 64, resolved in `wire.ts`) paces chunk size only — NOT a protocol boundary.
  **Errors are now uniform:** framing fully completes before streaming begins, so a
  value can't fail mid-stream — any compile/SQL/framing throw surfaces from
  `executeQuery` to the router's one try/catch → `errorResponse` (buffered HEADER +
  500 trailer). The old generator-prime + mid-stream-flush + "never `controller.error()`"
  machinery is GONE (deleted with `makeHandler`). The beta.2/master JS client buffers
  the whole body (`arrayBuffer()`) then reads it once — its `stream()` throws "not yet
  implemented", and its `submit()` builds ONE request body — so the client streams
  NEITHER download NOR upload; only gremlin-python has chunked-transfer. **Memory:** on
  DO the SQLite cursor can't be held open across `await`s for a stable snapshot (CF
  docs: consume cursors synchronously before the next `await`), so `store.query()`
  drains the whole row array up front — and since the seam now returns that whole array
  anyway, streaming only avoids holding the final concat copy, not the array. True
  row-level laziness would need keyset pagination per pull, infeasible for arbitrary
  compiled traversal SQL. The floor is a cursor-lifetime constraint, NOT transport:
  the DO RPC vs the old internal `fetch` doesn't change it (both already streamed the
  body). Identical drain-then-return on both runtimes (no per-runtime code, no `Sql`
  seam change).
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

## Schema (src/storage.ts) — rationale (W4 property model)

Integer rowid PKs; interned labels (small hot indexes); covering edge indexes
`(src,label,tgt)` and `(tgt,label,src)` so out()/in() are index-only scans.

**Vertex properties are NORMALIZED** (W4, `docs`/memory `w4-property-model`): a
`vertex_properties(id, node, key, value, meta BLOB)` table, one row per
VertexProperty instance — so a key may repeat (multi-property, `Cardinality.list`/
`set`) and `id` (rowid) IS the VertexProperty id. `value` has **no declared type**
(BLOB affinity) so it keeps whatever SQLite storage class the bound value has
(correct numeric order/range for `has('age',gt(30))`/`order().by('age')`). `meta`
is a JSONB `{metaKey:scalar}` blob (meta-properties). **Edges keep a FLAT JSONB
`props` column** — TinkerPop's edge `Property` has no id/meta/multi, so no table is
warranted; edge writes wrap `jsonb(?)`, reads select `json(props)`.

**Static covering indexes** `vp_key_value(key,value)` + `vp_node_key(node,key)`,
built once at schema time, REPLACE the old self-tuning `json_extract` expression
index (and its literal-key-splice requirement). A property key now BINDS as a
parameter (`key=?`) — a plain B-tree column seeks fine bound, so no splice and no
injection surface. There is no per-key `indexKeys` reporting / `ensureNodePropIndex`
anymore (the machinery is gone; a vestigial always-empty `Compiled.indexKeys`
accumulator remains inert — a scoped follow-up removes the threading).

**The read seam (`src/plan.ts`).** `ScalarCtx.propsExpr` is EDGE-ONLY (the flat
blob); nodes read props via `idExpr` through three dispatchers: `hasProp`
(node → ANY-match `EXISTS(vertex_properties …)` = multi-property has semantics),
`scalarProp` (node → `value … ORDER BY id LIMIT 1` = first-under-multi, for
order/group-key/by(key)/map/sack), and `vertexPropsAgg`/`framedProps` (a correlated
`json_group_object(key, [values])` used ONLY at leaf materialization — never inside
the movement/filter CTEs, so the traversal hot path stays index-only; `extIdOf`
precedent). `values('k')` is a genuine **flatMap JOIN** (one row per value);
`valueMap` frames `{key:[values]}` uniformly (node + edge). `vertexPropsAgg` is
`ORDER BY MIN(id)` so property order is insertion order.

**Writes (`src/steps/write.ts`).** `applyVertexProperty(node,key,value,meta,card)`:
single = delete-then-insert, list = append, set = append-unless-equal (patch meta);
one SQL statement each. `readCardinality`+`metaOf` parse `property([Cardinality,] k,
v [,mk,mv…])`. `VertexSpec.props` is an ordered `PropSpec[]` (a Record can't hold a
repeated key). Edges reject cardinality/meta. `property(null)`/`property([:])`/
map-form `property()` are no-ops (map-form not yet implemented). `drop()` cascades
`vertex_properties`.

**Meta reads (`compileProperties`).** `properties()` frames the real VP id + meta
via a hand-rolled `vertexPropertyBuffer` (the client's `VertexPropertySerializer`
hardcodes empty meta — same bug as vertex/edge). Leading `has(metaKey[,P])` /
`hasKey(k|P)` / `hasValue(v|P)` are property-stream filters; `properties().id()`,
`properties().properties()` (meta → `metaProperty` shape), `properties(k).valueMap()`
(→ `metaMap`) all land. Deferred: `properties().dedup()`, map-form `property()`,
a traversal-valued `property(k, __.…)`, `properties()`-scalar `count()` after meta.

**JSONB is available on both runtimes** (DO SQLite 3.47.0, Bun 3.53.0; JSONB landed
3.45.0). New JSON columns (edge props, vp.meta, path-tracking) use JSONB: bind the
JSON *text* + wrap `jsonb(?)` (a raw Buffer bind diverges across runtimes — see the
bind-type gotcha), read back via `json(col)`.

Perf shape: traversal hops (out/in/both) are index-only and sub-ms; property
filters/orders/projections ride `vp_node_key`/`vp_key_value` (a static index seek,
no cold-key build). `test/performance.test.ts` asserts via EXPLAIN QUERY PLAN that
the vp indexes engage (no full scan of vertex_properties).

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

Property materialization: `execute.ts` `vertexBuffer` frames the vertex from
ioc primitives instead of routing through anySerializer (whose VertexSerializer
hardcodes empty props). valueMap/elementMap build JS `Map`s; the id/label token
keys are `t.id`/`t.label` (from `io.ts`), which ride as GraphBinary `DataType.T`.

L3 harness: `test/conformance/conformance-server.ts` is the SAME shared stack as the
production Bun server (`application` over a `BunGraphManager`), just with the toy
graphs pre-seeded; the cucumber suite hits the bare `/gremlin` endpoint and its `g`
field selects the graph (no dev-only handler fork — the `StoreSource` resolver is
gone). Seeding runs each graph's write traversals through the normal query path
(`seed-*.ts` export gremlin `string[]`; a numeric `T.id` → integer rowid, so the
canonical ids reproduce). See `test/conformance/README-cucumber.md` to run the full
suite manually.

## P2/P3 read-compiler progress log (all landed; historical narrative)

> This section is a *record* of how the read compiler was built, not a to-do list.
> The **actual immediate next work is W3 — Cloudflare deploy + Worker auth** (see
> docs/2026-07-11-phased-roadmap-plan.md). Live L3 is 608 (path family, then the
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

**`asDate`/`dateAdd`/`dateDiff` + `datetime()` literals — LANDED (2026-07-13, L3 589→608).**
The date family, all on the value-tail carrier. **Internal representation = epoch-millis
INTEGER**; a new `'date'` ValueType tag (`render.ts`) frames it back to a JS Date via the
client's `dateTimeSerializer` (GraphBinary DATETIME 0x04, UTC wire — `execute.ts`
`frameValue`). Second/minute/hour/day are **fixed-width** (no month/year DT token exists),
so date arithmetic is pure integer — NO SQLite date functions for datetime literals; only a
runtime ISO-string `asDate()` calls `unixepoch(x)*1000` (`asDateSql`). All three are scalar
transforms (in `SCALAR_TX_NAMES`, sibling to asBool/asNumber): const-fold over inject
literals in `compileInject` (`asDateConst` parses ISO/int/long→ms, rejects float/non-ISO/null
with "Can't parse"; dateAdd = `ms + n*factor`; dateDiff = `self−other` → Long), runtime SQL in
`renderProjection` (`projection.ts`). Frontend: `datetime('iso')`/`DateTime('iso')` →
epoch-ms via `parseIsoMs` (`frontend.ts`) — an offset folds into the instant; an
**offset-less** date-time is UTC-normalized (append `Z`), because bare `Date.parse` would
read it as HOST-LOCAL and diverge Bun↔DO (a parity bug — the JS cucumber comparator checks
instants only, so this never shows in conformance but would break a real query). `DT.unit`
→ `{dt}`.

**Timezone/offset — deliberately UTC-only (NOT lossy for the target client).** GraphBinary
DATETIME 0x04 has a `utcOffsetSeconds` field + nanosecond precision, and TinkerPop's type is
`OffsetDateTime` — BUT a JS `Date` is a pure UTC-millis instant with NO per-value offset
(`getTimezoneOffset()` returns the *host* tz, not the value's), so the client's
`DateTimeSerializer` always writes offset=0 and ms precision; its deserialize folds any
offset into the instant. So against the JS reference client + JS conformance harness (which
compares instants only) we CANNOT preserve offset/sub-ms no matter what the server emits.
We match that: epoch-ms, UTC framing — instant + ms are exact, offset-label + sub-ms are
intentionally dropped (parity with the reference client, not accidental loss). Preserving
offset would need our OWN DATETIME framing (breaks locked #4) + an `offsetSeconds` carrier,
for ZERO conformance gain and no JS client that can read it. The internal rep is
offset-*ready* (add an `offsetSeconds` column + custom framing later, purely additive) IF
non-JS clients (Python/.NET/Go `OffsetDateTime`) become a target. **Upstream give-back
(logged, not filed):** the real fix is gremlin-javascript adopting **Temporal** (TC39 Stage
4 / ES2026 — `Temporal.ZonedDateTime`/`Instant` carry offset + nanos; shipped Chrome 144 /
Firefox 139 / Node 26, but NOT Bun/JSC yet, so we can't use it server-side) instead of
`Date` — sibling to the TINKERPOP-3044/3043 JS-can't-author-types family. Only once a JS
client can *consume* an offset is server-side offset framing worth building. `dateDiff`'s other operand is always
compile-time (literal ms / `constant(datetime|null)`→0; nested inject/movement defers).
**Bare `asNumber()` runtime extended**: a date-tagged value → its epoch-millis (Long,
identity); else `CAST(x AS INTEGER)` (Long) — correct for every reachable use (integral epoch
in date round-trips like `values('birthday').asNumber().asDate()`); a fractional runtime
standalone would mis-tag but is unreachable. **DEFERRED (structural wall, NOT built):**
`P.typeOf(GType.DATETIME)` over a STORED property (DateTime.feature, 8 scenarios) — SQLite
`typeof()` can't distinguish a stored datetime from a string/number (same wall as bool/uuid
typeOf, `GTYPE_SQL` `datetime:null`→false); needs a storage type-tag scheme. Also `inject([1,2])
.asDate()` mis-parses (frontend flattens list literals to varargs — the pre-existing asBool
`[1,2]` limitation, 1 scenario).

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
throws a clear deferral rather than under-filter. **ProductiveByStrategy is a consumer
policy, not a rewrite:** `group`/`groupCount`/`project`/`select`/`aggregate`/`order`/linear
`path`/alias-compare `where` preserve productive NULL results while ordinary consumers
drop missing `by()` results. The productive bit survives aggregate list and numeric
reducer boundaries; `local(aggregate(...))` shares that compiler. Nullable element-valued
fields and `barrier().dedup().by(...)` still fail closed rather than fabricate a shape.
Rationale + the challenged "DO routing obviates partitioning" presumption:
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
- `lowerGroup` — group() is a **barrier** → a rich GroupStream, root-framed as one Map. Dual-path
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
  (materialises props; `execute.ts` was dropping them through `anySerializer`).
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

## List-value substrate + re-enterable tail (LANDED 2026-07-13, L3 608→617)

The tail used to be **strictly terminal** — a projection/fold produced a value the chain
couldn't continue from, which is why `unfold`, chained projections, `Scope.local`, and
set-ops were all blocked. Fixed by a **re-enterable tail** built on an explicit stream
model. Plan + decision log: `docs/2026-07-13-list-value-substrate-plan.md` (Approach A).

- **`src/steps/stream.ts`** — the `Stream` union: `St` (elements, context.ts) |
  `ScalarStream` (a `v` column) | `ListStream` (a JSONB `list` column, N rows). All share
  `Carry` (the shape-independent state — `q`/aliases/indexKeys/params/path/origin) carved
  out of `St`, so a retype preserves it. **`St.elem` stays `'node'|'edge'` — the 20+
  movement/filter StepFns only ever see `St`; the union lives at the orchestration layer.**
- **`dispatchNext(stream, steps, at)`** (`src/steps/index.ts`) routes by stream shape:
  elements → `foldBody` (absorb further movement) + `compileTail`; scalar →
  `compileFromScalar`; list → `compileFromList`. A retype step calls back into it, so
  `V().fold().unfold().out()` flows elements→list→elements→… — each phase with its own ≤1
  projection. The old "only one projection per traversal" ceiling is dissolved
  STRUCTURALLY (fresh accumulator per phase), not by loosening a check.
- **`foldTailAcc` now returns `{acc, stop}`**, breaking at a retype boundary (`unfold`, or a
  NON-terminal `fold`). A **terminal `fold` stays the reducer path, byte-identical** (N rows
  → one List in the handler) — it never becomes a JSONB value, avoiding a wasteful
  build+explode for the common case. Only a fold WITH followers retypes to a `ListStream`.
- **`compileFold`** (projection.ts): a non-terminal fold → one JSONB list value via
  `jsonbGroupArray` (plan.ts) — element rowids (`ListOf {elem}`) or a values/id/label scalar
  (`ListOf {scalar}`). Refuses aliases/path/origin through the retype (deferred).
- **`compileUnfold`** (`src/steps/list.ts`): `json_each` explode (ordered by array position)
  → a fresh `St` (elements, rejoined downstream) or a `ScalarStream`. Mirrors
  `compilePathArray`'s idiom. `fold().unfold()` is a deliberate materialize→explode roundtrip
  — NO peephole (correct-but-wasteful beats code for a query nobody writes; see decision log).
- **`Scope.local` list reducers** (`compileFromList` `listReducer`): `count/sum/min/max/mean
  (Scope.local)` reduce EACH list (row) to one scalar via a correlated `json_each` aggregate.
- **inject-as-list** (`compileInject`): an all-array inject → a stream of list VALUES (each
  bracket arg is ONE list; `inject([1,2],[3,4])` = two rows) via `jsonbArrayOf`, dispatched to
  the list phase. `inject([1,3,100,300])` frames as one List (`{kind:'jsonbList'}`, handler
  reads `json(list)`); `inject([...]).unfold()`, `.mean(Scope.local)`, `.none(P)` all compose.
  A mixed/all-scalar inject stays the flat `v`-stream path (`flattenListArgs`).
- **`none(P)` on a list** (`listNoneFilter`): keep each list where NO element matches P
  (`NOT EXISTS(json_each …)`), a collection filter. NOTE `stripTerminal` now only strips a
  BARE `none()`/`discard()` (the iterate marker) — `none(P)` is the real NoneStep, kept.
- **scalar-local semantics** (`foldTailAcc`): a `Scope.local` reducer/order reached in the
  element/scalar tail operates on each scalar as a degenerate one-element list —
  `sum/min/max/order/dedup` = identity, `mean` = the value AS Double (`localMean`, always
  Double even of one value: `d[29.0].d`). Scalar TRANSFORMS keep their Scope.local no-op.
  A Scope.local step whose scalar form isn't worked out (count/limit/range/tail/skip, and
  scalar-stream `none()` which is a barrier we don't model) FAILS CLOSED — no silent global
  form (correctness-by-design over the old flatten-coincidence; traded ~11 coincidental passes
  for honest throws, net L3 608→618 all-correct).
- **No handler change beyond `{kind:'jsonbList'}`**: unfold's exploded relation frames via the
  existing vertex/value shapes; terminal fold keeps its N-row List framing.

**Frontend prerequisites** (`src/frontend.ts`): collection literals `[a,b,c]` now parse as
ONE array value (not N flattened args), and `Scope.local/global` is captured (was dropped —
`order(Scope.local)` latently compiled as global). The varargs-style steps TinkerPop spreads
a Collection into — V/E/hasId (`hasId(1,[2,6])`≡`hasId(1,2,6)`) and, UNTIL inject-as-list
lands, `inject` — flatten a list arg back via `flattenListArgs`; predicates unwrap a lone
list in `parsePredicate`.

**Deferred (each its own follow-on, NOT built):** `order/limit/range/tail/dedup(Scope.local)`
on a LIST (their scenarios chain `reverse()`/`skip(local)`); element-list `order(Scope.local).
by(key)`; **`select(Column.values/keys)`** + the group-values cluster; set-ops (`combine`/
`intersect`/…); Map-unfold; `local()`; order-before-a-non-terminal-fold (`order().by(desc).
fold().none(…)`); the **scalar-stream `none(P)` barrier** (`V().values('age').none(gt(32))`→
empty — a whole-stream barrier, NOT the per-list collection filter; semantics not yet modelled,
fails closed). Mixed-type inject (`inject([a,b],'c')`) stays flattened for now.

## Side-effect state — sack + aggregate/cap + group('a') (LANDED 2026-07-13, L3 618→634)

The one genuinely-new execution notion: state that is NOT the current id-relation. Two
mechanisms, one home (`Carry`), both still ONE SQL statement (locked #3 holds — no
interpreter). Plan + decision log: `docs/2026-07-13-side-effect-state-plan.md`.

- **`sack` = a carried per-traverser column** (`Carry.sack`, sibling to `origin`),
  threaded through movement/filter CTEs by the EXISTING `carryFrag`/`carriedCols`/`advance`
  plumbing — `advance` gained a `sack?: string|null` tri-state opt (set/keep/clear) exactly
  like `origin`. `withSack(init)` seeds the `sk` column at the V()/E() source (extracted by
  `frontend.ts extractSack`, mirroring extractStrategies; thread `sackInit` → `compileRead`
  → `buildPrefix` → `seedSource`). `sack(Operator.x).by(v)` is a PREFIX StepFn
  (`src/steps/sack.ts`) that REPLACES the carried column (assign/sum/minus/mult/div/min/max;
  div forces REAL division; one by() only; a by-miss drops the traverser like values()); it
  hand-rolls its SELECT so it excludes `sk` from `carryFrag` and re-projects. Bare `sack()`
  is a TAIL read (`compileSackRead` in projection.ts) through the shared value tail (framing
  INFERRED like values() — as:undefined; a trailing sum()/dedup/order composes). `Operator`
  tokens need the `TraversalOperatorContext` walkArgs case (was dropped, like the other enum
  tokens). `sack` ∈ PREFIX (mutate only — bare read guarded to break to the tail) and BY_HOSTS.
- **Side-effects = a named registry** (`Carry.sideEffects: Map<name, SideEffectDef>`, sibling
  to `aliases`). `SideEffectDef` = a `list` def (aggregate → a JSONB-list CTE) or a `group`
  def (stashed group-spec). `aggregate('x')` (`src/steps/sideeffect.ts`) is a PASS-THROUGH
  barrier StepFn: builds the bag CTE (`jsonbGroupArray` of rowids, or a by(key) scalar with a
  by-miss `IS NOT NULL` filter), registers it, returns `st` UNCHANGED (so the chain continues
  — `V().aggregate('x').out()` works). **`store()` does NOT exist in TinkerPop 4** (dropped;
  `aggregate(Scope.local)` replaces it — no grammar rule), so only `aggregate` reaches here.
- **`cap('x')` (`compileCap` in projection.ts)** looks the name up. A **list side-effect
  UNROLLS to individual results** — there is NO BulkSet wire type in the client and the suite
  expects one result per bagged element (`aggregate('x').cap('x')` → 6 vertices, NOT one
  List), so cap explodes the stored list via `compileUnfold` → the element/scalar stream →
  `dispatchNext` (reuses the §9 list substrate, zero new list code). A **group side-effect
  re-emits ONE GroupStream** via `lowerGroup` over the stashed source.
- **`group('a')`/`groupCount('a')` (side-effecting, `sideeffect.ts`)** = a PASS-THROUGH
  barrier that stashes the group-spec (source `from` string referencing the persistent
  `st.last` CTE + `elemCtx` + folded `bys`) and returns `st` unchanged, so movement between
  it and `cap('a')` works (`groupCount('a').by('name').out().cap('a')`). In `foldBody`,
  group/groupCount dispatch as a prefix step ONLY when they carry a string side-effect key
  (`isSideEffectGroup` guard, mirroring the sack/choose guards); the bare terminal form falls
  to the existing `compileTail` barrier. Index keys for the group key are computed at cap time
  (`lowerGroup` resolves the source at cap time) — the def carries none.
- **Deferred, fail closed (each a clear throw):** `within('x')`/`without('x')` mid-chain
  readback (the aggregate-dedup idiom — where eager/lazy actually diverge; set-based join
  can't honour incremental visibility); the sack inject-const **numeric-promotion** block
  (NumberHelper byte→short-on-overflow bump — number-chasing risk, deliberately not chased);
  sack through `repeat()`/`barrier`/`local`, split/merge-on-fork, `sack(BiFunction)`;
  aggregate on a SCALAR stream (`values(k).aggregate(x)`) and `by(<nested/token>)`; multi-key
  `cap('x','y')`; `group('a')…cap('a').select(Column.values).unfold()` (needs
  `select(Column.values)`, §9); group side-effect after `as()`/`path()`.

## local() — per-element scope + otherV (LANDED 2026-07-13, unified 2026-07-15)

`local(child)` runs the child once PER incoming traverser, so a barrier inside it scopes
per-element, not globally: `local(outE().limit(1))` = one edge PER vertex. The original
implementation had two private body shapes (recorded below); both now route through the
shared child compiler and the private parser/window module has been deleted:
- **Scalar-reduction body** (`local(outE().count())`) → a tail projector reusing
  `compileMapScalar`/`compileNestedScalar` (the `foldBody` guard `isScalarLocal` — body's
  last step ∈ {count,sum,min,max,mean} — breaks it to the tail). Per-input scalar, zeros
  preserved (correlated subquery). **`compileMapScalar` now tags a nested `count()` as
  `as:'long'`** (TinkerPop count is always Long; the SQLite COUNT integer would otherwise
  infer as Int via anySerializer — a latent bug that also fixed `map(...count())`).
- **Movement + a per-element `limit`/`range`** (historically a prefix StepFn) →
  the movement folds normally under a fresh input ordinal (ROW_NUMBER seed, the coalesce
  technique), then the barrier is a WINDOW `ROW_NUMBER() OVER (PARTITION BY <ordinal> ORDER
  BY id)` sliced to the local range — NOT a global LIMIT. The ordinal is dropped at local's
  output. `limit` non-determinism is spec-safe: the suite asserts `should be of` (subset) +
  `count of N`, so a deterministic id-order pick is a valid subset.

Current lowering also supports bare movement plus origin-partitioned `skip` and `dedup`;
the same element row-operator path is shared by map/flatMap/local.

**`otherV`** (`movement.ts`) — the endpoint away from the vertex an edge was entered from.
Needs that entering vertex, carried as a `fromV` column set by `toEdge` (= `p.id`, both
bothE branches). **Gated on `Carry.trackFromV`** (seeded true iff the chain names `otherV`,
`chainNeedsFromV`) so ordinary edge traversals stay index-only with no dead column;
`local`'s body inherits the flag through its `{...st}` seed. `toVertex`/`otherV` clear
`fromV` on landing (drop it from the carried frag + `fromV:null`) so a later edge step
doesn't collide. `otherV` = `CASE WHEN e.src=fromV THEN e.tgt ELSE e.src END`.

Deferred (clear throws): non-movement local bodies (match/simplePath/union/nested local),
no-barrier bodies, `order()`/`dedup()` inside local, local after `as()`/`path()`/branch/sack,
and `otherV` with no preceding edge step. A one-step `local(aggregate(...))` is canonicalized
onto the ordinary aggregate side-effect compiler (including ProductiveBy NULL policy).

## GroupStream + derived MapStream — select(Column), list-local, nested lists (updated 2026-07-15)

`group()`/`groupCount()` now ALWAYS lower to a rich `GroupStream`, whose physical layout
covers scalar/element/composite keys and scalar/list/element values. Root materialization
uses the handler's `groupBuffer`; a compatible `select(Column.*)` consumer derives the
narrow `(mk,mv)` `MapStream` entry layout. Terminal position no longer selects a different
semantic compiler.

- **`lowerGroup`** (`steps/group.ts`) builds the one rich relation. `compileFromGroup`
  derives `(mk,mv)` only for compatible consumers. Scalar keys drop nulls on derivation;
  **element keys retain an internal rowid** so `select(Column.keys).unfold()` rejoins them.
- **`select(Column.values)`/`select(Column.keys)`** (`compileFromMap`, `steps/list.ts`)
  aggregate one map column into ONE list value (`json_group_array`, COALESCE→`[]` for an
  empty map) → a `ListStream` that unfold()/framing handles. So
  `group().select(Column.values).unfold()` flows **map→list→scalar**, each phase a fresh
  accumulator. `{column:'values'|'keys'}` comes from `frontend.ts enumSuffix`.
- **List-local `Scope.local` transforms** (order/dedup/limit/skip/range/tail) on a
  `ListStream` (`listLocalTransform`, `steps/list.ts`): rebuild EACH row's list via a
  correlated `json_each` aggregate (works on a one-row fold() list AND a multi-row stream of
  lists alike). Stays a list, so downstream continues. Element order preserved: order() sorts
  by value (bare or direction-only `by(Order.desc)`), subset ops keep position order, dedup
  keeps first occurrence (`GROUP BY value ORDER BY MIN(key)`). **tail avoids a count()
  subquery** (`ORDER BY key DESC LIMIT n`, outer re-sort asc) — a two-level `json_each`
  correlation on `c.list` fails ("no such column"). `by(key)`/traversal comparators defer.
- **Nested (list-VALUED) maps** — `group().by().by(__.<move>().<label|values(k)|id>()…fold())`.
  Generic child scalar rows retain parent origin + encounter and fold ONCE at the final
  group-key boundary (not once per parent). Pre-fold `dedup`/`limit`/`range`/`tail` run
  in the ordinary origin-partitioned scalar pipeline. `ListOf`/`MapOf` have a **`'list'`
  variant** so
  `select(Column.values)` of a list-valued map is a **list-of-lists** and `compileUnfold`
  explodes it to per-list `ListStream` rows (which the Scope.local ops above then reshape).
  Scalar keys, empty child domains (`[]`), duplicate parents, and productive NULL are
  explicit relational semantics. The old correlated `compileNestedList` + `MAX` path is
  deleted.
- **`cap('a')` of a group side-effect** (`compileCap`) re-emits the same GroupStream as an
  inline group; compatible Column consumers derive MapStream normally.

The handler also frames the rich group's one-list-per-key value layout. **Deferred (clear throws):** Map-unfold
(→Map.Entry, the reserved `'entry'` ListOf), element-VALUE group maps, non-element-key
neighbour-list values, `order(Scope.local).by(key/traversal)`, and set-ops
(combine/intersect/difference — a separate sub-project: operand compilation + vertex identity
+ null semantics). Plan/decision log context: `docs/2026-07-13-list-value-substrate-plan.md`
(this is Stage §9/§10's natural completion).

## String + set-op / list-algebra families + format (LANDED 2026-07-14, L3 685→822)

Six batches finishing the collection-algebra tail (all pure SQL, no per-row JS). Hard-won
facts:
- **String transforms (`src/plan.ts` `scalarTx`, list phase `src/steps/list.ts`).**
  `trim`/`lTrim`/`rTrim` = SQLite `trim(x, set)` over `JAVA_WHITESPACE` (Java's
  `Character.isWhitespace` code points incl. U+3000 — built from explicit code points, NOT
  literal chars in source). `reverse` = a **correlated recursive CTE** (SQLite has no
  REVERSE) for a string; number/null pass through; a LIST reverses element ORDER
  (`listReverse`). `concat` skips nulls (`concat_ws('')`), all-null→null (a `CASE` guard,
  live only when no non-null string arg). `scalarTx` is the ONE per-element string builder,
  reused by the scalar tail AND the list-local phase (`listStringTransform`, `Scope.local`
  over a folded list). A string op on a non-`local` list raises TinkerPop's "can only take
  string as argument". A single bare `order().fold()` sorts folded scalars (compileFold).
- **`format()` (`src/steps/mapscalar.ts` `compileFormat`, sibling to `compileMath`, in
  BY_HOSTS).** `%{key}` → element prop (scalarProp); `%{_}` → next by() modulator
  (round-robin); `||`-concatenation so a missing prop NULLs the row (FormatStep filter). A
  constant template doesn't filter (`hadToken` gate). Defers: project()/select() columns,
  as()-alias fallback.
- **Set-op / list-algebra family (`src/steps/list.ts`).** `combine`=concat (List);
  `intersect`/`difference`/`disjunct`=set ops → a **Set** (new `{kind:'jsonbSet'}` shape →
  `ioc.setSerializer.serialize(new Set(...))` — MUST be a `Set`, not an array); `product`=
  cartesian → list of pair-lists; `conjoin`=`group_concat` to a String; `all`/`any`=list
  filters (`(pred) IS TRUE`/`IS NOT TRUE` so a null element fails; eq/neq(null) null-aware).
  **Null-safe set membership uses `IS`, not `=`.** A Set followed by a list op degrades to a
  plain List (matches `intersect().order(local)`), so set-ops emit `jsonbSet` ONLY when
  terminal, else a deduped ListStream. **Operands** (`operandList`): a literal array
  (`jsonb(text)`), `constant(c).fold()` (→`[c]`), or a **standalone scalar-fold traversal**
  (`__.V().values(k).fold()`) — compiled independently via `compileRead` + `json_group_array`
  and embedded as a scalar subquery by `embedSql` (splits the rendered SQL on `?` and
  re-interleaves `value()` tokens to carry binds; the inner `WITH` scopes to the subquery).
  Argument/incoming-type errors mirror TinkerPop's messages. Defers: element-fold operands
  (a vertex list), set-ops after `path()`.
- **`unfold()` on a scalar = identity** (`compileFromScalar`) — a scalar isn't a collection.
  Unlocks `aggregate('a').by(k).cap('a').unfold().<reducer>`. **`min`/`max` range over any
  Comparable incl. Strings** (v4 made Strings Comparable — `typeof` filter allows `'text'`
  for min/max; `sum`/`mean` stay numeric).
- **Reference-graph seeding (`test/conformance/seed-graphson.ts`).** A GraphSON v3 file →
  write-traversal seed (vertices then edges, ids via numeric `T.id`). `gsink` + `ggrateful`
  seeded.

## Traverser bulking — count (LANDED 2026-07-14, L3 822→824)

`repeat(<single out/in/both>).times(n).count()` (path/`as`/sack-free) compiles to unrolled
per-depth GROUP-BY-SUM(bulk) CTEs (`src/steps/bulk.ts` `tryBulkRepeatCount`, recognized in
`compileRead` before the normal fold; reuses `buildPrefix` for the source + leading filters)
instead of enumerating every walk. This is what makes the grateful graph seedable — its
`repeat(out()).times(8).count()` = 2505037961767380 (2.5e15) now returns in ~10ms; the old
UNION-ALL model tried to materialize 2.5e15 rows and hung the host UNINTERRUPTIBLY
(bun:sqlite is synchronous — no query interrupt — so any hang guard MUST be compile-time, a
runtime timeout can't fire). **SQLite fact (verified both runtimes):** an aggregate/GROUP BY
in a recursive-CTE term errors `recursive aggregate queries not supported` — so bulking
CANNOT use `WITH RECURSIVE`; a compile-time-known `times(n)` UNROLLS to n plain CTEs (the
only viable shape). Bulking fires only with NO per-traverser identity live (path/`as`/sack
each make same-vertex traversers distinct → the GROUP-BY collapse would be wrong; mirrors
TinkerPop's `LazyBarrierStrategy` bailing under a PATH requirement). **No fail-fast guard
was needed** — all 39 grateful queries were run in isolation (zero hangs): the non-bulkable
`repeat().times(5).as().select().count()` fails closed at compile via the "one projection"
guard, and deep `V(id)`-rooted repeats throw on unsupported bodies. **Deferred (own
follow-ups):** `groupCount`/`group().by(count)` bulking (times(2) group already materializes
fine — its non-pass is a group-value/empty-key semantics gap, NOT tractability); `sum` and
labeled/`as`-select over deep repeat (non-bulkable by traverser identity); unbounded
`until()`/`emit()` bulking (no compile-time depth to unroll → would need a JS depth-loop).
**BulkSet wire type is a dead end (do NOT chase):** v4 removed it, remote clients expand it
to a flat List, and the pinned beta.2 client has no bulk support — so bulking's payoff is
100% internal SQL, never a wire feature. See `docs/2026-07-14-traverser-bulking.md`.

## Environment notes

- Runtime is Bun (pinned in `mise.toml`), not Node. `bun run start` serves
  via `Bun.serve`; `bun test` runs the suite (`*.test.ts`). No tsx/esbuild —
  Bun runs TS natively.
- Build graph is mise tasks (`mise.toml`): `install ─▶ {test, build} ─▶ ci`.
  GitHub Actions (`.github/workflows/ci.yml`) runs `mise run ci` — nothing
  CI-specific lives in the workflow, so the gate is reproducible locally.
- Storage runtimes meet at the `Sql` interface in `src/storage.ts` (both sync):
  `bun:sqlite` for dev/Bun, DO `ctx.storage.sql` for production. The agnostic
  `GraphStore` (schema, label interning) sits on top; compiler + the execute/frame
  tier (`src/execute.ts`) are storage-agnostic. The HTTP edge (`router`/`wire`/`http`)
  never touches a store.
- Bun ⇄ Cloudflare via DI (`@bodar/yadic`), DONE: `application(deps)` in
  `src/application.ts` wires the shared `router` (`src/router.ts`) from the one
  injected leaf, a `GraphManager` (`src/manager.ts` — the graph-lifecycle seam,
  sibling to `Sql`). Entry points: `src/bun/server.ts` (`Bun.serve` +
  `BunGraphManager`; exports `startServer`, listens under `import.meta.main`)
  and `src/cloudflare/worker.ts` (`CloudflareGraphManager` over the DO namespace;
  DO `GraphDatabase` + `DurableObjectSqlite`). Reference impl: `~/Projects/the client`.
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
