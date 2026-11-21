# 08 — Performance evidence

Status of this file: a report. It answers one reviewer concern from the code. The new work it
proposes is in [`docs/2026-11-21-benchmark-suite-plan.md`](../../2026-11-21-benchmark-suite-plan.md).

Commit examined: `1489c279`. Date: 2026-11-21.

## 1. The concern and the short answer (Explanation)

The reviewer says that performance evidence is "the biggest thing missing". The reviewer also says:
"architectural elegance is not a benchmark".

The concern is valid. The repository has many performance **guards**, but it has no **benchmark**.

- A guard asks one question: "did this query plan or this growth rate get worse?" The repository has
  more than 15 guards (section 3).
- A benchmark asks a different question: "how fast is mogwai-db, at a stated size, against a stated
  alternative?" The repository has no such measurement. No file reports p50 or p95 latency. No file
  compares mogwai-db with a hand-written SQLite schema, with TinkerGraph, or with a graph database.
- The largest graph in any test or instrument is 8,000 vertices (`scripts/scaling-probe.ts:6-8`). The
  reviewer asks for 10,000 to 10,000,000 vertices.

For this report, a small throwaway probe measured mogwai-db against a hand-written SQLite adjacency
schema at 10,000 and 100,000 vertices (section 4). These numbers are one run on one machine. They are
evidence for the plan, not a benchmark result.

Gap summary (detail in section 6):

| Reviewer dimension | Status |
|---|---|
| Graph sizes 10k / 100k / 1m / 10m | partial: guards stop at 8k; probe for this report reached 100k |
| Graph shapes | partial: uniform random and chains exist; no power-law, no dense, no cyclic dataset in a suite |
| Workloads | partial: growth-rate guards cover lookup, hops, aggregation, writes; no concurrency |
| Baselines | missing |
| Metrics | partial: best-of-N time and SQL bytes exist; no p50/p95, no RSS, no database size in a suite |
| Adversarial queries | partial: many super-linear witnesses exist, all at 1k–8k vertices |

## 2. Why compile-to-SQL can be fast, and where it can lose (Explanation)

### 2.1 Why it can be fast

mogwai-db compiles each Gremlin traversal into one SQL program (CLAUDE.md, locked decision 3). SQLite
then runs the traversal inside its own engine, with B-tree indexes. There is no JavaScript work per row.

The schema gives each Gremlin step an index:

| Step | Index | Where |
|---|---|---|
| `out()` | `e_out ON edges(src, label, tgt)` | `src/storage.ts:222` |
| `in()` | `e_in ON edges(tgt, label, src)` | `src/storage.ts:223` |
| edge between two known vertices | `e_pair ON edges(src, tgt)` | `src/storage.ts:230` |
| `E().hasLabel(x)` | `e_label ON edges(label)` | `src/storage.ts:235` |
| `hasLabel(x)` | `vl_label ON vertex_labels(label, node)` | `src/storage.ts:221` |
| `has(k, v)` | `vp_key_value ON vertex_properties(key, value)` | `src/storage.ts:241` |
| `values(k)` per vertex | `vp_node_key ON vertex_properties(node, key)` | `src/storage.ts:242` |
| edge `has(k, v)` | `ep_key_value ON edge_properties(key, value)` | `src/storage.ts:243` |

The edge indexes are covering. Thus `out()` and `in()` read only the index and not the table
(`.claude/rules/schema-storage.md`).

A bounded `repeat(...).times(n)` collapses equal traversers into one row with a count (a "bulk"). Thus
the row count stays small when the traverser count is large. The archived repeat plan records why
(`docs/archive/2026-08-09-repeat-two-regimes-plan.md:10`). The probe in section 4.4 shows 9,417,313
traversers counted in 33.8 ms on a 10,000-vertex power-law graph.

The compiler fixes the access path from the query text. It does not depend on SQLite statistics. The
reason is a platform fact: a Durable Object accepts `ANALYZE` but refuses `PRAGMA analysis_limit`
(`docs/archive/2026-08-01-relir-build-plan.md:38-50`, fact P4). That fix took a filtered 1-hop lookup
from about 9.8 s to about 19 ms on a mid-size graph (same lines). `test/plan-stability.test.ts:79`
guards it.

### 2.2 Where it can lose

Each item below is a known cost. Each has a citation.

1. **Compile cost on every request.** The parse tree is cached: a 512-entry LRU keyed by query text
   (`src/gremlin/frontend.ts:98-112`). The compiled SQL is **not** cached. Each request lowers and
   emits again. The probe measured 1.3–2.1 ms per simple read and 9–10.5 ms for
   `order().by(outE().count())` (section 4.2). On a 0.02 ms index lookup, compile is about 99% of the
   server time. This is inferred from the probe, not profiled in a suite.
2. **Normalised properties.** Each property is one row in `vertex_properties`
   (`src/storage.ts:124-126`). An aggregate over one property joins that table and decodes a type tag.
   The probe measured `groupCount().by('age')` at 15.9–19.4× a narrow table with an `age` column
   (section 4.2).
3. **Storage size per element.** Each element carries a global id (`gid`, 16 bytes) and a content hash
   (`rev`, 87 bytes in the probe), for replication (`src/storage.ts:96-97`, `:136-139`). There are five
   indexes on `edges`. The probe measured 6.3–7.4× the bytes of a narrow adjacency schema (section 4.3).
4. **Bulk load cost.** The probe measured about 38,000 elements per second with the streaming loader,
   against about 1,400,000 per second for plain `INSERT` into the narrow schema (section 4.3).
5. **`json_each` on the inner side of a join.** SQLite cannot index a table-valued function. A
   `json_each(?)` on the inner side is decoded again for each outer row. The emitter spools it into a
   `MATERIALIZED` CTE so that SQLite builds an automatic index (`src/rel/emit.ts:935-944`). Without the
   spool the measured cost was 0.9 s at 1k and 14 s at 4k (same lines). A Durable Object probe confirms
   the automatic index on workerd (`test/cf-probe/spool-autoindex.probe.ts:80-89`).
6. **CTE materialisation.** A `MATERIALIZED` CTE is a real temporary table. It is a fence: SQLite cannot
   push a filter into it. The emitter uses it only to compute a shared value once
   (`src/rel/emit.ts:960-962`). Its cost is not measured at scale.
7. **Recursive expansion.** An unbounded `repeat()` lowers to a recursive CTE. A recursive term cannot
   hold an aggregate or `DISTINCT` (`docs/archive/2026-08-01-relir-build-plan.md:23-36`, facts P1 and
   P3). Thus an unbounded walk cannot collapse duplicate traversers. On a dense or power-law graph the
   row count grows with the number of paths, not with the number of vertices. A cyclic walk without
   `simplePath()` does not stop, by the Gremlin specification (CLAUDE.md, "Semantics traps").
8. **Known super-linear shapes.** `docs/outstanding-work.md` §2 lists 57 performance items. Examples:
   `write-value-join` (730 ms → 42.3 s), `keyed-join-residue` (436 ms at 1k → 28 s at 8k),
   `setop-autoindex-do`. This report does not repeat them.

## 3. What is measured today (Reference)

"Gate" means CI fails on a regression. "Instrument" means a person runs it and reads the result.

### 3.1 Plan-shape gates (no wall clock)

| Item | Kind | Graph | What it asserts | Status |
|---|---|---|---|---|
| `test/performance.test.ts:16` | gate | 5,000 vertices | `has`, `order().by`, `values` use a `vp_` index; `where(outE())` and `map(outE().count())` use `e_out` | exists |
| `test/plan-stability.test.ts:79` | gate | 4,010 vertices, 10,010 edges | the graph-sized access path is the same with and without `sqlite_stat1` | exists |
| `test/plan-stability.test.ts:119` | gate | same | every id lookup is a `SEARCH` | exists |
| `test/plan-stability.test.ts:146` | gate | same | a literal `within()` set seeks each member | exists |
| `mise run sql-plan` (`scripts/sql-plan.ts`, `mise.toml:522-527`) | gate | modern (6 vertices) | no root scan of a non-element table, no automatic index on a base table, no unconstrained FTS scan; nested scans ratcheted per query in `scripts/sql-plan-baseline.json` | exists |
| `mise run sql-hygiene` (`scripts/sql-hygiene.ts`, `mise.toml:509-512`) | gate | L1 corpus | per-family maxima of binds and SQL bytes (`scripts/sql-hygiene-baseline.json`); no subquery evaluated twice per row; DO statement limits | exists |
| `test/cf-limits.test.ts`, `mise run test:cf-limits` (`mise.toml:253`) | gate / instrument | L3 corpus | every statement fits the DO limits: 100 binds, 100 KB text, 2 MB value (`src/do-limits.ts:13-23`) | exists |

### 3.2 Growth-rate guards (wall clock, coarse bound)

These tests run a query at one or two sizes. They fail on an exponential or quadratic regression. The
bound is about 100× the measured time, so they do not measure speed.

| Item | Graph | Assertion | Status |
|---|---|---|---|
| `test/performance.test.ts:105` | none (compile only) | a 24-hop `both()` chain compiles in < 2,000 ms; SQL bytes grow ≤ 2.2× when hops double | exists |
| `test/compiler/id-routing-scale.exec.test.ts:19-21` | 6,000 | < 1,000 ms | exists |
| `test/compiler/traversal-ids-scale.exec.test.ts:16-18` | 6,000 | < 1,000 ms | exists |
| `test/compiler/merge-scale.exec.test.ts:29` | 6,000 | `mergeV`/`mergeE` under a budget | exists |
| `test/compiler/runtime-name-scale.exec.test.ts:26` | 6,000 | under a budget | exists |
| `test/compiler/rooted-sample-scale.exec.test.ts:27` | 6,000 | under a budget | exists |
| `test/compiler/set-op-scale.exec.test.ts:21` | 8,000 | `intersect`/`difference` under a budget | exists |
| `test/compiler/walk-condition-hub-scale.exec.test.ts:57-58` | 130 → 1,050 chains | large/small time ratio < 16 for 8× data | exists |
| `test/compiler/project-linear.exec.test.ts:117` | none | SQL bytes grow ≤ 2.2× when `project` width doubles | exists |
| `test/federate-value-stream-scale.test.ts:24` | 5,000 and 8,000 | federated value stream crosses the 2 MB value cap | exists |

### 3.3 Instruments (not in CI)

| Item | What it reports | Status |
|---|---|---|
| `scripts/scaling-probe.ts` | best-of-7 execute ms, SQL bytes and JOIN count for about 140 query shapes at 1k and 8k vertices; time ratio 8k/1k. Graph: uniform random, mean out-degree 2.5, seed 7 (`scripts/scaling-probe.ts:335-363`). No compile time, no RSS, no baseline. | exists |
| `scripts/l5-pool-bench.ts` | test-suite parallelism and peak RSS of the test harness. Not a database benchmark. | exists |
| `test/cf-probe/*.probe.ts` | one-off Durable Object facts under `wrangler dev`, with the result in a comment | exists |
| `.logs/compile-cost-report.md` | per-query compile cost and CPU profile, local only (`docs/outstanding-work.md:51`). No committed script makes it. | partial |
| `test/L6-workload/` | about 300 application-shaped queries on modern, crew and air-routes (3,504 airports, 57,645 edges, `test/fixtures/air-routes.ts:1-2`). It checks correctness against TinkerGraph goldens. It does not record time. | exists (correctness only) |

### 3.4 Rules that govern performance work

- **The 2× bar.** A regression counts only past 2× against the commit before
  (`docs/archive/2026-11-16-ladder-retirement-plan.md:18-30`).
- **Benchmarks must `ANALYZE`, or they measure the wrong plan**
  (`docs/archive/2026-08-01-relir-build-plan.md:49`). The plan-stability gate makes the plan the same
  without statistics, but a benchmark must still state which case it runs.
- **Never decline on data size** (CLAUDE.md). A benchmark at 1m or 10m vertices is also the test of
  this rule.

## 4. Probe measurements made for this report (Reference)

These numbers are **measured once**, not benchmarked. Machine: Linux x64, 24 cores, Bun 1.3.11,
`bun:sqlite`, file database in WAL mode. Each time is the best of 7 runs. mogwai times are the raw SQL
of the compiled plan through `GraphStore.query`, without result framing. The probe scripts were
throwaway and are not in the repository; the plan makes them permanent.

Dataset: N vertices with `name` and `age`; 5 random out-edges per vertex (uniform, xorshift seed 7).
Baseline: a narrow schema `v(id, name, age)`, `e(src, dst)`, indexes `e(src,dst)`, `e(dst,src)`,
`v(name)`.

### 4.1 Load and size

| Metric | 10k vertices / 50k edges | 100k vertices / 500k edges |
|---|---|---|
| mogwai `BatchingLoader` (`src/bulk.ts:656`) time | 1,491 ms | 15,788 ms |
| mogwai `BatchingLoader` peak RSS (whole process) | 256 MB | 291 MB |
| mogwai `loadBulk` (`src/bulk.ts:620`) time | 1,305 ms | 13,411 ms |
| mogwai `loadBulk` peak RSS (whole process) | 433 MB | 2,482 MB |
| baseline `INSERT` + index time | 35 ms | 419 ms |
| mogwai database bytes | 16,904,192 | 176,041,984 |
| baseline database bytes | 2,277,376 | 25,722,880 |

`loadBulk` holds the whole input in memory. `BatchingLoader` flushes every 5,000 elements
(`src/bulk.ts:664-680`), so its RSS stays flat. `io()` uses the batching path (CLAUDE.md, "IoStore").

### 4.2 Read latency and compile time

| Query | compile ms (100k) | mogwai ms 10k | baseline ms 10k | mogwai ms 100k | baseline ms 100k | ratio 100k |
|---|---|---|---|---|---|---|
| `has('name','p42').values('age')` | 1.61 | 0.02 | < 0.01 | 0.02 | < 0.01 | 2.4× |
| `… .out().count()` | 1.56 | 0.03 | < 0.01 | 0.03 | < 0.01 | 2.6× |
| `… .out().out().out().count()` | 1.74 | 0.07 | 0.01 | 0.08 | 0.01 | 7.1× |
| `… 5 × out() … .count()` | 1.94 | 1.04 | 0.19 | 1.54 | 0.52 | 2.9× |
| `V().groupCount().by('age')` | 1.83 | 14.73 | 0.76 | 165.43 | 10.41 | 15.9× |
| `V().order().by(outE().count(),desc).limit(10).id()` | 10.5 | 8.61 | 2.01 | 100.32 | 23.85 | 4.2× |

Ratios below 0.1 ms are within timer noise. Compile time is warm, with a parse-cache hit.

### 4.3 Write throughput (100 to 10k elements, through the executor, Bun, file WAL)

| Operation | Measured |
|---|---|
| `g.addV('person').property('name', n)`, one request each, 1,000 requests | 2,410 ms (2.4 ms each) |
| `g.mergeV([name:'m<i>'])`, 1,000 requests, 500 distinct texts | 3,508 ms (3.5 ms each) |
| `g.V().has('name',a).addE('knows').to(__.V().has('name',b)).count()`, 1,000 requests | 2,376 ms |
| `g.inject(xs).unfold().addV('person').count()`, `xs` = 10,000 strings | 230 ms (about 43,000 per second) |
| `g.V().has('name', n).values('name')`, 1,000 requests, compile included | 898 ms (0.9 ms each) |

`g.inject(<list of maps>).unfold().mergeV()` declines today. This is tracked in
`docs/outstanding-work.md:1294`.

### 4.4 Adversarial: power-law graph (Barabási–Albert, m = 3, 10,000 vertices, max in-degree 683)

| Query from the hub `p1` | compile ms | execute ms | answer |
|---|---|---|---|
| `both().both().count()` | 42.3 (cold) | 2.1 | 8,970 |
| `repeat(both()).times(3).count()` | 9.5 | 13.7 | 634,372 |
| `repeat(both()).times(4).count()` | 5.3 | 33.8 | 9,417,313 |
| `repeat(both()).times(3).dedup().count()` | 5.6 | 13.7 | 9,755 |
| `V(p5000).repeat(out()).until(has('name','p1')).limit(1).count()` | 11.3 | 0.4 | 1 |

The bounded `repeat` collapses traversers into bulk rows. The time grows with distinct vertices, not
with the 9.4 million traversers. The unbounded walks above stop early only because of `limit(1)` and
an acyclic edge direction. An unbounded walk over `both()` without `simplePath()` does not stop, by
specification.

## 5. Platform limits and size feasibility (Reference)

| Limit | Value | Source | Measured here? |
|---|---|---|---|
| DO isolate memory | 128 MB | Cloudflare documentation; cited in `docs/outstanding-work.md:634` | no |
| DO storage per object | 10 GB | Cloudflare documentation; CLAUDE.md "IoStore" | no |
| DO CPU per request | 30 s default; up to 5 min when `limits.cpu_ms` is set | Cloudflare documentation. `wrangler.jsonc` sets no `limits` key. | no |
| DO binds per statement | 100 | `src/do-limits.ts:13` | yes, `test/cf-limits.test.ts` |
| DO statement text | 100 KB | `src/do-limits.ts:16` | yes |
| DO value size | 2 MB | `src/do-limits.ts:23` | yes, on workerd |
| mogwai compile budget | 400,000 bytes | `src/sql/kernel/budget.ts:23` | yes |

Feasibility per size. The storage figure is the probe's 176 MB per 100k vertices at out-degree 5 with
two properties (about 1.7 KB per vertex). The extrapolation is linear and **inferred**.

| Size (out-degree 5) | Inferred mogwai bytes | Bun | One Durable Object |
|---|---|---|---|
| 10k | 17 MB | yes | yes |
| 100k | 176 MB | yes | storage yes; load must span several requests (16 s CPU on Bun) |
| 1m | about 1.8 GB | yes (about 160 s to load) | storage yes; load must span many requests; memory per query is the risk |
| 10m | about 18 GB | yes, manual run only (about 27 min to load) | **no**: more than 10 GB |

A 10m-vertex graph at out-degree 5 does not fit in one Durable Object. The plan therefore runs 10m on
Bun only. It runs DO measurements at 10k and 100k, with 1m as a stretch goal.

Concurrency. The storage seam is synchronous (`src/api.ts:36`). One Durable Object runs one request at
a time on one thread. Thus concurrent reads on one graph queue; they do not run in parallel. Parallel
work needs several graphs, that is several Durable Objects. This is inferred from the design; no test
measures it.

## 6. Gap matrix against the reviewer's request (Reference)

| Reviewer item | Today | Evidence | Status |
|---|---|---|---|
| 10k vertices | growth guards at 5k–8k; probe at 10k | §3.2, §4 | partial |
| 100k vertices | probe only | §4 | partial (not in repo) |
| 1m vertices | none | — | missing |
| 10m vertices | none; does not fit in one DO | §5 | missing |
| Sparse shape | uniform random, degree 2.5 | `scripts/scaling-probe.ts:341-363` | partial |
| Dense shape | none | — | missing |
| Power-law shape | probe only | §4.4 | missing in repo |
| Deep chains | chain graph in a hub test | `test/compiler/walk-condition-hub-scale.exec.test.ts` | partial |
| Cyclic shape | ring in plan-stability (`(i+k-1) % N`) | `test/plan-stability.test.ts:28-32` | partial (plan shape only) |
| Indexed lookup | plan-shape gates | §3.1 | partial (no latency) |
| 1–5 hop traversal | scaling probe shapes | §3.3 | partial |
| Shortest path | `shortestPath()` service exists (`src/services/catalog/olap/shortest-path.ts:39-47`) | no timing anywhere | missing |
| Aggregation | `group`/`groupCount` probe shapes | §3.3 | partial |
| Writes | `merge-scale` guard; `loadBulk` statement count (`src/bulk.ts:153`) | §3.2 | partial (no throughput) |
| Concurrent reads | none | — | missing |
| Hand-written SQLite baseline | none in repo; probe only | §4 | missing |
| TinkerGraph baseline | used for correctness goldens only, offline via docker (`scripts/workload-goldens/generate.ts:1-12`) | — | missing as performance baseline |
| Graph-native database baseline | none | — | missing |
| p50/p95 latency | none; best-of-7 only | `scripts/scaling-probe.ts:380-387` | missing |
| Peak RSS | test harness only | `scripts/l5-pool-bench.ts` | missing for the database |
| Database size | none | — | missing |
| Query compile time | one coarse bound; local report | `test/performance.test.ts:105`; `.logs/compile-cost-report.md` | partial |
| Write throughput | none | — | missing |
| Degradation with vertex degree | hub test ratio | `test/compiler/walk-condition-hub-scale.exec.test.ts:57-58` | partial |
| Adversarial queries | super-linear witnesses at 1k–8k; outstanding-work §2 | §3.2, §3.3 | partial |
| Results on a Durable Object | one-off probes under `wrangler dev` | `test/cf-probe/` | partial |

## 7. Conclusions (Explanation)

1. The reviewer is right. There is no benchmark, no baseline and no percentile latency.
2. The repository is strong on a different axis. It gates plan shape and growth rate in CI. This
   prevents the worst failure (a quadratic plan in production). It does not say how fast a query is.
3. The probe suggests three facts to confirm with the plan's suite:
   - indexed lookups and short hops are within 3–7× of a narrow hand-written schema, and below 2 ms;
   - aggregation over a property is 16–19× slower than a column, because properties are rows;
   - per-request compile time (1–10 ms) is larger than execution for point queries, and nothing
     caches the compiled SQL.
4. Storage is 6–7× a narrow schema. A 10m-vertex graph does not fit in one Durable Object. This is a
   product limit to document, not only a benchmark gap.

## Glossary

| Term | Meaning in this file |
|---|---|
| baseline | a hand-written SQLite schema and SQL that answers the same question |
| bulk | one row that stands for several equal traversers, with a count |
| CTE | a named subquery in a `WITH` clause |
| DO | a Cloudflare Durable Object: one isolate with its own SQLite database |
| gate | a check that fails CI |
| guard | a gate on plan shape or growth rate, not on speed |
| instrument | a script a person runs; it reports and does not fail CI |
| `json_each` | the SQLite function that turns one JSON value into rows |
| probe | the throwaway measurement made for this report |
| RSS | resident set size: the memory a process holds |
| spool | a `MATERIALIZED` CTE that computes a shared value once |
