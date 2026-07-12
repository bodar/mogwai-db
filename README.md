<p align="center">
  <img src="logo.png" alt="mogwai-db" width="480">
</p>

# mogwai-db

A TinkerPop 4 Gremlin server on SQLite, targeting Cloudflare Durable Objects.

> ## ⚠️ Status: pre-alpha — work in progress, **not for production**
>
> This is an **active experiment under heavy development on `trunk`**. It is
> **not ready for real use** — not yet deployed, not hardened, no auth, and the
> property storage model is about to be reworked (breaking). Do not build
> anything on it yet. It's shared in the open so the design and progress are
> visible, not because it's usable. If you pull `trunk`, expect churn.
>
> **Where we are today:**
> - **Understands the whole language:** 2,177 / 2,177 canonical Gremlin traversals
>   from the official Gherkin corpus parse + chain-extract (100%).
> - **Executes correctly:** **205** official TinkerPop Gherkin scenarios pass
>   against a live server through the *unmodified* `gremlin@4.0.0-beta.2` client
>   (of a ~2,101-scenario suite that no provider passes 100% of — we target a
>   declared feature subset: no lambdas, no OLAP, no multi-request transactions).
>   The number only ratchets up.
> - **Reads:** compiler is largely complete (movement, filters, projections,
>   aggregation, `where`/`and`/`or`/`union`/`optional`, `repeat`/`times`/`emit`).
> - **Writes:** the graph is now **writable** — `addV`/`addE`, user-supplied ids,
>   `mergeV`/`mergeE` upsert, and `property()` update all land.
> - **Not yet:** Cloudflare deploy + Worker auth (**the immediate next milestone**),
>   multi/meta properties (breaking schema rework), the conformance grind
>   (`match`, `path`, `coalesce`, …).
>
> See [docs/2026-07-11-phased-roadmap-plan.md](docs/2026-07-11-phased-roadmap-plan.md) for the phased roadmap and the writes-first sequence.

## Where mogwai-db fits (and where it doesn't)

mogwai-db is **not** trying to be Neptune or TigerGraph. It's aimed at a
different, underserved corner of the graph-database space.

**Good fit:** many small-to-medium **isolated** graphs — per-user knowledge
graphs, per-tenant SaaS graphs, agent memory, personal projects. One Durable
Object = one graph, so per-tenant isolation is free and idle graphs cost
essentially nothing (scale to zero). Point lookups and k-hop traversals compile
to index-only SQLite queries that run *in the same process as storage* — no
query-engine-to-storage network hop, so latency on the common OLTP shape is
competitive with (often faster than) the managed incumbents.

**Poor fit:** one enormous graph, or heavy analytics. A DO caps at ~10 GB of
SQLite (tens of millions of edges), execution is single-threaded per graph, and
there are no parallel/OLAP graph algorithms (PageRank, community detection,
whole-graph scans). If you need to shard one logical graph across machines or run
graph analytics at scale, use Neptune / TigerGraph — that's their job, not this.

### How it compares

The tick column is mogwai-db's honest **self-rating**: ✅✅ = a real edge · ✅ =
solid / on par · ❌ = a weak spot for now. The other columns are informational —
where each database sits on that dimension.

| Property | mogwai-db | Neptune | Cosmos (Gremlin) | Neo4j Aura | TigerGraph | JanusGraph |
|---|---|---|---|---|---|---|
| Gremlin / TinkerPop | ✅✅ **v4** | v3 | v3 | Cypher | GSQL | v3 |
| Managed infra | ✅ Cloudflare-run | managed | managed | managed | managed | self-run |
| Capacity planning / sizing | ✅✅ autoscale | serverless | autoscale | provisioned | provisioned | provisioned |
| Scale-to-zero | ✅✅ ~$0 | no | no | no | no | no |
| Cheap per-tenant fleets | ✅✅ free | costly | costly | costly | costly | costly |
| Single-graph scale | ❌ ~10 GB | ~unbounded | ~unbounded | large | large | large |
| OLAP | ❌ none | strong | weak | strong | strong | Spark |
| Maturity | ❌ **pre-alpha** | GA | GA | GA | GA | GA |

Read the columns: mogwai's real edges are **idle cost, per-tenant isolation, and
v4 currency**; it honestly concedes **scale ceiling, OLAP, and — for now —
maturity**. The managed services are *equals* on infrastructure ops, not worse.

## What works (verified against unmodified gremlin@4.0.0-beta.2)

- v4 HTTP wire protocol: GraphBinary + JSON requests, GraphBinary v4 streamed responses
- Parser generated from TinkerPop's canonical ANTLR grammar (antlr4ng, TypeScript target)
- Writes: addV + property (incl. user-supplied `T.id`/`T.label`), general addE (from/to alias or __.V(id)),
  mergeV/mergeE upsert (option(Merge.onCreate/onMatch)), property() update, iterate()/discard()
- Reads compiled to CTE-chained SQL:
  - movement: V/E, hasLabel, has(k,v) + P.gt/gte/lt/lte/within/without + TextP, out/in/both(labels…), dedup, range/skip/limit
  - projection: values, id, label, count, valueMap, elementMap, properties, edge/property elements
  - structure: as/select/project/by (column threading), order().by
  - aggregation: group/groupCount/fold/sum + nested by()
  - filter/branch: where/not/is, and/or, union, optional
  - recursion: repeat(__.…).times(n) [+ emit] via recursive CTE (depth-guarded)
- Vertex/edge property materialization (custom GraphBinary framing — client serializer ships empty props)
- Errors propagate as GraphBinary status trailers (client raises ResponseError with server message)

## Runs on two runtimes from one codebase

Everything above the storage driver is runtime-agnostic; the platform-specific
leaf is injected via DI (`@bodar/yadic`). Same parser, compiler, framing and
request handler serve both:
- **Bun** (dev/local) — `Bun.serve` over `bun:sqlite`.
- **Cloudflare Durable Objects** (production) — one DO = one isolated graph, over
  `ctx.storage.sql`. Worker routes `POST /g/{graphId}` → `getByName` → DO.

The `Sql` interface (`src/storage.ts`) is the seam — two ~15-line adapters
(`src/bun/BunSqlite.ts`, `src/cloudflare/DurableObjectSqlite.ts`). Both SQLite,
both synchronous. One shared contract test (`test/contract.ts`) runs against
both over the real GraphBinary wire, so they're proven identical, not tested twice.

## Layout
- src/storage.ts                     — `Sql` seam + agnostic `GraphStore` (schema, label interning)
- src/compiler.ts                    — canonical Gremlin -> step chain -> parameterised SQL / write plans
- src/handler.ts                     — request handling + GraphBinary framing (Web Request/Response)
- src/application.ts                 — DI wiring (`application(deps)`), shared by both runtimes
- src/io.ts                          — reused Apache-2.0 GraphBinary serializers from the gremlin client
- src/bun/{BunSqlite,server}.ts      — Bun entry: bun:sqlite + Bun.serve
- src/cloudflare/{DurableObjectSqlite,worker}.ts — CF entry: ctx.storage.sql + Worker/DO
- test/contract.ts                   — shared conformance contract (both runtimes run it)
- conformance/                       — corpus parse/chain conformance test
- parser/                            — generated from gremlin-language/Gremlin.g4 (regenerate, don't edit)

## Run
Runtime is [Bun](https://bun.sh) (pinned via mise). `mise install` to get it.

The build graph lives in [mise tasks](mise.toml) — `install ─▶ {test, build} ─▶ ci`.
CI (GitHub Actions) just runs `mise run ci`.

```
mise run test                  # full suite: corpus + contract on both runtimes
mise run build                 # bundle the Worker (wrangler dry-run deploy)
mise run ci                    # the gate: test + build

bun run start                  # Bun server on :8182
bun run dev:cf                 # Worker + DO under wrangler dev
bun run deploy                 # wrangler deploy
```

`mise run test` boots the Worker under `wrangler dev` for the Cloudflare half, so
the first run may pause while workerd starts.

## Known gaps / next (see docs/2026-07-11-phased-roadmap-plan.md for the sequenced roadmap)
- **Deploy (W3, immediate next):** Worker router hardening — per-graph bearer
  auth, management/delete endpoint, real Cloudflare deploy → *deployable*.
- **Multi/meta properties (W4):** props are still a flat JSON object; reworking to
  support multi-/meta-properties touches storage + valueMap/values/has/properties
  (breaking, biggest blast radius — deliberately after a deployed baseline).
- **Conformance grind (W5):** `aggregate`/`cap`, `path`/`simplePath`, `match`,
  `local`, `choose`, `coalesce`, `sack`; seed the other reference graphs.
- **Not planned (declared out of scope):** lambdas, OLAP/GraphComputer,
  multi-request transactions.

## Traversal strategies fail closed
`withStrategies(...)` (e.g. `PartitionStrategy`, `SubgraphStrategy`) parses and
chains, but the compiler does not yet *apply* it. Rather than silently drop it —
which would give a client relying on it for logical partition/subgraph isolation
unfiltered reads with no error — the compiler **rejects it at execution** until
it's honoured. Fail closed, never leak.
