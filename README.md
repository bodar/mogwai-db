<p align="center">
  <img src="logo.png" alt="mogwai-db" width="480">
</p>

# mogwai-db

A TinkerPop 4 Gremlin server on SQLite, targeting Cloudflare Durable Objects.

## What works (verified against unmodified gremlin@4.0.0-beta.2)

- v4 HTTP wire protocol: GraphBinary + JSON requests, GraphBinary v4 streamed responses
- Parser generated from TinkerPop's canonical ANTLR grammar (antlr4ng, TypeScript target)
- Writes: addV+property, addE via to(__.V(id)), iterate()/discard()
- Reads compiled to CTE-chained SQL: V, hasLabel, has(k,v), has(k,P.gt/gte/lt/lte/within/without),
  out/in/both(labels...), dedup, limit, values, id, label, count
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

## Known gaps / next
- Vertex property materialization: client's VertexSerializer hardcodes empty properties
  on write; implement our own vertex framing with ioc primitives (~15 lines)
- Worker router hardening: per-graph bearer auth, management/delete endpoints, real deploy
- Step coverage per the feature table: as/select, where, union, repeat (recursive CTE),
  order().by, valueMap, drop, mergeV/mergeE
- Conformance: run gremlin-test Gherkin subset
