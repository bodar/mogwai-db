# Cross-DO federation — prior art + feasibility (research note)

**Status: research only when written. Now planned** — the `call("federate", …)` sketch
here became Phase 6 of
[2026-07-20-call-service-registry-plan.md](./archive/2026-07-20-call-service-registry-plan.md);
see the **2026-07-21 addendum** at the foot for the concrete mechanic + an `ATTACH`
correction. Originally captured the answer to
"is there prior art for distributed/heterogeneous joins in graph query land, and
could mogwai's one-DO-per-tenant isolation support a lazyrecords-style
push-down + project + client-side-join?"

Origin: lazyrecords (Dan's Java lib) could join across heterogeneous data sources
by projecting the query down onto each side of the join, executing per-source, then
merging on the client. Question: does that pattern have an analog in TinkerPop /
graph query languages, and does mogwai's topology admit it.

## TL;DR

- Prior art is **rich** — but **not in Gremlin/TinkerPop**. It lives in RDF
  (SPARQL federation), relational federation (Calcite, Trino, Postgres FDW), and
  one proprietary graph engine (Neo4j Fabric).
- The lazyrecords shape (push down, project, join client-side) is **exactly** the
  shape that works. It's only ever viable at the point where traversal **degrades
  to values** — because property-graph traversal is pointer-chasing over
  graph-local identity, and identity does not cross a store boundary.
- mogwai is unusually well-positioned to prototype it (SQLite compile target on
  *both* sides), and the genuine finding is an **open-standard gap**: property
  graphs never got SPARQL's `SERVICE`.

## Prior art map

| System | Domain | Mechanic | Relevance |
|---|---|---|---|
| **SPARQL 1.1 `SERVICE`** | RDF | Ship sub-query to remote endpoint, get bindings, join locally. FedX/SPLENDID/ANAPSID/Comunica add source-selection, join-ordering, **bind-join**. | Canonical analog. Standardized ~15y ago. |
| **Apache Calcite** | Relational | Planner pushes down what each source can do; executes residual join/agg itself. | lazyrecords as a library. |
| **Trino/Presto, Postgres FDW, Spark DSv2** | Relational | Connectors push projections/filters/some joins down; engine does the distributed join. | Production federation. |
| **Neo4j Fabric** | Property graph | Cypher `USE <db>` routes sub-queries to shards/named graphs; coordinator combines. | Strongest graph-native analog. **Proprietary.** |
| **Apollo GraphQL Federation** | API composition | Gateway decomposes query per subgraph, stitches on entity `@key`. | Different "graph", same decompose+join mechanic. |
| **Steampipe / osquery** | Ops data | External sources as virtual tables; SQLite/Postgres FDW joins. | Precedent for the coordinator idea below. |
| **TinkerPop / Gremlin** | Property graph | **Nothing.** One `GraphTraversalSource` = one graph. `union()` stays intra-graph. `withRemote()` is transport, not federation. OLAP partitions ONE logical graph — and v4 kept the OLAP *step names* (`pageRank`/`peerPressure`/`connectedComponent`/`shortestPath` parse) but **dropped the `withComputer`/`program` GraphComputer surface**, so OLAP is even less of a federation path in v4 than in 3.x. | The gap. |

## Why Gremlin has no federation — and it's structural, not an oversight

SPARQL and relational federate cleanly because they are **set-oriented over
values** (bindings, tuples): ship a set, join on value equality.

Property-graph traversal is **pointer-chasing over identity** — `out()` follows an
edge by internal reference. Edges are graph-local. In mogwai, rowids are per-DO and
**no edge crosses a DO boundary.** A traversal therefore *cannot* hop A→B the way it
hops inside one graph. `out()` across DOs is a category error, not a missing feature.

Federation is only meaningful where the traversal **degrades to values** — project
to scalars (ids, property values), join on value equality across stores. That is
precisely the lazyrecords insight. The only honest cross-DO query shape:

```
DO-A:  g.V().has('type','user').values('email')      →  value stream
DO-B:  g.V().has('type','order').valueMap('email',…)  →  value stream
coord: inner-join on email
```

Join key = a **property value** present on both sides, NEVER an edge.

## The SQLite-coordinator idea — sound, with precedent

Making the coordinator an intermediate SQLite holding transient results is the right
instinct. Precedent: Steampipe/osquery (sources as virtual tables), and SQLite
**`ATTACH`** — attach N database files, join across them in ONE native query planned
by SQLite. Materialize each DO's projected result as an attached db / temp table →
the join is free.

It is a **fractal of what mogwai already is**:

- DO compiles graph-traversal → SQL over `nodes`/`edges`.
- Coordinator compiles the **cross-graph residual** → SQL over temp tables of
  materialized values.
- The same `q` kernel (`src/q.ts`) could plausibly emit both.
- **Type/collation semantics match for free** — SQLite on both ends. This is the
  exact thing that breaks most federation engines (SPARQL↔SQL coercion, Trino
  connector type maps). mogwai skips it because leaf and coordinator are the same
  machine.

Coordinator flow: decompose → fire parallel subtraversals at each DO (each already
frames GraphBinary result buffers via `execute.ts` behind its `query` RPC) → load projected values into
`:memory:` SQLite temp tables → run residual join → frame back out as GraphBinary.
Coordinator = a Worker or a dedicated coordinator DO.

## The optimization that separates toy from usable

**Bind-join** (SPARQL's term; postgres_fdw's parametrized pushdown). Don't pull all
of A + all of B then join. Pull A, extract join keys, push them into B's
subtraversal as a filter:

```
DO-B:  g.V().has('email', within(<keys from A>))…
```

Cuts transfer by orders of magnitude. mogwai does this **cheaply** — `within()`
already compiles (see the aggregate/within notes in CLAUDE.md). This is the hinge
between a demo and something you'd run.

## Hard parts (shared by every federated engine)

1. **Planning without statistics.** DOs expose no cardinality → join-order and
   probe-side selection are guesswork. Start heuristic (probe the more-selective
   side first), no cost model.
2. **No cross-DO transaction** on Cloudflare. Snapshot skew between sub-queries;
   consistency is best-effort. Fine for analytics, wrong for invariants. (Sibling to
   the per-request-transaction gap already noted for the management API.)
3. **The missing language primitive.** No Gremlin step marks the boundary.
   **`call()`** (`TraversalService` / service-call step) — inject external-service
   results into the stream — is the extension point. Added in 3.x and **confirmed
   live in the v4 grammar** (`Gremlin.g4`: both the spawn `g.call('svc')` and the
   mid-traversal `.call('svc')`, with overloads up to
   `call(string, genericMap, nestedTraversal)`). So a `call("federate", …)` cross-
   graph construct rides an **existing v4 primitive** — no grammar fork (locked #2
   holds). The current `g`-field-selects-named-graph decision is single-graph
   *selection*, not *join* — federation needs a construct above it.

## Upstream angle (the actually-interesting finding)

The real gap: **property graphs never got SPARQL's `SERVICE`.** RDF standardized
federation ~15 years ago; TinkerPop 4 has none; ISO GQL (newly standardized) has
none; Neo4j Fabric is the only graph-native answer and it's closed.

So there is a genuine "define the `SERVICE` of property graphs" opening — a
standardized federation step + a coordinator reference implementation over the
existing wire protocol. Small-diff-unlocks-durable-capability, and mogwai is
unusually well-placed to prototype it: it already has the isolated-source topology
(DOs), the wire protocol, and — critically — a **SQLite compile target on both
sides**, so the coordinator is the same machine as the leaf.

If it were ever built, the honest scope is narrow and specific:

- **relational join on projected scalar keys only** (no cross-graph edge traversal —
  physically impossible with graph-local identity);
- **bind-join pushdown** via `within()`;
- **SQLite-`ATTACH` coordinator** (leaf and coordinator share the `q` kernel);
- **`call()`-step boundary** (no grammar fork);

and the novel contribution would be the **missing open standard**, not the plumbing.

## Deliberately out of scope

- Cross-DO **edge** traversal — category error (see "Why Gremlin has no federation").
- Cross-DO transactions / consistency guarantees.
- Cost-based cross-source planning.
- Anything that would fork the generated grammar (locked decision #2).

---

# Addendum (2026-07-21) — transfer format + bulk import/export, and an `ATTACH` correction

Written while scoping **Phase 6** of the call-service-registry plan
([2026-07-20-call-service-registry-plan.md](./archive/2026-07-20-call-service-registry-plan.md)),
which promotes this research note's `call("federate", …)` sketch into a concrete
`mogwai.graph.federate` barrier service. Origin question: *for the worst case — a
federated sub-traversal returning most/all of a graph — is GraphBinary an efficient
enough transfer format, or should we build a bulk import/export path first?* Answer:
**neither is on the Phase 6 critical path** (detached-reference merge sidesteps both),
but the question surfaced a real deferred capability and one invalidated assumption
above. Recorded so the reasoning isn't lost.

## Correction: SQLite `ATTACH` / raw dumps do NOT work on Cloudflare DO

The "SQLite-coordinator idea" above (lines ~60–82, 134) leans on **`ATTACH`** —
attach N database files, join across them in one native query. **Cloudflare Durable
Object SQLite does not permit `ATTACH` (nor raw `.dump` / cross-db file copy).** A dev
discussion / feature ask upstream is possible but low-odds. So the coordinator, if ever
built, cannot use SQLite-native attach on the production runtime — it must materialize
foreign rows into **ordinary temp relations / `VALUES` CTEs inside the one DO's own
SQLite** (application-level), which is exactly what the detached-reference merge below
already does. The `q`-kernel-emits-both-sides insight still holds; only the *cross-db
file* mechanic is dead on CF. (Bun could still `ATTACH`, but we do not build a
runtime-divergent path.)

## Phase 6's actual mechanic: detached references (no bulk write, no GraphBinary tax)

The federated call merges a sibling graph's **query results** back as TinkerPop
**detached references** — id + label + a property *snapshot*, NOT attached to the local
graph and NOT inserted into local `nodes`/`edges`:

- Sibling result rows land in a `VALUES`-CTE temp relation (same pattern as
  `services/directory.ts`), lifted into an `ElementStream`, JOINed back on the
  originating parent ordinal so `path()`/`as()` linkage is preserved — like a
  `flatMap`'s children.
- **Cost is O(rows returned)** — one `VALUES` materialization + a JOIN — **not** N
  `addV`/`addE` writes. The per-element write path (one Gremlin string per element,
  1 element INSERT + 2–4 statements/property + an FTS write; see `steps/write.ts`)
  **never enters the picture.** So the "re-ingestion" cost the worst case worried
  about does not exist for Phase 6.
- **Limit (honest):** detached elements have no *local* edges, so no local graph
  movement over them (`call(federate,…).out()` can't run `out()` locally). Traverse
  further only by pushing it into the sibling's sub-traversal, or by *materializing*
  (persisting) the foreign subgraph locally — and **only that persist path needs the
  bulk-write machinery below.** The plan states this ("no unbounded local graph
  movement over them unless materialized").

## Transfer format: three distinct problems, three answers

The worst case conflates three problems that have different best formats:

| Problem | Best format | Why |
|---|---|---|
| **Federate-to-federate internal call** (DO↔DO RPC, or in-process on Bun) | **Raw rows, skip GraphBinary** | The sibling call is in-process/RPC, not client HTTP. GraphBinary's per-value self-describing type tags are pure overhead here — decode to GraphBinary only at the final *client* HTTP edge. `GraphManager.query` returns `Framed[]` today; a barrier can expose a raw-row internal path instead. |
| **Bulk export/import for interop** (bring data in from Neptune/Neo4j, or hand ours out) | **CSV-with-typed-headers** | Cross-vendor de-facto standard (see prior art below); text is fine for interop; portable, no deps. |
| **Compact whole-graph backup/replication** (our-graph → our-graph, size matters) | **Application-level typed dump** (NOT a SQLite file dump — forbidden on CF) | Our schema is already row-normalized; a `SELECT` over the four tables serialized ourselves (shared header once, values, `vtype` per column not per cell) beats GraphBinary's per-value tags without new deps. Reuses the same producer as the CSV path. |

Key fact behind all three: **GraphBinary is a row-oriented, per-value self-describing
*wire* protocol, not a bulk format.** Every value carries its own
`type_code+type_info+value_flag`. Fine for a live query response (its job); wasteful as
a whole-graph transfer (repeats type tags per cell, no shared schema/column dictionary,
fully materialized in memory — no cursor streaming on DO). This matches CLAUDE.md's own
wire-protocol characterization.

## Bulk import/export prior art (researched 2026-07-21) — DEFERRED capability

There is **no bulk path at any layer today** (no `io()` step, no management-API
export/import verb, no multi-row insert; even the ~8,900-element grateful-dead seed runs
one `addV`/`addE` per element). When picked up, the target is **CSV-with-typed-headers**:

- **Cross-vendor de-facto standard.** Amazon Neptune's Gremlin CSV bulk-load format
  (vertex file: `~id`, `~label`, `propname:type`/`propname:type[]` columns; edge file:
  `~id`, `~from`, `~to`, `~label`, props) and Neo4j `neo4j-admin database import` CSV
  (`:ID`/`:LABEL`/`prop:type`; `:START_ID`/`:END_ID`/`:TYPE`) are structurally the same
  shape. Instantly familiar to users of either.
- **TinkerPop has no columnar/bulk format.** GraphML (verbose XML), GraphSON (JSON,
  per-value `@type`/`@value` tagging — see the cousin note
  [2026-07-13-graphson-untyped-scope.md](./2026-07-13-graphson-untyped-scope.md) for
  per-*result* JSON, a different problem), Gryo (binary but JVM-only + deprecated),
  GraphBinary (wire protocol, row-oriented). None fit compact whole-graph transfer.
- **Apache GraphAr** (ASF incubating, v0.13.0 Aug 2024; Parquet/ORC/CSV/JSON backends;
  per-label vertex tables + chunked column groups + CSR/CSC adjacency) is the one real
  "columnar graph format" and the state of the art for the heterogeneous/sparse-property
  impedance mismatch — but it's **data-lake/Spark-oriented and heavyweight** (Arrow/
  Parquet/ORC deps), colliding with the no-new-dependencies lock. **Cited north star, not
  adopted.** (Neptune's Parquet support is likewise scoped to the separate Neptune
  *Analytics* product, not the transactional loader.)
- **Raw SQLite file dump / `ATTACH` copy** — **ruled out on CF** (see the correction
  above). The compact-replication path must be an *application-level* typed row dump, not
  a `.dump`/`ATTACH`.

Cross-graph load caveats (whenever built): `labels.id` and `nodes.id`/`edges.id` are
local rowids with no cross-graph meaning, so a load into a non-empty target needs label
re-interning and rowid/uid collision handling — not a blind copy. A bulk-write path also
needs an FTS-bulk-aware variant of the write helpers (the "delete FTS only on genuine
overwrite" logic assumes single-row context — see CLAUDE.md's FTS PERF TRAP).

## Net decision

- **Phase 6 proceeds on the detached-reference merge** — no bulk path, no internal
  GraphBinary tax (raw-row internal transfer, GraphBinary only at the client edge). This
  is the plan as written; the worst case does not change it.
- **Bulk import/export is a separately deferred capability**, target **CSV-with-typed-
  headers** (Neptune/Neo4j shape), with an application-level typed dump for compact
  our→our replication. GraphAr is a cited north star we do not adopt; SQLite `.dump`/
  `ATTACH` is out on CF.
