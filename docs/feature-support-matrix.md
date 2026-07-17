# mogwai-db — feature support matrix

Scannable map of what the compiler supports, and where partial steps stop. Grouped
by traversal concern. **L3 conformance: <!-- L3:passing -->1,086<!-- /L3:passing --> · corpus parse+chain: 2298/2298.**

Sourced from the dispatch maps (`src/steps/*.ts`) and the compiler `throw` sites — if
the code defers a shape, it fails closed with a clear error and this file says so. Keep
rows in sync in the same commit that changes support.

| Mark | Meaning |
|---|---|
| ✅ | Full — all normal forms |
| 🟡 | Partial — the Notes list what works and what defers |
| ❌ | Deferred — throws a clear error |
| 🚫 | Out of scope — locked non-goal |

In a 🟡 cell, **✅** = supported form, **❌** = deferred shape.

---

## 1. Sources & movement

| Step | | Notes |
|---|:--:|---|
| `V()`/`V(id…)`, `E()`/`E(id…)` | ✅ | `V` id resolves numeric rowid or string `uid` |
| `out`/`in`/`both`, `outE`/`inE`/`bothE`, `outV`/`inV`/`bothV` | ✅ | index-only covering-index hops |
| `otherV` | ✅ | endpoint away from the entering vertex |
| `inject(…)` | ✅ | ordinary args → scalar stream, all-array args → list stream (§9); later scalar injects append relationally. ❌ appending a list onto an existing scalar stream |

## 2. Filters & predicates

| Step | | Notes |
|---|:--:|---|
| `hasLabel`, `has(k)`, `has(k,v)`, `has(k,P)`, `has(label,k,v)`, `has(T.label/T.id,…)` | ✅ | ANY-match over normalized props, static covering index |
| `hasId(…)` | ✅ | flattens list args |
| `is(P)` | 🟡 | scalar filter, incl. after transforms/reducers/`limit`/`range`/`skip`. ❌ after `path()` |
| `where(__.…)` | ✅ | single- & multi-hop incl. `both()` and edge-typed hops; `label()`/`not()`; alias-rooted `where(__.as('x')…)` |
| `where(P)` / `where('a',P)` | 🟡 | alias-column compare. ❌ some `where(P.op)` forms; `by(key)` on an edge-typed label |
| `and`, `or`, `not`, `filter(__.…)` | ✅ | incl. infix `.and()`/`.or()` connectors. ❌ `filter(predicate)` — use a traversal |
| `P` (eq/neq/lt/gt/within/without/between/inside/outside) | ✅ | `between` is `[lo,hi)` |
| TextP (startsWith/endsWith/containing + negations) | ✅ | bound `LIKE`, escaped |
| TextP regex (`regex`/`notRegex`) | 🚫 | no SQLite `regexp()` UDF; DO blocks `create_function`/`load_extension` |
| `typeOf(GType)` over a stored property | 🟡 | `is(typeOf(X))` / `has('k',typeOf(X))` over int/long/short/byte/bigint/float/double/string/boolean/datetime/uuid/list/map/set via the stored `vtype`. ❌ `bigdecimal`/`char`/`duration` detect but can't frame (no serializer) |
| `dedup()` | 🟡 | bare; `dedup().by(key/T.id/T.label/scalar traversal)` first-per-key window. ❌ `dedup(label)`, >1 `by()`, after `as()` / path tracking |
| `identity()` | ✅ | |

## 3. Projections & element data

| Step | | Notes |
|---|:--:|---|
| `values(k…)`, `id()`, `label()`, `count()` | ✅ | ids frame as `COALESCE(uid,id)` |
| `valueMap`, `elementMap` | 🟡 | custom vertex/edge framing; re-enterable as a per-element map, so `select(Column.keys/values)`, `count()`, `is(typeOf(MAP))`, `select(unbound-label)`→empty compose. ❌ heterogeneous element-value maps |
| `properties(k…)` [`.key`/`.value`/`.element`/`.id`/`.label`/`.count`] | 🟡 | full property stream with owner/key/value/meta; `.key`/`.value`/`.id`→scalar, `.element()`→owner vertex/edge, all re-enterable; real VP id + meta, `has(metaKey)`/`hasKey`/`hasValue`/`valueMap`. ❌ `dedup()`/`order()` before a projection |
| `select('a')`, multi-`select`, `project(…)` | 🟡 | column-threaded aliases; single-label select → scalar/element/typed-list; multi-`select`/`project` → per-traverser record (scalar/vertex/edge/scalar-list/element-list fields), each field re-enters; `limit`/`range`/`skip`/`tail` with `Scope.local` slice fields. ❌ record `order`/`dedup`/`fold`/`where` |
| `select(Column.values/keys)` | 🟡 | over a group, scalar record, or per-element valueMap/elementMap (keys→Set); list-valued maps → list-of-lists. ❌ heterogeneous element-value lists, raw Map params |
| chained projections (`values().count()`, `project().select()`, `valueMap().select()`) | 🟡 | scalar/record/map projections retype to a stream and re-enter one step at a time. ❌ heterogeneous structured values |
| `order()` [`.by(key[,dir])`] | 🟡 | tail modifier. ❌ after `path()`; `by(key)` on a scalar stream |
| `limit`, `range`, `skip` | ✅ | CTE mid-chain / tail modifier after `order()`; `Scope.local` slices record fields |
| `by(…)` modulator | ✅ | on `order`/`select`/`project`/`group`/`groupCount`/`path`/`math` |

## 4. Aggregation & barriers

| Step | | Notes |
|---|:--:|---|
| `group`, `groupCount` | 🟡 | scalar/`T.id`/`T.label`/composite-`project` keys; scalar reducers → SQL `GROUP BY`; element values → ordered stream + fold, incl. an unreduced value traversal (`by(__.out())`) via implicit fold; non-reducing → scalar lists; nested-MAP values (`by(__.properties().groupCount().by(T.label))`, `by(__.bothE().group().by(T.label).by(__.values(x).sum()))`) via two-level aggregation; group-scoped `count/sum/min/max/mean`/`fold()` at the key boundary; scalar-stream `groupCount()`; `count()`/`is(typeOf(MAP))`/`unfold()`→Map.Entry re-enter. ❌ >2 `by()`, deep/non-scalar keys, `order().by(key)` in a value, `select(Column)`/`unfold()` over a nested-MAP value |
| `fold()` | ✅ | scalar or element list, re-enterable; empty lists and node/edge item metadata preserved |
| `sum`, `min`, `max`, `mean` | ✅ | carry runtime `(v,vt)`; also `Scope.local` list reducers (§9); `min`/`max` over any Comparable incl. Strings |
| `group('a')`/`groupCount('a')` (side-effecting) | 🟡 | see §12 |

## 5. Per-traverser branching

Common to all four branch steps: incoming `as()` and `path()` thread through element
arms; **mixed-shape arms (scalar + element + list class) merge into a variant stream**.
❌ across all: mixed element KIND (node+edge), a NEW `as()` inside an arm, path through a
mixed-shape arm.

| Step | | Notes |
|---|:--:|---|
| `choose(pred, then[, else])` | 🟡 | gated dispatch; homogeneous scalar/list arms; predicate on the generic child-existence engine + infix connectors. ❌ 2-arg scalar-then + identity-else |
| `choose(fn).option(k, body)…` | 🟡 | scalar option-map, composes as a scalar stream. ❌ no `Pick.none` default; element/discard/identity/fail bodies; `Pick.unproductive`/`any` |
| `coalesce(…)` | 🟡 | first-productive over element/scalar/list arms (empty `fold()` is productive); element movement + `limit`/`skip`/`range`/`dedup`; nests in coalesce/optional |
| `union(…)` | 🟡 | element multi-hop/nested arms; homogeneous scalar/list arms via `UNION ALL`. ❌ source-branch tails |
| `optional(…)` | 🟡 | single-hop fast path + multi-hop; element `limit`/`skip`/`range`/`dedup`; non-total scalar child → variant stream (+ `count()` re-entry). ❌ element-kind change on miss; most steps after a variant stream |
| `flatMap(__.…)` | 🟡 | movement/filter bodies + scalar tails (`all`); scalar or element `fold()` → list per parent. ❌ record/group/path bodies |
| `map(__.…)` | 🟡 | scope-aware child barriers (`count/sum/min/max/mean`), scalar tails, `fold()` per parent, movement bodies (first-per-origin). ❌ alias/select/structured bodies |
| `local(…)` | 🟡 | one child `all` policy: movement, `limit`/`skip`/`range`/`dedup`, scalar transforms/reducers, `fold()`, `local(aggregate(...))`; outer `as()`/path/`otherV()` survive. ❌ general `order()`; structured/record/group/path/match/union/nested bodies; sack |

## 6. Recursion (`repeat`)

| Step | | Notes |
|---|:--:|---|
| `repeat(__.<out/in/both>).times(n)` | ✅ | `WITH RECURSIVE`; `both` = two terms |
| `…times(n).count()` | ✅ | traverser bulking — unrolled `GROUP-BY-SUM(bulk)` CTEs; propagates through post-repeat labels/movement/`select(labels).count()`. ❌ `groupCount`/`by(count)`, `sum`, aliases live across the walk, unbounded `until`/`emit` |
| `emit` (before/after, bare) | ✅ | runs to natural fixpoint |
| `until(<pred>)`, `loops().is(n)` | 🟡 | do-while/while-do. ❌ `until(__.loops()…)` beyond `loops().is(P)` |
| `repeat().path()`, `simplePath()` in body | ✅ | JSONB array walk + `json_each` cycle guard |
| movement + `has()` / multi-hop bodies | 🟡 | `out()/both()/in()` chains with `has(k,v/P/TextP)`. ❌ `hasLabel`/3-arg/T-token `has`; path with a multi-hop body |
| `emit(pred)`, `times(pred)`, `until`+`times`/`emit` | ❌ | predicate / combined exit forms |
| barrier/side-effect/edge-step bodies, nested `repeat`, on edges, after `as()`, `path().by()` on the walk | ❌ | can't live in a recursive term |

## 7. Path family

| Step | | Notes |
|---|:--:|---|
| `path()`, `path().by(key)` | 🟡 | linear or recursive layout; label-carry + handler assembly; `count()`/`is(typeOf(PATH))`/`unfold()` re-enter; through a branch (pad-to-max cols). ❌ `by(traversal)`/`by(T.x)`; `by()` through a branch; mixed element-kind at a position; dynamic-length (`repeat`) arm; spanning >1 movement/repeat; over a `union()` source |
| `simplePath()`, `cyclicPath()` | ✅ | all-pairs identity / `json_each` guard |
| other steps after `path()` | ❌ | `order`/reducer/transform/`inject`/`select(Column.keys)` — need label history |
| `tree()` | 🚫 | JS GLV stubs it, 0 conformance |

## 8. Pattern matching

| Step | | Notes |
|---|:--:|---|
| `match(p1, p2, …)` | 🟡 | conjunctive `as(start).<element traversal>.as(end)` patterns, dependency-ordered; the body folds through the shared movement/filter StepFns (out/in/both/…E/…V + has/hasLabel/hasId/where — no private vocabulary). ❌ scalar-terminal (`count`/`values` binds a scalar var), edge-typed end var, `or`/`not`/nested-match, >1 or 0 root vars, `dedup(label)` downstream, path tracking |

## 9. Lists & collections

| Step | | Notes |
|---|:--:|---|
| `fold()` / `inject([…])` as a list value | ✅ | JSONB list, re-enters the tail; each bracket arg = one list |
| `unfold()` | 🟡 | explode → elements/scalar/nested-list; Map-unfold → per-entry Map.Entry with `select(Column.keys/values)`. ❌ after a projection/modifier on an element stream; non-`select`/element-value on unfolded entries |
| `is(typeOf(LIST))`, `is(typeOf(MAP))` | 🟡 | LIST retypes a stored-`vtype='list'` scalar to a list stream; MAP is identity on a valueMap/group map. ❌ SET retype; list-operation steps (`merge`/`split`/`index`/`order`/`project`/`where`/`asX`) |
| `Scope.local` reducers (count/sum/min/max/mean) | ✅ | per-list aggregate → scalar; also degenerate scalar-local |
| `none(P)`/`all(P)`/`any(P)` | ✅ | collection filters, null-aware |
| `Scope.local` order/limit/range/skip/tail/dedup on a list | 🟡 | per-list `json_each` rebuild; `reverse()`; per-element string transforms; bare `order().fold()` sorts. ❌ `order(Scope.local).by(key/traversal)` |
| set-ops (`combine`/`intersect`/`difference`/`disjunct`/`product`/`conjoin`) | 🟡 | over a list; operand = literal list, `constant(c).fold()`, or a standalone scalar-fold traversal. ❌ element-fold operand; after `path()` |
| scalar-stream `none(P)` barrier | ❌ | whole-stream barrier (distinct from the per-list filter) |

## 10. Types, math & dates

| Step | | Notes |
|---|:--:|---|
| `asBool`, `asNumber(GType.X)`, bare `asNumber()` | ✅ | typed-value carrier → GraphBinary framing; runtime casts compose |
| string transforms (`trim`/`reverse`/`concat`/`format`/…) | 🟡 | SQL scalar; `concat` skips nulls; trim over Java whitespace; compose as `Scope.local` per-element after `fold()`; `format("…%{key}…%{_}…")` reads props / `by()`. ❌ `split`, element/map `asString`, reading `project()`/`select()` columns |
| `math("<formula>")` | 🟡 | full exp4j set → one SQL scalar, always Double; property / scalar-child `by()` vars. ❌ var with no `by()`; `withSideEffect` vars; `project()`/`select()` columns |
| `asDate`, `dateAdd`, `dateDiff`, `datetime()`/`DateTime()` | 🟡 | epoch-millis, UTC-only, ms precision; `typeOf(DATETIME)` over stored props. ❌ `inject([…]).asDate()` |
| `asNumber` + reducer (`fold`/`sum`) | ✅ | reducers carry runtime `vt` |
| `bigdecimal` | ❌ | no client serializer |

## 11. Writes

| Step | | Notes |
|---|:--:|---|
| `addV()`, `.property(k,v)`, `property(T.id/T.label)` | ✅ | user-supplied ids (string→uid, int→rowid); inline property nested VALUES + nested-traversal LABEL (`addV(__.…)`) resolved at run time; nested property KEY that is a constant (`__.select(const)`/`__.constant()`). ❌ live-read nested property KEY (fails closed) |
| `addE()`, `from`/`to` | 🟡 | endpoints: `as()` alias, `__.select(label)`, nested `__.V(…)` (incl. folded `repeat().times()`), or `__.addV(…)` (nested write); edge uid; inline property nested VALUES + constant nested KEY; multi-addE initializers. ❌ nested-traversal edge label; endpoint read tail past a movement (order/limit); live-read nested property KEY (fails closed); `addE` after some prefixes |
| `mergeV`, `mergeE` | 🟡 | id-aware upsert, onCreate/onMatch, start + mid-chain; map label/id/VALUES may be nested traversals (`[k: __.trav]`) resolved correlated per driver; whole-arg `__.select(k)` of a `withSideEffect(k, map)` constant; prop VALUES keep their type (literal subtype / typed-client wire DataType / nested read shape — uuid/datetime/long honored, not JS-inferred). ❌ whole-arg traversals needing a map-valued driver (`__.identity()`/incoming-as-map) or nested-write bodies; nested map KEYS; bare `mergeV()`/`mergeE()`; typed collection ELEMENTS (JSONB storage floor) |
| `property()` update | ✅ | vertex normalized rows single/list/set + meta; edge normalized UPSERT (single, no meta) |
| `property(Cardinality.list/set,…)` | ✅ | list appends, set dedups by value |
| `drop()` (vertices + edges) | 🟡 | after movement/filter/`where`, cascades props. ❌ after `properties()` / `order()` |

## 12. Side-effect state

One home (`Carry`): a named registry (aggregate/cap/group('a')) and a carried column
(sack); both stay one SQL statement.

| Step | | Notes |
|---|:--:|---|
| `aggregate('x')` | 🟡 | pass-through barrier → list/variant relation; `by(key/scalar/ordered-element traversal)`; `local(aggregate(...))`; ProductiveBy NULL survives. ❌ on a scalar stream, token modulators, general element ordering |
| `cap('x')` | 🟡 | list/variant emits one collection (`unfold()` for members); group side-effect re-emits its GroupStream. ❌ multi-key `cap('x','y')` |
| `sack()` / `withSack(…)` | 🟡 | carried column: `sack(Operator.x).by(key/T.label/nested)` mutate, bare `sack()` read, `withSack(init)` seed. ❌ inject-const numeric promotion; `repeat()`/`barrier`/`local`; split/merge-on-fork; `sack(BiFunction)` |
| `group('a')`/`groupCount('a')` | 🟡 | pass-through barrier, `cap('a')` re-runs the group. ❌ after `as()`/`path()` (inherits §4 limits) |
| `store('x')` | 🚫 | dropped in v4 — use `aggregate(Scope.local)` |
| `within('x')`/`without('x')` readback | ❌ | mid-chain side-effect read (eager/lazy divergence) |

## 13. Traversal strategies

| Strategy | | Notes |
|---|:--:|---|
| 15 optimization strategies, `withoutStrategies(…)` | ✅ | no-ops (result-preserving; SQL plans itself) |
| SubgraphStrategy (vertex criterion) | 🟡 | `where`/`has` injection. ❌ edge/vertexProperty criteria, adjacency expansion |
| PartitionStrategy (read-filter + write-stamp) | 🟡 | `has(within)` + property stamp. ❌ `includeMetaProperties`, partition-aware merge |
| ReadOnly / EdgeLabel / ReservedKeys verification | ✅ | throw TinkerPop's canonical messages |
| ProductiveByStrategy | ✅ | productive-NULL policy for every supported consumer |
| `with(…)` (OptionsStrategy sugar) | ❌ | not implemented |
| OLAP / GraphComputer / Seed / Event | 🚫 | out of scope |

## 14. Element / property model

| Feature | | Notes |
|---|:--:|---|
| Integer rowid ids | ✅ | |
| User-supplied ids (string `uid`) | 🟡 | at `V('x')` seed, framing-out, `properties().element().id()`. ❌ scalar id via `by(__.outV().id())`/`group().by(__.id())`; edge uid via `addE` in some paths |
| Multi-properties (list/set) | ✅ | normalized `vertex_properties`; `values()` flatMaps, `has()` ANY-matches, `valueMap` `{k:[…]}` |
| Meta-properties | ✅ | JSONB `meta` per VP row |
| Property types: primitives + list/map/set | ✅ | vertex + edge normalized (`value` keeps SQLite storage class → correct order/range); `vtype` stores the canonical type (→ `typeOf` §2, framing §10); collections as JSONB |

## 15. Locked non-goals (🚫)

| Feature | Why |
|---|---|
| Lambdas | v4-native stance |
| OLAP / GraphComputer | OLTP-only (small per-tenant graphs) |
| Multi-request `g.tx()` | needs DO session state (P5 stretch) |
| `tree()` | 0 conformance (JS GLV stubs it) |
| TextP regex | platform wall — no SQLite `regexp()` UDF, DO blocks extensions |
