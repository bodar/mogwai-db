# 04 — Query plan inspection and profiling

**Area owner interest:** high. The owner wants an `explain()` that shows the relational algebra (RelIR)
and the generated SQL, and if possible SQLite's `EXPLAIN QUERY PLAN`. It has two purposes: debugging,
and a demonstration that mogwai-db compiles Gremlin to SQL instead of interpreting it.

**Evidence base:** trunk at `1489c279`, Bun 1.3.11, 2026-11-21. All output in §2 comes from read-only
scratch scripts that call the existing compiler functions. Nothing in the repo was changed.

**Verdict:**

| Capability | Status |
|---|---|
| A user-facing `explain()` (Gremlin terminal method) | **missing** — it declines today |
| A user-facing `profile()` (Gremlin step) | **missing** — it declines today |
| An internal pipeline whose stages are separate, inspectable values | **exists** |
| A RelIR pretty-printer | **missing** |
| SQL text and binds for a compiled traversal | **exists** (internal API only) |
| `EXPLAIN QUERY PLAN` over compiled SQL | **exists** in tests and CI gates, not for users |
| Per-statement time and row counts | **missing** |
| A plan for the feature | see `docs/2026-11-21-explain-profile-plan.md` |

The concern "you cannot see what the engine does with a query" is valid for a USER. It is not valid for
the code: every stage has a value that a small function can print. §2 shows this with real output.

---

## 1. Explanation — the compilation pipeline

*Diátaxis type: Explanation.*

### 1.1 The stages

mogwai-db turns one Gremlin string into one SQL statement (a read) or an ordered list of SQL statements
(a write program). No step runs row by row in JavaScript. Root `CLAUDE.md` locked decision 3 states this
rule.

| # | Stage | Value it produces | Code |
|---|---|---|---|
| 1 | Parse | ANTLR parse tree (cached, bounded LRU) | `src/gremlin/frontend.ts:101` `parseGremlin` |
| 2 | Front end | `Step[]` — a flat chain of `{name, args}` | `src/gremlin/frontend.ts:356` `stepChain` |
| 3 | IR passes | `IRStep[]` — the chain after rewrites | `src/compiler/ir/passes.ts:423` `runPasses` |
| 4 | Lowering | RelIR `Plan` — bindings plus a result `Rel` | `src/compiler/rel/lower.ts:4428` `lowerToRel` |
| 5 | Rel passes | the same `Plan`, rewritten physically | `src/compiler/rel/lower.ts:4372` |
| 6 | Naming | CTE boundaries decided | `src/compiler/rel/lower.ts:4376` `name` |
| 7 | Emit | SQL text plus binds, rendered once | `src/rel/emit.ts:1353` `renderLowered` |
| 8 | Assemble | `Compiled` (read) or `Program` (write) | `src/compiler/rel/spine.ts:194` `finishLowering` |
| 9 | Execute | rows from SQLite | `src/execute.ts:499`, `src/program.ts:85` |
| 10 | Frame | GraphBinary or untyped JSON | `src/execute.ts:509` `frameResolved` |

The orchestrator is `compilePlan` (`src/compiler/compiler.ts:48`). Its body, `compileUnguarded`
(`src/compiler/compiler.ts:113`), calls stages 1–8 in order.

### 1.2 Why the stages are separate values

Each stage has a closed input and output type. This is a design rule, not a side effect:

- The compiler depends only on the IR (`Step[]`). The wire format never reaches it (root `CLAUDE.md`,
  locked decision 5).
- The RelIR node set is closed: 16 relation kinds (`src/rel/rel.ts:11-50`) and 3 statement kinds
  (`src/rel/stmt.ts:18-27`).
- A plan renders to SQL exactly once (`src/rel/emit.ts:1340-1352`, the comment on `RenderedPlan`). The
  SQL that runs is the SQL that the render produced.

These properties make an `explain()` cheap to build. Each stage value can be captured and printed. No
stage has to be re-run in a special mode.

### 1.3 IR passes

A `Pass` rewrites the `Step[]` chain or verifies it and throws. The passes run in five categories:
`extract < decoration < canonicalize < simplify < verify` (`src/compiler/CLAUDE.md`). The loop is
`src/compiler/ir/passes.ts:446-453`. Line 452, `chain = pass.run(chain, ctx)`, is the one place where
the chain changes.

This is the same model as TinkerPop's `TraversalStrategy` categories. TinkerPop's own `explain()` prints
the chain after each strategy (§3.1). A mogwai-db trace at line 452 gives the same information.

### 1.4 Lowering and RelIR

The lowering is a fold over `IRStep[]` (`src/compiler/CLAUDE.md`). It produces a RelIR `Plan`:

- `bindings` — named relations or statements that run first (`src/rel/plan.ts:27`).
- `result` — the relation that the client reads (`src/rel/plan.ts:103`).

A read has no bindings that are statements. A write has one binding per statement (insert, update,
delete). A child traversal (`where`, `by`, `union`, …) lowers through the scoped-relation connector
(`src/compiler/rel/lower/scoped.ts`). The connector produces ordinary RelIR nodes (joins, `EXISTS`
expressions, aggregates). So the plan for a nested query has the same node kinds as a flat one.

`repeat()` without `times(n)` lowers to a `recursive` node (`src/rel/rel.ts:50`). That node holds its
step as a closure, `step: (self) => Rel`. A printer must call `recursiveStep` (`src/rel/walk.ts`, used at
`src/rel/check.ts:240`) to see the step body.

### 1.5 Rel passes

Physical passes run on the finished algebra before naming (`src/compiler/rel/lower.ts:4356-4375`). The
order is `fuse → leading → magic → dropUnreadJoins → semijoin`. `semijoin` holds the property seek and
the trigram seek. The `name` pass then decides which shared subtrees become CTEs. The plan before these
passes (the "logical" plan) and the plan after them (the "physical" plan) are both in memory at
`src/compiler/rel/lower.ts:4372`. Neither is kept or exposed today.

### 1.6 Execution

| Plan kind | How it runs | Code |
|---|---|---|
| `read` | one `store.query(sql, binds)` | `src/execute.ts:499` |
| `program` | each step in order, in one atomic unit | `src/program.ts:75-121` |
| segment (barrier) | head read, then an async or sync barrier, then a resume compiled at run time | `src/drive.ts:51`, `src/drive.ts:82` |

Every statement on both runtimes passes through `GraphStore.query` (`src/storage.ts:364`). A program
passes through `runStepsIn` (`src/program.ts:85`), which calls `store.query` once per step at
`src/program.ts:105`. These two lines are the natural places to measure time and row counts.

On Cloudflare, the Worker compiles and the Durable Object (DO) executes
(`src/cloudflare/cloudflare-graph-manager.ts:29-38`). Only the rendered SQL crosses the RPC. The RelIR
`Plan` cannot cross, because it holds closures and symbol brands (`src/program.ts:15-24`). So an
`explain()` must render its RelIR text where the compile runs. The JSON response path does not compile
on the Worker; the DO compiles it (`src/cloudflare/cloudflare-graph-manager.ts:60`).

---

## 2. Worked example — Step[] → RelIR → SQL → SQLite plan

*Diátaxis type: Explanation (measured output).*

**Method.** A scratch script called `parseGremlin`, `stepChain`, `runPasses`, `lowerToRel` (with
`loweringOptions`) and `compile`. It printed each value. It ran the SQL against the modern graph from
`test/support/harness.ts` `seededStore`. The RelIR tree is printed by a 10-line ad-hoc walker over
`input`/`left`/`right`/`seed`/`inputs`. It does not print expressions or correlated subplans inside
expressions. The traversal is the `1-hop` shape from `test/plan-stability.test.ts`, on the modern graph.

```
g.V().has('person','name','marko').out('knows').values('name')
```

### 2.1 Step[] (front end) and IRStep[] (after passes)

```
V().has("person", "name", "marko").out("knows").values("name")      -- Step[]
V().has("person", "name", "marko").out("knows").values("name")      -- IRStep[] (no pass changed it)
```

With a parameter (`has('person','name',who)` and `bindings: {who: 'marko'}`), the step argument keeps
its name: `has("person", "name", $who)`. The SQL then has one `?` and `binds = ["marko"]`. This is the
bind rule from root `CLAUDE.md`: only a user parameter becomes a bind.

For `g.V().has('name','marko').repeat(out()).emit().values('name')`, the passes fold `emit()` into the
repeat region. The `IRStep[]` is `V().has(…).repeat(<region>).values("name")`.

### 2.2 RelIR plan (after rel passes and naming)

```
result:
  project#vw28 [v, vtype]
    project#sv27 [v, vtype, bulk]
      project#sv26 [v, vtype, pord, bulk]
        join#j25 inner ordered
          project#m22 [id, bulk]
            join#j21 inner ordered
              project#c14 [id, bulk]
                filter#f13 (binary)
                  join#sj0 inner ordered
                    distinct#sd0
                      project#sp0 [sid]
                        filter#sf0 (binary)
                          scan#sk0 vertex_properties AS rsk0
                    scan#src0 nodes AS rn
              scan#mv15 edges AS rme16
          scan#vp23 vertex_properties AS rp24
```

How to read it:

- `distinct#sd0 … scan#sk0 vertex_properties` is the property seek. The `semijoin` pass put it in front
  of the `nodes` scan (`src/rel/passes/semijoin.ts`).
- `join … ordered` pins the left side as the outer loop. This is the join-order fence from
  `src/rel/rel.ts:40-48`.
- `scan#mv15 edges` is `out('knows')`. `scan#vp23 vertex_properties` is `values('name')`.
- `bulk` is the traverser multiplicity column.

### 2.3 SQL (one statement, 806 bytes, 0 binds)

```sql
SELECT CASE WHEN rp24.vtype IN ('list','map','set') THEN json(rp24.value) ELSE rp24.value END AS v,
       rp24.vtype AS vtype
FROM (SELECT DISTINCT rsk0.node AS sid FROM vertex_properties rsk0
      WHERE ((rsk0.key = 'name') AND (rsk0.value = 'marko'))) sd0
CROSS JOIN nodes rn ON (rn.id = sd0.sid)
CROSS JOIN edges rme16 ON ((rme16.src = rn.id)
  AND rme16.label IN (SELECT rl18.id AS id FROM labels rl18 WHERE rl18.name IN ('knows')))
CROSS JOIN vertex_properties rp24 ON ((rp24.node = rme16.tgt) AND rp24.key IN ('name'))
WHERE (rn.id IN (SELECT rvl6.node AS node FROM vertex_labels rvl6 WHERE rvl6.label IN
         (SELECT rl2.id AS id FROM labels rl2 WHERE rl2.name IN ('person')))
  AND EXISTS (SELECT 1 AS one FROM vertex_properties rp10
              WHERE (((rp10.node = rn.id) AND (rp10.key = 'name')) AND (rp10.value = 'marko'))))
```

Line breaks were added for this report. The emitter produces one line. `CROSS JOIN` is SQLite's way to
fix the join order. The shape is `{"kind":"value", …}`; the framer reads it.

### 2.4 SQLite `EXPLAIN QUERY PLAN` (bun:sqlite)

```
CO-ROUTINE sd0
  SEARCH rsk0 USING INDEX vp_key_value (key=? AND value=?)
  USE TEMP B-TREE FOR DISTINCT
SCAN sd0
SEARCH rn USING INTEGER PRIMARY KEY (rowid=?)
LIST SUBQUERY 4
  SEARCH rvl6 USING COVERING INDEX vl_label (label=?)
  LIST SUBQUERY 3
    SEARCH rl2 USING COVERING INDEX sqlite_autoindex_labels_1 (name=?)
SEARCH rme16 USING COVERING INDEX e_out (src=? AND label=?)
LIST SUBQUERY 2
  SEARCH rl18 USING COVERING INDEX sqlite_autoindex_labels_1 (name=?)
SEARCH rp24 USING INDEX vp_node_key (node=? AND key=?)
SEARCH rp10 EXISTS USING INDEX vp_node_key (node=? AND key=?)
```

(`CREATE BLOOM FILTER` lines are left out.) Every loop is a `SEARCH`. No base table is scanned. Result:
2 rows (`vadas`, `josh`).

### 2.5 The same pipeline for `repeat()` and for a write

`g.V().has('name','marko').repeat(out()).emit().values('name')` lowers to a `recursive#w8` node. The SQL
is a `WITH RECURSIVE wk_w8(id, lp0, bulk)`. The SQLite plan shows `SETUP` and `RECURSIVE STEP`, and the
step is `SEARCH rme10 USING COVERING INDEX e_pair (src=?)`. Result: 5 rows.

`g.V().has('name','marko').property('age',30)` is a program with 6 bindings and one result read:

| Binding | Kind | Statement |
|---|---|---|
| `pw10` | retained relation | the target traversers (a snapshot) |
| `pw24` | `delete` | stale full-text rows |
| `pw32` | `delete` | the old `age` value (single cardinality) |
| `pw51` | `insert … RETURNING` | the new `age` value |
| `pw56` | `insert` | the new full-text row |
| `pw61` | `update` | mark the vertex dirty |
| result | read | frame the written vertex |

Each later statement reads `pw10` through one `json_each(?)` bind. In the rendered program the bind is
a marker, `{"rowsOf":"pw10"}`. `runStepsIn` fills it with the retained rows at run time
(`src/program.ts:96-100`).

### 2.6 Cost on the example (bun:sqlite, modern graph, measured)

| Measure | Value |
|---|---|
| First compile (cold JIT and caches) | 17.0 ms |
| Warm compile, median of 50 | 1.43 ms |
| SQL execution, median of 50 | 0.038 ms |
| `EXPLAIN QUERY PLAN`, median of 50 | 0.035 ms |

On a small graph, compile time is about 37 times execution time. A `profile()` that reports only SQL
time would hide most of the cost. The plan therefore reports compile time as a separate number.

---

## 3. Reference — what TinkerPop defines

*Diátaxis type: Reference.*

### 3.1 `explain()`

| Fact | Evidence |
|---|---|
| `explain()` is a TERMINAL METHOD, not a step. | `vendor/tinkerpop/gremlin-language/src/main/antlr4/Gremlin.g4:1200-1209`, `:1335-1337` |
| The reference returns a `TraversalExplanation`. | `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Traversal.java:247-251` |
| GraphBinary has no explanation type. The serializer TRANSFORMS it into a `Map`. | `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/io/binary/types/TraversalExplanationSerializer.java:61-79`; registered at `.../binary/TypeSerializerRegistry.java:120` |
| The map keys: `original` (list of step strings), `intermediate` (list of `{strategy, category, traversal}`), `final` (list of step strings). | same file, `:61-83` |
| The JS client has no `explain()` method. A user sends the string `g.V().explain()`. | `vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/process/graph-traversal.ts` (only `profile` at `:1467`) |

So the TinkerPop 4 wire answer to `explain()` is one `Map<String, Object>`. Every GLV can decode a map.
A mogwai-db answer with the same three keys plus extra keys is wire-compatible (inferred from the
serializer; no GLV test exists).

### 3.2 `profile()`

| Fact | Evidence |
|---|---|
| `profile()` is a STEP. It appends a `ProfileSideEffectStep` and a `cap`. | `.../process/traversal/Traversal.java:235-240` |
| The grammar also has `profile(String)`, the side-effect form. | `Gremlin.g4:795-797` |
| The result type is `TraversalMetrics`: total duration plus one `Metrics` per step (`dur`, `counts`, `annotations`, nested metrics). | `.../traversal/util/TraversalMetrics.java:51-70`, `.../DefaultTraversalMetrics.java` |
| GraphBinary 4 has NO metrics type. The JS `DataType` list has no metrics code. | `.../structure/io/binary/TypeSerializerRegistry.java:95-127`; `vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/structure/io/binary/internals/DataType.js` |
| GraphSON keeps a metrics shape with keys `dur`, `metrics`, `counts`, `annotations`, `id`, `name`. | `.../io/graphson/GraphSONSerializersV3.java:391-417` |
| The corpus has no `explain()` or `profile()` scenario. `ProfileStrategy.feature` only checks that the strategy changes nothing. | `vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/test/features/integrated/ProfileStrategy.feature` |

So a TinkerPop 4 GLV cannot decode a `TraversalMetrics` from GraphBinary at all. A mogwai-db `profile()`
must answer with a `Map`. Reusing the GraphSON key names gives users a familiar shape.

---

## 4. Reference — existing inspection hooks in mogwai-db

*Diátaxis type: Reference.*

### 4.1 User-facing

| Hook | Status | What it does | Evidence |
|---|---|---|---|
| `g.V().explain()` | missing | Declines with `UnsupportedTraversal: … no lowering covers g.V().explain()` | `src/compiler/compiler.ts:122`; `src/gremlin/frontend.ts:489-498` (answers only `toList()` and `iterate()`) |
| `g.V().profile()`, `profile('m')` | missing | Declines with the same message | measured in a scratch script; `profile` is in `OPAQUE_STEPS` (`src/compiler/rel/write.ts:894`) and `SIDE_EFFECT_KEYED` (`src/compiler/ir/labels.ts:265`) |
| `withStrategies(ProfileStrategy)` | exists (no effect) | Accepted as a no-op | `src/compiler/ir/strategies.ts:119-121`; `docs/feature-support-matrix.md` §15 |
| GraphQL `extensions: {"mogwai:explain": true}` | partial | Returns the translated GREMLIN string, not SQL or RelIR | `src/graphql/edge.ts:53`, `:190`, `:236`; documented at `src/docs.ts:291`, `:455` |
| Access log `$MOGWAI_LOG=1` | partial | One line per query: graph id, Gremlin, result count. No timing. Bun only. | `src/router.ts:72-93` |
| `docs/feature-support-matrix.md` | missing entry | `explain()` and `profile()` are not listed. Only `ProfileStrategy` is (§15). | `docs/feature-support-matrix.md:281` |

### 4.2 Internal (developer and CI)

| Hook | Status | What it does | Evidence |
|---|---|---|---|
| `compile(q, params)` | exists | Returns `{kind:'read', sql, binds, shape}` or `{kind:'program', steps, …}` | `src/compiler/compiler.ts:258`; used by `test/support/harness.ts:25` |
| `lowerToRel(steps, opts)` | exists | Returns the RelIR `Plan`, shape and rendering | `src/compiler/rel/lower.ts:4428` |
| RelIR walkers | exists | `relChildren`, `relExprs`, `exprRels`, `recursiveStep` | `src/rel/walk.ts:62`, `:98`, `:153` |
| RelIR pretty-printer | missing | No function prints a `Rel` or `Plan`. A search for `pretty`, `print`, `dump`, `inspect` in `src/`, `test/`, `scripts/` found none. | grep, 2026-11-21 |
| `Step[]` printer | missing | No function prints a `Step[]` back as Gremlin text. | grep, 2026-11-21 |
| `accessPaths(store, sql, binds)` | exists | Sorted multiset of index decisions from `EXPLAIN QUERY PLAN` | `test/support/sql-core.ts:69` |
| `relationalCore(sql)` | exists | The CTE chain of a read without the framing `SELECT` | `test/support/sql-core.ts:27` |
| Plan-stability gate | exists | Same access path with and without `ANALYZE`, on 4,000 vertices | `test/plan-stability.test.ts` |
| `scripts/sql-plan.ts` | exists | CI gate: `EXPLAIN QUERY PLAN` over every corpus read, classifies each loop | `scripts/sql-plan.ts:143` `classify`, `:201` `planOf` |
| `scripts/sql-hygiene.ts` | exists | CI gate on per-row SQL terms | `scripts/sql-hygiene.ts` |
| `scripts/scaling-probe.ts` | exists | Time at graph sizes | `scripts/scaling-probe.ts` |
| DO SQL probe worker | exists | Runs arbitrary SQL in a real DO under `wrangler dev`. Never deployed. | `test/cf-probe/worker.ts` |
| Decline reasons | exists | Closed vocabulary of WHY a traversal declined | `src/compiler/unsupported.ts:9`, `:216` `Declines` |

Two debt items already track the duplicated test plan readers: `explain-reader` and
`explain-classify-tests` in `docs/outstanding-work.md` §6. A user-facing `explain()` should reuse the same
plan reader. The plan says so.

### 4.3 `EXPLAIN QUERY PLAN` on each runtime

| Runtime | Status | Evidence |
|---|---|---|
| bun:sqlite | **works** (measured) | §2.4; `test/plan-stability.test.ts`; `scripts/sql-plan.ts` |
| bun:sqlite, no binds passed | **works** (measured) | Scratch script: 17 plan rows for the parameterized example with `binds = []` |
| bun:sqlite, on a `DELETE` | **works, writes nothing** (measured) | Scratch script: node count 6 before and after |
| DO SQLite under `wrangler dev` (local workerd) | **works** (measured 2026-11-02) | `test/cf-probe/spool-autoindex.probe.ts:68-73`, recorded result at `:84-92` |
| DO SQLite in production Cloudflare | **unknown** | Not measured. The local result is strong evidence. The DO authorizer refuses some statements (`sqlite_version()`, `PRAGMA writable_schema`; `test/cf-probe/worker.ts` header). |
| Browser (wasm SQLite) | **unknown** | Not measured. Standard SQLite supports it. |

### 4.4 Timing on each runtime

| Runtime | Status | Note |
|---|---|---|
| Bun | **works** (measured) | `performance.now()` gives sub-millisecond resolution (§2.6). |
| Cloudflare Worker and DO | **unknown, probably coarse** | Cloudflare documents that `Date.now()` and `performance.now()` advance only on I/O, as a Spectre mitigation. A synchronous compile or a synchronous `sql.exec` may therefore read 0 ms. This repo has not measured it. All DO probe timings are round-trip times taken outside the DO (`test/cf-probe/spool-autoindex.probe.ts:69-71`). |
| DO row counters | **available, unused** | The DO `SqlStorageCursor` exposes `rowsRead` and `rowsWritten` (Cloudflare API). `src/cloudflare/DurableObjectSqlite.ts:14-15` calls `toArray()` and discards the cursor. These counters are exact and are what Cloudflare bills. |

---

## 5. Gaps

*Diátaxis type: Reference.*

| # | Gap | Severity | Status |
|---|---|---|---|
| G1 | No user can see the SQL that a traversal compiles to. | high — this is the owner's top interest, and the product's main difference | missing |
| G2 | `explain()` and `profile()` decline instead of answering. A GLV user who tries them gets an error. | medium | missing |
| G3 | No RelIR printer. The algebra is the most interesting stage and the only one with no text form. | high for the demo | missing |
| G4 | No per-statement time or row count. A slow query in production cannot be located. | high for operations | missing |
| G5 | No compile-time number anywhere at run time. §2.6 shows compile time dominates small queries. | high for the performance area | missing |
| G6 | `EXPLAIN QUERY PLAN` on production DO is not verified. | low — local workerd works | unknown |
| G7 | Timer resolution inside a Worker or DO is not verified. | medium — it decides whether `profile()` can report ms on Cloudflare | unknown |
| G8 | `explain()` and `profile()` are absent from `docs/feature-support-matrix.md`. | low | missing |
| G9 | A segment plan (a barrier: `call()`, `io()`, regex, ranked `order()`) compiles its resume at run time (`src/drive.ts`). A compile-only `explain()` sees only the head. | medium | design constraint |
| G10 | There is no authentication (`docs/outstanding-work.md` §5 `operations`). An explain output shows schema and index names to anyone who can query. | low — the caller can already read the data | design constraint |

None of these gaps needs a new dependency. None changes the compile output. The plan,
`docs/2026-11-21-explain-profile-plan.md`, closes G1–G5 and G8, measures G6 and G7, and handles G9 and G10
as explicit design decisions.

---

## Glossary

| Term | Meaning here |
|---|---|
| RelIR | mogwai-db's relational algebra: `Rel` nodes (`src/rel/rel.ts`) and `Stmt` nodes (`src/rel/stmt.ts`) |
| Plan | A RelIR program: ordered `bindings` plus a `result` relation (`src/rel/plan.ts:103`) |
| Binding | A named relation or statement in a plan. A retained binding keeps its rows for later statements. |
| Program | A compiled write: several SQL statements that run in one atomic unit |
| Segment plan | A plan split at a barrier whose input arrives later (a Promise or a JS transform) |
| Pass | A `Step[] → Step[]` rewrite before lowering (`src/compiler/ir/pass.ts`) |
| Rel pass | A `Rel → Rel` rewrite after lowering (`src/rel/passes/`) |
| EQP | SQLite `EXPLAIN QUERY PLAN`: one row per loop, with the index it uses |
| GLV | Gremlin Language Variant: a TinkerPop client library (Java, JS, Python, .NET, Go) |
| Decline | A clear `UnsupportedTraversal` failure for a query the compiler does not lower |
