# LDBC findings — fix the three measured defects

**Status: L1–L3 LANDED (2026-11-25). Round 2 (next-round items 1–3) LANDED (2026-11-25). Open: the
round-3 list under "Next round" and the questions under "Needs a human".**

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
- **Check if `write.ts` `decimalTextSeeks` can seek `vp_decimal` (from L1).** ✅ Done by Next round
  item 1.
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
- **Per-entry size limit for the plan cache (from L2).** ✅ Done by round-2 item 2 (`ed9ff04e`).
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

## Round 2 (landed 2026-11-25)

The owner scoped round 2 to the three reuse-sweep items. All three landed. Remains: nothing.

1. **The BigDecimal tail of the write-side merge seek** (`7d6b0bc9`, `722b7da8`). `decimalTextSeeks`
   (`src/compiler/rel/write.ts`) has one arm per stored tail. The BigDecimal arm is one point seek on
   `vp_decimal`/`ep_decimal` at every magnitude. The long/bigint TEXT arm is gated on |c| >= 2^53.
   `stringifyExact` (`src/json-exact.ts`) spools a whole number in [2^53, 2^63) as its exact digits.
   This fixes a duplicate upsert keyed on `2^55m` or on a stored double `2^55`. It also closes the
   Deferred item "Check if `write.ts` `decimalTextSeeks` can seek `vp_decimal`".
2. **One `BoundedLru<K,V>` for the parse cache and the plan cache** (`ed9ff04e`, `src/bounded-lru.ts`).
   It has an entry limit, a size limit, a per-entry limit and hit/miss stats. Sizes are in UTF-16
   units, not bytes. It closes the round-1 follow-up "Per-entry size limit for the plan cache".
3. **`disjuncts` and `disjoin` in `src/rel/expr.ts`** (`11e1b3e3`). They sit beside `conjuncts` and
   `conjoin`. The listed private OR and AND folds use them. The SQL is byte-stable.

## Parked in round 2

Five items were not built. They share ONE cause: the owner scoped round 2 to items 1–3. No item is
blocked on missing substrate, except the volatility item (see round-3 item 8). No branch exists for
any of them. Their questions are under "Needs a human". The round-3 list below orders them.

## Follow-ups from review (round 2)

Major first. Minor items are kept only when they are cheap and concrete.

- **MAJOR — the merge selectivity count ignores the BigDecimal arm (super-linear).** `cappedCount`
  (`src/compiler/rel/write.ts`, about line 4039) counts only the exact `(key, value)` arm. For a
  BigDecimal-stored key it always gives 0. The computed-search picker and the `mapDrivers` ranking
  then choose that key as the most selective. The `vp_decimal` arm returns every vertex with that
  value, once per driver. Witness: N vertices, `sku:i` (int), `price:'9.99'` (bigdecimal).
  `g.V().mergeV(__.project('sku','price').by('sku').by('price')).count()`: 733 ms at 1k, 80,650 ms at
  8k (110×). The `inject` map form: 3,020 ms / 153,097 ms (50×). Price as a double: linear. Answers are
  correct. Trunk before round 2 was also quadratic. Fix: make `cappedCount` also count a capped probe
  through `vp_decimal` (`vtype = 'bigdecimal' AND CAST(value AS REAL) = c`).
- **MAJOR — the long/bigint TEXT arm's `vtype` gate does not narrow the index (super-linear).**
  `vp_key_value` is `(key, value)` and does not hold `vtype`. When |c| >= 9e18, or the two range ends
  have different digit counts, the bounds fall back to `value >= '-' AND value < ':'`. Each driver
  then reads every numeric-looking TEXT row of the key. Witness: N `p` vertices with
  `n = '<i>0000000000000000000000.25'` (BigDecimal past 9e18), N `q` vertices with the same value
  under `m`, `g.V().hasLabel('q').mergeV(__.project('n').by(values('m')))`: 152 ms at 1k, 7,526 ms at
  8k (49×). Pre-existing (trunk 64×). Fix: past 2^63 only a `bigint` TEXT row can meet c. Below that,
  a partial index on `(key, value) WHERE vtype IN ('long','bigint')` lets the gate narrow, as
  `vp_decimal` does for the BigDecimal arm.
- **Read-path BigDecimal equality misses a large value (pre-existing wrong answer).** After
  `g.addV('p').property('n', 123456789012345678m)`, `g.V().has('n', 123456789012345678m).count()`
  returns 0. The reference returns 1. The merge in the same case matches. Probable cause: the literal
  and the REAL cast of the stored value have different number classes on the read path
  (`src/compiler/rel/predicate.ts`, `decimalTextArm`).
- **Parse-cache bounds are large for a 128 MB isolate, and one sizing rule is wrong.** Measured trees
  are about 141–207 B per text unit. At 256K units in all that is about 36–55 MB. One 64K-unit entry is
  about 13 MB. The rule `PARSE_CACHE_MAX_ENTRY_TEXT_UNITS >= PLAN_CACHE_MAX_ENTRY_TEXT_UNITS` rests on a
  wrong premise: `compilePlan` returns a plan-cache hit before it calls `parseGremlin`, so a held plan
  never reads its parse tree. Fix: remove the rule (comment and the test in
  `test/compiler/plan-cache.exec.test.ts`). Choose the parse bounds for memory only (for example 64K
  units in all and a smaller per-entry limit). No answer changes.
- **Cheap — BigDecimal merge witnesses in [2^53, 2^63).** `test/compiler/merge-decimal-seek.exec.test.ts`
  tests BigDecimals only at small magnitudes. Add a re-upsert of `36028797018963968m` and
  `98765432109876543.21m`, by inject map and by `mergeE`.
- **Cheap — `stringifyExact` doc comment is stale.** It says a finite Double crosses as JS's shortest
  spelling. A whole number in [2^53, 2^63) now crosses as exact digits (class INTEGER). `realJsonText`
  in the same file spells such a value in exponent form (class REAL). Update the comment and say why
  this branch does not use `realJsonText`.
- **To `docs/outstanding-work.md` — a side-effect membership filter is super-linear.**
  `g.V().aggregate('x').out().where(within('x')).count()` on a person graph with 2 out-edges per vertex:
  74 ms at 1k, 5,504 ms at 8k (74×). Same before round 2. Not this plan's item.
- **Covered by "Next round" reuse items 9–10:** the private OR folds left at `write.ts:1403` and
  `lower.ts:1376`, the private AND folds, and the `and`/`or` copies in `receiver.ts`.

## Next round

This is the proposed round-3 order. The owner decides the scope (see "Needs a human"). Wrong answers
come first, then super-linear costs, then cheap fixes, then byte-stable reuse.

1. **A list nested in a map/record value keeps its static member type** (`project-fold-member-tag`;
   `docs/outstanding-work.md` `project-fold-type-loss` and `project-count-fold-class`).
   `project().by(...fold())`, `by()` of a `by()` and `select(a,b)` lose the member tag. Witnesses:
   `g.inject(true).project('b').by(fold())` gives `{"b":[1]}`; `project().by(out().count().fold())`
   frames the count as Int. `group().by().by(fold())` and `map(fold())` keep the type. Carry the tag
   through the one map/record lowering, not per host.
2. **Run-time equality sets, part A: unwrap folded-set members** (`decimal-arm-runtime-bounds` A). A
   folded set of doubles or dates compares wrongly. Land before part B.
3. **Run-time equality sets, part B: the decimal arm for `within(listParam)`.** Stored `age=29m`:
   `has('age', within(xs))` with `xs=[29,30]` misses the BigDecimal row. The `json_each` path gets no
   `decimalTextArm` (`src/compiler/rel/predicate.ts`). Fix it through the one decimal-arm rule. Do the
   read-path large-BigDecimal miss (follow-up above) in the same item. The correlated operand form
   (`has('age', select('a').values('age'))`) looks contrived; the owner decides.
4. **Merge seek stays linear on BigDecimal keys.** The two MAJOR follow-ups above: `cappedCount`
   counts the decimal arm, and the long/bigint TEXT arm gets an index its gate can narrow. Add the
   [2^53, 2^63) witnesses and the `stringifyExact` doc fix here.
5. **Parse-cache bounds for memory** (follow-up above). Small.
6. **GraphBinary frames a boolean tag through `booleanOfStored`; name `vp_decimal`/`ep_decimal` in the
   index-build-on-deploy note** (round-1 follow-ups, about 5 lines).
7. **Sargable seek range for an ordered predicate** (`has(k, gt/lt/between/inside …)`; the Deferred
   item above). Linear today, but common reach (range filters, LDBC dates). It is a range derivation
   (Calcite `Sarg`, `vendor/calcite/core/src/main/java/org/apache/calcite/rex/RexSimplify.java`), and
   it can use `disjuncts` from round 2.
8. **Prerequisite for item 9: `UUID()` returns a value** (`docs/outstanding-work.md` `uuid-literal`).
   `g.inject(UUID())` returns `[]` today. Lower it to a random v4 value tagged `uuid`, or decline it
   with a limitations line.
9. **One volatility authority** (`volatility-one-authority`; round-1 follow-up "Volatility has two
   authorities"). The literal visitor declares a dynamic literal. `compilePlan` asks the same
   predicate. No answer changes until item 8 gives a second dynamic literal.

### Reuse sweep (byte-stable unless said)

10. **Route the remaining ~25 reduce-based AND/OR folds onto `conjoin`/`disjoin`.** Sites:
    `src/rel/decorrelate.ts:113,146,316`; `src/rel/passes/leading.ts:220,228,297`;
    `src/compiler/rel/lower/scoped.ts:1185,1272,2680`; `slice.ts:725`; `branch.ts:1269`; `map.ts:1695`;
    `lower.ts:6621,1376,2326`; `transform.ts:299`; `projector.ts:225`; `predicate.ts:1191`;
    `write.ts:1403,3696,3858,4091,4215,6319`. A seedless `reduce` throws a bare `TypeError` on an empty
    array; `conjoin` returns `undefined` and the type checker makes the caller handle it. Check with
    `bun scripts/refs.ts conjoin`/`disjoin` and a grep for hand-written `op: 'and'|'or', left`.
11. **Delete `receiver.ts`'s private `and`/`or`** (`src/compiler/rel/receiver.ts:79-80`). Import them
    from `src/rel/expr.ts`. `scoped.ts:1544` becomes `(step.name === 'or' ? disjoin : conjoin)(preds)!`.
12. **One builder for the BigDecimal compare form that `vp_decimal`/`ep_decimal` index.**
    `predicate.ts:258` `decimalTextArm` (read) and `write.ts:3981` `decimalTextSeeks` (write) both
    spell the index expression of `src/storage.ts:251`. One `decimalCompare(value, vtype, c)` in
    `build.ts` keeps them in step. Do it with item 3 or item 4.
13. **Share the all-null `concat` guard** between `lower.ts:2320-2327` and `transform.ts:294-300`
    (`allNullGuard(parts, body)` beside `VALUE_TX`, built on `conjoin`).
14. **Name the tautology once** (`always` in `src/rel/expr.ts`; 17 spellings of
    `eq(compilerInt(1), compilerInt(1))`). The seeded folds at `write.ts:4102,4105,4257,4278` become
    `conjoin(xs) ?? always`. That drops a leading `1=1 AND`: a SQL TEXT change with no answer change,
    so the sql-plan and sql-hygiene baselines move and the commit must say so. Keep it a separate
    commit from item 10.

## Needs a human

Round-2 questions, verbatim:

- **`boolean-frame-and-index-note` (round-3 item 6):** "You asked for items 1, 2, 3. These two round-1
  follow-ups are about 5 lines in total. Do you want them in this round, or in a later one?"
- **`project-fold-member-tag` (round-3 item 1):** "This is a real wrong answer (Int for a count, 1 for
  true) at plausible reach, and it is not in '1,2,3'. Add it to the next round, first in order?"
- **`decimal-arm-runtime-bounds` (round-3 items 2–3):** "Part A is a wrong answer on plain
  doubles/dates at plausible reach; part B needs a stored BigDecimal. Take A in the next round, and B
  only if you want it? The correlated part looks contrived — drop it?"
- **`volatility-one-authority` (round-3 items 8–9):** "No answer changes until a second dynamic literal
  exists. Do it with the UUID() fix (g.inject(UUID()) returns [] today), or leave it?"
- **`sargable-ordered-range` (round-3 item 7):** "Linear today, not a regression, but common reach
  (range filters, LDBC dates). Take it in the next round after the disjuncts move?"

Still open from round 1: item 4 of the source report (store size) is the owner's decision; see the
top of this file.
