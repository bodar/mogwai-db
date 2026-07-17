# mogwai as agent memory — exploratory vision

**Date:** 2026-07-17 · **Status:** exploratory research, not a committed plan · **Author:** Dan + Claude

This is a scoping/vision piece, not a design lock. It studies three prior-art systems,
extracts what to borrow and what to beat, and proposes a shape for **mogwai-as-agent-memory**
that leans into mogwai's structural strengths (a graph engine that lives *inside* a Durable
Object) and Cloudflare's **Code Mode** thesis. Concrete forks are flagged with a recommendation,
not resolved.

---

## TL;DR — the thesis

> **The most efficient agent-memory API is not an API. It's a query language plus a code sandbox,
> running next to the data.**

- **neo4j-labs/agent-memory** is a good memory *model* (short-term / long-term / **reasoning
  traces**) shipped as **~16–20 MCP tools** over a standing Neo4j cluster. Its "hybrid vector+graph"
  retrieval is oversold (vector-KNN + threshold, then *optional* post-hoc traversal; no fusion,
  **no recency/decay/salience**).
- The **official Apache `gremlin-mcp`** is a thin, honest bridge: one raw-Gremlin-string tool + a
  sampled schema tool + offline `translate`/`format`. Weak: no bound params, sampled+`typeof`
  schema, no pagination, errors-masquerade-as-success. It's mid-migration to **HTTP + canonical
  Gremlin string** — *the exact wire mogwai already committed to*.
- **Cloudflare Code Mode** collapses "2,500 endpoints / 1.17M tokens" into **one `codemode({code})`
  tool + ~1,000 tokens** by turning the tool surface into a *typed API the model writes code
  against*, run in a Worker Loader isolate. Intermediate results never cross the model boundary —
  only the final answer does.

mogwai is uniquely positioned to fuse all three: it **is** a chainable, compile-to-SQL graph query
language that already lives inside a per-agent DO. Gremlin *is* the "code" in Code Mode. So instead
of neo4j's 20-tool surface, mogwai-memory is **one Gremlin endpoint + (on Cloudflare) one Code Mode
sandbox** — with the tri-partite memory model reduced to a documented graph schema and a library of
query recipes, not a tool bag.

---

## What each input teaches

### 1. Official Apache `gremlin-mcp` (TinkerPop 4) — the honest baseline

6 tools total. Online (need an endpoint): `get_graph_status` (live `g.inject(1)`),
`get_graph_schema` (sampled), `run_gremlin_query({query})`, `refresh_schema_cache`. Offline
(always on, driver-free): **`translate_gremlin_query`** (Gremlin between language variants —
js/python/go/dotnet/java/groovy/canonical/anonymized — via `GremlinTranslator`, with an optional
**MCP-sampling** step that offloads dialect normalization to the *host client's* LLM, no API key)
and **`format_gremlin_query`** (gremlint pretty-print).

**Borrow:** `translate` + `format` are cheap, portable wins mogwai can ship (it already carries
`GremlinTranslator`-capable client code). The **MCP-sampling pattern** — server delegates a fuzzy
subtask to the client's model, provider-neutral, graceful fallback — is reusable for *extraction*
too.

**Beat:** no bound params (`submit(query, null)` → literal inlining, no type-truth channel); schema
is *sampled* (100 elems/50 values) and typed by JS `typeof` (`string`/`number`/`unknown`); no result
pagination; errors return as `{results:[], message:"Query failed: …"}` success frames. mogwai already
threads GraphBinary DataTypes as its type-truth channel, owns an **exact catalog** (interned labels +
`vtype` per property), and already does **chunked GraphBinary streaming**. mogwai can out-introspect
this reference with *exact, typed, real* schema + enums instead of sampled guesses.

### 2. neo4j-labs/agent-memory — the model to borrow, the retrieval to beat

**Tri-partite model** (borrow this wholesale):
- **Short-term:** `Conversation`→`Message` linked list (`NEXT_MESSAGE`), vector-searchable.
- **Long-term:** entity KG on the **POLE+O** ontology (Person/Object/Location/Event/Org), entity
  resolution + tiered dedup (`SAME_AS`), `Fact` S-P-O triples with `valid_from/valid_until`,
  `Preference` with `SUPERSEDED_BY`.
- **Reasoning:** `ReasoningTrace`→`ReasoningStep`→`ToolCall`, `:TOUCHED` provenance edges, `Tool`
  call-stats. **This tier is the genuinely differentiated idea** — case-based reasoning over the
  agent's *own* history (thought→action→observation), and it's *pure graph* (no vectors needed for
  the structure). Borrow it.

**The gaps that are mogwai's opening:**
- **"Hybrid" is marketing.** Per-tier vector-KNN + `score >= threshold` + `ORDER BY score`, then
  graph traversal as a *second, post-hoc* step. **No full-text/BM25, no score fusion/RRF, no
  cross-tier re-rank.** No embedder configured → most retrieval returns `[]`.
- **No recency / decay / salience / importance anywhere in ranking.** No forgetting curve, no
  usage reinforcement. A 2-year-old memory and a 2-minute-old one compete on pure cosine.
- **Temporal = property-level only** (`valid_from/until`); not bitemporal, no as-of queries.
- **Declared POLE+O typed relations collapse to generic `RELATED_TO`** at write time (type demoted
  to a property) → loses native typed-relationship traversal/indexing.
- Heavy substrate: standing Neo4j 5.11+ cluster, native vector indexes, APOC dependency;
  multi-tenancy bolted on via `User{identifier}` nodes; extraction-path entities skip dedup+embedding.

### 3. Cloudflare Code Mode — the efficiency reframe

Not "expose N tools." Expose **one** `codemode({code})` tool; the model writes a JS/TS async fn; it
runs in a **Dynamic Worker Loader** V8 isolate (no fs, no env, no net by default). MCP tools become
**typed globals** (`declare const github: {...}`) generated from connector schemas — the model reads
*TypeScript signatures*, not JSON tool specs. `search()`/`describe()` discover the API lazily. Result:
the entire Cloudflare API in **~1,000 tokens** vs **1.17M** as flat tools.

The deep win isn't just surface size — it's **chaining**: with flat tools, each call's output must
round-trip *through the model's neural net* just to be copied into the next call's input. In Code
Mode the intermediate stays in the sandbox; only the final result crosses back. Connector calls cross
the sandbox via RPC, and the runtime can **intercept/pause for approval and durably replay** (SQLite
in a DO) — a natural gate for *memory writes*.

---

## Why mogwai is a structurally excellent fit for memory

| Memory need | Neo4j-labs answer | mogwai answer |
|---|---|---|
| **Multi-tenant isolation** (one memory per agent/user) | `User{identifier}` nodes threaded through every query | **Free.** One DO per graph via `idFromName` — already a flat namespace, already isolated. |
| **Provisioning** | Standing cluster; create schema | **Create-on-first-access** is already the whole story (decision #6). |
| **Idle cost** | Always-on cluster | **Scale-to-zero.** Idle graph = idle DO = ~$0. An abandoned memory stays GC-eligible. |
| **Schema/enums for the model** | Sampled + `typeof` | **Exact + typed.** Catalog-backed labels, canonical `vtype`, true enum sets from `vp_key_value`. |
| **Large result → context blowup** | Full `toArray()`, no pagination | **Chunked GraphBinary streaming** + `resultIterationBatchSize` already built. |
| **Query cost** | Cypher over bolt, app-side assembly | **Compile-to-SQL**, colocated with storage, no row-at-a-time. |
| **Wire** | bolt | **HTTP + canonical Gremlin string** — where the official MCP is migrating *to*. |
| **Edge locality** | Regional cluster | Memory lives geographically near the agent. |

The one thing mogwai lacks: **vector search**. That's the central architectural fork (below).

---

## Proposed shape — "the API is a query language"

Two layers. Layer A is portable (Bun + CF) and is 90% of the value. Layer B is the Cloudflare-only
Code Mode play that beats neo4j's oversold hybrid.

### Layer A — the native Gremlin memory endpoint (both runtimes)

Almost no new tool surface. The memory *model* is a documented graph schema + recipe library; the
"API" is Gremlin itself.

- **`gremlin(query, params)`** — the one data-plane tool. The agent writes a traversal; it compiles
  to SQL and runs *in the DO*; only the final result is framed back. A single `g.V(...).out()...
  .order().by(...).limit(k)` already does what Code Mode's chaining does — intermediate traversers
  never leave the DO. **With bound params + type-truth** (mogwai's existing GraphBinary DataType
  channel), fixing gremlin-mcp's #1 gap.
- **`schema` / `describe`** — *exact, typed, enum-discovered* schema from the catalog (beats the
  sampled reference). Enum discovery = one `values(k).dedup()` per low-cardinality key over
  `vp_key_value`, returning *real* enums not sampled ones.
- **`translate` / `format`** — borrowed offline utilities (mogwai already ships the client code).
- Errors ride the GraphBinary status trailer (mogwai already does this) — no errors-as-success.

This alone is a **better** gremlin-mcp: typed params, exact schema, streaming, honest errors,
per-agent isolation, scale-to-zero.

### Layer B — Code Mode over the memory substrate (Cloudflare only)

For multi-step memory ops that fuse services — the retrieval neo4j only *claims* to do — expose one
`codemode({code})` tool running TS in a Worker Loader isolate with typed bindings to:

- `graph.query(gremlin, params)` → the mogwai DO (RPC into the same `query` seam).
- `vectors.query(embedding, opts)` → **Cloudflare Vectorize** (the "vertex store" — see fork).
- `ai.embed(text)` / `ai.extract(text)` → **Workers AI** (embedding + entity/relation extraction).

The agent (or a curated recipe) writes *one* function:

```ts
// Fused retrieval — the thing neo4j's "hybrid" only pretends to be.
const qv = await ai.embed(query);
const seeds = await vectors.query(qv, { topK: 30 });                 // semantic recall
const expanded = await graph.query(                                  // structural expansion + typed rel traversal
  "g.V(ids).as('s').both().dedup().project('v','score')...", { ids: seeds.map(s => s.id) });
return rank(expanded, { recency, salience, similarity: seeds });     // FUSED score, server-side
```

Embed → KNN → graph-expand → **fused rank (recency + salience + similarity)** → return only the
assembled top-k context. All server-side, one execution, minimal token cross. This is the
efficiency story: (1) tiny tool surface, (2) no intermediate shuttling through the model, (3)
server-side rank+truncate so only final context returns. mogwai wins all three because it's a query
engine, not a tool bag.

**Write gating:** Code Mode's durable interception/replay is a natural approval gate for memory
*writes* (consolidation, dedup merges) — pause, surface to the user/agent, replay on resume.

---

## Retrieval — beating the oversold hybrid

The single biggest product differentiator. neo4j ranks on **pure cosine, thresholded, no recency**.
mogwai can push **decay + salience + usage reinforcement** *into the SQL query plan*:

- **Recency decay:** score includes `exp(-λ·age)` — computable in the compiled ORDER BY from a
  `last_seen` timestamp column.
- **Salience / importance:** a first-class property, reinforced on access (write-back on read).
- **Usage reinforcement:** access-count column, incremented via the same DO round-trip.
- **Fused score:** `w1·similarity + w2·recency + w3·salience` — expressed as `order().by(...)` and
  compiled to a SQL scoring expression, rather than neo4j's app-side post-hoc sort.

Caveat / dependency: this needs sack/math-in-`by()` support — **check the feature-support matrix**;
some of this is future compiler work. It's also the reason retrieval-as-code (Layer B) is attractive
short-term: do the fused rank in TS in the sandbox now, push it into the SQL plan later as the
compiler grows. Either way, *mogwai owns the ranking*, which neo4j structurally does not.

---

## The memory model (borrow + adapt)

Reduce neo4j's model to a mogwai graph schema (documented, not 20 tools). Verbatim borrow of the
**tri-partite split + reasoning traces**. Adaptations:

- **Keep typed relationships typed.** Don't repeat neo4j's `RELATED_TO`-collapse. Edge labels are
  interned + indexed in mogwai — `EMPLOYED_BY`/`LOCATED_AT`/`OWNS` stay real edge labels with
  native `out('EMPLOYED_BY')` traversal. This is a direct structural win.
- **Reasoning tier is pure graph** — no vectors required for the trace structure; vectors only for
  "find similar past task" seeding.
- **Temporal:** start with property-level `valid_from/until` (parity), but mogwai's exact typed
  values make real as-of / bitemporal queries more tractable later.
- **Hygiene** (dedup / consolidation / decay / supersession) = scheduled Gremlin write recipes,
  gated via Code Mode's approval/replay.

### Ingestion (text → graph)

Two provider-neutral options, no standing infra:
- **Workers AI** LLM for entity/relation/preference extraction (structured output).
- **MCP-sampling** (borrowed from the official translate tool): the memory server asks the *host
  client's* model to extract — zero inference cost, no API key, degrades gracefully. Elegant for a
  serverless memory that doesn't want to own an inference budget.

---

## Runtime parity (Bun ⇄ Cloudflare)

Dan's instinct is right: Layer B (Worker Loader) is **Cloudflare-only**, and that's fine — CF is the
production target. Clean parity story:

- **The memory model + ranking SQL + Layer A endpoint are 100% portable** (shared graph engine).
- On **Cloudflare**: additionally expose raw `codemode` + Vectorize + Workers AI bindings.
- On **Bun**: expose the *curated recipe tools* (the same embed→KNN→expand→rank pipeline, run as
  native server code instead of agent-authored sandbox code). Vector search on Bun = a local
  fallback (sqlite-vec if loadable, or a bundled ANN), OR Dan's "route to a CF instance with a
  credential" callback. The *model* never diverges; only the *arbitrary-code sandbox* is CF-only.

So: "we always want feature parity" holds for the memory semantics; the Code Mode sandbox is a
CF-only *performance/ergonomics* superpower, not a semantic fork.

---

## Where this beats neo4j-labs/agent-memory (summary)

1. **Tool surface:** 1 query tool + 1 code tool vs ~20 MCP tools (Code Mode thesis).
2. **Multi-tenancy + scale-to-zero:** free from DO-per-graph vs a standing cluster + `User` nodes.
3. **Ranking:** fused recency/salience/similarity vs pure-cosine-no-decay.
4. **Typed relationships preserved** vs `RELATED_TO` collapse.
5. **Exact typed schema/enums** vs sampled + `typeof`.
6. **Serverless ingestion** (Workers AI / MCP-sampling) vs a configured embedder/extractor stack.
7. **Edge-local, per-agent, ~$0 idle** vs regional always-on Neo4j.

Honest debts we'd owe: **vector search** (mogwai has none — the fork below), a mature **extraction**
pipeline, and the **ranking-in-SQL** compiler work (matrix-dependent).

---

## Open forks (recommendation, not resolved)

1. **Where do vectors live?**
   - (a) **Cloudflare Vectorize sidecar** — Dan's "vertex store" instinct. Realistic: DO SQLite
     almost certainly can't load `sqlite-vec` (no extension loading). Fused via Layer B.
     **← recommended for CF.**
   - (b) **In-DO vectors** — would need a pure-SQL ANN or brute-force cosine over a JSONB/blob
     column (fine for small per-agent memories — thousands of vectors, not millions — which is
     exactly the agent-memory regime!). Worth a spike: brute-force cosine in SQL over a per-agent
     DO may be *entirely sufficient* and keeps everything in one store. This is the
     upstream-disposition-friendly, no-sidecar option and could be the real unlock.
   - **Recommendation:** spike (b) first (brute-force cosine in a DO for realistic memory sizes); it
     may kill the need for a sidecar and keep the "one store, one query language" story pure. Fall
     back to (a) Vectorize for large corpora.

2. **Where does the memory layer live?** A generic graph engine (mogwai-db) vs an opinionated memory
   product. **Recommendation:** sibling repo `mogwai-memory` (schema + recipes + MCP/Code-Mode
   server) depending on mogwai-db as the engine. Keeps mogwai a clean TinkerPop-4 graph; memory is a
   layer, not a fork. mogwai-db gains only small, generally-useful primitives (e.g. ranking-in-`by()`).

3. **Ranking-in-SQL now or code-mode-now-SQL-later?** **Recommendation:** fused rank in Layer B TS
   first (ships immediately, matrix-independent); migrate the hot path into the compiled SQL plan as
   sack/math-`by()` lands. Documented fallback, clean cutover point.

---

## Rough phasing (if pursued)

- **Phase 0 — spike:** brute-force cosine over a per-agent DO (fork #1b); measure at realistic memory
  sizes. Decides the vector story.
- **Phase 1 — Layer A:** `gremlin`/`schema`/`describe`/`translate`/`format` MCP server over mogwai
  (typed params, exact schema, honest errors). Already a better gremlin-mcp.
- **Phase 2 — memory model:** tri-partite + reasoning-trace schema + write/retrieval recipes; typed
  relationships kept real.
- **Phase 3 — Code Mode (CF):** `codemode` + Vectorize/Workers AI bindings; fused retrieval; write
  gating via replay/approval.
- **Phase 4 — ranking-in-SQL:** decay/salience/reinforcement pushed into the compiled plan; the
  differentiator neo4j structurally can't match.

---

## Competitive landscape & economics (mid-2026)

### The gap (independently found, maps onto mogwai's strengths)

> No incumbent combines **(a) true scale-to-zero / zero idle cost, (b) per-tenant *physical*
> isolation, and (c) graph + temporal reasoning depth.** Today those axes are *anti-correlated*:
> KG-depth players need a standing graph DB; serverless players skimp on graph/temporal or paywall it.

DO-per-graph sits in that empty corner: physical isolation AND free-when-idle AND graph-native.
Nobody occupies it. Caveat: it's a crowded, fast-moving market (15+ players; giants pivoting in —
Pinecone **Nexus**, Weaviate **Engram** GA'd Jun 2026, Redis **Iris**, MongoDB). Architecture-market
fit is strong; the market is GTM-hard.

### Two camps

- **App-layer memory** (Mem0, Zep/Graphiti, Cognee, Supermemory, Hindsight, MemoClaw, Papr, Memobase):
  generous free tiers, then **10–50× raw-CF cost**, metered by memories/tokens/ops.
- **Infra-layer** (Pinecone, Weaviate, Neo4j Aura): **fixed monthly floors** ($45 / $45 / $66)
  disconnected from usage; Neo4j = standing hourly cluster billing.

Isolation patterns: **shared-table+tenant-key** (weak/cheap — Mem0/Zep/Supermemory) ·
**dedicated-DB-per-workspace** (strong/expensive/hourly — Neo4j NAMS) · **unsolved** (Letta self-host).
**DO-per-agent is a fourth point: physically isolated yet individually free when idle.**

### Head-to-head

| vs | Their weakness | mogwai line |
|---|---|---|
| **Neo4j NAMS** (model twin: tri-partite + reasoning traces) | Standing Aura ~$66/mo floor, per-workspace dedicated DB, idle costs | Same model, free-when-idle, physical isolation, ~100× cheaper small-scale. **Direct beat.** |
| **Zep/Graphiti** (deepest bitemporal KG) | Killed self-host (CE dep. Apr 2025); $125/mo floor | Serverless *and* trivially self-hostable (single Bun artifact) — unoccupied combo. Must build temporal depth. |
| **Mem0** | Graph paywalled at $249/mo Pro; shared-table tenancy | Graph-native every tier; physical isolation. |
| **Hindsight / MemoClaw** (cheap/serverless/single-store — closest in spirit) | Hindsight=one Postgres (no phys. isolation); MemoClaw=no graph depth | Graph query language + Code Mode + physical isolation + edge locality. |
| **Weaviate Engram** (most direct threat: GA, instant, per-project/user isolation primitive) | Shared tenancy, $45/mo floor, pipeline-run metered | Physical isolation, no floor, one-fn fused retrieval. |

### Economics — price on value, not cost

Modeled agent (10k memories, 1k retrievals/mo) sits **inside CF free-tier on every meter**. Only real
cost = fixed platform fee: **$5/mo** (Workers Paid, single-tenant) or **$25/mo** (Workers for Platforms)
÷ N tenants → **~$0.02–0.03/tenant/mo** at scale. Competitor floors ($45–66/mo) are 100–1000× actual
usage cost at small scale.

**→ A 30% markup on CF resources underprices the market.** Play: **cost like CF, price like the
app-layer** (per-memory/per-op). That's where **90%+ gross margin** lives *while still undercutting
every floor-priced incumbent 100×*. Undercut AND keep margin — both are available here.

### Platform notes — two-tier isolation (the product shape)

The tenancy model is **two tiers**, isolating two different things:

| Tier | Isolated | Mechanism |
|---|---|---|
| **Customer** (signup → "whole suite") | code + limits + observability | **WfP user Worker** in the dispatch namespace — untrusted mode, isolated cache, per-customer limits/tags, can run custom code |
| **Agent** (unlimited per suite) | data (agent↔agent) | its own SQLite DB — a DO, or a **facet** |

- **Workers for Platforms** ($25/mo base, **1,000 user Workers incl., +$0.02 each** after) = the
  per-**customer** isolation boundary — each signup gets their own isolated deployment (the "suite"),
  not a row in a shared table. This is isolation-as-a-product-feature + a home for per-customer custom
  code. (Earlier draft said "WfP not needed" — wrong: it's not for data isolation, it's the customer
  suite + custom-code story.)
- **Durable Object facets** = the per-**agent** primitive. A supervisor DO = one customer's suite;
  each agent = a facet (child DO) with its **own isolated SQLite** ("any number of facets… each its
  own SQLite database"; "the application cannot read [the parent]'s database, only its own"). Unlimited
  agents, colocated cheaply under one customer envelope, free-when-idle. **Open beta / Workers Paid** —
  verify before betting on it; plain-DO-per-agent is the today-fallback.
  Ref: blog.cloudflare.com/durable-object-facets-dynamic-workers.
- **Security point:** do NOT give an untrusted customer Worker a raw account-level DO namespace binding
  (it could `idFromName` another customer's DO). The supervisor/facet pattern enforces isolation via the
  execution boundary — customer code runs as a facet child that only sees its own storage. (Per-Worker
  unique-resource isolation is turnkey for D1/KV in WfP but **not** documented for DOs → facets are how
  you isolate graph storage.)
- **Cost:** ~**$0.02 marginal per customer** for a genuinely isolated deployment + unlimited near-free
  agents. 10k customers ≈ $205/mo. Bang-for-buck holds.
- **Composes with Code Mode Layer B:** the per-customer user Worker is the natural home for that
  customer's Code Mode sandbox — their agents run custom retrieval/extraction TS in their own
  untrusted-mode Worker against their own facet DBs.
- **Vectorize isolation is logical** (namespace filter), capped **50k namespaces/index, 50k
  indexes/account, topK≤50 w/ metadata** — a *second, weaker* isolation model beside the DO's, and it
  does NOT compose with the facet-per-agent model (vectors would live outside the agent's isolated DB).
  This is the clincher for **in-DO(/in-facet) vectors** (the cosine spike): isolation stays
  uniform/physical/uncapped, one store per agent, one bill. Vectorize only for corpora overflowing a DO.

### Honest risks

1. **GTM-hard, not tech-hard.** The moat (CF-native scale-to-zero + isolation) is real but copyable by
   anyone building on DO. Durable edge = first-mover + Code-Mode/Gremlin ergonomics, not substrate alone.
2. **Engine exists; the memory *product* doesn't.** Owe: vector search, extraction, decay/salience
   ranking, hygiene/consolidation, temporal depth.
3. **Temporal-depth bar is high** (Zep bitemporal intervals) — tractable on the typed-value substrate,
   unbuilt.

**Net verdict:** pursue it. "Instant isolated MCP endpoint on signup, graph-native, ~$0 idle" is a story
none of the 15 can fully tell. Win condition = build the product layer + value-price + move before
Engram/Nexus close the gap.

## Sources

- Official Apache `gremlin-mcp`: `~/Projects/tinkerpop/gremlin-js/gremlin-mcp` (beta.2 + master diff).
- Competitor landscape + pricing (mid-2026): Mem0, Zep/Graphiti, Letta, Cognee, Supermemory, LangMem,
  Pinecone/Nexus, Weaviate/Engram, Chroma, Neo4j Aura/NAMS, Papr, Memobase, Hindsight, MemoClaw, Redis
  Iris, MongoDB Atlas — vendor pricing pages + docs (see conversation research for per-vendor URLs).
- Cloudflare pricing: Durable Objects, Vectorize, Workers, Workers for Platforms, Workers AI
  (developers.cloudflare.com/*/platform/pricing).
- `kpritam/gremlin-mcp`: `~/Projects/gremlin-mcp` (community TinkerPop-3 server; enum-discovery idea).
- `neo4j-labs/agent-memory`: `~/Projects/agent-memory` (tri-partite model, reasoning traces).
- Cloudflare Code Mode: blog.cloudflare.com/code-mode-mcp, developers.cloudflare.com/agents/tools/codemode.
