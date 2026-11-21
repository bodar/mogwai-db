# 05 — Agent-memory reference application

**Date:** 2026-11-21. **Scope:** the reviewer's request for a reference application that "demonstrates a
concrete reason to adopt it", with agent memory as the candidate. **Method:** read-only code analysis at
trunk `1489c279`, plus throwaway probe scripts (not committed). The probes ran Gremlin queries against an
in-process store (`test/support/executor.ts` `exec(store).jsonAsync`) and against a real Bun server
(`src/bun/server.ts` `startServer`). No suite was run. Every timing is **measured on Bun, in-memory
SQLite, one run, one laptop**. Timings on a Durable Object are **not measured**.

**Related documents.** Vision: `docs/2026-07-17-agent-memory-vision.md`. Open work:
`docs/outstanding-work.md`. Step support: `docs/feature-support-matrix.md`. Differences and limits:
`docs/limitations.md`. The build plan for this area: `docs/2026-11-21-agent-memory-reference-app-plan.md`.

## 1. Summary (Explanation)

The reviewer's concern is valid. The repository has no reference application of any kind. The only
example content is the four TinkerPop demo graphs (`src/examples.ts:31-36`). The agent-memory vision
says itself that "NOTHING in it has shipped" (`docs/2026-07-17-agent-memory-vision.md:3-7`).

The engine substrate for a small memory application exists today. The probes show that the five memory
operations (write, recall, associate, forget, summarise) each have a working Gremlin form. Full-text
search and graph traversal compose in one query. One graph per agent is the default deployment model.

Five gaps stop the application from being convincing today:

1. There is no authentication (`docs/outstanding-work.md` `operations`). A graph id in the URL is the
   only selector, so any caller can read any agent's memory.
2. A JSON request cannot send a map parameter. An HTTP client without a GraphBinary driver cannot call
   `tinker.search` or `mergeV` with a parameter (section 4.3). This gap is **not tracked**.
3. Batch ingestion with a per-row computed property declines (`R8-res`, `inject-label-addV`,
   `inject-unfold-nested`). One memory per request works, at 5.3 ms per write on Bun.
4. A `datetime` parameter declines in every position the probes tried (section 4.3). This gap is **not
   tracked**. A `datetime('…')` literal works.
5. Search has no relevance score, and there is no vector search. `tinker.search` is a substring filter
   (`src/services/catalog/search.ts:11-26`). Brute-force cosine in Gremlin declines (section 4.4).

The smallest convincing application is a Cloudflare Worker with five endpoints. It calls one Durable
Object per agent over RPC, and it ranks by recency and salience in Gremlin. It needs no new dependency.
Section 6 gives the schema and the queries. The plan file gives the ordered work.

## 2. What exists (Reference)

| Capability the application needs | Status | Evidence |
|---|---|---|
| One isolated graph per agent, created on first request | exists | `src/cloudflare/cloudflare-graph-manager.ts:109` (`getByName(id)`); `.claude/rules/management-api.md` "Graph selection" |
| Idle graph costs no compute | exists (platform property) | DO-per-graph; teardown is `ctx.storage.deleteAll()` (`.claude/rules/management-api.md`) |
| Parameterised Gremlin over HTTP and GraphBinary | exists | `src/router.ts:100-118`, `src/wire.ts:135-171` |
| Durable Object RPC `json(gremlin, params)` | exists | `src/cloudflare/graph-store-do.ts:99` |
| Full-text substring index on every property value | exists | `src/storage.ts:63-65` (`property_fts`, FTS5 trigram, case-insensitive) |
| `tinker.search` service over that index | partial | `src/services/catalog/search.ts:105-120`; 3-character minimum (`:31`, `:55`); no `regex` (`:50`); no score |
| `TextP.containing` routed through the same index | exists | `src/services/CLAUDE.md` "Full-text search"; `src/rel/passes/semijoin.ts` `trigramSeek` |
| Typed schema reflection (`g.call('schema')`) | exists | `src/services/catalog/schema.ts:236` |
| `math()`, `dateDiff()`, `sack()` for scoring | exists | `docs/feature-support-matrix.md` §10, §11 |
| Upsert (`mergeV`, `mergeE`) | exists | `docs/feature-support-matrix.md` §5 |
| Graph algorithms (`pageRank`, `shortestPath`, `nodeSimilarity`, …) | exists | `docs/feature-support-matrix.md` §13 |
| Backup and restore to R2 (`io()`) | exists | `wrangler.jsonc` `r2_buckets`; `src/cloudflare/R2IoStore.ts` |
| Cross-graph query (`federate`) | exists | `src/services/catalog/federate.ts`; `docs/feature-support-matrix.md` §13 |
| Replication between graphs | exists | `src/replicate.ts`; `wrangler.jsonc` `REPLICATOR` |
| Browser runtime (OPFS storage, a graph per Worker) | exists | `src/browser/mogwai.ts`, `src/browser/OpfsIoStore.ts` |
| GraphQL front end | partial | `src/graphql/translate.ts`; schema redesign pending (`graphql-redesign`) |
| Authentication | missing | `docs/outstanding-work.md` `operations` |
| MCP server | missing | no MCP code in `src/`; the Apache `gremlin-mcp` is vendored at `vendor/tinkerpop/gremlin-js/gremlin-mcp` |
| Vector search | missing | no vector code in `src/`; spike not run (`agent-memory-spike`) |
| Memory schema, recipes, or demo | missing | nothing in `src/`, `test/` or `docs/` except the vision |

## 3. What the vision assumes that is not true yet (Reference)

| Vision claim | Fact today | Status |
|---|---|---|
| "Typed params + type-truth" for every client (vision, Layer A) | True over GraphBinary. A JSON request sets `paramTypes: {}` and passes objects unchanged (`src/wire.ts:139-141`). A JSON object binding is not a Map, so `call()` and `mergeV` do not read it (`src/services/params/call-params.ts:104`). | partial |
| "Enum discovery = one `values(k).dedup()`" | `values(k).dedup()` works. No service returns enums; `schema` returns keys and types only. | partial |
| "Chunked GraphBinary streaming" | Exists (`src/router.ts` `streamBuffers`). | exists |
| "Recency decay … in the compiled ORDER BY" | Works with `dateDiff` and `math` inside `project().by()` (probe `decay-score`, section 4.2). | exists |
| "Salience reinforced on access (write-back on read)" | A top-level `property(single, k, __.values(k).math('_ + 1'))` after recall works. A write inside `sideEffect()` declines (`s3-write-in-child`). `math()` turns an integer counter into a Double. | partial |
| "Fused score `w1·sim + w2·recency + w3·salience`" | Two of three terms work. There is no similarity term: no vector search and no text relevance score. | partial |
| "Brute-force cosine in SQL over a per-agent DO" | Not measured (`agent-memory-spike`). In Gremlin, `values('emb').unfold()` over a list-valued property declines (`per-row-node-vocabulary-closed`), and `index()` is missing. | missing |
| "Ingestion via Workers AI or MCP sampling" | No code. | missing |
| "Facets per agent under a supervisor DO" | No code. Plain DO per graph is the model in use. | missing |
| "Better gremlin-mcp: honest errors on the trailer" | Errors ride the GraphBinary trailer (`src/router.ts:114-118`). A JSON client gets HTTP 200 with a GraphBinary error body (`src/http.ts:49-53`). | partial |

## 4. Probe results (Reference)

### 4.1 Memory operations

Graph: one agent graph created on first request. Queries sent as JSON over HTTP to a Bun server unless
the row says "in-process". "Answers" means the result matched a hand check.

| Operation | Query shape (abridged) | Result |
|---|---|---|
| write | `g.addV('memory').property('mid',mid).property('text',text)…property('salience',0.7d)` with JSON scalar bindings | answers |
| write + link to session | `…as('m').V().has('session','sid','s1').addE('recorded').to('m')` | answers |
| entity upsert | `g.mergeV([(T.label):'entity','name':'tea']).option(Merge.onCreate,['kind':'topic'])`, twice | answers; second call returns the same vertex |
| associate | `mergeE([(T.label):'mentions',(Direction.OUT):Merge.outV,(Direction.IN):Merge.inV]).option(Merge.outV,__.select('m'))…` | answers |
| associate | `V().has('memory','mid','m3').addE('mentions').to(__.V().has('entity','name','tea'))` | answers |
| recall (text) | `g.call('tinker.search',['search':'tea']).element().values('mid')` | answers |
| recall (text + graph) | `…element().hasLabel('memory').out('mentions').in('mentions').dedup().values('mid')` | answers |
| recall (text + rank) | `…element().hasLabel('memory').order().by('salience',desc).limit(5)` | answers |
| recall (related) | `V().has('memory','mid','m1').as('x').out('mentions').in('mentions').where(neq('x')).dedup()` | answers |
| recall (page) | `V().hasLabel('memory').order().by('createdAt',desc).range(0,2)` | answers |
| reinforce | `V().has('memory','mid','m1').property(single,'hits',__.values('hits').math('_ + 1'))` | answers; `hits` becomes a Double (`math()` always returns Double, `docs/feature-support-matrix.md` §10) |
| recall + reinforce, one query | `…order().by('salience',desc).limit(1).property(single,'hits',__.values('hits').math('_ + 1')).values('mid','hits')` | answers (in-process) |
| supersede | `V().has(…,'m2').as('old').addV('memory')….addE('supersedes').to('old')` | answers |
| current facts only | `V().hasLabel('memory').not(__.in('supersedes'))` | answers |
| forget (decay) | `V().hasLabel('memory').has('salience',lt(0.5)).has('lastSeen',lt(datetime(…))).drop()` | answers |
| forget (orphans) | `V().hasLabel('entity').not(__.in('mentions')).drop()` | answers |
| summarise | `V().hasLabel('memory').group().by('kind').by(values('text').fold())` | answers |
| summarise | `V().hasLabel('entity').project('entity','mentions').by('name').by(__.in('mentions').count()).order().by(select('mentions'),desc)` | answers |
| summary node | `addV('summary')….as('s').V().has('memory','kind','fact').addE('summarizedBy').to('s')` | answers |
| schema | `g.call('schema')` | answers: labels, keys and types |
| path between memories | `V().has(…,'m1').shortestPath().with('target', __.has('memory','mid','m3'))` | answers |

### 4.2 Scoring

| Query shape | Result |
|---|---|
| `as('a').as('b').math('a * 0.5 + b * 0.1').by('salience').by('hits')` | answers |
| `project('s','h').by('salience').by('hits').math('s * 0.5 + h * 0.1')` | answers |
| `project('mid','score').by('mid').by(__.values('lastSeen').dateDiff(datetime(…)).math('exp(_ / 86400000 / 30)')).order().by(select('score'),desc)` | answers (recency decay) |
| `withSack(0.0d).V()….sack(sum).by('salience').sack(sum).by('hits').order().by(sack(),desc)` | answers |
| `math('s * 0.5 + h * 0.1').by('salience').by('hits')` with `s`, `h` not bound as labels | declines; the query is not valid Gremlin (math variables name labels) |

### 4.3 Gaps the probes found

| Query shape | Result | Tracking |
|---|---|---|
| JSON body `bindings: {"p": {"search":"kyoto"}}`, `g.call('tinker.search', p)` | fails: "requires a non-empty string `search` param" | **untracked** |
| JSON body `bindings: {"m": {"name":"tea"}}`, `g.mergeV(m)` | declines | **untracked** |
| Same two queries in-process with a `Map` parameter | answer | — |
| `['search': term]` (a parameter inside a map literal) | parse error; the grammar does not allow it | grammar (locked decision 2) |
| `g.inject(rows).unfold().mergeV()` | declines | `R8-res` |
| `g.inject('t1','t2').as('t').addV('memory').property('text', __.select('t'))` | declines | `inject-label-addV` |
| `g.inject(rows).unfold().as('r').addV(…).property('text', __.select('r').select('text'))` | declines | `inject-unfold-nested` |
| `V()….sideEffect(__.property('hits',5))` | declines with a clear message | `s3-write-in-child` |
| `fold().coalesce(__.unfold(), __.addV(…))` (classic upsert) | declines, message says "use mergeV()/mergeE()" | Won't do in this form; `mergeV` answers |
| `tinker.search` with a 2-character term | declines with a clear message | by design (`search.ts:55`) |
| `tinker.search` with `regex` | declines with a clear message | matrix §17 "Services and federation" |
| JSON-negotiated response to a failed query | HTTP 200 with a GraphBinary body and a status 500 trailer, not JSON. `errorResponse` ignores `Accept` (`src/http.ts:49-53`). HTTP 200 is by design (`.claude/rules/wire-protocol.md`); the binary body for a JSON client is **untracked**. | **untracked** |
| A `datetime` parameter (a JS `Date`, typed `datetime`) in `property(k, ts)`, `has(k, lt(ts))`, `inject(ts)` or a `mergeV` map | declines (in-process `compile()`; not tested through a GLV). The same values as `datetime('…')` literals answer. No L3 scenario sends a datetime parameter. | **untracked** |
| `dateDiff(ts)` or `dateDiff(__.constant(ts))` with a parameter | parse error; the grammar takes a date literal or a traversal (`Gremlin.g4` `traversalMethod_dateDiff`) | grammar (locked decision 2) |

### 4.4 Vector-style queries

| Query shape | Result | Tracking |
|---|---|---|
| Store a list-valued property `property('emb',[0.1d,0.2d,0.3d])` and read it | answers | — |
| `values('emb').sum(local)` | answers | — |
| `values('emb').unfold()` at top level or in a child | declines | `per-row-node-vocabulary-closed` |
| `values('emb').index()` | declines | `index()` row in matrix §9 |

A dot product of two lists needs either `index()` or a list-zip step. Neither exists. So brute-force
cosine cannot be written in Gremlin today. A service that computes cosine in SQL is the remaining route
(plan item 6).

### 4.5 Timings at 5,000 memories

**Measured on Bun, in-process, `:memory:` SQLite, one run.** Each memory is one vertex with four
properties and two `mentions` edges to 20 entities. Each query time is the mean of 20 runs after one
warm-up. These numbers include compile time (no plan cache was configured by the probe).

| Operation | Mean time |
|---|---|
| Write one memory (1 vertex, 2 edges, one request) | 5.30 ms |
| `tinker.search` rare term → `element()` | 0.86 ms |
| `TextP.containing` rare term | 1.81 ms |
| `tinker.search` common term → order by salience → top 10 | 3.30 ms |
| `tinker.search` → 2-hop expand → dedup → order → top 10 | 3.21 ms |
| 2-hop related memories from one memory | 3.66 ms |
| Entity mention counts, top 5 | 3.72 ms |
| Weighted score with `math()` over 3 memories | 3.37 ms |
| Reinforce one memory | 6.30 ms |

These numbers say only that the operations are not pathological at 5,000 memories. They are not a
benchmark. They do not say anything about a Durable Object.

## 5. How full-text search and traversal combine (Explanation)

The `property_fts` table holds one row per property value (`src/storage.ts:63-65`). The tokenizer is
`trigram`, so the index answers a `LIKE '%term%'` probe for a term of 3 or more characters. The write
path maintains the index; there are no triggers (`src/services/CLAUDE.md`).

`g.call('tinker.search', [search: t])` is a start service. It contributes a relation of matching
properties at the head of the chain (`src/services/CLAUDE.md` "`call()` is the extensibility seam").
`.element()` walks each property to its owner. After that the stream is an ordinary vertex stream, so
every later step (`out`, `order().by`, `dedup`, `project`) lowers into the same SQL statement. The
intermediate rows never leave SQLite.

`has(k, TextP.containing(t))` reaches the same index by a different route. A physical rewrite
(`trigramSeek` in `src/rel/passes/semijoin.ts`) replaces the scan with an index probe and keeps the exact
`instr` test beside it. So `TextP` is case-sensitive and exact, while `tinker.search` is
case-insensitive (`docs/limitations.md` §3 "Text").

Neither route returns a relevance score. A substring match is a filter, not a ranking. Ranking today
comes from graph facts (salience, recency, mention counts), not from text similarity.

## 6. The smallest convincing reference application (Explanation and Reference)

### 6.1 Shape (Explanation)

The application is a Cloudflare Worker with five HTTP endpoints. It authenticates the caller and maps
the caller to one agent graph. It calls that graph's Durable Object over RPC with
`env.GRAPH.getByName(agentId).json(gremlin, params)` (`src/cloudflare/graph-store-do.ts:99`). RPC carries
a `Map` parameter, so it avoids the JSON map-binding gap. The mogwai HTTP routes stay private.

The application owns no storage and no query engine. Each endpoint is one Gremlin string with
parameters. The demonstration is that the whole memory model is five queries, and that each agent's
memory is a separate SQLite database that costs nothing when idle.

The client language is TypeScript for the Worker. An end user can call the five endpoints from any
language with plain HTTP and JSON, because the Worker builds the `Map` parameters itself.

A cross-script Durable Object binding (`script_name` in `wrangler.jsonc`) is a Cloudflare platform
feature. **It is not tested in this repository.** Plan item 3 tests it.

### 6.2 Graph schema (Reference)

| Element | Label | Properties | Notes |
|---|---|---|---|
| vertex | `memory` | `mid` (string), `text` (string), `kind` (`fact`/`episode`/`preference`), `createdAt`, `lastSeen` (datetime), `salience` (double), `hits` (double) | `hits` is a double because `math()` returns a double |
| vertex | `entity` | `name` (string), `kind` (string) | upserted with `mergeV` |
| vertex | `session` | `sid` (string), `startedAt` (datetime) | groups episodes |
| vertex | `summary` | `text` (string), `createdAt` (datetime) | written by the summarise operation |
| edge | `mentions` | — | `memory` → `entity` |
| edge | `recorded` | — | `session` → `memory` |
| edge | `supersedes` | — | new `memory` → old `memory` |
| edge | `summarizedBy` | — | `memory` → `summary` |

Typed edge labels stay real edge labels. This is the vision's point against a generic `RELATED_TO`
edge (`docs/2026-07-17-agent-memory-vision.md`, "Keep typed relationships typed").

### 6.3 Key queries (Reference)

Every query below answered in a probe, in the form shown or in an equivalent form with literals.
Parameters are in `$name` form here for clarity; the Gremlin text uses the bare name.

| Endpoint | Gremlin |
|---|---|
| `remember` | `g.addV('memory').property('mid',$mid).property('text',$text).property('kind',$kind).property('createdAt',datetime('<now>')).property('lastSeen',datetime('<now>')).property('salience',$s).property('hits',0.0d)` |
| `remember` (entities) | `g.mergeV($entity)` once per entity, then `g.V().has('memory','mid',$mid).addE('mentions').to(__.V().has('entity','name',$name))` |
| `recall` | `g.call('tinker.search',$q).element().hasLabel('memory').not(__.in('supersedes')).project('mid','text','score').by('mid').by('text').by(__.values('lastSeen').dateDiff(datetime('<now>')).math('exp(_ / 2592000000)')).order().by(select('score'),desc).limit($k)` |
| `recall` (expand) | `g.call('tinker.search',$q).element().hasLabel('memory').out('mentions').in('mentions').dedup().order().by('salience',desc).limit($k)` |
| `associate` | `g.V().has('memory','mid',$a).as('m').V().has('entity','name',$e).as('e').mergeE($edge).option(Merge.outV,__.select('m')).option(Merge.inV,__.select('e'))` |
| `forget` | `g.V().hasLabel('memory').has('salience',lt($min)).has('lastSeen',lt(datetime('<cutoff>'))).drop()`, then `g.V().hasLabel('entity').not(__.in('mentions')).drop()` |
| `summarise` | `g.V().hasLabel('entity').project('entity','mentions').by('name').by(__.in('mentions').count()).order().by(select('mentions'),desc).limit($k)` |

`<now>` and `<cutoff>` are not parameters, because a `datetime` parameter declines (section 4.3).
The application writes them as `datetime('<ISO-8601>')` literals from `Date.toISOString()`. A literal is a
constant, so this follows the bind rule in `CLAUDE.md`.

The `recall` row with `project(…).by(…dateDiff…)` is a composition of two probed forms (`decay-score`
and `fts-order`). **It was not run as one query.** Plan item 2 runs it.

### 6.4 What makes it convincing (Explanation)

| Claim | Evidence the application would show |
|---|---|
| Isolation per agent costs nothing | Each agent id maps to its own DO and SQLite file. No tenant column exists in any query. |
| One round trip per operation | Search, traversal, ranking and limit run in one SQL statement inside the DO. |
| Memory is portable | `g.io(…).write()` exports a lossless GraphSON file to R2; `read()` restores it. |
| Memory is inspectable | `g.call('schema')` lists every label, key and type. |
| Graph algorithms apply | `pageRank`, `nodeSimilarity` and `shortestPath` run over the same memory graph. |

## 7. Run the memory queries against a local server (How-to)

This procedure works today on Bun. It uses JSON over HTTP, so it uses literal maps instead of map
parameters (section 4.3).

1. Start the server: `bun run src/bun/server.ts --port 8182`.
2. Send a write with scalar bindings:

   ```sh
   curl -s localhost:8182/gremlin/agent-alice -H 'Content-Type: application/json' -H 'Accept: application/json' \
     -d '{"gremlin":"g.addV(\"memory\").property(\"mid\",mid).property(\"text\",text).property(\"salience\",0.7d)","bindings":{"mid":"m1","text":"Alice prefers green tea"}}'
   ```

3. Upsert an entity with a literal map: `g.mergeV([(T.label):'entity','name':'tea'])`.
4. Link them: `g.V().has('memory','mid','m1').addE('mentions').to(__.V().has('entity','name','tea'))`.
5. Recall with a literal search map: `g.call('tinker.search',['search':'tea']).element().values('text')`.
6. Read the schema: `g.call('schema')`.
7. Delete the agent's graph: `curl -X DELETE localhost:8182/gremlin/agent-alice`.

Use a GraphBinary client (the `gremlin` package) if you need map parameters.

## 8. Verdict on the reviewer's concern (Explanation)

The concern is valid. Nothing in the repository shows an adopter why to choose mogwai-db.

The code answers part of the concern. The engine already holds every primitive the minimal application
needs, and the probes show that the five memory operations answer. So the missing work is mostly
packaging, plus five specific gaps: authentication, JSON map parameters, `datetime` parameters, batch
ingestion and a similarity term. Only the first three block a convincing demonstration. Batch ingestion and similarity
improve it.

## Glossary

| Term | Meaning here |
|---|---|
| agent graph | One graph that holds one agent's memory; one Durable Object on Cloudflare. |
| DO | Cloudflare Durable Object: a single-threaded object with its own SQLite database. |
| decline | A clear `UnsupportedTraversal` error. The query does not run. |
| FTS5 trigram | SQLite full-text index that splits text into 3-character tokens. It answers substring probes. |
| Map parameter | A query parameter whose value is a key-value map, sent as a GValue binding. |
| probe | A throwaway script that ran queries for this report. Not committed. |
| recall | Read memories that match a query, ranked. |
| salience | A number from 0 to 1 that says how important a memory is. |
| RPC | A Durable Object method call from a Worker, without HTTP. |
