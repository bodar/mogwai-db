# mogwai-db — feature support matrix

**A living, honest map of what the compiler supports.** Not a conformance gate, not
a roadmap — a scannable "can I use this step, and if only partly, where's the edge?"
reference. Grouped into tables by traversal concern.

**Last synced:** 2026-07-15 · **live L3 conformance:** 867 · **corpus parse+chain:**
2298/2298 (100%). Sourced from the actual dispatch maps (`src/steps/*.ts`) and the
`throw` sites in the compiler — if the code defers it, this file says so.

> **How to keep this true.** When a step's support changes, update its row here in the
> same commit. The deferral notes below are paraphrased from real `throw` messages —
> grep `src/` for `not yet supported` / `not supported` / `step not implemented` to
> find the authoritative text.

## Legend

| Mark | Meaning |
|---|---|
| ✅ | **Full** — supported across its normal forms |
| 🟡 | **Partial** — common forms work; specific shapes deferred (see note) |
| ❌ | **Deferred** — not yet compiled; throws a clear error (a named future bet) |
| 🚫 | **Out of scope** — a locked non-goal (lambdas / OLAP / multi-request tx) |

The throughline for every ❌: it **fails closed** with a clear message, never silently
under-executes. That honesty is the point of this table.

**Notes convention.** Within a Notes cell, each line is one clause: a ✅ bullet is a
**supported** form, a ❌ bullet is a **deferred** shape (fails closed). Rows that are
wholly ❌/🚫 give the deferral reason as a single plain line.

---

## 1. Sources & movement

| Step | Status | Notes |
|---|:--:|---|
| `V()`, `V(id…)` | ✅ | ✅ id resolves numeric rowid **or** string `uid` |
| `E()`, `E(id…)` | ✅ | |
| `inject(…)` | ✅ | ✅ shaped source: ordinary args → ScalarStream; all-array args → ListStream (§9)<br>✅ later scalar inject appends relationally, so position-sensitive filters/reducers compose<br>❌ appending a list to an existing scalar stream (needs a mixed-shape row discriminant) |
| `out`/`in`/`both` | ✅ | ✅ covering-index hops, index-only, sub-ms at 1M edges |
| `outE`/`inE`/`bothE` | ✅ | ✅ flips the typed id-relation to edge |
| `outV`/`inV`/`bothV` | ✅ | ✅ flips edge → endpoint vertex |
| `otherV` | ✅ | ✅ the endpoint away from the entering vertex (a carried `fromV`, gated on chain use — no hot-path cost otherwise) |
| `outV`/`inV`/`bothV` | ✅ | ✅ flips back to node |

## 2. Filters & predicates

| Step | Status | Notes |
|---|:--:|---|
| `hasLabel`, `has(k)`, `has(k,v)`, `has(k,P)` | ✅ | ✅ ANY-match `EXISTS(vertex_properties…)` (multi-property has), rides the static `vp_key_value` covering index (W4 — key binds, no splice) |
| `has(label,k,v)`, `has(T.label/T.id, v/P)` | ✅ | ✅ the cucumber verification idiom |
| `hasId(…)` | ✅ | ✅ flattens list args |
| `is(P)` | 🟡 | ✅ relational scalar filter, including after transforms, reducers, and position-sensitive `limit`/`range`/`skip` chains<br>❌ after `path()` |
| `where(__.…)` | 🟡 | ✅ single- & multi-hop (`compileExistsChain`)<br>✅ `where(__.label()/not())`<br>✅ alias-rooted `where(__.as('x')…)`<br>❌ `both()` multi-hop<br>❌ edge-typed hops |
| `where(P)` / `where('a',P)` | 🟡 | ✅ alias-column compare (P2a)<br>❌ some `where(P.op)` alias forms<br>❌ `where().by(key)` on an edge-typed label |
| `and`, `or`, `not`, `filter(__.…)` | ✅ | ✅ `and`/`or`/`not`, `filter(traversal)`<br>❌ `filter(predicate)` (non-traversal) — use `filter(traversal)` |
| `P` predicates (eq/neq/lt/gt/within/without/between/inside/outside) | ✅ | ✅ `between` is `[lo,hi)` (two comparisons, not SQL `BETWEEN`) |
| **TextP** (startingWith/endingWith/containing + negations) | ✅ | ✅ bound `LIKE`/`NOT LIKE`, pattern escaped |
| **TextP regex** (`regex`/`notRegex`) | 🚫 | **Unimplementable in SQL.** Stock SQLite only *reserves* the `REGEXP` operator (needs a `regexp()` UDF that ships with no implementation — verified `no such function: REGEXP` on bun:sqlite 3.53.0); DO SQLite exposes no `sqlite3_create_function` and blocks `load_extension`, so the UDF can't be supplied. A post-SQL JS filter would violate locked #3. (The `regexp_*` funcs in CF docs are **R2 SQL**, a different engine, not DO SQLite.) `LIKE`-expressible forms — startingWith/endingWith/containing — are ✅ above; only true regex is out |
| `typeOf(GType)` over a **stored property** | ❌ | SQLite storage class can't distinguish bool/datetime/uuid from int/text — needs a storage type-tag scheme |
| `dedup()` | 🟡 | ✅ bare `dedup()`<br>❌ `dedup(label)`<br>❌ `dedup()` after `as()` / with path tracking (path-distinct semantics) |
| `identity()` | ✅ | |

## 3. Projections & element data

| Step | Status | Notes |
|---|:--:|---|
| `values(k…)` | ✅ | |
| `id()`, `label()`, `count()` | ✅ | ✅ ids frame as `COALESCE(uid,id)` |
| `valueMap`, `elementMap` | ✅ | ✅ custom vertex/edge framing (client serializer hardcodes empty props) |
| `properties(k…)` [`.key`/`.value`/`.element`/`.id`/`.label`/`.count`] | ✅ | ✅ relational PropertyStream with explicit owner/key/value/meta payload + carried state<br>✅ `.key`/`.value`/`.id` retype to ScalarStream; later scalar filters/order/range/reducers/fold compose<br>✅ `.element()` retypes to the owner vertex **or edge** stream; later element steps compose<br>✅ real VP id + meta framed; `has(metaKey)`/`hasKey`/`hasValue`/`.properties()`(meta)/`valueMap`(metaMap)<br>❌ property-stream `dedup()`/`order()` before a projection |
| `select('a')`, multi-`select`, `project(…)` | 🟡 | ✅ column-threaded aliases<br>✅ single-label `select` retypes to an element (vertex/edge) or ScalarStream under `by(key)`; later steps compose<br>✅ multi-`select`/`project` lower to a heterogeneous per-traverser RecordStream (scalar/vertex/**edge** fields); selecting a field re-enters ordinary scalar/element lowering, and `count()` composes<br>✅ `limit`/`range`/`skip`/`tail` with `Scope.local` slice record fields<br>❌ record `order`/`dedup`/`fold`/`where`, traversal-valued `by()` |
| `select(Column.values/keys)` | 🟡 | ✅ a rich GroupStream derives the narrow MapStream entry layout for scalar/count/sum and neighbour-list values + element/scalar keys; list-valued maps (`by(__.<move>()…fold())`) become list-of-lists<br>✅ over a scalar-only RecordStream: one list per record, then ordinary list/unfold lowering<br>❌ heterogeneous element-valued record lists, element-VALUE group maps, Map-unfold (→Map.Entry), raw Map params |
| **chained projections** (`values().count()`, `project().select()`) | 🟡 | ✅ scalar projections retype to a physical ScalarStream; transforms, filters, ordering/range, and numeric reducers then lower one relational step at a time<br>✅ RecordStream fields retype to scalar/element/list streams<br>❌ `valueMap().select()` and other legacy structured values still hit compatibility boundaries |
| `order()` [`.by(key[,dir])`] | 🟡 | ✅ tail modifier<br>❌ `order()` after `path()`<br>❌ `order().by(key)` on a scalar stream |
| `limit`, `range`, `skip` | ✅ | ✅ CTE mid-chain, tail-modifier after `order()`<br>✅ `Scope.local` slices RecordStream fields |
| `by(…)` modulator | ✅ | ✅ only as an `order`/`select`/`project`/`group`/`groupCount`/`path`/`math` modulator |

## 4. Aggregation & barriers

| Step | Status | Notes |
|---|:--:|---|
| `group`, `groupCount` | 🟡 | ✅ always lowers to a rich GroupStream (same semantic relation terminal or followed)<br>✅ scalar reducers → SQL `GROUP BY`; element values → ordered-stream + handler fold<br>✅ `select(Column.*)` derives MapStream only for layouts it can consume<br>❌ >2 `by()` modulators<br>❌ `by(T.x)` key<br>❌ deep nested-`by()` chains |
| `fold()` | ✅ | ✅ scalar fold is a relational ListStream even when terminal; uniform scalar item tags survive materialization/unfold<br>✅ element fold retains the element-framing path |
| `sum`, `min`, `max`, `mean` | ✅ | ✅ relational ScalarStream with explicit `(v,vt)` payload, so filters/range can follow without losing runtime numeric framing<br>✅ also as `Scope.local` list reducers (§9)<br>✅ `min`/`max` range over any Comparable incl. **Strings** (v4); `sum`/`mean` numeric only<br>✅ `cap('a').unfold().<reducer>` (unfold of a scalar = identity) |
| `group('a')`/`groupCount('a')` (side-effecting) | 🟡 | pass-through barrier: stashes the group-spec, `cap('a')` re-emits it (§12). ❌ after `as()`/`path()`, `cap('a')` then more steps |

## 5. Per-traverser branching

| Step | Status | Notes |
|---|:--:|---|
| `choose(pred, then[, else])` | 🟡 | ✅ gated-seed dispatch<br>✅ **incoming `as()` threads through** the gated arms + merge (carried-schema)<br>❌ scalar/projection arm bodies<br>❌ mixed-shape arms<br>❌ a NEW `as()` bound *inside* an arm (arms diverge — fails closed)<br>✅ **path threads through** (pad-to-max cols) |
| `choose(fn).option(k, body)…` | 🟡 | ✅ scalar-CASE option-map; its ScalarStream result composes with scalar filters, transforms, reducers and `fold`<br>❌ without a `Pick.none` default<br>❌ element/discard/identity/fail bodies<br>❌ `Pick.unproductive`/`any` |
| `coalesce(…)` | 🟡 | ✅ first-non-empty via the `St.origins` ordinal STACK<br>✅ **incoming `as()` threads through** (originSeed projects it alongside the ordinal, merge preserves it)<br>✅ **nested in coalesce/optional** (each branch pushes a unique ordinal `o0`/`o1`/…)<br>❌ scalar branches<br>❌ mixed-shape<br>❌ a NEW `as()` inside an arm<br>✅ **path threads through** (pad-to-max cols) |
| `union(…)` | 🟡 | ✅ element multi-hop arms via `foldBody`; homogeneous scalar `values`/`id`/`label`/`constant`/`count` arms lower through child ScalarStreams + `UNION ALL`, and later scalar steps compose<br>✅ **incoming `as()` threads through** the merge (`mergeBranchCarried`), so `union(…).select('a')`/`.path()` resolve<br>❌ mixed-shape<br>❌ source-branch tails<br>❌ a NEW `as()` inside an arm<br>✅ **path threads through** element arms (pad-to-max cols) |
| `optional(…)` | 🟡 | ✅ single-hop LEFT JOIN fast path + multi-hop<br>✅ **incoming `as()` threads through** (fast path carries it from the input; general path via originSeed)<br>❌ element-kind change on miss<br>❌ a NEW `as()` inside an arm<br>✅ **path threads through** (pad-to-max cols) |
| `flatMap(__.…)` | 🟡 | ✅ origin-safe movement/filter element bodies and scalar `values`/`id`/`label`/`constant` tails use the generic child compiler with `all` cardinality; later scalar steps compose<br>✅ **incoming `as()` threads through** (single body, no merge)<br>✅ **path threads through** element bodies (pad-to-max cols)<br>❌ record/list/group/path bodies; NEW `as()` inside body |
| `map(__.…)` | 🟡 | ✅ child `count()` is a scope-aware ScalarStream barrier: parent-domain LEFT JOIN + origin GROUP BY preserves duplicates and emits zero for empty children; scalar filters, transforms, reducers and `fold` compose<br>✅ scalar `values`/`id`/`label`/`constant` tails are productive rows through the generic child domain; missing values drop the parent, productive NULL survives, movement+projection selects first per origin<br>✅ movement/filter element bodies compile through the generic child domain; `ROW_NUMBER() PARTITION BY origin` keeps the first productive child per multiset-distinct parent<br>❌ alias/select/fold and other barrier-bearing element bodies |
| `local(…)` | 🟡 | ✅ child `count()` shares the generic parent-domain/origin barrier with `map()`<br>✅ movement + a per-element `limit()`/`range()` via the shared child-domain ordinal and `ROW_NUMBER() OVER (PARTITION BY …)`<br>✅ outer `as()` aliases/path columns survive the child scope<br>❌ non-movement bodies (match/simplePath/union/nested local), no-barrier bodies, `order()`/`dedup()` inside, `local(aggregate(...))`, sack/otherV state |

## 6. Recursion (`repeat`)

| Step | Status | Notes |
|---|:--:|---|
| `repeat(__.<out/in/both>).times(n)` | ✅ | ✅ `WITH RECURSIVE walk`<br>✅ both = two recursive terms |
| `repeat(__.<out/in/both>).times(n).count()` | ✅ | ✅ **traverser bulking** — unrolled GROUP-BY-SUM(bulk) CTEs, so `times(8).count()`=2.5e15 in ~10ms (§Traverser bulking)<br>✅ post-repeat `as()`/movement/bare `select(labels).count()` erases discarded record identity and propagates bulk per extra hop (`writtenBy` grateful scenario = 24.3bn)<br>❌ `groupCount`/`by(count)`, `sum`, aliases live before/across the walk, unbounded `until`/`emit` |
| `emit` (before/after, bare) | ✅ | ✅ runs to natural fixpoint (no depth cap) |
| `until(<pred>)`, `loops().is(n)` | 🟡 | ✅ do-while/while-do<br>❌ `until(__.loops()…)` beyond `loops().is(P)` |
| `repeat().path()`, `simplePath()` in body | ✅ | ✅ JSONB array walk + `json_each` cycle guard |
| `emit(pred)`, `times(pred)` | ❌ | predicate forms |
| `until` + `times`, `until` + `emit` | ❌ | combined exit conditions |
| movement + `has()` / multi-hop repeat bodies | ✅ | ✅ `repeat(__.out().has(k,v/P/TextP))`, `repeat(__.both().has(…))`, `repeat(__.in().out())` — a JOIN-chain recursive term (`expandRepeatBody`); both() forks by cartesian direction<br>❌ `hasLabel`/3-arg/T-token `has` in the body; path()/simplePath() with a MULTI-hop body |
| barrier/side-effect / edge-step repeat bodies | ❌ | `repeat(__.out().dedup()/limit()/order()/local()/union()/sack()/groupCount())`, nested `repeat`, `repeat(__.outE().inV())` — can't live in a recursive term (a barrier/state/edge-alternation per iteration) |
| `repeat()` on edges, after `as()` | ❌ | |
| `path().by()` on the recursive walk | ❌ | |

## 7. Path family

| Step | Status | Notes |
|---|:--:|---|
| `path()`, `path().by(key)` | 🟡 | ✅ always lowers to an explicit PathStream: wide-row linear layout or `(pk,ord,element)` recursive layout; root materialization alone frames GraphBinary<br>✅ linear label-carry + handler assembly<br>✅ **through a branch** (union/coalesce/optional/choose/flatMap — pad-to-max `cols`, ragged arms NULL-padded + LEFT JOIN)<br>❌ `path().by(traversal)`/`by(T.x)`; `path().by()` **through a branch** (padded null vs missing-prop ambiguous)<br>❌ mixed element-kind at one branch position; a dynamic-length (`repeat`) arm (needs tagged-array)<br>❌ spanning >1 linear movement/repeat<br>❌ over a `union()` **source** step |
| `simplePath()`, `cyclicPath()` | ✅ | ✅ all-pairs identity (linear) / `json_each` guard (in repeat body) |
| steps after `path()` | ❌ | `order`/reducer/`is`/transform/`inject` after `path()` |
| `tree()` | 🚫 | JS GLV cucumber ignores all 13 tree scenarios + stubs `DataType.TREE` → 0 conformance. Build only if a non-JS consumer appears |

## 8. Pattern matching

| Step | Status | Notes |
|---|:--:|---|
| `match(p1, p2, …)` | 🟡 | ✅ conjunctive pattern join on the alias seam<br>✅ `as(start).<out/in>*[.has].as(end)` patterns, dependency-ordered<br>❌ `both()`/edge/scalar-terminal patterns<br>❌ `or`/`not`/nested-match<br>❌ `>1`/`0` root vars<br>❌ match-inside-where<br>❌ select-then-movement<br>❌ path tracking |

## 9. Lists & collections

| Step | Status | Notes |
|---|:--:|---|
| `fold()` as a re-usable list value | ✅ | ✅ JSONB list<br>✅ re-enters the tail |
| `unfold()` | 🟡 | ✅ `json_each` explode → elements/scalar/nested-list stream (list-of-lists → per-list rows), retaining uniform scalar item metadata<br>❌ after a projection/modifier on an element stream<br>❌ Map-unfold (→Map.Entry) |
| `inject([…])` as a list | ✅ | ✅ each bracket arg = one list value |
| `Scope.local` reducers (count/sum/min/max/mean) | ✅ | ✅ per-list correlated aggregate → ScalarStream, including later filters/reducers<br>✅ also degenerate scalar-local |
| `none(P)`/`all(P)`/`any(P)` collection filters | ✅ | ✅ keep a list where no / every / some element matches (`IS TRUE`/`IS NOT TRUE` null handling; null-aware `eq/neq(null)`) |
| `Scope.local` order/limit/range/skip/tail/dedup on a list | 🟡 | ✅ per-list correlated `json_each` rebuild (order sorts by value / direction-only `by(Order.desc)`; dedup keeps first occurrence; tail avoids a count() subquery)<br>✅ `reverse()` reverses list order; per-element string transforms (toUpper/trim/length/…)<br>✅ a single bare `order().fold()` sorts the folded scalars<br>❌ `order(Scope.local).by(key/traversal)` |
| **set-ops** (`combine`/`intersect`/`difference`/`disjunct`/`product`/`conjoin`) | 🟡 | ✅ over a list value: `combine`=concat (List), `intersect`/`difference`/`disjunct`=set ops (Set, null-safe `IS` membership), `product`=cartesian (list of pair-lists), `conjoin`=join to a String<br>✅ operand = a literal list, `constant(c).fold()`, or a standalone scalar-list traversal (`__.V().values(k).fold()` — compiled as an independent read + `json_group_array`, embedded as a scalar subquery)<br>✅ a Set followed by a list op degrades to a List (matches `intersect().order(local)`)<br>❌ an element-fold operand (`__.V().fold()` — a vertex list)<br>❌ after `path()` (path isn't yet a re-enterable list) |
| scalar-stream `none(P)` barrier | ❌ | whole-stream barrier (distinct from the per-list filter); fails closed |

## 10. Types, math & dates

| Step | Status | Notes |
|---|:--:|---|
| `asBool`, `asNumber(GType.X)`, bare `asNumber()` | ✅ | ✅ typed-value carrier (compile-time subtype tag → GraphBinary framing)<br>✅ runtime scalar casts lower as relational ScalarStream transforms and compose with later filters/reducers |
| string transforms | ✅ | ✅ SQL scalar, text-in text-out; non-local scalar transforms lower stepwise as ScalarStream relations<br>✅ `concat` skips nulls (`concat_ws`), all-null→null<br>✅ trim family over Java's `isWhitespace` set (incl. U+3000)<br>✅ `reverse` string chars (recursive CTE) / number identity / list order (§9)<br>✅ all compose as `Scope.local` per-element list transforms after `fold()`<br>✅ a string op on a non-`local` list raises TinkerPop's "can only take string as argument"<br>✅ `format("…%{key}…%{_}…")` templates a string — named tokens read element properties, `%{_}` pulls by() modulators (positional/round-robin); a missing property filters the row (❌ reading project()/select() columns, the as()-alias fallback)<br>❌ `split` (list-valued), element/map `asString` |
| `math("<formula>")` | 🟡 | ✅ full exp4j operator/function set → one SQL ScalarStream, always Double; later scalar steps/barriers compose<br>❌ a var with no `by()`<br>❌ `withSideEffect` vars<br>❌ reading `project()`/`select()` map columns |
| `asDate`, `dateAdd`, `dateDiff`, `datetime()`/`DateTime()` literals | 🟡 | ✅ epoch-millis rep + `'date'` tag (UTC-only, ms precision — parity with the JS reference client)<br>❌ `typeOf(GType.DATETIME)` over stored props<br>❌ `inject([…]).asDate()` |
| `asNumber` + reducer (`fold`/`sum`) | ✅ | ✅ numeric reducers carry runtime `vt` explicitly (`asNumber(...).sum()`)<br>✅ typed `fold()` carries uniform element metadata through ListStream materialization |
| bigdecimal | ❌ | no client GraphBinary serializer |
| `format()` | 🟡 | ✅ element-property template substitution with `%{key}` + `%{_}`/`by()` returning a composable ScalarStream<br>❌ reading project()/select() columns and the as()-alias fallback |

## 11. Writes

| Step | Status | Notes |
|---|:--:|---|
| `addV()`, `.property(k,v)`, `property(T.id/T.label)` | ✅ | ✅ user-supplied ids (string→uid, int→rowid) |
| `addE()`, `from`/`to` | 🟡 | ✅ `as()` alias or nested `__.V(…)`<br>✅ edge uid via `property(T.id)`<br>✅ multi-addE graph initializers<br>❌ nested-traversal `addE` label<br>❌ endpoint traversal past a movement<br>❌ `addE` after some prefixes |
| `mergeV`, `mergeE` | 🟡 | ✅ id-aware upsert, onCreate/onMatch, start + mid-chain<br>❌ nested-traversal merge maps (`mergeV(__.select…)`)<br>❌ `option(…, __.traversal)`<br>❌ bare `mergeV()`/`mergeE()` (incoming-as-map) |
| `property()` update | ✅ | ✅ vertex: normalized rows, single/list/set + meta (W4); edge: JSON-merge blob |
| `drop()` (vertices + edges) | 🟡 | ✅ vertex `drop()`<br>❌ edge `drop()`<br>❌ `drop()` after some steps |
| `property(Cardinality.list/set, …)` (multi-property) | ✅ | list appends, set dedups by value (W4 normalized table) |

## 12. Side-effect state (🟡 — the registry + carried-column substrate landed)

Design + decision log: `docs/2026-07-13-side-effect-state-plan.md`. Two mechanisms, one
home (`Carry`): a **named side-effect registry** (aggregate/cap/group('a')) and a
**carried per-traverser column** (sack) — both stay one SQL statement (no interpreter).

| Step | Status | Notes |
|---|:--:|---|
| `aggregate('x')` | 🟡 | ✅ pass-through barrier → a JSONB-list side-effect CTE; `aggregate('x').by(key)` scalar bag (by-miss drops)<br>❌ on a scalar stream (`values(k).aggregate(x)`), `by(<nested/token>)`, `local(aggregate(...))` |
| `store('x')` | 🚫 | dropped in TinkerPop 4 (no grammar rule); `aggregate(Scope.local)` replaces it |
| `cap('x')` | 🟡 | ✅ a list side-effect UNROLLS to individual results (no BulkSet wire type); a group side-effect re-emits the same GroupStream as inline `group()` (`cap('a').select(Column.values).unfold()` composes)<br>❌ multi-key `cap('x','y')` |
| `sack()` / `withSack(…)` | 🟡 | ✅ carried column: `sack(Operator.x).by(key/T.label/nested)` mutate, bare `sack()` read as a ScalarStream, `withSack(init)` seed; later scalar steps/barriers compose<br>❌ inject-const numeric promotion (NumberHelper byte→short bump), `repeat()`/`barrier`/`local`, split/merge-on-fork, `sack(BiFunction)` |
| `group('a')` / `groupCount('a')` (side-effecting) | 🟡 | ✅ pass-through barrier → stashed group-spec, `cap('a')` re-runs `lowerGroup`<br>❌ nested value-`by()` with movement+order, `by(__.select…)`, after `as()`/`path()` (inherits `lowerGroup`'s §4 limits) |
| `within('x')` / `without('x')` readback | ❌ | mid-chain read of a side-effect (the aggregate-dedup idiom) — where eager/lazy diverge; fails closed |

Landed L3 618→634 (sack +4, aggregate/cap +8, group('a')/cap +4). The
`group('a')…cap('a').select(Column.values).unfold()` cluster now lands (cap re-enters →
MapStream, §MapStream). Still gates `ProductiveByStrategy` (needs `local()` too).

## 13. Traversal strategies

| Strategy | Status | Notes |
|---|:--:|---|
| 15 optimization strategies | ✅ | ✅ accepted as **no-ops** (result-preserving by TinkerPop's contract; our SQL does its own planning) |
| `withoutStrategies(…)` | ✅ | ✅ safe no-op (we apply no default) |
| **SubgraphStrategy** (vertex criterion) | 🟡 | ✅ `where`/`has` injection pass<br>❌ edge/vertexProperty criteria<br>❌ adjacency (`out()` expansion) |
| **PartitionStrategy** (read-filter + write-stamp) | 🟡 | ✅ `has(within)` + property stamp<br>❌ `includeMetaProperties`<br>❌ partition-aware merge |
| ReadOnly / EdgeLabel / ReservedKeys **verification** | ✅ | ✅ throw TinkerPop's canonical messages |
| ProductiveByStrategy | ❌ | its scenarios use `local(aggregate(...))` — the aggregate-in-local body (§5) still defers |
| `with(…)` (OptionsStrategy sugar) | ❌ | `step not implemented: with()` |
| OLAP / GraphComputer / Seed / Event strategies | 🚫 | out of scope |

## 14. Element / property model

| Feature | Status | Notes |
|---|:--:|---|
| Integer rowid ids | ✅ | |
| **User-supplied ids** (string `uid`) | 🟡 | ✅ resolved at `V('x')` seed + framing-out and `properties().element().id()`<br>❌ scalar id via `by(__.outV().id())`/`group().by(__.id())`<br>❌ edge's own uid via `addE` in some paths |
| **Multi-properties** (list/set cardinality) | ✅ | normalized `vertex_properties` table; `values()` flatMaps, `has()` ANY-matches, `valueMap` `{k:[…]}` (W4) |
| **Meta-properties** (properties-on-properties) | ✅ | JSONB `meta` per VP row; write `property(k,v,mk,mv)`, read `properties().has(mk)`/`.properties()`/`valueMap` (W4) |
| Property types: primitives + list/map | ✅ | ✅ vertex: normalized `vertex_properties` rows, `value` BLOB affinity (keeps SQLite storage class → correct numeric order/range); edge: flat JSONB `props` (W4) |

## 15. Locked non-goals (🚫)

| Feature | Why |
|---|---|
| **Lambdas** | v4-native stance; gremlin-lang barely supports them |
| **OLAP / GraphComputer** | locked out — mogwai is OLTP (small per-tenant graphs) |
| **Multi-request `g.tx()`** | needs DO session state (a P5 stretch, not a non-goal forever) |
| `tree()` | 0 conformance (JS GLV stubs it) — build only for a non-JS consumer |
| **TextP regex** (`regex`/`notRegex`) | Platform wall, not a design choice: stock SQLite ships no `regexp()` UDF and DO blocks `sqlite3_create_function`/`load_extension`. Same wall as `typeOf` over stored props. `LIKE`-expressible TextP (startsWith/endsWith/containing) stays ✅ |

---

## Where this points (the remaining frontier)

Cheapest wins are long done. What's left, by structural weight:

1. ~~**Side-effect state** (§12)~~ — **substrate LANDED** (618→634): the registry
   (aggregate/cap/group('a')) + carried column (sack). Remaining tails: `within/without`
   readback, sack numeric-promotion. (The `group('a')…select(Column.values)` cluster now
   lands via the MapStream re-entry, §MapStream.)
2. ~~**Multi/meta-properties (W4)** (§11, §14)~~ — **LANDED** (634→648): normalized
   `vertex_properties` table + edge JSONB, multi/set cardinality, meta writes+reads. The
   self-tuning `json_extract` index machinery is retired for static vp covering indexes.
3. ~~**`local`** (§5)~~ — **substrate LANDED** (648→661): per-element scalar reduction +
   movement window. Remaining: non-movement bodies, `local(aggregate(...))` (→
   ProductiveByStrategy), `order()`/`dedup()` inside local.
4. **Chained projections** (§3) — element→scalar→scalar re-type; partly dissolved by the
   list substrate, still open for this shape (~40).
5. ~~**Collection-algebra tail** (§9)~~ — **LANDED** (661→822 over several batches):
   `select(Column.values/keys)`, list-local `Scope.local` ops, nested list-valued maps
   (§MapStream); the **string-step family** (trim/reverse/concat-nulls + list-local
   transforms); the **set-op family** (combine/intersect/difference/disjunct/product/conjoin
   + all/any — Set framing via `jsonbSet`, null-safe `IS` membership, literal/`constant`/
   standalone-scalar-fold operands); `format()`; unfold-of-scalar identity; min/max over
   Strings. Remaining here: **Map-unfold** (→Map.Entry), element-VALUE maps.

**The current frontier (all design-heavy — clean value-tail/list wins are harvested):**
- **traverser bulking — COUNT LANDED (2026-07-14).** `repeat(<out/in/both>).times(n).count()`
  (path/sack-free; plus cardinality-only post-repeat labels/record selection) now compiles to unrolled GROUP-BY-SUM(bulk) CTEs (`src/steps/bulk.ts`),
  so the **grateful reference graph is seeded** and `times(8).count()` = 2.5e15 returns in
  ~10ms (was an uninterruptible hang). Still deferred (own follow-ups): `groupCount`/
  `group().by(count)` bulking, `sum`/labels whose identity remains semantically live, unbounded `until()`/
  `emit()` bulking (no compile-time depth → needs a JS depth-loop). See
  `docs/2026-07-14-traverser-bulking.md`.
- **path() → re-enterable list** — path isn't yet a list stream, so path-rooted set-ops /
  `reverse()` / `order()` defer.
- **element-list terminal framing** — rejoin rowids→vertices at a terminal list, for
  `fold().order(Scope.local).by(key)`.
- **Select alias-threading** (~68F), **Repeat body generality** (~54F, scattered),
  **Aggregate `within`/`without` readback** (~54F, eager/lazy divergence), **Match**
  patterns (~34F), **Choose/Merge map bodies**.
- **Comparability/Orderability** (~66F) — mixed-type / null / NaN predicate + ordering
  rules; fail-closed territory (correct-by-design over number-chasing).

Full analysis: `docs/2026-07-12-conformance-structural-bets.md` (the "remaining frontier").
