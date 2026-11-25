# LDBC findings — fix the three measured defects

**Status: L1–L3 LANDED (2026-11-25). Open: the follow-ups and the next-round items below.**

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

**✅ LANDED (2026-11-25, `e5933675`).** The owner seek (`indexSeek`, `src/rel/passes/semijoin.ts`,
`seekArms`) reads a value-pinning OR as a UNION ALL of seek arms under its DISTINCT. New partial
indexes `vp_decimal`/`ep_decimal` (`src/storage.ts`) serve the BigDecimal arm. One rule serves eq
and within, on vertex and edge properties. Gates: `test/plan-stability.test.ts`,
`test/compiler/numeric-eq-seek.exec.test.ts`.

**What remains.** Nothing in this item. Follow-ups are in "Deferred" below.

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

**✅ LANDED (2026-11-25, `0caf17ad`).** `compilePlan` looks a request up in a bounded LRU on the app
scope (`planCache`, `src/compiler/plan-cache.ts`) before it compiles. One path serves Bun, the DO and
the CF edge. Gate: `test/compiler/plan-cache.exec.test.ts`.

**What remains.** Nothing in this item. v2 and segment-plan heads are in "Deferred" below.

- The key is the text, each parameter's value and type, the federation depth and the detached mode.
- Only a single-statement plan is cached. A segment plan, a failed compile, a query with a
  no-argument `datetime()`, and a parameter set larger than 4 KB are never cached.
- The LRU holds 512 entries and 8 MB of text per app scope.
- A compile does not read the store, so a write cannot make a cached plan stale.
- Measured: 28 of 30 LDBC queries hit. A warm compile is about 2 µs. q17 and q19 are segment plans
  and do not hit.
- v1 serves only repeated IDENTICAL requests. See Deferred for v2.

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

**✅ LANDED (2026-11-25, `318a9dd9`).** The untyped renderer reads the value's `boolean` tag in
`untypedLeaf` (every scalar leaf) and `scalarKey` (every scalar map key) in `src/untyped.ts`. One
decode, `booleanOfStored` in `src/gremlin/types.ts`, now serves GraphSON, CSV and the JSON response.
Test: `test/untyped-boolean.test.ts`.

**What remains.** Not in the JSON renderer, so not fixed here:
- A list that `project().by(...fold())` collects loses its Boolean or datetime type, on GraphBinary
  too. `g.inject(true).project('b').by(fold())` gives `{"b":[1]}`. A datetime comes back as a plain
  number. `group().by().by(fold())` and `map(fold())` keep the type. Tracked in
  `docs/outstanding-work.md` as `project-fold-type-loss`.
- Already true before this change: an error response is GraphBinary even when the request asks for JSON.

**Fact.** On the `application/json` path (`Executor.jsonAsync` / the untyped renderer),
`g.inject(true)` returns `[1]` and `false` returns `[0]`. GraphBinary is correct (`0x27 01`). Every
query that ends in a Boolean (`constant(true)`, `choose(…, constant(true), constant(false))`, `is()`
over Booleans) gives a number to a JSON client.

**Done when.** `g.inject(true)`, `g.V().constant(false)`, a Boolean property value and a Boolean
inside a map/list all render as JSON `true`/`false`. A test covers each. Find the root cause (SQLite
has no Boolean storage class; the type must come from the value's carried type, not from the SQL
value), and fix it where every Boolean passes, not per step.

## Deferred / follow-ups

- **Derive a sargable seek range for an ordered numeric predicate (from L1).** `has(k, gt(29))` lowers
  to a type-dispatching `CASE` (`ordered`, `src/compiler/rel/predicate.ts`). No index can serve a
  `CASE`, so the owner seek reads `vp_key_value(key=?)`: every row of the key. The fix needs a range
  derivation: a native arm `value > X AND value < ''` plus the decimal arm on `vp_decimal`. That is a
  different mechanism from L1's OR expansion (Calcite's `Sarg`/`RexSimplify` family,
  `vendor/calcite/core/src/main/java/org/apache/calcite/rex/RexSimplify.java`). Measured cost today:
  linear in the key's rows (0.9 ms at 1k, 6.2 ms at 8k). It is not a regression.
- **A user `or()` of equalities keeps the key-wide seek (from L1).** `has(k, eq(1).or(eq(2)))` gives
  disjuncts that each hold a NESTED `OR` (raw compare or decimal arm). `seekArms`
  (`src/rel/passes/semijoin.ts`) expands one disjunction only, never a general DNF (arm count against
  the 100 KB statement cap). `within(1, 2)` is the common spelling and seeks. Revisit only with evidence.
- **Check if `write.ts` `decimalTextSeeks` can seek `vp_decimal` (from L1).** Its BigDecimal half may
  use the new index. It also covers the long-as-TEXT tail, so it is not a drop-in deletion.
- **L2 v2 — pin-on-read parameters.** v1 keys on every parameter value. So one text sent with
  different parameter values gets no hit. In v2, the compile records which parameters it read the
  VALUE of (pinned, as TinkerPop's `GValueManager` does). The key holds only the pinned values. A hit
  rebinds the unpinned parameters by name through the kernel's named-bind keying. A derived bind
  (`#fts`) is recomputed or treated as pinned.
- **L2 — segment-plan heads under the cache.** v1 never caches a segment plan (LDBC q17, q19). A
  segment's head can be cached. Its resume compiles against landed rows and must never be cached.

## Follow-ups from review (round 1)

All findings were minor. They are ordered: wrong answers first, then cheap fixes, then design notes.

- **`within()` with a LIST parameter misses a stored BigDecimal (pre-existing wrong answer).** Stored
  `age=29m`: `g.V().has('age', within(xs))` with `xs=[29,30]` returns `[marko]`. `within(29,30)` and
  `has('age', x)` return `[dec, marko]`. The `json_each` path gets no `decimalTextArm`
  (`src/compiler/rel/predicate.ts`). The correlated form
  `has('age', select('a').values('age'))` also leaves it out. Same answer and SQL before L1. Fix the
  json_each and correlated arms through the one decimal-arm rule, not per site.
- **GraphBinary does not use `booleanOfStored` (from L3, cheap).** `frameValue`
  (`src/execute.ts`, around line 333) decodes a `boolean` tag with `Boolean(v)`. Use
  `booleanOfStored` there, so the comment "the one decode every external form uses" is true. No
  answer changes for stored 1/0/true/false.
- **Volatility has two authorities (from L2).** `readsClock` (`src/gremlin/frontend.ts`) finds a
  no-argument `datetime()` again. The clock is read at `emitArg` (`Date.now()`). Make the emit site
  record "volatile" in a per-compile sink, and make `compilePlan` read that sink. Then a new volatile
  literal (for example a random `UUID()`) cannot be cached by mistake.
- **Per-entry size limit for the plan cache (from L2).** A batch-insert text of 500 inline `addV`s
  holds about 330 KB per entry. Measured: 20 entries filled 6.7 MB of the 8 MB budget. Do not hold a
  plan whose key plus SQL is over about 64–256 KB, the same idea as `PLAN_CACHE_MAX_PARAM_KEY`.
  Also: the byte bound counts string `.length` (UTF-16 units) and no object overhead, so "8 MB" is
  about 16 MB of heap. Rename or reword the bound.
- **One-off write plans evict hot reads (from L2).** Distinct-parameter `addV` writes all miss and
  fill the LRU. No wrong answer, miss cost is in the noise. Do this with L2 v2 (pin-on-read): an
  admission rule for write programs. Not v1 work.
- **Index build on first open after deploy (from L1).** `vp_decimal`/`ep_decimal` are built by
  `CREATE INDEX IF NOT EXISTS` in the DO constructor (`src/cloudflare/graph-store-do.ts`). A partial
  index still scans the whole property table once. On a large existing graph, the first open pays a
  cost that grows with the graph. `e_label`/`e_pair` already do this. Add one line on index-build
  migration on a big DO to the deploy notes or `docs/outstanding-work.md`.
- **Already recorded under L3:** an error response is GraphBinary even when the request asks for
  JSON (`src/untyped.ts`).

## Next round

The reuse sweep proposed these. Each one changes no answer.

1. **Serve the BigDecimal tail of the write-side seek through `vp_decimal`/`ep_decimal`.** This
   replaces the Deferred item "Check if `write.ts` `decimalTextSeeks` can seek `vp_decimal`".
   `decimalTextSeeks` (`src/compiler/rel/write.ts`, called from `propertySeeks`) does 6 prefix probes
   per NUMERIC driver. A safe-range long is never stored as TEXT (`storedScalar`,
   `src/gremlin/types.ts`), so the `prefixed` arm (|c| < 2^52) finds only `bigdecimal` rows. Replace
   it with one seek: `vtype = 'bigdecimal' AND key = k AND CAST(value AS REAL) = c`. Put the `vtype`
   term on the scan, because SQLite uses a partial index only when the WHERE implies it. Narrow the
   `spanned` arm to the long/bigint TEXT tail (|c| >= 2^53). The residual still decides. Test:
   mergeV/mergeE matching `1m`, `2^60` as a long, and a string key, in the style of
   `test/compiler/numeric-eq-seek.exec.test.ts`. About 25 lines removed.
2. **One bounded LRU for the parse cache and the plan cache.** `parseGremlin`
   (`src/gremlin/frontend.ts`, `parseCache`, count limit only) and `PlanCache`
   (`src/compiler/plan-cache.ts`, count + bytes) use the same delete-then-set `Map` idiom. Extract a
   `BoundedLru<K,V>` with an optional size function. The parse cache then gets a byte limit (today 512
   texts of 100 KB can outgrow the plan cache's whole budget) and hit/miss stats. Do the per-entry
   size limit above in the same primitive.
   **✅ LANDED (2026-11-25, `ed9ff04e`).** `BoundedLru<K,V>` (`src/bounded-lru.ts`) holds both caches.
   It has an entry limit, a size limit, a per-entry limit and hit/miss stats. The size wording now
   says "UTF-16 units", not bytes. The parse cache holds 512 entries, 256K units, 64K per entry.
   This also closes the round-1 follow-up "Per-entry size limit for the plan cache". Remains: nothing.
3. **Move `disjuncts` beside `conjuncts` in `src/rel/expr.ts`.** It is a private copy in
   `src/rel/passes/semijoin.ts` with `or` in place of `and`. The Deferred `eq().or(eq())` case and the
   rowid/uid disjunction in `src/compiler/rel/source.ts` (a private `disjunction` builder) will need
   it there. Move only.
   **✅ LANDED (2026-11-25, `11e1b3e3`).** `disjuncts` and `disjoin` (the OR twin of `conjoin`) are in
   `src/rel/expr.ts`. The private OR and AND folds now use them. The SQL is byte-stable. Remains:
   nothing.

## Needs a human

None from round 1. Item 4 of the source report (store size) stays the owner's decision; see the top
of this file.
