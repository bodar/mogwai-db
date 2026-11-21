# 06 — Remaining Gremlin edge cases

**Date:** 2026-11-21. **Scope:** the reviewer's item "remaining Gremlin edge cases (improves compatibility
incrementally)", and the reviewer's claim that "a benchmark suite would do more for credibility than
another 20 supported Gremlin features". **Method:** read-only code analysis at trunk `1489c279`; the
committed test baselines; and throwaway probe scripts (not committed) that compiled and ran queries on
the `modern` graph in-process (`test/support/harness.ts` `run`). No suite was run.

**Related documents.** This report does not repeat open work items. It cites them by id from
`docs/outstanding-work.md` (OW). Step support: `docs/feature-support-matrix.md` (matrix). Accepted
differences and out-of-scope features: `docs/limitations.md`. Agent-memory gaps that are not Gremlin
features: `05-agent-memory-reference-app.md`.

**A stale pointer.** `CLAUDE.md` says matrix §17 lists "Deliberate divergences". Today matrix §17 is
"Not supported yet: rare combinations", and the divergences are in `docs/limitations.md` §3. The
expected-outcome ledger already cites `docs/limitations.md` for each divergence
(`test/L3-conformance/expected-outcomes.ts:52-55`).

## 1. Summary (Explanation)

mogwai-db answers most Gremlin that applications send. The remaining gaps are mostly rare step
combinations, a few missing steps, and two strategies. The evidence:

| Measure | Value | Source |
|---|---|---|
| L3 reachable TinkerPop scenarios that pass | 2,065 of 2,246 (91.9%) | `test/L3-conformance/l3-state.json`; matrix header |
| L3 in-scope failures, by kind | 180 decline, 14 wall, 10 divergence, 1 defect | `test/L3-conformance/expected-outcomes.ts` (counted) |
| L6 app-shaped workload queries | 305 pass, 7 declined, 0 wrong (baseline) | `test/L6-workload/baseline.json` |
| L6 declines that answer today | 3 of 7 (probe; baseline not re-recorded) | section 5 |
| Wrong answers in L3 | 1 scenario | `multilabel-edge-label`, OW `l3-ledger` |
| Explicit decline sites in `src/` | 91 `throw` sites | section 4 |
| Implicit decline sites in the lowering | 1,366 `return null` in `src/compiler/rel/` | `grep -c`; guarded by `mise run ladder` |

**On the benchmark claim, the reviewer is right.** Section 6 gives the reasoning. In short: the
remaining Gremlin gaps touch about 1% to 2% of application-shaped queries (L6), and each fix raises L3 by
one to seven scenarios. There is no comparative benchmark at all. So a benchmark answers a question that
no current artefact answers, while another 20 features move a number that is already above 90%.

One qualification: OW §1 lists 33 open wrong-answer items. Wrong answers matter more than either new
features or benchmarks. They are out of this report's scope; see `docs/outstanding-work.md` §1.

## 2. Gap reference, grouped by cause (Reference)

"L3" is the number of ledgered L3 scenarios for the gap. "Impact" is an estimate of how often real
application Gremlin meets the gap: **common**, **plausible** or **rare**. Where OW gives a "Reach", the
table uses it. Where it does not, the estimate is **inferred** from the L6 corpus and the TinkerPop
recipes, and is marked (i).

### 2.1 Missing step or step form

| Gap | Trigger | L3 | Impact | Status | Tracking |
|---|---|---|---|---|---|
| `to(Direction, …)`, `toE(Direction, …)` | `g.V(1).to(Direction.OUT,'knows')` | 2 | rare (i): new in TinkerPop 4, `out()`/`outE()` say the same | missing | OW `step-vocabulary`; ledger `to-direction-step` |
| `index()` | `g.V().values('age').index()` | 5 | plausible (i): needed for list zip, so also for vector maths | missing | OW `rel-blocker-families`; ledger `index-step` |
| `tree('k')` side-effect form, a step after `tree()` | `g.V().out().out().tree('a').cap('a')` | 7 | rare (i) | partial (`tree()` works) | OW `step-vocabulary`; ledger `tree-step` |
| `subgraph('k')` | `g.V().outE('knows').subgraph('sg').cap('sg')` | 7 | plausible (i): a common export idiom on TinkerGraph | missing | OW `step-vocabulary`; ledger `subgraph-step` |
| Meta-property stream | `g.V().properties('name').properties()` | 7 | rare | missing | OW `o-propstream`; ledger `property-stream` |
| `propertyMap()` | `g.V().propertyMap()` | 0 | rare (i) | missing | matrix §17 only; **untracked in OW** |
| `withSack(seed, Operator)` | `g.withSack(1, sum).V().sack()` | 0 | rare | missing | OW `step-vocabulary` |
| `coin(p)` | `g.V().coin(0.5).count()` | 0 | rare (i) | missing | OW `ladder-depth-gaps`, `coin-in-repeat` |
| `split()` local, over a list, in a child | `g.V().values('name').flatMap(split('a').unfold())` | 4 | plausible (i) | partial | OW `o-split`, `nested-reverse-split`; ledger `split-residue` |
| `regex`/`notRegex` in `is()`, `where()`, `match()` | `g.V().values('name').is(regex('m.*'))` | 0 | plausible (i) | partial (`has(k, regex)` works) | matrix §17 only; **untracked in OW** |
| `tinker.search` with `regex` or a term under 3 characters | `call('tinker.search',[search:'te'])` | 0 | rare | missing (by design) | matrix §13; `src/services/catalog/search.ts:50`, `:55` |
| `hasLabel(P)` | `hasLabel(TextP.startingWith('p'))` | 0 | rare | missing | OW `haslabel-predicate` |
| GDS parameters (`maxIterations`, `tolerance`, …) | `call('pageRank').with('maxIterations',5)` | 0 | plausible | missing | OW `gds-params` |

### 2.2 Missing modulator or option form

| Gap | Trigger | L3 | Impact | Status | Tracking |
|---|---|---|---|---|---|
| `valueMap(keys).by(…)` | `g.V().valueMap('name','age').by(__.unfold())` | 2 | **common** (i): the TinkerPop 4 replacement for `unfold()`ing each value; in L6 | missing | ledger `uncovered-composition`; **no OW id** |
| `valueMap().with(WithOptions.tokens, …)` with a `by()` | `valueMap('name','age').with(WithOptions.tokens, WithOptions.ids).by(__.unfold())` | 2 | plausible (i) | partial (`with(tokens)` alone works) | ledger `uncovered-composition` |
| `addV`/`addE` with `with()` options or traversal arguments | `addE(__.V()….label()…).from(…)` | 7 | rare | partial | OW `rel-blocker-families`; ledger `add-element-residue` |
| Body-keyed `choose`/`branch` with `option()` | `choose(label).option('person', choose(age).option(P.lt(30),…))` | 1 | plausible | partial | OW `body-keyed-choose` |
| `sample(n).by(k)` followed by a step | `g.V().sample(1).by('age').count()` | 1 | rare | partial | OW `weighted-sample-otherv` |
| `emit(…)` whose condition sorts and slices | `emit(order().by(k).limit(1)…)` | in `repeat-shape` | rare | missing | OW `emit-any-head` |

### 2.3 Composition limit (a supported step in an unsupported position)

| Gap | Trigger | L3 | Impact | Status | Tracking |
|---|---|---|---|---|---|
| Write inside a child body | `sideEffect(__.property('x',1))`, `map(__.addV('y'))` | 1+ | **common** (i): `sideEffect(property)` is a frequent idiom | missing | OW `s3-write-in-child` |
| Batch write with per-row values | `inject(rows).unfold().mergeV()`, `inject(xs).as('x').addV().property(k, select('x'))` | 2+ | **common** | missing | OW `R8-res` (top write candidate), `inject-label-addV`, `inject-unfold-nested` |
| `mergeV`/`mergeE` beyond covered drivers | `mergeV(__.select('m').limit(local,1).unfold())`, map-driver `mergeE` with `option(Merge.outV)` | 12 | plausible | partial | OW `merge-residue`; ledger `merge-residue` |
| `path()` read as a value | `project(…).by(__.path().by('name'))`, `path().group()`, `path().order()` | 8 | **common** (i): `by(path())` is in L6 | partial | OW `path-as-value`; ledger `path-value` |
| `where()`/`is()` with a traversal or label operand | `where(gt(__.V(1).values('age'))).by('age')` | 11 | plausible | partial | OW `labels-scope`, `element-operand-compare`; ledger `where-predicate` |
| Edge test on the far end | `g.V(1).bothE().where(__.otherV().hasId(2))` | 0 | **common** (i): the "edge between two vertices" recipe; in L6 | missing | **no OW id** |
| Multi-label `as()` then `select(…).by(…).by(…)` over a fold | `fold().as('a','c').select('a','c').by(range(local,0,2)).by(count(local))` | 0 | plausible (i): the pagination recipe; in L6 | missing | **no OW id** |
| `union()` as a source or with a reducing arm | `union(count())`, `g.union(V().out(), V().hasLabel(…)).path()` | 7 | rare | partial | OW `source-union`; ledger `union-residue` |
| `select()` over `Pop`, `Column` or traversal keys | `select(all, constant('a'))` | 5 | rare | partial | OW `rel-blocker-families`; ledger `select-residue` |
| `repeat()` body and modulator compositions | `repeat(dedup().both()).times(2)`, nested `repeat` with `until(repeat(…))` | 24 | plausible | partial | OW `repeat-residue`, `emit-any-head`, `repeat-branch-fanout`; ledger `repeat-shape` |
| Side effects in a child or a branch | `local(aggregate('a').cap('a'))`, `group('m').by().by(bothE().count())` then `select` | 24 | plausible | partial | OW `keyed-group-arm-hosts`, `group-depth-gaps`, `effect-in-child`; ledger `group-side-effect` |
| `values(k).unfold()` over a list- or map-valued property | `g.V().values('emb').unfold()` | 0 | plausible (i) | missing | OW `per-row-node-vocabulary-closed` |
| Set operations between a value list and an element list | `values('name').combine(V().fold())` | 4 | rare | missing | OW `o-setop-mixed`; ledger `set-op-operand` |
| `inject()` of a set literal | `g.inject({1,3})` | 3 | rare | missing | OW `inject-set-literal`; ledger `inject-residue` |
| `match()` residue | `g.V().valueMap().match(as('a').select('name').as('b'))` | 2 | rare (`match()` is deprecated in TinkerPop 4) | partial | OW `match-residue` |
| `discard()` before a barrier | `project('x').by(coalesce(…, discard()))` | 1 | rare | partial | OW `discard-then-reduce` |
| Federation forms | `federate` with a parameter edge label, `order()` over the bound stream | 0 | rare | partial | OW `federate-residue` |

### 2.4 Type system

| Gap | Trigger | L3 | Impact | Status | Tracking |
|---|---|---|---|---|---|
| `datetime` parameter | `g.inject(ts)`, `property('t', ts)`, `has('t', lt(ts))` with a `Date` parameter | 0 | **common** (i): every time-stamped application | missing (probe, in-process) | **untracked** |
| `is(typeOf(LIST\|SET))` over a list framing | `fold().is(typeOf(GType.LIST))` | 5 | rare | partial | OW `typeof-list-framing` |
| Exact decimal arithmetic | `bigdecimal` math | 0 | rare | missing | OW `exact-decimal`; `docs/limitations.md` §2 |
| Sack type and operator residue | `withBulk(false)`, `barrier(normSack)` | 5 | rare | partial | OW `o-sack`, `normsack-ignored` |
| Map or set equality | `has(k, [a:1])` | 0 | rare | missing (by design) | `docs/limitations.md` §2 |
| NaN literal as a value | `inject(NaN)` | 6 | rare | wall | `docs/limitations.md` §2; ledger `nan-literal` |

### 2.5 Strategies

| Gap | Trigger | L3 | Impact | Status | Tracking |
|---|---|---|---|---|---|
| `SubgraphStrategy(vertexProperties:)`, or over a write | `withStrategies(new SubgraphStrategy(vertexProperties: …))` | 6 | rare | missing | OW `strategies-residue`; `src/compiler/ir/strategies.ts:405`, `:415` |
| `PartitionStrategy` with `mergeV`/`mergeE` or `includeMetaProperties` | `withStrategies(new PartitionStrategy(…)).mergeV(…)` | 7 | plausible (i): multi-tenant users of one graph | missing | OW `merge-residue`; `strategies.ts:467`, `:469` |
| `ElementIdStrategy`, `ReferenceElementStrategy`, other semantic strategies | `withStrategies(ElementIdStrategy)` | 2 | rare | rejected | OW `strategies-residue`; matrix §15 |
| `ProductiveByStrategy` on an unsupported `by()` host | `withStrategies(ProductiveByStrategy)…` | 1+ | rare | partial | `strategies.ts:153` |

### 2.6 Deliberate divergence, wall and out of scope

These are not gaps to close. They are listed so the reader can see the whole failing set.

| Class | Count in L3 | Where it is stated |
|---|---|---|
| Divergence: string id is not the integer it spells | 8 | `docs/limitations.md` §3 "Writes" |
| Divergence: `merge()` error wording; eager onCreate check | 2 | `docs/limitations.md` §3 "Errors" |
| Wall: GraphML, Gryo | 4 | `docs/limitations.md` §1 |
| Wall: `withoutStrategies(ConnectiveStrategy)`, graph-computer strategies, vertex-property ids, list default cardinality | 4 | matrix §15, §16; `src/api.ts` `DEFAULT_VERTEX_CARDINALITY` |
| Out of scope: barrier inside unbounded `repeat`, `tail`/`sample` with no order, branch arms with different row shapes | 0 (decline) | `docs/limitations.md` §1; OW "Won't do" |

## 3. Why each class exists (Explanation)

**Missing steps.** The compiler lowers each step into a relational algebra (`src/rel/`). A step with no
lowering has no SQL form yet. Most missing steps are new in TinkerPop 4 (`to()`, `index()`), produce a
non-stream structure (`subgraph`, `tree('k')`), or need row-at-a-time work that SQLite cannot express
without a user-defined function (`regex` outside `has()`). Durable Object SQLite has no user-defined
functions, and the project does not filter in JavaScript (`.claude/rules/wire-protocol.md`).

**Missing modulators.** A `by()` or `with()` is a child traversal or an option on a host step. The host
step reads it through the child seam. Where the host has no connector row and no tail lowering for that
`by()`, it declines (`src/compiler/CLAUDE.md`, "the scoped-relation connector"; L9 `deferred-hosts.ts`).

**Composition limits.** Each step works alone, but one combination has no route. The connector made
nesting depth mostly irrelevant (`docs/archive/2026-11-16-ladder-retirement-plan.md`). The remaining
limits sit where a value crosses a scope with no carrier: a write in a child (no write lowering inside a
decorrelated body), a path used as a value, a per-row value from an unfolded map driving a write.
`src/compiler/unsupported.ts:9-56` names these classes as decline kinds.

**Type system.** SQLite has five storage classes. mogwai-db carries Gremlin's types beside each value
(`vtype`). A gap appears where a value enters without that type: a parameter whose type node does not
reach the lowering (the `datetime` case), a list framing with no GType, or a NaN that SQLite stores as
NULL.

**Strategies.** A strategy rewrites the traversal before it runs. mogwai-db applies three, checks four,
ignores the ones that do not change answers, and rejects the rest (matrix §15). A rejected strategy would
change the answer, so ignoring it would be a wrong answer. The project fails closed instead.

**Divergences and walls.** These follow two rules in `CLAUDE.md`: "a faithful port, mechanically
sympathetic to SQLite and JS", and "the reference is the authority on WHAT a query means, not on HOW Java
executes it".

## 4. Explicit decline sites (Reference)

Every `throw` of `UnsupportedTraversal` (or a subclass) in `src/`, found by
`grep -rn "new UnsupportedTraversal\|UnsupportedTraversal.because"` plus the subclass constructors.
Lines are at trunk `1489c279`.

The 1,366 `return null` sites in `src/compiler/rel/` are not listed. Each one is a lowering that does not
cover a shape. When every route returns `null`, `Declines.uncovered` raises the generic message "no
lowering covers <query>" (`src/compiler/unsupported.ts:280-286`). `mise run rel-blockers` ranks them by
family. `mise run ladder` stops the count from rising.

### 4.1 Compiler front and whole-query checks

| Site | Query shape that triggers it |
|---|---|
| `src/compiler/compiler.ts:110` | a `repeat()` unrolled to a large count, or children nested hundreds deep (stack depth) |
| `src/compiler/compiler.ts:122` | a terminal method the step walk cannot see (`next()`, `toSet()`) |
| `src/compiler/compiler.ts:133` | a traversal source with no steps (`g`) |
| `src/compiler/compiler.ts:145` | a `where(P)` key that cannot resolve as the reference resolves it |
| `src/compiler/compiler.ts:150` | a path label shadowed by a side effect with the same name |
| `src/compiler/compiler.ts:156` | `path().from(k)`/`to(k)` where `k` may be absent or out of order |
| `src/compiler/compiler.ts:159` | a NaN literal as a value |
| `src/compiler/compiler.ts:162` | a map or set as an equality operand or merge key |
| `src/compiler/unsupported.ts:98`, `:269`, `:283` | the decline builders (`because`, `terminalError`, `uncovered`) |
| `src/compiler/ir/passes.ts:429` | `withoutStrategies(ConnectiveStrategy)` |
| `src/compiler/ir/passes.ts:439` | a rejected strategy (matrix §15 "Rejected") |
| `src/compiler/ir/step.ts:467` | a slice count that is not an exact 64-bit long |
| `src/compiler/ir/step.ts:502`, `:504` | `sample()` count past 32 bits; `tail()` with a negative count |
| `src/compiler/ir/strategies.ts:153` | `ProductiveByStrategy` with an unsupported `by()` host |
| `src/compiler/ir/strategies.ts:405`, `:415` | `SubgraphStrategy(vertexProperties)`; `SubgraphStrategy` over a write |
| `src/compiler/ir/strategies.ts:467`, `:469` | `PartitionStrategy(includeMetaProperties)`; `PartitionStrategy` with `mergeV`/`mergeE` |
| `src/compiler/ir/strategies.ts:2027` | a bounded `repeat` unroll past the compile budget |
| `src/compiler/ir/strategies.ts:2125` | `repeat()…emit()` over a body that draws at random |
| `src/compiler/ir/strategies.ts:2168` | `repeat()…times(n)` with an `emit()` that reads `loops()` other than `loops().is(n)` |
| `src/compiler/ir/strategies.ts:2437` | `where(__.as('x'))` on a label no earlier `as()` binds |
| `src/channels.ts:266`, `:272` | branch arms that bind different carried state (sack, path, labels) |

### 4.2 Lowering and SQL limits

| Site | Query shape that triggers it |
|---|---|
| `src/compiler/rel/segment.ts:362`, `:370` | `federate` in a branch arm that returns values, or one element twice |
| `src/compiler/rel/segment.ts:532`; `src/compiler/rel/barrier-value.ts:75`, `:116`; `src/compiler/rel/order-dedup-local.ts:220` | a step after a barrier (`regex`, `split`, a value barrier, `order(local)`) that the resume cannot lower (`ResumeGap`) |
| `src/compiler/rel/segment.ts:748`, `:765`, `:792` | a step after a barrier `call()` over a federated or detached result |
| `src/compiler/rel/segment.ts:803`, `:815` | a `federate` sub-traversal that reads `select()` and ends in a value or mixed elements |
| `src/compiler/rel/boundgraph.ts:441`, `:459` | `federate` in a branch arm under a parent stream; a merged read with no landed graph |
| `src/compiler/rel/orderability.ts:95`, `:167`, `:178`, `:203` | an `order()` comparison of a value the comparator cannot classify |
| `src/compiler/rel/regex.ts:124` | a `regex()` pattern JavaScript cannot parse |
| `src/sql/kernel/budget.ts:78`, `:155` | SQL text past the compile budget (`CompileBudgetExceeded`) |
| `src/sql/kernel/budget.ts:194`; `src/rel/emit.ts:293` | more than 64 tables in one SELECT (`JoinWidthExceeded`) |
| `src/sql/kernel/budget.ts:213`; `src/rel/passes/name.ts:117` | a random draw that more than one branch reads (`CopiedDraw`) |
| `src/sql/kernel/q.ts:354` | a string constant with a NUL or a lone surrogate |
| `src/storage.ts:37`, `:40` | a statement past SQLite's text or shape limit at run time |

### 4.3 Values and parsing

| Site | Query shape that triggers it |
|---|---|
| `src/gremlin/frontend.ts:901`, `:931`, `:939`, `:943` | a map literal with mixed-type keys, a collection key, a numeric key, or a `null` key |
| `src/gremlin/coerce.ts:464`, `:467`, `:481` | `dateAdd()` past 32 bits or past the date range; a date outside ±8.64e15 ms |
| `src/gremlin/types.ts:55` | a number that cannot be a BigDecimal |
| `src/gremlin/types.ts:782` | an enum value inside a stored collection |
| `src/gremlin/float.ts:129` | a non-finite number framed as BigDecimal |
| `src/gremlin/math.ts:115` | a `math()` formula the parser rejects |
| `src/json-exact.ts:68`, `:82` | a raw bigint, or an infinity on a runtime with no `JSON.rawJSON` |
| `src/gremlin/gql.ts:95`, `:127`, `:171`, `:225`, `:261`, `:292`, `:327` | GQL `match()` string forms: two labels on one variable, an unknown edge form, an unknown property value, an undirected edge with a variable, an empty pattern, a terminal pattern with no variable |

### 4.4 Services, federation and execution

| Site | Query shape that triggers it |
|---|---|
| `src/services/catalog/search.ts:50`, `:55` | `tinker.search` with `regex`; a term under 3 characters |
| `src/services/params/call-params.ts:65`, `:77`, `:85` | a `call()` parameter traversal other than `__.constant(…)` or `__.project(…).by(__.constant(…))` |
| `src/services/catalog/federate.ts:42`, `:56`, `:59`, `:206` | `federate` without `graph` or `traversal`, a traversal not rooted at `V()`/`E()`, an unmatched per-parent `select()` |
| `src/services/params/federation-depth.ts:30` | a cyclic or too-deep federation |
| `src/services/catalog/io.ts:85`, `:87` | `io()` with GraphML or Gryo |
| `src/services/catalog/olap/kernel.ts:51`, `:57`, `:170` | an OLAP `edges` scope other than one `outE`/`inE`/`bothE`; a mode other than decorate |
| `src/services/catalog/olap/wcc.ts:48` | `wcc` with a directed edge scope |
| `src/services/catalog/olap/betweenness.ts:50` | `betweenness` with `bothE` |
| `src/services/catalog/olap/shortest-path.ts:35`, `:62` | `shortestPath` with a non-vertex target, or a mode other than path |
| `src/services/catalog/degree-centrality.ts:64`, `:66` | `tinker.degree.centrality` not called mid-traversal on vertices |
| `src/foreign-decode.ts:108` | a GraphBinary type the HTTP federation decoder does not know |
| `src/execute.ts:594`, `:596` | a replication filter that writes, or does not yield vertices |
| `src/execute.ts:631` | a federated sub-traversal that writes |

### 4.5 Recorded decline reasons (advisory or terminal)

The lowering records a reason instead of throwing, then `compilePlan` reads it
(`src/compiler/unsupported.ts:216-287`, `Declines`).

| Kind | Site | Shape |
|---|---|---|
| `resource-path` | `src/compiler/rel/lower/scoped.ts:267`, `:304` | `V()`/`E()` in a child on a traverser whose path is tracked |
| `resource-reads-host` | `scoped.ts:283` | a re-sourcing child that reads the host's state after `V()` |
| `shared-draw` | `scoped.ts:348`, `:483`; `src/compiler/rel/lower/reduction.ts:694` | a random draw shared by several hosts |
| `effect-in-child` | `scoped.ts:536` | a side effect in a child that the same child reads |
| `hub-in-walk-term` | `scoped.ts:851` | an `until()` that scans a neighbourhood every loop |
| `draw-in-group-value` | `scoped.ts:2558` | a random draw in a `group()` value `by()` |
| `resource-under-absent` | `reduction.ts:1289` | `V()` in a child after a value some rows do not have |
| `write-in-filter`, `write-in-child` | `src/compiler/rel/lower.ts:5040`, `:5069`, `:5070` | a write inside a filter or any other child |
| `write-on-path` | `lower.ts:5052` | a write on a traverser whose path is tracked |
| `merge-map-scope`, `merge-own-entry` | `lower.ts:7085` | a merge `select(k)` over maps that may hold `k` |
| `map-key-collision` | `lower.ts:2015` | `select(k)` over maps that may hold `k` while a label or side effect `k` exists |
| `inject-in-child` | `lower.ts:6000` | `inject(x)` inside a child traversal |

## 5. Workload evidence (Reference)

L6 is 312 app-shaped queries from the owner's seed list, TinkerPop recipes and *Practical Gremlin*
(`test/L6-workload/workload.test.ts:1-12`). Its baseline lists 7 declines. A probe ran each on the
`modern` graph at `1489c279`.

| L6 id | Query | Probe result | Tracking |
|---|---|---|---|
| `seed-29` | `sideEffect(__.out('created').aggregate('x')).cap('x').unfold().dedup()` | answers | baseline stale |
| `rec-sack-mult` | `withSack(1.0d).V(1).repeat(__.outE().sack(mult).by('weight').inV()).times(2).sack()` | answers | baseline stale |
| `app-sack-path-weight` | `withSack(0.0d)….repeat(…sack(sum).by('weight')…).times(2).project('to','w')…` | answers | baseline stale |
| `rec-pagination-total` | `fold().as('persons','count').select('persons','count').by(__.range(local,0,2)).by(__.count(local))` | declines | **no OW id** |
| `rec-between-vertices` | `V(1).bothE().where(__.otherV().hasId(2)).values('weight')` | declines | **no OW id** |
| `app-software-valuemap` | `valueMap('name','lang').by(__.unfold())` | declines | **no OW id** |
| `app-project-path` | `project('software','path').by('name').by(__.path().by('name'))` | declines | OW `path-as-value` (family) |

So at most 4 of 312 L6 queries decline today (98.7% answer), **inferred** from the probe, not from an
L6 run. The 3 now-answering queries need `mise run workload-record`. That is the owner's step.

## 6. Benchmark or more features? (Explanation)

The reviewer says a benchmark suite would do more for credibility than 20 more Gremlin features. The
evidence supports the claim.

**The feature curve is flat.** L3 is at 91.9% of reachable scenarios. The largest open L3 families are
`repeat-shape` and `group-side-effect`, 24 scenarios each, and both are many small shapes, not one step.
Twenty more features would add perhaps 20 to 60 scenarios, which is 1% to 3% of L3. On L6, the
application-shaped corpus, the ceiling is at most 4 queries away.

**Some gaps still matter more than a benchmark.** Six gaps in section 2 are marked **common**: writes in
a child (`s3-write-in-child`), batch writes (`R8-res`), `valueMap(…).by(…)`, the far-end edge test, path
as a value in `by()`, and the `datetime` parameter. These are what an adopter types in the first hour.
Each one is a reason to drop the product, so each one is worth more than a generic feature. They are not
"another 20 features"; they are about 6.

**No comparative benchmark exists.** The repository measures performance against itself: the SQL plan
gate (`mise run sql-plan`), the hygiene gate (`mise run sql-hygiene`), scaling tests such as
`test/performance.test.ts`, and the compile-cost report. OW §2 lists 57 performance items, each measured
against the previous commit. Nothing compares mogwai-db with TinkerGraph, JanusGraph, Neo4j or a
competitor on the same queries and data. An adopter cannot answer "is it fast enough for me?" from the
repository. A benchmark answers that question; more features do not.

**What a credible benchmark needs (inferred, not a plan).** The L6 corpus already holds 312 queries with
TinkerGraph goldens over `air-routes` and the TinkerPop graphs. The same corpus, timed on mogwai-db (Bun
and `wrangler dev`) and on TinkerGraph (the golden generator already runs it in Docker,
`scripts/workload-goldens/generate.ts`), would give a like-for-like table with correctness already
checked. The LDBC Social Network Benchmark is the recognised external option; it is larger work.

**Recommendation.** Close the six **common** gaps first. Build the benchmark next, from the L6 corpus. A
separate plan for the benchmark is `docs/2026-11-21-benchmark-suite-plan.md` (written in parallel; not
reviewed here).
Then return to the long tail, ranked by `mise run rel-blockers`.

## 7. Untracked — proposed for outstanding-work.md

These gaps have no item in `docs/outstanding-work.md`. This report does not edit that file.

| Proposed id | Area | Reach | Problem | Evidence |
|---|---|---|---|---|
| `datetime-param` | values | common | A `datetime` parameter declines in `property(k, ts)`, `has(k, lt(ts))`, `inject(ts)` and a `mergeV` map. A `datetime(…)` literal answers. No L3 scenario sends one. | probe, in-process `compile(q, {ts: Date}, undefined, {ts: 'datetime'})`; not checked through a GLV |
| `json-map-binding` | wire | common | A JSON request's object binding stays a plain object, so `call(name, p)` and `mergeV(m)` fail or decline. The GraphBinary path sends a `Map`. | `src/wire.ts:135-146`; `src/services/params/call-params.ts:104`; report 05 §4.3 |
| `json-error-body` | wire | plausible | A JSON-negotiated request that fails gets a GraphBinary error body. A JSON client cannot read the message without a GraphBinary decoder. | `src/http.ts:49-53` |
| `valuemap-by` | modulators | common | `valueMap(keys).by(__.unfold())` declines. | L6 `app-software-valuemap`; L3 `g_V_valueMapXname_ageX_withXtokens_*X_byXunfoldX` |
| `where-otherv` | filters | common | `bothE().where(__.otherV().hasId(x))` declines. | L6 `rec-between-vertices` |
| `multi-as-select-by` | paths and labels | plausible | `fold().as('a','b').select('a','b').by(range(local,…)).by(count(local))` declines. | L6 `rec-pagination-total` |
| `regex-in-is-where` | filters | plausible | `regex`/`notRegex` in `is()`, `where()`, `match()` declines; matrix §17 lists it but OW has no item. | matrix §17 "Filter"; probe |
| `propertymap` | read element data | rare | `propertyMap()` declines; matrix §17 lists it but OW has no item. | probe |
| `l6-baseline-stale` | tests | — | 3 baselined L6 declines now answer; the baseline needs `mise run workload-record`. | section 5 |

## Glossary

| Term | Meaning here |
|---|---|
| decline | A clear `UnsupportedTraversal` error. The query does not run and returns no partial answer. |
| divergence | An accepted difference from Java TinkerPop, listed in `docs/limitations.md` §3. |
| wall | A capability the project declares it does not have, such as a file format. |
| L3 | The TinkerPop conformance corpus, run as cucumber scenarios. |
| L6 | 312 application-shaped queries with TinkerGraph goldens. |
| ledger | `test/L3-conformance/expected-outcomes.ts`: every failing in-scope L3 scenario with its kind. |
| lowering | The step that turns the Gremlin step list into relational algebra, then SQL. |
| OW | `docs/outstanding-work.md`. |
| reachable | In scope and not a wall or a divergence. |
| (i) | Inferred impact: an estimate, not a measurement. |
