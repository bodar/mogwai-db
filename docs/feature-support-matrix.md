# mogwai-db — feature support matrix

What you can rely on. Each step gets one mark based on how much of it works and how
freely it composes — a ✅ step works **anywhere in a traversal**, however deeply nested,
not just at the top. Notes call out **only the cases that don't work yet**; if a row has
no note, the whole step works. **L3 conformance: <!-- L3:passing -->1,226<!-- /L3:passing --> · corpus parse+chain: 2298/2298.**

| Mark | Meaning |
|---|---|
| ✅ | **Supported.** The forms you'd reach for work, and the step composes at any depth. A note, if present, lists narrow corner cases. |
| 🟡 | **Partial.** Either a real chunk of the step is missing, or it only works shallowly (near the top of a traversal, not deeply nested). The note says what's missing. |
| ❌ | **Not yet.** Throws a clear error — never mis-executes. |
| 🚫 | **Out of scope.** A deliberate non-goal. |

Grounded in the code: a deferred shape fails closed with a clear error, and this file says
so. Kept in sync in the commit that changes support.

---

## 1. Sources & movement

| Step | | Notes |
|---|:--:|---|
| `V()`/`V(id…)`, `E()`/`E(id…)` | ✅ | `V(id)` resolves a numeric rowid or a string `uid`; mid-traversal `V()`/`E()` re-sources the graph per traverser. ❌ mid-`V`/`E` when the incoming scalar carries path / origins / sack |
| `out`/`in`/`both`, `outE`/`inE`/`bothE`, `outV`/`inV`/`bothV` | ✅ | index-only covering-index hops; convergent walks auto-collapse so dense/deep traversals stay fast |
| `otherV` | ✅ | |
| `inject(…)` | ✅ | ❌ appending a list onto an existing scalar stream |

## 2. Filters & predicates

| Step | | Notes |
|---|:--:|---|
| `hasLabel`, `has(k)`, `has(k,v)`, `has(k,P)`, `has(label,k,v)`, `has(T.label/T.id,…)` | ✅ | |
| `hasId(…)` | ✅ | |
| `is(P)` | ✅ | ❌ after `path()` |
| `where(__.…)` | ✅ | single- & multi-hop, edge-typed hops, `label()`/`not()`, alias-rooted `where(__.as('x')…)` |
| `where(P)` / `where('a',P)` | 🟡 | value-compare over a scalar stream works, as does alias-column compare; ❌ some `where(P.op)` forms, `by(key)` on an edge-typed label, `where('a',P)` over a scalar |
| `and`, `or`, `not`, `filter(__.…)` | ✅ | incl. infix `.and()`/`.or()`. ❌ `filter(rawPredicate)` — use a traversal |
| `dedup()`, `dedup(labels)` | ✅ | bare, `dedup().by(key/T.id/T.label/scalar traversal)`, `dedup(labels)` by an `as()`-label tuple. ❌ bare `dedup()` after `as()`/path tracking; more than one `by()`; `dedup(labels).by(traversal)` |
| `identity()` | ✅ | |
| `typeOf(GType)` over a stored property | ✅ | `is(typeOf(X))` / `has('k',typeOf(X))` over every canonical type, incl. `bigdecimal`/`char`/`duration` |

**Predicates (`P`)** — every comparison predicate works, in every position a predicate is accepted:

| | eq | neq | lt | lte | gt | gte | within | without | between | inside | outside |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |

`between` is `[lo,hi)` (inclusive low), `inside` is `(lo,hi)` (exclusive both).

**Text predicates (`TextP`)** — bound, escaped `LIKE`:

| | startingWith | endingWith | containing | notStartingWith | notEndingWith | notContaining | regex / notRegex |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🚫 |

`regex` is a platform wall: no SQLite `regexp()` UDF, and Durable Objects block `create_function`/`load_extension`.

## 3. Projections & element data

| Step | | Notes |
|---|:--:|---|
| `values(k…)`, `id()`, `label()`, `count()` | ✅ | ids frame as `COALESCE(uid,id)` |
| `valueMap`, `elementMap` | ✅ | each value framed by its stored type; re-enterable as a per-element map (`select(Column.keys/values)`, `count()`, `is(typeOf(MAP))` compose). ❌ heterogeneous element-value maps |
| `properties(k…)` [`.key`/`.value`/`.element`/`.id`/`.label`/`.count`] | ✅ | full property stream with owner/key/value/meta, all re-enterable; real VP id + meta. ❌ `dedup()`/`order()` before a projection |
| `select('a')`, multi-`select`, `project(…)` | ✅ | single-label select → scalar/element/typed-list; multi-`select`/`project` → per-traverser record whose fields each re-enter; `limit`/`range`/`skip`/`tail` with `Scope.local` slice fields; `project(…)` over a scalar parent. ❌ record-level `order`/`dedup`/`fold`/`where`; a scalar-parent `project` field needing element output |
| `select(Column.values/keys)` | ✅ | over a group, scalar record, or per-element valueMap/elementMap. ❌ heterogeneous element-value lists; raw Map params |
| chained projections (`values().count()`, `project().select()`, `valueMap().select()`) | ✅ | projections retype and re-enter one step at a time. ❌ heterogeneous structured values |
| `order()` [`.by(key[,dir]\|__.trav)`] | ✅ | `by(key)` and `by(__.traversal)`. ❌ after `path()`; `by(key)` on a scalar stream; a multi-term order mixing a traversal |
| `limit`, `range`, `skip` | ✅ | mid-chain or tail; `Scope.local` slices record fields |
| `by(…)` modulator | ✅ | on `order`/`select`/`project`/`group`/`groupCount`/`path`/`math` |

## 4. Aggregation & barriers

| Step | | Notes |
|---|:--:|---|
| `group`, `groupCount` | ✅ | scalar/`T.id`/`T.label`/composite-`project` keys; scalar reducers, element values, unreduced value traversals, and nested-map values (`by(__.<movement>.group())`) all compose through the generic child seam; group-scoped `count/sum/min/max/mean`/`fold()`; scalar-stream `groupCount()`. ❌ more than two `by()`; non-scalar / element-valued inner keys; `order().by(key)` inside a value; `select(Column)`/`unfold()` over a nested-map value |
| `fold()` | ✅ | scalar or element list, re-enterable; empty lists and element metadata preserved |
| `sum`, `min`, `max`, `mean` | ✅ | `min`/`max` over any Comparable incl. Strings |
| `group('a')`/`groupCount('a')` (side-effecting) | 🟡 | see §12 |

## 5. Per-traverser branching

Across all four branch steps, mixed-shape arms (scalar + element + list) merge into one
**variant stream**. After that merge the shape-agnostic steps compose (`count`, `unfold`,
`limit`/`skip`/`range`, `dedup`); steps that must look inside a heterogeneous row
(movement, `order`, value filters) fail closed. ❌ across all: mixing element **kinds**
(node + edge) in one arm; a new `as()` inside an arm; path through a mixed-shape arm.

| Step | | Notes |
|---|:--:|---|
| `choose(pred, then[, else])` | ✅ | gated dispatch over element/scalar/list arms and over a scalar parent; mixed-shape then/else → a variant stream. ❌ a 2-arg scalar-`then` with an implicit identity-else |
| `coalesce(…)` | ✅ | first-productive over element/scalar/list arms (empty `fold()` counts as productive); nests in coalesce/optional; over a scalar parent too |
| `union(…)` | ✅ | element multi-hop/nested arms; scalar/list arms; over a scalar parent. ❌ full-`V()`/`E()` source-branch tails |
| `optional(…)` | ✅ | `optional(t)` ≡ `coalesce(t, identity)`; single- and multi-hop; over a scalar parent restores the value on a miss. ❌ an element-kind change on a miss; per-row-shape steps after a mixed-shape result |
| `flatMap(__.…)` | ✅ | movement/filter/scalar/`fold()` bodies; over a scalar parent incl. a `V()`/`E()` re-source. ❌ record/group/path bodies |
| `map(__.…)` | ✅ | 1-to-1: movement (first-per-origin), scalar tails, reducers, `fold()`, `choose`/`coalesce`, a reducing `V()`/`E()` re-source. For an inner traversal that **fans out**, use `flatMap`/`local` (🚫 `map` would have to pick a first-of-many). ❌ alias/select/structured bodies |
| `choose(fn).option(k, body)…` | 🟡 | scalar option-map. ❌ no `Pick.none` default; element/identity/discard/fail bodies; `Pick.unproductive`/`any`; a `T`-token choice over a scalar parent |
| `local(…)` | 🟡 | one-child `all` policy: movement, slices, `dedup`, scalar transforms/reducers, `fold()`; over a scalar parent. ❌ `order()`; nested-traversal/record/group/path/match/union bodies; sack |

## 6. Recursion (`repeat`)

| Step | | Notes |
|---|:--:|---|
| `repeat(__.<out/in/both>).times(n)` | ✅ | `WITH RECURSIVE`; convergent walks collapse so a dense/deep walk returns in ms; i64 overflow fails loud |
| `…times(n).count()` | ✅ | propagates through post-repeat labels/movement/`select(labels).count()`. ❌ `groupCount`/`by(count)`, `sum`, aliases live across the walk, unbounded `until`/`emit` |
| `emit` (before/after, bare) | ✅ | runs to the natural fixpoint |
| `until(<pred>)`, `loops().is(n)` | ✅ | do-while / while-do. ❌ `until(__.loops()…)` beyond `loops().is(P)` |
| `repeat().path()`, `simplePath()` in body | ✅ | JSONB array walk + `json_each` cycle guard |
| movement + `has()` / multi-hop bodies | 🟡 | `out()/in()/both()` chains with `has(k,v/P/TextP)`. ❌ `hasLabel`/3-arg/`T`-token `has`; a path with a multi-hop body |
| `emit(pred)`, `times(pred)`, `until`+`times`/`emit` | ❌ | predicate / combined exit forms |
| barrier / side-effect / edge-step bodies, nested `repeat`, on edges, after `as()`, `path().by()` on the walk | ❌ | can't live in a recursive term |

## 7. Path family

| Step | | Notes |
|---|:--:|---|
| `path()`, `path().by(…)`, `path().from(l)/to(l)` | 🟡 | linear or recursive layout; `count()`/`is(typeOf(PATH))` re-enter; per-position `by('key')`/`by(T.label/T.id)`/`by(__.trav)`; `from(l)`/`to(l)` scope a linear path to a static label slice; collection ops compose over a `by(key)` path. ❌ a fan-out/aggregate `by(traversal)`; `by()` / `from` / `to` through a branch or a recursive path; mixed element-kind at a position; a dynamic-length (`repeat`) arm; spanning more than one movement/repeat; over a `union()` source |
| `simplePath()`, `cyclicPath()` [`.from(l)/.to(l)`] | ✅ | all-pairs identity / `json_each` guard; `from(l)`/`to(l)` scope a static label range. ❌ `by(key/T)` scoping |
| other steps after `path()` | 🟡 | collection ops (set-ops/`merge`/`reverse`/`conjoin`/`unfold`) compose over a `by(key)` path. ❌ `order`/reducer/`inject`/`select(Column.keys)` — need label history |
| `tree()` | 🚫 | the JS GLV stubs it (0 conformance) |

## 8. Pattern matching

| Step | | Notes |
|---|:--:|---|
| `match(p1, p2, …)` | 🟡 | conjunctive `as(start).<element traversal>.as(end)` patterns, dependency-ordered, over the shared movement/filter engine. ❌ scalar-terminal binds (`count`/`values`), edge-typed end var, `or`/`not`/nested-match, more than one or zero root vars, `dedup(label)` downstream, path tracking |

## 9. Lists & collections

| Step | | Notes |
|---|:--:|---|
| `fold()` / `inject([…])` as a list value | ✅ | JSONB list, re-enters the tail |
| `unfold()` | ✅ | explode → elements/scalar/nested-list; a stored typed list frames each element by its own type; Map-unfold → per-entry Map.Entry. ❌ after a projection/modifier on an element stream; non-`select`/element-value on unfolded entries |
| `Scope.local` reducers (count/sum/min/max/mean) | ✅ | per-list aggregate → scalar |
| `none(P)`/`all(P)`/`any(P)` | ✅ | collection filters, null-aware |
| `Scope.local` order/limit/range/skip/tail/dedup on a list | ✅ | per-list `json_each` rebuild; `reverse()`; per-element string transforms. ❌ `order(Scope.local).by(key/traversal)` |
| set-ops (`combine`/`intersect`/`difference`/`disjunct`/`product`/`merge`/`conjoin`) | ✅ | operand = a literal list, `constant(c).fold()`, or a standalone scalar-fold traversal. ❌ an element-fold operand |
| `is(typeOf(LIST))`, `is(typeOf(SET))`, `is(typeOf(MAP))` | 🟡 | LIST/SET retype a stored collection to a typed list stream (SET frames as a GraphBinary Set); MAP is identity on a valueMap/group map. ❌ MAP → relational unfold; the list-operation steps (`merge`/`split`/`index`/`order`/`project`/`where`) after the retype; typed-element `Scope.local` transforms |
| scalar-stream `none(P)` barrier | ❌ | whole-stream barrier (distinct from the per-list filter) |

## 10. Types, math & dates

| Step | | Notes |
|---|:--:|---|
| `asBool`, `asNumber(GType.X)`, bare `asNumber()` | ✅ | typed-value carrier → GraphBinary framing |
| string transforms | ✅ | see the string-function table below; compose as `Scope.local` per-element after `fold()`. ❌ `split(Scope.local)` on a scalar (needs a preceding `fold()`); element/map `asString`; reading `project()`/`select()` columns |
| `math("<formula>")` | ✅ | see the math-function table below; `_` binds the value, named vars resolve through `by()`/`as()`. ❌ a var with no `by()`; `withSideEffect` vars; `project()`/`select()` columns |
| `asDate`, `dateAdd`, `dateDiff`, `datetime()`/`DateTime()` | ✅ | epoch-millis, UTC-only, ms precision; `typeOf(DATETIME)` over stored props. ❌ `inject([…]).asDate()` |
| `asNumber` + reducer (`fold`/`sum`) | ✅ | reducers carry the runtime type |
| `bigdecimal`, `char`, `duration` | ✅ | literals, exact-TEXT storage, framing, `typeOf`, numeric `order()`/range, `asNumber(GType.BIGDECIMAL)`. ❌ bigdecimal `math()`/`project` arithmetic; `min()`/`max()` over the TEXT-stored tail |
| exact `long`/`bigint` > 2^53 | ✅ | BigInt end-to-end, lossless |

**Math functions** — TinkerPop's `math()` compiles to one SQL scalar (always Double). Full exp4j surface:

| operators | functions |
|---|---|
| `+` `-` `*` `/` `%` `^` | `abs` `ceil` `floor` `round` `sqrt` `cbrt` `exp` `log` (natural) `log10` `log2` `sin` `cos` `tan` `asin` `acos` `atan` `sinh` `cosh` `tanh` `signum` |

All ✅.

**String functions** — one SQL scalar each, composable and `Scope.local`-able:

| | concat | length | toUpper | toLower | asString | substring | replace | trim | lTrim | rTrim | reverse | split | format |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

`trim`/`lTrim`/`rTrim` strip Java whitespace; `concat` skips nulls; `split(sep)` → a List (`""` → characters, `null` → whitespace runs); `format("…%{key}…%{_}…")` reads props / `by()` modulators.

## 11. Writes

| Step | | Notes |
|---|:--:|---|
| `addV()`, `.property(k,v)`, `property(T.id/T.label)` | ✅ | user-supplied ids; inline property VALUES + nested-traversal LABEL + constant nested KEY. ❌ a live-read nested property KEY |
| `addE()`, `from`/`to` | 🟡 | endpoints via `as()` alias, `__.select(label)`, nested `__.V(…)` (incl. folded `repeat().times()`), or `__.addV(…)`; edge uid; inline property VALUES + constant nested KEY; multi-addE. ❌ a nested-traversal edge label; an endpoint read tail past a movement; a live-read nested property KEY; `addE` after some prefixes |
| `mergeV`, `mergeE` | 🟡 | id-aware upsert, onCreate/onMatch, start + mid-chain; map label/id/VALUES may be nested traversals; prop VALUES keep their type. ❌ whole-arg map-valued driver traversals; nested map KEYS; bare `mergeV()`/`mergeE()` |
| `property()` update | ✅ | vertex single/list/set + meta; edge UPSERT (single, no meta) |
| `property(Cardinality.list/set,…)` | ✅ | list appends, set dedups by value |
| `drop()` (vertices + edges) | ✅ | after movement/filter/`where`, cascades props. ❌ after `properties()` / `order()` |

## 12. Side-effect state

One home (`Carry`): a named registry (aggregate/cap/group('a')) and a carried column (sack),
each staying one SQL statement.

| Step | | Notes |
|---|:--:|---|
| `aggregate('x')` | 🟡 | pass-through barrier → list/variant relation; `by(key/scalar/ordered-element traversal)`; `local(aggregate(...))`; over a scalar stream too. ❌ a `by()`-modulated scalar aggregate; token modulators; general element ordering |
| `cap('x')` | 🟡 | emits one collection; group side-effect re-emits its group. ❌ multi-key `cap('x','y')` |
| `sack()` / `withSack(…)` | 🟡 | carried column: `sack(Operator.x).by(key/T.label/nested)` mutate, bare `sack()` read, `withSack(init)` seed. ❌ inject-const numeric promotion; `repeat()`/`barrier`/`local`; split/merge-on-fork; `sack(BiFunction)` |
| `group('a')`/`groupCount('a')` | 🟡 | pass-through barrier, `cap('a')` re-runs the group. ❌ after `as()`/`path()` (inherits §4 limits) |
| `store('x')` | 🚫 | dropped in v4 — use `aggregate(Scope.local)` |
| `within('x')`/`without('x')` readback | ❌ | mid-chain side-effect read |

## 13. Traversal strategies

| Strategy | | Notes |
|---|:--:|---|
| optimization / OLAP-guard / planning strategies, `withoutStrategies(…)` | ✅ | no-ops (result-preserving on our OLTP SQL engine) |
| SubgraphStrategy (vertex **and** edge criteria) | ✅ | recursive `where(criterion)` injection; edge criterion explodes `out/in/both`→`…E.…V`; `checkAdjacentVertices`. ❌ vertexProperties criterion; mutating traversals |
| PartitionStrategy (read-filter + write-stamp) | ✅ | recursive `has(within)` + property stamp. ❌ `includeMetaProperties`; partition-aware `mergeV`/`mergeE` |
| ReadOnly / EdgeLabel / ReservedKeys verification | ✅ | throw TinkerPop's canonical messages |
| ProductiveByStrategy | ✅ | productive-NULL policy for every supported consumer |
| `withoutStrategies(ConnectiveStrategy)` | 🚫 | its infix `.and()/.or()` folding is unconditionally baked in |
| `with(…)` (OptionsStrategy sugar) | ❌ | not implemented (the `OptionsStrategy` class itself is a no-op) |
| SackStrategy / ElementId / SideEffect / Event / VertexProgram | 🚫 | reject fail-closed (would change results) |

## 14. Element / property model

| Feature | | Notes |
|---|:--:|---|
| Integer rowid ids | ✅ | |
| User-supplied ids (string `uid`) | 🟡 | at `V('x')` seed, framing-out, `properties().element().id()`. ❌ a scalar id via `by(__.outV().id())`/`group().by(__.id())`; edge uid via `addE` in some paths |
| Multi-properties (list/set) | ✅ | normalized; `values()` flatMaps, `has()` ANY-matches, `valueMap` `{k:[…]}` |
| Meta-properties | ✅ | JSONB `meta` per VP row |
| Property types: primitives + list/map/set | ✅ | vertex + edge, correct order/range; collections round-trip each leaf's exact gremlin type through valueMap/vertex/edge/`properties()` and the write-response echo |

## 15. Locked non-goals (🚫)

| Feature | Why |
|---|---|
| Lambdas | v4-native stance |
| OLAP / GraphComputer | OLTP-only (small per-tenant graphs) |
| Multi-request `g.tx()` | needs DO session state (P5 stretch) |
| `tree()` | 0 conformance (JS GLV stubs it) |
| TextP regex | platform wall — no SQLite `regexp()` UDF, DO blocks extensions |
