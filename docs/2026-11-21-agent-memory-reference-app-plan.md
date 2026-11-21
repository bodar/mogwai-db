# Agent-memory reference application — build plan

**Date:** 2026-11-21. **Status: PROPOSED — not started. Needs the owner's decisions in §7 before item 3.**
**Source:** `docs/reports/2026-11-21-production-readiness/05-agent-memory-reference-app.md` (the evidence)
and `docs/2026-07-17-agent-memory-vision.md` (the product direction). This plan does not replace the vision.
It builds the smallest application that shows a concrete reason to adopt mogwai-db.

## 1. Goal

Ship a reference application that stores and recalls an agent's memory in one mogwai graph per agent.
The application has five operations: `remember`, `recall`, `associate`, `forget` and `summarise`. Each
operation is one parameterised Gremlin query. The application runs on Cloudflare Workers and on Bun.

Success means three things:

1. An adopter can run it in under 10 minutes from a clean checkout.
2. Its end-to-end test runs in `mise run ci`.
3. A short page states, with measured numbers, what it costs per agent and how fast each operation is.

Non-goals: an MCP server, Code Mode, Workers AI extraction, facets and a commercial product. The vision
puts those in a sibling `mogwai-memory` repository (vision, "Open forks" item 2).

## 2. Current state

All facts below are from the report, section 2 to section 4. Status words: exists, partial, missing.

| Area | Status | Evidence |
|---|---|---|
| One graph per id, created on first request | exists | `src/cloudflare/cloudflare-graph-manager.ts:109` |
| DO RPC `json(gremlin, params)` | exists | `src/cloudflare/graph-store-do.ts:99` |
| Full-text substring search, composes with traversal | exists | `src/storage.ts:63-65`; `src/services/catalog/search.ts:105-120` |
| Ranking by recency and salience in one query | exists | report §4.2 (`math`, `dateDiff`, `sack`) |
| Upsert of entities and edges | exists | `mergeV`/`mergeE`, report §4.1 |
| Reference application, schema, recipes | missing | `src/examples.ts:31-36` holds only TinkerPop demo graphs |
| Authentication | missing | `docs/outstanding-work.md` `operations` |
| Map parameter in a JSON request | missing | `src/wire.ts:135-146` passes objects unchanged; `src/services/params/call-params.ts:104` needs a `Map` |
| `datetime` parameter | missing | report §4.3; declines in `property`, `has`, `inject`, `mergeV` |
| Batch ingestion with per-row values | missing | `R8-res`, `inject-label-addV`, `inject-unfold-nested` |
| Text relevance score | missing | `tinker.search` is a filter (`search.ts:11-26`) |
| Vector similarity | missing | `agent-memory-spike`; `values(list).unfold()` declines (`per-row-node-vocabulary-closed`) |

## 3. Design

### 3.1 Deployment shape

```
client (any language, JSON)
   │  HTTPS + auth header
   ▼
memory Worker  ── examples/agent-memory/worker.ts (new)
   │  env.GRAPH.getByName(`mem:${agentId}`).json(gremlin, params)   ← DO RPC, Map params
   ▼
GraphDatabase DO (one per agent)  ── src/cloudflare/graph-store-do.ts, unchanged
```

The memory Worker owns authentication and the mapping from caller to agent id. It never exposes the
mogwai `/gremlin/{g}` routes. It reaches the DOs through a Durable Object binding. Two binding options
exist; §7 decision D2 picks one.

On Bun, the same five handlers call `BunGraphManager.executor(id).jsonAsync(gremlin, params)`. So one
handler module serves both runtimes. The handler module imports only `src/` code and needs no new
dependency.

### 3.2 Graph schema

The schema is the one in the report, §6.2. It is documentation and recipes, not code. Edge labels stay
typed (`mentions`, `recorded`, `supersedes`, `summarizedBy`).

### 3.3 Queries

The queries are the ones in the report, §6.3. Rules:

- Every user value is a parameter, except a `datetime`, until item 1b lands. A `datetime` is a literal
  built from `Date.toISOString()`. This follows the bind rule in `CLAUDE.md`: a literal is a constant.
- A counter that `math()` updates is a Double from the start (`hits: 0.0d`), so its type never changes.
- Recall ranks in SQL: `project(…).by(…dateDiff…math…)` then `order().by(select('score'), desc).limit(k)`.
  Nothing is ranked in JavaScript. This follows locked decision 3.

### 3.4 Respecting the locked decisions

| Rule (`CLAUDE.md`) | How this plan keeps it |
|---|---|
| Compile to SQL, never interpret | Every operation is one compiled query. The Worker only routes. Item 6 computes cosine in SQL. |
| Never decline on data size | No operation checks a count. Batch ingestion waits for `R8-res`, which crosses data as one `json_each` value. |
| Binds only for user parameters | Every agent value is a parameter. Constants (weights, labels) are literals. |
| No new dependencies without approval | None in items 0–5. Item 7 lists a dependency as decision D4. |
| Parser is generated, never edited | No grammar change. `dateDiff(param)` stays a parse error; the app uses a literal. |

## 4. Work items

Each item has an acceptance test. Do them in order. Items 1a and 1b change `src/`; the others add files.

### Item 0 — Measure the vendored `gremlin-mcp` against mogwai (no code change)

The Apache `gremlin-mcp` (`vendor/tinkerpop/gremlin-js/gremlin-mcp`) speaks HTTP through the `gremlin`
driver (`src/gremlin/connection.ts:42` there). mogwai serves the bare `/gremlin` endpoint with a body `g`
field (`.claude/rules/management-api.md`). So the vision's Layer A may already work with zero code.
**This is inferred, not measured.**

- Run its tool queries (`get_graph_status`, `get_graph_schema`, `run_gremlin_query`) against a Bun
  mogwai seeded with the memory schema. Use a scratch directory; do not add it as a dependency.
- Record which tool queries answer and which decline.

**Acceptance:** a table in this plan, under item 0, lists each `gremlin-mcp` tool query and its outcome.

### Item 1a — Accept a map parameter in a JSON request

`parseJsonQuery` (`src/wire.ts:135-146`) passes JSON objects as plain objects. Convert a JSON object
binding to a `Map`, recursively, so it means what a GraphBinary map means. Decision D1 settles whether a
plain object is always a `Map`.

**Acceptance:** a test in `test/wire.test.ts` posts `bindings: {"p": {"search": "kyoto"}}` with
`g.call('tinker.search', p).element()` and `bindings: {"m": {"name": "tea"}}` with `g.mergeV(m)` over
JSON. Both answer. The same requests over GraphBinary give the same rows.

### Item 1b — Accept a `datetime` parameter

A JS `Date` parameter typed `datetime` declines in `property`, `has(k, P)`, `inject` and a `mergeV` map
(report §4.3). Find the decline with `bun scripts/rel-blockers.ts` and fix it in the shared lowering. The
`datetime(…)` literal path already answers, so the parameter path should reuse its value node.

**Acceptance:** an L4 scenario (`test/L4-addendum/`) per position: `property('t', ts)`,
`has('t', lt(ts))`, `inject(ts)`, `mergeV(m)` with a `datetime` member. Each answers and matches the
literal form. A GraphBinary round trip through the `gremlin` client is in `test/wire.test.ts`.

### Item 2 — Memory recipes as a workload source

Add the report §6.3 queries, over a small seeded memory graph, to the L6 workload corpus as a new source
`agent-memory`. Generate goldens offline from TinkerGraph, as for every L6 source
(`scripts/workload-goldens/generate.ts`).

**Acceptance:** `mise run L6` lists the `agent-memory` source, every query is `pass`, and
`test/L6-workload/baseline.json` records them. The composed `recall` query (report §6.3, not yet run as
one query) is one of them.

### Item 3 — The handler module and the Bun runner

Add `examples/agent-memory/` with:

- `memory.ts` — five handlers `remember`, `recall`, `associate`, `forget`, `summarise`. Each takes an
  executor and a typed request, and returns a typed result.
- `bun.ts` — a Bun entry that serves the five endpoints over `startServer`'s manager.
- `README.md` — the schema, the five queries and the run steps (How-to, Diátaxis).

**Acceptance:** `test/examples-agent-memory.test.ts` starts the Bun runner on port 0 (as
`test/examples.test.ts` does), creates two agents, and checks:

- `remember` then `recall` returns the memory for agent A and nothing for agent B (isolation);
- `associate` then `recall` with expansion returns the linked memory;
- `forget` removes low-salience, old memories and orphaned entities;
- `summarise` returns entity counts in descending order.

### Item 4 — The Cloudflare Worker

Add `examples/agent-memory/worker.ts` and its `wrangler` config. It authenticates with a shared-secret
header for the demonstration (decision D3), maps the caller to `mem:<agentId>`, and calls the DO over
RPC.

**Acceptance:** a test beside `test/cloudflare.test.ts` runs the same checks as item 3 under
`wrangler dev`. The test also checks that a request without the secret gets HTTP 401, and that the
mogwai `/gremlin/{g}` route of the memory deployment is not reachable.

### Item 5 — Measured cost and latency page

Measure each operation at 1,000, 10,000 and 50,000 memories per agent, on Bun and under `wrangler dev`.
Report the median and p95 of 50 runs, the SQLite file size, and the plan shape (`EXPLAIN QUERY PLAN`
shows index seeks, not scans). Write the page as `examples/agent-memory/MEASUREMENTS.md`.

**Acceptance:** the page exists, names the commit it measured, and every number has its runtime and
graph size. A test in `test/L2-sql/` asserts that `recall` and the 2-hop expansion seek the
`property_fts` index and the adjacency indexes (no full `SCAN` of `vertex_properties` or `edges`).

### Item 6 — Similarity spike (the vision's Phase 0)

This is `agent-memory-spike`. Gremlin cannot express cosine today (report §4.4). Spike a `call()`
service `mogwai.vector.knn` that computes cosine in SQL:

- Embeddings are stored as a list-valued property (already works, report §4.4).
- The query vector is ONE parameter (a user value, so a bind is correct).
- The service joins `json_each` over the stored list with `json_each` over the query vector on the
  member index, and sums the products. Its output is the top-k elements with a score.

Measure at 1,000, 10,000 and 50,000 vectors of 384 dimensions, on Bun and under `wrangler dev`.

**Acceptance:** a measurement table in this plan, and a decision record: keep the service, replace it
with Vectorize (vision fork 1a), or stop. No service ships to `src/services/` without decision D5.

### Item 7 — Optional: ranked text search

Add a `mogwai.search.ranked` service that uses `property_fts MATCH` with `bm25()` and returns a score per
element. FTS5 computes `bm25()` for any tokenizer; whether it is useful over trigram tokens is not known.

**Acceptance:** a measurement on the item 5 graphs shows that the `bm25()` order differs from the
substring order and puts the expected memory first on 10 hand-written queries. If it does not, record
that and stop.

## 5. Order and dependencies

| Item | Depends on | Changes `src/` | Blocks |
|---|---|---|---|
| 0 | — | no | — |
| 1a | D1 | yes (`src/wire.ts`) | 3 over plain HTTP |
| 1b | — | yes (lowering) | parameterised dates in 2–4 |
| 2 | — (1b optional) | no | 3 |
| 3 | 2, D3 | no | 4, 5 |
| 4 | 3, D2, D3 | no | 5 |
| 5 | 4 | no | — |
| 6 | D5 | spike only | — |
| 7 | 5 | spike only | — |

`R8-res` (batch upsert) is not in this plan. When it lands, item 3 adds a `rememberMany` handler.

## 6. Risks

| Risk | Effect | Check |
|---|---|---|
| Cross-script DO binding is not supported as assumed | Item 4 must put the Worker in the mogwai script | Item 4's test runs under `wrangler dev` before any docs are written |
| `datetime` parameter fix is wider than one lowering | Item 1b grows | Rank it with `mise run rel-blockers` first; if it is a family, fix the family |
| JSON object → `Map` changes an existing client's meaning | A client that sent an object for a list or string param breaks | Item 1a test covers scalar, list and map; D1 decides |
| Demo numbers read as a benchmark | Over-claims | Item 5 names runtime, size and commit for every number |
| The application drifts from the engine | Recipes stop working after a compiler change | Item 2 puts them in L6, which gates `mise run ci` |
| Write latency (5.3 ms per memory on Bun, report §4.5) is too high for bulk import | Slow onboarding of existing memories | Use `io()` GraphSON import for bulk; revisit after `R8-res` |

## 7. Open decisions for the owner

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | JSON object binding semantics | (a) always a `Map`; (b) a `Map` only where a step needs one; (c) a typed JSON envelope (`{"@type": "g:Map", …}`) | (a): it is what a JSON client means, and GraphBinary already sends `Map` |
| D2 | How the memory Worker reaches the DOs | (a) cross-script DO binding to mogwai's `GraphDatabase`; (b) a second Worker entry in the mogwai script; (c) a service binding to mogwai's HTTP routes | (a), if item 4 shows it works |
| D3 | Authentication for the demonstration | (a) shared secret header; (b) Cloudflare Access; (c) wait for `operations` and `docs/2026-11-21-auth-access-control-plan.md` (written in parallel) | (a) for the demo, stated as not production auth |
| D4 | MCP surface | (a) none here; (b) point the vendored `gremlin-mcp` at the Worker; (c) build an MCP server, which needs `@modelcontextprotocol/sdk` (a new dependency) | (a) or (b); (c) belongs in the sibling repo |
| D5 | Similarity | (a) in-DO `mogwai.vector.knn` service; (b) Vectorize sidecar; (c) none | Decide after item 6's numbers |
| D6 | Where the application lives | (a) `examples/agent-memory/` in this repo; (b) the sibling `mogwai-memory` repo now | (a): its test then guards the engine; move it when the product starts |

## Glossary

| Term | Meaning here |
|---|---|
| agent graph | One graph per agent; one Durable Object on Cloudflare. |
| DO RPC | A method call from a Worker to a Durable Object, without HTTP. |
| golden | The answer TinkerGraph gives for a workload query, recorded offline. |
| L6 | The realistic-workload test level (`test/L6-workload/`). |
| recipe | One documented Gremlin query for one memory operation. |
