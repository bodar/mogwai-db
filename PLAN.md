# mogwai-db — Plan

A TinkerPop 4 Gremlin server on SQLite, deployed as a Cloudflare Durable Object.
One DO instance = one isolated graph database. Any TinkerPop 4 GLV (JS, Python,
Java, Go, .NET) connects over plain HTTP.

## Architecture (settled — do not relitigate without cause)

```
GLV client ──HTTP POST──▶ Worker ──graphId──▶ Durable Object
                                                 │
                    request: JSON or GraphBinary │ (accept both; beta.2 sends
                                                 │  binary, master sends JSON)
                                                 ▼
                                    ANTLR parser (generated from
                                    TinkerPop's canonical Gremlin.g4
                                    via antlr4ng TypeScript target)
                                                 ▼
                                    step chain extraction (typed AST;
                                    grammar encodes step + overload in
                                    node class names)
                                                 ▼
                                    compiler: CTE-chained SQL over
                                    nodes/edges, or write plans
                                                 ▼
                                    DO SQLite (dev shim: bun:sqlite)
                                                 ▼
                                    GraphBinary v4 streamed response
```

Key decisions and why:
- **Target TinkerPop 4, not 3.7 bytecode.** v4's wire format is a canonical
  Gremlin string + parameter map over HTTP. The ANTLR grammar in
  `gremlin-language` is the spec; we generate the parser rather than
  hand-writing anything. Result: protocol-compatible with every v4 GLV in
  every language, and we track upstream by regenerating.
- **Reuse the client package's GraphBinary implementation** (Apache-2.0,
  `gremlin/build/esm/structure/io/binary`). All ~30 type serializers are
  bidirectional. We wrote only the response framing (~20 lines).
- **Compile to SQL, don't interpret.** Each step appends a CTE; SQLite's
  planner does the traversal work via covering indexes. Row-at-a-time
  interpretation in JS is the failure mode to avoid.
- **Own IR = the step chain** (`{name, args}[]`). The grammar visitor is a
  thin front-end; if the wire format ever changes again, only that layer moves.

### Runtime abstraction (Bun ⇄ Cloudflare via DI)

One codebase, two runtimes: `bun run` locally, Durable Objects in production.
The platform-specific leaves are injected; everything above them (parser,
compiler, framing, request handler) is runtime-agnostic. Wiring uses Dan's
`@bodar/yadic` (JSR). Reference implementation to mirror:
`~/Projects/talebrary` — see `src/Application.ts` (the agnostic `application(deps)`
builder), `src/cloudflare/app.ts` and `src/bun/app.ts` (the two entry points that
provide platform `deps`), and `src/database/TalebraryDatabase.ts` +
`D1Adapter.ts` / `src/bun/SqliteDatabase.ts` (the swapped storage interface).

- **The seam is `Sql`** (`exec` + `query(sql, binds)`), consumed by the agnostic
  `GraphStore`, with two implementations: `BunSqlite` (`bun:sqlite`) and
  `DurableObjectSqlite` (`ctx.storage.sql`). The compiler consumes only
  `{sql, binds}` + write plans, so it needs no change; `src/handler.ts`'s
  `execute()` takes the store as a param.
- **Stays synchronous — deliberate divergence from talebrary.** Talebrary's
  `TalebraryDatabase` is async because D1 is async. We target DO
  `ctx.storage.sql`, which is *synchronous* (like `bun:sqlite`), so our
  interface keeps sync `get/all/run` — no promise wrapping, simpler compiler.
- **Wiring.** `application(deps)` = `LazyMap.create(deps)` layering the
  agnostic services (`Dependency<'store', GraphStore>`, `Dependency<'io', …>`
  for the GraphBinary primitives, then the request `handler`). Entry points:
  `src/bun/server.ts` provides `{store: new BunSqlite(...)}` and wraps `handler`
  in `Bun.serve`; `src/cloudflare/worker.ts` (the DO) provides
  `{store: new DurableObjectSqlite(ctx.storage.sql)}` and wraps `handler` in the
  DO `fetch`. `package.json` `module` points at the CF entry (talebrary does this).
- **DONE.** The seam, both adapters, `application(deps)`, and both entry points
  exist; one contract test runs on both runtimes over the real wire. `io` ended
  up a shared module (relative import bypasses gremlin's `exports` map and
  bundles under esbuild), not an injected leaf — only `store` is injected.

## Schema (performance rationale inline)

```sql
labels(id INTEGER PRIMARY KEY, name TEXT UNIQUE);       -- interning keeps edge
                                                        -- indexes small & hot
nodes(id INTEGER PRIMARY KEY, label INTEGER, props TEXT); -- JSON props; JSONB
                                                          -- when DO SQLite ≥3.45
edges(id INTEGER PRIMARY KEY, src INTEGER, label INTEGER,
      tgt INTEGER, props TEXT);
CREATE INDEX e_out ON edges(src, label, tgt);  -- covering: out() never touches
CREATE INDEX e_in  ON edges(tgt, label, src);  -- the table, index-only hops
CREATE INDEX n_label ON nodes(label);
```

- Property filters: `json_extract(props, '$.<key>')` with identifier-safe keys
  spliced **literally** (validated against `^[A-Za-z_][A-Za-z0-9_]*$`), exotic
  keys bound (`'$.'||?`). The literal path is REQUIRED for the expression index
  below to match — a bound path never does, forcing a full scan (measured ~90×
  slower). Injection-safe by validation, not parameterization. See
  `compiler.ts` `propExtract` and `test/performance.test.ts`.
- Hot properties: expression indexes are **auto-built on first filtered use**
  (`CREATE INDEX ... ON nodes(json_extract(props,'$.name'))`), driven by the
  compiler's `indexKeys` (keys hit by `has`/`order().by`) and
  `GraphStore.ensureNodePropIndex`. Self-tuning — no operator configuration. The
  planner uses them automatically because the compiled predicate uses the
  matching literal path (above). First touch of a cold key pays a one-time
  build (~270 ms at 1 M rows); thereafter index seeks.
- Constraint: DO SQLite has no user-defined functions. Anything SQL can't
  express (regex TextP) filters post-SQL in JS.

## Wire protocol notes (hard-won; trust these)

- Request: POST; body is either JSON `{gremlin, parameters, g, ...}` or
  GraphBinary `0x84 + map(fields, bare) + string(gremlin, bare)`. Sniff on
  first byte 0x84. Field name for parameters is `bindings` in binary requests.
- Response: `Content-Type: application/vnd.graphbinary-v4.0`. Frame:
  `0x84, bulked(0x00), value*, 0xFD 0x00 0x00, status int (bare),
  nullable message (0x00+string bare | 0x01), nullable exception (same)`.
  Always HTTP 200; errors go in the status trailer (client raises
  ResponseError with the message — verified working).
- `iterate()` appends a `.discard()` step — strip it, execute, return nothing.
- Grammar overload suffixes are lowercase (`TraversalMethod_limit_long`);
  step name = segment before first underscore.
- The client's `VertexSerializer.serialize()` hardcodes empty properties
  (client never needed to send them). To materialize properties we write our
  own vertex framing with the ioc primitives: `[VERTEX, 0x00] + any(id) +
  list([label], bare) + list(vertexProperties, qualified)`. Its deserialize
  side reads them fine.

## Semantics traps (encode as tests before implementing the step)

- Traversers are **multisets**: UNION ALL everywhere; `dedup()` is the only
  thing that collapses. Silent DISTINCT changes `count()` answers.
- `both()` on a self-loop yields the vertex twice.
- `repeat()` without `until()` is legal and infinite: enforce a max-depth
  guard (configurable, default ~32) and document the deviation.
- `has()` on a missing property filters the traverser (SQL NULL semantics
  align, but keep the explicit `IS NOT NULL` in `values()`).
- Element ids are integers (SQLite rowids). v4 clients round-trip them fine;
  don't invent string ids.

## Target — declared feature profile (the north star)

We aim to be a **conformant TinkerPop provider for a declared feature subset** —
not 100% of the 2101-scenario suite (no provider is). The suite's own
`Graph.Features` + tag mechanism sanctions this; our profile:

| `Graph.Features` | Supported | Notes |
|---|---|---|
| Persistence, Add/Remove V+E | ✅ | |
| Transactions (per-request, implicit) | ✅ | DO single-threading = serializable |
| ThreadedTransactions / multi-request `tx()` | ❌ | needs DO session state (P5) |
| Computer (OLAP / GraphComputer) | ❌ | locked out |
| Lambdas | ❌ | locked out (v4-native stance) |
| UserSuppliedIds (string/custom) | ✅ | target |
| MultiProperties | ✅ | target (schema rework) |
| MetaProperties | ✅ | target (schema rework) |
| Upsert (`mergeV`/`mergeE`) | ✅ | target — the agent workhorse |
| Property data types | primitives + list/map | JSON storage |

The conformance denominator is therefore "all non-lambda / non-OLAP /
non-multi-request-tx scenarios". `conformance/corpus.txt` (2177/2177 parse+chain)
is the "we understand the whole language" metric; the live cucumber pass count is
the "we execute it correctly" metric.

### Revised roadmap — writes-first (usable before feature-complete)

The P2/P3 read compiler is largely done (live L3 130). The path to *usable* is
sequenced so the invasive schema rework lands behind a deployed, writable
baseline:

- **W1 — user-supplied ids. DONE.** `nodes`/`edges` gained a nullable
  `uid TEXT UNIQUE`; the SQLite rowid stays the internal PK (all movement joins
  untouched — zero perf hit). uid is resolved at exactly two boundaries:
  `V('x')`/`E('x')` seed (numeric args → `id IN`, string args → `uid IN`, OR'd)
  and framing-out (`COALESCE(uid, id) AS id` at the id/vertex/edge/valueMap/
  elementMap/select/group-element projections). `addV().property(T.id, v)` sets
  the id (string→uid, int→rowid) and `property(T.label, v)` overrides the label
  — **also fixed a latent bug** where `property(T.id, …)` corrupted the prop bag.
  `addE` resolves string endpoint ids through uid and echoes the caller's ids on
  the wire. Verified end-to-end through the real GLV (`property(t.id,'person:marko')`,
  `V('person:marko').out().id()`). Known small gaps (deferred, not blocking):
  `properties().element().id()` and `group().by(__.id())` still surface the rowid
  (owner-uid not threaded into those two paths); `addE` can't yet set the edge's
  OWN uid (edges get rowid ids; endpoints echo user ids). mergeV/mergeE (W2) will
  build on this.
- **W2 — writes.** `mergeV`/`mergeE` (upsert, id-aware), `property()` update on
  existing elements, general `addE` from arbitrary traverser sets. → *writable*.
- **W3 — P4 deploy.** Worker router (`POST /g/{graphId}` → `idFromName` → DO,
  LOCKED design) + bearer auth per graph + delete/lifecycle management endpoint.
  → *deployable*.
- **W4 — multi/meta-property schema rework.** Props stop being a flat JSON object
  (design fork: nested JSON `{key:[{value,meta}]}` vs a normalized
  `properties` table). Touches valueMap/values/has/properties/addV/storage —
  biggest blast radius, deliberately after a deployed baseline exists.
- **W5 — conformance grind.** `aggregate`/`cap`, `path`/`simplePath`, `match`,
  `local`, `choose`, `coalesce`, `sack` + the multi/meta scenarios W4 unlocks +
  seeding the other reference graphs (classic/crew/grateful/sink).

The read-step backlog (below, P2-tail/P3/P5) continues under W5. Phases P0–P3 and
their step-level detail follow.

## Phases

**P0 — done (this repo).** Protocol shell, parser, schema, compiler slice
(V, hasLabel, has+P, out/in/both, dedup, limit, values, id, label, count),
writes (addV+property, addE via `to(__.V(id))`), discard, error trailers.
The shared contract (`test/contract.ts`) passes against unmodified
gremlin@4.0.0-beta.2 on both runtimes (Bun + Cloudflare DO); corpus 100%.

**P1 — correctness spine. DONE.**
1. Vertex property materialization — custom vertex framing (`handler.ts`
   `vertexBuffer`) bypasses the client's empty-props serializer; `valueMap`
   (list-valued, `+tokens`, key filter), `elementMap` (flat, T-token keys)
   land on it.
2. `drop()` — `WITH <ctes> DELETE FROM edges …; DELETE FROM nodes …`; deletes
   the target vertices and their incident edges (`compileDrop`).
3. `order().by(key[, desc])`, `range`, `skip` — a tail-modifier model in
   `compileRead`: order/range/skip/limit fold `ORDER BY`/`LIMIT`/`OFFSET` into
   the projection select; range/skip/limit stay CTEs when no `order()` precedes
   (so mid-chain limit still works). Plus `inject(consts)` as a value stream.
4. L3 cucumber stood up: `conformance/conformance-server.ts` hosts the named
   graphs (routing by the `g` field — dev only), `conformance/conformance.test.ts`
   is a self-contained mini-L3 through the real GLV, and
   `conformance/README-cucumber.md` has the full external run + tag ratchet.
   Publishing the full scenario count needs `npm install` in the TinkerPop GLV
   checkout (next action).

**P2 — the column-threading compiler.** `as()`/`select()`/`by()`/`project()`
require carrying labelled columns through the CTE chain (each `as('a')`
adds an alias column to every subsequent CTE). This is the structural upgrade
that unlocks most of the Medium tier. Split into data-ranked substages (coverage
measured against the official Gherkin suite, 2099 scenarios, 155 unlocked after
P1 — see the greedy set-cover analysis; `as`+`select` is the single biggest
*structural* lever available):

- **P2a — threading core: `as`/`select`/`project`/`by(key|vertex)`. DONE.**
  +53 scenarios (→208). Alias columns threaded through `traversalCtes` as
  synthetic safe names (`a0`,`a1`, … — never user strings in SQL identifiers);
  `as('a')` binds the current traverser id to its column, every subsequent CTE
  carries all bound alias columns, `out/in/both` move `id` while carrying
  aliases unchanged. Single `select('a')` reuses the existing `vertex`/`value`
  shape sourced from the alias column; multi-`select`/`project` produce a new
  `{kind:'map'}` shape framed by `handler.ts` `mapBuffer` (reuses `vertexBuffer`
  for vertex-valued entries — can't route those through `anySerializer`, same
  empty-props bug). `by()` modulators cycle across entries; `by('key')`→scalar,
  bare→vertex. Correctness guard: `extractArgs` now captures `Pop`/`Column`/`T`
  tokens (previously silently dropped → would mis-execute) and consumers throw a
  clear "not implemented" for everything past the P2a set (`Pop.first/all/mixed`,
  `Column`, `Scope.local`, `by(T.x)`, `by(__.nested)`, `order()` after
  select/project). Corpus stays 100% parse. Design constraint honoured: each
  alias is a stable, *referenceable* column so P2b's correlated subqueries build
  on it without reopening this work.
- **P2b — `where`/`not` + `is`. DONE.** Live L3 **85 → 119**. A shared
  `predicateSql(expr,binds,pred)` now backs `has`/`is`/`where` (one predicate code
  path), gaining **TextP** (`startingWith`/`endingWith`/`containing` + negations →
  `LIKE`/`NOT LIKE` with the pattern escaped and **bound**; regex/typeOf throw).
  `is(P)` folds onto the projected scalar (values/label/id → WHERE; count/sum →
  wrap). `where`/`not`/`filter(__.T)` are movement-phase filter CTEs via
  `compileFilterPredicate`: `EXISTS` over incident edges for bare movement,
  correlated scalar (`compileNestedScalar`, extended to `outE/inE/bothE`) for
  `.count().is(P)`, current-prop for `.values(k)[.is(P)]`/`has`/`hasLabel`; `not()`
  wraps `NOT COALESCE((pred),0)` so a NULL predicate (missing prop) counts as "no
  output" → kept. Alias-compare `where(P.neq("a"))` / `where("a",P.eq("b"))[.by(k)]`
  compares carried alias columns (P2a), consuming a trailing `by()`. Deferred with
  clear errors: `and()`/`or()`, nested `as()` inside where, multi-hop/neighbour-
  filter where, `where(P.eq(__.constant()))`, regex.
- **P2c — edge/element traversal + aggregation, sequenced to clear the L3
  `BeforeAll` gate.** The official cucumber runner's `BeforeAll` caches every
  seeded graph via three aggregation traversals
  (`g.V().group().by('name').by(__.tail())`,
  `g.E().group().by(__.project(...).by(__.outV().values('name'))...)`,
  `g.V().properties().group().by(__.project("n","k","v").by(__.element().values('name')).by(__.key()).by(__.value()))`)
  — so *no* upstream L3 scenario runs until that whole cluster works. Split
  (coverage vs the 2099-scenario suite, cumulative from P2a's 208):
  - **P2c-1 — edge traversal proper. DONE.** `E`, `outE`/`inE`/`bothE`,
    `outV`/`inV`/`bothV`, and edge-aware `has`/`hasLabel`/`label`/`values`/
    `count`/`order`/`valueMap`. The id-relation is now *typed*: `id` is a
    node-id or edge-id, tracked statically by the compiler (`Elem`, no runtime
    tag); `outE/inE/bothE` flip it to edge, `outV/inV/bothV` back to node,
    wrong-kind uses throw. New `edge` result shape framed by `handler.ts`
    `edgeBuffer` — materialises edge props as `Property` elements
    (`EdgeSerializer` hardcodes empty props, same bug `vertexBuffer` works
    around). Alias bindings record the element kind so `select`/`project` of an
    edge-typed label throws (would otherwise silently join `nodes`). Deferred
    with clear errors: edge `drop()`, edge `elementMap()` (needs IN/OUT tokens),
    edge-valued `select`/`project`. ~+57 (→~265).
  - **P2c-1b — property elements. DONE.** `properties(keys?)` then an optional
    `key`/`value`/`count`/`element`[`.values(k)`/`.id`/`.label`/`.count`]. The
    traverser is a property — a `json_each(props)` expansion carrying owner
    id/label/props + key(pk)/value(pv) — compiled in its own tail fn
    (`compileProperties`) rather than the movement phase. New `property` shape
    framed as a `VertexProperty`. Trailing steps past the follow-on throw (no
    silent drop); property→element→movement chains and `hasKey`/`hasValue`
    deferred. ~+33 (→~298).
  - **P2c-2 — aggregation. DONE (gate + adjacent slice).** `group`/`groupCount`/
    `fold`/`sum` + nested-traversal `by()` (the shared correlated-scalar-subquery
    machinery, `compileNestedScalar` — also P2b's `where` engine). **Clears the L3
    `BeforeAll` gate**: the upstream cucumber runner now gets past setup, so the
    official number is **live for the first time — 85 scenarios pass** (from 0;
    everything was gate-blocked) across the implemented tag set. group() is a
    barrier → one Map via a new `{kind:'group'}` shape; dual-path (locked #3):
    SQL `GROUP BY` for scalar reducers (count/sum/`json_group_array` scalar-lists),
    ordered-stream + linear handler assembly for element values (default list /
    `by(__.tail())`). `fold()`→`{kind:'list'}`, `sum()`→`{kind:'scalar'}` (Long/
    Double). Composite `by(__.project(...))` keys and group over V/E/`properties()`
    all land (the three gate traversals). Deferred with clear errors: `cap`/
    `aggregate` (side-effect state), general `unfold`, top-level `tail`, deep
    nested-`by()` chains, `local`/`Scope`. Remaining agg failures are all
    out-of-scope steps (repeat/as-in-complex-position/where/union/local).
- **P2 tail — PARTIALLY DONE (live L3 119 → 126).**
  - **`and`/`or`. DONE.** Filter steps: each branch → a `compileFilterPredicate`
    boolean, joined `AND`/`OR`; also inside `where(__.and/or)` (`combineBranchPreds`,
    shared). Reuses the P2b predicate engine.
  - **`union`. DONE (element branches).** `UNION ALL` of each branch's movement
    (`branchMovementSelect`, single out/in/both hop) seeded from the current
    relation → merged id-relation continues downstream. Scalar/mixed/multi-hop/
    aliased/edge branches defer with clear errors.
  - **`optional`. DONE (single hop).** `LEFT JOIN` + `COALESCE(neighbour, self)` —
    matches emit neighbour(s), a miss falls back to self. `both()`/multi-hop defer.
  - **`coalesce`. DEFERRED** (first-non-empty-branch-per-traverser needs correlated
    per-seed EXISTS chaining) — clear error.
  - **`path()`. DEFERRED** → JSON-array accumulation column threaded through
    movement (structural, like alias threading; accept loss of index-only scans).

**P3 — recursion & upserts.**
- `repeat/times/emit` → **DONE (live L3 126 → 130).** `WITH RECURSIVE
  walk(id, depth)` seeded from the current relation; body = single out/in/both
  hop (both = two recursive terms). `times(n)` (either side of `repeat`) → project
  `depth = n`; `emit` after → `depth >= 1`, before → `depth >= 0`; depth guard 32
  when `times` absent. All `WITH` became `WITH RECURSIVE` (harmless for
  non-recursive CTEs). Deferred with clear errors: `until()`, `emit(pred)`/
  `times(pred)`, complex bodies (order/limit/local inside repeat), `path`/
  `simplePath`, repeat after `as()`, repeat on edges.
- `until/emit(pred)` + `simplePath` via path-array containment — next.
- `mergeV`/`mergeE` → `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
  (requires unique indexes; part of the management/schema story). This is
  the agent-workload workhorse — prioritize if that's the driving use case.
- General `addE` (from any traverser set, `from()`/`to()` with arbitrary
  nested traversals).

**P4 — DO deployment.**
- DONE: the DI seam (`Sql` interface + agnostic `GraphStore`), both adapters
  (`BunSqlite`, `DurableObjectSqlite`), `application(deps)` yadic wiring, and
  the `src/cloudflare/worker.ts` entry (Worker + `GraphDatabase` DO). The shared
  contract test (`test/contract.ts`) passes on both runtimes over GraphBinary;
  the Worker builds for production (`wrangler deploy --dry-run`, ~265 KB gzip).
- Remaining: Worker router (LOCKED design): `POST /g/{graphId}` → `idFromName(graphId)`
  → DO; graph springs into existence on first request. The request's `g`
  field selects an optional named graph *within* the tenant. Never route on
  the `g` field at the Worker (forces body-parse before routing). Deletion/
  lifecycle = management endpoint on the Worker. Wrap each request in one
  implicit transaction (DO single-threading gives serializable isolation).
- Bundle check: parser + antlr4ng + serializers ≈ 1 MB minified (verified);
  ATN warm-up once per isolate.
- Auth: bearer token per graph at the Worker layer.

**P5 — stretch.**
- `match()` as a rewrite onto where/select (TinkerPop itself does this).
- `sack()` as an arithmetic column; `aggregate/cap` via staged execution.
- `shortestPath` special-cased recursive CTE.
- Multi-request `g.tx()` (grammar supports it; needs DO session state).
- Explicitly out of scope: lambdas (gremlin-lang barely supports them —
  defensible v4-native stance), OLAP/GraphComputer.

## Feature complexity map

| Feature | Mapping | Effort | Perf |
|---|---|---|---|
| V/E, hasLabel, has(k,v), P preds | indexed SELECT | done/trivial | excellent |
| out/in/both | covering-index joins | done | excellent |
| values/id/label/count/dedup/limit | SQL | done | excellent |
| addV/property, addE (restricted) | INSERT RETURNING | done | excellent |
| drop | DELETE + CTE targets | done | excellent |
| order/range/skip/valueMap/elementMap/inject | SQL / json_extract | done | excellent |
| E/outE/inE/bothE/outV/inV/bothV | typed id-relation + edge shape | done | excellent |
| as/select/project/by(key\|vertex) | column threading | done | very good |
| mergeV/mergeE | UPSERT RETURNING | easy | excellent |
| where/not (anon traversals) | correlated EXISTS | medium | good |
| union/coalesce/optional | UNION ALL/LEFT JOIN | medium | good |
| repeat/until/emit | recursive CTE + guard | medium | good |
| path/simplePath | JSON path column | medium | moderate |
| TextP | LIKE/GLOB; regex in JS | easy | good |
| group/groupCount | GROUP BY + json_group_object | easy | very good |
| sack | threaded column | medium | good |
| aggregate/cap/sideEffect | staged temp CTEs | hard | moderate |
| match | rewrite onto P2 primitives | med (after P2) | good |
| tx() multi-request | DO session | medium, defer | — |
| lambdas, OLAP | — | won't support | — |

## Test strategy: build against the official suites, not vibes

Four layers, cheapest first. TinkerPop ships everything we need; write as few
bespoke tests as possible.

**L1 — Grammar corpus gate (exists, passing 100%).**
`conformance/corpus.txt` holds all 2,177 unique canonical traversals extracted
from the official Gherkin features; `conformance/corpus-test.ts` parses and
chain-extracts every one. Current score: 2177/2177 parse, 2177/2177 chain.
CI gate: this never regresses. Re-extract when upstream features change
(regex over `gremlin-test/.../features/**/*.feature`). Side benefit: the
step-frequency table it prints is the implementation priority order —
top of corpus: V(1584), by(572), values(519), inject(420), as(321), out(281),
is(253), has(249), select(227), option(155), cap(142), order(138),
repeat(128). Note inject's rank: the suite uses it for inline data setup,
so implementing it early unlocks disproportionately many scenarios.

**L2 — Compiler snapshot tests (ours, small).**
For each supported step: canonical string → expected SQL + binds. Plus the
semantics traps below as executable tests (multiset counting, both() on
self-loop, missing-property has()). This is the only bespoke layer.

**L3 — The official Gherkin suite against a live mogwai-db (the score).**
164 feature files, run by TinkerPop's own JS cucumber runner that ships in
`gremlin-js/gremlin-javascript` (test/cucumber + `npm run features-graphbinary`).
It connects to `http://localhost:45940/gremlin` (hardcoded in test/helper.js —
point it at mogwai-db, or serve on that port) and uses GraphBinary, i.e. our
exact wire path. Requirements to host it:
- Serve the named test graphs: scenarios open connections per graph name
  (modern, classic, crew, sink, grateful, empty). Map graph name → separate
  database (in DO terms: graphId; in dev: one store per name).
  `conformance/seed-modern.ts` seeds modern with the canonical ids; start
  with modern+empty, which covers the large majority of scenarios.
- `@StepWrite` scenarios mutate the empty graph and the runner cleans it
  with `g.V().drop()` — implement drop early (P1) partly for this reason.
- Run narrow, expand outward: cucumber `--tags` lets us start with e.g.
  `@StepCount or @StepOut or @StepHas` and ratchet the tag set as steps land.
  The passing-scenario count is THE conformance number; publish it per commit
  and never let it drop.
- Expect to maintain a small ignore-list (feature-steps.js already has this
  mechanism upstream) for lambda/OLAP/side-effect-exotica scenarios that are
  explicitly out of scope.

**L4 — Cross-language spot checks.**
Once L3 is respectable, run gremlin-python (also v4) against the same server
with a port of the contract (test/contract.ts). Two independent GLVs passing is strong evidence
the protocol implementation is right rather than accidentally co-adapted to
the JS client.

Ratchet rule for the whole build: every new step lands with (a) L2 snapshots,
(b) its L3 tag added to the cucumber run, (c) corpus still at 100%.


## Definition of "production-close"

- L3 cucumber score published per commit; target: all scenarios not involving
  lambdas/OLAP/side-effect exotica (tracked via the ignore-list, kept short).
- Corpus gate at 100% parse/chain permanently.
- Unmodified GLVs in ≥2 languages (JS + Python) pass the same e2e suite.
- p50 single-hop traversal < 1 ms server-side at 1M edges (benchmark in repo).
- Clear `step not implemented: x()` errors for everything outside the set.
