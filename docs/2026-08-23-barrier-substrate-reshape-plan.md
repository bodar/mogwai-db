# Barrier substrate reshape — from single-scalar fixpoint to a general per-node schema

**Status: DESIGN SYNTHESIS (2026-08-23), not yet built.** Supersedes the "output shape" half of
`docs/2026-08-21-barrier-substrate-design.md` for the OLAP/graph-algorithm barriers. Records the
decision to generalize the `barrier_relation` scratch table, grounded in the newly-vendored
`vendor/gds` (Neo4j GDS Pregel) as the shape reference. The authority remains the code
(`src/storage.ts`, `src/compiler/rel/segment.ts`, `src/services/catalog/graph-algorithms.ts`);
this is the mental model and the phased plan.

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

1. **`barrier_state` general table + driver, migrate the 3 landed algorithms** to `scope=0,
   channel=0`. Census/L3 unchanged by construction (same answers, new storage). One authority; delete
   nothing else yet. `barrier_relation` becomes `barrier_state` or is retired in the same move.
2. **Multi-channel decorate** (`DecorateSpec` plural). No new algorithm yet — a differential that a
   two-channel decorate reads back both channels.
3. **Weighted shortestPath (§5)** — the relaxation barrier (dist + pred-set channels) + predecessor-DAG
   reconstruction + path-output arm. Restores the `9b77dd5`-deferred weighted scenarios as real
   answers; the grateful hang scenario now terminates. **L3 +3.**
4. **Sequential barrier chaining** — decorate/foreign resumes call `planOf` (`pageRank().wcc()`).
5. **`scope`-keyed working state** — the first pair-keyed consumer (closeness or node-similarity is
   simplest; Brandes adds the reverse-pass retention policy).
6. **Barrier-in-body by promotion (§6)** — tree Plan + batch promotion, reusing §5's `scope`.
   Unbounded-repeat stays fail-closed.

Items 1–3 are the shortestPath Phase 2 rebuild in general clothing; 4–6 are the nesting + Tier-2
centrality reach. Each is an independently green push.

## 8. Robustness — the resident-table hazard the 2026-08-21 doc flagged

A resident scratch table leaks on crash: run-token GC (`frameResolved`'s `finally`,
`src/execute.ts:618`) fires only on the happy path, so a request dying mid-`apply` orphans its rows
until never. With the generalized, potentially larger and longer-lived `barrier_state` this matters
more. Add an **orphaned-run sweep** — a bounded `DELETE FROM barrier_state WHERE run NOT IN (live
runs)` at store open, or a run-age column swept on a schedule. Cheap belt for the one genuinely silent
failure mode of a durable scratch substrate.

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
