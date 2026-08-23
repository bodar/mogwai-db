# Barrier substrate reshape — from single-scalar fixpoint to a general per-node schema

**Status: SUBSTRATE COMPLETE (2026-08-23) — all phased items 1–6 landed + a GDS-style algorithm
library built on it.** Supersedes the "output shape" half of `docs/2026-08-21-barrier-substrate-design.md`
for the OLAP/graph-algorithm barriers. Generalized `barrier_relation` →
`barrier_state(run,round,scope,id,channel,cval)`, grounded in the vendored `vendor/gds` (Neo4j GDS
Pregel) as the shape reference. The authority is the code (`src/storage.ts`, `src/compiler/rel/segment.ts`,
`src/services/catalog/olap/` — split from the former `graph-algorithms.ts` into a shared `kernel.ts` +
one file per algorithm); this doc is the mental model + landing record.

**All three `barrier_state` dimensions and all four barrier OUTPUT shapes now exist, each exercised by a
real algorithm:**
- dimensions: **multi-channel** (HITS hub+auth) · **scope key** (closeness/harmonic/Brandes, per-source) ·
  **keep-all rounds** (Brandes reverse pass).
- output shapes: **decorate** (per-vertex score) · **path** (shortestPath) · **detached rows**
  (federate/io) · **pair-maps** (nodeSimilarity — a stream of `{node1,node2,similarity}` maps).
- **Algorithm library (`src/services/catalog/olap/`), all GDS-oracled, `do`-residency ones real-workerd
  validated:** shortestPath, wcc, pageRank, peerPressure, hits, closeness, harmonic, triangleCount,
  localClusteringCoefficient, kcore, betweenness, nodeSimilarity. (degree is `tinker.degree.centrality`.)
- **Remaining GDS candidates all REUSE existing shapes** (scc, labelPropagation, articleRank, eigenvector,
  louvain) — more algorithms, no new substrate. Eigenvector's GDS Pregel formulation is finicky to
  exact-match (A+I, one-step message lag) — deferred, noted in-session. Modes: one shape (decorate/etc.)
  per algo; NO GDS stream/stats/mutate matrix — the traversal after the call is the mode (user decision,
  revisit only on concrete need).

## 1. The finding — `barrier_relation` is GDS's `SingleNodeValue` special case

The landed scratch table (`src/storage.ts:120-123`) is:

```sql
CREATE TABLE barrier_relation(
  run INTEGER NOT NULL, round INTEGER NOT NULL, id INTEGER NOT NULL, cval,
  PRIMARY KEY (run, round, id)) WITHOUT ROWID
```

One untyped `cval` per `(run, round, id)` — exactly one scalar per node per round. It is precisely
right for the family it was built for: **symmetric, order-independent, single-scalar fixpoint
propagations** — WCC (min-label), peerPressure/LPA (cluster), PageRank/ArticleRank/Eigenvector
(rank). All landed or a trivial variant.

The vendored reference names this shape exactly. GDS Pregel's `NodeValue`
(`vendor/gds/pregel/src/main/java/org/neo4j/gds/beta/pregel/NodeValue.java:48-124`) has two forms:
a **`SingleNodeValue`** (one columnar array, the 1-property fast path) and a **`CompositeNodeValue`**
(a `Map<propertyKey, HugeArray>` — one array per named property). The schema is declared up front as
a **`PregelSchema`**: a set of `(propertyKey, ValueType)` elements, where `ValueType ∈ {LONG, DOUBLE,
LONG_ARRAY, DOUBLE_ARRAY}` (`.../pregel/PregelSchema.java:22-45`, `.../NodeValue.java:42-45`).

**`barrier_relation` IS `SingleNodeValue`.** Every Tier-2 algorithm needs `CompositeNodeValue`, and
some need more than that. This is not a tweak to the existing table; it is building the general thing
the current one is a degenerate case of.

## 2. The three limits (each blocks a Tier-2 family), and the substrate basis

Measured per-node iteration state for every Tier 1/2 family (`docs/2026-07-24-graph-algorithms-plan.md`
§Feasibility tiers):

| Limit | Root cause in code | Blocks |
|---|---|---|
| **value width** — one `cval`/node | `PRIMARY KEY(run,round,id) WITHOUT ROWID` (`storage.ts:122`) | HITS (hub+auth), **Bellman-Ford (dist + predecessor-set)**, Prim (in-tree?, min-edge, endpoint), Louvain (community+weight) |
| **key shape** — node-keyed only | `id` is the sole non-run/round key | Brandes betweenness, closeness/harmonic (per-**(source,node)**), node-similarity (per-**(u,v)**) |
| **retention** — 2-slot overwrite | `Slot=0\|1`, `DELETE next before write` (`graph-algorithms.ts:104`) | Brandes reverse-BFS backward pass, MST/Louvain accumulating output, per-level coarsening |

And a fourth fact that is not a limit but a boundary: **not everything is a `barrier_relation` at
all.** BFS/DFS/topological-sort/DAG-longest-path/unweighted-shortest-path are the **recursive-CTE
path-channel** substrate (`src/compiler/rel/shortestpath.ts`, P1/P2 of the RelIR build plan), not a
BSP `apply` loop. The substrate is a **basis of ≥2 shapes**, and **weighted shortestPath sits on the
seam** — a relaxation *barrier* (dist + predecessors, needs the value-width fix) feeding *path
reconstruction* (the path channel). That seam is the concrete forcing function (see §5).

## 3. THE UNIFICATION — the extra key dimension is ONE mechanism serving THREE needs

The central insight of this synthesis, and the reason "go further" is cheaper than it looks:

**A `scope` key column added to the working-state relation simultaneously answers Brandes's source
dimension, node-similarity's pair anchor, AND a nested barrier's enclosing-parent id.** They are the
same feature.

- **Brandes / closeness**: state is per **(source, node)** — `scope = source vertex`.
- **Node similarity**: per **(u, v)** pair — `scope = u` (the anchor), `id = v`.
- **Nested barrier in a per-parent body** (`group().by(__.call(pageRank))`, `local(__.…pageRank())`):
  the barrier runs once per enclosing group/parent — `scope = parent id`. A nested barrier is just a
  **scope-keyed** barrier whose scope is the enclosing traversal position's parent.

So the pair-keyed reshape (chosen for Tier-2 centrality) and the barrier-in-body nesting (chosen as
the nesting target) are **the same substrate primitive**: a scope dimension on the working state, and
a batch-promotion of the enclosing chain that runs the barrier once, keyed by scope, and rejoins
per-scope. Build it once; both land on it.

## 4. The target shape

DO SQLite forbids runtime DDL (no `TEMP` table — `SQLITE_AUTH`; no per-run `CREATE`/`ALTER`; measured,
`docs/2026-08-21-barrier-substrate-design.md` §(B)). So a per-barrier declared schema (GDS's approach,
which lives in JS heap arrays) must be carried in ONE pre-created generic table whose *rows* encode the
schema — the EAV/channel form is the only DDL-free way to hold a variable per-node schema.

### 4.1 Working state — one general relation

```sql
CREATE TABLE barrier_state(
  run INTEGER NOT NULL, round INTEGER NOT NULL,
  scope INTEGER NOT NULL,        -- the extra key dim (§3): 0 for node-keyed; source/anchor/parent otherwise
  id INTEGER NOT NULL,
  channel INTEGER NOT NULL,      -- the named property (GDS PregelSchema element); a small int per declared channel
  cval,                          -- untyped storage class (scalar); array/set channels hold a json array
  PRIMARY KEY (run, round, scope, id, channel)) WITHOUT ROWID
```

- **`channel`** = `CompositeNodeValue`'s property key, as a small int the barrier declares (dist=0,
  pred=1, …). A single-scalar barrier declares one channel; the WITHOUT-ROWID PK still holds one row
  per `(id, channel)`, so the WCC/pageRank case is `scope=0, channel=0` and pays two constant key
  columns — negligible under a covering PK.
- **`scope`** = §3's unifying dimension. `0` for the node-keyed fixpoint family.
- **array-valued channels** (predecessor sets, `LONG_ARRAY`) hold a `json_group_array` in `cval`, with
  set-union relaxation and set-comparison convergence — the one shape neither `MIN`/`SUM` aggregation
  nor scalar `IS NOT` distinctness covers, called out in the plan doc's Bellman-Ford correction.
- **retention** is a declared POLICY on the driver, not a fixed 2-slot alternation: `keep-2` (fixpoint
  propagation, today's behaviour), `keep-all` (Brandes needs every round for the reverse pass), or an
  `accumulate` output relation (MST edge-set, Louvain communities) that grows rather than overwrites.

### 4.2 Output / resume side — plural channels + new arms

`BarrierRelation`/`DecorateSpec` (`src/services/spi/types.ts:139-163`) are singular
(`{kind:'relation-ref', run, round}`, one `{key, vtype}`). They become plural and gain arms:

- **multi-channel decorate**: `DecorateSpec` → a set of `{key, channel, vtype}`; `decorateGraph`
  (`src/compiler/rel/decorate.ts`) joins per channel. Serves HITS-style multi-property decoration.
- **path-relation output** (the seam, §5): a barrier whose product is a set of path rows, framed by
  `pathPositions` — a genuinely new `BarrierOutput` arm beyond `ForeignRow[]` / id→scalar.
- **scope-keyed resume**: the resume join carries `scope` — for Brandes the aggregation over sources,
  for a nested barrier the per-parent rejoin.

`SingleNodeValue` stays as the degenerate case (scope=0, one channel), so the three landed algorithms
migrate to `barrier_state` with no behaviour change — ONE authority, not a fork kept beside it (the
GDS split is an in-heap perf optimization we do not need at SQL-row granularity).

## 5. The forcing function — weighted shortestPath (Phase 2 of the shortestPath work)

Weighted shortestPath is the first consumer, and it exercises the value-width fix and the path-output
arm together:

1. a **relaxation barrier** (Bellman-Ford, V−1 rounds, negative-weight-safe — which is why weighted
   `maxDistance` is a final filter not a prune) computes two channels per node on `barrier_state`:
   `dist` (channel 0, REAL) and `pred` (channel 1, a `json_group_array` of predecessor edges — the
   set-valued channel);
2. a **recursive CTE reconstructs paths over the pruned predecessor DAG** (dist strictly decreases →
   acyclic → enumerates only the actual shortest paths, not all simple paths — the fix for the
   `9b77dd5` hang);
3. framed via `pathPositions` — the new path-relation output arm.

This validates §4.1 (multi-channel + array channel) and §4.2 (path output) on a real, tested target
before any speculative widening. Per the shipping discipline in
`docs/archive/2026-08-09-repeat-two-regimes-plan.md` §8: land the general table declining, then admit
shapes one consumer at a time.

## 6. Nesting — barrier inside a body (the walled target)

`segmentPlan` runs once over the flat top-level chain (`src/compiler/compiler.ts:85`); `barrierIn`
(`segment.ts:67`) never descends into a `repeat`/`local`/`union`/`by`-child body; `Plan` is a linked
list, not a tree (`src/compiler/segment.ts:91` — cannot hold two pending segments); the child seam has
three answers and no async one (`src/compiler/rel/child.ts:74-101`); `drive.ts` is a flat `while` with
one await, not a stack. Run tokens/rounds are ALREADY nesting-safe (global autoincrement `run`,
run-scoped slots, multi-run GC) — the entire gap is compile-time.

The wall is real and partly permanent:

- **Unbounded `repeat()` body**: a barrier there is **algebraically impossible** — P3 (no async, no
  per-iteration collapse in a recursive SQL term). Fail closed forever; do not chase.
- **Everywhere else** (`local`, `union` arm, `by`-child, **bounded** `repeat` which unrolls to N
  sequential positions): reachable by **promotion** — lift the barrier out of the body by promoting
  the enclosing chain to a segment boundary. The head computes the body's per-parent input as ONE
  batch relation (keyed by the enclosing parent id); `apply` runs the barrier ONCE over that batch,
  keyed by `scope = parent` (§3); the resume rejoins per parent. This is `midSegment` generalized from
  a top-level index to an arbitrary nested position, and it needs: (a) a tree-aware finder; (b) `Plan`
  as a tree / `drive` as a stack; (c) the `scope` key from §4.1; (d) sequential barrier chaining
  first (bounded-repeat unroll produces N sequential barriers, and today even sequential decorate
  barriers don't re-enter `planOf` — only the sync value-transform ones do).

So barrier-in-body is: **`scope` key (§4.1) + batch promotion + a tree Plan + sequential chaining**,
with unbounded-repeat permanently fail-closed. The `scope` dimension is shared with §3, which is why
this target and the pair-keyed reshape are one build, not two.

## 7. Phased plan (green trunk per increment)

1. ✅ **LANDED (`e4c6c8c`) — `barrier_state(run,round,scope,id,channel,cval)`, the 3 algorithms
   migrated** to `scope=0, channel=0`. Behaviour-preserving: L3 1736 and census 1546-ran both
   unchanged. `barrier_relation` renamed to `barrier_state`; the shape centralised into `STATE_INSERT`
   + `VEC` (`graph-algorithms.ts`) so the Tier-2 consumers extend one place; delta helpers join on the
   full `(id,scope,channel)` key. One authority, no `SingleNodeValue` fork.
2. ✅ **LANDED (`48c1470` substrate, `3c520d0` consumer) — multi-channel decorate + `mogwai.hits`.**
   `DecorateSpec` is now `{ channels: {key, channel, vtype}[], seedFromInput? }`; `decorateGraph`/
   `decorateBinding` take a `channel` (name `_mogwai_decorate_r<run>_c<channel>`, filter pinned
   `scope=0 AND channel=<channel>`) and the decorate resume STACKS one layer per channel (reusing item
   4's stacking). The consumer that makes it real is **HITS** (`mogwai.hits`, call-only, GDS-style):
   hub=channel 0, auth=channel 1, a faithful SQL replay of the Wikipedia iteration GDS's own test
   asserts against (`vendor/gds/.../hits/HitsTest.java` `PseudoCodeHits`, GPLv3 — re-expressed). L2 norm
   in JS (no `sqrt` SQL fn assumed). Oracle test ports GDS's 8-node graph + pseudocode, matches to 10
   digits at 30 iters; validated on real workerd (olapContract — the two-channel read + in-place UPDATE
   normalise). **Corpus absence is NOT a skip** (root SCOPE.md): `call()` is the extension surface, GDS
   the reference + test source. This is the workflow for the rest of the Tier-2 family.
3. **Weighted shortestPath (§5)** — the relaxation barrier + reconstruction, un-defers `9b77dd5`. **L3 +3.**
   - ✅ **3a LANDED (`2b48641`) — the relaxation core.** `relaxWeighted` (Bellman-Ford dist, scope=source,
     channel 0) on `barrier_state` — the first scope+channel consumer, reusing `iterateInSql`. Design
     simplification: NO predecessor channel — an edge (u,v) is a shortest-path edge iff
     `dist[s][v] = dist[s][u] + w`, so reconstruction derives from dist alone. New `changedOrNew`
     fixpoint (LEFT JOIN) for the sparse frontier. Tested: correct on modern, TERMINATES on grateful
     (367ms) where the walk hangs. Not yet wired (weighted still fails closed).
   - ✅ **Reconstruction ALGORITHM proven** (`test/L2-sql/shortestpath-bsp.exec.test.ts`): a dist-gated
     recursive CTE over `barrier_state` rebuilds `marko→josh = [marko,lop,josh]` exactly. This raw SQL is
     the executable SPEC the rel port must reproduce (seed from `DISTINCT scope`; step joins the weighted
     adjacency + `barrier_state du`(=dist[s][u]) + `dv`(=dist[s][v]), gate `dv.cval = du.cval + w`, plus a
     `json_each` simple-path backstop for zero/negative weights; append via `json_insert($[#])`).
   - ✅ **3b LANDED (`0dd4ac4`) — the compiler port + wiring, L3 1736→1739.** `createShortestPathService`
     (store-capturing, DUAL resolve: weighted→barrier, unweighted→walk); `PathSpec` on the barrier
     contribution; `pathSegment` (head = source ids, apply = `relaxWeighted`, resume = `lowerPathResume`);
     `shortestPathReconstruct` (reuses `pathPositions`, guard = dist-gate `dv=du+w` float-exact +
     simple-path backstop, no MIN window). The grateful scenario that HUNG the walk now terminates and
     passes. First end-to-end consumer of barrier_state's scope + channel dims.
   - ✅ **3c LANDED via B (sync-driveable barriers).** The census/sync path could not drive an async
     barrier, so unweighted-shortestPath-as-barrier lost sync execution (the revert below records the
     attempt). Resolved by giving the OLAP barriers a SYNCHRONOUS CORE (`applySync`): production keeps the
     async `apply` (yields, no DO busy-lock — the occupancy axis is load-bearing, per the user), the
     sync/test drive runs the core (busy-lock fine). Then ALL shortestPath routes through the barrier and
     `shortestPathWalk` is DELETED — one substrate, the latent unweighted-dense hash gone. Census
     re-recorded (OLAP now runs in the sync census: ran 1546→1563, all L3-validated). L3 held 1739.
     - `494960a` — sync-apply barriers (Contribution.applySync + AsyncSegmentPlan.applySync +
       driveSegmentsSync runs the core + `syncBarrier` wrapper on all 4 OLAP services).
     - (this) — unweighted→barrier, delete the walk. maxDistance = a `dist<=cap` final filter.
   - ⚠️ **3c FIRST ATTEMPT, REVERTED — the design fork that led to B (kept for the record).** Migrating
     unweighted onto the barrier + deleting the walk was built and worked (L3 held 1739, L2 16/16), but
     the CENSUS regressed: 12 unweighted-shortestPath corpus traversals STOPPED EXECUTING. Cause is
     structural, not a bug — the census (and every sync-exec test) runs traversals through the SYNC path
     (`exec(store).framed(...)`), which cannot drive a BARRIER (an async segment). Unweighted shortestPath
     being sync-runnable via the walk (a `rel` contribution) was load-bearing; as a barrier it loses sync
     execution. **The OLAP barriers all have SYNCHRONOUS `apply`s** (relaxShortestPath / wcc / pageRank /
     peerPressure — no internal await; the async keyword buys nothing), so they COULD be driven
     synchronously — but the barrier `apply` signature is `Promise<…>`, so the sync drive can't extract
     the value. Two roads (HUMAN DECISION):
     - **A — keep the DUAL substrate (current 3b state).** Walk unweighted (sync), barrier weighted
       (async). Green. The walk's latent uncapped-unweighted-DENSE hang stays (a valid query, but no
       corpus/census scenario exercises it — they are small/capped). GDS itself ships several SP impls.
     - **B — sync-driveable `do` barriers.** Add a SYNC-apply barrier shape (a `SyncSegmentPlan` arm for
       a `do` barrier whose apply is synchronous) + a sync drive, then unweighted→barrier + delete walk.
       Bonus: the census could then run wcc/pageRank/peerPressure too (they currently defer in sync). A
       compounding substrate move, but real infra + a census re-record. This is the "one substrate" end
       state the plan named.
   - **Original 3b plan (done above):**
     1. `graph-algorithms.ts`: `shortestPathService` → `createShortestPathService(store)` (store-capturing,
        like wcc — the barrier `apply` needs the store); DUAL resolve — weighted (`SP_DISTANCE` set) →
        `{kind:'barrier', apply, path: PathSpec, residency:'do'}`, unweighted → the existing `{kind:'rel'}`
        walk. `apply(rows)`: dedup source ids from `BarrierInput`, `relaxWeighted(...)`, return
        `{kind:'relation-ref', run, round}`.
     2. `spi/types.ts`: add `path?: PathSpec` to the barrier Contribution; `PathSpec` carries the config
        the resume needs (scope {direction,labels}, distanceKey, includeEdges, target IR, maxWeight).
     3. `segment.ts`: `Barrier.path`; `barrierIn` carries it; `segmentPlan` dispatch `if (call.path) →
        pathSegment`; `pathSegment` mirrors `decorateSegment` (head = prefix `.id()` sources) but
        `resume → lowerPathResume`.
     4. `shortestpath.ts` / `lower.ts`: `shortestPathReconstruct(run, round, cfg, source, child, fresh)` —
        adapt `shortestPathWalk`: seed from `barrier_state` DISTINCT scopes; carry `dist` (seed 0, bump w);
        guard = `notInPath` AND the dist-gate (`dv` a `{kind:'scalar'}` subquery over `barrier_state`,
        run/round inlined like `decorateBinding`); DROP the final `MIN` window (the gate makes every path
        shortest); keep target/includeEdges; `maxWeight` a final `dist <= cap` filter; then `pathPositions`.
     5. `standard.ts`: register `createShortestPathService(app.store)`; drop the const from
        `pendingGraphAlgorithmServices`.
     Then un-defer: restore the two L2 weighted tests as real answers; **L3 +3** (incl. the grateful hang
     scenario, now terminating).
4. ✅ **LANDED (`44fc8f8`) — sequential barrier chaining, `pageRank().connectedComponent()`.** The
   DECORATE resume no longer lowers its whole tail straight to SQL; it re-enters `planOf` on the tail,
   so a SECOND barrier there becomes its own segment. The substrate move that made it a net
   simplification (deleted `lowerDecorateResume`): a `decorateGraph` source is now **stackable** (wraps
   an arbitrary base, not hard-wired `BaseGraph`) and **self-declaring** — a new optional
   `GraphSource.bindings?(fresh)` returns the whole stack's landed `barrier_state` CTEs under
   `run`-derived names, collected at the ONE `lowered()` point, so a downstream barrier's head and the
   final resume agree on each layer's CTE name and a stack's several CTEs coexist. The trampoline was
   already chain-capable (loops on segment resumes, GCs every run token), so nothing there changed.
   **No L3 forcing function** (no corpus scenario chains OLAP) — held 1739; safety net is our own
   `test/L2-sql/olap-chain.exec.test.ts` (both scores land, either order, no corruption vs standalone).
   Foreign→barrier (`federate().pageRank()`) is deliberately NOT done — pageRank's `apply` is a global
   store compute that ignores the detached landed stream, so the composition is semantically murky;
   it stays fail-closed (`resumed`'s named-step error) until a real consumer appears.
5. **`scope`-keyed working state** — the GDS centrality family, built the way HITS was (`call()` is the
   extension surface, GDS the reference + test-oracle source; corpus absence is NOT a reason to skip).
   - ✅ **`mogwai.closeness` LANDED (`4bb6d10`)** — the first scope-keyed consumer beyond shortestPath.
     closeness = reached/farness (GDS DefaultCentralityComputer), reusing `relaxShortestPath`'s per-source
     distances directly (scope = source): relax from every vertex over REVERSED edges (`direction:'in'` —
     proven by GDS's directed test), then aggregate each scope into one score at (scope 0, channel 0).
     Both GDS test graphs ported + matched; validated on real workerd. NO new substrate needed — the
     scope key already existed. `docs/.../closeness/` (GPLv3, re-expressed).
   - ✅ **`mogwai.harmonic` LANDED (`0a03944`)** — closeness's sibling on the SAME distances (extracted the
     shared `distanceCentrality` engine; they differ ONLY in the reduction: closeness reached/farness,
     harmonic Σ(1/dist)/(N−1)). Ported + matched GDS's undirected test (0.375/0.5/0.375/0.25/0.25).
   - ✅ **`mogwai.betweenness` (Brandes) LANDED** — the first barrier that exercises BOTH remaining
     limits at once: MULTI-SOURCE (scope = source, so "Brandes from every source" is ONE level-BFS) and
     KEEP-ALL ROUNDS (round = BFS level; the dependency pass walks them in reverse). σ per level (channel
     0) forward, δ per level (channel 1) backward, betweenness = Σ over sources s≠v of δ. Directed
     (GDS default); undirected variant deferred to a `direction` param. Ported + matched GDS's
     BetweennessCentralityTest (line 0/3/4/3/0, cycle 1/1/1, diamond b=8, connected-cycles a=13, clique
     0); validated on real workerd. The retention "limit" needed no schema change — keep-all is just not
     DELETE-ing prior rounds. `docs/.../betweenness/` (GPLv3, re-expressed).
   - **Also landed this family/session (one-shot + fixpoint decorates, kernel-based):** `mogwai.hits`
     (multi-channel), `mogwai.triangleCount` + `mogwai.localClusteringCoefficient` (one-shot), `mogwai.kcore`
     (h-index fixpoint).
   - ✅ **`mogwai.nodeSimilarity` LANDED — the NEW OUTPUT SHAPE (a 4th barrier output arm).** Every prior
     barrier either decorated the live stream, replaced it with paths, or landed detached rows;
     node-similarity emits a STREAM OF MAPS `{node1, node2, similarity}` — scored vertex PAIRS. New
     plumbing: `PairSpec` + `pairs?` on the barrier Contribution; `pairSegment` (source-form) →
     `lowerPairResume`, which builds the self-describing `[[key,{t,v}],…]` blob per pair (`typedNode`) and
     frames it through the existing `mapValue` wire form (`framed`'s `map` arm → `mapPayload`) — so NO new
     wire/framer code, just a new resume that produces a `MAP_COL` blob. Jaccard of out-neighbour sets in
     ONE SQL statement (a neighbour self-join). Matched a bipartite oracle + validated on real workerd.
     `docs/.../similarity/` (GPLv3, re-expressed).
6. **Barrier-in-body (§6).** A COMPOSITION target — pageRank/wcc work, and the body constructs work,
   so a barrier inside one must too. Two regimes, split by whether the body flattens:
   - ✅ **Slice 1 LANDED (`005e2a4`) — barrier in a BOUNDED `repeat` body**, via the unroll. A bounded
     `repeat(body).times(n)` already unrolls to a FLAT sequence of phases (`unrollFixedRepeat`), so a
     barrier `call()` there becomes n SEQUENTIAL top-level calls that item 4's chaining drives — ZERO
     tree-Plan machinery. Admitted `call` to `unrollableBodyStep` (non-emit only; emit = union arm =
     the promotion case); a `call` this route can't chain fails closed at its resume; the widening is
     not suppressed by `withoutStrategies(RepeatUnrollStrategy)`. L3 1739, census flat.
   - **Slice 2 (the big one) — per-parent nesting by PROMOTION** (`local`, `union` arm, `by`-child,
     and the UNBOUNDED-repeat body which cannot unroll). Needs the tree Plan + drive-as-stack + a
     tree-aware finder + the `scope=parent` key (§4·1, shared with item 5). ⚠️ For the OLAP barriers
     this also hits the **graph-filter blocker** ([[olap-decorate-substrate]] — per-group pageRank is a
     subgraph-scoped compute, unresolved), so its clean consumer is not yet obvious; unbounded-repeat
     bodies stay P3 fail-closed forever regardless. Weigh against resolving graph-filter first.

Items 1–4 are the shortestPath Phase 2 rebuild in general clothing plus its chaining; 5–6 are the
nesting + Tier-2 centrality reach. Each is an independently green push.

## 8. Robustness — the resident-table hazard the 2026-08-21 doc flagged ✅ LANDED (`b86dc41`)

A resident scratch table leaks on crash: run-token GC (`frameResolved`'s `finally`,
`src/execute.ts`) fires only on the happy path (via `plan.cleanup`, populated only once the FULL chain
drove), so a chain that THROWS at a later resume — after an earlier `apply` wrote its rows — orphaned
them until never. Chaining (item 4) and repeat-body barriers (item 6 slice 1) made this reachable
(`pageRank().connectedComponent().has(score, v)`). TWO belts landed:
- **drop-on-throw (precise, in-isolate):** `SegmentReaders.dropRuns`; both drives (`src/drive.ts`)
  wrap their loop and drop the runs allocated so far from the catch, then rethrow — harmless on success
  (the `return` exits before the catch). The Worker edge drives only federate (no relation runs), so
  its impl is a no-op.
- **ctor sweep (hard-crash, cross-isolate):** a run is intra-request + synchronous, so at GraphStore
  construction none is live and any surviving row is a prior isolate's orphan (a hard kill runs no JS
  finally). `DELETE FROM barrier_state` in the ctor reclaims them.
Verified non-vacuous (3/4 GC tests fail without drop-on-throw) and on real workerd. Test:
`test/L2-sql/barrier-run-gc.exec.test.ts`.

## 9. GDS as prior art — where to read at the pin

- **`vendor/gds/pregel/src/main/java/org/neo4j/gds/beta/pregel/PregelSchema.java`** — the declared
  per-node schema (`{propertyKey, ValueType}` set); §4.1's `channel` is this.
- **`.../pregel/NodeValue.java`** — `SingleNodeValue` vs `CompositeNodeValue` (`Map<key, HugeArray>`);
  the shape `barrier_relation` is the single case of. `ValueType` includes `LONG_ARRAY`/`DOUBLE_ARRAY`
  — §4.1's array channels.
- **`.../pregel/Pregel.java`** — the BSP driver (init → compute rounds → reduce → converge); the
  reference for `iterateInSql`'s generalization.
- **`vendor/gds/algo/src/main/java/org/neo4j/gds/…`** — the implementations (PageRank, Louvain,
  Dijkstra, Brandes) for exact per-algorithm state + convergence rules.
- ⚠️ GPLv3: study the STRUCTURE, re-express in SQL, never transcribe (see `.gitmodules`).
