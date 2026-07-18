# mogwai-db — feature support matrix

Scannable map of what the compiler supports, and where partial steps stop. Grouped
by traversal concern. **L3 conformance: <!-- L3:passing -->1,220<!-- /L3:passing --> · corpus parse+chain: 2298/2298.**

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
| `V()`/`V(id…)`, `E()`/`E(id…)` | ✅ | `V` id resolves numeric rowid or string `uid`; **mid-traversal after a scalar** (`inject(x).V()`) re-sources the graph per traverser (a flatMap; carried as()-labels ride forward). ❌ mid-`V`/`E` when the scalar carries path/origins/sack |
| `out`/`in`/`both`, `outE`/`inE`/`bothE`, `outV`/`inV`/`bothV` | ✅ | index-only covering-index hops. **Traverser bulking** auto-collapses convergent walks (`SELECT id, SUM(bulk) … GROUP BY id`) when the whole chain is identity-free — pure movement/filter/bare-`dedup`/`order`/`limit`·`range`·`skip`, ending in a reducer or a bare element leaf — so the frontier stays bounded by \|V\| not the walk count, and an element result ships as `(v, N)` RLE the client expands. Result-equivalent, automatic by shape, gated off under `path`/`as`/`sack` (`chainCollapseSafe`, `movementCollapse` fast path). ❌ `group`/`groupCount` weighting (still enumerates) |
| `otherV` | ✅ | endpoint away from the entering vertex |
| `inject(…)` | ✅ | ordinary args → scalar stream, all-array args → list stream (§9); later scalar injects append relationally. ❌ appending a list onto an existing scalar stream |

## 2. Filters & predicates

| Step | | Notes |
|---|:--:|---|
| `hasLabel`, `has(k)`, `has(k,v)`, `has(k,P)`, `has(label,k,v)`, `has(T.label/T.id,…)` | ✅ | ANY-match over normalized props, static covering index |
| `hasId(…)` | ✅ | flattens list args |
| `is(P)` | 🟡 | scalar filter, incl. after transforms/reducers/`limit`/`range`/`skip`. ❌ after `path()` |
| `where(__.…)` | ✅ | single- & multi-hop incl. `both()` and edge-typed hops; `label()`/`not()`; alias-rooted `where(__.as('x')…)` |
| `where(P)` / `where('a',P)` | 🟡 | alias-column compare; **over a scalar stream** `where(P)`/`filter(P)` applies the predicate directly to the value. ❌ some `where(P.op)` forms; `by(key)` on an edge-typed label; `where('a',P)` over a scalar |
| `and`, `or`, `not`, `filter(__.…)` | ✅ | incl. infix `.and()`/`.or()` connectors. ❌ `filter(predicate)` — use a traversal |
| `P` (eq/neq/lt/gt/within/without/between/inside/outside) | ✅ | `between` is `[lo,hi)` |
| TextP (startsWith/endsWith/containing + negations) | ✅ | bound `LIKE`, escaped |
| TextP regex (`regex`/`notRegex`) | 🚫 | no SQLite `regexp()` UDF; DO blocks `create_function`/`load_extension` |
| `typeOf(GType)` over a stored property | ✅ | `is(typeOf(X))` / `has('k',typeOf(X))` over every canonical type via the stored `vtype` — incl. `bigdecimal`/`char`/`duration` (now framed by the hand-rolled serializers, §10) |
| `dedup()` | 🟡 | bare; `dedup().by(key/T.id/T.label/scalar traversal)` first-per-key window. ❌ `dedup(label)`, >1 `by()`, after `as()` / path tracking |
| `identity()` | ✅ | |

## 3. Projections & element data

| Step | | Notes |
|---|:--:|---|
| `values(k…)`, `id()`, `label()`, `count()` | ✅ | ids frame as `COALESCE(uid,id)` |
| `valueMap`, `elementMap` | 🟡 | custom vertex/edge framing, each value framed by its stored type (uuid/datetime/long/collection — not JS-inferred); re-enterable as a per-element map, so `select(Column.keys/values)`, `count()`, `is(typeOf(MAP))`, `select(unbound-label)`→empty compose. ❌ heterogeneous element-value maps |
| `properties(k…)` [`.key`/`.value`/`.element`/`.id`/`.label`/`.count`] | 🟡 | full property stream with owner/key/value/meta; `.key`/`.value`/`.id`→scalar, `.element()`→owner vertex/edge, all re-enterable; real VP id + meta, `has(metaKey)`/`hasKey`/`hasValue`/`valueMap`. ❌ `dedup()`/`order()` before a projection |
| `select('a')`, multi-`select`, `project(…)` | 🟡 | column-threaded aliases; single-label select → scalar/element/typed-list (a value-history label reads its value, incl. after a re-source `V()`); multi-`select`/`project` → per-traverser record (scalar/vertex/edge/scalar-list/element-list fields), each field re-enters; `limit`/`range`/`skip`/`tail` with `Scope.local` slice fields. **`project(…)` over a scalar parent**: each field's `by()` runs against the value (bare `by()`/`identity`/transform/`math`/scoped reducer) → a record of scalar fields, via the pushChildScope substrate. ❌ record `order`/`dedup`/`fold`/`where`; scalar-parent `project` field needing element output |
| `select(Column.values/keys)` | 🟡 | over a group, scalar record, or per-element valueMap/elementMap (keys→Set); list-valued maps → list-of-lists. ❌ heterogeneous element-value lists, raw Map params |
| chained projections (`values().count()`, `project().select()`, `valueMap().select()`) | 🟡 | scalar/record/map projections retype to a stream and re-enter one step at a time. ❌ heterogeneous structured values |
| `order()` [`.by(key[,dir])`] | 🟡 | tail modifier. ❌ after `path()`; `by(key)` on a scalar stream |
| `limit`, `range`, `skip` | ✅ | CTE mid-chain / tail modifier after `order()`; `Scope.local` slices record fields |
| `by(…)` modulator | ✅ | on `order`/`select`/`project`/`group`/`groupCount`/`path`/`math` |

## 4. Aggregation & barriers

| Step | | Notes |
|---|:--:|---|
| `group`, `groupCount` | 🟡 | scalar/`T.id`/`T.label`/composite-`project` keys; scalar reducers → SQL `GROUP BY`; element values → ordered stream + fold, incl. an unreduced value traversal (`by(__.out())`) via implicit fold; non-reducing → scalar lists; nested-MAP values (`by(__.<movement>.group()/groupCount())`) via two-level aggregation — the movement/filter prefix (`out().hasLabel(…)`, multi-hop, `properties()`) lowers through the **generic child seam**, so any valid inner traversal + generic inner scalar/`T` key + `count`/numeric reducer composes; group-scoped `count/sum/min/max/mean`/`fold()` at the key boundary; scalar-stream `groupCount()`; `count()`/`is(typeOf(MAP))`/`unfold()`→Map.Entry re-enter. ❌ >2 `by()`, deep/non-scalar keys, `order().by(key)` in a value, element-valued inner key (`by(__.both().groupCount())` — needs element Map keys), `select(Column)`/`unfold()` over a nested-MAP value |
| `fold()` | ✅ | scalar or element list, re-enterable; empty lists and node/edge item metadata preserved |
| `sum`, `min`, `max`, `mean` | ✅ | carry runtime `(v,vt)`; also `Scope.local` list reducers (§9); `min`/`max` over any Comparable incl. Strings |
| `group('a')`/`groupCount('a')` (side-effecting) | 🟡 | see §12 |

## 5. Per-traverser branching

Common to all four branch steps: incoming `as()` and `path()` thread through element
arms; **mixed-shape arms (scalar + element + list class) merge into a variant stream**.
After a variant stream the **shape-agnostic** steps compose (`count`, `unfold` of a
cap()'d aggregate, and the row-preserving `limit`/`skip`/`range` + `dedup`); steps that
must look inside a heterogeneous row (movement, `order`, value filters) fail closed by
construction — the union has no single shape to lower them from.
❌ across all: mixed element KIND (node+edge), a NEW `as()` inside an arm, path through a
mixed-shape arm.

| Step | | Notes |
|---|:--:|---|
| `choose(pred, then[, else])` | 🟡 | gated dispatch; homogeneous scalar/list arms; predicate on the generic child-existence engine + infix connectors. **Over a scalar parent** (`values(…).choose(P/traversal, then[, else])`): value/reducer/nested-branch/`V()`-`E()`-re-source arm bodies, gated by a predicate over the value + `UNION ALL`; **mixed-shape then/else → a VariantStream**; no-else → identity passthrough. ❌ 2-arg scalar-then + identity-else |
| `choose(fn).option(k, body)…` | 🟡 | scalar option-map, composes as a scalar stream; **over a scalar parent** (`values(…).choose(fn).option(k, body)…`) the choice + option bodies run against the value via the modulation seam → a CASE. ❌ no `Pick.none` default; element/discard/identity/fail bodies; `Pick.unproductive`/`any`; T-token choice over a scalar parent |
| `coalesce(…)` | 🟡 | first-productive over element/scalar/list arms (empty `fold()` is productive); element movement + `limit`/`skip`/`range`/`dedup`; nests in coalesce/optional. **Over a scalar parent**: first arm that produces a value per row (productivity = the scalar-arm predicate); value/reducer/nested-branch/`V()`-`E()`-re-source arm bodies; **mixed-shape arms → a VariantStream** (ordinal-gated first-productive) |
| `union(…)` | 🟡 | element multi-hop/nested arms; homogeneous scalar/list arms via `UNION ALL`. **Over a scalar parent**: value/reducer/nested-branch/`V()`-`E()`-re-source arm bodies `UNION ALL`-concatenated (multiset-faithful); **mixed-shape arms → a VariantStream** (scalar + re-source element + `fold()` list). ❌ source-branch tails |
| `optional(…)` | 🟡 | single-hop fast path + multi-hop; element `limit`/`skip`/`range`/`dedup`; non-total scalar child → variant stream (+ shape-agnostic `count`/`unfold`/`limit`/`skip`/`range`/`dedup` re-entry). **Over a scalar parent** (`values(…).optional(t)` ≡ `coalesce(t, identity)`): a scalar arm restores the value on miss → a scalar stream; an element/list arm → a VariantStream (arm rows where productive, else the value). ❌ element-kind change on miss; per-row-shape steps (movement/`order`/value filters) after a variant stream |
| `flatMap(__.…)` | 🟡 | movement/filter bodies + scalar tails (`all`); scalar or element `fold()` → list per parent. **Over a scalar parent**: value/reducer/nested-branch arm body per value, plus a `V()`/`E()` re-source that reduces/projects back to a scalar per input. ❌ record/group/path bodies; a bare re-source ending in element space (→ variant, follow-on) |
| `map(__.…)` | 🟡 | scope-aware child barriers (`count/sum/min/max/mean`), scalar tails, `fold()` per parent, movement bodies (first-per-origin). **Over a scalar parent** (first-result-only, so only ≤1-per-input arm bodies): value/filter/`choose`/`coalesce`/reducer arm bodies, plus a `V()`/`E()` re-source that **reduces** back to a scalar (`__.V().count()`). ❌ alias/select/structured bodies. 🚫 a FAN-OUT arm (a nested `union`, a re-source projection, a bare re-source): map's first-of-many would need a deterministic emission-order column threaded through the fan-out (arm-index through `union`, id-order through re-source) — not a natural fit for the set-oriented SQL engine, and zero corpus examples. Fails closed (correct); use `flatMap`/`local` for all-results |
| `local(…)` | 🟡 | one child `all` policy: movement, `limit`/`skip`/`range`/`dedup`, scalar transforms/reducers, `fold()`, `local(aggregate(...))`; outer `as()`/path/`otherV()` survive. **Over a scalar parent**: value/reducer/nested-branch arm body per value, plus a `V()`/`E()` re-source that reduces/projects back to a scalar. ❌ general `order()`; structured/record/group/path/match/union/nested bodies; sack |

## 6. Recursion (`repeat`)

| Step | | Notes |
|---|:--:|---|
| `repeat(__.<out/in/both>).times(n)` | ✅ | `WITH RECURSIVE`; `both` = two terms. Element- or count-terminal (single-move body, no path/as/sack) takes the **traverser-bulking** unroll instead — `GROUP-BY-SUM(bulk)` frontier bounded by \|V\|, framed as `(vertex, bulk)` RLE; a dense/deep walk that would enumerate quadrillions returns in ms (`src/steps/bulk.ts`, `bulkRepeatCount`). i64 overflow fails loud |
| `…times(n).count()` | ✅ | the bulking count form — propagates through post-repeat labels/movement/`select(labels).count()`. ❌ `groupCount`/`by(count)`, `sum`, aliases live across the walk, unbounded `until`/`emit` |
| `emit` (before/after, bare) | ✅ | runs to natural fixpoint |
| `until(<pred>)`, `loops().is(n)` | 🟡 | do-while/while-do. ❌ `until(__.loops()…)` beyond `loops().is(P)` |
| `repeat().path()`, `simplePath()` in body | ✅ | JSONB array walk + `json_each` cycle guard |
| movement + `has()` / multi-hop bodies | 🟡 | `out()/both()/in()` chains with `has(k,v/P/TextP)`. ❌ `hasLabel`/3-arg/T-token `has`; path with a multi-hop body |
| `emit(pred)`, `times(pred)`, `until`+`times`/`emit` | ❌ | predicate / combined exit forms |
| barrier/side-effect/edge-step bodies, nested `repeat`, on edges, after `as()`, `path().by()` on the walk | ❌ | can't live in a recursive term |

## 7. Path family

| Step | | Notes |
|---|:--:|---|
| `path()`, `path().by(key\|T.x\|__.trav)`, `path().from(l)/to(l)` | 🟡 | linear or recursive layout; label-carry + handler assembly; `count()`/`is(typeOf(PATH))` re-enter; a `by(key)` (scalar) path coerces to a list so the collection ops (set-ops/`merge`/`reverse`/`conjoin`/`unfold`) compose; per-position `by('key')`/`by(T.label/T.id)`/`by(__.trav)` (a value+transform chain, or a `<movement>.count()`/edge-value reducer via `correlatedReduce`); `from(l)`/`to(l)` scope to the static position slice between two `as()` labels (linear); through a branch (pad-to-max cols). ❌ a fan-out/aggregate `by(traversal)` shape the per-position scalar can't render; `by()` through a branch; mixed element-kind at a position; dynamic-length (`repeat`) arm; `by(traversal)`/`from`/`to` over a recursive path; spanning >1 movement/repeat; over a `union()` source |
| `simplePath()`, `cyclicPath()` [`.from(l)/.to(l)`] | ✅ | all-pairs identity / `json_each` guard; `from(l)`/`to(l)` scope the pair-loop to a static label range. ❌ `by(key/T)` scoping |
| other steps after `path()` | 🟡 | collection ops (set-ops/`merge`/`reverse`/`conjoin`/`unfold`) compose over a `by(key)` path (coerced to a list). ❌ `order`/reducer/`inject`/`select(Column.keys)` — need label history |
| `tree()` | 🚫 | JS GLV stubs it, 0 conformance |

## 8. Pattern matching

| Step | | Notes |
|---|:--:|---|
| `match(p1, p2, …)` | 🟡 | conjunctive `as(start).<element traversal>.as(end)` patterns, dependency-ordered; the body folds through the shared movement/filter StepFns (out/in/both/…E/…V + has/hasLabel/hasId/where — no private vocabulary). ❌ scalar-terminal (`count`/`values` binds a scalar var), edge-typed end var, `or`/`not`/nested-match, >1 or 0 root vars, `dedup(label)` downstream, path tracking |

## 9. Lists & collections

| Step | | Notes |
|---|:--:|---|
| `fold()` / `inject([…])` as a list value | ✅ | JSONB list, re-enters the tail; each bracket arg = one list |
| `unfold()` | 🟡 | explode → elements/scalar/nested-list; a stored typed list carries each element's own vtype (frames exactly); Map-unfold → per-entry Map.Entry with `select(Column.keys/values)`. ❌ after a projection/modifier on an element stream; non-`select`/element-value on unfolded entries |
| `is(typeOf(LIST))`, `is(typeOf(SET))`, `is(typeOf(MAP))` | 🟡 | LIST/SET retype a stored collection scalar to a (typed) list stream — SET frames as a GraphBinary Set; `unfold()` carries each element's own stored type; MAP is identity on a valueMap/group map (a bare stored map frames whole, typed, via `values()`). ❌ MAP→relational unfold; list-operation steps (`merge`/`split`/`index`/`order`/`project`/`where`/`asX`); typed-element `Scope.local` transforms (fail closed) |
| `Scope.local` reducers (count/sum/min/max/mean) | ✅ | per-list aggregate → scalar; also degenerate scalar-local |
| `none(P)`/`all(P)`/`any(P)` | ✅ | collection filters, null-aware |
| `Scope.local` order/limit/range/skip/tail/dedup on a list | 🟡 | per-list `json_each` rebuild; `reverse()`; per-element string transforms; bare `order().fold()` sorts. ❌ `order(Scope.local).by(key/traversal)` |
| set-ops (`combine`/`intersect`/`difference`/`disjunct`/`product`/`merge`/`conjoin`) | 🟡 | over a list; operand = literal list, `constant(c).fold()`, or a standalone scalar-fold traversal; `merge` = set union; compose after `path().by(key)` (the path coerces to a list). ❌ element-fold operand |
| scalar-stream `none(P)` barrier | ❌ | whole-stream barrier (distinct from the per-list filter) |

## 10. Types, math & dates

| Step | | Notes |
|---|:--:|---|
| `asBool`, `asNumber(GType.X)`, bare `asNumber()` | ✅ | typed-value carrier → GraphBinary framing; runtime casts compose |
| string transforms (`trim`/`reverse`/`concat`/`format`/…) | 🟡 | SQL scalar; `concat` skips nulls; trim over Java whitespace; compose as `Scope.local` per-element after `fold()`; `format("…%{key}…%{_}…")` reads props / `by()`, a named `%{key}` token falling back to an as()-label of the same name when the property is absent; **over a scalar parent** `format` supports literals + `%{_}` by()-modulator tokens (a `%{key}` property token defers — a scalar has none); **`split(sep)`** on a scalar string → a List (recursive CTE): a non-empty separator, `""` → characters, `null` → whitespace runs; a NULL value stays NULL; a non-string arg raises the spec error. ❌ `split(Scope.local)` on a scalar (needs a preceding `fold()`), element/map `asString`, reading `project()`/`select()` columns |
| `math("<formula>")` | 🟡 | full exp4j set → one SQL scalar, always Double; property / scalar-child `by()` vars. **Over a scalar parent** (`values(…).math(…)`): `_` binds to the value; named vars resolve through by()-modulators run against the value. ❌ var with no `by()`; `withSideEffect` vars; `project()`/`select()` columns |
| `asDate`, `dateAdd`, `dateDiff`, `datetime()`/`DateTime()` | 🟡 | epoch-millis, UTC-only, ms precision; `typeOf(DATETIME)` over stored props. ❌ `inject([…]).asDate()` |
| `asNumber` + reducer (`fold`/`sum`) | ✅ | reducers carry runtime `vt` |
| `bigdecimal`, `char`, `duration` | 🟡 | hand-rolled serializers (`src/serializers.ts`); literals, exact-TEXT storage, framing, `typeOf`, numeric `order()`/range; `asNumber(GType.BIGDECIMAL)`. ❌ bigdecimal `math()`/`project` arithmetic; `min()`/`max()` over the TEXT-stored tail |
| exact `long`/`bigint` > 2^53 | ✅ | BigInt end-to-end; decimal-TEXT storage; `coerceBindValue` lossless bind seam |

## 11. Writes

| Step | | Notes |
|---|:--:|---|
| `addV()`, `.property(k,v)`, `property(T.id/T.label)` | ✅ | user-supplied ids (string→uid, int→rowid); inline property nested VALUES + nested-traversal LABEL (`addV(__.…)`) resolved at run time; nested property KEY that is a constant (`__.select(const)`/`__.constant()`). ❌ live-read nested property KEY (fails closed) |
| `addE()`, `from`/`to` | 🟡 | endpoints: `as()` alias, `__.select(label)`, nested `__.V(…)` (incl. folded `repeat().times()`), or `__.addV(…)` (nested write); edge uid; inline property nested VALUES + constant nested KEY; multi-addE initializers. ❌ nested-traversal edge label; endpoint read tail past a movement (order/limit); live-read nested property KEY (fails closed); `addE` after some prefixes |
| `mergeV`, `mergeE` | 🟡 | id-aware upsert, onCreate/onMatch, start + mid-chain; map label/id/VALUES may be nested traversals (`[k: __.trav]`) resolved correlated per driver; whole-arg `__.select(k)` of a `withSideEffect(k, map)` constant; prop VALUES keep their type (literal subtype / typed-client wire DataType / nested read shape — uuid/datetime/long honored, not JS-inferred). ❌ whole-arg traversals needing a map-valued driver (`__.identity()`/incoming-as-map) or nested-write bodies; nested map KEYS; bare `mergeV()`/`mergeE()` |
| `property()` update | ✅ | vertex normalized rows single/list/set + meta; edge normalized UPSERT (single, no meta) |
| `property(Cardinality.list/set,…)` | ✅ | list appends, set dedups by value |
| `drop()` (vertices + edges) | 🟡 | after movement/filter/`where`, cascades props. ❌ after `properties()` / `order()` |

## 12. Side-effect state

One home (`Carry`): a named registry (aggregate/cap/group('a')) and a carried column
(sack); both stay one SQL statement.

| Step | | Notes |
|---|:--:|---|
| `aggregate('x')` | 🟡 | pass-through barrier → list/variant relation; `by(key/scalar/ordered-element traversal)`; `local(aggregate(...))`; ProductiveBy NULL survives. **Over a scalar stream** `aggregate('x')`/`local(__.aggregate('x'))` collects the values into the bag (pass-through); `cap('x')` reads it (shape-agnostic). ❌ by()-modulated scalar aggregate, token modulators, general element ordering |
| `cap('x')` | 🟡 | list/variant emits one collection (`unfold()` for members); group side-effect re-emits its GroupStream. ❌ multi-key `cap('x','y')` |
| `sack()` / `withSack(…)` | 🟡 | carried column: `sack(Operator.x).by(key/T.label/nested)` mutate, bare `sack()` read, `withSack(init)` seed. ❌ inject-const numeric promotion; `repeat()`/`barrier`/`local`; split/merge-on-fork; `sack(BiFunction)` |
| `group('a')`/`groupCount('a')` | 🟡 | pass-through barrier, `cap('a')` re-runs the group. ❌ after `as()`/`path()` (inherits §4 limits) |
| `store('x')` | 🚫 | dropped in v4 — use `aggregate(Scope.local)` |
| `within('x')`/`without('x')` readback | ❌ | mid-chain side-effect read (eager/lazy divergence) |

## 13. Traversal strategies

| Strategy | | Notes |
|---|:--:|---|
| optimization / OLAP-guard / planning strategies, `withoutStrategies(…)` | ✅ | no-ops (result-preserving on our OLTP SQL engine — complete name→handling taxonomy in `strategies.ts`) |
| SubgraphStrategy (vertex **and** edge criteria) | ✅ | recursive `where(criterion)` injection over the whole traversal tree; edge criterion explodes `out/in/both`→`…E.…V`; `checkAdjacentVertices` (both endpoints in the subgraph). ❌ vertexProperties criterion, mutating traversals |
| PartitionStrategy (read-filter + write-stamp) | ✅ | recursive `has(within)` + property stamp. ❌ `includeMetaProperties`, partition-aware `mergeV`/`mergeE` |
| ReadOnly / EdgeLabel / ReservedKeys verification | ✅ | throw TinkerPop's canonical messages |
| ProductiveByStrategy | ✅ | productive-NULL policy for every supported consumer |
| `withoutStrategies(ConnectiveStrategy)` | 🚫 | rejected — its infix `.and()/.or()` folding is unconditionally baked in, so it can't be disabled |
| `with(…)` (OptionsStrategy sugar) | ❌ | not implemented (the `OptionsStrategy` class itself is a no-op) |
| SackStrategy / ElementId / SideEffect / Event / VertexProgram | 🚫 | reject fail-closed (would change results; several unreachable via the string grammar) |

## 14. Element / property model

| Feature | | Notes |
|---|:--:|---|
| Integer rowid ids | ✅ | |
| User-supplied ids (string `uid`) | 🟡 | at `V('x')` seed, framing-out, `properties().element().id()`. ❌ scalar id via `by(__.outV().id())`/`group().by(__.id())`; edge uid via `addE` in some paths |
| Multi-properties (list/set) | ✅ | normalized `vertex_properties`; `values()` flatMaps, `has()` ANY-matches, `valueMap` `{k:[…]}` |
| Meta-properties | ✅ | JSONB `meta` per VP row |
| Property types: primitives + list/map/set | ✅ | vertex + edge normalized (`value` keeps SQLite storage class → correct order/range); `vtype` stores the canonical type (→ `typeOf` §2, framing §10). Collections store a self-describing typed-JSON `{t,v}` tree → list/set/map ELEMENTS, typed & non-string map KEYS, and arbitrary nesting round-trip with each leaf's exact gremlin type (uuid/datetime/long/…), incl. through valueMap/vertex/edge/`properties()` and the write-response echo |

## 15. Locked non-goals (🚫)

| Feature | Why |
|---|---|
| Lambdas | v4-native stance |
| OLAP / GraphComputer | OLTP-only (small per-tenant graphs) |
| Multi-request `g.tx()` | needs DO session state (P5 stretch) |
| `tree()` | 0 conformance (JS GLV stubs it) |
| TextP regex | platform wall — no SQLite `regexp()` UDF, DO blocks extensions |
