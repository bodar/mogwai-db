# LDBC findings — fix the three measured defects

**Status: L1–L3 LANDED (2026-11-25). Round 2 LANDED (2026-11-25). Round 3 LANDED (item 5 on
2026-11-26, `1c5020d9`). Open: "Parked in round 3", "Follow-ups from review (round 3)" and the round-4 list under
"Next round (round 4)".**

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
- ✅ *(Landed 2026-11-25 as round-3 item 6.)* **GraphBinary does not use `booleanOfStored` (from L3, cheap).** `frameValue`
  (`src/execute.ts`, around line 333) decodes a `boolean` tag with `Boolean(v)`. Use
  `booleanOfStored` there, so the comment "the one decode every external form uses" is true. No
  answer changes for stored 1/0/true/false.
- **Volatility has two authorities (from L2).** ✅ Done by round-3 items 8–9: one predicate,
  `dynamicLiteral` (`src/gremlin/frontend.ts`), drives the value draw and `isVolatileQuery`.
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

- **(Subsumed by round-3 item 3.) MAJOR — the merge selectivity count ignores the BigDecimal arm (super-linear).** `cappedCount`
  (`src/compiler/rel/write.ts`, about line 4039) counts only the exact `(key, value)` arm. For a
  BigDecimal-stored key it always gives 0. The computed-search picker and the `mapDrivers` ranking
  then choose that key as the most selective. The `vp_decimal` arm returns every vertex with that
  value, once per driver. Witness: N vertices, `sku:i` (int), `price:'9.99'` (bigdecimal).
  `g.V().mergeV(__.project('sku','price').by('sku').by('price')).count()`: 733 ms at 1k, 80,650 ms at
  8k (110×). The `inject` map form: 3,020 ms / 153,097 ms (50×). Price as a double: linear. Answers are
  correct. Trunk before round 2 was also quadratic. Fix: make `cappedCount` also count a capped probe
  through `vp_decimal` (`vtype = 'bigdecimal' AND CAST(value AS REAL) = c`).
- **(Subsumed by round-3 item 3.) MAJOR — the long/bigint TEXT arm's `vtype` gate does not narrow the index (super-linear).**
  `vp_key_value` is `(key, value)` and does not hold `vtype`. When |c| >= 9e18, or the two range ends
  have different digit counts, the bounds fall back to `value >= '-' AND value < ':'`. Each driver
  then reads every numeric-looking TEXT row of the key. Witness: N `p` vertices with
  `n = '<i>0000000000000000000000.25'` (BigDecimal past 9e18), N `q` vertices with the same value
  under `m`, `g.V().hasLabel('q').mergeV(__.project('n').by(values('m')))`: 152 ms at 1k, 7,526 ms at
  8k (49×). Pre-existing (trunk 64×). Fix: past 2^63 only a `bigint` TEXT row can meet c. Below that,
  a partial index on `(key, value) WHERE vtype IN ('long','bigint')` lets the gate narrow, as
  `vp_decimal` does for the BigDecimal arm.
- **(Fixed by round-3 item 3.) Read-path BigDecimal equality misses a large value (pre-existing wrong answer).** After
  `g.addV('p').property('n', 123456789012345678m)`, `g.V().has('n', 123456789012345678m).count()`
  returns 0. The reference returns 1. The merge in the same case matches. Probable cause: the literal
  and the REAL cast of the stored value have different number classes on the read path
  (`src/compiler/rel/predicate.ts`, `decimalTextArm`).
- **(Round-3 item 5 — parked, see "Parked in round 3".) Parse-cache bounds are large for a 128 MB isolate, and one sizing rule is wrong.** Measured trees
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

## Round 3 (2026-11-25/26)

**Owner review (2026-11-25): mechanical sympathy, not Java emulation.** The rule
(CLAUDE.md, "A faithful port"): fix a wrong answer in the way SQLite and JS do it naturally; if that is
not possible, decline it. Do not build machinery to give Java's exact number behaviour.
`docs/limitations.md` already accepts that a `bigdecimal` compares at double precision. The review
made these changes:
- **Cut item 4** (merge seek on BigDecimal keys, the two MAJOR follow-ups, the [2^53, 2^63) witnesses,
  the `stringifyExact` doc fix). It is the cost of the TEXT-stored decimal arms, and item 3 removes them.
- **Cut the correlated form of item 3.** It is contrived.
- **Replace item 3** with a storage change that removes the decimal arms rather than adding more.
- Items 1, 2, 5–14 stay. None of them copies Java. Items 1, 2 and 8 are wrong answers.

This is the round-3 order. Wrong answers come first, then super-linear costs, then cheap fixes, then
byte-stable reuse.

1. **A list nested in a map/record value keeps its static member type** (`project-fold-member-tag`;
   `docs/outstanding-work.md` `project-fold-type-loss` and `project-count-fold-class`).
   `project().by(...fold())`, `by()` of a `by()` and `select(a,b)` lose the member tag. Witnesses:
   `g.inject(true).project('b').by(fold())` gives `{"b":[1]}`; `project().by(out().count().fold())`
   frames the count as Int. `group().by().by(fold())` and `map(fold())` keep the type. Carry the tag
   through the one map/record lowering, not per host.
   ✅ **Landed 2026-11-25 (`d232b713`).** `listNodeExpr` emits `{t:'list', m:<tag>, v}` once per list
   when the static member type is not implied by the storage class (`LOSSLESS_VTYPES`). One JS helper,
   `taggedMembers`/`listMembers` (`src/gremlin/types.ts`), serves every list framer. The group value path
   drops `selfDescribingList`. Tests: `test/compiler/nested-list-member-type.exec.test.ts`,
   `test/L4-addendum/nested-list-member-type.feature`. Remains: nothing.
2. **Run-time equality sets, part A: unwrap folded-set members** (`decimal-arm-runtime-bounds` A). A
   folded set of doubles or dates compares wrongly. Land before part B.
   ✅ **Landed 2026-11-25 (`27d0e19e`).** `foldedListSet` reads each member through `list.ts`
   `payloadOf`, the one payload authority; the `select(Column.values)` arm uses the same helper. Every
   caller gets it: `has`/`is`/`where`, `exists`, connector bodies. Linear at N=1k/8k. Test:
   `test/compiler/folded-set-payload.exec.test.ts`. Remains: nothing (part B is item 3).
3. **Store a comparable REAL for a `bigdecimal` / out-of-range `bigint`; keep the exact text only for
   output.** Today such a value is TEXT in `value`, so every compare site needs a decimal arm
   (`decimalTextArm` in `predicate.ts`, `decimalTextSeeks` in `write.ts`, the `seekArms` OR expansion in
   `semijoin.ts`, `vp_decimal`/`ep_decimal` in `storage.ts`). Each site that lacks an arm is a missed row:
   `within(listParam)` misses a stored `29m`, and `has('n', 123456789012345678m)` returns 0. The arms
   also cause the two quadratic merge costs. The documented semantics is already "compare at double
   precision" (`docs/limitations.md`). So store the double in `value`, which SQLite compares and
   indexes natively, and keep the exact digits in a nullable column used only to frame the output.
   Then delete the decimal arms, the two partial indexes and the OR expansion where only they used it.
   This includes round 2's merge-side BigDecimal arm (`7d6b0bc9`). Keep `722b7da8` (a JS double past
   2^53 crosses JSON as its own exact digits): that is JS-to-SQLite value fidelity, not Java emulation,
   and it stops a duplicate upsert of a plain double.
   No migration (pre-alpha). Done when: the witnesses above return the right rows, a BigDecimal still
   round-trips exactly, and LDBC q3/q7/q21/q26 keep their plain seek.
   ✅ **Landed 2026-11-25 (`88bc891c`, `d3aa060e`, `c2e13ae8`).** `value` holds the comparable form
   (REAL for a BigDecimal or a BigInteger past int64, INTEGER for a long). A nullable `exact` column
   holds the digits for output only. `storedForm` (`src/compiler/rel/build.ts`) is the one write
   conversion. `storedPayload` (`COALESCE(exact, value)`) is the one read for output. A nested operand
   converts by its tag through `comparableOf`. Deleted: `vp_decimal`/`ep_decimal`, `decimalTextSeeks`,
   the stored-row `decimalTextArm`, and the `seekArms` reason. Two divergences are added to
   `docs/limitations.md`. Test: `test/compiler/comparable-storage.exec.test.ts`. Every witness is at
   most 7.5× from 1k to 8k. Remains: nothing.
4. *(Cut by owner review — subsumed by item 3.)*
5. **Parse-cache bounds for memory** (follow-up above). Small.
   ✅ **Landed 2026-11-26 (`1c5020d9`)**, rebased onto trunk; the `isVolatileQuery` comment keeps both edits.
6. **GraphBinary frames a boolean tag through `booleanOfStored`; name `vp_decimal`/`ep_decimal` in the
   index-build-on-deploy note** (round-1 follow-ups, about 5 lines).
   ✅ **Landed 2026-11-25 (first half, `71265cd0`).** `frameValue` (`src/execute.ts`) decodes a `boolean` tag with
   `booleanOfStored`, the one decode GraphSON, CSV and JSON use. Test: `test/graphbinary-boolean.test.ts`.
   Remains: nothing. The index-note half is moot: item 3 deletes `vp_decimal`/`ep_decimal`.
7. **Sargable seek range for an ordered predicate** (`has(k, gt/lt/between/inside …)`; the Deferred
   item above). Linear today, but common reach (range filters, LDBC dates). It is a range derivation
   (Calcite `Sarg`, `vendor/calcite/core/src/main/java/org/apache/calcite/rex/RexSimplify.java`), and
   it can use `disjuncts` from round 2.
   ✅ **Landed 2026-11-26 (`6fb4f9fe`, `34d6d6d1`).** `storedRange` (`src/compiler/rel/predicate.ts`)
   lowers an ordered predicate on a stored property to a range in SQLite storage-class order plus a
   vtype residual, not a `CASE`. The owner seek reads the range through `(key, value)`; a correlated
   check hides it (`unindexed`) and keeps `(node, key)`. An element pinned by id (`ElementFacts.pinned`,
   `src/rel/passes/semijoin.ts`) gets no lifted seek. Tests: `test/compiler/stored-range.exec.test.ts`,
   `test/plan-stability.test.ts`. Selective ranges are now near flat from 1k to 8k; wide ones are at
   most 9.8×. Remains: nothing.
8. **Prerequisite for item 9: `UUID()` returns a value** (`docs/outstanding-work.md` `uuid-literal`).
   `g.inject(UUID())` returns `[]` today. Lower it to a random v4 value tagged `uuid`, or decline it
   with a limitations line.
9. **One volatility authority** (`volatility-one-authority`; round-1 follow-up "Volatility has two
   authorities"). The literal visitor declares a dynamic literal. `compilePlan` asks the same
   predicate. No answer changes until item 8 gives a second dynamic literal.
   ✅ **Items 8 and 9 landed 2026-11-25 (`afde6e28`).** `g.inject(UUID())` draws `crypto.randomUUID()`,
   tagged `uuid` (reference: `GenericLiteralVisitor.visitUuidLiteral`). One predicate, `dynamicLiteral`
   (`src/gremlin/frontend.ts`), drives the value draw and `isVolatileQuery`; `readsClock` is deleted. The
   value is memoised per request in `ParamEnv.dynamicLiterals`, so a body extracted twice reads one value.
   Test: `test/compiler/dynamic-literal.exec.test.ts`. Remains:
   - Two dateDiff constant-fold sites still extract with `NO_PARAMS`: `src/compiler/rel/transform.ts:471/474`
     and `src/gremlin/coerce.ts:636/703`. Each draws its own `datetime()` at its site, and the env is not
     in scope there. This is ms-level and is the same as before this change.
   - A federated pushdown sends the query text to a sibling graph, so the sibling draws its own `UUID()`.
   - The census shows 7 traversals that execute now but are not in the baseline. They are on trunk
     already and have nothing to do with this change, so the census is not re-recorded.

### Reuse sweep (byte-stable unless said)

10. **Route the remaining ~25 reduce-based AND/OR folds onto `conjoin`/`disjoin`.** Sites:
    `src/rel/decorrelate.ts:113,146,316`; `src/rel/passes/leading.ts:220,228,297`;
    `src/compiler/rel/lower/scoped.ts:1185,1272,2680`; `slice.ts:725`; `branch.ts:1269`; `map.ts:1695`;
    `lower.ts:6621,1376,2326`; `transform.ts:299`; `projector.ts:225`; `predicate.ts:1191`;
    `write.ts:1403,3696,3858,4091,4215,6319`. A seedless `reduce` throws a bare `TypeError` on an empty
    array; `conjoin` returns `undefined` and the type checker makes the caller handle it. Check with
    `bun scripts/refs.ts conjoin`/`disjoin` and a grep for hand-written `op: 'and'|'or', left`.
    ✅ **Items 10, 11 and 13 landed 2026-11-26 (`20a36e55`).** Every seedless AND/OR `reduce` uses
    `conjoin`/`disjoin` (`src/rel/expr.ts`). Each caller handles `undefined`. `receiver.ts` and
    `semijoin.ts` lose their private folds. `allNullGuard` (`src/compiler/rel/transform.ts`, beside
    `VALUE_TX`) serves both `concat` sites. `test/rel-expr-folds.test.ts` fails on a new seedless
    AND/OR `reduce`. Byte-stable. Remains: nothing.
11. **Delete `receiver.ts`'s private `and`/`or`** (`src/compiler/rel/receiver.ts:79-80`). Import them
    from `src/rel/expr.ts`. `scoped.ts:1544` becomes `(step.name === 'or' ? disjoin : conjoin)(preds)!`.
12. *(Cut by owner review — item 3 deletes both spellings.)*
13. **Share the all-null `concat` guard** between `lower.ts:2320-2327` and `transform.ts:294-300`
    (`allNullGuard(parts, body)` beside `VALUE_TX`, built on `conjoin`).
14. **Name the tautology once** (`always` in `src/rel/expr.ts`; 17 spellings of
    `eq(compilerInt(1), compilerInt(1))`). The seeded folds at `write.ts:4102,4105,4257,4278` become
    `conjoin(xs) ?? always`. That drops a leading `1=1 AND`: a SQL TEXT change with no answer change,
    so the sql-plan and sql-hygiene baselines move and the commit must say so. Keep it a separate
    commit from item 10.
    ✅ **Landed 2026-11-26 (`8cff5c66`).** All 19 spellings of `1 = 1` are now the one `always`
    (`src/rel/expr.ts`). Seeded folds use `conjoin(xs) ?? always`. SQL text only, no answer change.
    The sql-hygiene baseline moved. The sql-plan baseline did not. Remains: nothing.

## Parked in round 3

Two items did not land. Neither needs new substrate. The cause is the same for both: the round built
them from a doc state that other landings had already moved. So there is no prerequisite item, only a
rebase.

- **Item 5, parse-cache bounds** (resume branch `wf/parse-cache-bounds-1-0`, `7269cbf9`, worktree
  `.claude/worktrees/wf_b159e7ce-919-5`). It is built and `mise run ci` was green on its base
  `2f1fcfc4`. The land failed. On trunk it conflicts in `src/gremlin/frontend.ts`: items 8+9
  (`afde6e28`) rewrote the `isVolatileQuery` comment that this commit also edits. Resume: rebase onto
  trunk, keep both comments, run `mise run ci`, land. Review follow-ups for the same commit:
  - Give the test "a large batch write compiled again and again is never held, and hot reads stay"
    (`test/compiler/plan-cache.exec.test.ts`) an explicit timeout. It took 6.8 s on a cold run against
    the 5 s default. The cause is the batch compile (about 300 ms per compile), not this commit.
  - Add one line to the `frontend.ts` comment that names the trade: a text of 4K–64K units that misses
    the plan cache (segment plan, volatile text, long param key) is parsed again on each compile. The
    cost is linear in text length (about 2 ms at 5K, 13 ms at 60K units). No answer changes.
- **Item 6, GraphBinary boolean decode.** Nothing remains. The round built it again
  (`wf/graphbinary-boolean-decode-1-0`, `0131bb50`), but the same patch is already on trunk as
  `71265cd0` (identical `git patch-id`). The branch can be deleted.

## Follow-ups from review (round 3)

Major first. Minor items are kept only when they are cheap and concrete.

- **MAJOR — a label value join got about 2× slower (item 3, `src/compiler/rel/predicate.ts`,
  `src/compiler/rel/build.ts` `comparableOf`).** At 8k vertices, trunk before item 3 / after:
  `g.V().values('age').as('e').V().has('age', select('e'))` 973 / 2029 ms (2.08×, past the 2× bar);
  the same on `name` 21.8 / 44.9 ms; `has('age', __.values('age')).count()` 5.4 / 9.9 ms. Growth stays
  linear. SQL bytes for the `name` join: 2180 → 10492. Two causes:
  (a) `comparableOf` re-inlines the operand in each `CASE` arm (two tag tests, three value reads), in
  both the `IN` copy and the `EXISTS` copy. That breaks "an expression used N times is computed once".
  (b) For a correlated `__.values(k)` or `__.select('a').values(k)` operand, `comparedOnce` adds a second
  correlated seek of the same property row only to read its `vtype`.
  Fix: an operand that is a STORED property row reads that row's own `value` column, which is already
  in comparable form. No tag, no `+ 0`, no second seek. Convert by tag only for a true stream operand,
  and bind payload and tag once. A string or int key must not pay for a conversion that cannot matter.
- **MAJOR — `comparableOf` is a second payload-to-comparable authority beside `storedForm`.** After
  `c2e13ae8` the BigDecimal arm is `CAST AS REAL`, as `storedForm` stores it. The long/bigint arm is
  still `+ 0`, a parallel rule. Make `comparableOf` reuse `storedForm`'s value arm, spelled with one
  payload read. Do this with the item above; it is the same code.
- ✅ **LANDED (`7474be16`, round-4 item 2).** **MAJOR, pre-existing wrong answer — an infix connective inside `local()` drops the whole chain**
  (`src/compiler/ir/strategies.ts`). `g.V().hasLabel('person').local(__.has('age').or().has('lang')).count()`
  returns all 6 modern vertices as element rows; the reference is `[4]`. `local(__.has('age').and().has('name'))`
  fails the same way. `map(...)`, `filter(...)` and the step form `local(__.or(...))` answer correctly. The
  connective rewrite must stay inside the child body. Reference:
  `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/decoration/ConnectiveStrategy.java`.
- ✅ **LANDED (`1d7beeaf`, round-4 item 5).** **MAJOR, pre-existing super-linear — an edge upsert that MATCHES existing edges is quadratic**
  (`src/compiler/rel/write.ts`). `g.V().hasLabel('p').as('a').out('k').as('b').mergeE([(T.label):'k',
  (Direction.from):Merge.outV, (Direction.to):Merge.inV]).option(Merge.outV, __.select('a'))
  .option(Merge.inV, __.select('b')).count()`: 120 ms at 1k, 5,229 ms at 8k (44×); with
  `option(onMatch, …)` on `knows`, 280 ms / 18,911 ms (67×). The match join is
  `pw r INNER JOIN edges wt ON (src, tgt) WHERE wt.id IN (SELECT id FROM edges WHERE label IN (…))`;
  `EXPLAIN` shows `e_pair (src=? AND tgt=? AND rowid=?)`, so SQLite walks the whole label id list per
  driver row. Fix: test the label as a residual on the `e_pair` row, not as a rowid `IN` set. Answers
  are correct.
- **Pre-existing wrong answer — a nested-operand ORDERING has no comparability guard**
  (`src/compiler/rel/predicate.ts` `comparedOnce`). On one key with `'10'`, `10`, `10.00m`, `'x'`,
  `has('s', P.gt(__.V().has('k','b').values('s')))` also returns the String rows (SQLite: TEXT > number).
  The literal `has('s', gt(5))` answers correctly. Reference: an incomparable pair is false
  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java`).
  The `VALUES` row already holds the operand's tag, so apply the `NUMERIC_VTYPES` class guard that the
  literal path uses.
- **To `docs/outstanding-work.md`:**
  - `g.V(51).hasLabel('person').count()` is a point read that reads every `person` vertex
    (`rn.id IN (SELECT node FROM vertex_labels WHERE label IN (…))`): 0.06 / 0.48 ms at 1k / 8k (8.6×).
    Pre-existing (`src/compiler/rel/lower.ts`).
  - `g.V().has('d', within(__.V().values('d').fold()))` folds the set twice: once in the `IN`
    pre-filter, once in the `EXISTS`. A constant 2×, not super-linear (`src/compiler/rel/lower/reduction.ts`).
  - A nested operand that traverses an edge declines: `has('price', P.eq(__.out('k').values('price')))`,
    `within(__.out('k').values('price').fold())`, and `has('price', P.eq(__.constant(10.00m)))`.
    Pre-existing.
- **Cheap and concrete:**
  - `insertSet`'s `derive` hook (`src/setwrite.ts`) passes `cellOf(name)`, and `storedForm` re-inlines
    that `json_extract` about 10 times per row. Project the cells once, then derive in an outer
    project, as `mapEntryProperties` does.
  - `guardMergeInterleaving` (`src/compiler/rel/write.ts`, about l.3515) still emits `1 = 1 AND`. Use
    one `conjoin([...].filter(x => x !== always))` there.
  - `test/plan-stability.test.ts`: add a parameter-bound `V($ids).has(k, range)` gate. The literal
    `V(50, 51)` gate does not exercise the `json_each` or the id-or-uid branch of `pinnedBy`.
  - The storage-class edge conjunct of `storedRange` (`+value < ''`) is needed only where the range is
    a seek. In a correlated check the `vtype` residual already excludes those rows. Add the edge only
    where `indexable` makes the range a seek.
  - The doc comment on `ordered` (`src/compiler/rel/predicate.ts`) says a numeric value may be stored
    as decimal TEXT. `storedRange` now relies on the opposite: `value` is always the comparable
    INTEGER/REAL (`src/storage.ts`). Fix the comment.
  - `pinnedBy` and `reached` in `elementFacts` (`src/rel/passes/semijoin.ts`) extract the member twice.
    Make one extractor that returns `(member, bounded?)`.
  - The `allNullGuard` JSDoc (`src/compiler/rel/transform.ts`) sits between the `VALUE_TX` JSDoc and
    `VALUE_TX`. Move `allNullGuard` above that block.
  - `rereadsSubquery` (`src/rel/emit.ts`) has a second, column-spelling fence exemption. State the
    rule once: a fence costs the predicate its index when the predicate seeks the block's own columns.
- **Accepted, no action:** item 3 adds `COALESCE(exact, value)` to every property read that passes a
  value on. sql-hygiene moved in 89 families. Measured runtime cost is noise, except `elementMap()`
  +10% at 8k. Some per-row term is inherent to a two-column design.

## Next round (round 4)

Order: wrong answers, then super-linear and the 2× regression, then the parked item, then cheap fixes,
then byte-stable reuse.

1. **Order a stored property by its stored `value`** (reuse proposal, and a wrong answer). After item 3
   a stored row's `value` is already comparable, so `storedCompareOn` (`src/compiler/rel/predicate.ts`)
   is an identity there, except one case: `CAST(REAL AS INT)` clamps a long/bigint past int64 to
   9223372036854775807. Witness on trunk: store `n` = 3e20, 1e20, 2e20 as bigint (`k` = c, a, b).
   `g.V().hasLabel('x').order().by('n').values('k')` gives `[c,a,b]`; `.order().by('n', desc)` gives the
   same; `properties('n').order().by(value).value()` gives insertion order. All should be sorted. Sites:
   `src/compiler/rel/source.ts` (ordering read, about l.723), `src/compiler/rel/property.ts`
   `propertyOrderTerms` (about l.234), `src/compiler/rel/modulator.ts` (about l.330, `T.value` over a
   property). Keep `storedCompareOn` only for carriers that are not stored rows (list members, `{t,v}`
   nodes, reducer `vt`). Check first that datetime and duration are stored as INTEGER. Delete
   `storedCompare` (dead export, 0 references).
   ✅ **Landed 2026-11-26 (`8211161e`).** `wholeNumber` (`src/compiler/rel/build.ts`) is the one
   whole-number primitive, `CAST(x AS NUMERIC)`: INTEGER inside int64, REAL past it, never clamped. A
   stored row sorts by its own `value` through `storedOrderKey`. `storedCompare` is deleted. Remains: nothing.
2. **Infix connective inside `local()`** (follow-up above).
   ✅ **Landed 2026-11-26 (`7474be16`).** `spliceIdentityHosts` folds the body's top-level connectives
   with `canonicalizeConnectivesLevel` before the splice (`src/compiler/ir/strategies.ts`). Remains: nothing.
3. **Comparability guard for a nested-operand ordering** (follow-up above).
   ✅ **Landed 2026-11-26 (`e35f833a`, with item 4).** `sameBucket` (`src/compiler/rel/predicate.ts`) is a
   separate conjunct beside the compare, so the owner seek stays. Remains: a nested EQUALITY is still
   unguarded (`nested-eq-type-guard`) and a STREAM subject's ordering is still direct
   (`nested-stream-ordering-guard`), both in `docs/outstanding-work.md`.
4. **Value-join regression and one comparable authority** (the two MAJOR item-3 follow-ups above, one
   item).
   ✅ **Landed 2026-11-26 (`e35f833a`).** A stored operand reads its row's own `value`
   (`TypedOperand.comparable`, `source.ts` `storedFirstValue`). A stream operand converts by tag through
   `comparableOf`, bound once in a VALUES row. `comparableNumber` is deleted. Remains: the age join is
   1.3x of the pre-item-3 timing, not 1.2x; the rest is the cost of the bind-once subquery that converts
   a label operand. Two stored durations still compare their nanos TEXT (`duration-stored-comparable`).
5. **Quadratic matching `mergeE`** (follow-up above).
   ✅ **Landed 2026-11-26 (`1d7beeaf`).** The match joins the criteria read's own edge row, not
   `edges.id IN (label population)` (`src/compiler/rel/write.ts`, `src/compiler/rel/source.ts`). Scaling
   1k/8k: 10.5 / 74 ms (7.1×), was 65×. Remains: nothing.
6. ~~Land round-3 item 5~~ — landed as `1c5020d9`. Its two review follow-ups (test timeout, trade comment) join item 7.
7. **The cheap and concrete round-3 follow-ups** above.
   ✅ **Landed 2026-11-26 (`325506c2`).** All eight cheap items and the two item-5 follow-ups. A derived
   `insertSet` column reads its cells off one `MATERIALIZED` CTE (`src/setwrite.ts`). The storage-class edge
   is added only by the seek (`StorageSlice`, `src/rel/passes/semijoin.ts` `indexable`). One `membership`
   extractor serves `pinnedBy` and `reached`. No answer changes, no baseline moved. Remains: nothing.

### Reuse sweep (byte-stable unless said)

8. **One AND/OR authority.** Delete `and`/`or`/`eq` in `src/compiler/rel/build.ts` (about l.399–415;
   `and`/`or` accept `undefined`; 138 + 19 refs, `eq` 247 refs). Use `conjoin`/`disjoin` and the
   `src/rel/expr.ts` constructors. That also removes the bare `Error('… a conjunction of nothing')`.
   Loop folds that the `test/rel-expr-folds.test.ts` scan cannot see: `lower/filter.ts:113`
   `fuseSourceFilters` and `:245`, `lower/reduction.ts:1955`, `lower/branch.ts:1204`, `match.ts:608`
   `connectiveExpr`, `lower/exists.ts:206-208`. Hand-written `x ? and(x, y) : y`: `map.ts:620`,
   `modulator.ts:1066`, `lower.ts:6442/6475/6535`, `rel/decorrelate.ts:710`. About 20 literal
   `{kind:'binary', op:'and'|'or'}`: `build.ts:306/310`, `child.ts:289`, `path.ts:534`,
   `write.ts:746/1489`, `lower.ts:1338`, `decorrelate.ts:575`. Then let the scan also forbid object-literal
   `op:'and'|'or'` outside `expr.ts`. SQL unchanged.
9. **Name the contradiction once.** Export `never` (`1 = 0`) beside `always`, and a text in-list
   constructor that returns `never` for an empty set (SQLite rejects `IN ()`). Spellings:
   `predicate.ts:50` `CONSTANT.false` (42 uses), `build.ts:305` `storedForm` `tagged`, `build.ts:584`
   `keyMembership`, `write.ts:4236` `fromOnCreate`, `record.ts:555`, `services/catalog/search.ts:94`.
   Private `inList` in `receiver.ts:79` and `build.ts:745`, plus about 40 inline in-list literals. SQL
   the same or smaller.
10. **`isNull`/`isNotNull`/`binary` in `src/rel/expr.ts`.** Delete the 7 private `bin`/`binary`
    (`sack.ts:245`, `tag.ts:38`, `operator.ts:119`, `transform.ts:95`, `reducer.ts:388`,
    `lower/reduction.ts:1402`, `predicate.ts:40`) and the 8 private null tests (`operator.ts:120`,
    `sack.ts:246`, `receiver.ts:78`, `predicate.ts:818`, `lower/filter.ts:444`, `modulator.ts:378`,
    `child.ts:291`, `write.ts:1905-1906`). About 41 inline `op:'is'|'is not'` literals get shorter.
11. **Move `setMembers` into `list.ts`.** `lower/reduction.ts:513` `setMembers` builds its own
    `json_each` explode and calls `payloadOf`/`ownTagOf`, which `list.ts` exported only for it. Add
    `listMemberSet(list, of, fresh, typed)` beside `correlatedListMembers` on `membersOf`,
    `memberPayload` and `memberOwnTag`, and make the two exports private again. This also removes the
    `isTypedList` alias of `hasTypedMembers`. SQL changes only in column aliases (`sm`/`smt` →
    `mv`/`mt`); check the sql-plan and sql-hygiene baselines.
12. **The census/L5 nondeterminism test asks `dynamicLiteral`.** `test/support/graph.ts:110`
    `NONDETERMINISTIC` copies `src/gremlin/frontend.ts:129` `dynamicLiteral` as a regex. Use the
    predicate for dynamic literals; keep the regex only for `sample`/`coin`/`shuffle`. No answer changes.

Items 8–12 were not started in round 4. They move to round 5 unchanged (round-5 items 9–13).

## Parked in round 4

None. Items 1–5 and 7 landed. Item 6 had landed before the round. No round-4 branch is a resume point.

## Follow-ups from review (round 4)

Major first. Minor items are kept only when they are cheap and concrete.

- **MAJOR — a label-operand ORDERING builds the label's history document 4 times per row**
  (`e35f833a`, `src/compiler/rel/predicate.ts`). The `+value OP operand` VALUES and the `sameBucket`
  guard VALUES each inline the whole `jsonb_array(jsonb_object('k',2,'v',…,'t',rp.vtype))` document.
  The semijoin and its residual EXISTS each hold both copies (before: 2 copies). The tag is only
  `rp.vtype`. Measured old / new, ms at 1k / 8k vertices:
  - `g.V().has('age',3).values('age').as('e').V().has('age', gt(select('e'))).count()`:
    11.9 / 78.7 → 20.6 / 125.3. SQL 2969 → 6386 bytes.
  - The same with `.has('s', lt(select('e')))` added: 18.6 / 133 → 24.8 / 173. SQL 5299 → 9278.
  - `g.V().values('age').as('e').V().has('age', gt(select('e'))).limit(1)`: 4.0 / 3.7 → 7.0 / 14.8.

  Growth is linear and the slowdown (about 1.6×) is under the 2× bar. But the SQL doubles, and an
  expression used N times must be computed once. The same commit adds `sharedNode`, a peephole that
  finds the label's `.v`/`.t` pair again by string suffix and `JSON.stringify` equality. That is a second
  recognizer of the label's history read. ✅ Fixed by round-5 item 2 (`2479f03e`): both recognizers
  are deleted, and `aliasEntryAt` (`src/compiler/rel/alias.ts`) is the one reader of the entry.
- **MAJOR — two copies of the comparability bucket table** (`src/compiler/rel/predicate.ts`).
  `sameBucket` lists `TEXT_VTYPES` and `OWN_BUCKET_VTYPES` by hand. `comparableTheta` (about l.717)
  spells the same partition as a 7-arm CASE, which mirrors `kindOf` in `orderability.ts`. The two copies
  already differ on duration: `comparableTheta` keys it through `wholeNumber`, the nested guard compares
  the stored TEXT. That wrong answer is recorded as `duration-stored-comparable`, so it is not new. Fix:
  one exported bucket table, read by both (see round-5 item 3).
- **Pre-existing wrong answer — `P.not` around an ordering keeps incomparable rows**
  (`src/compiler/rel/predicate.ts` `negated()`). Store `s` in {`'10'`, `10`, `10.00m`, `'x'`, `3`, `true`,
  `1`}. `g.V().has('k','e').as('x').V().has('s', P.not(P.gt(select('x').values('s')))).values('k')`
  returns `[a,d,e,f,h]`; the reference is `[e,h]`. The literal form `has('s', P.not(P.gt(3)))` is wrong
  in the same way. SQL `NOT(cmp AND guard)` lets a cross-bucket row pass. The reference negates the
  BiPredicate: `P.not` → `predicate.negate()`
  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/P.java`),
  and `Compare.lte` is false on an incomparable pair (`…/process/traversal/Compare.java`). Fix: push the
  negation into the operator (`gt` → `lte`) before the guard is added, for literal and nested operands.
- **To `docs/outstanding-work.md`** (not recorded there yet):
  - A meta-property long past 2^53 loses its tag when it is written. The meta JSON holds it as a bare
    string. `g.V().properties('n').values('j')` after `property('n', 1L, 'j', 9007199254740993L)` returns
    a String, not a Long (wrong number class). `order().by('m')` on such values sorts as text, and
    `has('m', gt(150000000000000000000N))` finds nothing. The root cause is the meta write, not the
    compare key (`src/compiler/rel/modulator.ts` reads it).
  - `g.V().fold().local(unfold().order().by(K).values('k')).limit(1)` is quadratic for every key: 18.5 /
    605 ms at 1k / 8k (32.7×), on trunk before and after round 4. `g.V().local(unfold().order().by('n'))
    .count()` stays linear. It is probably the `fold-label-history-copy` family; check before a new row.
  - `mergeE` depth gaps (clean declines, unchanged from before round 4): an endpoint from
    `option(Merge.outV, __.identity())`, one endpoint per traverser
    (`g.V().hasLabel('person').mergeE([(T.label):'knows',(Direction.from):Merge.outV]).option(Merge.outV,__.identity())`),
    a search map with endpoints but no `T.label` (`g.mergeE([(Direction.from):1,(Direction.to):2])`), and
    a list-valued property criterion.
  - An injected exact-tail number stream declines at the source:
    `g.inject(300000000000000000000N, 100000000000000000000N, 5L).order()`, `.max()`, `.dedup()`, and
    `g.inject(1.5d, 9007199254740993L, 2L).order()`. The same values answer from stored properties.
- **Cheap and concrete:**
  - Stale comments after `8211161e`: the `storedValue` doc in `src/compiler/rel/build.ts` (about l.702)
    names the deleted `storedCompare`; `src/compiler/rel/decorate.ts:100` names "`storedCompareOn`'s CAST".
  - Rename `CAST_TO_INT` (`src/compiler/rel/predicate.ts:141`) to a name such as `WHOLE_NUMBER_TAGS`.
    Those tags key through `wholeNumber` (CAST AS NUMERIC), not CAST AS INTEGER.
  - The `edgeCriteria` doc (`src/compiler/rel/write.ts`) says the plan is "an `e_pair` seek per pair".
    The measured plan seeks `e_in (tgt=? AND label=? AND src=?)`. Say "an endpoint-index seek".
  - `insertSet` (`src/setwrite.ts`) projects a derived column's placeholder (`exact`) into the
    `cells` MATERIALIZED CTE, and nothing reads it. Leave a derived column out of `cells` unless another
    derive reads it. One `json_extract` per loaded property row; measured cost is noise.
- **No action:** `Where.feature:268`'s body wrapped in `local()` declines cleanly. The same traversal
  without `local()` also declines.

## Next round (round 5)

Order: wrong answer, then the SQL doubling, then cheap fixes, then byte-stable reuse.

1. ✅ **LANDED (`f6715991`, round-5 item 1). The premise was wrong; the fix went the other way.** The
   reference `P.not` is `NotP`, whose test is `!original.test`
   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/NotP.java:108`).
   So an incomparable pair is KEPT by `P.not(gt)`. The `has()` witness answers `[a,d,e,f,h]`, which is
   correct. The wrong answer was in `where()`: it pushed the negation into the operator. Mechanism:
   `aliasPred` (`src/compiler/rel/lower.ts`) folds each leaf as `{ cmp, guard }`, conjoins the guards
   outside, and negates a two-valued compare. `NEGATED_CMP` is deleted. Witnesses are in
   `test/L4-addendum/nested-operand-comparability.feature`. Remains: nothing.
2. ✅ **LANDED (`2479f03e`, round-5 item 2), except the SQL size target.** The label's history entry is
   read in one place, `aliasEntryAt` (`src/compiler/rel/alias.ts`). The producers that know the column
   hand it on: `aliasOperandAt` puts it on `TypedOperand.node`, and a bare `select(label)` yields it as
   `ChildValue.labelEntry`. `overOperand` binds the node once. `sharedNode` and the `aliasEntryNode`
   path match are deleted. The same commit fixes a wrong answer: an untagged label value (an untyped
   literal injected beside a typed one) made the guard read a NULL tag and drop every row. The operand
   now infers the tag, as `aliasOperandAt` does. Witnesses: `test/compiler/label-operand-entry.exec.test.ts`
   and one scenario in `test/L4-addendum/nested-operand-comparability.feature`. Remains:
   - The inferred tag makes the guard SQL about 330 B larger per per-row label site (6386 → 7050 B).
     Item 3 can win it back: a bucket lookup that reads the tag once drops the inferred-tag arm.
   - The SQL is not back to about 3 KB. That needs the label history document to stop being inlined in
     both the semijoin and the residual EXISTS. This is outside the item. The emit spike was not tried.
   - `local(V().has(gt(select(…))).limit(1))` is cubic, also on the base. Recorded as
     `reresource-label-operand-limit`.
3. **One bucket table for ordering comparability.** Extract `bucketGuard(typeA, typeB)` from `sameBucket`.
   Then `comparableTheta` = `bucketGuard(typeA, typeB)` AND `op(storedCompareOn(typeA)(valA),
   storedCompareOn(typeB)(valB))`. `storedCompareOn` already keys datetime and duration through
   `wholeNumber`, every Number tag by its class, and passes the other tags raw, so each arm computes what
   it does today. A cross-bucket pair is false in both forms; a NULL stays NULL. About 12 fewer lines, and
   `where('a', gt('b'))` emits one compare, not seven. Do it after item 2 (same file).
4. ✅ **LANDED (`d9befdba`, round-5 item 4), except the rename.** The two stale comments and the
   `edgeCriteria` doc are fixed. `insertSet`'s `cells` CTE holds only the cells a column or a derivation
   reads (`src/setwrite.ts`). Remains: the `CAST_TO_INT` rename (`src/compiler/rel/predicate.ts:140`).
5. **`storedCompareOnce` is `overOperand` specialised — delete it.** `storedCompareOnce`
   (`src/compiler/rel/predicate.ts` about l.688, one caller `modulator.ts:284`) binds `(subject, vtype)`
   once in a VALUES row. `overOperand` (about l.883) does the same. Call `overOperand` directly. About 9
   lines. Do it with item 2, because item 2 changes `overOperand`.
6. **`storedForm.value` is `comparableOf`.** In `src/compiler/rel/build.ts`, `storedForm` builds `value`
   with a `typeof(payload)='text'` guard; `comparableOf` builds the same CASE without it. The guard is
   redundant: `CAST(x AS REAL)` of a REAL and `CAST(x AS NUMERIC)` of an INTEGER or REAL are no-ops
   (measured on bun:sqlite 3.51: `CAST(3.0 AS NUMERIC)` and `CAST(9.3e18 AS NUMERIC)` stay REAL). Use
   `value: comparableOf(payload, vtype)`; `exact` keeps its own arms. Removes one per-row `typeof` read
   from every stored-value write. sql-hygiene only shrinks.
7. **mergeV map-entry signature keys a Number by `typedValueKey`.** `searchKeying.entries`
   (`src/compiler/rel/write.ts` about l.3716) uses half of `typedValueKey` and spells a third
   `CAST(value AS REAL)` under its own numeric in-list. Use `typedValueKey` for both halves. The exact
   key only admits fewer false candidates (two distinct longs past 2^53 no longer meet); `couldMatch`
   stays the residual.
8. **Elide `always` once, at the algebra boundary.** Make `conjoin` (`src/rel/expr.ts`) skip
   `=== always`. Make the emitter (`src/rel/emit.ts`, `filter` and join `ON`) treat an `always`
   predicate as absent. Then delete the hand filter at `write.ts:3522`. Sites that still emit a
   tautology: `write.ts:3912`, `4041`/`4044` (the mergeV `CROSS JOIN … ON (1 = 1)`), `4196`, `4215`, the
   NOT-EXISTS filters at `5037`/`5241`/`5570`/`5954`, and `src/rel/decorrelate.ts:112`/`145`. Optionally
   retire `CONSTANT.true` (`predicate.ts:49`) for `always`. Answers do not change; sql-hygiene only falls.
   Do it with item 10.

### Reuse sweep (byte-stable unless said)

9. **One AND/OR authority** (round-4 item 8, unchanged).
10. **Name the contradiction once** (round-4 item 9, unchanged). Do it with item 8.
11. **`isNull`/`isNotNull`/`binary` in `src/rel/expr.ts`** (round-4 item 10, unchanged).
12. **Move `setMembers` into `list.ts`** (round-4 item 11, unchanged).
13. **The census/L5 nondeterminism test asks `dynamicLiteral`** (round-4 item 12, unchanged).
14. **One `tagIn(expr, names)` constructor.** `{ kind: 'in-list', expr: X, values: NAMES.map(compilerText) }`
    is spelled 26 times, as local helpers named `inList`/`among`/`tagIn`/`numeric`/`bothIn` (predicate.ts,
    build.ts, write.ts, reducer.ts, operator.ts, list.ts, boundgraph.ts). Export one `tagIn` beside
    `eq`/`isNot`/`conjoin`. Identical Expr trees. Do it with item 10 (its text in-list constructor).
15. **Fold `scanColumnOf` into the column-lineage authority** (`src/rel/lineage.ts`).
    `scanColumnOf`/`ownScan` (`src/compiler/rel/source.ts`, new in `1d7beeaf`) and `edgeRowOf`
    (`src/compiler/rel/write.ts`) repeat `columnPath`/`definingPath`/`rowidScan`/`columnAt`. First add
    the one missing case to `definingPath`: a `window`'s pass-through columns (semijoin and leading gain
    it too). Lineage picks a join side by position and refuses a LEFT join's null-padded side, so it is
    the stricter rule. About 35 lines and one concept removed. Only the plan can change: keep the
    sql-plan gate and the merge-scale `e_in`/no-`rowid=?` assertions green.

## Needs a human

No new questions in round 4. No new questions in round 3.

**Answered by the owner review (2026-11-25):** take items 1–3 and 5–11, 13 and 14 in round 3, in the
order above. Item 4, item 12 and the correlated form are cut. Items 8 and 9 land together, because a
random `UUID()` literal must never be served from the plan cache.

Round-2 questions, verbatim (now answered):

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
