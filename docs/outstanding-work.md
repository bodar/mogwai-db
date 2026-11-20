# Outstanding work

This file lists the work that is left to do. It is a reference: every item has the same shape, so
you can scan it and pick work.

- For what works today, see [feature-support-matrix.md](feature-support-matrix.md).
- For what we will not do, see [limitations.md](limitations.md) and [Won't do](#wont-do) below.
- Finished work is in git history and `docs/archive/`. When an item lands, delete it from this file.

## How to read an item

Each item has a title and a stable id in parentheses. `git log -S<id>` finds its history.

| Field | Meaning |
|---|---|
| **Area** | The part of the system or of Gremlin that the item touches. |
| **Reach** | How often a user meets the problem: `common`, `plausible` or `rare`. |
| **Problem** | What is wrong or missing, often with an example query. |
| **Fix** | The direction we intend to take. |
| **Depends on** | Items to do first. |
| **Where** | Files and functions to start from. |

An item marked "verify" may have landed already. Check it against the code before you start.

## Rules

- Fix a decline in the shared lowering, not for one query shape. Rank open families with
  `mise run rel-blockers`, and probe one step with `bun scripts/rel-blockers.ts --step <step>`.
- Never answer a size limit with a decline. A set whose size depends on data crosses to SQL as one
  JSON value, split at 2 MB.
- A user-facing limit on a small query has so far always been statement text (100 KB on Cloudflare)
  or statement shape (64 tables in a join). It has not been the 100-bind cap. Check text and shape
  first.
- A high compile cost is a reason to make the compiler faster, never a reason to raise a limit.
  Each compile-cost fix lands with a test that stops the cost from coming back. The compile budget is
  the same on every runtime and is deterministic. The compiler imports no platform constant.
- Cite function names, not line numbers. Line numbers drift.
- The `defect` entries in `test/L3-conformance/expected-outcomes.ts` cite ids in parentheses, and
  `test/L3-conformance/l3-state.test.ts` checks that each id occurs in §1. Keep the `(id)` text when
  you edit an item.

## Measurement tools

| Tool | What it tells you |
|---|---|
| `test/L3-conformance/l3-state.json` | The L3 pass floor. Deferral buckets are in `l3-telemetry.summary.json`. |
| `test/L3-conformance/expected-outcomes.ts` | The kind and reason of every in-scope L3 failure. A fix deletes its names there. |
| `mise run rel-blockers` | Declines ranked by family. |
| `test/L7-census/deferrals.tsv` | Must hold no `crashed` rows. |
| `test/rel-spine.test.ts` `DECLINED`, `test/L4-addendum` `@Unsupported`, L5 `LAW UNEVALUABLE` | Worklists that fail when a shape lands, so you know to remove the marker. |
| `.logs/compile-cost-report.md` (local) | Per-query compile cost, CPU profiles and hot spots. |

## Contents

1. [Wrong answers](#1-wrong-answers) — 33 items
2. [Performance](#2-performance) — 57 items
3. [Queries we decline](#3-queries-we-decline) — 89 items
4. [Shared substrate](#4-shared-substrate) — 17 items
5. [Product capabilities](#5-product-capabilities) — 7 items
6. [Internal debt](#6-internal-debt) — 91 items
7. [Needs an owner decision](#7-needs-an-owner-decision) — 8 items
8. [Low priority](#8-low-priority) — 13 items
9. [Won't do](#wont-do)

## 1. Wrong answers

Queries that run and return a wrong result today. Fix these first.

### Wrong answers: writes

#### Merge writes refuse on traverser count (`o-seqguard`)
- **Area:** writes
- **Reach:** plausible
- **Problem:** `sequentialGuard` raises at run time when `count(*) > 1`. This is a data-size refusal. `g.V().mergeV([name:'zz']).option(Merge.onMatch,[age:1])` raises over 6 traversers and answers over 1. A label-only multi-driver `mergeV` with different labels declines (r7-fu11).
- **Fix:** Answer from a snapshot of the input. This retires `sequentialGuard`, `guardMergeInterleaving` and `mergeObservesOtherWrites`.
- **Where:** `src/compiler/rel/write.ts` (`sequentialGuard`)

#### Write-path id lookups skip the uid check (`rf3-reuse1`)
- **Area:** writes
- **Reach:** rare
- **Problem:** `endpointRowid`, `endpointRowid.byColumn` (mergeE) and `withPreChecks` match `id = v`. After `addV('a').property(T.id,'x')` at rowid 1, `g.mergeE([(T.label):'k',(OUT):1,(IN):2])` writes an edge from `'x'`. The reference raises "Vertex does not exist".
- **Fix:** Export `externalIdIs(idCol, uidCol, v)` from `rowidOnly` and use it at these sites. Do not change `elementIdGuard`.
- **Where:** `src/compiler/rel/write.ts`

#### A driver map that holds a null merges with its duplicate (`nr-fu-null-dup-create`)
- **Area:** writes
- **Reach:** rare
- **Problem:** `g.inject([name:'a',age:null],[name:'a',age:null]).mergeV().id()` gives `[7,7]`. The reference creates two vertices, because a null is never stored (`ElementHelper.java:348-352`).
- **Fix:** In `createKey` and `mapCouldMatch`, a map that holds a null entry never collapses.
- **Where:** `src/compiler/rel/write.ts` (`createKey`, `mapCouldMatch`)

#### onMatch arms resolve against the Map, not the matched element (`nr-fu-onmatch-scope`)
- **Area:** writes
- **Reach:** rare
- **Problem:** The bug is latent. A decline with an incorrect reason hides it (`MergeVertexStep.java:100`).
- **Fix:** Pass `'notMap'` for onMatch arms. Build this before R8-res (§4).
- **Where:** `src/compiler/ir/write-args.ts` (`mergeMaps`)

#### `property(k, <traversal>)` writes are unsafe (`o-prop-trav`)
- **Area:** writes
- **Reach:** plausible
- **Problem:** The guard can fire after an earlier write. `mergeArmValueWrite` takes `limit 1` in scan order and stores null.
- **Fix:** Check the guard before any write. Take the value from the traversal's first result in a defined order, and do not store null.
- **Where:** `src/compiler/rel/write.ts` (`mergeArmValueWrite`)

#### A meta-property under undeclared cardinality patches instead of inserting (`o-meta-undeclared`)
- **Area:** writes
- **Reach:** rare
- **Problem:** A meta-property write on a property with undeclared cardinality updates an existing row. It must insert a new row.
- **Fix:** Insert a new meta-property row under undeclared cardinality.

#### `loadBulk` remap with replace ignores the id policy (`rf3-bulk-remap-replace`)
- **Area:** bulk-load
- **Reach:** rare
- **Problem:** With `{idPolicy:'remap', onCollision:'replace'}`, `resolveReplace` ignores `idPolicy`. `V(1)` lands as rowid 1 with uid NULL.
- **Fix:** Make `resolveReplace` apply the remap id policy.
- **Where:** `src/bulk.ts` (`resolveReplace`)

#### `loadBulk` append with one uid twice in a batch shows a raw SQLite error (`rf3-bulk-dup-uid`)
- **Area:** bulk-load
- **Reach:** rare
- **Problem:** The user sees SQLite's raw "UNIQUE constraint failed".
- **Fix:** Add an in-batch check keyed like `dedupeByKey`. Raise the named-remedy error.
- **Where:** `src/bulk.ts`

### Wrong answers: paths, labels, side effects and match

#### `barrier(Barrier.normSack)` does not normalize sacks (`normsack-ignored`)
- **Area:** sack
- **Reach:** rare
- **Problem:** The step acts as a plain `barrier()`. `g.withSack(1.0d).V(1).out().barrier(Barrier.normSack).sack()` gives `[1,1,1]`. The reference gives 1/3 each (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/SackFunctions.java:40`). The `sack.ts` header says the form declines, but it does not.
- **Fix:** Divide each sack by the total of all sacks at the barrier. Until then, decline the one-argument form when the argument is `normSack`.
- **Where:** `src/compiler/rel/lower/slice.ts:368` (`barrier` with ≤1 argument returns its input, so the argument is dropped); `src/compiler/rel/sack.ts` header

#### A label bound before a local `order()` is lost (`order-local-alias-drop`)
- **Area:** labels
- **Reach:** plausible
- **Problem:** `g.V(1).as('a').values('name').fold().order(Scope.local).select('a')` gives `[]`. The reference gives `[v[1]]`. `elementMap().order(Scope.local).by(Column.keys).select('a')` and the `valueMap()` form fail the same way.
- **Fix:** Carry the alias channel through the value-transform barrier. This is the same root as §3 "Value barriers carry the traverser's channels". Until then, a clear decline is better than the lost row.
- **Where:** `src/compiler/rel/order-dedup-local.ts`

#### A `match` pattern that ends in a non-seeded reducer binds NULL (`match-null-reducer-end`)
- **Area:** match
- **Reach:** plausible
- **Problem:** `g.V().match(__.as('a').values('age').sum().as('b')).select('b')` gives `[29,27,null,32,null,35,null]`. The reference gives `[29,27,32,35]`. `SumGlobalStep` emits nothing over zero starts, so the pattern does not match that `a`.
- **Fix:** Filter the binding table on the reducer's `present` signal (`value-nullness`) before binding. `count()` needs no filter.
- **Where:** `src/compiler/rel/match.ts` (the `reducingEnd` route)

### Wrong answers: values, lists and maps

#### A Map-valued property under `project()` (`cr-fu14`) (verify: may have landed)
- **Area:** framing
- **Reach:** rare
- **Problem:** `g.V().project('n','m').by('name').by(values('m')).select('m')` leaked `TypeError: pairs.flatMap is not a function`. A reviewer reports that the project form now answers. A `group()` nested in `local()` is not reached by ProductiveByStrategy.
- **Fix:** Confirm the project form with a framed run over a graph with a map property. Drop that half if it answers. Make ProductiveByStrategy reach a `group()` in `local()`.
- **Where:** `src/execute.ts`

#### `dedup()` treats maps with the same entries in a different order as different (`dedup-map-order`)
- **Area:** values
- **Reach:** plausible
- **Problem:** `g.inject([x:1,y:2],[y:2,x:1]).dedup().count()` gives 2. The reference gives 1.
- **Fix:** Define a map's identity as its entries in any order. Use this identity at every dedup, group and set-operation site.

#### Number-class losses (`number-class-residue`)
- **Area:** numbers
- **Reach:** rare
- **Problem:** Several paths lose the number class:
  - An untagged whole REAL that a value barrier re-injects frames as an Int (`lowerValueResume`).
  - A set-operation literal operand loses its member class. `g.inject([1.0d]).combine([1.0d])` reads a whole Double back as an Int.
  - An intermediate `sum` that leaves the Long range and returns is not widened.
  - `mean()` of a BigInteger must answer a BigDecimal. Today it raises "BigDecimal scale arithmetic is not supported".
- **Fix:** Carry the type tag through each of these paths.

#### `reverse()` over a list-valued property does not reverse it (`reverse-list-value`)
- **Area:** values
- **Reach:** plausible
- **Problem:** `g.V().values('lst').reverse()` with `[1,2,3]` gives `[1,2,3]`. The reference gives `[3,2,1]` (`ReverseStep.java:55-57`). The same occurs via `properties().value()`, `as()/select()`, `coalesce` and `local`. `select('a').reverse()` over `project().by('lst')` leaks `TypeError node.v.map is not a function`.
- **Fix:** Make `reverseValue` reverse a list for every non-String type that is an Iterable.
- **Where:** `src/compiler/rel/reverse.ts` (`reverseValue`)

#### A Set frames as a List in a `select()` record and a `group()` value (`set-framing-nested`)
- **Area:** framing
- **Reach:** rare
- **Problem:** Over a set-valued `m`, `g.V().as('v').values('m').is(typeOf(GType.SET)).as('a').select('v','a')` gives `a` as a List. `group().by('name').by(values('m').is(typeOf(SET)).fold())` gives a List of a List.
- **Fix:** Make the record-field and group-value framers read `ListOf.set`. Extend `typeof-framing.exec.test.ts` beyond the single-key select.

#### `project().by(out().count().fold())` frames the count as Int (`project-count-fold-class`)
- **Area:** numbers
- **Reach:** plausible
- **Problem:** The report is `[3i]`; the reference is `[3L]` (`CountGlobalStep` yields a Long). The top-level `g.V().out().count().fold()` is correct.
- **Fix:** Confirm with a framed run, then frame the folded count as a Long.

#### `group().by(length())` key wire type (`group-length-key-tag`)
- **Area:** framing
- **Reach:** rare
- **Problem:** `g.V().values('name').group().by(length())` emits keys tagged `{t:null,v:3}`. The wire type may be wrong.
- **Fix:** Check the wire type of the key. Fix the tag if it is wrong; drop the item if it is not.

#### Meta values stored untyped (`o-meta-typed`)
- **Area:** properties
- **Reach:** rare
- **Problem:** The `meta` bag is `json_object` over raw values. A Boolean lands as `1`, and a set or map reads back as a list. Reads frame by JSON class (`metaTagOf`), so they are as faithful as the store.
- **Fix:** Write a typed `{t,v}` meta node. Read it in `execute.ts` `vertexPropertyBuffer`.
- **Depends on:** typed-value-carrier
- **Where:** `src/compiler/rel/write.ts` (`metaExpr`); `src/bulk.ts`; `src/compiler/rel/property.ts` (`metaTagOf`); `src/execute.ts` (`vertexPropertyBuffer`)

### Wrong answers: filters and predicates

#### Within/without over a list parameter over-matches (`string-set-param-guard`)
- **Area:** predicates
- **Reach:** rare
- **Problem:** `has('k', within(xs))` with `xs=['9007199254740993']` also matches a BigInteger stored as decimal text. With `xs=['1']` it also matches a Char `'1'`. The inline literal set is correct.
- **Fix:** Re-land branch `wf/tag-excludes-guard-3-0` (a448915b). There, `textSpacedSet` takes the composed guard.
- **Depends on:** tag-excludes-guard
- **Where:** `src/compiler/rel/predicate.ts`

### Wrong answers: federation, services and io

#### Federate global barriers count the wrong rows (`rf3-fed-barrier`)
- **Area:** federate
- **Reach:** plausible
- **Problem:** `noParents()` takes the zero-parent answer from the last pushed step. With parents, a pushed global barrier runs the sibling once. `h.V().count()` gives `[]` (reference `[0]`); with parents it gives `[6]` (reference `[12]`). Also tracked as r7-fu7.
- **Fix:** Stop `pushableTailPrefix` at the first global barrier in mid form. Or lower the pushed prefix over an empty relation for the seed (`ReducingBarrierStep.java:143-148`).
- **Where:** federate lowering (`noParents`, `pushableTailPrefix`)

#### Federate subgraph `V(2,[3,4])` returns extra vertices (`rf3-reuse3`)
- **Area:** federate
- **Reach:** rare
- **Problem:** In a federate subgraph, `V(2,[3,4])` gives `[josh,lop,vadas]`. The reference gives `[vadas]`. On the local graph the query is correct.
- **Fix:** Extract `idArgMembers(args)` from `idMembership`. Use it in `BoundGraph.elementScan` and `inlineNames`. This also deletes the second copy of the null-member rule in `elementScan` (`nonEmpty`, `CONSTANT.false`).
- **Where:** `src/compiler/rel/boundgraph.ts`

#### A malformed `g:Binary` in a GraphSON load throws a bare `Error` (`graphson-binary-bare-error`)
- **Area:** io
- **Reach:** rare
- **Problem:** The bare `Error` reaches the user through `io().read()`. `g:Duration` has the same pattern.
- **Fix:** Raise the named load error.
- **Where:** `src/formats/graphson.ts`

#### `tinker.search` with `type: 'VertexProperty'` always returns nothing (`search-vertexproperty-empty`)
- **Area:** services
- **Reach:** rare
- **Problem:** A VertexProperty search returns empty even when a meta-property matches. The code comments call this a "documented gap".
- **Fix:** Search meta-property values and return the matching vertex properties.
- **Where:** `src/services/catalog/search.ts`

#### Hand-rolled `json_each` membership subqueries (`rf3-reuse2`)
- **Area:** services
- **Reach:** rare
- **Problem:** About 10 sites hand-roll a `json_each` membership subquery. Three use bare `JSON.stringify` on user strings, so a label with a lone surrogate matches nothing.
- **Fix:** Add one `jsonMembers(values)` and use it at every site.
- **Where:** `src/services/catalog/olap/kernel.ts`, `src/services/catalog/olap/pagerank.ts`, `src/manager.ts`

#### Scalar and combine resumes land their value through `foreignNodeStream` (`resume-node-stream`)
- **Area:** federate
- **Reach:** rare
- **Problem:** `lowerScalarResume` and `lowerReduceCombine` put `compilerText(stringifyExact(node))` into statement text, in a one-row VALUES with `Filter(CONSTANT.false)` for empty. A pushed `max()`/`min()` over a long string property may grow the statement with data. That can hit the DO 100 KB statement limit in production only. This is not verified.
- **Fix:** Verify the wall first. In both cases, use `foreignNodeStream(empty ? [] : [node], fresh)`. This deletes both `Filter(false)` workarounds. About 15 lines.
- **Where:** `src/compiler/rel/lower.ts` `lowerScalarResume`, `lowerReduceCombine`; `src/compiler/rel/foreign.ts` `foreignNodeStream`

### Wrong answers: storage and runtimes

#### Failover double write (`failover-double-write`)
- **Area:** browser
- **Reach:** plausible
- **Problem:** The L8 browser bracket's "hard-killed leader" test in `failover.test.ts` failed once on CI (count `4`, expected `3`). It passed on the next push. The likely cause is a write retried across failover and applied twice.
- **Fix:** Treat it as the exactly-once gap, not noise, until shown otherwise.
- **Depends on:** `browser-runtime`
- **Where:** `test/browser/failover.test.ts`

#### One `json_each` membership helper outside the compiler (`members-everywhere`)
- **Area:** storage / replication / bulk
- **Reach:** plausible
- **Problem:** About 25 sites hand-write `IN (SELECT value FROM json_each(?))` with a mix of `JSON.stringify` and `stringifyExact`. They do not split a set past the 2 MB DO value cap. Two sets are data-sized: `manager.ts`'s filtered `_changes` `match` set (a filter's matched vertices) and replicate's gid sets (a peer's whole changeset batch, about 60k hex gids per 2 MB). These fail only in production.
- **Fix:** Use `setwrite.ts`'s `members` (it already uses `jsonChunks`) at every site. Under 2 MB each still renders exactly `json_each(?)`. A gid caller writes `SELECT unhex(value) FROM ${members(gids)}`, so the gid index still serves. Per site: change `JSON.stringify` to `stringifyExact` (check pagerank's injected value strings). In `drain.ts` the 500-id page bounds the set, so there it only unifies the spelling. None of the sites reads `key`.
- **Where:** `src/formats/drain.ts` `rowsForOwners`; `src/bulk.ts` `BatchingLoader.existing`/`existingUid`/`wipeFts`/`assertFree`; `src/replicate.ts` `resolveGids`/`localRevs`/`resurrect`/`applyDeletes`/`liveRevs`; `src/manager.ts` `changes`/`conflictLeaves`/`revsDiff`; `src/refresh.ts` `ftsRowsForDirty`; `src/services/catalog/olap/pagerank.ts`; `src/services/catalog/olap/kernel.ts` `relaxShortestPath`

### Wrong answers: tests, tooling and docs

#### L3-ledgered wrong answers (`l3-ledger`)
- **Area:** tests
- **Reach:** rare
- **Problem:** Each entry is a `defect` in `test/L3-conformance/expected-outcomes.ts`. The fix deletes its names there.
  - `with('multilabel')` frames an edge's own label as a String (l3-multilabel-edge-label). `E().elementMap()` gives the endpoint labels as Sets but the edge's own label as a String. 1 scenario.
- **Fix:** Frame the edge's own label as a Set under `with('multilabel')`.
- **Where:** `test/L3-conformance/expected-outcomes.ts`

### Wrong answers: compiler internals

#### `g.V(1,1)` returns one traverser (`repeated-id-lost`)
- **Area:** compile
- **Reach:** rare
- **Problem:** `g.V(1,1)` gives one vertex. The reference gives two. A repeated literal id loses a row.
- **Fix:** Keep the id list as a multiset when it drives the start step.

#### Path-position `by()` dispatch built twice (`path-position-projection`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** The path-position `by()` dispatch exists twice. One copy reads a mid-path value, list or map position as a vertex.
- **Fix:** Extract `pathPositionProjection`. This also fixes the misread.
- **Where:** `src/compiler/rel/path.ts`

#### Writes drop `sack`/`path` channels (`write-input-channels`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** `writeInputChannels` keeps only `encounter` and `alias` channels. A write after a `sack` or `path` loses them.
- **Fix:** Carry `sack` and `path` through writes.
- **Where:** `src/compiler/rel/write.ts` `writeInputChannels`

### Wrong answers: other

#### `UUID()` literal returns nothing (`uuid-literal`)
- **Area:** literals
- **Reach:** plausible
- **Problem:** `g.inject(UUID())` returns `[]`, and `g.inject(UUID()).count()` returns `[0]` (measured 2026-11-20). The reference returns one random UUID. It used to decline. L3 never sees this form: `g_injectXUUIDXXX` is GLV-lossy, because gremlin.js sends a concrete `uuid.v4()`.
- **Fix:** Lower `UUID()` to a random v4 value tagged `uuid`. Read the grammar visitor in `vendor/tinkerpop/gremlin-language` to see when it is evaluated. Or decline it and add a limitations line. Never return an empty stream.

## 2. Performance

Queries that answer correctly but grow faster than linear with data or query size, or compile slowly.

### Performance: writes

#### Write half of the value join is quadratic (`write-value-join`)
- **Area:** writes
- **Reach:** common
- **Problem:** `g.V().hasLabel('order').as('o').values('code').as('c').V().hasLabel('warehouse').has('code', select('c')).addE('servedBy').from('o').count()` goes 730 ms → 42.3 s. The constant form `…has('region','r1').addE(…)` goes 688 ms → 34 s. A key-bound target (`V('w1')`) is linear. The cost is the re-source read inside the write program.
- **Fix:** Run `fuse` in the write lowering too.
- **Depends on:** rf3-fuse-write

#### `fuse` runs only in the read `lowered()` (`rf3-fuse-write`)
- **Area:** writes
- **Reach:** plausible
- **Problem:** A write fed by `order().by(…).V().has(…)`, or the label filter of a write-body `V()` re-source, renumbers holders × V first. Also tracked as r4-fu0.
- **Fix:** Run `fuse` on the write path too.

#### K-entry map driver and related shapes (`r7-fu9`)
- **Area:** writes
- **Reach:** plausible
- **Problem:**
  - `inject([k0:0,…]).mergeV()` is 55×, because `json_extract` re-reads per entry.
  - A child seek does not reach a `fold()` reducer (68×).
  - `hasLabel` after an equi-joined hop in a re-source is 16×.
- **Fix:** Explode the map once. Extend the seek to `fold()` reducers and to `hasLabel` after an equi-joined hop.

#### Literal maps spelled about 5× their text (`literal-text-amplification`)
- **Area:** writes
- **Reach:** common
- **Problem:** `g.inject(<3,000 [name:'m<i>'] maps>).mergeV()` is 44 KB of query and a first statement of about 223 KB. Each map becomes a `jsonb('[[{"t":"string","v":"name"},…]]')` VALUES row. A Durable Object refuses it at about 1,300 maps, where the query text alone allows about 6,000. It declines cleanly on both runtimes. This is the owner's priority ("twenty keys" upsert).
- **Fix:** Use a compact per-literal encoding, or one JSON array literal exploded by `json_each`. Never a decline.

#### Fold the labelled both-endpoint seek into the unlabelled seek (`mergee-seek-arm`)
- **Area:** writes / `mergeE`
- **Reach:** plausible
- **Problem:** `endpointSeek` has a `label` parameter that adds a correlated `labelId()` subquery. `mergeEFromMap` has four `seekedSearch` arms, and one is redundant. The `e_pair(src,tgt)` index now makes the unlabelled pair one seek, and `allMatch`'s `labelOk` checks the label for each candidate.
- **Fix:** Remove the `label` parameter and one `seekedSearch` arm (about 10 lines). Answers cannot change. Measure first: N labelled re-upserts out of one hub at 1k and 8k must stay about linear. Use the walk-condition-hub-scale test pattern.
- **Where:** `src/compiler/rel/write.ts` `endpointSeek`, `mergeEFromMap`

### Performance: repeat

#### `local(repeat(both()).times(k))` does not bulk-collapse (`local-repeat-bulk`)
- **Area:** repeat
- **Reach:** rare
- **Problem:** A `local()` or `repeat()` inside `local()` does not bulk-collapse. So `local(repeat(both()).times(k))` enumerates its walks. It compiles, but row count is exponential in k.
- **Fix:** Apply the bulk collapse inside a per-traverser host.
- **Where:** `src/compiler/ir/bulk.ts`

#### The bounded emit unroll's statement text is O(n²) in `times(n)` (`emit-unroll-frontier`)
- **Area:** repeat
- **Reach:** plausible
- **Problem:** Each emitted level is its own UNION arm with k copies of the body, so each prefix is recomputed per arm. A phase is about 1.2 KB. `g.V().emit().repeat(__.local(__.out().order().by('name').limit(1))).times(13).count()` is 119 KB, over DO's 100 KB cap. `emit().repeat(out().order().by('name')).until(loops().is(16))` is 101 KB. The non-emit unroll has the same root: `g.V().repeat(local(outE().order().by('weight',desc).limit(1)).inV()).emit().until(loops().is(20)).values('name')` is 319,550 bytes. These queries decline on DO only, with a clean query-text decline. They compile fully before the store refuses them.
- **Fix:** Compute a per-level frontier relation once: a MATERIALIZED CTE per level that level k+1 extends, or the RelIR tree-Plan promotion. Build this before more emit-unroll admissions. It also lets every emitted level share one random draw, which retires the emit-over-`sample()`/`shuffle` decline in `tryUnroll` (`RepeatStep.java:334-353`).
- **Where:** `src/compiler/ir/strategies.ts` (`tryUnroll`); `src/storage.ts` (`STATEMENT_SHAPE_LIMIT`); `src/sql/kernel/budget.ts`

#### `repeat(both().simplePath()).times(n)` re-inlines the path per level (`simplepath-reinline`)
- **Area:** `repeat()`
- **Reach:** common
- **Problem:** The inline unroll's per-level `simplePath()` check re-inlines the full nested path expression of every earlier level (`jsonb_insert(jsonb_insert(…))`) instead of projecting it once per level. Linear, but against the compute-once rule. R7a (46e0a19b) made `repeat(local(both().simplePath())).times(3)` take this SQL too: 508/3840 → 584/4440 ms at 1k/8k (≈15%, inside the 2× bar).
- **Fix:** Project each level's path once (a MATERIALIZED level or a projected column) and reference it in the next level's check.
- **Where:** `tryUnroll` (`src/compiler/ir/strategies.ts`); the path-family lowering in `src/compiler/rel/lower.ts`

#### `until(map(in().count()).is(P))` counts a hub's whole neighbourhood per frontier row (`until-map-count`)
- **Area:** `repeat()`
- **Reach:** plausible
- **Problem:** The direct spelling `until(in().count().is(P))` takes the count bound (`boundConditionCount`) and stays linear (5.2/10.7 ms at 1k/8k sources → one hub). The `map(…count())` spelling escapes the bound and is answered outside `correlatedExistence`'s refusal, so each frontier row counts the hub's whole in-neighbourhood: 20.9/1110.6 ms, 53× per 8×. Pre-existing. The `project('a').by(out().count()).select('a').is(P)` spelling of the same thing declines with a reason that names the direct spelling (`hubInWalkTerm`), on purpose, so it does not reach this cost.
- **Fix:** Have the count bound see through a `map()`/`project().by()` wrapper of a count, or route both through `perHostWork`'s `exhausts && readsNeighbourhood` refusal. The second retires a trunk answer, so it needs an owner call.
- **Where:** `boundConditionCount` (`src/compiler/ir/strategies.ts`); `correlatedExistence` (`src/compiler/rel/lower/scoped.ts`)

#### A sack-carrying unroll phase never collapses (`unroll-sack-collapse`)
- **Area:** `repeat()`, sack
- **Reach:** plausible
- **Problem:** U4 (b84e2cf1) admits `sack` in a bounded unroll body, but `CHANNEL_GROUP_POLICY.sack = 'undefined'` (`src/channels.ts`) forbids grouping a sack phase, so each path stays its own row (deg^n in `times(n)`). Faithful (`B_O_S_SE_SL_Traverser.carriesUnmergeableSack`, `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/traverser/B_O_S_SE_SL_Traverser.java`) and linear in N (`withSack(0).V().repeat(both().sack(sum).by(constant(1))).times(4).sack().sum()` 2454/18779 ms at 1k/8k, 7.7×), but `repeat(both()).times(4).count()` is 6/51 ms. Not a regression: trunk declined these, and the written-out chain costs the same.
- **Fix:** Collapse a sack phase on `(id, sack value)` with `SUM(bulk)` — two traversers with equal sacks are interchangeable. Same root as `local-repeat-bulk` and the RC(emit) walk blowup (ladder plan 8d0): no collapse of equal traverser states.
- **Where:** `CHANNEL_GROUP_POLICY` (`src/channels.ts`); `src/compiler/ir/bulk.ts`

#### An edge-step unroll body never collapses (`unroll-edge-step-collapse`)
- **Area:** `repeat()`
- **Reach:** plausible
- **Problem:** `repeat(bothE().otherV()).times(4).count()` takes 454 ms at 1k against 6 ms for `repeat(both())`; each phase's rows are edges, so the RLE collapse never fires. Linear (8.6× per 8×). The written-out chain costs the same on trunk (452 ms), so the cost is the edge-step lowering's, not U4's.
- **Fix:** Collapse after `otherV()` (the phase ends on a vertex), or fuse `bothE().otherV()` into `both()` when nothing reads the edge.
- **Where:** `src/compiler/ir/bulk.ts`; `edgeFeedsOtherV` (`src/compiler/rel/lower.ts`)

#### `elementMap().select(k)` builds the whole map per row (`elementmap-select-direct`)
- **Area:** values, `repeat()` conditions
- **Reach:** plausible
- **Problem:** `g.V().repeat(out()).until(elementMap().select('lang').is('java')).count()` (answering since bf776b35) is ≈10–12× its `has('lang','java')` form (121/910 ms vs 10/49 ms at ≈1k/8k); `valueMap().select(k).unfold()` likewise. Linear; constant factor only.
- **Fix:** Canonicalize `elementMap().select(k)` / `valueMap().select(k).unfold()` to `values(k)` (respecting the T.id/T.label keys).
- **Where:** `src/compiler/ir/strategies.ts`

### Performance: branches and nesting

#### Presence gate inlines its value twice (`produced-only-where`)
- **Area:** nesting
- **Reach:** common
- **Problem:** `producedOnlyWhere`, the nested-host presence gate, spells the handed value's correlated subquery twice: in `CASE WHEN (<value>) IS NOT NULL` and in the body. Example: `project('x').by(values('name').local(fold()))` reads `name` twice (10 SELECTs). sql-hygiene's `respelled` check does not see it, because the EXPLAIN parents differ. The gate is also a near-copy of the presence authority in `child.ts`.
- **Fix:** Gate through `gatedByHost`. Lower the rest over `presenceDischarged(host)`, with the value projected once.
- **Depends on:** nr-once-twins
- **Where:** `src/compiler/rel/lower/reduction.ts` (`producedOnlyWhere`); `src/compiler/rel/child.ts` (`hostPresence`, `gatedByHost`, `caseWhen`, `presenceDischarged`)

#### Unused origin in `flatMapRejoin` (`rejoin-unused-origin`)
- **Area:** fan-out
- **Reach:** plausible
- **Problem:** `flatMapRejoin` mints an outer `row_number() OVER ()` origin that nothing reads. Example: `local(__.out().local(__.count()))`. Every fan-out local body inherits it (verify: may have changed).
- **Fix:** Skip the origin when no barrier in the body needs it.
- **Where:** `src/compiler/rel/lower/reduction.ts` (`flatMapRejoin`)

#### Keyed choose: duplicated probe (`keyed-choose-probe-twice`)
- **Area:** branch
- **Reach:** common
- **Problem:** Under a rejoin, and at top level for every keyed reducing option, `routedReduction`'s `EXISTS` probe runs over a second copy of the routed input. `g.V().choose(__.label()).option('person', __.out().count())` emits two identical CTEs, each with the correlated label subquery. `chooseOptions` calls `gate(takes(ordinal))` a second time for the probe. Under `map()` the `P.between(26,30)` gate is inlined 4× (10 KB of SQL). Cost is linear.
- **Fix:** Give the probe the gated Rel that the arm was lowered over. Check `src/rel/passes/prune.ts` DAG pruning first.
- **Where:** `src/compiler/rel/lower/branch.ts` (`chooseOptions`); `routedReduction`

#### Keyed choose: unused bulk column (`reconcile-bulk-constant`)
- **Area:** branch
- **Reach:** rare
- **Problem:** A `reconcileCollapsed` merge adds `1 AS bulk` when no arm carries a bulk channel. Example: `g.V(3).local(__.choose(__.hasLabel('person'), __.out().count(), __.constant('z')).fold())` grows from 1886 B to 1927 B (verify).
- **Fix:** Skip `ensureBulk` when no arm is bulked.
- **Where:** `src/compiler/rel/lower/branch.ts` (`reconcileCollapsed`, `ensureBulk`)

#### A slice after a re-source over a multi-row prefix builds holders × candidates (`resource-union-prefix-slice`)
- **Area:** compile
- **Reach:** rare
- **Problem:** `g.V().hasLabel('holder').map(__.union(__.identity(), __.identity()).V().has('age').limit(3).sample(1))` takes 1.9 s at 1k holders and 15.9 s at 8k (1k candidates). The `has('age')` map form is newly answered since 6c (1d1f3fc8); trunk already paid this cost for the `hasLabel` local form.
- **Fix:** A bounded-slice-per-origin substrate: read the prefix once, slice per origin without crossing the whole candidate set.
- **Where:** `reSourcedBody` (`src/compiler/rel/lower/scoped.ts`), `drawnPerOrigin` (`src/compiler/rel/lower/reduction.ts`)

#### A per-origin draw behind a stream barrier under a tracked path is quadratic (`resource-barrier-prefix-path`)
- **Area:** compile
- **Reach:** plausible
- **Problem:** `g.V().hasLabel('holder').local(__.V().hasLabel('person').order().by('age').sample(1)).path().count()` goes from 1,006 ms at 1k to 71.2 s at 8k (70×); `limit(5).sample(1)` 450 ms → 30.1 s. Trunk before 6a had the same cost. A barrier (`order()`/`limit()`) ahead of the draw takes GraphStep's origins × candidates product instead of `splitInto`'s shared read.
- **Fix:** Lower the barrier inside the once-read shared relation, then split the path after it, as `splitInto` already does for a still prefix.
- **Where:** `splitInto`, `splitRefuses` (`src/compiler/rel/lower/movement.ts`); `reSourcedOnce`

#### A re-sourced arm's `E().has(…).limit(1)` read runs per host (`resource-edge-limit-arm`)
- **Area:** nesting, re-source
- **Reach:** rare
- **Problem:** `g.V().local(__.union(__.E().has('weight',0.5).limit(1).inV(), __.out())).count()` is ≈4× per doubling (590/2405 ms at 1k/2k); inside `repeat(…).times(2)` 1778/120298 ms at 1k/8k (67.7×). The `V().has(name).limit(1)` form is linear. Pre-existing (byte-identical SQL before and after R7b 35feb250).
- **Fix:** Lower the re-sourced, sliced edge read once per query, not per host row.
- **Where:** `reSourcedBody` (`src/compiler/rel/lower/scoped.ts`)

### Performance: paths, labels, side effects and match

#### `fold().as('x').select('x').unfold()` is quadratic in the list (`fold-label-history-copy`)
- **Area:** labels
- **Reach:** plausible
- **Problem:** `g.V().values('name').fold().as('x').select('x').unfold().count()` goes from 30.7 ms to 1595.8 ms (52×). A map-valued `values('m')` is 67×. The label-history column `a0 = jsonb_array(jsonb_object('k',3,'v',json(fd8.list)))` copies the whole list onto every exploded row.
- **Fix:** Drop the history entry through the explode when nothing downstream reads it. Or reference the folded row by key instead of copying it.
- **Where:** `src/compiler/rel/list.ts`

#### Inline label compare builds a JSON history per row (`inline-label-compare-cast`)
- **Area:** labels
- **Reach:** plausible
- **Problem:** `g.V().as('a').out().in().where(neq('a')).count()` compares through `CAST(json_extract(jsonb_array(jsonb_object('k',0,'v',rn.id)),'$[#-1].v') AS INT)` instead of `rn.id`. Linear; ≈1.36× slower than the old `local()` route at 1k/8k (3.5/28.1 vs 2.6/20.6 ms), which R7a (46e0a19b) now routes through the inline form.
- **Fix:** When a label's history holds one known entry, compare the bound column directly.
- **Where:** the label-history `where(neq)` lowering in `src/compiler/rel/lower.ts`

### Performance: values, lists and maps

#### A shared collection is re-read per traverser (`collection-reread`)
- **Area:** collections
- **Reach:** plausible
- **Problem:** `g.V().group('a').by(constant('a')).by('age').select('a').select('a').count()` goes from 57 ms to 3.4 s. Also: a collection read that does not depend on the outer row is paid per host row in `coalesce`, `choose`, `order().by` and `dedup().by`. `g.V().aggregate('a').coalesce(select('a').unfold().has('age',gt(1000)), constant('x')).count()` goes from 0.75 s to 62 s. `local(select('a').unfold().limit(2))` and `map(select('a').unfold())` are quadratic. N9 reads a collected side effect per traverser at 68×.
- **Fix:** Read the collection once as one MATERIALIZED relation and cross-join it.

#### A side effect read inside `where` is re-derived per traverser (`where-sideeffect-rederive`)
- **Area:** collections
- **Reach:** plausible
- **Problem:** `g.V().both().groupCount('a').by(T.label).as('b').barrier().where(__.select('a').select('software').is(P.gt(2))).select('b').values('name')` re-runs `V().both()` in a correlated scalar subquery per row. Under `count()` it takes 3.6 s at 1k and 246.8 s at 8k (68×). `scripts/sql-plan-baseline.json` accepts it.
- **Fix:** Compute the side effect once and join it.

#### Pooled `group` join-then-GROUP BY gap (`owner-q3a-group-rule`)
- **Area:** collections
- **Reach:** common
- **Problem:** `group().by(label).by(count())` is 1.40× and `by('name').by(tail())` is 1.30× slower than the old ladder.
- **Fix:** Add a decorrelation rule that closes the pooled `group` join-then-GROUP BY gap. The owner queued this (Q3a).

#### Correlated reduce computes its aggregate twice (`correlated-reduce-twice`)
- **Area:** reducers
- **Reach:** common
- **Problem:** `correlatedReduce` computes the whole aggregate twice per row, once for `v` and once for `vtype`. This hits `values('age').local(sum())` (about 6× per-row overhead, linear).
- **Fix:** Project the aggregate once and read `v` and `vtype` from it.
- **Depends on:** nr-once-twins
- **Where:** `src/compiler/rel/lower/reduction.ts` (`correlatedReduce`)

#### Collection member expressions inlined many times (`collection-members-once`)
- **Area:** lists
- **Reach:** plausible
- **Problem:** `collectionMembersOrSelf` inlines the member value expression 4×, vtype 2× and the `vtype IN (list,set)` flag about 10×. `g.V().V(__.values('ref')).count()` over a plain String key grew from 919 B to 2499 B and 12.0 ms to 19.3 ms at 8k. `positionedMembers` also adds a full-stream `row_number()` under `count()`.
- **Fix:** Project the expressions once behind a fence, as `V(__.out().id())` does with `LIMIT -1 OFFSET 0`. Skip `row_number()` when nothing reads the order.
- **Depends on:** nr-once-twins
- **Where:** `src/compiler/rel/list.ts` (`collectionMembersOrSelf`); `src/compiler/rel/lower.ts` (`positionedMembers`)

#### List set-op member family spelled three times (`listsetop-family-once`)
- **Area:** lists
- **Reach:** rare
- **Problem:** `listSetOp` spells the self-side member family expression (a CASE in a CASE over `json_extract(mx.type)`) 3×: in SELECT, in the semi-join EXISTS and in GROUP BY. Example: `g.V().local(__.values('name').fold()).intersect(__.V().values('name').fold())`.
- **Fix:** Project `mine`'s `(mv, mf)` once below the join.
- **Depends on:** nr-once-twins
- **Where:** `src/compiler/rel/list.ts` (`listSetOp`)

#### `dedupLocalValue` in N log N (`dedup-local-nlogn`)
- **Area:** local dedup
- **Reach:** plausible
- **Problem:** `dedupLocalValue` is quadratic. A `fold()` of 8k members costs about 32M comparisons.
- **Fix:** Stable-sort on `(orderabilityCompare, index)`. Keep the first of each equal run. Re-emit in index order (LinkedHashSet keeps the first occurrence). This is safe because `compare()==0` is type-spaced. Run a scaling probe at 1k and 8k; expect about 64× to drop to about 10×.
- **Where:** `src/compiler/rel/orderability.ts` `dedupLocalValue`

#### `order(local).by()` over list members reads each key once (`list-order-keptby`)
- **Area:** local order over a list
- **Reach:** plausible
- **Problem:** The local order branch calls `byProjection` a second time (`keyOn(kept)`) to re-point the key at the `mof` productivity filter. It also spells the member key twice (in the filter and in `json_group_array`'s ORDER BY). `fold().order(local).by('age')` reads the property twice per member.
- **Fix:** Use `keptBy` and `withSubqueryColumns` from `build.ts`. Keep the same productivity drop (`Order.feature:281-289` still gives four vertices). Gate on a `vertex_properties` read count, as in `value-run-once.exec.test.ts`.
- **Where:** `src/compiler/rel/list.ts` local order branch; `src/compiler/rel/build.ts` `keptBy`

### Performance: filters and predicates

#### Re-land the tag-guard algebra (`tag-excludes-guard`)
- **Area:** predicates
- **Reach:** plausible
- **Problem:** A String set that mixes a number-spelled member with another member (`within('CA','10')`) keeps the per-member disjunction. It gets a key-only seek, which is graph-sized (0.086 → 0.855 ms, N=1k → 8k). The fix is built but not landed: branch `wf/tag-excludes-guard-3-0`, a448915b, worktree `.claude/worktrees/wf_e5181ab5-5da-143`. Its CI was green and the cherry-pick onto trunk applied cleanly.
- **Fix:** Re-land the branch. It adds one tag-guard algebra (`tagExcludes`/`tagOnly`, a `TagGuard` value, `sameSpaceEquality` returning `(raw, guard)`, `composedSetGuard`). It deletes `hoistedStringSet` and both `JSON.stringify` recognizers. It gives `within('CA','10')` the multi-seek (pinned in `test/plan-stability.test.ts`) and fixes string-set-param-guard. After re-land, remove the stale names `hoistedStringSet`/`stringOnly`/`textSpaced` from this doc and from the Next-round `tagExcludes` line.
- **Where:** `src/compiler/rel/predicate.ts`

### Performance: sources and movement

#### `both()` one-read form slows label and path shapes (`both-gate-frontier-cost`)
- **Area:** movement
- **Reach:** common
- **Problem:** The computed-carrier leg of `copyRepeatsWork` cannot see the consumer or the hop depth. Every hop takes the direction-row form. Then `jsonb_array(jsonb_object('k',0,'v',rn.id))` is rebuilt per output row, not once per vertex. Measured at 8k/24k: `g.V().match(__.as('a').both().as('b'), __.as('b').both().as('c')).count()` +40%; `g.V().as('a').both().both().both().where(neq('a')).count()` +47%; 4 hops +54%; `both().both().both().simplePath()` +12%.
- **Fix:** Keep the window, DISTINCT and LIMIT legs. Narrow or drop the carrier leg, or project the computed carrier at the frontier's row count. Add the `match()`, 3-hop and 4-hop label shapes to the scaling witnesses. Correct the `copiedWork` doc: a computed filter predicate counts as no work. (verify: the current `copies.ts` comment reports label shapes as faster; re-measure.)
- **Where:** `src/rel/copies.ts` (`copyRepeatsWork`, `copiedWork`); `test/compiler/both-frontier-once.exec.test.ts`

### Performance: federation, services and io

#### Federate value tail is quadratic (`federate-value-tail`)
- **Area:** federate
- **Reach:** plausible
- **Problem:** `….call('federate',['graph':'x']).V().has('name', select('e')).values('age').sum()` goes 397 ms → 22.2 s. The `.count()` form and the injected sibling form are linear. The arg-less pushdown for a value tail does not take the mapValues injection route.
- **Fix:** Route the value tail through the mapValues injection.
- **Depends on:** S1
- **Where:** `src/services/catalog/federate.ts`

#### Federate scatter sorts the wrong way round (`federate-scatter-order`)
- **Area:** federate
- **Reach:** plausible
- **Problem:** The `lowerTypedNodeStream` scatter is `json_each(?) fnx0 CROSS JOIN json_each(?) fgd2 ORDER BY fgd2.value, fnx0.key`. The pool is outer and the parents inner, so a temp B-tree sorts all P×N rows. Pool 8k × 100 parents: 385 ms, against 107 ms before. End to end over 8k parents: 98 → 144 ms.
- **Fix:** Put the parents outer. Sort per parent only where a pushed `order()` asks for it; §17 treats cross-parent order as unordered.
- **Where:** `lowerTypedNodeStream` in `src/compiler/rel/lower.ts`

### Performance: storage and runtimes

#### Set-operation membership relies on SQLite's automatic index (`setop-autoindex-do`)
- **Area:** storage
- **Reach:** plausible
- **Problem:** Intersect and difference semi-join a MATERIALIZED operand spool. EXPLAIN shows `USING AUTOMATIC PARTIAL COVERING INDEX`. Every witness is 2.5–5× for 8× on Bun. If DO runs with `automatic_index` off, the join is O(N·M) in production only. A walk's per-state `emit` condition (`perState`) relies on the same index.
- **Fix:** Check DO's pragma default and cite it in the `listSetOp` doc. Or make `CfLimitedSql` run with `PRAGMA automatic_index=OFF` so CI sees it. If it is off on DO, index the spool explicitly.
- **Where:** `listSetOp`; `src/cf-limits.ts` (`CfLimitedSql`); `src/compiler/rel/walk.ts` (`perState`)

### Performance: tests, tooling and docs

#### Route re-inlined expressions through `once()` (`nr-once-twins`)
- **Area:** sql-hygiene
- **Reach:** common
- **Problem:** Many lowerings spell one expression several times per row. Known sites: `storedCompareOnce`/`valueTheta` in `predicate.ts` (`nr-ru1`, `nr-ru2`, `r5-fu5`: every correlated `where()`/`has()` comparison); the `is()` chain (`rf3-is-chain-size`); the modulator's `projectionOf`/`typedOf`; groupCount's `json_each` (15× per row, `r6-s9-4`); the child seam (3–5×, `S9.8`); the alias operand at `as()` (`r5-fu2`); `order().by(<may-be-empty>)` (twice, `r6-m-orderby`); the record-field `{t,v}` round trip (`r6-s9-6`); the math label-variable fold (3×); the per-row `typeOf` CASE (inferred vtype twice, `predicate.ts`).
- **Fix:** Route each site through `once()` in `rel/build.ts`. The change is semantics-free: no Map probe, no `landedOnce`.
- **Where:** `src/compiler/rel/build.ts` (`once`); `src/compiler/rel/predicate.ts`; `src/compiler/rel/modulator.ts`

### Performance: compiler internals

#### Keyed join residue stays super-linear (`keyed-join-residue`)
- **Area:** semijoin
- **Reach:** plausible
- **Problem:** These shapes were super-linear before U4 and are still super-linear:
  - (a) A keyed join under a window `dedup()` whose WHERE also holds an EXISTS-to-join loop. SQLite does not build the automatic index and scans the rows. Example: `…has('name', select('n')).has('kind','person').select('a').dedup()`, 436 ms at 1k, 28 s at 8k.
  - (b) The magic per-host body in a scalar `map/project().by(…count())`. Its test is a semi-join on the magic set, not a seek the keyed join uses (22 ms, 1.2 s).
  - (c) A constant inside a nested `where(__.has(…))` after the correlated seek (36 ms, 2.4 s).
  - (d) A correlated `V().has(k, select('n'))` body in `local()` or `coalesce()` decorrelates into `outer CROSS JOIN <every element>`. Example: `…values('name').as('n').local(__.V().has('name', select('n')).values('city')).count()`, 693 ms at 1k, 44 s at 8k.
- **Fix:** Fix each shape in the keyed join or the decorrelator. (verify: later ladder-retirement magic work may have changed (b) and (d).)
- **Depends on:** S1
- **Where:** `src/rel/passes/semijoin.ts` (`keyedJoin`), `src/rel/decorrelate.ts`

#### Correlated value is spelled twice (`value-join-spelled-twice`)
- **Area:** semijoin
- **Reach:** common
- **Problem:** `narrowFilter` (and `indexSeek` through `freshCopy`) copies the full typed-value normaliser into the IN. It keeps the EXISTS, which holds of the same rows. Statement text about doubles per correlated `has()`. `sql-hygiene` cannot see it because the corpus has no value join.
- **Fix:** Replace the EXISTS with the IN when the IN is placed. Or project the value once on the outer side and reference that column from both. Add a `sql-hygiene` witness of a value join.
- **Where:** `narrowFilter` in `src/rel/passes/semijoin.ts`

#### Label past `as()` regression to re-measure (`r7-fu3-label-past-as`)
- **Area:** semijoin
- **Reach:** plausible
- **Problem:** `g.V().hasLabel('city').values('name').as('e').V().hasLabel('person').as('v').has('city', select('e')).select('v').values('name').count()` was reported at 232 ms / 3.7 s (1k/4k), against 127 ms / 2.0 s before. The `dedup()` form also regressed.
- **Fix:** Re-measure this witness. Pin it in `test/correlated-value-seek.test.ts`. Add the missing fixture: a low-cardinality key against a small labelled set, both correlated and constant.
- **Where:** `test/correlated-value-seek.test.ts`

#### Unroll decline compiles fully first (`cc5-order-phase-cost`)
- **Area:** compile
- **Reach:** rare
- **Problem:** Between the old 2,560-step and the new 10,000-step early charge, a decline compiles fully before it declines. `repeat(out()).times(9000)` went from 0 ms to 2–3 s. `repeat(out().order().by('name')).times(3300)` takes 1.8 s and ~367 MB heap, near a DO's 128 MB isolate.
- **Fix:** Make the per-node cost of an `order().by()` phase cheaper (now ~750 B/phase). Do not lower the budget. Do not add a per-step-kind byte table.
- **Where:** `src/sql/kernel/budget.ts` (`CompileBudget`)

#### Transformed sort/dedup key spelled twice per row (`cc7-key-twice`)
- **Area:** compile
- **Reach:** common
- **Problem:** `g.V().out().order().by(values('name').toLower().toUpper())` reads the property once. But the `lower()/upper()` and receiver-check CASE appear twice: in the productivity filter's `IS NOT NULL` and in the sort projection. `sql-hygiene` does not see a repeat in a LET shape.
- **Fix:** Compute the whole key once as a column below the filter. This does not change which rows run it or which error fires. `exprMayAbort` is too conservative here.
- **Where:** `withSubqueryColumns`, `keptBy` in `src/compiler/rel/build.ts`

#### Double-tagged scalar field spelled 4× in `project().by()` (`cc1-double-tag`)
- **Area:** compile
- **Reach:** plausible
- **Problem:** A double-tagged scalar field through the correlated `by()` form spells the correlated value subquery 4× in the number-class framing (`printf('%.15g', v)` CASE) and 2× for presence. That is ~3.2 KB per key against ~1.1 KB plain. Growth is linear, but "computed once" is broken.
- **Fix:** Make it a `once` consumer (§3.1).
- **Where:** `src/compiler/rel/record.ts`, `src/compiler/rel/framing.ts`

#### Scalar runs take a slower correlated plan (`scalar-tail-fence`)
- **Area:** compile
- **Reach:** common
- **Problem:** `scalarTail` fences the clause reader only where `isSelfContained(rel)` holds. So `g.V().local(__.values('age').is(P.gt(30)).dedup().fold())` (and `.order().fold()`) runs as a correlated per-row subquery. It re-inlines the value `CASE` expression 9 times. It is 35–40% slower at N=8k (14.8 → 20.2 ms), but still linear.
- **Fix:** Route only the runs that used to decline (reducing `count()` children) through the unfenced path. Or project the value once inside the correlated child. Add a sql-hygiene corpus witness of this shape.
- **Where:** `src/compiler/rel/lower.ts` (`scalarTail`, the `&& isSelfContained(rel)` term)

#### A re-source over an origin-independent candidate set is quadratic (`cr-fu5`)
- **Area:** compile
- **Reach:** plausible
- **Problem:** `local(__.V().hasLabel('person').limit(2)).count()` goes from 355 ms to 24.6 s. `sample(2)` is the same. `rankPairs` crosses origins × candidates. `g.V().hasLabel('software').local(V().hasLabel('person').order().by(shuffle).limit(2)).count()` too: 191 ms at 1k, 14.0 s at 8k (73×); `shuffleCutToSample` serves only a cut to one.
- **Fix:** Read the prefix once with `rootedRead`, then cross with its small result. Fix the `rankPairs` doc: the CTE is not `MATERIALIZED`, so "FENCED" is wrong.
- **Where:** `rankPairs`, `rootedRead`

#### A per-origin draw over a moving re-source under a tracked path is quadratic (`reresource-path-draw`) (verify: may have landed)
- **Area:** compile
- **Reach:** rare
- **Problem:** `g.V().hasLabel('holder').local(__.V().hasLabel('person').out().sample(1)).path().count()` goes from 585 ms at 1k to 39.7 s at 8k (68×). `local(V().out().limit(1)).path()` declines in `reSourcedBody`. Recent commits d19d6f6e and d4406e18 changed this area.
- **Fix:** Concatenate the read's own path onto the origin's after the join.
- **Depends on:** M1b/H1
- **Where:** `reSourcedOnce`, `reSource`, `reSourcedBody`

#### A per-origin slice or draw after a host-reading filter in a re-source is quadratic (`reresource-host-filter`)
- **Area:** compile
- **Reach:** plausible
- **Problem:** `g.V().hasLabel('holder').as('h').local(__.V().hasLabel('person').where(neq('h')).limit(1)).count()` goes from 665 ms at 1k to 45 s at 8k. The `sample(1)` form goes from 806 ms to 55 s. `sharedEnd` cuts the shared read at the host-reading step, so the slice runs per host over hosts × graph.
- **Fix:** Push the host-reading filter past the slice as an anti-join or semi-join on the shared read. `neq('h')` excludes at most one row per host, so share `limit(k+1)` and filter per host.
- **Where:** `sharedEnd`, `reSourcedBody`

#### Mid-traversal `V().has` with no seek in a read (`r4-perf1`) (verify: may have landed)
- **Area:** compile
- **Reach:** plausible
- **Problem:** The original witness went from 813 ms to 44.6 s. The matching r7-fu3 value join is now linear.
- **Fix:** Re-probe the original witness. Close the item if it is linear.

#### A labelled value join is quadratic (`r7-fu3-labelled`)
- **Area:** compile
- **Reach:** plausible
- **Problem:** `…V().hasLabel('person').has('name', select('e'))` is label-driven: 328 ms → 20.8 s (63×), also inside a federated sibling. Value-over-label was measured to make a fact-to-small-dimension join quadratic. Also quadratic: an element reached through a join key, `V().outE().has('w', select('w'))` (1.07 s → 71 s). A value join after a re-source, `g.V().hasLabel('holder').values('age').as('a').V().hasLabel('person').has('age', __.select('a')).count()`, takes 439 ms at 1k and 29.5 s at 8k; the seek in `semijoin.ts` does not fire for it.
- **Fix:** Join the outer value against one materialized `(owner, value)` relation of the labelled set, built once and index-probed per outer row. This must be a real join (RelIR `flatten` §4 decorrelation), not a narrowing conjunct. A correlated `IN` over a MATERIALIZED CTE scans per row. The join-key case needs a join reorder. A selectivity fact is the other option, but DO cannot bound `ANALYZE`.
- **Where:** `src/rel/passes/semijoin.ts` (`narrowFilter`)

#### A crossed run's filters run once per (host, vertex) pair (`crossed-run-filter`)
- **Area:** compile
- **Reach:** plausible
- **Problem:** `g.V().hasLabel('holder').V().hasLabel('person').has('age',1500).count()` takes 152 ms at 1k and 10.8 s at 8k (71×). The SQL is `nodes CROSS JOIN (…) WHERE … EXISTS(…)`.
- **Fix:** Evaluate the crossed run's filters once, before the cross join.

#### A scalar member node is rebuilt per one-row producer (`r6-reuse4`)
- **Area:** compile
- **Reach:** common
- **Problem:** `project().by(outE().values('weight').sum())` reads the edges twice per host row. `max` reads them three times.
- **Fix:** Build the scalar member node once and share it.

#### No body-may-yield-NULL fact (`S11`)
- **Area:** compile
- **Reach:** common
- **Problem:** The M3 removal machinery always runs. It costs +13–75%.
- **Fix:** Add a fact for "this body may yield NULL". Skip the machinery when the fact is false.

#### `g.V().union(out(), in()).limit(2)` is linear, not constant (`union-limit-linear`)
- **Area:** compile
- **Reach:** common
- **Problem:** It takes 4.9 → 37 → 339 ms at 1k/8k/64k vertices. The cause is not diagnosed. It is possibly the per-start arm order ahead of the `LIMIT`.
- **Fix:** Diagnose with EXPLAIN. Make the `LIMIT` stop the scan early.

#### Super-linear shapes from ladder-retirement rounds 4–7 (`ladder-superlinear`)
- **Area:** compile
- **Reach:** plausible
- **Problem:** Each is pre-existing. Full witnesses are in `docs/2026-11-16-ladder-retirement-plan.md` at `4100715c` (search the id).
  - V2: `magic`'s per-filter row-bound gate keeps `limit(1)`-before-test quadratic. The fix is likely a one-line delete.
  - V3: a pick inside a body needs a per-host-bounded magic domain.
  - V5: hosts that magic does not reach, including hosts after `coalesce`/`optional`/`union`/`choose`. `local(repeat(out('knows')).emit().limit(3))` does not terminate on a cyclic graph.
  - U6/U7: the positional scope key of a `both()`/`union` body.
  - T4: `where(is(c))` over a value is cubic.
  - N9: `local(select('x').unfold().sample(1))` raises a bare `database or disk is full` Error at 1k. `local(repeat(both()).times(k).dedup())` has no per-iteration collapse.
  - R4.5: `flatMap(out().out())` is 1.29×. Decide if "a body that moves is left alone" is semantic.
- **Fix:** Address each by its own id.
- **Where:** `src/rel/passes/magic.ts`

#### Trigram seek reach is root-only (`trigram-seek-reach`)
- **Area:** compiler
- **Reach:** plausible
- **Problem:** The trigram seek fires only on a root `V()`/`E()` scan. `where(has('name',containing('ark')))`, `out().has(…containing)`, `local(has(…))` and `union(has(…), …)` do not use `property_fts`. The plans are correct and linear (`out().has`: 3.0 ms at 1k, 5.7 ms at 8k). This entry records the limit so nobody overstates the seek's reach.
- **Fix:** Extend the seek past the root only if a measurement justifies it.
- **Where:** `src/rel/passes/semijoin.ts`

#### Far-endpoint `hasId` not pushed into the edge seek (`far-hasid-seek`)
- **Area:** compiler
- **Reach:** plausible
- **Problem:** `g.V(2).outE().where(inV().hasId(4)).count()` and `g.V(2).out().hasId(4).count()` seek `e_pair (src=?)`, not the `(src=? AND tgt=?)` prefix. A hub source reads its whole out-neighbourhood.
- **Fix:** Push a far-endpoint `hasId` into the seek's `tgt` column.

#### Origin-independent draw body re-evaluated per host (`draw-prefix-once`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** A drawing body whose prefix does not depend on the origin still costs scope × candidates. The cost is linear. `map(__.V().hasLabel('software').order().by('age').sample(1))` takes 1.8 s at 1k hosts and 13.0 s at 8k. `limit(5)`, `dedup()` and `order().by(shuffle)` prefixes behave the same.
- **Fix:** Lower such a prefix once. Then draw from it with the counting pick.

#### Scalar side-effect constant decoded per reference (`cr-fu3`)
- **Area:** compiler
- **Reach:** plausible
- **Problem:** A scalar side-effect constant is decoded at each reference. `where(__.select('k').is(5))` emits a CASE tower of about 1 KB.
- **Fix:** Spell the constant with `constLit` at the child seam.
- **Where:** `src/compiler/rel/const.ts` `constLit`

#### `hasLabel` on a joined edge re-reads the edge (`label-probe-edge-col`)
- **Area:** compiler
- **Reach:** plausible
- **Problem:** `hasLabel` on a joined edge does a correlated rowid probe. `outE().as('e').inV().inE().hasLabel('created').where(neq('e'))` is about 1.5× slower than before (linear, output-bound). The old IN form has the same cost.
- **Fix:** When `ownScan(row, id, 'edges')` resolves, read `col(scan, 'label')`.

## 3. Queries we decline

Sensible queries that fail with `UnsupportedTraversal` today. Each one is a feature gap we plan to close.

### Queries we decline: writes

#### Literal maps are spelled about 5× their query text (`literal-text-amplification`)
- **Area:** writes
- **Reach:** common
- **Problem:** `g.inject(<100 × 20-key string maps>).mergeV().count()` is 32 KB of query and a ~118 KB first statement. A DO refuses it (100 KB text cap). 50×20 answers; 200×20 is ~238 KB. Each key and value is spelled as a quoted `{"t":"string","v":…}`. Also, a 200 KB literal `property('doc','<…>')` renders as ~400 KB, because it is spelled twice. The decline message is clear, but the cause stays.
- **Fix:** Use a compact typed-literal encoding, or one JSON array literal exploded by `json_each`. Spell a literal once. Never add a decline. The parameter route for maps waits on R8-res.
- **Depends on:** R8-res (parameter route only)
- Note: duplicate of the §4 entry of the same id. Merge; keep these numbers.

#### Large label carrier surfaces `database or disk is full` (`large-label-carrier-full`)
- **Area:** writes
- **Reach:** rare
- **Problem:** A large collection carried per member under an `as()` label fails with a bare `database or disk is full`. The user cannot read this as a query limit.
- **Fix:** Map it to a clear platform/size message, or avoid the per-member carrier copy.

#### Map parameter members spelled as constants (`nr-param-map-members`)
- **Area:** writes
- **Reach:** plausible
- **Problem:** `g.mergeV($m)` and `option(Merge.onCreate/onMatch, $m)` decompose the map at compile time (`MergeMaps`). Each member value is inlined. A member over about 100 KB exceeds a Durable Object's statement cap, so the query fails on the size of a parameter. Statement text grows 1:1 with member size (1,484 B at 10 B; 400,699 B at 400 KB).
- **Fix:** Spell a parameter's members from the parameter's own bind: one JSON bind per map parameter, members read as `json_extract(?, '$[i]')`. Never one bind per member. Workaround: `inject($m).mergeV()` (`mergeVFromMap`) already carries the map as one value. A label or key parameter (`addV($l)`) is also inlined, but it is a name, not a document.
- **Where:** `src/compiler/ir/write-args.ts` (`MergeMaps`); `src/compiler/rel/write.ts`

#### Batch-upsert idiom (`R8-res`)
- **Area:** writes
- **Reach:** common
- **Problem:** `g.inject([[name:'x'],…]).unfold().mergeV()` and `g.inject([[lookup:[…], create:[…]],…]).unfold().mergeV(__.select('lookup')).option(Merge.onCreate, __.select('create'))` decline: an unfolded list is not Map-framed. The un-unfolded form and record-framed `project('name').by('name').mergeV()` decline with `MapScopeDeferral` `'merge-own-entry'`. This is the top write candidate.
- **Fix:** Let `mergeFromTraversal` take record and `inject(map)` drivers, starting at `parseComputedMergeArg`'s per-driver map decomposition. Then `literalTextHint` can tell a too-large literal upsert to send `inject($rows).unfold().mergeV()`; today it can only say "send the values in smaller batches".
- **Depends on:** nr-fu-onmatch-scope (§1)
- **Where:** `src/compiler/ir/write-args.ts` (`parseComputedMergeArg`); `src/sql/kernel/budget.ts` (`literalTextHint`)

#### Explicit map over a Map driver (`merge-explicit-over-map-driver`)
- **Area:** writes
- **Reach:** rare
- **Problem:** `g.inject([a:1]).mergeV([name:'q'])` declines. So does a side-effect `select(k)` that no Map holds. Each is a plain multiplier that `mergedFromMap` does not route yet.
- **Fix:** Route these through `mergedFromMap`.
- **Where:** `src/compiler/rel/lower.ts` (`mergedFromMap`)

#### Map driver with a token key (`nr-fu-token-keys`)
- **Area:** writes
- **Reach:** plausible
- **Problem:** The `mergeV` form now answers. A `mergeE` map with endpoint token keys still declines: `g.inject([(T.label):'knows',(Direction.from):1,(Direction.to):2]).mergeE()`. `literalKeyFacts` gives up on a non-string key, so `mapSearchedKeys` is null and `mayHold` is always true (verify the remaining cause).
- **Fix:** Record the string keys beside the token keys. A string `select(k)` never hits a token key (`vendor/tinkerpop/gremlin-core/.../Scoping.java:119-121`).
- **Where:** `src/compiler/rel/framing.ts` (`literalKeyFacts`)

#### Single-source and `addV(T.id)` admission as row bounds (`nr-ru5`)
- **Area:** writes
- **Reach:** rare
- **Problem:** `g.V(1).addV().property(T.id,99)` declines. `singleSource` and the one-row `addV(T.id)` admission are not `rowBounds` questions.
- **Fix:** Ask `rowBounds` instead. The source `addV` id-collision guard must then cover the mid-chain path. `writeSnapshot` stays Values-only.
- **Where:** `src/compiler/rel/write.ts`; `src/rel/bounds.ts`

#### Injected label read by `addV` (`inject-label-addV`)
- **Area:** writes
- **Reach:** plausible
- **Problem:** `g.inject(1,2,3).as('i').addV('person').property('age', __.select('i'))` declines.
- **Fix:** Carry the label channel into the write's property traversal.

#### Merge residue (`merge-residue`)
- **Area:** writes
- **Reach:** plausible
- **Problem:** These decline: explicit list/set cardinality on a runtime merge arm; a map-driver merge holding `T.id`, a list-valued map (from `valueMap()`) or a multi-label map; map-driver `mergeE` with `option(Merge.outV/inV)` or an onCreate endpoint; `mergeE` over an incoming vertex stream (`elementMergeE`); an edge runtime arm value `option(onMatch,[k:__.trav])`; `mergeV(__.select("m").limit(local,1).unfold())`. A PartitionStrategy-aware upsert declines (7 L3 scenarios).
- **Fix:** Extend the merge driver one shape at a time.

#### Cardinality wrapper in a merge map (`merge-cardinality-wrapper`)
- **Area:** writes
- **Reach:** plausible
- **Problem:** `g.inject([name:'x', age:Cardinality.single(1)]).mergeV()`, its `mergeE` twin and bare `inject([k: single(1)])` decline and write nothing. So do `mergeE`/`E().property` with a `Cardinality.single(…)` map value.
- **Fix:** Let the map-literal blob and the merge driver carry and unwrap a `{cardinality, value, type}` value, as `MergeVertexStep.java` unwraps `CardinalityValueTraversal`. Three `@Unsupported` scenarios in `test/L4-addendum/binary-values.feature` fail when this lands. Wrapper writes inside `union`/`sideEffect`/`local` need `s3-write-in-child`.
- **Where:** `mapLiteralBlob`; `valueNodeOf`

#### Derive `KEEPS_ONE` from `ONE_TO_ONE` (`keeps-one-derived`)
- **Area:** writes
- **Reach:** plausible
- **Problem:** `KEEPS_ONE` restates 14 step names by hand and has drifted: it lacks `path`. So a one-traverser write chain through `path()` declines. `PathStep` is in Java's definitely-singular list.
- **Fix:** Build `KEEPS_ONE` from `ONE_TO_ONE` ∪ filters, slices, side effects and creations via `unionOf`. This gives one arity vocabulary and turns the `path()` decline into an answer.
- **Where:** `src/compiler/rel/write.ts` `KEEPS_ONE`; `src/compiler/ir/step.ts` `ONE_TO_ONE`

### Queries we decline: repeat

#### Spine cut does not reach correlated hosts or write programs (`spine-cut-hosts`)
- **Area:** repeat
- **Reach:** rare
- **Problem:** Only the root spine of a write-free program is cut into CTEs. A long unroll inside a correlated host or a write program still uses the JS stack. It declines through `tooDeep` at a depth that depends on the runtime. Examples: `g.V().local(__.repeat(__.out().limit(1)).times(1200)).count()`, union arms, `g.V().repeat(__.out().limit(1)).times(1200).addV('x')`.
- **Fix:** Make the correlated body a relation of its own. Then cut it the same way as the root spine.
- **Depends on:** correlated-subtree-sharing
- **Where:** `boundedSpine` and `hoist.cut` in `src/compiler/rel/lower.ts`

#### Counted `until` over a fan-out host (`until-fanout-host`)
- **Area:** repeat
- **Reach:** plausible
- **Problem:** The walk refuses every fan-out-hosted body, barrier or not. `needsPhases` picks phases only when the host's child holds a stream barrier. So `g.V().repeat(local(bothE().has('weight',gt(0.4)).otherV())).until(loops().is(2)).count()` and `g.V().repeat(flatMap(outE().inV())).until(loops().is(2)).count()` decline, while the `times(2)` forms answer.
- **Fix:** Widen `needsPhases` to any `FAN_OUT_HOSTS` child. Phases already answer these in O(k) SQL. Or correct the docstring's `BARRIER_IN_TERM` reason and record the gap.
- **Where:** `src/compiler/ir/strategies.ts` (`needsPhases`); `src/compiler/ir/step.ts` (`FAN_OUT_HOSTS`)

#### Fan-out barrier body under a branch host or uncounted `until` (`repeat-branch-fanout`)
- **Area:** repeat
- **Reach:** rare
- **Problem:** A fan-out barrier body under a non-counted `until` or a branch host declines, also in its `times(n)` form. Examples: `repeat(optional|union|coalesce|choose(…local(…)…))`, `where(repeat(local(out().limit(1))).until(loops().is(1)))`.
- **Fix:** Needs the tree-Plan promotion.

#### `discard()` in a bounded `repeat()` body (`discard-in-repeat`)
- **Area:** repeat
- **Reach:** rare
- **Problem:** `g.V().repeat(out().discard()).times(2)` declines. A host whose child reads `loops()` in a bounded body also declines.
- **Fix:** Admit `discard()` as an unrollable body step.

#### `as()` inside a repeat region (`repeat-interior-as`)
- **Area:** repeat
- **Reach:** rare
- **Problem:** `g.V(1).repeat(out()).as('a').times(2)` and `repeat(out()).as('z').emit().times(1)` decline. `verifyRepeatDefined` accepts them, correctly, but `gatherRepeatRegion` splits at `as()`.
- **Fix:** Land with the region-grouping proposal, as its own item with an L4 witness.
- **Where:** `gatherRepeatRegion`; `verifyRepeatDefined`

#### `repeat()` region absorbs an interior `as()` (`repeat-interior-as`)
- **Area:** `repeat()`
- **Reach:** plausible
- **Problem:** `repeat(out()).as('a').times(2)` declines (§4). TinkerPop lets the repeat region absorb an interior `as()`.
- **Fix:** Let `gatherRepeatRegion` absorb an interior `as()`. Add an L4 witness. This changes answers, so it is a separate item.
- **Depends on:** `repeat-slot`
- **Where:** `gatherRepeatRegion`

#### `otherV()` after a global barrier inside a repeat body (`repeat-barrier-otherv`)
- **Area:** `repeat()`
- **Reach:** plausible
- **Problem:** `g.V(1).repeat(bothE().sample(1).otherV()).times(3)` and `g.V(1).repeat(bothE().limit(1).otherV()).times(3)` decline with the generic "no lowering covers …", which names nothing. The `local(bothE().sample(1).otherV())` recipe answers. The unbounded `repeat(local(out().sample(1))).until(…)` also declines. Not a regression (6d(a), d5ce03e2, did not change them).
- **Fix:** Carry the edge's `fromV` through a phase-level barrier in an unrolled body; at minimum, a decline that names the barrier-then-`otherV()` shape.
- **Where:** `tryUnroll` (`src/compiler/ir/strategies.ts`); `edgeFeedsOtherV`, `FROM_V_TRANSPARENT` (`src/compiler/rel/lower.ts`)

#### Sack in an optional arm of an unroll; a sack repeat inside `local()` (`sack-optional-local-repeat`)
- **Area:** `repeat()`, sack
- **Reach:** rare
- **Problem:** `g.withSack(0.0).V().repeat(__.optional(__.outE().sack(sum).by('weight').inV())).times(2).sack()` and `g.V().local(__.repeat(…sack…).times(2))` decline with "no lowering covers". Same with or without a wrapping `local()` on trunk before R7b, so not a lost answer.
- **Where:** `unrollableBodyStep` / `carriesIterationState` (`src/compiler/ir/strategies.ts`)

#### A re-sourcing `local()` in an unbounded repeat, or with a side effect, declines generically (`resource-local-unbounded`)
- **Area:** `repeat()`, re-source
- **Reach:** rare
- **Problem:** `g.V().repeat(__.local(__.coalesce(__.out('knows'), __.V().has('name','peter')))).until(__.has('name','peter')).values('name')`, and `local(coalesce(…V()…).aggregate('x'))` / `local(union(V().has(…).sideEffect(property(…)), out()))` in `times(n)`, decline with the bare "no lowering covers …" that does not name the unsupported part. Identical on the parent of R7b.
- **Fix:** Answer the walk form through the connector, or at least decline naming the re-source in an unbounded repeat body.
- **Where:** `reSourcedBody` (`src/compiler/rel/lower/scoped.ts`); `src/compiler/rel/walk.ts`

### Queries we decline: branches and nesting

#### Chained `union()` names its input once per arm (`union-chain-references`)
- **Area:** branch
- **Reach:** rare
- **Problem:** A chain of general `union()`s names its input once per arm. `union(out(),in())×16` hits the "too many references" limit.
- **Fix:** Find a one-reference spelling for arbitrary arms, like the `hopJoin` direction row.
- **Where:** `src/compiler/rel/lower/branch.ts`

#### Fan-out residue (`fan-out-residue`)
- **Area:** fan-out
- **Reach:** rare
- **Problem:** A reducer arm of a batched `union` over the one-row self declines: `g.V().local(__.union(__.count()))` (L3 `g_VX1_2X_localXunionXcountXX`). The doc also listed "reductions without fold, scalar-host group reducer, `tail`, child-label escape" with no example (verify: may have landed).
- **Fix:** Lower a reducer arm in a batched union over the self row.
- **Depends on:** compositional-coverage

#### Per-origin slice in a batched arm (`batched-arm-per-origin-slice`)
- **Area:** branch
- **Reach:** rare
- **Problem:** A per-origin slice in a batched `union`/`choose` arm, or in a bounded `repeat` body, under an outer per-origin scope declines (verify: may have landed; the named helper `mintTraverserMajor` no longer exists).
- **Fix:** Thread the arm-minted origin through the slice.
- **Where:** `src/compiler/rel/lower/branch.ts`

#### Project body inside a union arm (`union-project-group`)
- **Area:** branch
- **Reach:** rare
- **Problem:** `g.V().union(project('g').by(out().group().by(label).by(values('age').is(gt(30)).count(local))), constant(1)).count()` declines. The same project answers under `project`, `local`, `map`, `flatMap`, `optional`, `coalesce`, `where` and in a group value `by()`.
- **Fix:** Lower a project body as a union arm.

#### Typed node through the per-traverser rejoin (`typednode-rejoin`)
- **Area:** fan-out
- **Reach:** rare
- **Problem:** A body that ends on `unfold()` over a MIXED-member collection (`typedNode` framing) under `local`/`map`/`flatMap` declines at `rowResident`. Its `{t,v}` envelope is a row column, like a variant or property payload, so the rejoin can carry it unchanged.
- **Fix:** Admit the `typedNode` arm in `rowResident`. Add depth witnesses.
- **Where:** `src/compiler/rel/framing.ts` (`rowResident`)

#### Variant and property child bodies at depth (`variant-property-depth`)
- **Area:** nesting
- **Reach:** plausible
- **Problem:** These decline (verify: may have landed): a variant `map()` body under a `union` arm, under `order().by()`, in `group().by(…fold())` or before `path()`; a property body under a `union` arm, followed by `path()`/`valueMap()`/`properties()`, or in `optional(properties(…))`.
- **Fix:** Extend the connector to variant and property bodies at these positions.
- **Depends on:** compositional-coverage

#### Source union (`source-union`)
- **Area:** branch
- **Reach:** plausible
- **Problem:** Corpus forms decline: mixed arms (`g.union(V(1), constant(1))`), `g.union(constant('x')).path()`, `withSideEffect`/`withSack` sources and steps after the union. `opensOffStarter` and `unionArms` disagree (`r1101-fu4`).
- **Fix:** Make `opensOffStarter` and `unionArms` share one rule. Then extend the source union to mixed arms.
- **Where:** `opensOffStarter`; `unionArms`

#### Keyed choose reducing-arm residue (`keyed-choose-reducing-arm`)
- **Area:** branch
- **Reach:** rare
- **Problem:** These decline under `local`/`flatMap`/`map` (verify each): `local()` keyed `count()` arms beside the pass-through; a rejoin's list/variant result followed by a local op, fold/sum/where/select or `select(<outer label>)`; repeat bodies; a rejoin under `path()`. `map()` over a fan-out body needs a per-start "first" (`g_V_mapXin_hasIdX1XX_limitX2X_valuesXnameX`; verify: `g.V().map(in().hasId(1)).limit(2).values('name')` now answers).
- **Fix:** Add a per-start key to the rejoin.

#### `branch()` with one surviving option and owed order (`branch-sole-arm-owed`)
- **Area:** branch
- **Reach:** common
- **Problem:** With one surviving option and an owed emission order, `chooseOptions` declines. `g.V().branch(__.label()).option('person', __.out()).fold()` and `g.V().order().by('name').branch(label()).option('person', values('name'))` fail with the generic message. The two-arm forms answer.
- **Fix:** Move `unionArms`' owed test (`owed && !encounterOf(…)`) into `soleArm`, so both exits share one rule.
- **Where:** `src/compiler/rel/lower/branch.ts` (`soleArm`, `chooseOptions`)

#### Keyed choose and branch: other declines (`branch-step-options-residue`)
- **Area:** branch
- **Reach:** rare
- **Problem:** These decline (verify each; `where(branch(…))` and mixed reducing options now answer): `by(branch(…).fold())` and a `repeat` body; an ordering or text key over an element choice (`elementPredicate` answers only the equality family); `map`/`project().by`/`coalesce`/`optional`/`repeat` hosts; an all-discard `option(Pick.none, __.discard())`.
- **Fix:** Lower the choice and per-key flags without `Materialize` fences under a correlated child.

#### Body-keyed `choose` (`body-keyed-choose`)
- **Area:** branch
- **Reach:** rare
- **Problem:** A keyed `choose` nested in an option arm declines, and `choose(select('a'))` through an arm alias declines.
- **Fix:** Lower a keyed `choose` in an option arm.
- **Depends on:** branch-slice

#### Re-sourced body reads host state (`resourced-host-state`)
- **Area:** re-source
- **Reach:** rare
- **Problem:** `map(__.V().sack())`, `__.V().simplePath()` and `loops()` under a host decline. `rootedRead` computes the body once for every host, so `readsHostState` declines.
- **Fix:** Correlate the host state into the body as a per-host read.
- **Where:** `readsHostState`; `rootedRead`; tests `test/L4-addendum/resourced-scalar-value.feature` `@gap:resourced-host-state`

#### `choose()` with mixed list-shaped arms (`choose-mixed-list-arms`)
- **Area:** branch
- **Reach:** plausible
- **Problem:** `g.V().choose(hasLabel('person'), out().fold(), values('name').fold())` declines.
- **Fix:** Merge an element-list arm with a scalar-list arm.

#### A drawn re-source after a host-reading filter declines under `map()` (`map-draw-host-read`)
- **Area:** nesting
- **Reach:** plausible
- **Problem:** The "random OTHER person" idiom answers under `local()` but declines under `map()`: `g.V().hasLabel('person').as('p').local(__.V().hasLabel('person').where(neq('p')).sample(1)).count()` returns 4; the `map(…)` form (and `order().by(shuffle).limit(1)` in place of `sample(1)`) declines with "this V()/E() inside map(), by() or a filter, whose later steps read the incoming traverser … is not supported yet". The message is misleading, since `local()` answers the same body.
- **Fix:** Give `map`'s first-row contract the fold route `local`'s forward contract takes when the draw follows the host cut.
- **Where:** `reSourcedBody` (`src/compiler/rel/lower/scoped.ts`)

#### `local(<edge body>).otherV()` depth residue (`local-edge-otherv-depth`)
- **Area:** nesting
- **Reach:** plausible
- **Problem:** `g.V().repeat(local(outE().limit(1)).otherV()).times(2).values('name')` (and the `bothE` form) and `g.V().local(bothE().dedup()).otherV().values('name')` decline. A repeat body does not get R7's `fromV` route because `inBody` clears `needsFromV`. Not a regression: trunk before R7 declined them too.
- **Fix:** Carry `needsFromV` into a repeat body; let `dedup()` pass the edge's `fromV` channel.
- **Where:** `lowerBody`'s `fromV` and `allRows('forward')` (`src/compiler/rel/lower/scoped.ts`); `FROM_V_TRANSPARENT` (`src/compiler/rel/lower.ts`)

#### A re-source under a tracked path declines on a still step that is not on the list (`resource-path-still-steps`)
- **Area:** paths
- **Reach:** plausible
- **Problem:** Under a tracked path, `g.V().hasLabel('holder').local(__.V().hasLabel('person').hasNot('x').limit(2)).path().count()`, `g.V(1).local(__.V().hasLabel('software').hasKey('lang').limit(1)).path()` and `g.V().local(__.V().hasLabel('person').as('b').limit(1)).path()` decline with the resource-path message, while the `has('age',gt(5))` and `limit(1).as('b')` forms answer linearly. `KEEPS_POSITION` omits `hasNot`/`hasKey`/`hasValue`/`as`. Also `local(__.V().out().order().by('name')).path()` and `local(__.V().out().dedup()).path()` decline although their cost is bounded by their output. Trunk before 6a declined all of these.
- **Fix:** Take `keeps-position-authority` first; then a barrier after a move under a path declines only when it bounds (see `bounding-slices-truncates`).
- **Depends on:** `keeps-position-authority`
- **Where:** `keepsPosition` (`src/compiler/rel/lower/movement.ts`); `reSourcedBody` (`src/compiler/rel/lower/scoped.ts`)

### Queries we decline: paths, labels, side effects and match

#### `group().by(k).by(<list that may be absent>)` declines (`group-by-absent-list`)
- **Area:** group
- **Reach:** rare
- **Problem:** The ProductiveByStrategy form of `group().by(k).by(<list value that may be absent>)` declines.
- **Fix:** Make `mapNodePayload` frame a null list value. (verify: may have landed with later group() work.)
- **Where:** `mapNodePayload`

#### Path as a value (`path-as-value`)
- **Area:** paths
- **Reach:** plausible
- **Problem:** `g.V().out().path().group()` and `g.V().out().path().fold().unfold()` decline. `path().unfold()` over a path that mixes vertices and edges declines: `g.V(1).outE().inV().path().unfold()`. `pathUnfolded` serves one element kind only.
- **Fix:** Add a `{t:'path'}` arm in `frameTypedNode`/`listNodeExpr`. Give the unfolded stream a per-row element kind.
- **Depends on:** compositional-coverage
- **Where:** `src/compiler/rel/path.ts` (`pathUnfolded`); `frameTypedNode`; `listNodeExpr`

#### `group()` over a collection-valued traverser (`group-collection-key`)
- **Area:** side-effects
- **Reach:** plausible
- **Problem:** `g.inject([1,2],[3]).group().by(count(local))` and `g.V().out().fold().group().by(count(local))` decline. `g.inject([1,2],[3]).count(local)` answers `[2,1]`. The reference answer is a map like `{2:1, 1:1}`.
- **Fix:** Lower a group key `by()` over a collection traverser.

#### Side-effect constant read in a `by()` (`cr-fu12`)
- **Area:** side-effects
- **Reach:** plausible
- **Problem:** `project/group/order().by(__.select('k'))` over a `withSideEffect` constant declines, for example `g.withSideEffect('k',1).V().project('a').by(__.select('k'))`. `sideEffect(__.select('k'))` answers. A null constant under `map`/`where` declines (verify).
- **Fix:** Route the `by()`/project seam to `sideEffectSelectChild`. Add L4 coverage.

#### Labels and scope (`labels-scope`)
- **Area:** labels
- **Reach:** plausible
- **Problem:** An alias `where` under `within`/`between`/`TextP` declines: `g.V().as('a').out().as('b').where('a', within('b'))` (`r5-fu8`). `where().by()` under repeat wrappers, `P.within` or bodies, including `not(where…by)`, may still decline (`r2-gap-wb`; verify: simple forms answer).
- **Fix:** Lower alias predicates beyond `eq`/`neq`.

#### Path and property streams (`o-subpath`, `o-pathvals`, `o-propstream`)
- **Area:** paths
- **Reach:** plausible
- **Problem:** `dedup()` before `path().from()` declines: `g.V().as('a').out().dedup().path().from('a')` (`o-subpath`). A mixed `path().unfold()` declines (`o-pathvals`). The meta-property stream `g.V().properties().properties()` and `valueMap()` over a VertexProperty decline (`o-propstream`). `__.properties(k)…` as an element's `where()`/`by()` body declines at the child seam (verify).
- **Fix:** Add a third property owner kind for a Property owned by a VertexProperty. Treat a `properties` head as a movement at the child seam.
- **Depends on:** path-as-value

#### Sack residue (`o-sack`)
- **Area:** sack
- **Reach:** rare
- **Problem:** The sack merge seed, `normSack`, `withBulk(false)` and sack bodies decline.
- **Fix:** Lower the sack merge seed and `normSack`.

#### Column select inside arms (`column-select-depth`)
- **Area:** paths
- **Reach:** rare
- **Problem:** `g.V().out().path().select(Column.keys)` declines. Multi-key select inside arms, `values('m').select(k)` over a Map-capable scalar and federate tails beyond values/count/order may also decline (verify).
- **Fix:** Lower `select(Column)` over path and map rows.

#### `V(<traversal>)` then `path()` (`v-lookup-path`)
- **Area:** paths
- **Reach:** rare
- **Problem:** A `path()` after a `V(<traversal>)` lookup declines: `g.V(1).V(__.out().id()).path()`. Other hosts now answer.
- **Fix:** Extend the path channel across the lookup.
- **Depends on:** path-as-value

#### Path after a nested count host (`nested-host-path`)
- **Area:** paths
- **Reach:** rare
- **Problem:** `g.V().local(__.out().local(__.out().count())).path()` declines. Other nested per-traverser host forms now answer.
- **Fix:** Carry the path channel through the nested rejoin.
- **Depends on:** path-as-value

#### `match()` residue (`match-residue`)
- **Area:** match
- **Reach:** rare
- **Problem:** These decline: a `local(<reducer>)` pattern body (`local` forwards a fresh traverser with no binding; `map(<reducer>)` binds); a `fold()` end; ProductiveByStrategy null-keeping; `where('a',P)` over scalar aliases or non-eq ops; a per-origin slice in a pattern body; `match` over a map stream (`g.V().valueMap().match(as('a').select('name').as('b'))`); `concat(constant(…), select('b').by('name'))`. Verify each.
- **Fix:** Handle each shape in the match lowering.

#### Keyed-label seeded merge (`keyed-label-seeded-merge`)
- **Area:** side-effects
- **Reach:** rare
- **Problem:** `g.withSideEffect('a',[x:1]).V().group('a').by(label).cap('a')` declines.
- **Fix:** Add a per-key `GroupBiOperator` merge.
- **Where:** `src/compiler/rel/collection.ts` (`registerGrouping`)

#### A keyed `group('a')` in a `coalesce` or `union` arm (`keyed-group-arm-hosts`)
- **Area:** side-effects
- **Reach:** plausible
- **Problem:** `g.V().coalesce(out('created').group('a').by('name').by(count()), constant(0)).cap('a')` and `g.V().union(group('a').by(label).by(values('age').sum()), out()).cap('a')` decline with "no lowering covers …". The same keyed site answers under `union` (with `by(count())`), `choose`, `optional`, `where`, `local` and `repeat`. Found by G1's review; pre-existing.
- **Fix:** Admit a keyed group side effect in a `coalesce` arm, and a `by(sum)` reducer in a `union` arm, through the connector's arm hosts.
- **Where:** `src/compiler/rel/lower/scoped.ts` (`CONNECTORS`); `src/compiler/rel/collection.ts`

### Queries we decline: values, lists and maps

#### Property-host `group().by(k).by(<pre>.sum())` declines (`pooled-recipe-split`)
- **Area:** collections
- **Reach:** plausible
- **Problem:** Since R5.5 (f2b0fc72), this form declines at a property host. `by(count())` takes groupCount's counting rows at every host (`countsTraversers`, `map.ts`). `sum`/`min`/`max` and a pre-body `by(out().count())` are splittable, but the counting recipe has no contribution column for them.
- **Fix:** Add a contribution column for `sum`/`min`/`max`. Let them union across sites too, and retire `POOLED_RECIPE`.
- **Where:** `src/compiler/rel/map.ts` (`countsTraversers`)

#### Grouping depth gaps (`group-depth-gaps`)
- **Area:** collections
- **Reach:** rare
- **Problem:** Each of these declines cleanly:
  - `group().by(label).by(optional(values('age')))`, `.by(properties('name'))`.
  - A `group()` as a `choose()` arm. Two keyed `group('m')`/`group('n')` sites.
  - A `union` whose arms produce maps: `union(group().by(label), constant(1))`.
  - `properties().group().by(key).by(value().fold())`, and `group('a')…cap('a')` over a property host. The property host has no CONNECTORS row. Extend `reductionHost` to the property framing.
  - Grouping over a map or path row: `project(…).group().by(select('l'))`, `valueMap().group()…`.
  - A keyed pooled group in `coalesce`, in `repeat`, after `outV()`, or with a raising `max()`/`mean()`/`sum()` value in an arm, body or second site.
  - Mixed member layouts: `where(out().group('a')…)` plus a root site.
  - Keyed `group('a').by(k).by(count())` at a branch-arm site on a non-vertex host: `g.E().union(group('a').by(label).by(count()), inV()).cap('a')`, `coalesce(out().group('a')…, constant('x'))`.
  - `union(limit(k).fold(), count())` after `values`/`project`/`valueMap`.
  - `aggregate('a').local(union(select('a').count(local), constant(0L)).sum())`.
  - A reducer inside a `coalesce` arm: `coalesce(out().map(out().count()), constant(0L)).sum()`.
- **Fix:** Lower each shape. Two sites with different recipes decline with only "no lowering covers". Make that message say that two sites must be one grouping.

#### Exact decimal arithmetic (`exact-decimal`)
- **Area:** numbers
- **Reach:** rare
- **Problem:** `g.inject(1.5m, 2).sum()` declines: decimal TEXT values cannot go through SQL `sum`. `fold(seed, Operator.x)` declines for classes other than int, long and double.
- **Fix:** Add an exact decimal reducer.

#### Parameter bound in a drawn per-origin slice (`param-draw-slice`)
- **Area:** slices
- **Reach:** plausible
- **Problem:** `g.V().hasLabel('software').local(__.V().hasLabel('person').order().by(shuffle).limit(x))` with `{x: 2}` declines with the shared-draw message. The literal `limit(2)` answers, and so does `local(out().limit(x))`. Only `x = 1` answers, through `shuffleCutToSample`. A parameterised limit is the normal TinkerPop 4 idiom.
- **Fix:** In the per-origin window's bound path, bind the count, or reduce it at plan time as `unrollFixedRepeat` does.
- **Where:** `src/compiler/rel/lower/slice.ts` (`sliceParamNames(step).some(…) → null`); `src/compiler/ir/shuffle-cut.ts`

#### `count(local)` over an element (`element-count-local`)
- **Area:** reducers
- **Reach:** plausible
- **Problem:** `g.V().out().count(local)` declines. So `g.V().group().by(label).by(out().count(local))` declines too. The reference answer is `{person:1, software:1}`: an element's `count(local)` is 1, and the group uses `Operator.assign`.
- **Fix:** Fix the step's own lowering. The group value `by()` then follows.

#### `project()` then `select(keys|values)` (`project-select-column`)
- **Area:** maps
- **Reach:** plausible
- **Problem:** `g.V().project('a','b').by('name').by('age').select(keys)` and `….select(values)` decline. Other `project()` `by()` bodies now answer.
- **Fix:** Lower `select(Column)` over a record. Extend the record seam generically, not per shape.
- **Where:** `bun scripts/rel-blockers.ts --step project`

#### `math()` over a Map's own keys (`cr-fu10`)
- **Area:** maps
- **Reach:** rare
- **Problem:** `g.V().has('name','marko').values('m').math('k + a')` declines. An older trunk answered `[3]`.
- **Fix:** Keep the map-entry read when no outer scope names the variable (`vendor/tinkerpop/gremlin-core/.../Scoping.java:119-135`).

#### Set operations lose member types (`o-setop-types`)
- **Area:** lists
- **Reach:** rare
- **Problem:** Set operations lose member types (verify: may have landed; a string intersect answers).
- **Fix:** Carry the member type tag through `listSetOp`.
- **Depends on:** typed-value-carrier

#### Global `order()` over element lists (`o-order-elemlist`)
- **Area:** lists
- **Reach:** rare
- **Problem:** Global `order()` over a stream of element lists declines (verify: `g.V().out().fold().order()` answers).
- **Fix:** Add an orderability key for element lists.

#### Local `split()` (`o-split`)
- **Area:** strings
- **Reach:** rare
- **Problem:** `split()` over a list or inside a body declines.
- **Fix:** Lower `split()` as a per-member function.
- **Depends on:** value-barrier-channels

#### Set literal in `inject()` (`inject-set-literal`) (was `r6-fu2-r`)
- **Area:** lists
- **Reach:** rare
- **Problem:** `g.inject({1,1})` declines. A keyed `select(traversal)` over injected values declines too.
- **Fix:** Frame a set literal at the inject source.

#### Set op with an element-list operand (`o-setop-mixed`)
- **Area:** lists
- **Reach:** rare
- **Problem:** `combine`/`merge`/`disjunct`/`product` between a scalar-membered list and an element-list operand declines: `g.V().values('name').combine(V().fold())`. This covers the four `g_V_valuesXnameX_{combine,merge,disjunct,product}XV_foldX` scenarios. The reference raises per row; that raise is unreachable until a list row can frame both kinds.
- **Fix:** Add a mixed scalar/element member encoding in `listSetOp`.
- **Where:** `src/compiler/rel/list.ts` (`listSetOp`)

#### Per-row list function residue (`list-function-residue`)
- **Area:** lists
- **Reach:** plausible
- **Problem:** These decline (verify each; element-host forms such as `map(values('tags').intersect(…))` now lower): a correlated operand (`__.select('a')…`); `merge()` whose operand is not provably a List; `merge([y:2])` over a map-valued property; a `union` that mixes list functions or a constant arm; `filter`/`not(intersect([…]).unfold())`; scalar-host `map`/`local`/`flatMap`/`coalesce`/`repeat` bodies; lists of lists (`values('nested').intersect([['a']])`); a set op over a fold inside `project/group().by()` or a branch host.
- **Fix:** Extend `perRowListFunction` to these hosts. The uncorrelated operand spool already composes; the host seam does not.
- **Where:** `perRowListFunction`; `src/compiler/rel/list.ts`

#### Edge properties beyond the stream (`edge-property-stream`)
- **Area:** properties
- **Reach:** plausible
- **Problem:** `g.E().properties('weight').fold()` and `….path()` decline. So do `aggregate().cap()`, `as().select()`, `project().by(properties())`, `sideEffect()` and branch arms over edge properties.
- **Fix:** Frame them through the `Shape`/node-tag owner discriminant.

#### MAP retype then a barrier (`map-retype-barrier`)
- **Area:** maps
- **Reach:** rare
- **Problem:** After `is(typeOf(MAP))`, a barrier declines: `g.V().values('m').is(typeOf(GType.MAP)).groupCount()`. Also `where(count(local)…)`, `order().by(count(local)|select('a'))`, `aggregate('x').cap('x')` (verify), and the mixed-element meet `g.V().union(outE(), out()).is(typeOf(GType.VERTEX))`.
- **Fix:** Carry the retyped framing into the barrier lowering.

#### `merge()` hosts and operands (`merge-step-hosts`)
- **Area:** maps
- **Reach:** rare
- **Problem:** `project(…).merge([…]).order().by(select('n'))` and `…merge(…).project('z').by(select('n'))` decline: the record becomes a map, and `mapTail` has no `order().by(select)` or `project().by(select)`. Also: `merge(__.project('a2').by(select('a')))`; `merge(__.select('n'))` (should raise not-a-Map); `groupCount().by('age').merge([29i:100L])`.
- **Fix:** Add `order().by(select)` and `project().by(select)` to `mapTail`. Fix `mapMerge`'s docblock: `merge($param)` is not reachable, because `Gremlin.g4:711-712` `traversalMethod_merge` takes `genericLiteral` only.
- **Where:** `mapTail`; `mapMerge`

#### Binary in more steps (`binary-steps`)
- **Area:** values
- **Reach:** rare
- **Problem:** `values('blob').asBool()`, `local(fold()).unfold()` and `optional(values('blob')).is(typeOf(BINARY))` over a binary decline. They should raise by class, as `asNumber` does.
- **Fix:** Raise by class in each step.

#### Families ranked by `rel-blockers` (`rel-blocker-families`)
- **Area:** mixed
- **Reach:** plausible
- **Problem:** The remaining L3 decline families: scalar-transform tail; Column/path row ops; `select()` over `Pop.all`/`Pop.mixed`, Column and traversal keys; side effects (`group('m').by().by(__.in().values())`); local/match/where; the single-missing-caller list.
- **Fix:** Rank by `mise run rel-blockers`. Fix the top family generically.

#### `is(typeOf(LIST|SET))` over a list framing (`typeof-list-framing`)
- **Area:** types
- **Reach:** rare
- **Problem:** `g.V().fold().is(typeOf(GType.LIST))`, `g.V().aggregate('x').cap('x').is(typeOf(GType.SET))` and `inject(['t']).is(typeOf(GType.LIST))` decline. A list framing does not name its GType. `cap()` of an undeclared `aggregate`/`store` frames a `BulkSet` (a SET) as a list.
- **Fix:** Make the list framing carry its GType (List, Set or BulkSet) from every producer. Do not derive it from today's marker: that answers `cap('x').is(typeOf(LIST))` true. The two `…_groupCount` witnesses also need `groupCount()` keyed by a collection.
- **Where:** `typeOfExpr`; `framingTypeOf`

#### Local Map order goes through `mapEntriesLocal` (`map-order-local`)
- **Area:** local order over a Map
- **Reach:** plausible
- **Problem:** Bare `order(local)` and `order(local).by(keys|values)` over a Map use a JS orderability barrier. `g.V().map(valueMap('name','age').order(Scope.local))` declines. Top-level and per-row Maps have two order authorities (the §2 map-key-order-authority question).
- **Fix:** Move these into `mapEntriesLocal`, which takes the `EntryComparator` list (`$[0]`/`$[1]`, asc/desc). About 20 lines of barrier go. Answers change only for maps with mixed-type keys; add one §17 line.
- **Where:** `src/compiler/rel/order-dedup-local.ts` `buildOrderDedupSegment` (`op === 'order'` arm), `entryComparators`; `src/compiler/rel/orderability.ts` `orderMapLocalValue`; `src/compiler/rel/map.ts` `mapEntriesLocal`

#### The record-local branch recognizes steps via `collectionReaderOf` (`record-local-reader`)
- **Area:** local steps over a record
- **Reach:** plausible
- **Problem:** `continueAs`'s record host tests count, slice and merge by hand before `recordToMap → mapTail`. `project(…).dedup(Scope.local)` and `local(project(…).order(Scope.local))` decline.
- **Fix:** Reuse `collectionReaderOf`, so both shapes lower as inline SQL. The same `storedCompareOn` caveat applies as in `map-order-local`.
- **Depends on:** `map-order-local`
- **Where:** `src/compiler/rel/lower.ts` `continueAs`

### Queries we decline: filters and predicates

#### Element-valued operand in a value comparison (`element-operand-compare`)
- **Area:** predicates
- **Reach:** rare
- **Problem:** `has(k, <body yielding an element>)`, that is `P.eq(traversal)`, declines: `g.V().has('name', __.identity())`. L3 `g_V_hasXname_notXidentityXX`. The operand route takes only scalar-producing bodies.
- **Fix:** Admit element-producing bodies in the operand route.
- **Where:** `nestedFirstValue`; `scalarChild`

#### `discard()` before a reducer (`discard-then-reduce`)
- **Area:** filters
- **Reach:** rare
- **Problem:** `g.V().discard().sum()` declines, while `values('age').discard().sum()` answers `[]`. `fold().discard()` and `valueMap()/elementMap()/path()` plus `where(identity())` may decline too (verify).
- **Fix:** Lower a constant-empty stream before a reducer for every stream kind.

#### `hasLabel(P)` (`haslabel-predicate`)
- **Area:** predicates
- **Reach:** common
- **Problem:** `g.V().hasLabel(within('person','software'))`, `hasLabel(P.eq('person'))` and `g.E().hasLabel(within('knows','created'))` decline. `hasLabel('person','software')` answers. The grammar is legal TinkerPop 4.
- **Fix:** Route a `P` through the existing label predicate.

### Queries we decline: sources and movement

#### `inject(xs).unfold()` declines for nested or mixed members (`inject-unfold-nested`)
- **Area:** inject
- **Reach:** plausible
- **Problem:** `inject(xs).unfold()` declines at any size when `xs` is a list of lists, Maps, a Set, Dates or BigInts, or mixed types. So `inject($rows).unfold().select('age')` and `inject(xs).unfold().as('n').addV('person').property('name', select('n'))` decline. The 2 MB split is therefore exercised only for scalar lists and maps.
- **Fix:** Build it at the same seam as R8-res's "a list parameter of Maps".
- **Depends on:** R8-res
- **Where:** `listLiteralBlob`

#### Mid-chain `inject` (`inject-mid-chain`)
- **Area:** inject
- **Reach:** plausible
- **Problem:** `inject` past an element or collection stream declines: `g.V(1).out().inject(7).path()`, `g.V().as('a').inject(1).select('a')`, `g.V(1).as('a').out().inject(1).select('a')`, `g.withSack(1).V().inject(5).sack()`, `g.V().values('age').fold().inject([1])`, `project('a').by('age').inject([a:1])`, `valueMap().inject([…])`, `out().path().inject(1)`. In `mergeArms`, list arms whose `of` differs and computed-map arms do not merge.
- **Fix:** Merge these arm shapes in `mergeArms`. Make `injectTail`'s alias reset read `addsUnlabelledTraversers`, so the two cannot drift.
- **Where:** `src/compiler/rel/lower.ts` (`injectTail`, `mergeArms`); `src/compiler/ir/labels.ts` (`addsUnlabelledTraversers`)

#### A weighted `sample()` followed by `otherV()` (`weighted-sample-otherv`)
- **Area:** movement
- **Reach:** plausible
- **Problem:** `g.V(1).bothE().sample(1).by('weight').otherV().count()` (a weighted random walk) declines with the generic "no lowering covers …", which does not say that the weighted sample before `otherV()` is the unsupported part. The unweighted form answers since 6d(a) (d5ce03e2).
- **Fix:** Let the weighted per-origin draw carry the edge's `fromV` as `perOriginWindow` does; until then, name the shape in the decline.
- **Where:** `FROM_V_TRANSPARENT`, `edgeFeedsOtherV` (`src/compiler/rel/lower.ts`); the weighted draw in `src/compiler/rel/lower/reduction.ts`

#### A one-row host hidden by a join or a list round-trip (`single-row-host-bounds`)
- **Area:** writes
- **Reach:** plausible
- **Problem:** `g.E().sample(1).outV().addE('likes').to(__.V().hasLabel('software').sample(1))` and `g.V().sample(1).fold().unfold().addE('x').to(__.V().sample(1))` decline with the shared-draw message although the host is one row. `rowBounds` does not see through an edge→vertex lookup join or the unfold of a one-row fold.
- **Fix:** In `boundsOf`: a lookup join to a unique key keeps the other side's bound; an unfold of a one-row fold of a one-row input is bounded by the list. Not in `rowNumberCap`.
- **Where:** `src/rel/bounds.ts` (`boundsOf`); `rootedHosts` (`src/compiler/rel/lower/reduction.ts`)

### Queries we decline: federation, services and io

#### Federate `has(k, select(label))` that ends in a value declines (`fed-mapvalue-bare-error`)
- **Area:** federate
- **Reach:** rare
- **Problem:** `mapValueElem` raises `UnsupportedTraversal` for a sub-traversal with a value terminal. The query does not get an answer.
- **Fix:** Answer it with a per-parent value-map landing.
- **Where:** `src/compiler/rel/segment.ts` (`mapValueElem`)

#### Federate explicit traversal with an outer parameter (`rf3-fed-explicit-params`)
- **Area:** federate
- **Reach:** rare
- **Problem:** An explicit federate `traversal` that references an outer user parameter fails with "Unbound parameter" (verify: `federate.ts` now forwards `boundParams` under pushdown).
- **Fix:** Forward `boundParams` in both forms.
- **Where:** `src/services/catalog/federate.ts`

#### `call('--list')` answers an empty listing (`directory-empty`)
- **Area:** services catalog
- **Reach:** rare
- **Problem:** `scalarStrings` returns null, which becomes `UnsupportedTraversal`, when the service filter matches nothing. `Values([])` cannot be represented. The decline depends on registry contents, not on query text. This changes behaviour.
- **Fix:** Build the rows as one exploded JSON array. An empty array is a zero-row relation. `call('--list',[service:'nope'])` returns `[]`.
- **Where:** `src/services/catalog/directory.ts` `scalarStrings`

### Queries we decline: compiler internals

#### Mid-traversal `V().has(k, select('e'))` declines under most hosts (`midtraversal-v-select-hosts`)
- **Area:** semijoin
- **Reach:** plausible
- **Problem:** The shape answers on the spine, in `local()`, in `project()/group().by()` and in `union()` arms. It declines in `coalesce`/`optional`/`filter`/`where`/`map`/`flatMap`/`repeat` bodies, after `simplePath()`, and for `has('name', neq(select('e')))`.
- **Fix:** Lower a mid-traversal `V()` in those hosts. The seek then applies through `rewriteRels`. Re-probe after §3.8 (nested child body).
- **Depends on:** §3.8 nested child body

#### Unroll advice comes from a hand-written host list (`expansion-decline-hosts`)
- **Area:** compile
- **Reach:** plausible
- **Problem:** `noteUnrolled` is called at about 10 sites. Sites that miss it give generic advice ("its steps fuse into one join per step — split it") and do not name `repeat(…).times(70)`. Reported misses: `by()` modulators and `branch()`, e.g. `g.V().project('a').by(repeat(out()).times(70).count())`, `order().by(…)`. (verify: connector hosts now note through `scopedHost`; `order().by()` may still miss.)
- **Fix:** Note the unroll host-less at the shared child-body reader (`bodyOf`/`childSeam`, given `ctx.budget`). Spliced steps already carry `IRStep.unrolled`. Only map-like hosts add their own name to the advice. Then a new host cannot miss it.
- **Where:** `noteUnrolled` in `src/compiler/rel/lower/chain.ts`; `scopedHost` in `src/compiler/rel/lower/scoped.ts`

#### Root `repeat()` text-cap decline has no cause (`root-repeat-cap-cause`)
- **Area:** compile
- **Reach:** plausible
- **Problem:** Under `CfLimitedSql`, `g.V().repeat(out()).times(1000).count()` (and `.path()`) says "statement too long … about 139 KB" with no cause or remedy. Before, it named a large `times()` as the usual cause.
- **Fix:** Pass the plan's `UnrollNote` to the catch at the execute site. Reuse `unrollAdvice` (`src/compiler/compiler.ts`). Update the test that pins the cause-free text.
- **Where:** `test/compiler/repeat-unroll-boundary.exec.test.ts` (~line 580)

#### Decline-message accuracy (`decline-message-accuracy`)
- **Area:** compile
- **Reach:** plausible
- **Problem:** Several decline messages are inaccurate:
  - (a) `statementShapeDecline` (`src/storage.ts`) measures size and literal share in UTF-16 units. DO's 100 KB cap is in UTF-8. Use `utf8Bytes` (`src/do-limits.ts`).
  - (b) `literalTextHint` (`src/sql/kernel/budget.ts`) always says "send the values in smaller batches". For one large literal, say "send it as a parameter".
  - (c) `valuePastPlatformCap('computed')` (`src/rel/raise.ts`) ends "…or leave it unfolded". Say "do not fold() it".
  - (d) `g.V().repeat(out().dedup()).until(loops().is(20000)).count()` and `repeat(both().dedup()).times(70)` say "no lowering covers". The `pastBudget` rethrow covers child bodies, not the root barrier-body path (`src/compiler/ir/strategies.ts`).
  - (e) A federate decline for `….call('federate',['graph':'x','traversal':__.V().has('name', select('e')).values('age')])` quotes the internal rewrite `g.inject(injectedMap).unfold().group()…`. Quote the user's traversal.
  - (f) `JoinWidthExceeded` and `CompileBudgetExceeded` start with "not supported yet" (`UnsupportedTraversal.because`). That promises a fix for a permanent SQLite limit. Reword.
- **Fix:** Make each change listed above.

#### Clean-decline depth gaps from the ladder retirement (`ladder-depth-gaps`)
- **Area:** compile
- **Reach:** rare
- **Problem:**
  - Every "N8 additions" list from rounds 1–6.
  - `g.V().as('a').mergeV(project('name').by(select('a').values('name')))` declines in every mode.
  - `g.V().coin(1.0).count()` and `coin(0.0).count()` decline.
- **Fix:** Lower each shape through the connector.

#### Strategies residue (`strategies-residue`)
- **Area:** compiler
- **Reach:** plausible
- **Problem:** **Strategies** residue is the largest L3 decline cluster. No rule exists yet for `SubgraphStrategy(vertexProperties:)`, `includeMetaProperties`, or ProductiveByStrategy on a non-standard host. No rule wraps a strategy criterion around a mutation.
- **Fix:** Add one rule per strategy in the strategy pass. Use the L3 telemetry sizes to order the work.
- **Where:** `src/compiler/ir/strategies.ts`

#### Step vocabulary residue (`step-vocabulary`)
- **Area:** compiler
- **Reach:** plausible
- **Problem:** **Step vocabulary (matrix-fill).** `tree` residue: the side-effect form `tree('a')` with `cap`, any step after `tree()`, and `is(typeOf(GType.TREE))`. Other gaps: `subgraph('sg')`, `withSack(seed, Operator)`, string steps inside `repeat`, and null carriage under `path()`. Mutation-guard outcomes (`ReadOnlyStrategy`) do not reject as the reference does.
- **Fix:** Fill each step in the matrix. Reject `ReadOnlyStrategy` mutations as the reference does. The L3 telemetry gives the size of each gap.
- **Where:** `docs/feature-support-matrix.md`

#### Two arity vocabularies (`arity-one-authority`)
- **Area:** compiler
- **Reach:** plausible
- **Problem:** `atMostOnePerTraverser` (a hand recursion over named hosts beside `rowBounds`/`atMostOneRow`) was deleted with the ladder (R7, 2026-11-20), so `rowBounds` is the one arity authority. `g.V().map(__.coalesce(__.out('knows').count().is(P.gt(0)), __.constant(-1L)))` still declines (re-probed after R7): `rowBounds` cannot see a `choose`'s/`coalesce`'s disjoint gates.
- **Fix:** Keep it in step with `ONE_TO_ONE`. See the KEEPS_ONE proposal under "Next round".
- **Where:** `src/rel/bounds.ts`

### Queries we decline: other

#### Re-probe parked `V(<traversal>)` items against nested child bodies (`nested-child-reprobe`)
- **Area:** child bodies (§3.8)
- **Reach:** plausible
- **Problem:** A per-traverser child body inside a child body now lowers (`nestedHostChild`, `bodyScopesPerOrigin`, `nestRowOrigin`). Items that were parked for `V(<traversal>)` under `where`/`filter`/`coalesce`/`optional`/`repeat` were not re-probed.
- **Fix:** Re-probe each parked item. Do not add a special case for a `V(<traversal>)` host.
- **Where:** `src/compiler/rel/lower/reduction.ts` `nestedHostChild`, `flatMapRejoin`

## 4. Shared substrate

Building blocks that unblock many other items. Do these before the items that depend on them.

### Shared substrate: writes

#### A write inside a child or multi-arm body (`s3-write-in-child`) (new id; was "S3")
- **Area:** writes
- **Reach:** common
- **Problem:** A write inside `local`/`map`/`flatMap`/`union`/`coalesce`/`optional`/`choose`/`repeat`/`sideEffect`/`where` or an onMatch body declines. This blocks the upsert idiom `fold().coalesce(unfold(), addV(…))`, `g.V().local(__.mergeV([name:'x']))`, corpus `coalesce(E()…, addE(…))` and onMatch `sideEffect(…drop())` (`r6-m-oncreate`). Writes after path/fold/sack and source-union starter-arm writes come next. `g.V().addE('x').to(__.V().sample(1))` declines with the shared-draw reason (`nr-fu-addE-draw`).
- **Fix:** Lower a write in a child body. Then do writes after path/fold/sack and the source-union starter arms.

### Shared substrate: repeat

#### `repeat()` residue (`repeat-residue`)
- **Area:** repeat
- **Reach:** plausible
- **Problem:** These decline: an unbounded body whose UNION is not the top node (needs join-union distribution); the UNORDERED bulked slice; `times($x)` lowered as a walk. The emit-unroll frontier is §1b `emit-unroll-frontier`; its byte estimate is about 10× low for fan-out bodies.
- **Fix:** Distribute a join over a union in the recursive term. Handle the remaining shapes one by one.
- **Where:** `src/rel/recursive.ts`; `src/compiler/ir/strategies.ts`

### Shared substrate: branches and nesting

#### Compositional coverage (`compositional-coverage`)
- **Area:** nesting
- **Reach:** common
- **Problem:** Declines rise with nesting depth (measured 6% → 28% → 71% → 88%). The correlated-scalar ladder still owns some nested shapes.
- **Fix:** Committed direction (owner, 2026-11-16). Finish general decorrelation through the scoped-relation connector and make the ladder a measured fast path. `alias-channels-child-seam`, `list-members`, `fan-out-residue`, `branch-slice` and `path-as-value` are expected to fall out of it.
- **Where:** `docs/2026-11-15-compositional-coverage-plan.md`; `docs/2026-11-16-ladder-retirement-plan.md`

#### Branch and slice (`branch-slice`)
- **Area:** branch
- **Reach:** plausible
- **Problem:** About 10 scenarios decline: a MAP/RECORD/PATH/PROPERTY variant arm, a batched `choose`, an alias through a collapsed arm, a nested branch in a sliced arm.
- **Fix:** Extend the branch merge to these arm shapes.
- **Depends on:** compositional-coverage

### Shared substrate: paths, labels, side effects and match

#### Alias channels through `childSeam` (`alias-channels-child-seam`) (was "G")
- **Area:** labels
- **Reach:** plausible
- **Problem:** Nested arms do not see label scope. The aliases family had 10 open scenarios (verify the count with `mise run rel-blockers`).
- **Fix:** Carry label scope into nested arms through `childSeam`.
- **Depends on:** compositional-coverage

### Shared substrate: values, lists and maps

#### Typed value carrier (`typed-value-carrier`)
- **Area:** values
- **Reach:** common
- **Problem:** `PresentWhen` is a side channel for presence, beside the value. Null and NaN handling differ between chain and child because of it. `PresentWhen` is still in `src/compiler/rel/child.ts` and `src/compiler/rel/lower/scoped.ts`.
- **Fix:** Owner decision (2026-11-05): a typed value is one carrier, with a total per-row type tag. NaN uses the same carrier. Build the plan as written (P1 is done; T1–T8 remain). It absorbs `r4-fu4`, `rf3-project-null-label`, `S9.9`, `rf3-static-null-is`, the null-bound branch label and the NaN wall.
- **Where:** `docs/2026-11-05-typed-value-carrier-plan.md`

#### Closed per-row node vocabulary (`per-row-node-vocabulary-closed`)
- **Area:** values
- **Reach:** plausible
- **Problem:** Some per-row scalar shapes have no `{t,v}` node and no framing arm. So `g.V().values('m').unfold()` and `format()` over a value that may be a Map decline (`per-row-unfold-entry-node`).
- **Fix:** Give every per-row scalar shape a node and a framing arm. A Map.Entry is `{t:'entry'}`, as `execute.ts` `mapEntry` frames it. Element nodes carry their id. An unreadable arm raises through `src/rel/raise.ts`.
- **Where:** `src/execute.ts` (`mapEntry`); `src/rel/raise.ts`

#### Map shape (`map-shape`)
- **Area:** maps
- **Reach:** plausible
- **Problem:** About 9 scenarios decline on map shape: a map-valued `g.union(select('map'),…)` source, seeded `fold([:], addAll)`, a merge map operand and a T-token key.
- **Fix:** Extend the map framing to these producers.

#### List members (`list-members`)
- **Area:** lists
- **Reach:** plausible
- **Problem:** These decline: `fold().as('m').mergeV(select('m').limit(local,1).unfold())`; `is(P)`/`order()` in a correlated list-member body; `order`/`range(local)` over a list of maps, a PROPERTY list or a MIXED list; `select()` in a list-host body.
- **Fix:** Extend the list-member body lowering. Decide the bind budget for `is(P)`/`order()` in a correlated body.
- **Depends on:** compositional-coverage

#### Value carriage (`value-carriage`)
- **Area:** values
- **Reach:** plausible
- **Problem:** Exact scalar types are lost through JSON-backed collections, member variants, maps, aliases, paths and format adapters. `by(sum/mean/…)` works in `group` only, not in `project`/`aggregate`/`store`/`where`.
- **Fix:** Carry the child reducer's type (`produced.vtype`) and productivity through every seam.
- **Depends on:** typed-value-carrier

#### Value barriers carry the traverser's channels (`value-barrier-channels`)
- **Area:** values
- **Reach:** plausible
- **Problem:** `split()`, regex and `lowerValueResume` re-root the stream. A label, path or sack bound before them declines.
- **Fix:** Carry labels, path and sack across the value barrier. After that, spike exact big-number predicates (REAL-band prefilter plus JS BigInt compare). The owner deferred the spike.
- **Where:** `lowerValueResume`

### Shared substrate: sources and movement

#### Liveness drops a dead carrier before a hop (`S2`)
- **Area:** compile, movement
- **Reach:** plausible
- **Problem:** A computed carrier that no step reads stays alive. Examples: an unused `as()` inside an `optional()` arm, a `path()` under `count()`. The live carrier makes `copyRepeatsWork` pick the one-read `both()` form, which is 10–28% slower for these shapes.
- **Fix:** Make alias/path liveness drop a dead channel before the hop. Then these shapes lose the computed column and use two seeks again. Separately, `optional(out().as('x').both().where(neq('x'))).count()` reads its carrier and is still 15% slower in the one-read form; measure a refinement for it.
- **Where:** `src/rel/copies.ts` (`copyRepeatsWork`, `copiedWork`); `hopJoin` in `src/compiler/rel/lower/movement.ts`

### Shared substrate: tests, tooling and docs

#### `CfLimitedSql` does not check expression depth (`cf-limits-depth`)
- **Area:** tooling
- **Reach:** plausible
- **Problem:** Each unrolled `order().by().limit()` phase nests about 18 levels of SQLite expression depth. If DO's cap is 100, `repeat(out().order().by('k').limit(5)).times(6)` declines on DO only. `CfLimitedSql` checks bytes and binds, but not depth.
- **Fix:** Find DO's expression-depth cap. Teach `CfLimitedSql` to check depth so CI sees the wall.
- **Where:** `src/cf-limits.ts`

### Shared substrate: compiler internals

#### Selectivity fact or decorrelated value join (`S1`)
- **Area:** semijoin
- **Reach:** common
- **Problem:** `semijoin.ts` picks an access path by fixed priority ("label/id beats value", "constant beats correlated"). Selectivity must decide instead. One gap causes several quadratic shapes: the labelled value join `has('person','name',select('e'))` (905 ms at 1k, 57.8 s at 8k), `has(label, k, select(e))`, and a low-cardinality constant beside a correlated seek.
- **Fix:** DO has no bounded `ANALYZE`, so use decorrelation. Join the outer values against one materialized `(owner, value)` relation (RelIR plan `flatten` §4). Then neither side drives quadratically. The labelled join is the U4 keyed join with the label set as the constant side.
- **Where:** `src/rel/passes/semijoin.ts` (`keyedJoin`, `narrowFilter`)
- Note: overlaps the labelled-value-join residue under r7-fu3 in §1b. Merge.

#### Correlated-subtree sharing (`correlated-subtree-sharing`)
- **Area:** compile
- **Reach:** plausible
- **Problem:** The naming pass cannot hoist a correlated shared subtree, because a correlated body is not a relation of its own. So the emitter inlines the body at every use.
- **Fix:** Make a correlated body a relation of its own (the tree-Plan promotion). This is the prerequisite for `spine-cut-hosts`.
- **Where:** `src/rel/passes/name.ts`

#### Merge search seeks are hand-built (`merge-seeks-to-semijoin`)
- **Area:** compiler
- **Reach:** plausible
- **Problem:** The merge search builds its seeks by hand: `seekedSearch`, `propertySeeks`, `decimalTextSeeks`, `endpointSeek`, and `cappedCount`'s per-driver choice. Other per-row property searches do not get the most-selective-key and decimal-TEXT-prefix access paths.
- **Fix:** Move the seeks into a correlated-join `OwnerSeek` that chooses a seek per outer row over the finished algebra. `semijoin.ts` now seeks per outer row (`narrowFilter`), so this is unblocked. The same multi-key `OwnerSeek` was the fix for the 19× two-pool merge guard (verify: the two-pool grid measures linear, see `merge-guard-containment`).
- **Where:** `src/compiler/rel/write.ts` `seekedSearch`, `propertySeeks`, `decimalTextSeeks`, `endpointSeek`; `src/rel/passes/semijoin.ts`

### Shared substrate: other

#### One table per row-changing reference strategy (`strategy-row-tables`) (was "H")
- **Area:** strategies
- **Reach:** plausible
- **Problem:** Row-changing reference strategies are not each recorded as a table that cites the vendor source.
- **Fix:** Add one table per row-changing strategy in `src/compiler/ir/`, citing vendor lines, as `src/compiler/ir/bulk.ts` does. Do not add one for a strategy that only changes execution order.
- **Where:** `src/compiler/ir/`

## 5. Product capabilities

New user-facing capabilities outside the Gremlin language.

#### `property(T.label)` on an existing element (`label-append`)
- **Area:** writes
- **Reach:** rare
- **Problem:** `g.V(1).property(T.label,'x')` declines.
- **Fix:** Future work. The debt item for `T.id` is related.

#### Federate residue (`federate-residue`)
- **Area:** federation
- **Reach:** plausible
- **Problem:** Independent sibling RPCs (federate and `io()`) run one after another. Arms at mid-position or inside a nested prefix are not covered. Phase 2b cross-graph identity (`group().by(id)`, `has(T.id, <cross-graph>)`) is open. Phase 3b post-merge reads (`hasLabel`/`has(key)`, live `out`/`in`, a mix of bound and base element reads) are open.
- **Fix:** Run independent sibling RPCs concurrently. Then cover the arm positions, Phase 2b and Phase 3b. Side-effect-boundary widening is low priority.
- **Where:** `docs/archive/2026-08-26-federate-pushdown-design.md`

#### Replication residue (`replication-residue`)
- **Area:** replication
- **Reach:** rare
- **Problem:** A cross-server peer does not receive the federate depth. No native whole-DB snapshot includes tombstones, so an `io()` round trip can resurrect deleted elements. Shared-target replication has no before-image journal. Replicated elements use a composite `(graph, id)` key.
- **Fix:** Add a `federationDepth` request field for cross-server peers. Add a native snapshot that includes tombstones. Add the before-image journal when shared-target replication is real. Replace the composite key with a global `gid` rejoin.
- **Where:** `src/drive.ts`, `src/execute.ts` (`federationDepth` is internal only today)

#### Graph algorithm parameters (`gds-params`)
- **Area:** services
- **Reach:** plausible
- **Problem:** The GDS services do not accept many standard parameters. Missing: `maxIterations`, `tolerance`, `consecutiveIds`, `useWassermanFaust`, `maxDegree`; `nodeSimilarity` `topK`/`similarityCutoff`/`degreeCutoff`; `sourceNodes`, `seedProperty`; weighted betweenness and LPA; `scaler`. The iterative algorithms `labelPropagation`, `eigenvector` and `louvain` do not exist.
- **Fix:** Add the cheap parameters first. Then add the iterative algorithms.
- **Where:** `src/services/catalog/olap/`

#### `io()` follow-ups (`io-residue`)
- **Area:** io
- **Reach:** plausible
- **Problem:** No one has measured a full-size round trip against the 5-minute CPU budget. No `g.io(...).with(...)` option selects the replace policy. Under `idPolicy:'preserve'` the loader still does endpoint lookups, and it parses each line more than once.
- **Fix:** Measure a full-size round trip. Add the replace-policy option. Skip endpoint lookups under `idPolicy:'preserve'` and parse each line once.
- **Where:** `src/formats/`, `src/bulk.ts`

#### Operations (`operations`)
- **Area:** deployment
- **Reach:** common
- **Problem:** There is no real Cloudflare deployment and no authentication. Transaction and session semantics are missing. Responses are not available as GraphSON. No schedule runs `PRAGMA optimize`.
- **Fix:** Deploy, add authentication, then sessions and GraphSON responses. Run `PRAGMA optimize` after a bulk load or on an alarm, never per request.

#### Browser runtime gaps (`browser-runtime`)
- **Area:** browser
- **Reach:** plausible
- **Problem:** `navigator.storage.estimate()` is not wired. Writes are not exactly-once, so a write retried across a failover can apply twice.
- **Fix:** Wire `navigator.storage.estimate()`. Add idempotency keys to writes.
- **Where:** `test/browser/failover.test.ts` (see `failover-double-write`)

## 6. Internal debt

Code-health work. These items change no answer unless they say so.

### Internal debt: writes

#### One owned-row wipe for bulk load and replication deletes (`wipe-owners`)
- **Area:** storage writes
- **Reach:** common
- **Problem:** The bulk loader and replication deletes hand-roll the same cascade. First `DELETE FROM property_fts WHERE rowid IN (SELECT [-]id FROM *_properties WHERE owner IN json_each)`, then the `deleteMembers` chain. The order is load-bearing: FTS rows go before the property rows they read through.
- **Fix:** Add `wipeOwners(store, 'vertex'|'edge', ids, {self})` beside `deleteMembers`. It states the order once and gives both FTS deletes the 2 MB split. About 15 lines; the statements do not change.
- **Depends on:** `members-everywhere`
- **Where:** `src/bulk.ts` `BatchingLoader.wipeVertexChildren`/`wipeEdges`/`wipeFts`; `src/replicate.ts` `applyDeletes`; `src/setwrite.ts` `deleteMembers`

### Internal debt: repeat

#### Spine-cut follow-ups (`spine-cut-followups`)
- **Area:** repeat
- **Reach:** rare
- **Problem:**
  - (a) The `boundedSpine` doc and the `lowerChainOf` comment say "effect-free". The gate is `writes.sites.length === 0`. Say "write-free", and say that guard and site effects read the cut pieces (ordered by `declaredBeforeUse`).
  - (b) Add an assertion that `repeat(out()).times(≥200).values(…)` on the workerd-sized stack declines as `UnsupportedTraversal`, not as a plain Error. (verify: may already be covered.)
- **Where:** `src/compiler/rel/lower.ts`; `test/compiler/repeat-unroll-boundary.exec.test.ts`

#### Stale host name in a test (`per-traverser-hosts-name`)
- **Area:** repeat
- **Reach:** rare
- **Problem:** `test/compiler/one-ir-walker.exec.test.ts:170` still names `PER_TRAVERSER_HOSTS`. The constant is now `PER_TRAVERSER_RESET_HOSTS`.
- **Fix:** Update the comment. Check that `PER_TRAVERSER_RESET_HOSTS` carries the reset rationale.
- **Where:** `test/compiler/one-ir-walker.exec.test.ts`; `src/compiler/ir/step.ts`

#### State the repeat-region grouping once (`repeat-slot`)
- **Area:** `repeat()`
- **Reach:** common
- **Problem:** `verifyRepeatDefined` and `gatherRepeatRegion` each group the repeat region by their own walk.
- **Fix:** Export one `repeatSlot(name)` (times → until) and the shared REPEAT_CLUSTER walk. Build `verifyRepeatDefined` on `gatherRepeatRegion`'s grouping. About 10 lines; answers do not change.
- **Where:** `gatherRepeatRegion`, `verifyRepeatDefined`

#### `hub-in-walk-term` advice misfires and is fixed text (`hub-in-walk-term-advice`)
- **Area:** `repeat()`, decline messages
- **Reach:** plausible
- **Problem:** The advisory (bf776b35, `hubInWalkTerm` in `src/compiler/unsupported.ts`) fires whenever the condition plan scans `edges`, so `g.V().repeat(out().simplePath()).until(path().count(local).is(3)).count()` (a path-length stop; simplePath brings in an edges scan) is told it reads each vertex's neighbourhood and to use `until(out().count().is(0))` — wrong and baffling. And the suggestion is always `out().count().is(0)` whatever the condition (`until(project('a').by(in('created').count())…is(gt(2)))` gets the wrong direction and predicate).
- **Fix:** Gate on the exhausting node's own input reading `edges`, and word the hint generically ("count the neighbourhood directly in `until(…count().is(…))`, or bound it with `limit(n)`").
- **Where:** `hubInWalkTerm` (`src/compiler/unsupported.ts`); `perHostWork` (`src/rel/work.ts`)

#### Round-15 comment and citation fixes (`round15-comment-fixes`)
- **Area:** `repeat()`, `local()`
- **Reach:** rare
- **Problem:**
  - (a) `PER_TRAVERSER_BODY_STEPS` (family 3, `src/compiler/ir/strategies.ts`) says `CHANNEL_GROUP_POLICY` keeps the sack a distinct group key through each phase's collapse; in fact `sack = 'undefined'` means a sack phase never collapses (`unroll-sack-collapse`).
  - (b) `verifyRepeatDefined`'s new comment should cite `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/RepeatStep.java` (`addUntilToTraversal`, the emit slot).
  - (c) `unrollRegion` keeps a body side effect and a body reader apart by top-level name (`PER_TRAVERSER_RESET_HOSTS.has(s.name) || s.name === 'select'`); a `select` nested in a `by()` passes. No wrong answer today (it declines downstream). Decide it with a deep `someStepDeep` fact instead.
- **Where:** `src/compiler/ir/strategies.ts`

### Internal debt: branches and nesting

#### R7 (ladder deletion) follow-ups (`r7-followups`)
- **Area:** branches and nesting
- **Reach:** rare
- **Problem:**
  - (a) `map(choose(hasLabel('person'), select('k'), constant(0)))` over an always-present host: the connector's `firstInner` keeps a per-row `IS NOT NULL` presence term plus an EXISTS fallback that re-inlines the label `EXISTS` four times. The deleted ladder's choose-arm route spent none (was pinned by `test/compiler/scalar-map-select.test.ts`). The default plan did not change with R7 — the connector was already first — so this is plan hygiene, not a regression.
  - (b) L5's `host-closure.test.ts` and L9's `connector-closure.test.ts` now run the IDENTICAL sweep (seed 42, 200 cases, default config).
  - (c) `deferred-hosts.ts`' retirement `scope` (`ladder` | `host-owned`) still names the deleted ladder.
- **Fix:** (a) compute the presence term once, or drop it where the host is always present. (b) fold the rate ratchet into L9's per-query one, or have one share the other's sweep. (c) rename the scope to what it now means (a connector row owed vs a host's own lowering).
- **Where:** `src/compiler/rel/lower/scoped.ts` `firstInner`; `test/L5-properties/host-closure.test.ts`; `test/L9-connector/connector-closure.test.ts`, `test/L9-connector/deferred-hosts.ts`

#### One "keeps the traverser where it stands" authority (`keeps-position-authority`)
- **Area:** paths
- **Reach:** plausible
- **Problem:** 6a added `KEEPS_POSITION` (`src/compiler/rel/lower/movement.ts`), a hand-written step-name list, beside `KEEPS_PATH_ENTRY` (`src/compiler/ir/strategies.ts`), which already encodes the same fact (steps that hand on the very traverser they were given; AbstractStep/ImmutablePath) and applies a scope rule. The copy is incomplete (no `hasNot`/`hasKey`/`hasValue`/`as`) and ignores `isLocalScope`, so the answer depends on which filter the user spells (`resource-path-still-steps`). A new filter step must be added by hand or silently loses the linear route.
- **Fix:** Derive `keepsPosition` from `KEEPS_PATH_ENTRY` and its scope rule (or from the lowered prefix's path-extension fact); delete `KEEPS_POSITION`.
- **Where:** `keepsPosition`, `KEEPS_POSITION` (`src/compiler/rel/lower/movement.ts`); `KEEPS_PATH_ENTRY` (`src/compiler/ir/strategies.ts`)

#### `BOUNDING_SLICES` is a name list; `truncates` is the fact (`bounding-slices-truncates`)
- **Area:** slices
- **Reach:** plausible
- **Problem:** 6a's guard (`BOUNDING_SLICES = {limit, range}` in `src/compiler/rel/lower/scoped.ts`, e4c03ba8) checks names on top-level steps after the host cut only. `write.ts` `truncates` already decodes RangeGlobalStep's stop-pulling rule (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/RangeGlobalStep.java`). A slice inside a child arm bypasses the guard: `…as('h').local(__.V().hasLabel('person').where(neq('h')).union(__.limit(1))).path().count()` answers at 1.2 s (1k) → 76 s (8k), where trunk declined. The set's declaration also sits between `reSourceAt`'s JSDoc and `reSourceAt`, orphaning that comment.
- **Fix:** Move `truncates` to `src/compiler/ir/step.ts` and use it for both; look through child arms. `range(n,-1)` would then answer as `skip(n)` does. The real fix for the guarded shapes is `reresource-host-filter`'s semi-join; replace the guard with it, do not grow it.
- **Where:** `BOUNDING_SLICES`, `reSourceAt` (`src/compiler/rel/lower/scoped.ts`); `truncates` (`src/compiler/rel/write.ts`)

#### Re-source decline messages name the wrong cause (`resource-decline-messages`)
- **Area:** messages
- **Reach:** plausible
- **Problem:** `local(__.V().hasLabel('person').where(neq('h')).limit(1)).path()` declines with `resourcePathMessage` ("a V()/E() inside local() on a traverser whose path is tracked … is not supported yet") although `local(__.V().hasLabel('person').limit(1)).path()` answers; likewise the move-then-barrier decline and `as()`-before-slice. `local(__.V().hasLabel('person').fold().sample(local,1))` reaches `declinedDraw`, whose message says the draw "would be drawn once and shared by every row", but a local sample over a folded list is a per-row function; the `sharedDraw` comment's cost reason is inconsistent with the labelled-`sample` fold 6c accepts. The coin/weighted decline is terminal (6c departed from a non-terminal note to keep six witnesses verbatim), so no later route can answer behind it.
- **Fix:** Name the shape (a limit/range after a step that reads the outer label, under `path()`); give `sample(local)` its own reason; state the coin decline's real basis (owner call).
- **Where:** `resourcePathMessage`, `declinedDraw`, `sharedDraw` (`src/compiler/rel/lower/scoped.ts`)

#### Property framing in `ladderless` is a per-(framing, step) literal (`property-ladderless-pair`)
- **Area:** nesting
- **Reach:** plausible
- **Problem:** `ladderless` carries `(framing.kind === 'property' && step.name === 'project')`; each host that leaves `propertyTail` would add another clause. Its doc also claims every property tail is reached through `continueAs`. R4.6's fix (c8c7d7f4) opened untested routes: `g.V().properties('name').hasValue('marko').V().count()` now returns 6; `…has('startTime',gt(2008)).V().count()` 18 on CREW.
- **Fix:** A framing-keyed table beside `LADDERLESS` (or derive it from which framings a tail still answers); add one re-source-after-property-filter test.
- **Where:** `ladderless`, `LADDERLESS` (`src/compiler/rel/lower/scoped.ts`); `test/compiler/project-property-host.exec.test.ts`

#### Route the remaining host lists through the host-set authorities (`host-lists`)
- **Area:** IR host sets
- **Reach:** common
- **Problem:** Four sites spell host lists by hand. The membership equals `FAN_OUT_HOSTS` or `PER_TRAVERSER_FILTER_HOSTS`.
- **Fix:** Use the shared sets. Export `PER_TRAVERSER_FILTER_HOSTS` for `isAlwaysProductiveFilterNoOp`, which is exactly that set. Membership does not change. Take with §6 `cr-fu15`.
- **Depends on:** `cr-fu15`
- **Where:** `src/compiler/ir/passes.ts` `inlineIdentityHostBody`, `isAlwaysProductiveFilterNoOp`; `src/compiler/ir/strategies.ts` `identityHostBody`; `src/compiler/rel/lower/reduction.ts` `flatMapRejoin`

#### Fold `mixedBranch` into `unionArms` (`mixed-branch-fold`)
- **Area:** branches
- **Reach:** common
- **Problem:** `mixedBranch` is now only `reconcileCollapsed` + `batchedBranch`.
- **Fix:** Fold it into `unionArms`. About 15 lines and one export go; the plan does not change. Update the comment at `test/L4-addendum/element-branch-child.feature:248`.
- **Where:** `src/compiler/rel/lower/branch.ts` `mixedBranch`, `unionArms`

### Internal debt: values, lists and maps

#### Round 8 grouping debt (`round8-debt`)
- **Area:** collections
- **Reach:** rare
- **Problem:**
  - `poolIdentity` copies the structural `JSON.stringify` replacer of `bodyKey` (`scoped.ts`). Give `bodyKey` the `ctx`-drop and `getText()` options.
  - `takeFinishedMap` is a near-copy of `snapshotSite` (`collection.ts`). Make one "site crosses the executor seam" take.
  - `pooledGroupMap` re-checks `!body.some(isValueBarrier)`, which `perTraverserSlot` already decided.
  - `namedEffect` (`lower.ts`) names every retained effect's shared subtrees. Say in its comment that it is generic.
  - A drain with no reader of its label still takes the finished map (O(keys) isolate memory): `g.V().group('a').by('name').by(values('age').sum()).count()`.
  - `by(constant(null))` lands as a self-join of the scope CTE on its row key. `seedOnly` could write in place.
- **Fix:** Address each sub-bullet.

#### Round 9 grouping debt (`round9-debt`)
- **Area:** collections
- **Reach:** rare
- **Problem:**
  - Send an unkeyed `group().by(k).by(count())` to the `countsTraversers` arm of `groupRows`, not the member pool (2226 vs 1223 SQL chars). Fold `keyedCount` into that route. Check the key spelling.
  - Export one `collapsesStep(step)` (`selfCollapses && !isLocalScope`, `lower/reduction.ts`). Replace the hand copies in `branch.ts` (`isReductionArm`, `slicesAcrossStarts`) and `map.ts` (`reducesPool`).
  - Delete the unreferenced spine-only `rewrite` in `src/rel/walk.ts` (it lacks V5's identity rule). Fix the `prune.ts` and `rewriteRels` comments that cite it.
  - `countsTraversers` (`map.ts`) and `reducingGroupCollapseTerminal` (`ir/bulk.ts`) both ask "is the value exactly count()". `bulk.ts` excludes the keyed form, which is now splittable.
  - The comments of `countsTraversers` and `sameGroupRecipe` lack `vendor/tinkerpop/...` paths.
  - The "costs nothing extra" comment in `name.ts` is about rows, not computed columns.
  - The `node-facts.test.ts` bounds (60/30) were reset with the new denominator. About 50 would hold (measured 8.6–44).
- **Fix:** Address each sub-bullet.

#### `selfCollapses` owns the local-scope check (`self-collapses-scope`)
- **Area:** reductions
- **Reach:** plausible
- **Problem:** Some callers of `selfCollapses` add `!isLocalScope(step)` by hand and some do not. `map.ts` `reducesPool` restates the test. `project('x').by(values('age').fold().sum(Scope.local))` declines, but `…count(Scope.local)` answers. It is not measured whether the missing check causes this.
- **Fix:** Move the `!isLocalScope` check into `selfCollapses(step)`. Measure the probe as part of the item.
- **Where:** `src/compiler/rel/lower/branch.ts` `isReductionArm` and the slice test near `SUBSET_SLICES`; `src/compiler/rel/lower/reduction.ts` `reductionArm`, `selfCollapsed`; `src/compiler/rel/map.ts` `reducesPool`

#### `collectionMembersOrSelf` reads `storedCollection` (`cm-stored-collection`)
- **Area:** collection tags
- **Reach:** common
- **Problem:** The `cm_c` projection hand-builds the `vtype IN ('list','set')` test. `storedCollection` documents itself as the one spelling of that test.
- **Fix:** Use `storedCollection`. Then a future collection tag has one place to change. The Expr and the SQL bytes do not change.
- **Where:** `src/compiler/rel/list.ts` `collectionMembersOrSelf`, `storedCollection`

#### One `notStoredCollection(tag)` (`not-stored-collection`)
- **Area:** collection tags
- **Reach:** common
- **Problem:** The per-row collection reader in `rel/lower.ts` has two NULL-safe negations of the collection test. One is `tagIsNot(…'list') AND tagIsNot(…'set')`. The other is `NOT (storedCollection(tag) IS TRUE)`.
- **Fix:** Add `notStoredCollection(tag)` beside `storedCollection` and use it at both sites. The first site's SQL shrinks a little, so the sql-hygiene count goes down.
- **Where:** `src/compiler/rel/lower.ts` per-row collection reader; `src/compiler/rel/list.ts` `storedCollection`

#### Gate `map()`'s correlated first-row forms on `rowResident` (`map-row-resident`)
- **Area:** connector / `map()`
- **Reach:** common
- **Problem:** `firstInnerOver` (`inline` and `pick`) asks `framingCols`, then discards the column list for `payloadCols(tail.rel)`. That is the `rowResident` question.
- **Fix:** Ask `rowResident`, so all three `map()` routes admit framings by one total switch. R4.2 tried this, measured no change in answers or SQL, and reverted. Re-check with `rejoin-row-resident.exec.test.ts` and sql-hygiene. Low value, no risk.
- **Where:** `src/compiler/rel/lower/scoped.ts` `firstInnerOver`; `src/compiler/rel/framing.ts` `rowResident`

### Internal debt: filters and predicates

#### `hasTokenPredicate` uses `ownScan` as its base case (`token-ownscan`)
- **Area:** source predicates
- **Reach:** common
- **Problem:** `hasTokenPredicate` has its own direct own-scan test. That test is `ownScan`'s base case.
- **Fix:** Spell it `ownScan(row, id, table) === row`. Then the direct, uncorrelated and correlated choice is a switch on one answer. Cost: `out().hasId(P.without(1,4))` goes from 13.6 to 24.8 ms at 8k, still linear.
- **Depends on:** `column-origin` (if both are taken, do this one second)
- **Where:** `src/compiler/rel/source.ts` `hasTokenPredicate`

### Internal debt: federation, services and io

#### PageRank routes seeds by row count (`rf3-reuse5`)
- **Area:** services
- **Reach:** rare
- **Problem:** PageRank chooses its seed route by `rows.length`, a data-dependent value.
- **Fix:** Route by the form of the call.
- **Where:** `src/services/catalog/olap/pagerank.ts`

#### `barrierIn` mislabels a federate call in an arm (`rf3-callsite-form`)
- **Area:** federation
- **Reach:** rare
- **Problem:** `barrierIn` labels a federate call inside an arm as `'source'`.
- **Fix:** Give it the correct call-site form.
- **Where:** `src/compiler/rel/segment.ts` `barrierIn`

#### call-params: one value-traversal resolver (`call-params-resolve`)
- **Area:** services
- **Reach:** common
- **Problem:** `constFromValueTraversal` duplicates `resolveValueTraversal`. The static-map loop and the `with()` loop in `parseCallSpec` convert values separately.
- **Fix:** Build `constFromValueTraversal` on `resolveValueTraversal`. Add one `paramValue(v)` for both loops. Keep the per-traverser refusal message. About 6 lines.
- **Where:** `src/services/params/call-params.ts` `constFromValueTraversal`, `resolveValueTraversal`, `parseCallSpec`

#### `tinker.search` builds its pattern the way TextP does (`search-like-pattern`)
- **Area:** full-text search
- **Reach:** common
- **Problem:** `searchProperties`'s `wrap` spells `'%'||x||'%'` twice (raw for the probe, escaped for the check). It and `predicate.ts` each hand-spell the 3-argument `like(…, '\')`.
- **Fix:** Build one escaped containing pattern. Derive the probe with `likeProbePattern(pattern).pattern`, as `semijoin.ts` `positiveOwners` does. Add `escapedLike(pattern, subject)` beside `trigramProbe` in `src/rel/like.ts`, for both builders and for `semijoin.ts` `necessaryTextAtom`'s recogniser. About 8–10 lines; SQL is byte-identical.
- **Where:** `src/services/catalog/search.ts` `searchProperties`; `src/compiler/rel/predicate.ts`; `src/rel/like.ts`; `src/rel/passes/semijoin.ts` `positiveOwners`, `necessaryTextAtom`

#### One `property_fts` row type and trigram-candidate scan (`fts-type`)
- **Area:** full-text search
- **Reach:** common
- **Problem:** `semijoin.ts` `FTS_TYPE` and `search.ts`'s inline `typeOf(...)` already differ: search marks `text` nullable.
- **Fix:** Export one `FTS_TYPE` from `src/rel/`, plus `trigramCandidates(ownerElem, probe, mint, extra?)`. `negativeOwners` reuses only the type. Plans do not change.
- **Where:** `src/rel/passes/semijoin.ts` `FTS_TYPE`, `negativeOwners`; `src/services/catalog/search.ts`

### Internal debt: storage and runtimes

#### First-request index build after deploy (`index-build-on-deploy`)
- **Area:** storage
- **Reach:** plausible
- **Problem:** `e_label` and `e_pair` are built by `CREATE INDEX IF NOT EXISTS` in `initSchema`. On an existing DO this runs in the constructor, inside the first request after deploy. The cost is O(|E| log |E|) once.
- **Fix:** Record this with the schema-migration facts for multi-GB graphs.
- **Where:** `src/cloudflare/graph-store-do.ts` (constructor); `src/storage.ts` `initSchema`

#### Binary carrier size (`binary-hex-size`)
- **Area:** storage
- **Reach:** rare
- **Problem:** Hex doubles a Binary's stored size. So DO's 2 MB value cap holds about 1 MB of bytes; base64 would hold about 1.5 MB. A Binary's hex text is also indexed in `property_fts`, as a UUID's is, which wastes index space.
- **Fix:** Add a line to `docs/limitations.md` so the limit is not found in production. Exclude Binary text from `property_fts`.

#### One "bind is past the DO value cap" predicate (`value-cap-predicate`)
- **Area:** storage errors
- **Reach:** rare
- **Problem:** The VALUE_TOO_BIG branch of `GraphStore.query`'s catch duplicates `cf-limits.ts` `valueBytes`, but drops its ArrayBuffer arm. An ArrayBuffer past the cap reads "computed" in production but "sent" under test.
- **Fix:** Move `valueBytes` (or the predicate) into `src/do-limits.ts` beside `fitsUtf8`/`utf8Bytes`, which both files already import. About 4 lines net. The wording does not change for string and Uint8Array binds.
- **Where:** `src/storage.ts` `GraphStore.query`; `src/cf-limits.ts` `valueBytes`; `src/do-limits.ts`

### Internal debt: tests, tooling and docs

#### Small comment and test fixes (`small-followups`)
- **Area:** tooling, tests
- **Reach:** rare
- **Problem:**
  - `src/gremlin/frontend.ts` LRU comment (~line 90) calls `parseGremlinUncached` "unchanged". Say "two-stage". Note on its `mode` parameter that `'ll'` is a test seam. Put the antlr4ng version (3.0.16) beside the `PredictionMode.d.ts` citation.
  - `test/inject-param-split.test.ts` "several list traversers keep inject order": `inject(xs, ys).unfold()` interleaves by member index (§17 unordered streams). The test passes only through `tail()`. Rename it, or assert count and tail only.
  - Optional: add a `mergeV(...).option(Merge.onMatch, $m)` case with a 150 KB member to `test/compiler/parameter-size.exec.test.ts`, marked expected-failure, to pin nr-param-map-members (§4).
- **Fix:** Make each change listed above.

#### `sql-plan` gates a weak-prefix SEARCH harder than a full SCAN (`sql-plan-weak-prefix-ratchet`)
- **Area:** tooling
- **Reach:** rare
- **Problem:** `g.V().fold().difference(__.V().hasLabel('person').fold())` classifies `weak-prefix:vertex_labels` (gated at zero), while the same query without `hasLabel` is a nested SCAN that is merely ratcheted. Under `fold()` the outer loop is one row. No corpus read hits it today (0/1458), but a pin bump that adds the shape turns CI red and `--record` cannot accept it.
- **Fix:** Make a weak-prefix under a CORRELATED ancestor part of the per-query ratchet, or say in the header why it is gated harder.
- **Where:** `classify` (`scripts/sql-plan.ts`)

#### Fixed test ports (`rf3-ci-port`)
- **Area:** tests
- **Reach:** common
- **Problem:** `test/cf-constructs.test.ts` binds port 8977 and `test/cloudflare.test.ts` binds 8976. Parallel worktree runs collide and fail local `ci`.
- **Fix:** Bind an ephemeral port.

#### Test pins and flakes (`rf3-pins`)
- **Area:** tests
- **Reach:** rare
- **Problem:** `one-row-one-traverser.exec.test.ts` times out at 5 s under the parallel run (nr-fu-ci-flake). The pin "hasId after a hop adds no scan" is vacuous. Some L4 expectations are stale (o-l4-sweep).
- **Fix:** Fix the timeout. Replace the vacuous pin with the uncorrelated `IN (SELECT id …)` shape. Sweep the L4 expectations.
- **Where:** `test/compiler/one-row-one-traverser.exec.test.ts`

#### Unroll pins do not test random bodies (`unroll-random-pins`)
- **Area:** tests
- **Reach:** rare
- **Problem:** The unroll-boundary test compares the emitted unroll SQL with a hand-written union. Both make the same independent draw, so the test proves nothing for a random body. The counted-until L4 file lacks the simplePath+emit, 64-table and large-k emit cases.
- **Fix:** Add a coupling check: every emitted level-k path extends an emitted level-(k-1) path. Add deny pins for `emit().repeat(both().sample(1)).times(2)` and a host-wrapped shuffle. Add the missing L4 cases.
- **Where:** `test/compiler/repeat-unroll-boundary.exec.test.ts`

#### L3 ledger citations (`l3-ledger-cites`)
- **Area:** tests
- **Reach:** rare
- **Problem:** `list-default-cardinality` (`g_V_hasXname_fooX_propertyXname_setXbarX_age_43X`) is a `wall` that cites a code literal (`src/api.ts` `DEFAULT_VERTEX_CARDINALITY`). An undeclared `property(k,v)` appends, so ordinary write answers differ from TinkerGraph's `single`. `oncreate-override` cites the limitations "When errors happen" row, which may cover constant names only (verify). The "String vs integer id" row does not cross-reference rf3-reuse1. The three `wall`s that answer (graph-computer-inert, vertex-property-ids, list-default-cardinality) have no check.
- **Fix:** File `list-default-cardinality` as a `divergence` with a limitations row: "Default vertex cardinality is list, the `Graph.Features` default (`Graph.java:671`); TinkerGraph's is single." Cite the mergeV/mergeE matrix row ("onCreate may restate a merge key, never change it") for `oncreate-override`, or extend the row. Add the cross-reference.
- **Where:** `test/L3-conformance/expected-outcomes.ts`; `docs/limitations.md`

#### Missing limitations line for C3 (`c3-limitations-line`)
- **Area:** docs
- **Reach:** rare
- **Problem:** The C3 limitations line is missing (verify: may have landed). It must name `not()`, the `order()` route and the seats it covers. It must say the concat raise is not Java's.
- **Fix:** Add the line to `docs/limitations.md`.

#### Stale comments (`stale-comments`)
- **Area:** docs
- **Reach:** rare
- **Problem:** The `shortest-path.ts` header describes the old recursive-CTE walk. The `strategies.ts` comment on `stream`/`mutate`/`stats` modes (near line 650) is stale.
- **Fix:** Rewrite both comments.
- **Where:** `src/services/catalog/olap/shortest-path.ts`; `src/compiler/ir/strategies.ts` `GRAPH_ALGO_SERVICE`

#### Prose fixes from round 12 (`round12-prose`)
- **Area:** docs
- **Reach:** rare
- **Problem:** In the `src/storage.ts` SCHEMA comment, the clause "AND matches TinkerPop's single-case reference graphs" refers to the wrong subject. `src/services/CLAUDE.md` has one over-long joined line at the new paragraph.
- **Fix:** Fix both.

#### One adjacency-seek plan-assertion helper (`adjacency-seek-assert`)
- **Area:** tests
- **Reach:** common
- **Problem:** `usesEdgeIndex` and `plainSeeks` each accept `e_out` or `e_pair` by hand. The next index change must edit both.
- **Fix:** Read the rule from the gate rather than listing index names: a SEARCH whose `constrainedColumns` are `[src]` on an index whose leading column is `src`, using `schemaFacts`/`constrainedColumns`/`PlanRow` exported by `scripts/sql-plan.ts` (10a, 4a1e42a8). Drops `both-frontier-once`'s private `PlanRow`/`planRows`. Also loosen `walk-condition-hub-scale.exec.test.ts`'s exact `e_pair (src=? AND tgt=?)` text to "a covering adjacency-index SEARCH with no label term" (S1 follow-up, 666ebf3e); its other two assertions already catch the regression.
- **Where:** `test/performance.test.ts` `usesEdgeIndex`; `test/compiler/both-frontier-once.exec.test.ts` `plainSeeks`; `test/compiler/walk-condition-hub-scale.exec.test.ts`

#### `mise run binds` flags a hand-written `json_each(?)` (`binds-json-each`)
- **Area:** gates
- **Reach:** common
- **Problem:** The binds gate flags `?` repetition, but not a hand-written `json_each(?)` outside the helper.
- **Fix:** Add that check to the gate.
- **Depends on:** `members-everywhere`
- **Where:** `scripts/binds-check.ts`

#### One EXPLAIN-tree reader (`explain-reader`)
- **Area:** plan gates and tests
- **Reach:** common
- **Problem:** Three plan readers walk EXPLAIN output separately. `nestedSnapshotScans` has its own `PlanRow`, LOOP regex and alias regex. That regex does not blank string literals or handle quoted names. Its `BASE_TABLES` list lacks `tombstones` and `barrier_state`. The walks disagree on MATERIALIZE: snapshot-scans stops there (a CTE fill runs once), and `classify` does not.
- **Fix:** Use `scripts/sql-plan.ts`'s `aliasTables`/`schemaFacts`/`classify` in all three. Move the shared module into `test/support/`, to keep the scripts → test/support direction. Take the MATERIALIZE stop. This drops 5 of the 27 `sql-plan-baseline.json` entries (`g.inject(['marko']).{combine,difference,intersect,merge,product}(__.V().values('name')…fold())`) to 22. Re-record in the same commit.
- **Where:** `test/support/snapshot-scans.ts` `nestedSnapshotScans`; `test/support/cte-runs.ts` `reevaluatedCtes`; `scripts/sql-hygiene.ts` `planOf`; `scripts/sql-plan.ts`

#### Plan-shape tests assert through the gate's classifier (`explain-classify-tests`)
- **Area:** tests
- **Reach:** common
- **Problem:** About 20 test files hand-roll `store.query('EXPLAIN QUERY PLAN '+sql, binds).map(r=>r.detail)`. The `seeks` regex in `test/L2-sql/filter.sql.test.ts` restates sql-plan's unconstrained-virtual class.
- **Fix:** Add one `explain(store, sql, binds): PlanRow[]` in the shared module and assert with `classify(...)`. Keep the specific `0:L…`/`0:=` pins where they are the point. Test-only.
- **Depends on:** `explain-reader`
- **Where:** `test/L2-sql/filter.sql.test.ts`; the shared plan module

#### Pin `sample(…).otherV()` on self-loops and repeated vertices (`sample-otherv-selfloop-test`)
- **Area:** tests
- **Reach:** plausible
- **Problem:** `test/compiler/sample-other-v.exec.test.ts` runs only on the modern graph (no self-loops, no repeated traversers). A self-loop's `bothE()` yields the loop twice and `otherV()` returns the vertex itself; `g.V(1).both().both().local(bothE().sample(1).otherV())` gives one row per traverser (7). Both probed correct at N=1k, neither pinned.
- **Fix:** Add a small self-loop graph case and a repeated-traverser case. Test-only.
- **Where:** `test/compiler/sample-other-v.exec.test.ts`

### Internal debt: compiler internals

#### One loop-head re-dispatch for every tail (`tail-loop-head`)
- **Area:** compile
- **Reach:** plausible
- **Problem:** Seven tails hand-roll the hand-back to `continueAs` (connector site, re-source, inject) and have drifted — the same bug class R4.6 fixed in `propertyTail`. `pathTail`, `mapEntryTail` and `recordTail` check only `connectorSite`, so `g.V().valueMap().unfold().V().count()` and `g.V().project('a').by('name').inject(1).count()` decline with "no lowering covers", while `g.V().valueMap().V().count()` and `g.V().project('a').by('name').V().count()` answer 36.
- **Fix:** One `handsBack(step, ctx, steps, at)` test at each tail's loop head returning `continueAs(rel, <framing>, …)`; `framingDispatch` already serves V/E/inject. About 12 lines go; no answer changes, a few declines answer.
- **Where:** `src/compiler/rel/lower.ts` `scalarTail`, `listTail`, `pathTail`, `mapTail`, `mapEntryTail`, `elementTail`, `recordTail`, `framingDispatch`

#### A total `windowOf(step)` beside `sliceOf`/`countOf` (`slice-window-of`)
- **Area:** slices
- **Reach:** plausible
- **Problem:** Five callers catch `sliceOf`'s internal "not a slice step" plain `Error` (`try { sliceOf } catch (e) { if (e instanceof ValueParseError) throw e; return null }`), and three repeat the `tail → {offset:0, limit:countOf(step)}` branch. Two are catch-alls that also swallow a `ValueParseError`/`UnsupportedTraversal` (`cutsToOne`, `truncates`).
- **Fix:** `windowOf(step): {offset, limit, fromEnd} | null` in `src/compiler/ir/step.ts`; delete the internal throw. About 20 lines go; values do not change, except an out-of-range count surfaces its specific "not an exact 64-bit long" decline.
- **Where:** `sliceOf` (`src/compiler/ir/step.ts`); `src/compiler/rel/lower/slice.ts`; `src/compiler/rel/list.ts`; `mapWindow` (`src/compiler/rel/map.ts`); `cutsToOne` (`src/compiler/ir/shuffle-cut.ts`); `truncates` (`src/compiler/rel/write.ts`)

#### `recordPairs` raise gate is untested (`cc1-raise-gate`)
- **Area:** compile
- **Reach:** rare
- **Problem:** The raise gate in `recordPairs` (`exprMayAbort(pair) ? CASE WHEN present THEN pair ELSE NULL END : pair`) has no test and appears redundant. With it forced off, all 13 `project-linear` tests and 25 probes answer the same, because `fieldPresence` reads the same subquery that holds the raise.
- **Fix:** Pin it with a probe that needs it, or remove it. Removal saves ~13% text on nested math projections.
- **Where:** `recordPairs` in `src/compiler/rel/record.ts`; `fieldPresence` in `src/compiler/rel/framing.ts`

#### Node-fact cache follow-ups (`cc4-followups`)
- **Area:** compile
- **Reach:** rare
- **Problem:**
  - (a) The compile-time gain of the bottom-up `freeRelIds`/`definesId`/`idsDefined` machinery (~140 lines) did not reproduce after cc-2.
  - (b) The code does not say why `idsDefined` (two keys) and `depthMemo` (iterative) bypass `nodeFact`.
  - (c) The `nodeFact` doc says an Expr is never mutated. `src/rel/expr.ts` does not freeze Exprs; only Rels are frozen (`factory.ts`).
- **Fix:** (a) Re-measure; remove the machinery if it does not pay. Keep `nodeFact` and the `ownReads` memo. (b) Add the comment. (c) Freeze Exprs, or document the convention.
- **Where:** `src/rel/walk.ts`, `src/rel/expr.ts`

#### One randomness detector and one draw-decline message (`draw-decline-unify`)
- **Area:** compile
- **Reach:** rare
- **Problem:** Three detectors find randomness: `draws` (`src/rel/copies.ts`), `nondeterministic`/`RANDOM_STEPS` (`src/compiler/ir/step.ts`) and `SHARED_DRAW` (`reduction.ts`). Three declines use different messages: SHARED_DRAW, the repeat-emit draw decline in `strategies.ts`, and `CopiedDraw`.
- **Fix:** Use one detector and one message. Cite `vendor/tinkerpop/gremlin-core/.../LocalStep.java` for "the branches of `local()` share one draw per traverser".
- **Where:** `src/rel/copies.ts`, `src/compiler/ir/step.ts`, `reduction.ts`, `src/compiler/ir/strategies.ts`, `src/rel/passes/name.ts`

Each item is measured from N≈1k to N≈8k (linear is about 8×), or it exceeds a DO cap. It passes every test graph and fails in production.

#### Debt from ladder-retirement rounds 4–7 (`ladder-debt`)
- **Area:** compile
- **Reach:** rare
- **Problem:**
  - U5: `fuse.ts` re-derives lineage.
  - V4: `keyedJoin` reuses the EXISTS decomposition of `indexSeek`.
  - U8, round-7 cheap follow-ups, M6.
  - K2: declines that lost their explanation under M1. K3, K4.
  - M1b/H1: path concatenation for `local()` over a re-source.
  - Reuse proposals P2–P42 not landed.
- **Fix:** Address each by its own id. Witnesses are in `docs/2026-11-16-ladder-retirement-plan.md` at `4100715c`.

#### LIKE probe decodes its own pattern (`like-probe-decoder`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** `likeProbePattern` recovers the raw TextP term by matching the shape of `likeEscaped`'s `replace()` chain. `likePattern` already knows the term. If the escape spelling changes, the decoder returns null and the seek falls back to a full FTS read. The answer stays correct; the sql-plan unconstrained-virtual gate catches the regression.
- **Fix:** Let the atom carry the raw term. Delete the decoder.
- **Where:** `src/rel/like.ts` `likeProbePattern`; `src/compiler/rel/predicate.ts` `likePattern`

#### Identity-reprojection idiom (`identity-reprojection`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** About 43 sites hand-roll the identity reprojection.
- **Fix:** Add an override-aware `carriedExprs(channels, sourceId, overrides?)` and a `from` option on `withPayload`. Migrate the sites.
- **Where:** `src/compiler/rel/**`, `src/rel/**`

#### `OwnerSeek` DISTINCT tail copied three times (`distinct-owners`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** The `OwnerSeek` DISTINCT tail occurs three times.
- **Fix:** Extract `distinctOwners`.
- **Where:** `src/rel/passes/semijoin.ts`

#### Map-key scope has two dispatchers (`mapKeyScope`)
- **Area:** compiler
- **Reach:** plausible
- **Problem:** `mapTail` and `mapHostChild` each decide map-key scope. `resolveMergeArg` writes its own collision sentence. Where a Map's keys are unknown (`valueMap()`, `group()`), the B4 message advises "rename the label", which can never help (`nr-fu-b4-unknown-keys`).
- **Fix:** First, make the unknown-keys message say the keys are not known at compile time. Then add one `mapKeyScope(key, facts, ctx, live)` beside `mapKeyCollision` and use it from both sites. Route `resolveMergeArg`'s sentence through `mapKeyCollision`.
- **Where:** `src/compiler/rel/lower.ts` `mapKeyCollision`, `mapTail`; `src/compiler/rel/lower/reduction.ts` `mapHostChild`

#### Six property-table insert builders (`propertyRowsInsert`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** `rel/write.ts` has six builders for PROPERTY_TABLE inserts.
- **Fix:** Use one builder that emits byte-identical SQL. It also absorbs the `json_extract` helper from nr-fu-mapentry-props.
- **Where:** `src/compiler/rel/write.ts`

#### Four copied blocks in `write.ts` (`write-copied-blocks`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** Four blocks are copied: carrier reproject, merged-create spread, alias-carry, and nested-spec decline.
- **Fix:** Extract each into one helper.
- **Where:** `src/compiler/rel/write.ts`

#### Keyed pool builds a reduction only to test it (`keyed-pool-mayraise`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** The keyed pool builds the pooled reduction only to ask `mayRaise`. This is a compute-once tidy-up, not a regression.
- **Fix:** Decide `mayRaise` from the value body. Build the reduction once, at the reader.
- **Where:** `src/compiler/rel/lower/scoped.ts` `keyedPooledGroup`

#### One `deferred` helper for narrowed catches (`deferred-helper`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** Four narrowed catches repeat the same deferral pattern.
- **Fix:** Add one `deferred(ctx, () => …)` and use it at all four sites.
- **Where:** `src/compiler/rel/lower.ts`, `src/compiler/rel/write.ts`

#### Id predicate classified twice (`rf3-idquery-dup`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** The filter vocabulary re-derives what `idMembership` decides. `routable` and `listAmongSeveral` have already drifted. A doc comment states "`V(1,[2,3]) ≡ V(1,2,3)`", which `GraphTraversalTest.java:146-147` refutes.
- **Fix:** Classify the predicate only, in one place. Fix the doc comment.
- **Where:** `src/compiler/rel/lower/filter.ts` `routable`, `listAmongSeveral`; `src/compiler/rel/source.ts` `idMembership`

#### Five column walkers (`rf3-reuse4`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** Five walkers rewrite or read columns separately.
- **Fix:** Fold `semijoin.ts` retargeting and `write.ts` `reScope` into `walk.ts` `substRelId`. Add one `colsRead(e, rel)` for fuse, prune, semijoin and walk.
- **Where:** `src/rel/walk.ts`, `src/rel/passes/semijoin.ts`, `src/compiler/rel/write.ts`

#### `group()` null-first sort term (`cr-reuse4`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** `group()` computes `mayYieldNull` separately. Fold, list, map and element bodies carry a null-first sort term they do not need.
- **Fix:** Derive `mayYieldNull` from `producedMemberNode`'s member gate. Drop the extra sort term.
- **Where:** `src/compiler/rel/map.ts`

#### Deep literal search helper (`cr-reuse5`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** `uncarriedLiteral`, `uncomparableLiteral` and `holdsNaN` each walk nested chains by hand.
- **Fix:** Add `firstInChainsDeep` / `someNode(value, pred)` and use it in all three.
- **Where:** `src/compiler/ir/uncarried-literal.ts`

#### One-row relation builder (`nr-ru3`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** Five sites hand-build a `VALUES(1)` one-row relation (r1-reuse4, r6-reuse5).
- **Fix:** Move `oneRow` from `lower.ts` to `build.ts`. Add `rowOf(cells, names, fresh)` for `once()`. Delete the five copies.
- **Where:** `src/compiler/rel/lower.ts` `oneRow`; `src/compiler/rel/build.ts`

#### Smaller consolidations (`small-consolidations`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** Several small duplications remain:
  - Five `row_number` hand-rolls (r1-reuse2).
  - An always-true `prn > 0` test (r1-reuse3).
  - `choose()` conditions not built through `childPredicate` (r2-reuse1).
  - `VALUE_ARGUMENT_STEPS` not derived from the move tables (r2-reuse8).
  - `collapsedToOneRow` used where `rowBounds` applies (r3-reuse5).
  - About 10 self-contained fences not built through `build.ts` `fenced` (r6-reuse3, r7-reuse1).
- **Fix:** Add `firstPerPartition` for the `row_number` sites. Drop `prn > 0`. Apply each listed reuse.
- **Where:** `src/compiler/rel/build.ts`, `src/compiler/rel/lower.ts`

#### Four spellings of the per-traverser filter-host set (`cr-fu15`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** `ONCE_FILTER_HOSTS`, `COLLAPSE_FILTERS`, `SHAPE_PRESERVING` and `EXISTENCE_FILTER_HOSTS` spell the same set. About 10 sites hand-roll a `V||E` re-source test.
- **Fix:** Use one authority, or write a comment that says why they differ. Extract the re-source test.

#### `property(T.id)` on an existing element (`tid-permanent-error`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** `property(T.id)` on an existing element raises a clearable `Deferral`. No future lowering can support it.
- **Fix:** Raise a permanent `Error`.
- **Where:** `src/compiler/ir/write-args.ts`

#### Two framing-to-`{t,v}` encoders (`tv-encoders`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** `producedMemberNode` and `fieldNode` both encode a framing as `{t,v}`. They must be edited together. A merge is an architectural change.
- **Fix:** Keep them in lockstep until a merge is planned.

#### Unconsumed `ContentDemand.keys` (`content-demand-keys`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** No consumer reads `ContentDemand.keys`. `literalKeysOf` takes a 3-argument `has`'s label as its key.
- **Fix:** Delete `keys` and `literalKeysOf`.
- **Where:** `src/compiler/ir/content-demand.ts`

#### Decline message kinds and wording (`nr-fu-s0-default-kind`)
- **Area:** compiler
- **Reach:** plausible
- **Problem:** About 25 self-explaining declines carry kind `'uncovered'`. Lowering throws in `channels.ts` and `sql/kernel/q.ts` bypass the decline sink. `UNCOMPARABLE_LITERAL` does not name the step or suggest the intent. `validateNoOverrides` stringifies every JS Map as `"{}"` (cr-fu13).
- **Fix:** Rename the default kind to `'unsupported'`. Migrate the remaining throws to the sink. Make `UNCOMPARABLE_LITERAL` name the step and suggest the intent. The two `@Unsupported` pins in `merge-oncreate-overrides-runtime-map.feature` assert the message. Do not grow the peephole.

#### `once` naming and math-chain pin (`once-naming`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** `bun scripts/refs.ts once` resolves to `emit.ts`'s locals, not to `build.ts`'s `once`. No pin records the math chain's exponential-to-linear win.
- **Fix:** Rename `build.ts` `once` to `heldOnce` or `evaluateOnce`. Pin `g.V().values('age').as('a').math('a+1').as('b').math('a+b').as('c').math('a+b+c')` → `[118,110,130,142]` at about 15 KB of SQL.
- **Where:** `src/compiler/rel/build.ts` `once`

#### Slice and productivity tidy-ups (`cr-fu8`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** `dedupBy`/`keptDedup` comments are stale. `productivityFilter(step, key, key.raw ?? key.value)` should pass `key.value` (r3-fu4). `compilerNull()` and the `aliasGuard` witnesses have no pins. The ProductiveByStrategy scenario in `group-value-null-member.feature` has a non-deterministic order.
- **Fix:** Fix the comments and the argument. Add the pins. Change the scenario to `order().by(label).by('name')`.
- **Where:** `src/compiler/rel/lower/slice.ts`

#### Single small items (`single-items`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** Each of these is one small fix:
  - Trace the `valueMap` sql-hygiene raise from 75 to 82 (r4-fu6).
  - `perRowCollectionStep` parses JSON again per row (r7-m).
  - `rowBounds` is too wide over `rn=1` and HAVING (r6-m-s8).
  - CF federation drops parameter types (r6-m-federate-types; verify).
  - Derive `declaredTypeOf` from `valueNodeOf` (r5-fu6).
  - Pin the `withSideEffect` number class (R15).
  - Make `rankedFirst`'s key total (F8).
  - `refReads` stops at a Ref (F11).
  - Use one JS-to-JSON encoder for a literal list (r7-fu10).
  - `byNode` nests its CASE (o-plansize).
  - Route `properties().drop()` through `removeRows` (r4-fu8c).
  - `effectScope` snapshots leak into the WITH of later statements (r4-fu8d; verify).
- **Fix:** Do each item on its own.

#### Number family defined five times (`number-family-one-authority`)
- **Area:** compiler
- **Reach:** plausible
- **Problem:** Five sets define the Number family: `SUBTYPES.number`, `NUMBER_TAGS` (receiver, documented as the family; a second copy is in `coerce.ts`), `NUMBER_FAMILY`, `NUMERIC_VTYPES` and `NUMERIC`. A new or corrected numeric type can change `typeOf(NUMBER)` without changing `asNumber` or the receiver checks. This is a major item.
- **Fix:** Define the family once in `gremlin/types.ts` beside `CANONICAL`. Derive the others from it.
- **Where:** `src/gremlin/types.ts` `SUBTYPES`; `src/compiler/rel/receiver.ts` `NUMBER_TAGS`; `src/gremlin/coerce.ts` `NUMBER_TAGS`; `src/compiler/rel/transform.ts` `NUMBER_FAMILY`; `src/compiler/rel/predicate.ts` `NUMERIC_VTYPES`; `src/compiler/rel/orderability.ts` `NUMERIC`

#### "Terminal global reducer" tested by name (`terminal-reducer-fact`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** Five places test for a terminal global reducer by step name. One is `isStreamBarrier(last) && (REDUCERS.has(last.name) || last.name === 'fold')`. `nestedHostChild` states the per-host policy (map → one; local, flatMap → all) by hand. All sites fail closed today.
- **Fix:** Make it one fact. See the `selfCollapses` proposal under "Next round".
- **Where:** `src/compiler/rel/lower/reduction.ts` `nestedHostChild`; `src/compiler/ir/analyze.ts`; `src/compiler/rel/write.ts`

#### Ordering pins (`ordering-pins`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** For the T-token tie-break (`'id'` property vs `T.id`), JS orders String first. SQL keeps input position. `g.E().order().by(elementMap())` returns `7,9,11,12,8,10`, which is correct but not pinned.
- **Fix:** Add the same type tie-break to the SQL ORDER BY, or add a line to `docs/limitations.md`. Pin the `elementMap()` order.
- **Where:** `src/compiler/rel/orderability.ts`

#### `CONSTANT.true` emitted as `WHERE (1 = 1)` (`const-true-elide`)
- **Area:** compiler
- **Reach:** common
- **Problem:** `identity()` arms and bodies go through `sourceFilter`, so 11 corpus plans gain `WHERE (1 = 1)`. Examples: `emit().repeat(out()).times(2).path()`, `union(identity(), out())`, `choose(…, identity())`. SQLite removes it, so runtime cost is zero.
- **Fix:** Elide a `CONSTANT.true` conjunct in the filter composer.
- **Where:** `src/compiler/rel/lower/filter.ts`

#### Side-effect elision uses a denylist (`effect-denylist`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** `dropEffectFreeSideEffect` decides effects from the hand denylist `OPAQUE_OR_RAISING`.
- **Fix:** See the effect-vocabulary proposal under "Next round".
- **Where:** `src/compiler/ir/step.ts` `OPAQUE_OR_RAISING`; `src/compiler/ir/strategies.ts` `dropEffectFreeSideEffect`

#### One correlated-probe builder (`exists-probe`)
- **Area:** RelIR builders
- **Reach:** common
- **Problem:** About 19 sites hand-build a `project(['one', 1])` EXISTS probe. There are also two private `existsOf` copies.
- **Fix:** Add one `existsProbe(matched, fresh, {negated, prefix})` beside `make`. Pass the id prefix through, so alias spelling and L2 snapshots stay byte-identical. About 25 lines.
- **Where:** `source.ts` `hasLabelPredicate`/`hasPropertyPredicate`/`hasTokenPredicate`; `write.ts` (5 sites); `list.ts` (2); `map.ts` (2); `lower.ts`; `existsOf` in `boundgraph.ts` and `decorate.ts`

#### One column-lineage walker (`column-origin`)
- **Area:** `src/rel` metadata
- **Reach:** common
- **Problem:** `ownScan` and `valueColIsDetached` each trace a column to its source, and they disagree on joins. The passthrough lists in `src/rel/subtype.ts` and `block.ts` `aggregateCols` restate the same rules.
- **Fix:** Add `columnOrigin(rel, name)` in `src/rel`, modelled on `vendor/calcite/core/src/main/java/org/apache/calcite/rel/metadata/RelMdColumnOrigins.java`. It returns scan+column, computed-at-rel, or opaque. It states the passthrough list and the window and join rules once. About 30–40 lines; plan-only.
- **Where:** `source.ts` `ownScan`; `lower/reduction.ts` `valueColIsDetached`; `src/rel/subtype.ts`; `block.ts` `aggregateCols`

#### Derive the effect and opaque step sets from the existing authorities (`opaque-step-sets`)
- **Area:** IR vocabularies
- **Reach:** common
- **Problem:** `write.ts` `OPAQUE_STEPS` and `step.ts` `OPAQUE_OR_RAISING` restate step names by hand. The graph-algorithm names are spelled in three places. This breaks the "not in two places" rule in the `MUTATING_STEPS` doc comment.
- **Fix:** Export `GRAPH_ALGO_NAMES = Object.keys(GRAPH_ALGO_SERVICE)`. Build `OPAQUE_STEPS` from `MUTATING_STEPS` ∪ `GRAPH_ALGO_NAMES` ∪ `['call','io','read','write','subgraph','profile']`. Build `OPAQUE_OR_RAISING` from `{'fail','call','io', …GRAPH_ALGO_NAMES}`. Gate `desugarGraphAlgos` on `s.name in GRAPH_ALGO_SERVICE`. About 6 lines; the sets stay identical.
- **Where:** `src/compiler/ir/strategies.ts`; `src/compiler/rel/write.ts` `OPAQUE_STEPS`; `src/compiler/ir/step.ts` `OPAQUE_OR_RAISING`; `src/compiler/ir/passes.ts` `desugarGraphAlgos`

#### `firstRootedColumn` uses `firstOf` for the ordered case (`first-rooted-firstof`)
- **Area:** RelIR builders
- **Reach:** common
- **Problem:** The typed `firstRootedValue` branch is a third copy of `firstOf`. It differs only by a fence.
- **Fix:** Build the ordered case on `build.ts` `firstOf`. Confirm with the sql-hygiene baseline that no plan moves.
- **Where:** `src/compiler/rel/build.ts` `firstRootedColumn`, `firstRootedValue`, `firstOf`

#### One iterative bottom-up fold (`rel-fold-nodes`)
- **Area:** `src/rel` walks
- **Reach:** common
- **Problem:** `relDepth` (`depthMemo` + stack) is `treeSize` with max in place of sum.
- **Fix:** Add `foldNodes(root, memo, beneath, combine)` and build both on it. About 20 lines go; it stays O(DAG) and stack-safe. Take with cc-4 follow-up (b).
- **Depends on:** cc-4 follow-up (b)
- **Where:** `src/rel/walk.ts` `relDepth`, `treeSize`

#### Every compute-once scalar subquery via `once()` (`once-everywhere`)
- **Area:** RelIR builders
- **Reach:** common
- **Problem:** `storedCompareOnce` and `valueTheta`'s `vto`/`vtp` one-row VALUES hand-roll `once()`. Each has its own copy of `once`'s `spelledFreely` test.
- **Fix:** Build both on `build.ts` `once()`. SQL stays the same or gets smaller, because `once` keeps a cheap operand inline. About 15 lines.
- **Where:** `src/compiler/rel/predicate.ts` `storedCompareOnce`, `valueTheta`; `src/compiler/rel/build.ts` `once`

#### One `oneRow` unit relation (`one-row-unit`)
- **Area:** RelIR builders
- **Reach:** common
- **Problem:** Several sites hand-roll a one-row unit relation.
- **Fix:** Export `oneRow` from `build.ts` beside `once()`. Replace `lower.ts` `oneRow`, `u`/`eu`/`pu` in `reduction.ts` (`mapEntryChild`, `perRowCollectionChild`) and `pv` in `write.ts`. `mapEntryChild` and `perRowCollectionChild` become a one-row `make.values({ rows: [[…]] })`, with one Rel node and one nesting level fewer. About 10 lines.
- **Where:** `src/compiler/rel/lower.ts` `oneRow`; `src/compiler/rel/lower/reduction.ts` `mapEntryChild`, `perRowCollectionChild`; `src/compiler/rel/write.ts`

#### One bound law for `uniqueKeyMatches` and `rowNumberCap` (`row-number-cap-authority`)
- **Area:** RelIR metadata
- **Reach:** common
- **Problem:** `rowNumberCap` (6d(b), 64bae352) copies `uniqueKeyMatches`' AND-takes-min / OR-needs-both walk line for line; only the leaf differs. Its "unpartitioned `row_number`" test also restates `columnIsRowKey`'s window arm (`src/rel/copies.ts`) and the renumber check in `src/rel/position.ts`.
- **Fix:** One `predicateBound(pred, leaf)` holding the and/or law (≈8 lines fewer); one `isWholeRelationRowNumber(spec)` read by all three sites (the cap also needs 1..N density). Compile-time metadata only.
- **Where:** `src/rel/bounds.ts` (`uniqueKeyMatches`, `rowNumberCap`); `src/rel/copies.ts` (`columnIsRowKey`); `src/rel/position.ts`

#### One V/E re-source vocabulary (`graph-sources-vocabulary`)
- **Area:** compiler internals
- **Reach:** common
- **Problem:** R7b (35feb250) made `GRAPH_SOURCES` one export in `src/compiler/ir/step.ts`, but the inline `name === 'V' || name === 'E'` checks remain: `reSourceAt` and `reSourcingBody` in `scoped.ts`, `reduction.ts` (three), `segment.ts`, `ir/bulk.ts`, and five in `lower.ts`. The deep "does this body re-source" question is asked through `GRAPH_SOURCES` in `spliceableLocalBody` but by hand in `reSourcingBody`, so the splice gate and the connector's trial can drift. Separately, `(V||E) && !idOfValue && !traversalIdArg(s)` (a re-source, not an id lookup) is spelled three times (`reSourceAt`; `lower.ts`; `reduction.ts`) — name it `isReSource(step)` beside `IRStep.idOfValue`.
- **Fix:** Use `GRAPH_SOURCES.has` in `reSourcingBody` and `reSourceAt` first (≈2 lines, no SQL change); the other sites only where they mean "re-source" rather than "which element kind". Then `isReSource` if those sites are touched anyway.
- **Where:** `src/compiler/ir/step.ts`; `src/compiler/rel/lower/scoped.ts` (`reSourceAt`, `reSourcingBody`); `src/compiler/rel/lower.ts`; `src/compiler/rel/lower/reduction.ts`

#### The unroll gate's movement family as one named set (`unroll-moves-set`)
- **Area:** compiler internals
- **Reach:** rare
- **Problem:** `unrollableBodyStep` tests `VERTEX_MOVES || EDGE_MOVES || ENDPOINT_MOVES`, exactly `COLLAPSE_MOVES` in `src/compiler/ir/bulk.ts`; but that name means "can bulk-collapse".
- **Fix:** Only with a neutral name: export the union from `ir/step.ts` (e.g. `ELEMENT_MOVES_NO_OTHERV`) and import it at both sites; `otherV` stays admitted only via `ONE_TO_ONE`. Skip otherwise.
- **Where:** `unrollableBodyStep` (`src/compiler/ir/strategies.ts`); `src/compiler/ir/bulk.ts`
#### Build `FROM_V_TRANSPARENT` from the step vocabularies (`from-v-transparent-vocabulary`)
- **Area:** compiler internals
- **Reach:** plausible
- **Problem:** `FROM_V_TRANSPARENT` (`src/compiler/rel/lower.ts`) hand-lists `FILTER_HOSTS` plus the slice ops; 6d(a)'s whole fix was adding the `sample` it had missed. The slice fold's private `SLICE_STEPS` (`src/compiler/rel/lower/slice.ts`) shares its name with `ir/step.ts`'s exported `SLICE_STEPS` but has different members.
- **Fix:** Rename and export slice.ts's set (e.g. `ROW_SLICE_STEPS`); build `FROM_V_TRANSPARENT` as `unionOf(FILTER_HOSTS, ROW_SLICE_STEPS, {…the has/path/identity/as/order names})` with the same members. Keep `dedup` out explicitly (its comment says why); `ROW_OPS` is not reusable whole.
- **Where:** `src/compiler/rel/lower.ts` (`FROM_V_TRANSPARENT`); `src/compiler/rel/lower/slice.ts`; `src/compiler/ir/step.ts`

### Internal debt: other

#### One `tagExcludes(tag, vtypes)` guard (`tag-excludes`)
- **Area:** binary-carrier guard (§1b)
- **Reach:** common
- **Problem:** The guard is built on branch `wf/tag-excludes-guard-3-0`, but it is not on trunk.
- **Fix:** Land it with the §1b binary-carrier-guard follow-up on that branch. Do not land it separately.
- **Where:** branch `wf/tag-excludes-guard-3-0`

#### `declaredBeforeUse` on every effect program (`declared-before-use`)
- **Area:** effect programs
- **Reach:** common
- **Problem:** `lowered` applies `declaredBeforeUse` only when `hoisted.length` is non-zero. Trunk once shipped an effect-reads-later-binding order bug as a bare "Ref … is not a Plan binding".
- **Fix:** Always apply `declaredBeforeUse`. The stable sort returns an already resolving list unchanged. Plans stay byte-identical.
- **Where:** `src/compiler/rel/lower.ts` `lowered`

#### One param-or-constant authority (`const-authority`)
- **Area:** literals and binds
- **Reach:** common
- **Problem:** The exact-tail form `name != null ? param(v,name) : compilerText(String(v))` occurs 3 times. `isExactTail` is spelled twice in `lower.ts` and once privately in `predicate.ts`. A text-or-param form occurs 4 times.
- **Fix:** Add `exactTailLit(arg)` and `isExactTail` beside `constLit` in `src/compiler/rel/const.ts`. Add `textLit(value, name)` and use it in `constLit`'s string arm. Delete the dead `text` alias in `write.ts`. `ftsTextExpr`'s `name#fts` stays the one visible special case. About 15 lines; SQL does not change.
- **Where:** `src/compiler/rel/lower.ts` `exactTailConst`, inject `rowExpr`; `src/compiler/rel/predicate.ts` `isExactTail`; `src/compiler/rel/write.ts` `storedExpr`, `metaExpr`; `src/compiler/rel/list.ts`; `src/compiler/rel/const.ts` `constLit`

#### Move `emit()`/`emitQuery()` to `test/support` (`emit-to-test`)
- **Area:** emitter
- **Reach:** common
- **Problem:** `emit` has no production caller. All references to `emitQuery` are in `test/`. Each one restates `lowered()`'s `DO_BIND_CAP` check.
- **Fix:** Move both to `test/support`. Keep `renderLowered` + `renderedSteps` as the one crossing, so a future caller cannot re-emit. About 15 lines leave `src/`; SQL does not change.
- **Where:** `src/rel/emit.ts` `emit`, `emitQuery`

#### `deferralInRow(message)` beside `raiseInRow` (`deferral-in-row`)
- **Area:** in-row raises
- **Reach:** common
- **Problem:** Four sites spell `deferralExpr(MSG, {kind:'call', fn:'random', args:[]})`. These are the only `fn:'random'` constructions outside `raise.ts`. `draws` must skip exactly these arms via `isAbort`, or a valid query declines with `CopiedDraw`.
- **Fix:** Add `deferralInRow(message)` beside `raiseInRow`, next to its recogniser, so they cannot drift. SQL does not change.
- **Where:** `src/rel/raise.ts` `raiseInRow`; `src/compiler/rel/projector.ts`; `src/compiler/rel/path.ts`; `src/compiler/rel/receiver.ts`; `src/rel/copies.ts` `draws`

## 7. Needs an owner decision

Items that wait for a decision. Do not start them without one.

#### A movement-led `until` that filters a neighbourhood is quadratic at a hub (`walk-until-hub`)
- **Area:** repeat
- **Reach:** plausible
- **Problem:** The `until` test runs per frontier row. `until(in('created').has('age',gt(45)))` scans the hub's whole in-neighbourhood each time it fails: 22.8× per 8× on the hub graph. The linear form needs the condition asked once per distinct element inside the recursion. SQLite's recursive term cannot hold DISTINCT or a keyed join.
- **Fix:** Owner call. Options: a reachability pre-pass whose condition set the term joins, or decline the movement head (this retires answers on trunk).
- **Where:** `test/compiler/walk-condition-hub-scale.exec.test.ts`

#### A correlated EXISTS body asks its element test once per host (`scope-free-subterm`)
- **Area:** compile
- **Reach:** plausible
- **Problem:** `g.V().where(out().out().where(in().has('age',gt(50))))` is 48× per 8× at a hub. A magic domain there does all the work that the short-circuit skips (10.6 ms → 505 ms at 8k on a uniform out-degree-20 graph). With no statistics, neither form wins.
- **Fix:** Owner call. Accept the hub case, or find a substrate that keeps the short-circuit and shares the test. None is known on SQLite.
- **Where:** `src/rel/passes/magic.ts`

#### A set with a one-char digit and another one-char member has no exact guard (`char-digit-guard`)
- **Area:** predicates
- **Reach:** rare
- **Problem:** In `within('1','2','C')`, a Char `'C'` equals `'C'` but a Char `'1'` does not equal `'1'`. The set keeps the per-member disjunction (inline) or the exclusion-only guard (list parameter). It is unresolved whether a Char should ever equal a String.
- **Fix:** Read `vendor/tinkerpop/gremlin-core/.../util/GremlinValueComparator.java:239-275`, then decide.
- **Depends on:** tag-excludes-guard

#### Correlated equality `by()` compare (`where-eq-by-compare`)
- **Area:** compile
- **Reach:** plausible
- **Problem:** `where(V().where(eq('a')).by('name')…)` goes from 1.16 s to 79 s at 1k → 8k (round 4 Q2, S5).
- **Fix:** Owner call. Accept the cost, or make it a `propertySeek` term.

#### Magic-set sharing under `where()` EXISTS costs ordinary queries (`R6-1`)
- **Area:** compile
- **Reach:** plausible
- **Problem:** Magic-set sharing under `where()` EXISTS costs ordinary queries up to 48×. U2's selective-host residue is part of this.
- **Fix:** Owner call on the hub-versus-statistics trade-off.
- **Where:** `src/rel/passes/magic.ts`

#### Numeric string ids (`string-id-coercion`)
- **Area:** ids
- **Reach:** plausible
- **Problem:** Should a numeric string id like `'1'` address the element whose rowid is 1, as TinkerGraph's LONG id manager does? Or are ids typed, so that `'1'` names only a uid `'1'`? Today ids are typed: `V(5)` and `V('5')` can both exist (limitations "String vs integer element id" row). 8 L3 scenarios assume the LONG id manager.
- **Fix:** Either answer is one change. Coerce at `routedExternalId`/`externalIdIs`, or ledger the 8 scenarios as `divergence` with a §17 line. Fix `rf3-reuse1` (§1) under either answer.
- **Where:** `src/compiler/rel/source.ts` (`routedExternalId`, `externalIdIs`)

#### Map-key order authority (`map-key-order-authority`)
- **Area:** maps
- **Reach:** rare
- **Problem:** The SQL map-key sort uses storage order (`storedCompareOn`). A top-level map's `order(local)` uses the JS orderability barrier. The two agree for keys of one type. They can differ when keys mix booleans or dates with numbers. A review found no difference on every plausible key mix it probed.
- **Fix:** Decide yes or no on the proposal "mapEntriesLocal takes the barrier's Map arm". Yes makes SQL the one authority and adds one §17 line for mixed-type keys.
- **Where:** `storedCompareOn`; `mapEntriesLocal`

#### GraphQL schema redesign (`graphql-redesign`)
- **Area:** graphql
- **Reach:** plausible
- **Problem:** The schema is derived by reflection. That was a mistake: reflection cannot choose names, cardinality, nullability or one concrete type. See [the plan's top section](./2026-08-07-graphql-front-end-plan.md).
- **Fix:** Replace it with an explicit, human-defined schema or views, registered through an API (prior art: Neo4j GraphQL type-defs, CouchDB design-doc views). Decide: SDL plus directives, or views as traversals; storage; versioning. Then build: a `_gremlin(query:)` raw-Gremlin escape field; mutations generated from the defined schema; a measurement of bind count and statement text (100 KB) for depth-4 selections.
- **Where:** `docs/2026-08-07-graphql-front-end-plan.md`

## 8. Low priority

Real but rare, or contrived, shapes. Do them when they become cheap.

### Low priority: repeat

#### Long spine is evaluated once per reading step (`spine-eval-per-step`)
- **Area:** repeat
- **Reach:** rare
- **Problem:** A guard step and the result each re-evaluate the plain cut CTEs. The uncut plan did the same, so this is not a regression.
- **Fix:** Share one evaluation of the cut spine between its readers.
- **Where:** `boundedSpine` in `src/compiler/rel/lower.ts`

#### Recursion over shape-changing bodies is not bounded by the cut (`shape-changing-recursion-depth`)
- **Area:** repeat
- **Reach:** rare
- **Problem:** `continueAs` over a body such as `repeat(out().as('x').select('x')).times(n)` is not bounded by the spine cut. `tooDeep` is the backstop, and the decline depth depends on the runtime.
- **Fix:** Bound it like the root spine, or accept `tooDeep` as the limit.

#### Long walks reach SQLite expression depth or FROM-list caps (`long-walk-sqlite-limits`)
- **Area:** repeat
- **Reach:** rare
- **Problem:** These decline cleanly on query text; record them so nobody reads them as regressions:
  - A long walk followed by a reducing side effect hits "Expression tree is too large (max depth 1000)" at about 200 hops, with or without the cut.
  - `fold()`, `values().fold()` and `aggregate('a').cap('a').unfold()` after `times(200..1000)` hit SQLite's expression depth.
  - `…times(140).group().by('k').by(values('i').sum())` hits the FROM-list cap. The `group('a')…cap('a')` form answers.
- **Fix:** No action planned. These are SQLite statement-shape limits on query text.

#### `coin()` in a bounded repeat body (`coin-in-repeat`)
- **Area:** repeat
- **Reach:** rare
- **Problem:** `g.V(1).repeat(both().coin(0.5)).emit().times(3)` gets the generic message. `coin` is not an unrollable body step, so the random-body decline never runs.
- **Fix:** Run the random-body check before the unroll check.

### Low priority: values, lists and maps

#### Set-op error wording (`setop-null-wording`)
- **Area:** lists
- **Reach:** rare
- **Problem:** A per-row operand with no first result raises "must yield an iterable type, not null". The reference says "The provided traverser does not map to a value" (`vendor/tinkerpop/gremlin-core/.../TraversalUtil.java:41-53`).
- **Fix:** Use the reference wording.

#### Contrived shapes: build only on a user report (`contrived-shapes`)
- **Area:** mixed
- **Reach:** rare
- **Problem:** These are real gaps in shapes that no user has been seen to write:
  - `inject([a:3],[a:null]).unfold().group().by(keys).by(select(values).fold())` gives `{a:[null]}`. The reference gives `{a:[3,null]}` (`r7-fu4`).
  - `where(__.select('k').toUpper().is('AB'))` over a string label bound in nested `choose` arms raises a bare `Error: malformed JSON` (`rf3-where-armlabel-json`, `lower/filter.ts`).
  - A `project()` key equal to a live label declines: `g.V().as('name').project('name','age').by('name').by('age').select('name')`. A lift returns the entry (`cr-fu11`, `Scoping.java:119-121`).
  - Wide longs: `sum`/`min`/`mean` drop a wide constant over a varying stream. A top-level sum past 2^53 rounds: `local(union(constant(9007199254740993L), values('age')).sum())`.
- **Fix:** If a user reports one, build the generic fix.

### Low priority: sources and movement

#### Sub-path decline message after `inject` (`inject-subpath-message`)
- **Area:** inject
- **Reach:** rare
- **Problem:** `g.V(1).as('a').values('age').inject(1).path().from('a')` says "not supported" twice. `UnsupportedTraversal.because` adds its own prefix. It quotes the placeholder `from(…)` as a label when the argument is not a literal.
- **Fix:** Say "inject() adds traversers that do not carry 'a'". Suggest `select('a')`, or moving `as('a')` after `inject()`.
- **Where:** `src/compiler/compiler.ts`

### Low priority: federation, services and io

#### `call()` reading the traverser inside a child (`call-child-message`)
- **Area:** services
- **Reach:** rare
- **Problem:** `where(__.call(dc, xin, __.project('direction').by(values('name'))).is(3))` gives the generic "no lowering covers". It should say "call() parameter value traversal must be __.constant(literal)". `servicesNamedBy` swallows the scan's error.
- **Fix:** Catch parse errors only in `servicesNamedBy`.
- **Where:** `src/services/params/call-params.ts` (`servicesNamedBy`)

#### Federated local order and dedup over landed-foreign elements (`federate-local-order`)
- **Area:** federate
- **Reach:** rare
- **Problem:** `order(local)` and `dedup(local)` over landed-foreign elements are not supported.
- **Fix:** Re-source the keys via `BoundGraph`.

### Low priority: storage and runtimes

#### Clear the bulk journal in bounded chunks (`bulk-journal-chunks`)
- **Area:** storage
- **Reach:** rare
- **Problem:** `clearBulkJournal` is one DELETE.
- **Fix:** Delete in bounded chunks.
- **Where:** `src/storage.ts` `clearBulkJournal`

### Low priority: compiler internals

#### Merge guard key-set containment on a power set (`merge-guard-containment`)
- **Area:** compiler
- **Reach:** rare
- **Problem:** `searchKeying` crosses each earlier map with every present key set it contains. A batch that is a power set of k keys gives 3^k pairs over 2^k maps (N^1.58). Key names that many longer key sets share also cost N × holders. All work stays in one statement, with no binds. No real batch of this shape has been seen.
- **Fix:** Measure before any change. The pool and k-subset families measure linear: the two-pool grid `[a{i%s}:1,b{i/s}:1]` takes 128 ms at 1k maps and 863 ms at 8k; 30-entry maps scale 8.2× from 1k to 8k; a 1000-entry map takes 107 ms.
- **Where:** `src/compiler/rel/write.ts` `searchKeying`; `test/compiler/merge-scale.exec.test.ts`

### Low priority: other

#### Nested scalar `reverse()`/`split()` (`nested-reverse-split`)
- **Area:** child bodies
- **Reach:** rare
- **Problem:** Scalar `reverse()` and `split()` inside a child body do not lower.
- **Fix:** Lower them inside a child body.

#### Agent memory Phase-0 spike (`agent-memory-spike`)
- **Area:** product
- **Reach:** rare
- **Problem:** It is not measured how brute-force cosine search over in-DO vectors performs at realistic sizes ([vision](./2026-07-17-agent-memory-vision.md)).
- **Fix:** Run the spike. The rest of the work belongs in a sibling repo.

## Won't do

Do not reopen these. The user-visible ones are also in [limitations.md](limitations.md).

- **Java execution details** (merge order, raise order, write interleave, signed zero, UTF-16,
  `java.util.regex`, Java number formatting, 32-bit float). These are not semantics.
- **Per-traverser write interleave.** A write sees a snapshot of its input. Do not rebuild the guards.
- **A barrier inside unbounded `repeat`, or a per-origin slice inside it.** A recursive SQL term
  cannot hold either.
- **Global `tail` or `sample` with no encounter order.** The decline is correct.
- **A per-origin window inside a `union`/`choose` arm.** The window is global in the reference
  (`vendor/tinkerpop/gremlin-core/.../step/branch/BranchStep.java`), so the current answer is right.
- **Moving `FromItem` construction into `src/rel/block.ts`.** It would break the predict/construct
  split.
- **A map literal with traversal values (`[k: __.…]`) as a merge argument.**
- **Branch arms with different row layouts; per-traverser slices of `coalesce`/`optional` arms.**
  These decline (`test/L4-addendum/branch-arm-decline.feature`).
- **Writes after a slice where the reference stops pulling.** Past what `EarlyLimitStrategy` moves,
  these decline (`test/L4-addendum/early-limit-side-effect.feature`).
