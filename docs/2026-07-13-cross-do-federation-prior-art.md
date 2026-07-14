# Cross-DO federation — prior art + feasibility (research note)

**Status: research only. Nothing built, nothing planned.** Captures the answer to
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
