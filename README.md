# mogwai-db

A TinkerPop 4 Gremlin server on SQLite, targeting Cloudflare Durable Objects.

## What works (verified against unmodified gremlin@4.0.0-beta.2)

- v4 HTTP wire protocol: GraphBinary + JSON requests, GraphBinary v4 streamed responses
- Parser generated from TinkerPop's canonical ANTLR grammar (antlr4ng, TypeScript target)
- Writes: addV+property, addE via to(__.V(id)), iterate()/discard()
- Reads compiled to CTE-chained SQL: V, hasLabel, has(k,v), has(k,P.gt/gte/lt/lte/within/without),
  out/in/both(labels...), dedup, limit, values, id, label, count
- Errors propagate as GraphBinary status trailers (client raises ResponseError with server message)

## Layout
- src/storage.ts   — schema: interned labels, integer ids, covering edge indexes
- src/compiler.ts  — canonical Gremlin -> step chain -> parameterised SQL / write plans
- src/server.ts        — Bun.serve endpoint + GraphBinary response framing (reuses the
                         client package's Apache-2.0 serializers)
- test/e2e.test.ts     — end-to-end suite via the real GLV (in-process server)
- conformance/         — corpus parse/chain conformance test
- parser/              — generated from gremlin-language/Gremlin.g4 (regenerate, don't edit)

## Run
Runtime is [Bun](https://bun.sh) (pinned via mise). `mise install` to get it.

```
bun install
bun run start                  # listens on :8182
bun test                       # e2e + corpus conformance
```

## Known gaps / next
- Vertex property materialization: client's VertexSerializer hardcodes empty properties
  on write; implement our own vertex framing with ioc primitives (~15 lines)
- Port storage.ts to DO SQLite (ctx.storage.sql) + Worker fetch handler; bun:sqlite
  is a shim with matching (synchronous) semantics
- Step coverage per the feature table: as/select, where, union, repeat (recursive CTE),
  order().by, valueMap, drop, mergeV/mergeE
- Conformance: run gremlin-test Gherkin subset
