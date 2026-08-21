# Graph Algorithms — a GDS-competitive, TinkerPop-compatible algorithm layer

**Status: INTENDED future work, not scheduled. Design/research only — nothing built. Reviewed
2026-08-13 against the RelIR spine.** OLAP is **no longer a locked non-goal**: the intention is to
implement it. Not in `docs/outstanding-work.md` because no tranche is scheduled, and until one lands
the four named steps fail closed. Names the open research where it matters.

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
   statement per iteration against a temp table. Each statement is pure SQL. Classic "Pregel-in-SQL" /
   BSP, **not** interpretation.
2. **One implementation, two front-ends.** The algorithm lives once, as a `call()` service. Named
   TinkerPop steps are **desugar Passes** to it — never a second lowering (enforced by test; see
   Guardrails).
3. **Reuse-first vocabulary.** Native TinkerPop names verbatim (they parse; stock clients emit them;
   conformance references them). Our extensions are `mogwai.*` (per the project rule); `gds.*` may be
   offered as *aliases* for onboarding but we do not squat that namespace.
4. **The `call()` surface is the superset, and it mirrors GDS's own shape.** GDS is itself call-based
   (`CALL gds.pageRank.stream/.mutate/.write/.stats`). We mirror those **modes** so Neo4j users see a
   familiar surface and we get write-back for free.
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

### GDS-style modes on the `call()` surface
- `stream` — return `{node, score}` rows (the source-form `{kind:'relation'}` contribution).
- `mutate` — write score back as a vertex property via the existing write path (`applyVertexProperty`,
  `src/bulk.ts`); then it's a normal queryable property. The ergonomic escape hatch; moots the
  return-shape question, and the only mode that needs nothing new.
- `stats` — return only the summary (iterations, didConverge, distribution).
- The native TinkerPop step ≈ a *fourth* "decorate-in-flight and continue" mode (per-traverser
  correlated read of a retained relation, element-preserving) — same engine, different tail.

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
  as a **`TEMP` table**: §1's envelope covers CTEs, `RETURNING` and the recursive-term laws but says
  nothing about `CREATE TEMP TABLE` on DO SQLite — probe it in `test/cf-probe/` before designing on
  it, and note that a retained `Binding` (§3.0) is the substrate answer that needs no DDL at all.
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
