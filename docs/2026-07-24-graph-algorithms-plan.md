# Graph Algorithms — a GDS-competitive, TinkerPop-compatible algorithm layer

**Status: BUILD STARTED 2026-08-22. The two-front-end seam is LANDED; the compute is next.** Reviewed
2026-08-13 against the RelIR spine. OLAP is **no longer a locked non-goal**: the intention is to
implement it. Names the open research where it matters.

**✅ LANDED (2026-08-22, commit `desugar the four native OLAP steps`).** The front-end for ALL FOUR
steps and the service registration:
- `desugarGraphAlgos` (extract Pass, `ir/strategies.ts`) rewrites `pageRank`/`connectedComponent`/
  `peerPressure`/`shortestPath` → `call('mogwai.pageRank'|'.wcc'|'.peerPressure'|'.shortestPath', {mode})`
  — Guardrails #1, tested in `test/compiler/passes.exec.test.ts`. `mode` is `decorate` for the three
  element-preserving steps, `path` for shortestPath. `pageRank(α)`'s damping rides in the config map;
  the `~tinkerpop.<algo>.*` config folds onto the minted call via `absorbCallWith`.
- The four services (`src/services/catalog/graph-algorithms.ts`) register in BOTH registries as
  `internal: true` (served, absent from `--list` — they back native steps, like `mogwai.io`).
- **Execution is a clear fail-closed deferral** ("graph algorithm execution is not implemented yet"),
  never a mis-execution or a silent decline. Census re-recorded (OLAP rows now carry that message).

**✅ LANDED (2026-08-22, commit `connectedComponent as a DECORATE barrier`) — the decorate substrate +
WCC.** The compounding "genuinely new plumbing" the doc flagged is built, and it is reused by
pageRank/peerPressure next:
- **The DECORATE barrier output shape.** A barrier's `apply` may now return a `(id → value)`
  `BarrierRelation` (not just detached `ForeignRow[]`); a `decorate: {key}` on the barrier contribution
  routes it to a decorate resume (`src/services/spi/types.ts`, `src/compiler/segment.ts`).
- **`lowerDecorateResume` + `DecorateGraph`** (`src/compiler/rel/lower.ts`, `rel/decorate.ts`). The
  resume re-lowers the LIVE element prefix over a `GraphSource` wrapper that answers the ONE decorated
  key off the barrier's `(id → value)` relation (landed ONCE as a fenced `json_each` binding,
  materialize-once) and delegates everything else to `BaseGraph`. So the element stream stays
  element-preserving and `has(key)`/`order().by(key)`/`project().by(key)` compose as ordinary property
  reads. `Lowering.source` threads the wrapper in.
- **`mogwai.wcc`** (`src/services/catalog/graph-algorithms.ts`): an async DECORATE barrier, residency
  `'do'`, computing WCC by union-find over the undirected edge list (component id = the
  lexicographically-smallest external id string in the component — the reference's exact rule). One
  bulk SQL read + a bounded in-JS computation, the barrier model — not row-at-a-time interpretation.
  Covered by `test/L2-sql/wcc.exec.test.ts`.

**Scoped out of this WCC commit (fail closed, next commits):** a custom edge scope
(`.with("~tinkerpop.connectedComponent.edges", __.bothE("knows"))`) — an anonymous edge traversal is
not yet carried as a call param; `values(key)`/`valueMap(key)` over the decorated key — needed by
pageRank (`valueMap("name", score)`), landing with it. L3 stays excluded for these (the cucumber runner
injects `.withComputer()`, which our grammar has no token for — that is the remaining L3-integration
problem, separate from execution).

**✅ LANDED (2026-08-22) — the L3 credit unblock.** `withComputer()` (the @GraphComputerOnly runner
setup) serializes to `withStrategies(VertexProgramStrategy(...))`; `VertexProgramStrategy` is now a
`NO_OP_STRATEGIES` entry (the graph-computer execution choice is inert for compile-to-SQL OLAP) and
`@GraphComputerOnly` left `OUR_EXCLUSIONS`, so the OLAP scenarios run in L3 — landed algorithms pass and
raise the floor, the rest fail closed.

**✅ LANDED (2026-08-22) — pageRank (default scope).** `mogwai.pageRank` is a DECORATE barrier faithfully
replaying `PageRankVertexProgram`'s BSP (default `outE`, α=0.85 / `pageRank(α)`, ε=1e-5, ≤20 iters,
dangling-node teleport redistribution) as a host-driven loop inside `apply`, reusing the decorate
substrate verbatim. L3 +3 (the three default-scope scenarios: `has`, `order().by(rank,desc).by(name)`,
`order…limit(2)` — exact reference ranking `lop,ripple,josh,vadas,marko,peter`). `test/L2-sql/pagerank.exec.test.ts`.

**✅ LANDED (2026-08-22) — numeric-decorate `values(key)`.** `DecorateGraph.propertyValues` reads the
decorated REAL score as a 1:1 join to the landed relation (framed by `DecorateSpec.vtype`), so
`values(key)`/`project().by(__.values(key).math(…))` compose. L3 +1 (pageRank scenario 7,
`…as(a).out("knows").values(pageRank).as(b).select(a,b).by().by(math)` — the score reads back through
movement). `values(name, key)` mixing the decorated key with stored keys, and `valueMap(key)`, stay
fail-closed (no landed scenario needs them).

**✅ RESOLVED (2026-08-22) — the "OLAP graph-filter" question, by reading `tinkergraph-gremlin`
(now vendored).** There is **no graph-filter / vertex-scoping** for OLAP steps, and the earlier
"pageRank subgraph vs WCC global" contradiction was a RED HERRING — **both are GLOBAL**. The evidence,
at the pin:
- `TinkerGraphComputer.submit` hands each chained vertex program a result graph built by
  `processResultGraphPersist(NEW, EDGES)`, which **copies ALL vertices and ALL edges**
  (`TinkerGraphComputerView.java:184-191`) — a full copy, not a filtered one. And `GraphFilterStrategy`
  is **removed** for the in-memory computer (`TinkerGraphComputer.java:62-64`). So the OLTP prefix
  (`hasLabel("person")`) runs as program 1 producing halted traversers, then pageRank (program 2) runs
  GLOBAL over the full graph; the prefix filters the OUTPUT (halted set) only.
- My global pageRank matches `PageRankVertexProgramTest.java` EXACTLY (marko 0.1138, vadas 0.1460, lop
  0.3047, ripple 0.1758 — dead-on its asserted ranges). WCC's `hasLabel("software").connectedComponent()`
  → global "1"/"1" ✓. Both landed algorithms are already reference-faithful; the prefix-as-output-filter
  is exactly what the decorate resume does. **No correct-by-design bug, no guard, no subgraph compute.**
- **Scenario 6 (`hasLabel("person").pageRank()` → marko 0.46) — RESOLVED, NOT anomalous (2026-08-23).**
  My earlier "anomalous" call was WRONG: I hadn't implemented `initialRank`. The step form seeds
  `initialRank = HaltedTraversersCount` (the incoming per-vertex traverser count) with teleport 0 when a
  preceding traversal-vertex-program exists (`PageRankVertexProgramStep.generateProgram` →
  `.initialRank(...)`; `VertexProgramStep.previousTraversalVertexProgram`). A bare `g.V()` has its
  `GraphStep` pushed PAST the OLAP step, so it is NOT a preceding program → no initialRank → the uniform
  seed (mass 1). So: `hasLabel(person)` → initialRank person=1/software=0, total mass 4, converges to the
  global SHAPE × 4 (marko 0.1138 × 4 = 0.455 → ceil 46) — EXACTLY the .feature. LANDED (initialRank
  feature below).

**✅ LANDED (2026-08-22) — edge-config carrying.** The source-rooted check moved OUT of
`nestedTraversalToGremlin` (it now carries an anonymous body verbatim) and INTO `federate`'s
`traversalOf` (federate is the one consumer that needs rooted); the OLAP services read a custom scope
(`~tinkerpop.<algo>.edges`) to a `{direction, labels}` descriptor (`edgeScopeOf`) and build the
adjacency with ONE store query (`scopedEdges`, label filter via a `json_each` bind). L3 +2 (1719→1721):
`g_V_pageRank_withXedges_outEXknowsXX_...` (matches 15/21/21 exactly) and the wcc `bothE(knows)` cluster
scenario. pageRank honours out/in/both; wcc supports the undirected `bothE` scope and fails closed on a
directional one (a different, directional min-propagation, not the undirected question).

**✅ LANDED (2026-08-22) — the OLAP computes are substrate-A-iterated (compile-to-SQL).** All three
decorate barriers now run the reference relaxation as ONE SQL statement per round: the current `(id → v)`
vector crosses as ONE `json_each` bind into a relaxation that JOINS the real `nodes`/`edges` tables, and
a loop drives to a fixpoint (`docs/2026-08-21-barrier-substrate-design.md` §Axis 2 / probe D). The graph
stays in SQLite — only the O(V) vector enters JS per round — honouring locked decision #3 (compile to
SQL, never interpret). WCC = a bothE min-label MIN; pageRank = the probe-D `α·pr/outdeg` join plus an
O(V) teleport scalar (dangling redistribution) and ε-convergence; peerPressure = an argmax tally with a
`ROW_NUMBER` tie-break on `CAST(c AS TEXT)`. The pure-JS computes are kept as differential ORACLES
(`test/L2-sql/olap-differential.test.ts` asserts the SQL rounds agree over the whole vector). Results
unchanged — L3 held at 1722, all conformance values identical. (The occupancy/yielding axis — alarm vs
Worker-driven — remains the doc's open question, unchanged by this.)

**✅ LANDED (2026-08-22) — peerPressure.** `mogwai.peerPressure` is a DECORATE barrier reusing the
substrate verbatim: peer-pressure label propagation (each vertex adopts the max-vote cluster among
{itself} ∪ {in-neighbours}, default outE, ties to the smallest id-string, to a fixpoint;
`PeerPressureVertexProgram.java:150-172`). L3 +1 (`g_V_peerPressure_hasXclusterX`). All THREE Template-A
decorate algorithms (wcc/pageRank/peerPressure) are now landed and reference-faithful — the decorate
substrate generalized cleanly to each.

**✅ LANDED (2026-08-23) — initialRank (the "barrier sees its input" substrate) + `times`.** A decorate
barrier may declare `seedFromInput`; when set and the prefix is NOT a bare `V()`/`E()` source, the
decorate segment gives `apply` a head that projects the incoming per-traverser element id (uncollapsed,
so multiplicity = row count) — the barrier's view of its input, reusing the existing value-head +
`readSegmentHead` machinery. pageRank reads it as `initialRank` (teleport 0); a bare source keeps the
uniform seed. `~tinkerpop.pageRank.times` caps the propagation rounds (maxIter = times+1; times=0 → the
seed as-is). L3 +1 (scenario 6, exact). Generic: any algorithm whose result depends on incoming
multiplicity uses `seedFromInput`.

**✅ LANDED (2026-08-23) — valueMap over a decorated key + pageRank FINISHED.** `DecorateGraph.valueMapPairs`
serves the decorated key (its value as a typed single-element list, mixed with stored keys via a UNION +
a `json()` subtype restore). L3 +1 (scenario 2). **pageRank is complete: all 7 ADJUDICABLE scenarios
pass.** The remaining two (8, 9) and the peerPressure+pageRank composite are in gremlin-js's `IgnoreError`
map (`ignoreReason.floatingPointIssues`) — the reference's OWN runner refuses to adjudicate them (float
noise in the .feature's expected values); our engine produces clean/correct values in isolation. They are
now EXCLUDED from L3 (`IGNORED_SCENARIOS`, parsed from feature-steps.js — auto-tracked, category 3 like
the runner-skipped tags), not counted as our failures. L3 denominator 2293 → 2286 (7 unadjudicable out).

**✅ LANDED (2026-08-23) — shortestPath, the UNWEIGHTED family (Template B).** `mogwai.shortestPath` is
now a PURE `rel` contribution (NOT a barrier): one `Recursive` term enumerates every SIMPLE path
(cycle-free via a `NOT EXISTS` membership over the carried path array, P2-legal), carrying `id`
(endpoint), `src` (source) and `dist` (hops) beside the path channel; a `MIN(dist) OVER (PARTITION BY
src, id)` window outside the walk keeps the shortest per (source, target) with ALL ties, then
`pathPositions` (`path.ts`) frames it — the SAME wire form `path()` produces, so no path-specific
framing. `src/compiler/rel/shortestpath.ts`. The reshape reaches the compiler through a new
`RelCallSite.stream` (the incoming element relation + `GraphSource`), dispatched by `midCall`'s
`serviceRelation` arm — the mid-traversal `relation` contribution, distinct from the per-parent `value`
arm. Covers the default `bothE` scope, the `~tinkerpop.shortestPath.edges` DIRECTION override
(`Direction.IN`/`__.outE()`/`__.bothE()`), `.includeEdges` (edges interleave the path), and the
unweighted `.maxDistance` hop cap (prunes the walk). **L3 +8 (1724→1732)**: `g_V_shortestPath`,
`g_V_both_dedup_shortestPath`, `g_V_hasXname_markoX_shortestPath`, `g_V_shortestPath_directionXINX`,
`g_V_shortestPath_edgesXoutEX`, `g_V_shortestPath_edgesIncluded`,
`g_V_shortestPath_edgesIncluded_edgesXoutEX`, `g_V_hasXname_markoX_shortestPath_maxDistanceX1X`.
`test/L2-sql/shortestpath.exec.test.ts`.

Why it cannot be `repeatWalk` (`walk.ts`): that regime DECLINES a path channel — its per-arm counter
bump distributes over the movement union while `extendPath` sits above it. This builder distributes the
append, the distance bump and the simple-path filter INTO each arm, so each references the walk once (P1)
and a `both` scope is two arms `UNION ALL`, exactly as `both()` is.

**✅ LANDED (2026-08-23) — shortestPath target filter + label-scoped edges.** The `.target` predicate
(`~tinkerpop.shortestPath.target`) filters the emitted paths by the ENDPOINT passing an anonymous vertex
predicate (`child.predicate` over the endpoint, applied AFTER the shortest-per-pair selection — the
trivial path is gated by the same endpoint filter, since its endpoint is its source). Label-scoped edges
(`__.bothE("uses")`) add `edgeLabelMatch` to the arm join (inline string labels, no bind). **L3 +4**:
`g_V_shortestPath_targetXhasXname_markoXX`, `g_V_shortestPath_targetXvaluesXnameX_isXmarkoXX`,
`g_V_hasXname_markoX_shortestPath_targetXhasLabelXsoftwareXX`, and the crew
`g_V_hasXname_danielX_shortestPath_targetXhasXname_stephenXX_edgesXbothEXusesXX`.

⚠️ **CORRECTION (2026-08-23, `9b77dd5`) — the weighted "LANDED" below is WITHDRAWN; it HANGS.** The
recursive-CTE walk (Template B) enumerates every SIMPLE path, and a min-distance relaxation cannot prune
INSIDE a recursive term (P3 / repeat-two-regimes §1a — no aggregate over the accumulation). So on a dense
graph it is exponential and reads as a hang (the §7.1 cost wall): L3's grateful
`g_V_hasXsong_name_MIGHT_AS_WELLX_..._edgesXoutEXfollowedByXX_distanceXweightX` never completes (measured
>95s standalone, bun 100% CPU), which is why no clean L3 run could re-record the floor. The unweighted
family survives only on small/hop-capped fixtures — it is the SAME latent flaw, unexercised. **Weighted
distance now FAILS CLOSED** (`shortestPathService` throws a deferral). This confirms the Tier-2 line above
(line ~273): weighted paths are Bellman-Ford iterative relaxation, a BSP BARRIER — not a recursive CTE.
**Phase 2 (authorized): rebuild ALL of shortestPath on the BSP relaxation barrier, delete the walk.** A
relaxation barrier computes min-dist + PREDECESSORS per node (V−1 rounds, the SQL-resident
`barrier_relation` substrate; Bellman-Ford handles the NEGATIVE/custom weights the reference allows, which
is why weighted maxDistance is a final filter not a prune); a recursive CTE then reconstructs paths over
the PRUNED predecessor DAG (dist strictly decreases → acyclic → enumerates only the actual shortest paths);
`path`-framed. New plumbing: a barrier whose product is a PATH relation, not a decorate resume.

**✅ ~~LANDED~~ WITHDRAWN — SEE CORRECTION ABOVE (2026-08-23) — shortestPath weighted distance.**
`~tinkerpop.shortestPath.distance` (a weight property key) makes distance the SUM of
edge weights (a REAL) rather than the hop count: the recursive term reads each edge's weight as a
correlated `values(key)` scalar (`child.scalar` over the edge — a nested SELECT, P2-legal) and sums it;
the MIN-over-partition outside the walk still selects the least-weight path (P3 forbids the min INSIDE
the term). The weighted `.maxDistance` filters the FINAL shortest distance per pair at collection (a
custom distance may be negative, so it does NOT prune the walk — the reference's
`distanceEqualsNumberOfHops` split). **L3 +3**:
`g_V_hasXname_markoX_shortestPath_targetXhasXname_joshXX_distanceXweightX`, the grateful
`g_V_hasXsong_name_MIGHT_AS_WELLX_..._edgesXoutEXfollowedByXX_distanceXweightX`,
`g_V_hasXname_vadasX_shortestPath_distanceXweightX_maxDistanceX1_3X`.

All 15 ShortestPath.feature scenarios now pass. The four native TinkerPop OLAP steps
(pageRank/connectedComponent/peerPressure/shortestPath) are complete and reference-faithful.

> **The bet in one sentence:** implement graph algorithms *once* as `call()` **services** (the
> extensible, GDS-class superset surface), and expose TinkerPop's four canonical OLAP step names
> (`pageRank`/`peerPressure`/`connectedComponent`/`shortestPath`) as thin **desugar Passes** that
> rewrite to the same services — backwards-compatible with stock TinkerPop clients AND a superset of
> them, one implementation.

Builds on the `call()` + Service Registry seam, which is now **built and in use** — read
`src/services/CLAUDE.md` (the registry + its guardrails), `src/services/spi/types.ts` (the
`Contribution` union: `rel` inline vs `barrier` async) and `src/compiler/rel/segment.ts` +
`src/compiler/rel/foreign.ts` (the barrier boundary and how its rows land). The doc that originally
described that seam is archived and DELETED; the code above is the authority. Nothing here changes
the compiler core; it adds services and rewrite Passes.

⚠️ **This doc predates the single-spine cut.** Every architectural bet in it survived, and the
mechanism per bet is now *proven code* rather than a plan — see "What the RelIR spine changed". One
bet needs a real correction: the `decorate` tail cannot be a barrier's landed rows.

---

## Motivation & the honest competitive framing

Neo4j ships **two** add-on libraries, and they are different things:

- **APOC** (~450+ procedures/functions) — a *utility/stdlib* grab-bag (import/export, string/date/
  collection helpers, refactoring, path expanders). Most of it is **not** algorithms; in Gremlin the
  bulk is already covered by *native composable steps* (`fold`/`project`/`repeat`/`coalesce`/`math()`…),
  and the procedure-call pattern itself is our `call()` seam. **APOC is NOT the target.**
- **GDS** (Graph Data Science, ~65 algorithms) — the actual algorithm catalog (PageRank, Louvain,
  betweenness, Dijkstra, embeddings…). **This is the target.**

GDS gets its performance from an in-memory compressed columnar graph projection, heavy multithreading,
and minutes-to-hours batch tolerance. We have **one single-threaded SQLite connection, a per-request/
alarm CPU budget on the DO, no UDFs, and a ≤10 GB store.** So the design question is never "can SQL
express algorithm X" — it is **"does X reduce to a bounded number of *set-based* passes over the edge
table, each cheap enough to finish in the CPU budget?"**

**GraphComputer / OLAP status in TinkerPop 4:**
- **NOT removed.** `GraphComputer.java` is still on `master`; the 4.0 "Future" roadmap treats OLAP as
  *retained and to be modernized* (GraphAR IO, deferred to 5.x), not deprecated.
  Sources: [4.0.0-beta.1 Future roadmap](https://tinkerpop.apache.org/docs/4.0.0-beta.1/dev/future/),
  [GraphComputer.java @ master](https://github.com/apache/tinkerpop/blob/master/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/computer/GraphComputer.java).
- **What IS true (per our tracked grammar in `parser/`):** the v4 Gremlin *language* has the four OLAP
  step *names* (`pageRank` w/ `_Empty` + `_double` overloads, `peerPressure`, `connectedComponent`,
  `shortestPath`) but **no `program`, `withComputer`, or `GraphComputer` token** — no way to *configure
  a computer job from the query string*. v4 exposes the step names but no execution surface for them.
  **That gap is exactly what we fill** by giving those steps an OLTP, compile-to-SQL execution.

---

## Guiding principles

1. **Compile-to-SQL is absolute (locked decision #3).** No row-at-a-time JS traversal, ever. An
   iterative algorithm is **host-driven iteration**: a JS loop issuing one *bulk, set-based* SQL
   statement per iteration, the `(id, score)` vector crossing each round as ONE `json_each` bind
   (substrate (A) iterated — NOT a temp table, which DO refuses; measured 2026-08-21, see §"Two
   mechanism gaps" below and `docs/2026-08-21-barrier-substrate-design.md` §(B)). Each statement is
   pure SQL. Classic "Pregel-in-SQL" / BSP, **not** interpretation.
2. **One implementation, two front-ends.** The algorithm lives once, as a `call()` service. Named
   TinkerPop steps are **desugar Passes** to it — never a second lowering (enforced by test; see
   Guardrails).
3. **Reuse-first vocabulary.** Native TinkerPop names verbatim (they parse; stock clients emit them;
   conformance references them). Our extensions are `mogwai.*` (per the project rule); `gds.*` may be
   offered as *aliases* for onboarding but we do not squat that namespace.
4. **The `call()` surface is the superset — of PARAMETERS, not of modes.** GDS is itself call-based
   (`CALL gds.pageRank.stream/.mutate/.write/.stats`), and the superset we owe is its per-algorithm
   *parameter* surface (`dampingFactor`, `relationshipWeightProperty`, `sourceNodes`, `topK`, …). We do
   NOT mirror its stream/mutate/write/stats **modes**: mogwai only implements `decorate` (+ `path` for
   shortestPath), because the traversal model subsumes the rest — a `stream` shape IS the decorated
   element stream, "stats" is ordinary aggregation over it (`values(key).mean()`), and "write"/"mutate"
   is `property()`/`addV` in the traversal. This corrects the doc's earlier "mirror the modes" text; see
   **GDS parameter coverage (2026-09-05)** below for the full mode/param/projection reconciliation.
5. **Correct by design, fail closed.** A config/variant SQL cannot express throws a clear deferral;
   never mis-execute, never silently answer a different question, never drop to JS filtering.
6. **Rides the existing seam — no new orchestrator.** Global iterative algorithms are `'barrier'`
   contributions (`Contribution`'s async arm, `services/spi/types.ts`). The boundary is
   `compiler/rel/segment.ts`, the rows land through `compiler/rel/foreign.ts`, and the rest of the
   chain is `lowerForeignResume` — "the same tail vocabulary, seeded from a landed relation instead of
   a scan". `mutate` uses the existing write path.

---

## Feasibility tiers (the scope map)

Ceilings are single-threaded SQLite, "usable" = sub-second to low-minutes on target small-to-medium
graphs. These tiers drive build order.

### Tier 1 — good perf, build first (O(E) or O(k·E), k≈20–50 iterations; usable into low millions of edges)
| Family | Algorithms | Mechanism |
|---|---|---|
| Centrality | Degree (done), **PageRank**, ArticleRank, Eigenvector, HITS | host-driven loop; each iter = one join + `GROUP BY` over edges |
| Community | **WCC**, Label Propagation, K-1 coloring, Modularity (metric), Conductance | min-label / argmax propagation to fixpoint (window fns give argmax) |
| Topology | **Triangle count**, Local clustering coefficient | 3-way self-join on edges — one query, O(E^1.5) |
| Paths (unweighted) | BFS, DFS, single-source & source-target **shortest path**, topological sort, DAG longest path | single recursive CTE (no aggregate in recursive term → allowed) |

Substrate present: **`movementCollapse`** (`SELECT id, SUM(bulk) … GROUP BY id`, frontier bounded by
|V| not walk-count) is a bounded-frontier BSP step — the hard primitive for the iterative Tier-1
algorithms.

### Tier 2 — implementable but perf-bounded (O(V·E) or pairwise; small/medium graphs, ~1e3–1e5 nodes)
- Weighted paths: Bellman-Ford (clean iterative relaxation), Dijkstra/A*/Yen's (no SQL priority queue →
  fall back to relaxation), Minimum Spanning Tree (union-find/Prim awkward in SQL).
- Betweenness / Closeness / Harmonic centrality (BFS-from-every-node, Brandes) — small graphs only.
- SCC (Kosaraju = two reachability passes).
- Node Similarity (Jaccard/Overlap) — neighbor-set self-join with topK/degree cutoff.
- **Louvain / Leiden** — the hard one: multi-level modularity + community coarsening. Doable as a
  barrier service with *batch synchronous* local moves + host-driven coarsening, but yields an
  **approximation**; matching GDS's quality is genuinely hard without in-memory bookkeeping.

### Tier 3 — not worth attempting on this substrate (~15–20% of GDS)
Node embeddings (Node2Vec, FastRP, GraphSAGE, HashGNN), approximate KNN, link-prediction ML pipelines.
Iterative vector/gradient math (sometimes a trained NN). Without UDFs, vectors, or threads, SQLite is
the wrong engine. **Fail closed with a clear deferral.**

**Estimate:** ~40–50% of GDS worth building here (Tier 1 + the small-graph half of Tier 2), of which
Tier 1 has genuinely competitive latency for target graph sizes. First tranche (PageRank / WCC / LPA /
triangle count / shortest path) covers the most-requested ~80% of real GDS usage.

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
   host-driven iteration loop  →  id→score relation  →  per-traverser join / mutate / stream rows
```

- **Named step → `call()` is an `extract` Pass**, not a step compiler. Idiomatic: the pipeline already
  does `Step[]→Step[]` rewrites, and `extract` runs first so the rest of the pipeline (and the `verify`
  pass, which asserts against `ctx.originalChain`) sees the canonical form while error messages still
  reference what the user wrote. **Do NOT add a `pageRank` lowering** — a second implementation,
  violates the extension law + principle #2.
- **The service is a `'barrier'` contribution** (async/multi-statement) — the arm the registry has for
  exactly this, and the one `federate`/`io` already ride. The two call POSITIONS are, on the live
  spine: a **source** `g.call(…)` contributes `{kind:'relation'}` and the fold continues through
  `continueAs` (`rel/lower.ts`); a **mid-traversal** `V().call(…)` contributes `{kind:'value'}` — a
  `ChildValue` from the ONE child seam (§6·6), via `midCall` as a chain step and `serviceValue` in a
  child body, so `where(call(…).is(3))` and `group().by(call(…))` are the same code path.

### The result-contract subtlety that decides conformance

The named step and a GDS-style call have **different result contracts**, and the desugar must preserve
the **named step's** contract:

- Native `pageRank()` is **element-preserving**: run the global compute, then *decorate each incoming
  traverser vertex* with its score under a canonical property key
  (3.x: `gremlin.pageRankVertexProgram.pageRank`) and **pass the vertex through**. So
  `…pageRank().order().by('gremlin.pageRankVertexProgram.pageRank', desc).limit(10).values('name')`
  keeps flowing as vertices.
- A GDS-style source call returns `{node, score}` rows.

⇒ The desugar targets the **streaming, per-parent, element-preserving** call mode — the shape
`tinker.degree.centrality` uses (`type: 'streaming'`, the value built by handing the child seam an IR
body). The *computation* is global (barrier), but the *binding* is a per-traverser read of the
`id→score` relation. Get this split right and the OLAP-excluded conformance scenarios ("PageRank=3 is
OLAP-excluded") come into scope as a give-back.

⚠️ **The correction the RelIR spine forces: `decorate` is NOT a barrier's landed rows.**
`foreignRelation` lands DETACHED elements, and `detachedTail` (`rel/lower.ts`) serves exactly
`id()`/`label()`/`values(k…)` and DECLINES everything else — while a resume cannot decline, so it
RAISES. So a `pageRank()` that landed its scores as foreign rows would refuse
`order().by(resultKey)` and every movement after it, which is precisely the contract the native step
must keep. The shape that works today is a **streaming `rel` contribution** whose
`RelContribution.value` is a `ChildValue` whose expression is a correlated read of a **RETAINED**
`scores` relation — RelIR §3.0's `Binding`/`Ref`/`snapshot`, which did not exist when this doc was
written. That keeps the stream LIVE and element-preserving: the element never detaches, so the tail is
the ordinary element vocabulary. The open question this leaves is not "what shape" but **who computes
the scores** — a host-driven loop is a barrier, and a barrier's product is a landed relation, so
`decorate` wants the loop's output RETAINED as a binding the following segment's algebra references
rather than re-sourced from. That is the one piece of genuinely new plumbing this doc asks for (see
open research 1).

### GDS-style modes on the `call()` surface — SUPERSEDED, see below

The original plan (mirror `stream`/`mutate`/`stats`) was **not** taken, and the code proves it:
`kernel.ts` accepts only `mode === 'decorate'`, shortest-path only `'path'`, and `spi/types.ts`
records "A former third arm, `stream`, is DELETED." The reconciled decision is in the next section.

---

## GDS parameter coverage (2026-09-05)

The bet (principle #2/#4): TinkerPop's four native steps are thin desugarings (`desugarGraphAlgos`,
`src/compiler/ir/strategies.ts`) onto `call('mogwai.<algo>', {…})`, and the `call()` surface is the
GDS-*parameter* superset. This section is the coverage matrix — GDS's per-algorithm param surface vs
what each service accepts today — built against the now-vendored config surface
(`vendor/gds/config-api` + `vendor/gds/procedures/facade-api/configs/{centrality,community,similarity,
path-finding}-configs`, added to the sparse set for exactly this) plus the `vendor/gds/algo`
implementations. **Implementation is a follow-on; this is the plan.**

### Modes / projection / multi-graph — the cross-cutting reconciliation

These resolve most of GDS's config surface *once*, so the per-algorithm tables below carry only real
algorithm-tuning params.

- **Modes (`stream`/`mutate`/`write`/`stats`) → N/A by design.** We do `decorate` (+ `path`). The
  traversal model subsumes the rest: the decorated element stream IS `stream`; "stats" is ordinary
  aggregation (`…pageRank().values(key).mean()`); "write"/"mutate" is `property()`/`addV` in the
  traversal. So every `writeProperty`/`mutateProperty`/`writeConcurrency` param is N/A, and GDS's
  `<algo>{Stream,Mutate,Write,Stats}Config` split collapses to one param set. `propertyName` (our
  decorate key) is the sole survivor of the write-mode family.
- **`relationshipTypes` → the `edges` scope.** `edgeScopeOf` (`src/services/catalog/olap/kernel.ts`)
  already parses `__.bothE("knows")` into `{direction, labels}`, which is GDS's relationship-type
  filter plus an orientation choice folded together. Gap: GDS allows richer multi-type selection; we do
  a single `outE`/`inE`/`bothE(labels?)` and fail closed past that.
- **`nodeLabels` → PARTIAL, a real gap.** `g.V().hasLabel("person").pageRank()` changes the *seed set*,
  not the graph projection — GDS's `nodeLabels` induces a subgraph (edges to excluded nodes vanish).
  No clean equivalent today; flag as a design item, not a param to bolt on.
- **Named graph → federation, a composition not a param.** GDS's `graphName` selects a projected graph;
  our analogue is `call("federate", {graph, …})` (a sibling DO). Directional analogue (different
  mechanism: cross-DO RPC vs in-process catalog), and OLAP-over-federated-source does not compose today
  — a separate substrate question, not a per-algorithm param.
- **`concurrency`/`logProgress`/`jobId`/`sudo` → N/A.** We compile to one (or a few) SQL statements in
  a single-threaded DO isolate; there is no thread pool to size or job registry to name.

### Per-algorithm matrix

Legend: **add** = real algorithm-tuning param to implement · **maps** = already covered via a
cross-cutting mapping above · **model** = needs a semantics decision first (lineage conflict) ·
**variant** = a missing algorithm shape, not a param · **N/A** = infra/mode/projection, excluded.

**Ranking / centrality**

| Algo | GDS param (default, cited) | today | verdict |
|---|---|---|---|
| pageRank | `dampingFactor` (0.85, `centrality-configs/…/pagerank/PageRankConfig.java`) | yes | — |
| | `maxIterations` (20, `…/pagerank/RankConfig.java:46`) | yes (`~tinkerpop.pageRank.times`) | — |
| | `tolerance` (1e-7, `RankConfig.java:40`) | hardcoded 1e-5, not settable | **add** |
| | `relationshipWeightProperty` (null) | **yes** (landed 2026-09-05) | — (weighted messages) |
| | `sourceNodes` (`[]`, personalized) | no (our seed = traverser count, different) | **add** |
| | `scaler` (None; Min/Max/Mean/Log/StdScore) | no | **add** |
| articleRank | `dampingFactor`/`maxIterations`/`tolerance` | yes/yes/yes | — |
| | `relationshipWeightProperty` (null) | **yes** (landed 2026-09-05) | — |
| | `sourceNodes`, `scaler` | no | **add** |
| betweenness | `samplingSize`/`samplingSeed` (full/exact default; `algo/…/betweenness/RandomDegreeSelectionStrategy.java`) | no (always exact) | **add** (accuracy/cost trade) |
| | `relationshipWeightProperty` (null) | no (hop-count only) | **add** |
| closeness | `useWassermanFaust` (false; `algo/…/closeness/{Default,WassermanFaust}CentralityComputer.java`) | no (Default only) | **add** (1-line reducer swap) |
| harmonic | (none — no algorithm-specific tunable, `algo/…/harmonic/HarmonicCentralityBaseConfig.java`) | — | full parity |
| hits | `hitsIterations`/`authProperty`/`hubProperty` | yes (as `iterations`/`authProperty`/`hubProperty`) | — |
| degree | `orientation` (NATURAL) | yes (as `direction` out/in/both) | — |
| | `relationshipWeightProperty` (null) | no (bare count) | **add** (weighted degree) |

**Community / components**

| Algo | GDS param (default, cited) | today | verdict |
|---|---|---|---|
| wcc | `threshold` (0; `community-configs/…/wcc/WccBaseConfig.java:32`, validation: >0 requires `relationshipWeightProperty`) | **yes** (landed 2026-09-05) | — |
| | `relationshipWeightProperty` (null) | **yes** (landed 2026-09-05) | — (pairs with `threshold`) |
| | `seedProperty` (null, incremental) | no | **add** |
| | `consecutiveIds` (false) | no | **add** (cheap result renumber) |
| peerPressure (≈GDS labelPropagation) | `maxIterations` (10; `community-configs/…/labelpropagation/LabelPropagationBaseConfig.java:40`) | hardcoded 30 | **add** (trivial — `iterateInSql` bound) |
| | `nodeWeightProperty`, `relationshipWeightProperty` (null) | no | **add** (SUM(weight) vote tally) |
| | `seedProperty` (null) | no | **model** — our lineage is TinkerPop `PeerPressureVertexProgram` (cluster = vertex id), which has no seed concept; adding it extends past the reference |
| scc | (none — no algorithm-specific config) | `propertyName` | full parity |
| kcore | (none) | `propertyName` | full parity |
| triangleCount | `maxDegree` (`Long.MAX_VALUE`; `algo/…/triangle/IntersectingTriangleCount.java`) | no | **add** (hub cost bound — O(deg²) today) |
| localClusteringCoefficient | `maxDegree` | no | **add** |
| | `seedProperty` (precomputed triangleCount reuse; `algo/…/triangle/LocalClusteringCoefficient.java`) | no (always recomputes) | **add** (composition/perf) |

**Similarity / paths**

| Algo | GDS param (default, cited) | today | verdict |
|---|---|---|---|
| nodeSimilarity | `topK`/`bottomK` (10; `similarity-configs/…/nodesim/NodeSimilarityBaseConfig.java:74`) | no (emits full dense relation) | **add** (top priority — combinatorial blowup on hubs) |
| | `topN`/`bottomN` (0=off) | no | **add** |
| | `similarityCutoff` (1e-42, `NodeSimilarityBaseConfig.java:52`) | implicit >0 only | **add** (`HAVING sim >= ?`) |
| | `degreeCutoff` (1) / `upperDegreeCutoff` (MAX) | no | **add** (`WHERE` on the `deg` CTE) |
| | similarity metric (JACCARD; OVERLAP/COSINE) | Jaccard hardcoded | **add** |
| | `relationshipWeightProperty` (null) | no (unweighted) | **add** |
| shortestPath | `sourceNode`/`targetNode(s)` | yes — generalized (sources from the traverser stream; target is an anonymous predicate) | superset |
| | `relationshipWeightProperty` (weight) | yes (`SP_DISTANCE`) | — |
| | edges scope / `includeEdges` | yes | — (stale "fail closed" header comment on label scope — `shortest-path.ts` — should be fixed) |
| | hop cap that PRUNES the walk (vs our post-hoc `maxDistance` filter) | partial (filters after full relaxation) | **add** (real early-stop) |
| | Yen's `k` (k-shortest-paths), A* heuristic | no | **variant** (new mechanism — single-relaxation barrier retains only the best distance) |

### Implementation priority (follow-on tranches)

1. **`relationshipWeightProperty` — one substrate, many algorithms.** ✅ Substrate LANDED 2026-09-05:
   `weightedAdjacencyCte(scope, weightKey)` (the generalized+renamed `shortestPathAdjacencyCte`, both now
   built on the shared `directedAdjacency` scaffolding so the weight/hop/unweighted forms cannot drift),
   with weighted **pageRank** as the first consumer (weighted out-degree `SUM(w) HAVING > 0`, message
   `α·pr·w/Σw`; unweighted path byte-unchanged; proven ≡ a weighted JS oracle in `olap-differential`).
   **articleRank** (weighted delta-accumulation ≡ oracle to 1e-9) and **wcc `threshold`** (union only
   across edges with `w > threshold`, validated `threshold > 0` requires the weight, ≡ the connected-
   components oracle over the filtered edge set) adopted it too, all 2026-09-05. Remaining consumers:
   betweenness (weighted paths), degree (streaming — a different mechanism: a weighted body
   `<dir>E().values(w).sum()`, needing the isolated-vertex → 0 case, since `sum()` has no seed over
   empty), weighted LPA.
2. **nodeSimilarity `topK`/`similarityCutoff`/`degreeCutoff`** — scalability wall today (dense output);
   all SQL tweaks (`WHERE`/`HAVING`/a per-source `ROW_NUMBER` cap).
3. **Cheap wins, no substrate:** peerPressure `maxIterations` (already a plain `iterateInSql` bound),
   pageRank/articleRank `tolerance`, wcc `consecutiveIds`, closeness `useWassermanFaust`, triangle/LCC
   `maxDegree`.
4. **`sourceNodes` (personalized pageRank/articleRank)** and **`seedProperty` (wcc)** — read a
   node-set/property into the seed INSERT instead of the identity seed.
5. **`scaler`** (post-hoc rescale), **betweenness sampling**, **nodeSimilarity metrics/weighted**.
6. **Deferred / design-first:** `nodeLabels` induced subgraph, OLAP-over-federation, Yen's/A*
   (`variant`), peerPressure `seedProperty` (`model` — reconcile lineage first).

Also fold in when implementation starts: the stale `strategies.ts` comment ("a GDS-style call chooses
`stream`/`mutate`/`stats`") and the stale `shortest-path.ts` header (label-scoped `.edges` "fails
closed" — the code actually threads labels).

---

## What the RelIR spine changed (reviewed 2026-08-13)

The single-spine cut deleted the route this doc was written against. **The architecture survived
intact** — named step → desugar Pass → `call()` service is still exactly right, and the `barrier` arm
is still where a global iterative compute belongs. What changed is that each mechanism is now shipped
code with measured properties, plus one correction:

- **The template got dramatically smaller.** `tinker.degree.centrality` — the shape Template A copies —
  is now ~5 lines of real logic (`src/services/catalog/degree-centrality.ts`). It hands the CHILD SEAM
  the IR body `[<direction>, count]`, which is the same correlated movement-then-reducer a
  `by(__.in().count())` is, so it needs **no substrate of its own** and inherits bulk-awareness,
  productivity and the `long` tag from the seam that already has them. `where(call(…).is(3))` composes
  for free, through `serviceValue`. The legacy triple this doc cites (`scopedMovementCount` →
  `pushChildScope` + `lowerScopedScalarReducer`) is DELETED; `site.child.scalar(body, site.host)` is
  the whole mechanism. **Read that file before writing an algorithm service** — the lesson is that a
  service should NAME steps rather than build SQL.
- **A position check is a THROW, not a decline** (§6·5). A `streaming` service called at a `start`
  position is invalid Gremlin, and there is no other spine to hand it to — so it raises with a message
  the user must see. The same rule kills the whole class of "silently answered a narrower question".
- **A resume cannot decline**, so a step after a barrier that the tail cannot serve RAISES naming the
  step. Good for us: an algorithm cannot half-work.
- **A data-sized row set crosses the boundary as ONE JSON bind** exploded by `json_each` (§6·2). A
  score relation is data-sized by definition, and a `VALUES (?,?,…)` re-injection would be a hard DO
  failure at 100 binds while passing every Bun test (measured: a 26-row federated hop, exactly that).
- **The barrier `resolve` no longer takes a `Query`.** A `rel` service composes an algebra RelIR names
  and renders once; a service holding a CTE accumulator would be a second bind-ordering authority.
- ⚠️ **The correction:** `decorate` cannot be the barrier's landed rows — they are DETACHED. See the
  result-contract section above; this is the one place the original design needs rework, and the fix
  (a retained binding, §3.0) is a concept that did not exist when this was written.

---

## The four built-in native steps

All four parse (verified in `parser/`). Three share one template; `shortestPath` is its own shape.

| Step | Grammar overloads | Desugars to | Result contract |
|---|---|---|---|
| `pageRank()` | `_Empty`, `_double` (damping α) | `mogwai.pageRank` | decorate vertex w/ score under `gremlin.pageRankVertexProgram.pageRank`, pass through |
| `connectedComponent()` | `_Empty` | `mogwai.wcc` | decorate vertex w/ component id under `gremlin.connectedComponentVertexProgram.component`, pass through |
| `peerPressure()` | `_Empty` | `mogwai.peerPressure` | decorate vertex w/ cluster id, pass through (same template as WCC) |
| `shortestPath()` | (check grammar for `with()` config) | `mogwai.shortestPath` | **path-shaped** — emits paths, not decorated vertices; a single `Recursive` term under §1's P1/P2 |

**Template A (pageRank / connectedComponent / peerPressure):** global barrier compute → `id→value`
retained binding → per-traverser correlated read, element-preserving, decorated under the canonical key.
**Template B (shortestPath):** one `Recursive` term producing paths, landing in the **path channel**
(one JSONB array, positions rebuilt as a typed tree — already live for `path()`); no barrier needed for
unweighted. P1 governs its shape and P3 is why a weighted variant cannot relax inside the term.

**Research the exact result property keys + `with()`/`by()`/`times()` modulator surface** against the
pinned features (`vendor/tinkerpop`, `gremlin-test/.../features/`) before implementing — the canonical
keys are what the conformance scenarios assert on.

---

## Worked example — PageRank (the proof-of-concept)

### 1. The desugar Pass (`extract` category)
In `src/compiler/ir/passes.ts` (body in `ir/strategies.ts`), a Pass that rewrites:
```
{ name: 'pageRank', args: [] }        → { name: 'call', args: ['mogwai.pageRank', { dampingFactor: 0.85, maxIterations: 20, tolerance: 1e-6, resultKey: 'gremlin.pageRankVertexProgram.pageRank', mode: 'decorate' }] }
{ name: 'pageRank', args: [0.9] }     → …same, dampingFactor: 0.9
```
Register in the `extract` group of the flat `PASSES` array. Commit an ordering/rewrite test in
`test/compiler/passes.exec.test.ts` (the family that pins pipeline invariants).

### 2. The barrier service (`src/services/catalog/pagerank.ts`)
A `Service` with `type: 'streaming'` (per-parent, element-preserving) whose contribution is
`'barrier'`. The barrier callback (host-driven, runs between SQL segments — the async gap
`compiler/rel/segment.ts` and `execute.ts`'s `drive` already provide, and the only await in the
executor's segment loop):

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
- Dangling-node mass (sinks) handled the standard way (redistribute, or fold into the teleport term) —
  **research the exact handling the conformance scenarios expect.**
- Convergence: stop at `maxIterations` or when `MAX(ABS(rank - prev)) < tolerance`.
- The traverser-`bulk` column and the `movementCollapse` fast path (`src/compiler/rel/lower.ts`'s
  `coalesce`, gated per POSITION by `bulkObservedFrom` — `src/compiler/ir/bulk.ts`) are the model for
  the frontier arithmetic.
- ⚠️ **Two mechanism gaps this sketch assumes and the platform has not been measured on.** (a) `pr`
  as a **`TEMP` table**: ✅ **MEASURED (2026-08-21) and the answer is NO** — `CREATE TEMP TABLE` on DO
  SQLite is authorizer-refused (`SQLITE_AUTH`; `test/cf-probe/substrate-b.probe.ts`). Do NOT design on a
  temp table. The substrate is instead **substrate (A) ITERATED** (`docs/2026-08-21-barrier-substrate-
  design.md` §(B)): each round crosses the `(id, score)` vector as ONE `json_each` bind and the
  relaxation is one pure-SQL statement — measured working (15 rounds / 100 nodes). A retained `Binding`
  (§3.0) is the in-plan equivalent when the loop stays within one compile; neither needs DDL.
  (b) A barrier's `apply` returns **`ForeignRow[]`** — detached vertices/edges — not arbitrary
  `(id, score)` tuples. An iterative algorithm's product is a NUMERIC relation, so either the
  contribution shape widens or the loop retains its result as a binding rather than returning it
  through `apply`. The second is the one that also fixes `decorate` (see the correction above), which
  is why it is the recommendation and not a coin-flip.

### 3. Binding back to traversers (the three tails)
- **decorate mode** (native step): `pr` is a **retained binding** (§3.0 — a `Ref` the following
  algebra reads, not a re-sourced relation), and the score is a `ChildValue` whose expression is a
  correlated read of it, contributed as `{kind:'value'}` exactly as `tinker.degree.centrality` does.
  The stream stays ELEMENTS, so `order()/by()/values()` compose through the ordinary element tail.
  **Not** a landed foreign relation — see the correction above; that trades live adjacency for a
  snapshot and makes `order().by(resultKey)` raise.
- **stream mode**: a source-form `{kind:'relation'}` contribution selecting `pr` as `{node, score}`.
- **mutate mode**: write `pr` into `vertex_properties` via `applyVertexProperty` (single cardinality),
  keyed by `resultKey`. Then normal queries read it. **A data-sized row set crosses as ONE JSON bind**
  exploded by `json_each` (§6·2, root `CLAUDE.md`) — never `VALUES (?,?,…)`, which passes on Bun's
  65 535-bind cap and is a hard failure at the DO's 100.

### 4. DO budget reality
~20–50 iterations × O(E) each. For low-millions of edges this is seconds; for larger, run under a DO
**alarm** and checkpoint `pr` across invocations. `stats`/`stream`/`mutate` all tolerate that;
**`decorate` in a live query does not (must finish in-request)** — research the alarm/checkpoint handoff
if we want decorate on large graphs, else fail closed with a size deferral.

⚠️ **Every latency claim above is a claim about the ACCESS PATH, and §1's P4 constrains how it may be
earned.** DO SQLite accepts `ANALYZE`/`PRAGMA optimize` but **refuses `PRAGMA analysis_limit` with
`SQLITE_AUTH`**, so an unbounded `ANALYZE` is O(graph) on the DO's serial request budget and cannot be
capped there. Consequence for this plan: an iteration's plan must be **stable without statistics** —
pinned at compile time from what the query already states (`Join.ordered`, the source seek), exactly as
the rest of the lowering does — and **a benchmark must `ANALYZE` or it measures the wrong plan**
(measured elsewhere: ~9.8 s → ~19 ms on one filtered 1-hop lookup). A design that needs the planner to
guess well is not shippable here; `test/plan-stability.test.ts` is the gate that says so.

---

## Naming & namespaces
- Native step names: **verbatim** (`pageRank`, `peerPressure`, `connectedComponent`, `shortestPath`).
- Canonical service names: **`mogwai.*`** (`mogwai.pageRank`, `mogwai.wcc`, `mogwai.louvain`, …).
- Optional **`gds.*` aliases** for onboarding — thin registry aliases, provenance clear.
- Algorithms with **no** native step (Louvain, betweenness, node similarity, …) are `call()`-only.

---

## Guardrails (encode as tests before/with the work)
1. **Named steps never lower directly** — a `passes.exec` test asserting each of the four rewrites to
   its `call` form. The "one engine" invariant.
2. **Mode equivalence** — `stream` vs `mutate` vs `decorate` produce consistent scores for the same
   config (a `services`/`exec` test).
3. **Fail-closed deferrals** — Tier-3 algos and SQL-inexpressible configs throw a clear deferral (never
   JS-filter, never mis-execute). Test the throw + message.
4. **Conformance** — add the algorithm cucumber tags to `test/L3-conformance/tags.ts` as steps land;
   confirm the reclaimed OLAP scenarios pass and the L3 ratchet only goes up. L1 corpus stays 100%.
5. **SQL snapshots** assert semantic equivalence, not byte-identity (per CLAUDE.md).

---

## Open research for the next agent — in compounding-substrate order

Substrate that unlocks several algorithm families first; leaf, single-algorithm questions last.

1. ✅ **ANSWERED — barrier/segmented-plan wiring.** It is BUILT and in production use by `federate` and
   `io`: the boundary is `src/compiler/rel/segment.ts` (`segmentPlan` → `midSegment`/`sourceSegment`),
   the rows land through `src/compiler/rel/foreign.ts` (`foreignRelation`, one JSON bind), the rest of
   the chain is `lowerForeignResume`, and the trampoline is `execute.ts`'s `drive`. Four facts a
   design here must respect: the head projects only the injected VALUE (`BarrierInput` is
   `{injectedValue?}`), a data-sized set crosses as ONE JSON bind, **a resume cannot decline** (an
   unsupported step after a barrier RAISES, naming the step), and landed rows are DETACHED. What is
   NOT answered is the piece §"the three tails" now names: whether a `decorate`-mode global compute
   can complete in-request, and the retained-binding shape that keeps its stream live.
2. ✅ **ANSWERED — recursive-term limits are now LAW**, `docs/2026-08-01-relir-build-plan.md` §1: **P1**
   the recursive reference appears exactly once at the top level of the term's `FROM` ("top level" = the
   join TREE, so `project(join(self, edges))` is legal; `src/rel/block.ts` is the one authority);
   **P2** `NOT EXISTS`, joins against a derived `UNION`, `IN (SELECT …)`, correlated scalars and
   multi-hop join chains are all LEGAL in a term — the unexploited headroom the Tier-1 path family
   should spend; **P3** no per-iteration barrier and no collapse is expressible in a term, in ANY
   lowering (`DISTINCT` inert, `LIMIT`/`ORDER BY` cap the whole CTE, `GROUP BY … SUM(bulk)` is an
   aggregate) — which is exactly what forces host-driven iteration for every algorithm needing one, and
   is `repeat()`'s two regimes (§9). Do not re-derive any of this.
3. **Exact result contracts** of the four native steps against pinned features (unlocks the four steps +
   OLAP conformance): canonical property keys, the `with()`/`by()`/`times()` modulator surface,
   `shortestPath` config (`ShortestPath.target`/`.edges`/`.distance`), and which conformance scenarios
   are currently OLAP-excluded and reachable.
4. **Where an iteration's state LIVES** (substrate — unlocks every iterative algorithm, and the
   `decorate` tail with it). Two candidates and they are not equivalent: a `TEMP` table (unmeasured on
   DO SQLite — probe `test/cf-probe/` first; §1 says nothing about DDL) versus a **retained `Binding`**
   (§3.0, `retained(binding)` = `isStmt(node) || snapshot`, a `Ref` resolving to the rows as one JSON
   bind). The binding needs no DDL, is already `checkPlan`-proven, and is the shape `decorate` requires
   anyway. Settle this before writing an algorithm. **This is barrier output-shape substrate (B) in
   `docs/2026-08-21-barrier-substrate-design.md`** — the SAME temp-table-vs-`Ref` question federate-
   subgraph raises; that note also fixes the barrier's sync/async axis (OLAP is async/yielding — it must
   NOT busy-lock the DO across its iterations; §"occupancy").
5. **DO alarm checkpointing** for large-graph iterative jobs (`stream`/`mutate`/`stats` only).
6. **PageRank dangling-node handling** the conformance scenarios expect (leaf — PageRank only).
7. **Louvain** feasibility spike (batch synchronous local moves + coarsening) — quality vs GDS, and
   whether it's worth shipping as "approximate" (leaf feasibility).
