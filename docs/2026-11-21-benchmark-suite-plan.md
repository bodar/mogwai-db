# Benchmark suite — measure speed, size and memory against a baseline

**Status: PROPOSED (2026-11-21).** No item has started. The owner decides the open decisions in §8
before items B7 and B10 start. Items B1–B6 need no decision and no new dependency.

**Source of this plan.** An external reviewer said performance evidence is "the biggest thing missing".
The evidence and the gap matrix are in
[`docs/reports/2026-11-21-production-readiness/08-performance-evidence.md`](reports/2026-11-21-production-readiness/08-performance-evidence.md).
This plan does not repeat them.

**Companion plan.** Compile-time breakdown and per-statement timing come from
[`docs/2026-11-21-explain-profile-plan.md`](2026-11-21-explain-profile-plan.md). This plan consumes that
instrument. It does not build a second one.

## 1. Goal (Explanation)

Produce numbers a reader can check: latency, memory, size and throughput, at stated sizes, against a
stated baseline, on both runtimes.

The suite answers four questions:

1. How fast is a query on mogwai-db, as p50 and p95, at 10k, 100k, 1m and 10m vertices?
2. How much slower or faster is it than a hand-written SQLite schema for the same question?
3. How much memory and disk does it use, and how fast does it accept writes?
4. Which shapes and sizes make it degrade, and how fast?

Non-goals:

- The suite does not change the compiler. A slow result becomes an item in
  `docs/outstanding-work.md` §2, under the 2× rule
  (`docs/archive/2026-11-16-ladder-retirement-plan.md:18-30`).
- The suite does not emulate Java execution. It compares answers by value, as L6 does.

## 2. Current state (Reference)

| Fact | Where |
|---|---|
| Plan-shape gates exist; they do not measure time | `test/performance.test.ts:16`, `test/plan-stability.test.ts:79`, `scripts/sql-plan.ts` |
| Growth-rate guards exist at 5k–8k vertices with coarse time bounds | `test/compiler/*-scale.exec.test.ts` |
| The scaling probe reports best-of-7 ms at 1k and 8k; no percentile, no baseline | `scripts/scaling-probe.ts:1-16`, `:365-392` |
| The probe's graph generator is a seeded xorshift, uniform out-degree 0–5 | `scripts/scaling-probe.ts:335-363` |
| Streaming bulk loader with flat memory | `src/bulk.ts:656-690` (`BatchingLoader`) |
| Parse cache, 512 entries; no compiled-SQL cache | `src/gremlin/frontend.ts:98-112` |
| `bun:sqlite` caches prepared statements by SQL text | `src/bun/BunSqlite.ts:39-42` |
| DO limits in one module | `src/do-limits.ts:13-23` |
| A `wrangler dev` harness exists for DO probes | `test/cf-probe/spool-autoindex.probe.ts`, `test/cloudflare.test.ts` |
| TinkerGraph runs offline in docker for goldens; not in CI, not in `package.json` | `scripts/workload-goldens/generate.ts:1-12` |
| L6 application-shaped corpus with correctness goldens | `test/L6-workload/corpus.ts`, `test/L6-workload/goldens.json` |

The report's probe (§4 of the report) measured, at 100k vertices on Bun: 0.02 ms for an indexed
lookup, 2.4–7.1× the narrow baseline for 1–5 hops, 15.9× for `groupCount().by('age')`, 6.8× the disk
size, and about 38,000 elements per second for a streaming load. These numbers are one run. B6 replaces
them with a repeatable result.

## 3. Design (Explanation)

### 3.1 Placement

- Code: `scripts/bench/`. It is an instrument, like `scripts/scaling-probe.ts`. It is not a `test/`
  bracket, because `scripts/brackets.ts` would make a `test/L…` directory a CI job.
- Tasks: `mise run bench` (tier S), `mise run bench:large` (tier L), `mise run bench:huge` (tier H),
  `mise run bench:do` (DO tier). Each tees to `.logs/<task>.log` like every task.
- Results: `bench-results/<date>-<commit>-<tier>.jsonl`, not committed by default. One banked file,
  `scripts/bench/baseline-ratios.json`, holds the ratios that B9 checks.
- Each (dataset, size) runs in its own child process, as the scaling probe does
  (`scripts/scaling-probe.ts:365`). Thus peak RSS belongs to one dataset.

### 3.2 Datasets

A dataset is a generator function with a name, a size N and a seed. It yields `BulkVertex` and
`BulkEdge` values (`src/bulk.ts:73`, `:92`). The same function feeds both mogwai and the baseline.

| Name | Shape | Out-degree | Notes |
|---|---|---|---|
| `sparse` | uniform random targets | 2 | the scaling probe's graph, at degree 2 |
| `uniform5` | uniform random targets | 5 | the report's probe graph |
| `dense` | uniform random targets | 50 | 1m vertices = 50m edges; tier H only above 100k |
| `powerlaw` | Barabási–Albert preferential attachment | m = 3 | hubs with in-degree in the hundreds at 10k |
| `powerlaw-heavy` | Barabási–Albert | m = 10 | for degree degradation |
| `chains` | N/1,000 disjoint chains of 1,000 vertices | 1 | deep `repeat` |
| `cyclic` | ring plus 2 random chords per vertex | 3 | every unbounded walk without `simplePath()` is infinite |
| `degree-sweep` | one hub per degree d ∈ {10, 100, 1k, 10k, 100k} on a `uniform5` base | 5 | degradation with vertex degree |

Every vertex has the label `person` or `software` (1 in 5), a `name` (`p<i>`), an `age` (18–77) and,
on 10%, a `city` from 1,000 values. Every edge has the label `knows` or `created` and a `weight` in
[0, 1). The seed is fixed per dataset (default 7) and printed in the result.

### 3.3 Baselines

Two SQLite baselines run beside mogwai on the same machine and the same `bun:sqlite` build:

- **B-narrow.** A schema an application developer writes by hand:
  `v(id INTEGER PRIMARY KEY, label TEXT, name TEXT, age INTEGER, city TEXT)`,
  `e(src INTEGER, dst INTEGER, label TEXT, weight REAL)`, indexes `e(src, label, dst)`,
  `e(dst, label, src)`, `v(name)`, `v(age)`, `v(city)`. This is the reviewer's "most important"
  baseline. It answers "what does the Gremlin layer and the general schema cost?"
- **B-same.** Hand-written SQL over **mogwai's own tables**. It answers "what does the compiler cost,
  for this schema?" The difference between B-narrow and B-same is the schema's cost. The difference
  between B-same and mogwai is the compiler's cost. The report's probe could not separate the two.

TinkerGraph and a graph-native database are open decisions (§8, D1 and D2).

### 3.4 Workloads

Each workload has an id, a Gremlin text, a B-narrow SQL text, and an equality check. The runner checks
that mogwai and the baseline return the same value before it records any time. A mismatch is a
failure of the run, not a number. `$hub`, `$a`, `$b` and `$name` are user parameters, so they bind
(CLAUDE.md, "A bind serves a user parameter").

| Id | Gremlin | B-narrow SQL |
|---|---|---|
| W1 lookup | `g.V().has('name', $name).values('age')` | `SELECT age FROM v WHERE name = ?` |
| W2 1-hop | `g.V().has('name', $name).out('knows').count()` | `SELECT count(*) FROM v JOIN e ON e.src = v.id AND e.label = 'knows' WHERE v.name = ?` |
| W3 2-hop | `g.V().has('name', $name).out().out().count()` | two `JOIN e` on `src = dst` |
| W4 3-hop dedup | `g.V().has('name', $name).out().out().out().dedup().count()` | `SELECT count(DISTINCT c.dst) …` with three joins |
| W5 5-hop | `g.V().has('name', $name).repeat(out()).times(5).count()` | five joins, `count(*)` |
| W6 friends-of-friends | `g.V().has('name', $name).as('me').out('knows').out('knows').where(neq('me')).dedup().values('name').limit(20)` | self-join with `dst <> me.id`, `DISTINCT`, `LIMIT 20` |
| W7 shortest path | `g.V().has('name',$a).shortestPath().with('~tinkerpop.shortestPath.target', __.has('name',$b))` | `WITH RECURSIVE bfs(n, d) AS (SELECT ?, 0 UNION SELECT e.dst, d + 1 FROM bfs JOIN e ON e.src = bfs.n WHERE d < 6) SELECT min(d) FROM bfs WHERE n = ?` |
| W8 group count | `g.V().groupCount().by('age')` | `SELECT age, count(*) FROM v GROUP BY age` |
| W9 top degree | `g.V().order().by(outE().count(), desc).limit(10).id()` | `SELECT src FROM e GROUP BY src ORDER BY count(*) DESC LIMIT 10` |
| W10 filtered aggregate | `g.V().hasLabel('person').has('city', $city).values('age').mean()` | `SELECT avg(age) FROM v WHERE label = 'person' AND city = ?` |
| W11 project | `g.V().hasLabel('software').project('n','c').by('name').by(in('created').count()).limit(100)` | `LEFT JOIN` + `GROUP BY`, `LIMIT 100` |
| W12 hub fan-out | `g.V().has('name', $hub).both().values('name').count()` | `UNION ALL` of both directions |
| R1 single addV | `g.addV('person').property('name', $name)` | `INSERT INTO v …` |
| R2 single addE | `g.V().has('name',$a).addE('knows').to(__.V().has('name',$b))` | `INSERT INTO e SELECT …` |
| R3 batch addV | `g.inject($names).unfold().addV('person').count()`, 10,000 names | one `INSERT … SELECT value FROM json_each(?)` |
| R4 upsert | `g.mergeV([name: $name])` | `INSERT … ON CONFLICT DO NOTHING` (needs a unique `name`) |
| R5 bulk load | `BatchingLoader` (`src/bulk.ts:656`) | prepared `INSERT` in one transaction, then `CREATE INDEX` |
| C1 concurrent reads | W1 and W3 from K clients, K ∈ {1, 4, 16, 64} | the same SQL from K connections (Bun only) |

W6 and W11 are written in full in `scripts/bench/workloads.ts` (B3). The table gives the shape. A
B-same SQL text exists for W1–W12 and is written in the same file.

### 3.5 Adversarial cases

These cases are not compared for speed. They record time, peak RSS and outcome. An outcome is an
answer, a clear decline, or a platform stop (DO CPU limit). A crash or a bare `Error` is a failure
(CLAUDE.md, "Correct by design").

| Id | Query | Dataset | Why |
|---|---|---|---|
| A1 | `g.V().has('name',$hub).repeat(both()).times(k).count()`, k = 3…6 | `powerlaw`, `powerlaw-heavy` | bulk collapse under hubs; the report measured 9.4m traversers in 33.8 ms at k = 4 |
| A2 | `g.V().has('name',$hub).repeat(both()).emit().times(k).dedup().count()` | `powerlaw` | emit plus dedup after a bounded walk |
| A3 | `g.V().has('name',$a).repeat(out().simplePath()).until(has('name',$b)).path().limit(1)` | `powerlaw`, `cyclic` | unbounded recursive CTE; path growth |
| A4 | `g.V().has('name',$a).repeat(out()).until(has('name',$b)).limit(1)` | `cyclic` | infinite by specification when no path exists; expect the DO CPU stop, never a cap |
| A5 | W7 shortest path from a hub | `powerlaw-heavy` | relaxation barrier cost (`src/services/catalog/olap/shortest-path.ts:39-47`) |
| A6 | `g.V().order().by(both().count(), desc).limit(10)` | `degree-sweep` | per-vertex sub-traversal over hubs |
| A7 | `g.V().has('name',$hub).drop()` | `degree-sweep` | cascade delete of a hub with 100k edges |
| A8 | `g.inject($big).unfold().count()`, `$big` past 2 MB | any | the 2 MB value split (`src/compiler/rel/build.ts:389-397`) |
| A9 | the witnesses of `keyed-join-residue` and `write-value-join` | `uniform5` | known super-linear items (`docs/outstanding-work.md` §2); the suite tracks them, the fix lives there |

### 3.6 Metrics and how to collect each

| Metric | Bun | Durable Object (`wrangler dev`) |
|---|---|---|
| p50 / p95 latency | W warm-up runs, then R timed runs with `performance.now()` around the whole request (compile + SQL + framing); nearest-rank percentiles. Defaults W = 3, R = 30. | the same loop, timed at the client over HTTP, plus the DO-side time the explain/profile plan returns |
| compile time | from the explain/profile plan's compile breakdown (parse, passes, lowering, emit); cold (first text) and warm (parse-cache hit) reported separately | the same, returned by the DO |
| per-statement SQL time | from the explain/profile plan | the same |
| peak RSS | `process.resourceUsage().maxRSS` in the child process, after the dataset loads and after the workload runs | not observable per isolate; record the DO's memory-limit errors instead (open decision D4) |
| database size | `PRAGMA page_count` × `PRAGMA page_size` after `PRAGMA wal_checkpoint(TRUNCATE)`; per-table bytes via `dbstat` when the SQLite build has it | `ctx.storage.sql.databaseSize` |
| write throughput | R1–R4: requests per second over 1,000 requests; R3, R5: elements per second | the same, over RPC |
| degradation with degree | W12 and A6 time per hub degree in `degree-sweep`; report the slope of log(time) against log(degree) | W12 at 10k only |
| concurrent throughput | C1: queries per second and p95 at K clients against `src/bun/server.ts` | K clients against one DO, and against K DOs |

Statistics rule. Every run states whether it ran `ANALYZE` first. The default runs both: "young" (no
`sqlite_stat1`) and "warm" (after `ANALYZE`). The relir plan requires this
(`docs/archive/2026-08-01-relir-build-plan.md:49`).

### 3.7 Result format

One JSON object per line. The first line is a header:

```json
{"kind":"header","commit":"1489c279","date":"2026-11-21","tier":"S","runtime":"bun","bun":"1.3.11",
 "sqlite":"3.51.2","cpu":"…","cores":24,"os":"linux-x64","warmup":3,"runs":30}
```

Then one line per (dataset, size, workload, system, statistics):

```json
{"kind":"result","dataset":"uniform5","n":100000,"edges":500000,"seed":7,"workload":"W3",
 "system":"mogwai","stats":"young","p50_ms":0.09,"p95_ms":0.12,"compile_cold_ms":2.1,
 "compile_warm_ms":1.7,"rows":1,"answer_hash":"…","peak_rss_mb":291,"db_bytes":176041984}
```

`system` is `mogwai`, `b-narrow`, `b-same`, or a value an open decision adds. A Markdown summary is
printed from the JSON lines: one table per dataset, with the ratio mogwai / B-narrow and
mogwai / B-same.

### 3.8 Gating versus reporting

- **Report, never gate, on absolute milliseconds.** CI runners vary. The existing guards already
  learned this (`test/compiler/walk-condition-hub-scale.exec.test.ts:117-121`).
- **Gate on correctness.** A mismatch between mogwai and a baseline fails the run in every tier.
- **Gate on ratio, in tier S only, at 2×.** For each workload, mogwai / B-same at 10k must stay
  within 2× of the banked ratio in `scripts/bench/baseline-ratios.json`. A ratio cancels most machine
  noise. The 2× bar is the project's existing rule. Whether this gate joins `ci` is open decision D3.
- **Gate on outcome for adversarial cases.** A1–A9 must answer, decline clearly or hit the platform
  stop. A crash fails.

### 3.9 Tiers

| Tier | Sizes | Datasets | Runtime | When | Expected wall time (inferred) |
|---|---|---|---|---|---|
| S (CI-small) | 10k | `sparse`, `uniform5`, `powerlaw`, `chains`, `cyclic` | Bun | every CI run, own job | under 2 min |
| L (nightly-large) | 100k, 1m | all except `dense` at 1m | Bun | nightly | 1m load is about 160 s per dataset on the report's machine |
| H (manual-huge) | 10m | `uniform5`, `powerlaw` | Bun only | by hand | 10m load is about 27 min per dataset |
| DO | 10k, 100k (1m stretch) | `uniform5`, `powerlaw` | `wrangler dev`; production DO is open decision D4 | nightly or by hand | load spans several requests |

Size feasibility. mogwai used about 1.7 KB per vertex at out-degree 5 in the report's probe. Thus
10m vertices need about 18 GB, which is more than one DO's 10 GB. Tier H therefore runs on Bun only.
This is inferred by linear extrapolation; B6 measures it.

DO load. At the probe's rate (about 38,000 elements per second), 100k vertices with 500k edges take
about 16 s of CPU. A 1m graph takes about 160 s. That is more than the 30 s default CPU limit of one
request. The DO tier therefore loads through `io()` from R2 in several requests, or sets
`limits.cpu_ms`. Which one is open decision D5.

## 4. Work items (How-to for the implementer)

Each item has an acceptance test. Do the items in order. B1–B6 need no decision.

**B1 — Dataset generators.** Write `scripts/bench/datasets.ts` with the eight datasets of §3.2. Use one
seeded xorshift; move the scaling probe's copy (`scripts/scaling-probe.ts:335-339`) into a shared module
and import it in both places.
*Acceptance:* the same (name, N, seed) gives the same SHA-256 over the edge list in two processes. A
test checks the max in-degree of `powerlaw` at 10k is above 100, and the length of each `chains` chain
is 1,000.

**B2 — Baseline loaders.** Write `scripts/bench/baseline.ts`. It loads B-narrow from the same generator
with prepared `INSERT` statements in one transaction, then creates the indexes.
*Acceptance:* vertex and edge counts equal mogwai's for every dataset at 10k.

**B3 — Workload catalogue.** Write `scripts/bench/workloads.ts` with W1–W12, R1–R5, C1 and A1–A9: the
Gremlin text, the B-narrow SQL and the B-same SQL.
*Acceptance:* at 10k on `uniform5`, every W workload returns equal answers from mogwai, B-narrow and
B-same. A deliberate wrong SQL text in a unit test makes the run fail.

**B4 — Runner on Bun.** Write `scripts/bench/run.ts`. One child process per (dataset, size). Warm-up,
timed runs, percentiles, peak RSS, database size, young and warm statistics.
*Acceptance:* `bun scripts/bench/run.ts --tier S` writes a JSONL file whose header has the commit and
whose lines validate against the §3.7 shape. Two runs on one machine give W1–W12 p50 within 2× of each
other.

**B5 — Compile and per-statement metrics.** Read compile time and per-statement time from the
explain/profile instrument (`docs/2026-11-21-explain-profile-plan.md`). Do not time compile phases in
the runner itself.
*Acceptance:* each mogwai result line has `compile_cold_ms` and `compile_warm_ms`. The cold value is
larger than or equal to the warm value for every W workload.

**B6 — Tier S task and first report.** Add `mise run bench` with `sources` globs, as other tasks have.
Run tier S and tier L once. Write the result summary into
`docs/reports/2026-11-21-production-readiness/08-performance-evidence.md` §4, replacing the probe
numbers.
*Acceptance:* the summary has p50 and p95 for W1–W12 at 10k, 100k and 1m, with ratios to both
baselines.

**B7 — DO tier.** Write `scripts/bench/do.ts`. It reuses the `wrangler dev` start-up of
`test/cf-probe/spool-autoindex.probe.ts`. It loads by `io()` (CLAUDE.md, "IoStore") and runs W1–W12
and R1–R4 over HTTP with the unmodified `gremlin` client.
*Acceptance:* tier DO at 10k and 100k writes JSONL with `runtime: "do-local"`. No result is a crash.
Depends on D5.

**B8 — Concurrency.** Add C1 to the runner. On Bun, start `src/bun/server.ts` and drive K clients. On
DO, drive K clients at one DO and at K DOs.
*Acceptance:* the result shows queries per second and p95 for K = 1, 4, 16, 64. The one-DO line is
expected to stay flat in queries per second as K grows, because one DO serializes requests (inferred
from `src/api.ts:36`). The run records whether this holds.

**B9 — Ratio gate.** Bank `scripts/bench/baseline-ratios.json` from tier S. Add a check that fails when
a workload's mogwai / B-same ratio exceeds 2× its banked value. Add `mise run bench-record` to re-bank,
with the reason in the commit message, as `sql-hygiene-record` does.
*Acceptance:* a deliberate slowdown (for example, dropping `e_out` in a test copy of the schema) fails
the gate for W2–W5. Joining `ci` depends on D3.

**B10 — External baselines.** Only after D1 or D2. Write an adapter that sends the same Gremlin text over
HTTP to a server outside the repository, as `scripts/workload-goldens/generate.ts` does for goldens.
*Acceptance:* tier S results gain `system: "tinkergraph"` lines with equal answers for W1–W12.

**B11 — Adversarial report.** Run A1–A9 in tiers S and L. Write each outcome into the report.
*Acceptance:* no A case crashes. Each super-linear case either has an item in
`docs/outstanding-work.md` §2 or is added there.

## 5. Risks (Explanation)

| Risk | Check |
|---|---|
| Wall-clock noise on CI runners makes a gate flaky | gate on ratio to B-same only, at 2×; report absolute times |
| A benchmark measures the wrong plan because statistics differ | run young and warm; record which in each line |
| `wrangler dev` is not production: its CPU and memory limits differ | label results `do-local`; production numbers are D4 |
| Tier L and H take too long for a shared machine | tiers L and H never run in `ci`; each dataset is one child process and can resume |
| B-narrow looks unfair, because mogwai stores more (multi-label, typed values, replication ids) | publish B-same beside it, so the reader sees schema cost and compiler cost apart |
| The suite drifts into performance fixes | a slow result becomes an `outstanding-work.md` item under the 2× rule; it is not a plan item here |
| Never decline on data size | a decline at 1m or 10m that does not occur at 10k is a bug; B11 files it as such |

## 6. Relation to other documents (Reference)

| Document | Relation |
|---|---|
| `docs/outstanding-work.md` §2 | receives each slow result; A9 reads its witnesses |
| `docs/2026-11-21-explain-profile-plan.md` | provides compile and per-statement timing (B5) |
| `docs/limitations.md` | should state the per-DO size ceiling once B6 measures it |
| `scripts/scaling-probe.ts` | stays the growth-rate instrument for query shapes; shares the generator (B1) |

## 7. Glossary

| Term | Meaning in this file |
|---|---|
| B-narrow | the hand-written application schema and SQL of §3.3 |
| B-same | hand-written SQL over mogwai's own tables |
| DO | a Cloudflare Durable Object |
| p50 / p95 | the 50th and 95th percentile of the timed runs, nearest rank |
| tier | a fixed set of sizes and datasets that run together |
| warm / young | with or without `sqlite_stat1` from `ANALYZE` |

## 8. Open decisions for the owner

| Id | Decision | Options | Note |
|---|---|---|---|
| D1 | TinkerGraph as a performance baseline | (a) docker Gremlin Server, offline, as the goldens script does; (b) skip | needs a JVM image; no `package.json` change; precedent: `scripts/workload-goldens/generate.ts:7-11` |
| D2 | One graph-native database as a baseline | (a) Neo4j via docker and Cypher; (b) a Gremlin-native server (JanusGraph); (c) skip | needs a service and a second query text per workload; a new dependency under CLAUDE.md "Working rules" |
| D3 | Does the tier S ratio gate join `ci`? | (a) gate; (b) report-only job | (a) catches a 2× regression; (b) avoids noise until the ratios are known to be stable |
| D4 | Measure on a production Durable Object | (a) a dedicated Cloudflare account and a nightly deploy; (b) `wrangler dev` only | (a) is the only source for real CPU and memory limits; it has a cost and needs credentials in CI |
| D5 | How the DO tier loads 100k+ graphs | (a) `io()` from R2 in several requests; (b) set `limits.cpu_ms` in a bench-only wrangler config | (a) tests the product path; (b) is simpler |
| D6 | Add a compiled-SQL cache keyed by query text and parameter types | (a) a plan for it after B6; (b) no | the report's probe suggests compile (1–10 ms) dominates point queries; B6 confirms or refutes this first |
| D7 | Publish results | (a) commit a summary per release under `docs/reports/`; (b) keep results local | (a) is what the reviewer asked for |
