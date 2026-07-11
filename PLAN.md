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

- Property filters: `json_extract(props, '$.' || ?)` with the key **bound**,
  never spliced (injection-safe by construction; mirrors Gremlin's own
  parameterization).
- Hot properties: expression indexes created on demand via a management
  endpoint (`CREATE INDEX ... ON nodes(json_extract(props,'$.name'))`);
  SQLite's planner picks them up automatically.
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
adds `a_id` to every subsequent CTE). This is the structural upgrade that
unlocks most of the Medium tier; design it once, carefully:
- `where(__.out(...).count().is(P.gte(n)))` → correlated EXISTS / scalar subquery
- `union`, `coalesce`, `optional` → UNION ALL / LEFT JOIN
- `path()` → JSON-array accumulation column (accept loss of index-only scans)

**P3 — recursion & upserts.**
- `repeat/until/emit/times` → recursive CTE with depth column; `simplePath`
  via path-array containment check.
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
| mergeV/mergeE | UPSERT RETURNING | easy | excellent |
| as/select/project/by | column threading | medium | very good |
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
