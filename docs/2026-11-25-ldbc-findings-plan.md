# LDBC findings — fix the three measured defects

**Status: PROPOSED (2026-11-25).**

**Source.** A head-to-head run against Relate 1.2.0 (Neo4j's embedded in-memory Cypher engine) on
LDBC SNB sf0.1: 327,588 vertices, 1,477,965 edges, Relate's own 30-query latency lane
(`/home/dan/Projects/relate/testing/relate-query-latency/workloads/graph-benchmark-ldbc/`). Both engines
answered 30/30 correctly. mogwai was 76× slower (geometric mean of p50), 12.6× with compile time
excluded. The harnesses, the graph and the per-query results are in the session scratchpad
(`ldbc-mogwai/`: `load.ts`, `bench.ts`, `graph.db`, `results.json`, `explain/`, `probe-or.ts`,
`probe-bool.ts`). The scratchpad can be cleared; each item states the facts it needs.

Item 4 of the source report (store size: one row per property plus trigram FTS rows for every
property, 1,118 MB against Relate's 35 MB) is NOT in this plan. The owner decides it separately.

## Items

### L1. A numeric equality must keep the `(key, value)` index seek

**Fact.** `has('Post','ID',962077547172)` lowers to
`value = ? OR (vtype = 'bigdecimal' AND CAST(value AS REAL) = ?)`. The `OR` stops the
`vp_key_value(key, value)` seek. SQLite reads every `ID` row (327,588) through `vp_key_value(key=?)`.
Measured: 87 ms with the `OR`, 0.018 ms with a plain `value = ?`. This one lowering makes LDBC q3,
q7, q21 and q26 slow (88–118 ms p50 each; Relate 0.05 ms).

**Where to start.** `src/compiler/rel/predicate.ts` (`STATIC_SUBJECT_CAST`, around line 60 and 111)
and the code that emits the big-decimal arm.

**Done when.**
- A numeric equality on a property is an index seek (`SEARCH … USING INDEX vp_key_value (key=? AND
  value=?)`) in `EXPLAIN QUERY PLAN`, with no full scan of the key's rows.
- A `bigdecimal` value that is numerically equal still matches. Keep or add a test for that case.
- Look for the same pattern in the other comparison operators (`gt`, `within`, …) and in edge
  properties. Fix each site through one shared rule, not per site.
- A plan-shape gate (`scripts/sql-plan.ts` or `test/plan-stability.test.ts`) fails if the `OR` form
  comes back.

### L2. Cache compiled plans

**Fact.** Compile costs more than the SQL on 22 of the 30 LDBC queries (compile p50 1.3–16 ms). On
the L6 corpus, 97% of mogwai's per-query time is compile (median 2.15 ms compile, 0.059 ms SQL).
mogwai caches only the parse (`src/gremlin/frontend.ts`, 512 entries). Relate caches the plan and
reports `planCache: miss | hit` per query; its warm total is about 0.03 ms.

**Constraints the design must respect.**
- A user parameter is a bind; a literal is inlined (CLAUDE.md, "A bind serves a user parameter").
  So a plan with only parameter binds is reusable across parameter values. The cache key is the
  canonical query text plus whatever the compile reads that is not in the text.
- Find every input the compile reads besides the text. Known: `unrollFixedRepeat` needs a parameter's
  concrete value, so that value must be in the key. Measured: on LDBC q19, `Executor.runSync` runs a
  store query DURING compile. A plan must never capture a data-dependent decision that a later write
  can make wrong. Either key on it, invalidate on write, or exclude that plan from the cache.
- Schema or catalog changes (labels, registered services, side-effect seeds) must invalidate.
- Memory is bounded: a DO isolate has about 128 MB. Use a bounded LRU per graph, sized by entries or
  bytes.
- One cache for Bun and DO.
- Expose hit/miss where the profile/explain instrument can read it
  (`docs/2026-11-21-explain-profile-plan.md`), if that instrument exists; else a counter.

**Done when.** A repeated query skips compile (measure: warm p50 on the LDBC lane and the L6 corpus
drops to roughly the SQL time). The whole suite passes with the cache on. A test proves a write that
changes a data-dependent compile decision does not serve a stale plan.

### L3. The JSON output must render a Boolean as a Boolean

**Fact.** On the `application/json` path (`Executor.jsonAsync` / the untyped renderer),
`g.inject(true)` returns `[1]` and `false` returns `[0]`. GraphBinary is correct (`0x27 01`). Every
query that ends in a Boolean (`constant(true)`, `choose(…, constant(true), constant(false))`, `is()`
over Booleans) gives a number to a JSON client.

**Done when.** `g.inject(true)`, `g.V().constant(false)`, a Boolean property value and a Boolean
inside a map/list all render as JSON `true`/`false`. A test covers each. Find the root cause (SQLite
has no Boolean storage class; the type must come from the value's carried type, not from the SQL
value), and fix it where every Boolean passes, not per step.

## Deferred / follow-ups
(none yet)
