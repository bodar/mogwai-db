# Graph Algorithms — a GDS-competitive, TinkerPop-compatible algorithm layer

**Date:** 2026-07-24
**Status:** PROPOSED — design/research doc, nothing built. This is scoping + architecture for
the next agent; it deliberately stops short of every detail and names the open research where it
matters.

> **The bet in one sentence:** implement graph algorithms *once* as `call()` **services** (the
> extensible, GDS-class superset surface), and expose TinkerPop's four canonical OLAP step names
> (`pageRank`/`peerPressure`/`connectedComponent`/`shortestPath`) as thin **desugar Passes** that
> rewrite to the same services — so we are backwards-compatible with stock TinkerPop clients AND a
> superset of them, with a single implementation.

This builds directly on `docs/archive/2026-07-20-call-service-registry-plan.md` (the `call()` + Service
Registry seam, LANDED) — read that first. Nothing here changes the compiler core; it adds services
and rewrite Passes.

---

## Motivation & the honest competitive framing

Neo4j ships **two** add-on libraries, and they are different things:

- **APOC** (~450+ procedures/functions) — a *utility/stdlib* grab-bag (import/export, string/date/
  collection helpers, refactoring, path expanders). Most of it is **not** algorithms; in Gremlin the
  bulk of APOC is already covered by *native composable steps* (`fold`/`project`/`repeat`/`coalesce`/
  `math()`…), and the procedure-call pattern itself is our `call()` seam. APOC is **not** the target.
- **GDS** (Graph Data Science, ~65 algorithms) — the actual algorithm catalog (PageRank, Louvain,
  betweenness, Dijkstra, embeddings…). **This is the target.**

GDS gets its performance from an in-memory compressed columnar graph projection, heavy
multithreading, and minutes-to-hours batch tolerance. We have **one single-threaded SQLite
connection, a per-request/alarm CPU budget on the DO, no UDFs, and a ≤10 GB store.** So the design
question is never "can SQL express algorithm X" — it is **"does X reduce to a bounded number of
*set-based* passes over the edge table, each cheap enough to finish in the CPU budget?"**

**GraphComputer / OLAP status in TinkerPop 4 (verified 2026-07-24, correcting an earlier
overstatement in `docs/2026-07-13-cross-do-federation-prior-art.md`):**
- **NOT removed.** `GraphComputer.java` is still on `master`; the 4.0 "Future" roadmap treats OLAP
  as *retained and to be modernized* (GraphAR IO, deferred to 5.x), not deprecated.
  Sources: [4.0.0-beta.1 Future roadmap](https://tinkerpop.apache.org/docs/4.0.0-beta.1/dev/future/),
  [GraphComputer.java @ master](https://github.com/apache/tinkerpop/blob/master/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/computer/GraphComputer.java).
- **What IS true (verified against our tracked grammar in `parser/`):** the v4 Gremlin *language* has
  the four OLAP step *names* (`pageRank` w/ `_Empty` + `_double` overloads, `peerPressure`,
  `connectedComponent`, `shortestPath`) but **no `program`, `withComputer`, or `GraphComputer`
  token** — i.e. no way to *configure a computer job from the query string*. So v4 exposes the step
  names but not an execution surface for them. **That gap is exactly what we fill** by giving those
  steps an OLTP, compile-to-SQL execution.

---

## Guiding principles

1. **Compile-to-SQL is absolute (locked decision #3).** No row-at-a-time JS traversal, ever. An
   iterative algorithm is **host-driven iteration**: a loop in JS issuing one *bulk, set-based* SQL
   statement per iteration against a temp table. Each statement is pure SQL — this honours #3. It is
   the classic "Pregel-in-SQL" / BSP pattern, **not** interpretation.
2. **One implementation, two front-ends.** The algorithm lives once, as a `call()` service. Named
   TinkerPop steps are **desugar Passes** to it — never a second lowering. (Enforced by test; see
   Guardrails.)
3. **Reuse-first vocabulary.** Native TinkerPop names verbatim (they already parse; stock clients
   emit them; conformance references them). Our own extensions are `mogwai.*` (per the project rule);
   `gds.*` may be offered as *aliases* for onboarding but we do not squat that namespace.
4. **The `call()` surface is the superset, and it mirrors GDS's own shape.** GDS is itself
   call-based (`CALL gds.pageRank.stream/.mutate/.write/.stats`). We mirror those **modes** so Neo4j
   users see a familiar surface and we get write-back for free.
5. **Correct by design, fail closed.** A config/variant SQL cannot express throws a clear deferral;
   never mis-execute, never silently answer a different question, never drop to JS filtering.
6. **Rides the existing seam — no new orchestrator.** Global iterative algorithms are `'barrier'`
   contributions (the async/multi-statement variant already present in the registry). Results flow
   back through the ordinary `lowerSteps`/`materializeFinal` machinery and the existing write path
   for `mutate`.

---

## Feasibility tiers (the scope map)

Ceilings are single-threaded SQLite, "usable" = sub-second to low-minutes on the target
small-to-medium graphs. These tiers drive build order.

### Tier 1 — good perf, build first (cost O(E) or O(k·E), k≈20–50 iterations; usable into low millions of edges)
| Family | Algorithms | Mechanism |
|---|---|---|
| Centrality | Degree (**done**), **PageRank**, ArticleRank, Eigenvector, HITS | host-driven loop; each iter = one join + `GROUP BY` over edges |
| Community | **WCC**, Label Propagation, K-1 coloring, Modularity (metric), Conductance | min-label / argmax propagation to fixpoint (window fns give argmax) |
| Topology | **Triangle count**, Local clustering coefficient | 3-way self-join on edges — one query, O(E^1.5) |
| Paths (unweighted) | BFS, DFS, single-source & source-target **shortest path**, topological sort, DAG longest path | single recursive CTE (no aggregate in recursive term → allowed) |

Substrate already present: **`movementCollapse`** (`SELECT id, SUM(bulk) … GROUP BY id`, frontier
bounded by |V| not walk-count) is a bounded-frontier BSP step — the hard primitive for the iterative
Tier-1 algorithms.

### Tier 2 — implementable but perf-bounded (O(V·E) or pairwise; small/medium graphs, ~1e3–1e5 nodes)
- Weighted paths: Bellman-Ford (clean iterative relaxation), Dijkstra/A*/Yen's (no SQL priority
  queue → fall back to relaxation), Minimum Spanning Tree (union-find/Prim awkward in SQL).
- Betweenness / Closeness / Harmonic centrality (BFS-from-every-node, Brandes) — small graphs only.
- SCC (Kosaraju = two reachability passes).
- Node Similarity (Jaccard/Overlap) — neighbor-set self-join with topK/degree cutoff.
- **Louvain / Leiden** — the hard one: multi-level modularity + community coarsening. Doable as a
  barrier service with *batch synchronous* local moves + host-driven coarsening, but it yields an
  **approximation**; matching GDS's quality is genuinely hard without in-memory bookkeeping.

### Tier 3 — not worth attempting on this substrate (~15–20% of GDS)
Node embeddings (Node2Vec, FastRP, GraphSAGE, HashGNN), approximate KNN, link-prediction ML
pipelines. These are iterative vector/gradient math (sometimes a trained NN). Without UDFs, vectors,
or threads, SQLite is the wrong engine. **Fail closed with a clear deferral.**

**Estimate:** ~40–50% of GDS is worth building here (Tier 1 + the small-graph half of Tier 2), of
which Tier 1 has genuinely competitive latency for the project's target graph sizes. The first
tranche (PageRank / WCC / LPA / triangle count / shortest path) covers the most-requested ~80% of
real GDS usage.

---

## The two-front-end architecture

```
  pageRank()  peerPressure()  connectedComponent()   ← native TinkerPop steps (already parse)
      │            │                 │
      └────────────┴─────────────────┘   extract-category desugar Pass (ir/passes.ts + strategies.ts)
                   ▼
        call('mogwai.<algo>', { …config, resultKey, mode })   ← canonical surface (superset)
                   ▼
        Service (services/catalog/<algo>.ts)  — 'barrier' contribution
                   ▼
   host-driven iteration loop  →  id→score temp table  →  per-traverser join / mutate / stream rows
```

- **Named step → `call()` is an `extract` Pass**, not a StepFn. This is idiomatic: the pipeline
  already does `Step[]→Step[]` rewrites, and `extract` runs first so the rest of the pipeline (and
  the `verify` pass, which asserts against `ctx.originalChain`) sees the canonical form while error
  messages still reference what the user wrote. **Do NOT add a `pageRank` StepFn** — that would be a
  second implementation (violates the extension law + principle #2).
- **The service is a `'barrier'` contribution** (async/multi-statement) — the variant already
  reserved in the registry for exactly this. `g.call(...)` = `seedCall` (start form);
  `V().call(...)` = `lowerCall` (per-parent child scope, the element-preserving form).

### The result-contract subtlety that decides conformance

The named step and a GDS-style call have **different result contracts**, and the desugar must
preserve the **named step's** contract:

- Native `pageRank()` is **element-preserving**: run the global compute, then *decorate each
  incoming traverser vertex* with its score under a canonical property key
  (3.x: `gremlin.pageRankVertexProgram.pageRank`) and **pass the vertex through**. So
  `…pageRank().order().by('gremlin.pageRankVertexProgram.pageRank', desc).limit(10).values('name')`
  keeps flowing as vertices.
- A GDS-style `seedCall` returns `{node, score}` rows.

⇒ The desugar targets the **streaming, per-parent, element-preserving** call mode — the exact shape
`tinker.degree.centrality` already uses (`type: 'streaming'`, per-parent merge, element carried,
`scopedMovementCount` → `pushChildScope` + `lowerScopedScalarReducer`). The *computation* is global
(barrier), but the *binding* is a per-traverser join to the `id→score` table. Get this split right
and the OLAP-excluded conformance scenarios (structural-bets doc: "PageRank=3 is OLAP-excluded") come
into scope as a give-back.

### GDS-style modes on the `call()` surface
- `stream` — return `{node, score}` rows (`seedCall` shape).
- `mutate` — write score back as a vertex property via the existing write path
  (`applyVertexProperty`); then it's a normal queryable property. This is the ergonomic escape hatch
  and moots the return-shape question.
- `stats` — return only the summary (iterations, didConverge, distribution).
- The native TinkerPop step ≈ a *fourth* "decorate-in-flight and continue" mode (per-traverser join,
  element-preserving) — same engine, different tail.

---

## The four built-in native steps

All four already parse (verified in `parser/`). Three share one template; `shortestPath` is its own
shape.

| Step | Grammar overloads | Desugars to | Result contract |
|---|---|---|---|
| `pageRank()` | `_Empty`, `_double` (damping α) | `mogwai.pageRank` | decorate vertex w/ score under `gremlin.pageRankVertexProgram.pageRank`, pass through |
| `connectedComponent()` | `_Empty` | `mogwai.wcc` | decorate vertex w/ component id under `gremlin.connectedComponentVertexProgram.component`, pass through |
| `peerPressure()` | `_Empty` | `mogwai.peerPressure` | decorate vertex w/ cluster id, pass through (same template as WCC) |
| `shortestPath()` | (check grammar for `with()` config) | `mogwai.shortestPath` | **path-shaped** — emits paths, not decorated vertices; the recursive-CTE special case flagged in `docs/outstanding-work.md` |

**Template A (pageRank / connectedComponent / peerPressure):** global barrier compute → `id→value`
temp table → per-traverser join, element-preserving, decorate under the canonical key.
**Template B (shortestPath):** single recursive CTE producing paths; different tail
(`PathStream`); no barrier needed for unweighted.

**Research the exact result property keys + `with()`/`by()`/`times()` modulator surface** against
the pinned beta.2 features (`vendor/tinkerpop`, `gremlin-test/.../features/`) before implementing —
the canonical keys are what the conformance scenarios assert on.

---

## Worked example — PageRank (the proof-of-concept)

### 1. The desugar Pass (`extract` category)
In `src/compiler/ir/passes.ts` (body in `ir/strategies.ts`), a Pass that rewrites:
```
{ name: 'pageRank', args: [] }        → { name: 'call', args: ['mogwai.pageRank', { dampingFactor: 0.85, maxIterations: 20, tolerance: 1e-6, resultKey: 'gremlin.pageRankVertexProgram.pageRank', mode: 'decorate' }] }
{ name: 'pageRank', args: [0.9] }     → …same, dampingFactor: 0.9
```
Register it in the `extract` group of the flat `PASSES` array. Commit an ordering/rewrite test in
`test/compiler/passes.exec.test.ts` (the family that already pins pipeline invariants).

### 2. The barrier service (`src/services/catalog/pagerank.ts`)
A `Service` with `type: 'streaming'` (per-parent, element-preserving) whose contribution is
`'barrier'`. The barrier callback (host-driven, runs between SQL segments — the async gap the
segmented-plan model in the call-registry doc already defines):

```
-- one-time: N = |V| over the projection (config nodeLabels/relationshipTypes filter, else all)
-- seed:  rank[v] = 1/N          → temp table pr(id, rank)
-- iterate k times (or until max |Δrank| < tolerance):
   INSERT INTO pr_next(id, rank)
   SELECT n.id,
          (1 - :d)/:N
          + :d * COALESCE(SUM(pr.rank / outdeg.c), 0)
   FROM nodes n
   LEFT JOIN edges e      ON e.tgt = n.id            -- incoming (config-orientable)
   LEFT JOIN pr           ON pr.id = e.src
   LEFT JOIN outdeg       ON outdeg.id = e.src       -- precomputed out-degree per node
   GROUP BY n.id;
   -- swap pr ⇄ pr_next; compute convergence delta
```
- Each iteration is **one set-based SQL statement** (honours #3). Out-degree precomputed once.
- Dangling-node mass (sinks) handled the standard way (redistribute, or fold into the teleport term)
  — **research the exact handling the conformance scenarios expect.**
- Convergence: stop at `maxIterations` or when `MAX(ABS(rank - prev)) < tolerance`.
- The traverser-`bulk` column and `movementCollapse` substrate are the model to follow for the
  frontier arithmetic.

### 3. Binding back to traversers (the three tails)
- **decorate mode** (native step): the incoming `ElementStream` JOINs `pr` on `id`, the score rides
  as a carried scalar exposed under `resultKey`; the stream stays elements → `order()/by()/values()`
  compose. Reuse the degree-centrality per-parent path.
- **stream mode**: `seedCall` selects `pr` as `{node, score}` rows.
- **mutate mode**: write `pr` into `vertex_properties` via `applyVertexProperty` (single
  cardinality), keyed by `resultKey`. Then normal queries read it.

### 4. DO budget reality
~20–50 iterations × O(E) each. For low-millions of edges this is seconds; for larger, run under a DO
**alarm** and checkpoint `pr` across invocations. `stats`/`stream`/`mutate` all tolerate that;
`decorate` in a live query does not (must finish in-request) — **research the alarm/checkpoint
handoff** if we want decorate on large graphs, else fail closed with a size deferral.

---

## Naming & namespaces
- Native step names: **verbatim** (`pageRank`, `peerPressure`, `connectedComponent`, `shortestPath`).
- Canonical service names: **`mogwai.*`** (`mogwai.pageRank`, `mogwai.wcc`, `mogwai.louvain`, …).
- Optional **`gds.*` aliases** for onboarding familiarity — thin registry aliases, provenance clear.
- Algorithms with **no** native step (Louvain, betweenness, node similarity, …) are `call()`-only.

---

## Guardrails (encode as tests before/with the work)
1. **Named steps never lower directly** — a `passes.exec` test asserting each of the four rewrites to
   its `call` form. This is the "one engine" invariant.
2. **Mode equivalence** — `stream` vs `mutate` vs `decorate` produce consistent scores for the same
   config (a `services`/`exec` test).
3. **Fail-closed deferrals** — Tier-3 algos and SQL-inexpressible configs throw a clear deferral
   (never JS-filter, never mis-execute). Test the throw + message.
4. **Conformance** — add the algorithm cucumber tags to `test/L3-conformance/tags.ts` as steps land;
   confirm the reclaimed OLAP scenarios pass and the L3 ratchet only goes up. L1 corpus stays 100%.
5. **SQL snapshots** assert semantic equivalence, not byte-identity (per CLAUDE.md).

---

## Open research for the next agent (start here)
1. **Exact result contracts** of the four native steps against pinned beta.2 features: canonical
   property keys, the `with()`/`by()`/`times()` modulator surface, `shortestPath` config
   (`ShortestPath.target`/`.edges`/`.distance`), and which conformance scenarios are currently
   OLAP-excluded and reachable.
2. **Barrier/segmented-plan wiring** — how a `'barrier'` contribution actually suspends between SQL
   segments today (the call-registry doc describes the model; confirm what Phase 6 *built*, per its
   "as built" addendum) and whether a `decorate`-mode global compute can complete in-request.
3. **DO alarm checkpointing** for large-graph iterative jobs (`stream`/`mutate`/`stats` only).
4. **PageRank dangling-node handling** the conformance scenarios expect.
5. **SQLite recursive-CTE limits** confirmation for the Tier-1 path family (no aggregate/`GROUP BY`
   in the recursive term — drives which algos must be host-driven vs single-CTE).
6. **Louvain** feasibility spike (batch synchronous local moves + coarsening) — quality vs GDS, and
   whether it's worth shipping as "approximate".
